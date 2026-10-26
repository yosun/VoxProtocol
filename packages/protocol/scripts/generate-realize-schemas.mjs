import {writeFile} from "node:fs/promises";
import {z} from "zod";
import * as core from "../dist/realize.js";
import * as contracts from "../dist/realize-contracts.js";

// Compile first. Use the same patched Zod runtime for validation and schema export.
const schemas = {...core, ...contracts};
const definitions = {};
for (const name of Object.keys(schemas).filter((name) => name.endsWith("V1Schema")).sort()) {
  const converted = z.toJSONSchema(schemas[name], {io: "input", target: "draft-2020-12", reused: "inline"});
  delete converted.$schema;
  definitions[name.replace(/V1Schema$/, "")] = converted;
}

// JSON Schema cannot express arbitrary integer-string sums or signature checks.
// It can express u64 range, bounded keys, and state-dependent structural fields.
const maximum = core.USDC_MAX_BASE_UNITS.toString();
const upperRange = ["0", "[1-9][0-9]{0,18}"];
for (let index = 0; index < maximum.length; index++) {
  const digit = Number(maximum[index]);
  const low = index === 0 ? 1 : 0;
  if (digit <= low) continue;
  const range = digit - 1 === low ? `${low}` : `[${low}-${digit - 1}]`;
  const remaining = maximum.length - index - 1;
  upperRange.push(`${maximum.slice(0, index)}${range}${remaining ? `[0-9]{${remaining}}` : ""}`);
}
upperRange.push(maximum);
const u64Pattern = `^(?:${upperRange.join("|")})$`;
function enrich(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.pattern === "^(0|[1-9][0-9]{0,19})$") {
    schema.pattern = u64Pattern;
    schema.maxLength = 20;
  }
  if (schema.type === "object" && schema.additionalProperties && typeof schema.additionalProperties === "object" && schema.propertyNames?.maxLength === 64) schema.maxProperties = 64;
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(enrich);
    else if (value && typeof value === "object") enrich(value);
  }
}
Object.values(definitions).forEach(enrich);
definitions.GenerationParameters.maxProperties = 64;
definitions.Commission.allOf = Object.entries(core.REALIZE_COMMISSION_STATE_REQUIREMENTS).map(([state, requirements]) => ({
  if: {properties: {state: {const: state}}, required: ["state"]},
  then: {
    properties: {payment_state: {enum: [...requirements.payment]}, fulfillment_state: {enum: [...requirements.fulfillment]}},
    ...(["QUOTED", "AWAITING_PAYMENT", "FUNDED", "GENERATING", "COMPLETED", "SETTLED"].includes(state) ? {required: ["quote_id", ...(["QUOTED"].includes(state) ? [] : ["accepted_quote_hash"])]} : {})
  }
}));
definitions.Commission.allOf.push(
  {if: {properties: {payment_state: {enum: ["captured", "refund_pending", "refunded", "settled"]}}, required: ["payment_state"]}, then: {required: ["quote_id", "accepted_quote_hash"]}},
  {if: {required: ["accepted_quote_hash"]}, then: {required: ["quote_id"]}},
  {if: {properties: {state: {enum: ["DRAFT", "QUOTED"]}}, required: ["state"]}, then: {not: {required: ["accepted_quote_hash"]}}}
);
const fulfillmentConditions = [
  {if: {properties: {status: {enum: ["completed", "failed"]}}, required: ["status"]}, then: {required: ["completed_at"]}},
  {if: {properties: {status: {enum: ["queued", "generating"]}}, required: ["status"]}, then: {not: {required: ["completed_at"]}}},
  {if: {properties: {status: {const: "completed"}}, required: ["status"]}, then: {properties: {outputs: {minItems: 1}}}},
  {if: {properties: {status: {const: "failed"}}, required: ["status"]}, then: {required: ["error_code"]}}
];
definitions.FulfillmentResult.allOf = fulfillmentConditions;
const commissionConditions = definitions.Commission.allOf;
function applyStateConditions(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties?.commission_id && schema.properties?.payment_state && schema.properties?.fulfillment_state && schema.properties?.state) schema.allOf = commissionConditions;
  if (schema.properties?.fulfillment_request_id && schema.properties?.outputs && schema.properties?.status) schema.allOf = fulfillmentConditions;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "allOf") continue;
    if (Array.isArray(value)) value.forEach(applyStateConditions);
    else if (value && typeof value === "object") applyStateConditions(value);
  }
}
Object.values(definitions).forEach(applyStateConditions);
definitions.RealizeQuote["x-vox-semantic-validation"] = ["component sum equals total", "payout sum and role subtotals equal total and components", "unique payout IDs and beneficiary pairs", "canonical quote hash and authorized issuer signature", "expiration follows issue time"];
definitions.SettlementInstruction["x-vox-semantic-validation"] = ["payout sum equals total", "unique payout IDs", "ordered batches partition payouts exactly once", "must match accepted quote"];
definitions.RevenueRightsAgreement["x-vox-semantic-validation"] = ["allocations total no more than 10000 basis points", "party and policy references resolve uniquely", "valid time intervals", "authorized acceptances bind to the canonical terms hash"];

const bundle = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://vox.gold/schemas/realize-v1.schema.json",
  title: "VOX Realize Protocol v1",
  description: "Generated from @vox/protocol. Select a contract by $ref into $defs. Structural JSON validation must be followed by the semantic validation documented in docs/realize-protocol.md.",
  "x-vox-protocol-version": core.REALIZE_PROTOCOL_VERSION,
  "x-vox-resource-limits": {
    usdc_decimals: 6, usdc_max_base_units: maximum,
    max_payout_recipients: core.REALIZE_MAX_PAYOUT_RECIPIENTS,
    max_recipients_per_transaction: core.REALIZE_MAX_RECIPIENTS_PER_TRANSACTION,
    max_transaction_batches: core.REALIZE_MAX_TRANSACTION_BATCHES,
    max_compute_units_per_transaction: core.REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION,
    max_serialized_transaction_bytes: core.REALIZE_MAX_TRANSACTION_BYTES
  },
  $defs: definitions
};
await writeFile(new URL("../schemas/realize-v1.schema.json", import.meta.url), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`Generated ${Object.keys(definitions).length} Realize JSON schemas.`);

const ref = (name) => ({$ref: `#/components/schemas/${name}`});
const json = (name) => ({"application/json": {schema: ref(name)}});
const errorResponse = {description: "Stable Realize error code; see protocol error table.", content: json("RealizeError")};
const hostedErrorResponse = {
  description: "Existing VOX lowercase compatibility error; see docs/openapi.yaml.",
  content: {"application/json": {schema: {type: "object", properties: {code: {type: "string"}, error: {type: "string"}}, required: ["code", "error"]}}}
};
const idempotencyHeader = {name: "Idempotency-Key", in: "header", required: true, schema: {type: "string", minLength: 1, maxLength: 256}};
const pathParameter = (name) => ({name, in: "path", required: true, schema: {type: "string", minLength: 1, maxLength: 256}});
function operation(operationId, request, response, status, description, options = {}) {
  return {
    operationId, description, tags: [options.provider ? "Populi provider contract" : "VOX callback contract"],
    security: options.webhook ? [{webhookSignature: []}] : [{serviceBearer: []}],
    ...(options.provider ? {servers: [{url: "https://{populi_host}", variables: {populi_host: {default: "populi.example.invalid"}}}]} : {}),
    ...(request ? {requestBody: {required: true, content: json(request)}} : {}),
    parameters: [...(options.parameters ?? []), ...(request && !options.webhook ? [idempotencyHeader] : [])],
    responses: {[status]: {description: "Success", content: json(response)}, default: options.webhook ? hostedErrorResponse : errorResponse}
  };
}
const openapi = {
  openapi: "3.1.0", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {title: "VOX–Populi Realize v1 provider contract", version: "1.0.0", description: "Exact provider and callback contract for VOX and Populi implementers. This document does not assert that Populi routes are deployed. VOX's hosted commissioning API is documented separately in docs/openapi.yaml. Public Populi /api/cost estimates are a separate interface."},
  servers: [{url: "https://{vox_host}", variables: {vox_host: {default: "vox.example.invalid"}}}],
  paths: {
    "/v1/realize/creators/{creator_id}/capabilities": {get: operation("getProviderCapabilities", null, "CreatorCapabilities", "200", "Populi advertises supported creator capabilities. VOX may proxy discovery.", {provider: true, parameters: [pathParameter("creator_id")]})},
    "/v1/realize/provider-prices": {post: operation("quoteProviderPrice", "ProviderPricingRequest", "ProviderPriceQuote", "200", "Populi issues an authoritative provider base-price reservation with expiration. This is not the final VOX commission quote.", {provider: true})},
    "/v1/realize/fulfillments": {post: operation("submitProviderFulfillment", "ProviderFulfillmentRequest", "FulfillmentResult", "202", "Populi accepts externally funded generation. Authenticate VOX and validate funding authorization; bypass Stripe and credit balances. Replays return the original job.", {provider: true})},
    "/v1/realize/fulfillments/{fulfillment_request_id}": {get: operation("getProviderFulfillment", null, "FulfillmentResult", "200", "Populi returns the current durable generation status and final artifact references.", {provider: true, parameters: [pathParameter("fulfillment_request_id")]})},
    "/v1/realize/webhooks/populi": {post: operation("receivePopuliFulfillmentCallback", "FulfillmentResult", "WebhookAcknowledgment", "200", "VOX receives signed, idempotent fulfillment events. Acknowledge after durable storage; polling remains the recovery path.", {webhook: true, parameters: [
      {name: "X-Realize-Webhook-Id", in: "header", required: true, schema: {type: "string", pattern: "^[A-Za-z0-9:_-]{1,256}$"}},
      {name: "X-Realize-Webhook-Timestamp", in: "header", required: true, schema: {type: "string", pattern: "^(0|[1-9][0-9]{0,12})$"}}
    ]})}
  },
  components: {
    securitySchemes: {
      serviceBearer: {type: "http", scheme: "bearer", description: "Scoped server-to-server token; never a commissioner-supplied credential. See docs/realize-populi-handoff.md."},
      webhookSignature: {type: "apiKey", in: "header", name: "X-Realize-Webhook-Signature", description: "v1=HMAC-SHA256(secret, timestamp + '.' + raw_body), lowercase hex."}
    },
    schemas: Object.fromEntries(Object.keys(definitions).map((name) => [name, {$ref: `../packages/protocol/schemas/realize-v1.schema.json#/$defs/${name}`}]))
  }
};
await writeFile(new URL("../../../docs/realize-openapi.json", import.meta.url), `${JSON.stringify(openapi, null, 2)}\n`);
console.log("Generated the VOX and Populi OpenAPI 3.1 contract.");

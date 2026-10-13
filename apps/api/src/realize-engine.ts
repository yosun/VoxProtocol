import {
  CreatorCapabilitiesV1Schema,
  computeRealizeQuoteHash,
  computeFirstPartyRealizeRightsPolicyHash,
  FirstPartyRealizeRightsPolicyV1Schema,
  FulfillmentResultV1Schema,
  ProviderPriceQuoteV1Schema,
  ProviderPricingRequestV1Schema,
  ProviderFulfillmentRequestV1Schema,
  RealizeQuoteV1Schema,
  SettlementInstructionV1Schema,
  REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION,
  REALIZE_MAX_RECIPIENTS_PER_TRANSACTION,
  REALIZE_MAX_TRANSACTION_BATCHES,
  REALIZE_MAX_TRANSACTION_BYTES,
  signRealizeQuote,
  bytesToHex,
  canonicalBytes,
  canonicalize,
  domainHash,
  utf8,
  type CreatorCapabilitiesV1,
  type FulfillmentResultV1,
  type ProviderPriceQuoteV1,
  type ProviderPricingRequestV1,
  type ProviderFulfillmentRequestV1,
  type RealizeQuoteV1,
  type SettlementInstructionV1,
  type SettlementAcknowledgmentV1,
  type RealizeCommissionServiceV1
} from "@vox/protocol";
import {isValidSolanaAddress} from "@vox/solana";
import {createHash, randomUUID} from "node:crypto";
import {isIP} from "node:net";
import {z} from "zod";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const atomic = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).superRefine((value, context) => {
  if (BigInt(value) > 18_446_744_073_709_551_615n) context.addIssue({code: z.ZodIssueCode.custom, message: "amount exceeds the USDC u64 limit"});
});
const positiveAtomic = atomic.refine((value) => BigInt(value) > 0n);

export const REALIZE_ROUNDING_POLICY = "half_up_percent;largest_remainder_remainder_desc_recipient_id_asc" as const;
export const REALIZE_MAX_PROVIDER_PRICE_AGE_SECONDS = 300;

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const FeeFormulaV1Schema = z.object({
  fixed_amount_usdc_atomic: atomic.default("0"),
  percent_basis_points: z.number().int().min(0).max(10_000).default(0),
  minimum_amount_usdc_atomic: atomic.default("0"),
  percentage_basis: z.enum(["provider_base", "provider_plus_owner"]).default("provider_base")
}).strict();

const WeightedRecipientV1Schema = z.object({
  recipient_id: id,
  destination: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana address"),
  basis_points: z.number().int().min(1).max(10_000)
}).strict();

const FeeAllocationV1Schema = z.object({
  fee: FeeFormulaV1Schema,
  recipients: z.array(WeightedRecipientV1Schema).min(1).max(64)
}).strict().superRefine((allocation, context) => {
  if (allocation.recipients.reduce((sum, recipient) => sum + recipient.basis_points, 0) !== 10_000) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["recipients"], message: "recipient basis points must sum to 10000"});
  }
  if (new Set(allocation.recipients.map((recipient) => recipient.recipient_id)).size !== allocation.recipients.length) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["recipients"], message: "recipient ids must be unique within an allocation"});
  }
});

const MainnetPricingPolicyV1Schema = z.object({
  minimum_total_usdc_atomic: positiveAtomic,
  maximum_total_usdc_atomic: positiveAtomic,
  provider_basis_points: z.number().int().min(1).max(10_000),
  character_owner_basis_points: z.number().int().min(1).max(10_000),
  platform_basis_points: z.number().int().min(1).max(10_000)
}).strict().superRefine((policy, context) => {
  if (BigInt(policy.minimum_total_usdc_atomic) < 1_000_000n) context.addIssue({code: z.ZodIssueCode.custom, path: ["minimum_total_usdc_atomic"], message: "Mainnet minimum may not be below 1 USDC"});
  if (BigInt(policy.maximum_total_usdc_atomic) < BigInt(policy.minimum_total_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["maximum_total_usdc_atomic"], message: "Mainnet maximum must be at least the minimum"});
  if (BigInt(policy.maximum_total_usdc_atomic) > 10_000_000_000n) context.addIssue({code: z.ZodIssueCode.custom, path: ["maximum_total_usdc_atomic"], message: "Mainnet maximum may not exceed 10000 USDC"});
  if (policy.provider_basis_points + policy.character_owner_basis_points + policy.platform_basis_points !== 10_000) context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_basis_points"], message: "Mainnet provider, owner, and platform allocations must sum to 10000 basis points"});
});
type MainnetPricingPolicyV1 = z.infer<typeof MainnetPricingPolicyV1Schema>;

export const DEFAULT_MAINNET_PRICING_POLICY = Object.freeze({
  minimum_total_usdc_atomic: "1000000",
  maximum_total_usdc_atomic: "10000000000",
  provider_basis_points: 2_500,
  character_owner_basis_points: 7_000,
  platform_basis_points: 500
});

/** Mainnet disbursements require a separate explicit approval and are never automatic. */
export function requiresExplicitMainnetDisbursementApproval(networkId: string): boolean {
  return networkId === "solana:mainnet-beta";
}

export const RealizeCreatorPayoutConfigurationV1Schema = z.object({
  protocol_version: z.literal("realize/1"),
  creator_id: id,
  version: z.number().int().positive(),
  populi_api_base_url: z.string().url().max(2_048),
  populi_api_token_env: z.string().regex(/^VOX_[A-Z0-9_]{2,80}$/).default("VOX_POPULI_API_TOKEN"),
  artifact_hosts: z.array(z.string().min(1).max(253)).max(32).default([]),
  max_artifact_bytes: z.number().int().positive().max(250_000_000).default(100_000_000),
  rights_agreement_reference: id,
  rights_agreement_version: z.number().int().positive(),
  rights_subject_id: id,
  rights_agreement_hash: digest,
  usdc_mint: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana mint address"),
  network_id: z.enum(["solana:devnet", "solana:testnet", "solana:mainnet-beta"]),
  settlement_program_version: id,
  funding_destination_token_account: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana token account"),
  rights_policy_mode: z.enum(["signed_agreement", "first_party"]).optional(),
  mainnet_pricing_policy: MainnetPricingPolicyV1Schema.optional(),
  quote_ttl_seconds: z.number().int().min(30).max(86_400).default(900),
  provider_payouts: z.array(z.object({provider_id: id, recipients: z.array(WeightedRecipientV1Schema).min(1).max(64)}).strict()).min(1).max(16),
  character_owner_id: id,
  character_owner_markup: FeeAllocationV1Schema,
  platform_fee: FeeAllocationV1Schema,
  additional_beneficiaries: z.array(z.object({
    recipient_id: id,
    role: z.enum(["commissioner", "referrer", "sponsor", "additional_beneficiary"]),
    fee: FeeFormulaV1Schema,
    destination: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana address")
  }).strict()).max(64)
}).strict().superRefine((configuration, context) => {
  const providerIds = configuration.provider_payouts.map((item) => item.provider_id);
  if (new Set(providerIds).size !== providerIds.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_payouts"], message: "provider payout mappings must be unique"});
  for (const item of configuration.provider_payouts) {
    if (item.recipients.reduce((sum, recipient) => sum + recipient.basis_points, 0) !== 10_000) context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_payouts"], message: `provider recipients for ${item.provider_id} must sum to 10000 basis points`});
    if (new Set(item.recipients.map((recipient) => recipient.recipient_id)).size !== item.recipients.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_payouts"], message: `provider recipient ids for ${item.provider_id} must be unique`});
  }
  const beneficiaryKeys = configuration.additional_beneficiaries.map((item) => `${item.recipient_id}\u0000${item.role}`);
  if (new Set(beneficiaryKeys).size !== beneficiaryKeys.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["additional_beneficiaries"], message: "beneficiary recipient and role pairs must be unique"});
});

export type RealizeCreatorPayoutConfigurationV1 = z.infer<typeof RealizeCreatorPayoutConfigurationV1Schema>;

export const FIRST_PARTY_RIGHTS_REFERENCE_PREFIX = "vox:rights:first-party-ai:v1:";
export const FIRST_PARTY_RIGHTS_POLICY_STATEMENT = "VOX operates this AI character as a first-party creator. This policy permits customer-requested generation after the customer reviews and accepts the quote in checkout. It does not require a separate creator-signed rights agreement or a separate character-owner payout wallet. The quoted USDC price is allocated under VOX's server-managed Realize policy.";

export function createFirstPartyRealizeRightsPolicy(configuration: Pick<RealizeCreatorPayoutConfigurationV1, "creator_id" | "character_owner_id" | "rights_subject_id">) {
  const policy = FirstPartyRealizeRightsPolicyV1Schema.parse({
    protocol_version: "realize/1",
    policy_id: `${FIRST_PARTY_RIGHTS_REFERENCE_PREFIX}${configuration.creator_id}`,
    version: 1,
    creator_id: configuration.creator_id,
    character_owner_id: configuration.character_owner_id,
    rights_subject_id: configuration.rights_subject_id,
    statement: FIRST_PARTY_RIGHTS_POLICY_STATEMENT
  });
  return {policy, terms_hash: computeFirstPartyRealizeRightsPolicyHash(policy)};
}

export interface PopuliRealizeClient {
  getCapabilities(configuration: RealizeCreatorPayoutConfigurationV1, creatorId: string): Promise<CreatorCapabilitiesV1>;
  getInputSchema(configuration: RealizeCreatorPayoutConfigurationV1, schemaUri: string, creatorId: string): Promise<Record<string, unknown>>;
  getCurrentPrice(configuration: RealizeCreatorPayoutConfigurationV1, request: ProviderPricingRequestV1): Promise<ProviderPriceQuoteV1>;
  requestFulfillment(configuration: RealizeCreatorPayoutConfigurationV1, request: ProviderFulfillmentRequestV1): Promise<FulfillmentResultV1>;
  getFulfillment(configuration: RealizeCreatorPayoutConfigurationV1, fulfillmentRequestId: string): Promise<FulfillmentResultV1>;
}

export interface SolanaRealizeSettlementClient extends Pick<RealizeCommissionServiceV1, "requestSettlement"> {
  getSettlement(settlementId: string): Promise<RealizeSettlementResponseV1>;
  getPaymentIntentResolution(paymentIntentId: string): Promise<RealizePaymentIntentResolutionV1>;
  requestRefund(input: {commission_id: string; payment_intent_id: string; accepted_quote_hash: string; amount_usdc_atomic: string; network_id: string; usdc_mint: string; payer_wallet: string; funding_transaction_signature: string; payment_reference: string; idempotency_key: string}): Promise<RealizeRefundResponseV1>;
  getRefund(refundId: string): Promise<RealizeRefundResponseV1>;
}

export const RealizeSettlementResponseV1Schema = z.object({
  settlement_id: id,
  status: z.enum(["accepted", "processing", "partial", "settled", "failed"]),
  transaction_signatures: z.array(z.string().min(32).max(128)).max(64).default([]),
  settled_amount_usdc_atomic: atomic.optional(),
  failed_payout_ids: z.array(id).max(64).default([]),
  updated_at: z.string().datetime({offset: true})
}).strict();
export type RealizeSettlementResponseV1 = z.infer<typeof RealizeSettlementResponseV1Schema>;

export const RealizeRefundResponseV1Schema = z.object({
  refund_id: id,
  status: z.enum(["accepted", "processing", "refunded", "failed", "uncertain"]),
  transaction_signature: z.string().min(32).max(128).optional(),
  retryable: z.boolean().optional(),
  updated_at: z.string().datetime({offset: true})
}).strict();
export type RealizeRefundResponseV1 = z.infer<typeof RealizeRefundResponseV1Schema>;

export const RealizePaymentIntentResolutionV1Schema = z.object({
  payment_intent_id: id,
  kind: z.enum(["none", "settlement", "refund"]),
  record_id: id.optional(),
  state: z.string().max(64).optional(),
  settled_amount_usdc_atomic: atomic.optional(),
  batch_statuses: z.array(z.enum(["prepared", "finalized", "failed", "uncertain"])).max(64).optional()
}).strict();
export type RealizePaymentIntentResolutionV1 = z.infer<typeof RealizePaymentIntentResolutionV1Schema>;

function assertProviderUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password || url.search || url.hash) throw new Error("Populi API URL must not contain credentials, a query, or a fragment");
  const ipVersion = isIP(hostname);
  const privateIpv4 = ipVersion === 4 && (/^(10|127|0)\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname));
  const privateIpv6 = ipVersion === 6 && (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:"));
  if (process.env.NODE_ENV === "production" && (url.protocol !== "https:" || ipVersion !== 0 || hostname === "localhost" || hostname.endsWith(".local") || privateIpv4 || privateIpv6)) {
    throw new Error("Populi API must use an externally routable HTTPS origin in production");
  }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"))) {
    throw new Error("Populi API must use HTTPS (local HTTP is allowed only outside production)");
  }
  return url;
}

export class RealizeProviderHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number) {
    super(`Populi request failed with HTTP ${status}`);
  }
}

async function providerJson<T>(configuration: RealizeCreatorPayoutConfigurationV1, path: string, init: RequestInit, schema: {parse(input: unknown): T}): Promise<T> {
  const base = assertProviderUrl(configuration.populi_api_base_url);
  const token = process.env[configuration.populi_api_token_env];
  if (!token) throw new Error(`Populi authentication is not configured (${configuration.populi_api_token_env})`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const url = new URL(path.replace(/^\//, ""), base.href.endsWith("/") ? base : `${base.href}/`);
    const response = await fetch(url, {redirect: "error", ...init, signal: controller.signal, headers: {authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", ...(init.headers ?? {})}});
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 256_000) throw new Error("Populi response exceeds the Realize response size limit");
    const bodyText = await response.text();
    if (bodyText.length > 256_000) throw new Error("Populi response exceeds the Realize response size limit");
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 5_000;
      throw new RealizeProviderHttpError(response.status, Number.isFinite(delay) ? Math.max(5_000, delay) : 5_000);
    }
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { throw new Error("Populi returned invalid JSON"); }
    return schema.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

export class HttpPopuliRealizeClient implements PopuliRealizeClient {
  async getInputSchema(configuration: RealizeCreatorPayoutConfigurationV1, schemaUri: string, creatorId: string): Promise<Record<string, unknown>> {
    const base = assertProviderUrl(configuration.populi_api_base_url);
    const schema = new URL(schemaUri);
    // Never forward the service token to an origin or endpoint supplied by a customer.
    if (schema.username || schema.password || schema.hash || schema.origin !== base.origin || !schema.pathname.startsWith("/v1/realize/schemas/")) throw new Error("Provider input schema must use its configured Realize schema origin");
    const schemaCreatorIds = schema.searchParams.getAll("creator_id");
    if ([...schema.searchParams.keys()].some((key) => key !== "creator_id") || schemaCreatorIds.length > 1 || (schemaCreatorIds.length === 1 && schemaCreatorIds[0] !== creatorId)) {
      throw new Error("Provider input schema has unsupported or mismatched query parameters");
    }
    return providerJson(configuration, `${schema.pathname}${schema.search}`, {method: "GET"}, z.record(z.unknown()).refine((value) => value.type === "object", "input schema must describe an object"));
  }

  async getCapabilities(configuration: RealizeCreatorPayoutConfigurationV1, creatorId: string): Promise<CreatorCapabilitiesV1> {
    const capabilities = await providerJson(configuration, `/v1/realize/creators/${encodeURIComponent(creatorId)}/capabilities`, {method: "GET"}, CreatorCapabilitiesV1Schema);
    if (capabilities.creator_id !== creatorId) throw new Error("Populi capability response names a different creator");
    return capabilities;
  }

  async getCurrentPrice(configuration: RealizeCreatorPayoutConfigurationV1, request: ProviderPricingRequestV1): Promise<ProviderPriceQuoteV1> {
    return providerJson(configuration, "/v1/realize/provider-prices", {method: "POST", body: JSON.stringify(request), headers: {"idempotency-key": request.request_id}}, ProviderPriceQuoteV1Schema);
  }

  async requestFulfillment(configuration: RealizeCreatorPayoutConfigurationV1, request: ProviderFulfillmentRequestV1): Promise<FulfillmentResultV1> {
    const parsed = ProviderFulfillmentRequestV1Schema.parse(request);
    return providerJson(configuration, "/v1/realize/fulfillments", {method: "POST", body: JSON.stringify(parsed), headers: {"idempotency-key": parsed.idempotency_key}}, FulfillmentResultV1Schema);
  }

  async getFulfillment(configuration: RealizeCreatorPayoutConfigurationV1, fulfillmentRequestId: string): Promise<FulfillmentResultV1> {
    return providerJson(configuration, `/v1/realize/fulfillments/${encodeURIComponent(fulfillmentRequestId)}`, {method: "GET"}, FulfillmentResultV1Schema);
  }
}

async function settlementJson<T>(path: string, init: RequestInit, schema: {parse(input: unknown): T}): Promise<T> {
  const baseUrl = process.env.VOX_REALIZE_SETTLEMENT_URL;
  const token = process.env.VOX_REALIZE_SETTLEMENT_TOKEN;
  if (!baseUrl || !token) throw new Error("The Solana Realize settlement adapter is not configured");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error("The Solana Realize settlement adapter must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("The Solana Realize settlement URL is invalid");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {redirect: "error", ...init, signal: controller.signal, headers: {authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", ...(init.headers ?? {})}});
    const text = await response.text();
    if (text.length > 256_000) throw new Error("Settlement adapter response exceeds the size limit");
    if (!response.ok) throw new Error(`Solana settlement adapter failed with HTTP ${response.status}`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error("Solana settlement adapter returned invalid JSON"); }
    return schema.parse(body);
  } finally { clearTimeout(timeout); }
}

export class HttpSolanaRealizeSettlementClient implements SolanaRealizeSettlementClient {
  async requestSettlement(instruction: SettlementInstructionV1): Promise<SettlementAcknowledgmentV1> {
    const parsed = SettlementInstructionV1Schema.parse(instruction);
    const response = await settlementJson("v1/settlements", {method: "POST", body: JSON.stringify(parsed), headers: {"idempotency-key": parsed.settlement_id}}, RealizeSettlementResponseV1Schema);
    if (response.settlement_id !== parsed.settlement_id) throw new Error("settlement adapter returned a different settlement id");
    return {protocol_version: "realize/1", settlement_id: parsed.settlement_id, accepted: true};
  }
  getSettlement(settlementId: string): Promise<RealizeSettlementResponseV1> {
    return settlementJson(`v1/settlements/${encodeURIComponent(settlementId)}`, {method: "GET"}, RealizeSettlementResponseV1Schema);
  }
  requestRefund(input: {commission_id: string; payment_intent_id: string; accepted_quote_hash: string; amount_usdc_atomic: string; network_id: string; usdc_mint: string; payer_wallet: string; funding_transaction_signature: string; payment_reference: string; idempotency_key: string}): Promise<RealizeRefundResponseV1> {
    return settlementJson("v1/refunds", {method: "POST", body: JSON.stringify(input), headers: {"idempotency-key": input.idempotency_key}}, RealizeRefundResponseV1Schema);
  }
  getRefund(refundId: string): Promise<RealizeRefundResponseV1> {
    return settlementJson(`v1/refunds/${encodeURIComponent(refundId)}`, {method: "GET"}, RealizeRefundResponseV1Schema);
  }
  getPaymentIntentResolution(paymentIntentId: string): Promise<RealizePaymentIntentResolutionV1> {
    return settlementJson(`v1/payment-intents/${encodeURIComponent(paymentIntentId)}/resolution`, {method: "GET"}, RealizePaymentIntentResolutionV1Schema);
  }
}

export function generationParametersHash(parameters: Record<string, unknown>): string {
  return bytesToHex(domainHash("vox.realize.generation.parameters.v1", canonicalBytes(parameters)));
}

function halfUpPercent(base: bigint, basisPoints: number): bigint {
  return (base * BigInt(basisPoints) + 5_000n) / 10_000n;
}

function applyFee(providerBase: bigint, ownerSubtotal: bigint, fee: z.infer<typeof FeeFormulaV1Schema>): bigint {
  const base = fee.percentage_basis === "provider_plus_owner" ? providerBase + ownerSubtotal : providerBase;
  const variable = halfUpPercent(base, fee.percent_basis_points);
  const fixed = BigInt(fee.fixed_amount_usdc_atomic);
  const minimum = BigInt(fee.minimum_amount_usdc_atomic);
  return fixed + variable > minimum ? fixed + variable : minimum;
}

function splitAmountsByBasisPoints(amount: bigint, recipients: Array<{recipient_id: string; basis_points: number}>): Array<{recipient_id: string; amount: bigint}> {
  const parts = recipients.map((recipient, index) => {
    const numerator = amount * BigInt(recipient.basis_points);
    return {recipient_id: recipient.recipient_id, amount: numerator / 10_000n, remainder: numerator % 10_000n, index};
  });
  let remainder = amount - parts.reduce((sum, part) => sum + part.amount, 0n);
  const ranked = [...parts].sort((left, right) => left.remainder === right.remainder
    ? compareCanonicalIds(left.recipient_id, right.recipient_id) || left.index - right.index
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) ranked[index % ranked.length]!.amount += 1n;
  return parts.filter((part) => part.amount > 0n).map(({recipient_id, amount: value}) => ({recipient_id, amount: value}));
}

function splitByBasisPoints(amount: bigint, recipients: z.infer<typeof WeightedRecipientV1Schema>[]): Array<{recipient_id: string; destination: string; amount: bigint}> {
  const amounts = new Map(splitAmountsByBasisPoints(amount, recipients).map((part) => [part.recipient_id, part.amount]));
  return recipients.filter((recipient) => (amounts.get(recipient.recipient_id) ?? 0n) > 0n).map((recipient) => ({recipient_id: recipient.recipient_id, destination: recipient.destination, amount: amounts.get(recipient.recipient_id)!}));
}

function payoutId(commissionId: string, pricingRequestId: string, role: string, recipientId: string): string {
  const seed = `${commissionId}\u0000${pricingRequestId}\u0000${role}\u0000${recipientId}`;
  return `vox:payout:${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}

function ensureU64(value: bigint, description: string): string {
  if (value < 0n || value > 18_446_744_073_709_551_615n) throw new Error(`${description} exceeds the USDC u64 limit`);
  return value.toString();
}

export function validateProviderPrice(input: {
  providerQuote: ProviderPriceQuoteV1;
  request: ProviderPricingRequestV1;
  capabilities: CreatorCapabilitiesV1;
  now: string;
}): ProviderPriceQuoteV1 {
  const quote = ProviderPriceQuoteV1Schema.parse(input.providerQuote);
  const now = Date.parse(input.now);
  const issuedAt = Date.parse(quote.issued_at);
  if (quote.request_id !== input.request.request_id || quote.creator_id !== input.request.creator_id || quote.capability_id !== input.request.capability_id || quote.generation_provider_id !== input.request.generation_provider_id || quote.requested_generation_parameters_hash !== input.request.requested_generation_parameters_hash) throw new Error("Populi price quote does not match the requested creator, capability, provider, or generation parameters");
  if (!input.capabilities.generation_provider_ids.includes(quote.generation_provider_id) || !input.capabilities.capabilities.some((capability) => capability.capability_id === quote.capability_id)) throw new Error("Populi price quote references an unadvertised capability or provider");
  if (issuedAt > now + 60_000 || now - issuedAt > REALIZE_MAX_PROVIDER_PRICE_AGE_SECONDS * 1_000 || Date.parse(quote.expires_at) <= now) throw new Error("Populi price quote is not current");
  return quote;
}

export function buildRealizeQuote(input: {
  configuration: RealizeCreatorPayoutConfigurationV1;
  commissionId: string;
  pricingRequestId: string;
  pricingRequestHash: string;
  capabilityId: string;
  generationProviderId: string;
  generationParameters: Record<string, unknown>;
  outputMediaTypes: string[];
  providerPrice: ProviderPriceQuoteV1;
  issuedAt: string;
  issuerId: string;
  issuerKeyId: string;
  issuerPublicKey: string;
  issuerSecretKey: Uint8Array;
  quoteId?: string;
}): RealizeQuoteV1 {
  const configuration = RealizeCreatorPayoutConfigurationV1Schema.parse(input.configuration);
  const providerPayouts = configuration.provider_payouts.find((item) => item.provider_id === input.generationProviderId);
  if (!providerPayouts) throw new Error("No server-managed payout destinations are configured for this provider");
  const providerCost = BigInt(input.providerPrice.price_usdc_atomic);
  let providerBase = providerCost;
  let ownerAmount = applyFee(providerBase, 0n, configuration.character_owner_markup.fee);
  let platformAmount = applyFee(providerBase, ownerAmount, configuration.platform_fee.fee);
  let total = providerBase + ownerAmount + platformAmount;
  let revenueAllocationPolicy: MainnetPricingPolicyV1 | undefined;
  if (configuration.network_id === "solana:mainnet-beta") {
    const mainnetPolicy = MainnetPricingPolicyV1Schema.parse(configuration.mainnet_pricing_policy ?? DEFAULT_MAINNET_PRICING_POLICY);
    revenueAllocationPolicy = mainnetPolicy;
    if (configuration.additional_beneficiaries.length > 0) throw new Error("Mainnet 25/70/5 provider/owner/VOX pricing does not allow additional payout allocations");
    const providerRequiredGross = (providerCost * 10_000n + BigInt(mainnetPolicy.provider_basis_points) - 1n) / BigInt(mainnetPolicy.provider_basis_points);
    total = providerRequiredGross > BigInt(mainnetPolicy.minimum_total_usdc_atomic) ? providerRequiredGross : BigInt(mainnetPolicy.minimum_total_usdc_atomic);
    if (total > BigInt(mainnetPolicy.maximum_total_usdc_atomic)) throw new Error("Dynamic Mainnet quote exceeds the configured maximum payment");
    const amounts = new Map(splitAmountsByBasisPoints(total, [
      {recipient_id: "generation_provider", basis_points: mainnetPolicy.provider_basis_points},
      {recipient_id: "character_owner", basis_points: mainnetPolicy.character_owner_basis_points},
      {recipient_id: "platform", basis_points: mainnetPolicy.platform_basis_points}
    ]).map((part) => [part.recipient_id, part.amount]));
    providerBase = amounts.get("generation_provider") ?? 0n;
    ownerAmount = amounts.get("character_owner") ?? 0n;
    platformAmount = amounts.get("platform") ?? 0n;
    if (providerBase < providerCost) throw new Error("Mainnet provider allocation does not cover the quoted provider cost");
  }
  const additional = configuration.additional_beneficiaries.map((beneficiary) => ({
    recipient_id: beneficiary.recipient_id,
    role: beneficiary.role,
    amount: applyFee(providerBase, ownerAmount, beneficiary.fee),
    destination: beneficiary.destination
  })).filter((beneficiary) => beneficiary.amount > 0n);
  total = providerBase + ownerAmount + platformAmount + additional.reduce((sum, beneficiary) => sum + beneficiary.amount, 0n);
  const issuedAtMs = Date.parse(input.issuedAt);
  const providerExpiry = Date.parse(input.providerPrice.expires_at);
  const expiresAtMs = Math.min(issuedAtMs + configuration.quote_ttl_seconds * 1_000, providerExpiry);
  if (!Number.isFinite(issuedAtMs) || expiresAtMs <= issuedAtMs) throw new Error("Provider price expires too soon to issue a quote");

  const recipients: Array<{payout_id: string; recipient_id: string; role: "generation_provider" | "character_owner" | "platform" | "commissioner" | "referrer" | "sponsor" | "additional_beneficiary"; amount_usdc_atomic: string; destination: string}> = [];
  const destinationPrefix = configuration.network_id === "solana:mainnet-beta" ? "solana:mainnet" : configuration.network_id;
  const destination = (wallet: string) => `${destinationPrefix}:${wallet}`;
  const addAllocation = (role: "generation_provider" | "character_owner" | "platform", amount: bigint, allocation: z.infer<typeof FeeAllocationV1Schema> | {recipients: z.infer<typeof WeightedRecipientV1Schema>[]}) => {
    if (amount === 0n) return;
    for (const part of splitByBasisPoints(amount, allocation.recipients)) recipients.push({payout_id: payoutId(input.commissionId, input.pricingRequestId, role, part.recipient_id), recipient_id: part.recipient_id, role, amount_usdc_atomic: ensureU64(part.amount, `${role} payout`), destination: destination(part.destination)});
  };
  const providerAllocation = {recipients: providerPayouts.recipients};
  addAllocation("generation_provider", providerBase, providerAllocation);
  addAllocation("character_owner", ownerAmount, configuration.character_owner_markup);
  addAllocation("platform", platformAmount, configuration.platform_fee);
  for (const beneficiary of additional) recipients.push({payout_id: payoutId(input.commissionId, input.pricingRequestId, beneficiary.role, beneficiary.recipient_id), recipient_id: beneficiary.recipient_id, role: beneficiary.role, amount_usdc_atomic: ensureU64(beneficiary.amount, "additional beneficiary payout"), destination: destination(beneficiary.destination)});
  const roleOrder = new Map([["generation_provider", 0], ["character_owner", 1], ["platform", 2], ["commissioner", 3], ["referrer", 4], ["sponsor", 5], ["additional_beneficiary", 6]]);
  recipients.sort((left, right) => roleOrder.get(left.role)! - roleOrder.get(right.role)! || compareCanonicalIds(left.recipient_id, right.recipient_id));
  if (recipients.length > 64) throw new Error("Quote exceeds the maximum payout recipient count");

  const unsignedQuote = {
    protocol_version: "realize/1" as const,
    quote_id: input.quoteId ?? `vox:quote:${createHash("sha256").update(`${input.commissionId}\u0000${input.pricingRequestId}`).digest("hex")}`,
    pricing_request_id: input.pricingRequestId,
    pricing_request_hash: input.pricingRequestHash,
    commission_id: input.commissionId,
    creator_id: configuration.creator_id,
    capability_id: input.capabilityId,
    character_owner_id: configuration.character_owner_id,
    character_owner_recipient_ids: configuration.character_owner_markup.recipients.map((recipient) => recipient.recipient_id).sort(),
    generation_provider_id: input.generationProviderId,
    generation_provider_recipient_ids: providerPayouts.recipients.map((recipient) => recipient.recipient_id).sort(),
    requested_generation_parameters: input.generationParameters,
    output_media_types: [...new Set(input.outputMediaTypes)].sort(),
    provider_cost_usdc_atomic: ensureU64(providerCost, "provider cost"),
    provider_base_price_usdc_atomic: ensureU64(providerBase, "provider price"),
    provider_price_quote_id: input.providerPrice.provider_quote_id,
    provider_price_quote_hash: bytesToHex(domainHash("vox.realize.provider-price.v1", canonicalBytes(input.providerPrice))),
    provider_price_issued_at: input.providerPrice.issued_at,
    payout_configuration_version: configuration.version,
    payout_configuration_hash: bytesToHex(domainHash("vox.realize.payout-configuration.v1", canonicalBytes(configuration))),
    rounding_policy: REALIZE_ROUNDING_POLICY,
    ...(revenueAllocationPolicy ? {revenue_allocation_policy: revenueAllocationPolicy} : {}),
    usdc_mint: configuration.usdc_mint,
    network_id: configuration.network_id,
    settlement_program_version: configuration.settlement_program_version,
    character_owner_markup_usdc_atomic: ensureU64(ownerAmount, "character owner share"),
    platform_fee_usdc_atomic: ensureU64(platformAmount, "VOX platform fee"),
    additional_beneficiaries: additional.map((beneficiary) => ({recipient_id: beneficiary.recipient_id, role: beneficiary.role, amount_usdc_atomic: ensureU64(beneficiary.amount, "additional beneficiary amount")})),
    total_amount_usdc_atomic: ensureU64(total, "quote total"),
    payout_recipients: recipients,
    expires_at: new Date(expiresAtMs).toISOString(),
    issued_at: input.issuedAt,
    rights_agreement_reference: configuration.rights_agreement_reference,
    ...(configuration.rights_policy_mode ? {rights_policy_mode: configuration.rights_policy_mode} : {}),
    rights_agreement_version: configuration.rights_agreement_version,
    rights_agreement_hash: configuration.rights_agreement_hash,
    issuer_id: input.issuerId,
    issuer_key_id: input.issuerKeyId,
    issuer_public_key: input.issuerPublicKey
  };
  const canonical_quote_hash = computeRealizeQuoteHash(unsignedQuote as Omit<RealizeQuoteV1, "canonical_quote_hash" | "signature">);
  const quote = {...unsignedQuote, canonical_quote_hash, signature: signRealizeQuote(canonical_quote_hash, input.issuerSecretKey)};
  return RealizeQuoteV1Schema.parse(quote);
}

export function createRealizeSettlementInstruction(input: {
  quote: RealizeQuoteV1;
  commissionId: string;
  paymentIntentId: string;
  createdAt: string;
  computeUnitsPerRecipient?: number;
  serializedBytesPerRecipient?: number;
}): SettlementInstructionV1 {
  const quote = RealizeQuoteV1Schema.parse(input.quote);
  if (!quote.usdc_mint || !quote.network_id || !quote.settlement_program_version) throw new Error("Quote is missing its settlement network, mint, or program version binding");
  const payouts = quote.payout_recipients.map((recipient) => {
    if (!recipient.destination) throw new Error(`Payout ${recipient.payout_id} has no server-configured destination`);
    return recipient;
  });
  const batches = [];
  let start = 0;
  while (start < payouts.length) {
    let count = Math.min(REALIZE_MAX_RECIPIENTS_PER_TRANSACTION, payouts.length - start);
    let group = payouts.slice(start, start + count);
    let computeUnits = (input.computeUnitsPerRecipient ?? 40_000) * group.length;
    let serializedSize = 256 + (input.serializedBytesPerRecipient ?? 180) * group.length;
    while (count > 1 && (computeUnits > REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION || serializedSize > REALIZE_MAX_TRANSACTION_BYTES)) {
      count -= 1;
      group = payouts.slice(start, start + count);
      computeUnits = (input.computeUnitsPerRecipient ?? 40_000) * group.length;
      serializedSize = 256 + (input.serializedBytesPerRecipient ?? 180) * group.length;
    }
    if (computeUnits > REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION || serializedSize > REALIZE_MAX_TRANSACTION_BYTES) throw new Error("One payout exceeds Solana transaction resource limits");
    batches.push({transaction_index: batches.length, payout_ids: group.map((recipient) => recipient.payout_id), compute_units: computeUnits, serialized_size_bytes: serializedSize});
    start += count;
    if (batches.length > REALIZE_MAX_TRANSACTION_BATCHES) throw new Error("Settlement exceeds the maximum transaction batch count");
  }
  const settlementId = `vox:settlement:${createHash("sha256").update(`${input.commissionId}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
  return SettlementInstructionV1Schema.parse({
    protocol_version: "realize/1",
    settlement_id: settlementId,
    commission_id: input.commissionId,
    payment_intent_id: input.paymentIntentId,
    quote_id: quote.quote_id,
    canonical_quote_hash: quote.canonical_quote_hash,
    asset: "USDC",
    network_id: quote.network_id,
    usdc_mint: quote.usdc_mint,
    settlement_program_version: quote.settlement_program_version,
    total_amount_usdc_atomic: quote.total_amount_usdc_atomic,
    payout_recipients: payouts,
    transaction_batches: batches,
    created_at: input.createdAt
  });
}

export function newRealizeId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function realizeCanonicalHash(value: unknown, domain: string): string {
  return bytesToHex(domainHash(domain, utf8(canonicalize(value))));
}

import {z} from "zod";
import {
  REALIZE_PROTOCOL_VERSION, CommissionV1Schema, PaymentIntentV1Schema,
  CreatorCapabilitiesV1Schema, CreatorPricingRequestV1Schema, CreatorPricingResponseV1Schema,
  FulfillmentRequestV1Schema, FulfillmentResultV1Schema, ProviderPricingRequestV1Schema,
  ProviderPriceQuoteV1Schema, SettlementInstructionV1Schema, UsdcAtomicV1Schema,
  type CommissionV1
} from "./realize.js";

const version = z.literal(REALIZE_PROTOCOL_VERSION);
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({offset: true});

export const RealizeErrorCodeV1Schema = z.enum([
  "INVALID_REQUEST", "UNSUPPORTED_PROTOCOL_VERSION", "UNAUTHORIZED", "FORBIDDEN",
  "CREATOR_NOT_FOUND", "CAPABILITY_NOT_FOUND", "COMMISSION_NOT_FOUND", "QUOTE_NOT_FOUND",
  "PRICE_UNAVAILABLE", "PROVIDER_UNAVAILABLE", "QUOTE_EXPIRED", "QUOTE_HASH_MISMATCH",
  "QUOTE_SIGNATURE_INVALID", "QUOTE_IMMUTABLE", "RIGHTS_AGREEMENT_REQUIRED",
  "INVALID_STATE_TRANSITION", "PAYMENT_REQUIRED", "PAYMENT_UNVERIFIED",
  "PAYMENT_AMOUNT_MISMATCH", "PAYMENT_REPLAYED", "PAYMENT_IN_PROGRESS",
  "SETTLEMENT_MISMATCH", "FULFILLMENT_FAILED", "PROVIDER_TIMEOUT",
  "IDEMPOTENCY_CONFLICT", "RESOURCE_LIMIT_EXCEEDED", "RATE_LIMITED",
  "WEBHOOK_SIGNATURE_INVALID", "WEBHOOK_REPLAYED"
]);
export const RealizeErrorV1Schema = z.object({
  protocol_version: version,
  code: RealizeErrorCodeV1Schema,
  message: z.string().min(1).max(2_000),
  request_id: id.optional(),
  retryable: z.boolean(),
  details: z.record(z.string().max(128), z.string().max(2_000)).optional()
}).strict();
export type RealizeErrorCodeV1 = z.infer<typeof RealizeErrorCodeV1Schema>;
export type RealizeErrorV1 = z.infer<typeof RealizeErrorV1Schema>;

/** Protocol errors are data; HTTP and persistence adapters choose their transport. */
export class RealizeContractError extends Error {
  constructor(public readonly code: RealizeErrorCodeV1, message: string) {
    super(message);
    this.name = "RealizeContractError";
  }
}

export const CreateCommissionRequestV1Schema = z.object({
  protocol_version: version,
  commission_id: id,
  commissioner_id: id,
  creator_id: id,
  capability_id: id,
  requested_generation_parameters: CreatorPricingRequestV1Schema.shape.requested_generation_parameters,
  rights_agreement_reference: id
}).strict();
export const AcceptQuoteRequestV1Schema = z.object({
  protocol_version: version,
  commission_id: id,
  quote_id: id,
  canonical_quote_hash: hash
}).strict();
export const AcceptQuoteResponseV1Schema = z.object({
  protocol_version: version,
  commission: CommissionV1Schema,
  payment_intent: PaymentIntentV1Schema
}).strict().superRefine((response, context) => {
  const {commission, payment_intent: intent} = response;
  if (commission.commission_id !== intent.commission_id || commission.quote_id !== intent.quote_id ||
    commission.accepted_quote_hash !== intent.accepted_quote_hash || commission.commissioner_id !== intent.payer_id) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["payment_intent"], message: "payment intent must bind to the accepted commission"});
  }
});
export const CreatePaymentIntentRequestV1Schema = z.object({
  protocol_version: version,
  commission_id: id,
  quote_id: id,
  accepted_quote_hash: hash,
  network_id: id
}).strict();

/** Evidence asserted by an authenticated, authorized commissioning service. */
export const ExternalFundingAuthorizationV1Schema = z.object({
  protocol_version: version,
  authorization_id: id,
  payment_intent_id: id,
  commission_id: id,
  accepted_quote_hash: hash,
  asset: z.literal("USDC"),
  total_amount_usdc_atomic: UsdcAtomicV1Schema.and(z.string().regex(/^[1-9][0-9]*$/)),
  provider_amount_usdc_atomic: UsdcAtomicV1Schema.and(z.string().regex(/^[1-9][0-9]*$/)),
  network_id: id,
  payment_reference: id,
  verified_by: id,
  verified_at: timestamp
}).strict().superRefine((funding, context) => {
  if (UsdcAtomicV1Schema.safeParse(funding.total_amount_usdc_atomic).success && UsdcAtomicV1Schema.safeParse(funding.provider_amount_usdc_atomic).success && BigInt(funding.provider_amount_usdc_atomic) > BigInt(funding.total_amount_usdc_atomic)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_amount_usdc_atomic"], message: "provider amount may not exceed the total payment"});
  }
});

/** The Populi HTTP profile requires an authoritative provider quote and external funding. */
export const ProviderFulfillmentRequestV1Schema = FulfillmentRequestV1Schema.extend({
  provider_quote_id: id,
  funding_authorization: ExternalFundingAuthorizationV1Schema
}).strict().superRefine((request, context) => {
  if (request.funding_authorization.commission_id !== request.commission_id || request.funding_authorization.accepted_quote_hash !== request.accepted_quote_hash) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["funding_authorization"], message: "funding must bind to the fulfillment commission and accepted quote"});
  }
});
export const WebhookAcknowledgmentV1Schema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean().optional()
}).strict();
export const SettlementAcknowledgmentV1Schema = z.object({
  protocol_version: version,
  settlement_id: id,
  accepted: z.literal(true)
}).strict();

export type CreateCommissionRequestV1 = z.infer<typeof CreateCommissionRequestV1Schema>;
export type AcceptQuoteRequestV1 = z.infer<typeof AcceptQuoteRequestV1Schema>;
export type AcceptQuoteResponseV1 = z.infer<typeof AcceptQuoteResponseV1Schema>;
export type CreatePaymentIntentRequestV1 = z.infer<typeof CreatePaymentIntentRequestV1Schema>;
export type ExternalFundingAuthorizationV1 = z.infer<typeof ExternalFundingAuthorizationV1Schema>;
export type ProviderFulfillmentRequestV1 = z.infer<typeof ProviderFulfillmentRequestV1Schema>;
export type WebhookAcknowledgmentV1 = z.infer<typeof WebhookAcknowledgmentV1Schema>;
export type SettlementAcknowledgmentV1 = z.infer<typeof SettlementAcknowledgmentV1Schema>;

/** Implementations map these interfaces to HTTP, an RPC transport, or local calls. */
export interface RealizeCreatorServiceV1 {
  getCapabilities(creatorId: string): Promise<z.infer<typeof CreatorCapabilitiesV1Schema>>;
  price(request: z.infer<typeof CreatorPricingRequestV1Schema>): Promise<z.infer<typeof CreatorPricingResponseV1Schema>>;
}
export interface RealizeCommissionServiceV1 {
  createCommission(request: CreateCommissionRequestV1): Promise<CommissionV1>;
  acceptQuote(request: AcceptQuoteRequestV1): Promise<AcceptQuoteResponseV1>;
  getCommission(commissionId: string): Promise<CommissionV1>;
  createPaymentIntent(request: CreatePaymentIntentRequestV1): Promise<z.infer<typeof PaymentIntentV1Schema>>;
  requestSettlement(instruction: z.infer<typeof SettlementInstructionV1Schema>): Promise<SettlementAcknowledgmentV1>;
}
export interface RealizeGenerationProviderV1 {
  getCapabilities(creatorId: string): Promise<z.infer<typeof CreatorCapabilitiesV1Schema>>;
  getCurrentPrice(request: z.infer<typeof ProviderPricingRequestV1Schema>): Promise<z.infer<typeof ProviderPriceQuoteV1Schema>>;
  requestFulfillment(request: ProviderFulfillmentRequestV1): Promise<z.infer<typeof FulfillmentResultV1Schema>>;
  getFulfillment(fulfillmentRequestId: string): Promise<z.infer<typeof FulfillmentResultV1Schema>>;
}

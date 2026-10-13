import {canonicalize, canonicalBytes} from "./canonical.js";
import {bytesToHex, concatBytes, hexToBytes, utf8} from "./encoding.js";
import {domainHash} from "./hash.js";
import {signBytes, verifyBytes} from "./realize-crypto.js";
import {z} from "zod";

/** Realize v1 represents USDC in six-decimal token base units, never decimal dollars. */
export const REALIZE_PROTOCOL_VERSION = "realize/1" as const;
/** A standing rights-agreement party accepted by the customer per signed quote. */
export const REALIZE_COMMISSIONER_ROLE_PARTY_ID = "vox:role:commissioner" as const;
export const USDC_BASE_UNITS_PER_USDC = 1_000_000n;
export const USDC_MAX_BASE_UNITS = 18_446_744_073_709_551_615n;
export const REALIZE_MAX_PAYOUT_RECIPIENTS = 64;
export const REALIZE_MAX_RECIPIENTS_PER_TRANSACTION = 8;
export const REALIZE_MAX_TRANSACTION_BATCHES = 64;
export const REALIZE_MAX_TRANSACTION_BYTES = 1_232;
export const REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION = 1_400_000;

const isoDate = z.string().datetime({offset: true});
const digest = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const amountPattern = /^(0|[1-9][0-9]{0,19})$/;
const validAmount = (value: string): boolean => amountPattern.test(value) && (value.length < 20 || value <= USDC_MAX_BASE_UNITS.toString());
export const UsdcAtomicV1Schema = z.string().regex(amountPattern, "must be a canonical integer string in USDC base units")
  .refine(validAmount, "exceeds the USDC u64 amount limit");
const atomicAmount = UsdcAtomicV1Schema;
const positiveAtomicAmount = atomicAmount.and(z.string().regex(/^[1-9][0-9]*$/, "must be greater than zero"));
const protocolVersion = z.literal(REALIZE_PROTOCOL_VERSION);
const stableId = z.string().min(1).max(256);
const ed25519PublicKey = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, "must be a canonical unpadded base64url Ed25519 public key");
const signature = z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/, "must be a canonical unpadded base64url Ed25519 signature");

/**
 * Parameters are intentionally bounded and canonical-JSON-safe. Encode decimal
 * generation controls such as temperature as strings; integer parameters remain
 * JSON numbers so the existing VOX canonical serializer can hash them exactly.
 */
export const GenerationParametersV1Schema = z.record(
  z.string().min(1).max(64),
  z.union([
    z.string().max(4_000),
    z.number().int().safe(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(4_000), z.number().int().safe(), z.boolean(), z.null()])).max(64)
  ])
).superRefine((parameters, context) => {
  if (Object.keys(parameters).length > 64) context.addIssue({code: z.ZodIssueCode.custom, message: "at most 64 generation parameters are allowed"});
});

export const PayoutRoleV1Schema = z.enum([
  "generation_provider",
  "character_owner",
  "platform",
  "commissioner",
  "referrer",
  "sponsor",
  "additional_beneficiary"
]);

export const PayoutRecipientV1Schema = z.object({
  payout_id: stableId,
  recipient_id: stableId,
  role: PayoutRoleV1Schema,
  amount_usdc_atomic: positiveAtomicAmount,
  /** Network-qualified address or payment endpoint; omitted until settlement routing is known. */
  destination: z.string().min(1).max(512).optional()
}).strict();

export const AdditionalBeneficiaryV1Schema = z.object({
  recipient_id: stableId,
  role: z.enum(["commissioner", "referrer", "sponsor", "additional_beneficiary"]),
  amount_usdc_atomic: positiveAtomicAmount
}).strict();

export const CreatorCapabilitiesV1Schema = z.object({
  protocol_version: protocolVersion,
  creator_id: stableId,
  generation_provider_ids: z.array(stableId).min(1).max(16),
  capabilities: z.array(z.object({
    capability_id: stableId,
    input_schema_uri: z.string().url().max(2_048),
    output_media_types: z.array(z.string().min(1).max(128)).min(1).max(32),
    max_output_count: z.number().int().min(1).max(64).optional(),
    max_duration_seconds: z.number().int().min(1).max(86_400).optional()
  }).strict()).min(1).max(64),
  rights_agreement_references: z.array(stableId).max(64).optional(),
  discovery_uri: z.string().url().max(2_048).optional(),
  updated_at: isoDate
}).strict().superRefine((creator, context) => {
  if (new Set(creator.generation_provider_ids).size !== creator.generation_provider_ids.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["generation_provider_ids"], message: "provider IDs must be unique"});
  if (new Set(creator.capabilities.map((capability) => capability.capability_id)).size !== creator.capabilities.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["capabilities"], message: "capability IDs must be unique"});
});

export const CreatorPricingRequestV1Schema = z.object({
  protocol_version: protocolVersion,
  request_id: stableId,
  commission_id: stableId.optional(),
  requester_id: stableId,
  creator_id: stableId,
  capability_id: stableId,
  generation_provider_id: stableId.optional(),
  requested_generation_parameters: GenerationParametersV1Schema,
  rights_agreement_reference: stableId.optional(),
  requested_at: isoDate
}).strict();

/** A raw current price returned by a creator's generation provider. */
export const ProviderPriceQuoteV1Schema = z.object({
  protocol_version: protocolVersion,
  request_id: stableId,
  provider_quote_id: stableId,
  creator_id: stableId,
  capability_id: stableId,
  generation_provider_id: stableId,
  requested_generation_parameters_hash: digest,
  price_usdc_atomic: positiveAtomicAmount,
  issued_at: isoDate,
  expires_at: isoDate
}).strict().superRefine((quote, context) => {
  if (Date.parse(quote.expires_at) <= Date.parse(quote.issued_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["expires_at"], message: "provider price expiration must be later than issue time"});
});

export const ProviderPricingRequestV1Schema = z.object({
  protocol_version: protocolVersion,
  request_id: stableId,
  creator_id: stableId,
  capability_id: stableId,
  generation_provider_id: stableId,
  requested_generation_parameters: GenerationParametersV1Schema,
  requested_generation_parameters_hash: digest,
  rights_agreement_reference: stableId,
  requested_at: isoDate
}).strict();

export const CreatorPricingResponseV1Schema = z.object({
  protocol_version: protocolVersion,
  request_id: stableId,
  creator_id: stableId,
  quotes: z.array(z.lazy(() => RealizeQuoteV1Schema)).min(1).max(10),
  issued_at: isoDate
}).strict().superRefine((response, context) => {
  if (new Set(response.quotes.map((quote) => quote.quote_id)).size !== response.quotes.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["quotes"], message: "quote IDs must be unique"});
  response.quotes.forEach((quote, index) => {
    if (quote.creator_id !== response.creator_id || quote.pricing_request_id !== response.request_id) context.addIssue({code: z.ZodIssueCode.custom, path: ["quotes", index], message: "quotes must bind to the response creator and pricing request"});
  });
});

export function computeRealizeQuoteHash(quote: Omit<RealizeQuoteV1, "canonical_quote_hash" | "signature"> | RealizeQuoteV1): string {
  const {canonical_quote_hash: _ignoredHash, signature: _ignoredSignature, ...unsignedQuote} = quote as RealizeQuoteV1;
  return bytesToHex(domainHash("vox.realize.quote.v1", utf8(canonicalize(unsignedQuote))));
}

export function realizeQuoteSigningPayload(canonicalQuoteHash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(canonicalQuoteHash)) throw new Error("canonical quote hash must be lowercase SHA-256 hex");
  return concatBytes(utf8("vox.realize.quote.signature.v1"), new Uint8Array([0]), hexToBytes(canonicalQuoteHash));
}

export function signRealizeQuote(canonicalQuoteHash: string, secretKey: Uint8Array): string {
  return signBytes(realizeQuoteSigningPayload(canonicalQuoteHash), secretKey);
}

export function verifyRealizeQuoteSignature(quote: RealizeQuoteV1, issuerPublicKey: string | Uint8Array = quote.issuer_public_key): boolean {
  try {
    return computeRealizeQuoteHash(quote) === quote.canonical_quote_hash && verifyBytes(realizeQuoteSigningPayload(quote.canonical_quote_hash), quote.signature, issuerPublicKey);
  } catch {
    return false;
  }
}

export interface RealizeClientRequestSigningInput {
  method: "GET" | "POST";
  path: string;
  principal_id: string;
  issued_at: string;
  body?: unknown;
}

export function realizeClientRequestSigningPayload(input: RealizeClientRequestSigningInput): Uint8Array {
  const signed = {method: input.method, path: input.path, principal_id: input.principal_id, issued_at: input.issued_at, ...(input.body === undefined ? {} : {body: input.body})};
  return concatBytes(utf8("vox.realize.client.signature.v1"), new Uint8Array([0]), canonicalBytes(signed));
}

export function signRealizeClientRequest(input: RealizeClientRequestSigningInput, secretKey: Uint8Array): string {
  return signBytes(realizeClientRequestSigningPayload(input), secretKey);
}

function sumAmounts(values: string[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

export const RealizeQuoteV1Schema = z.object({
  protocol_version: protocolVersion,
  quote_id: stableId,
  pricing_request_id: stableId,
  pricing_request_hash: digest.optional(),
  creator_id: stableId,
  commission_id: stableId.optional(),
  capability_id: stableId.optional(),
  character_owner_id: stableId.optional(),
  character_owner_recipient_ids: z.array(stableId).min(1).max(64).optional(),
  generation_provider_id: stableId,
  generation_provider_recipient_ids: z.array(stableId).min(1).max(64).optional(),
  requested_generation_parameters: GenerationParametersV1Schema,
  output_media_types: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
  /** Provider's quoted cost, which may differ from its gross-revenue allocation. */
  provider_cost_usdc_atomic: atomicAmount.optional(),
  provider_base_price_usdc_atomic: atomicAmount,
  provider_price_quote_id: stableId.optional(),
  provider_price_quote_hash: digest.optional(),
  provider_price_issued_at: isoDate.optional(),
  payout_configuration_version: z.number().int().positive().optional(),
  payout_configuration_hash: digest.optional(),
  rounding_policy: z.enum(["half_up_percent;largest_remainder_remainder_desc_recipient_id_asc"]).optional(),
  revenue_allocation_policy: z.object({
    minimum_total_usdc_atomic: positiveAtomicAmount,
    maximum_total_usdc_atomic: positiveAtomicAmount,
    provider_basis_points: z.number().int().min(1).max(10_000),
    character_owner_basis_points: z.number().int().min(1).max(10_000),
    platform_basis_points: z.number().int().min(1).max(10_000)
  }).strict().optional(),
  usdc_mint: z.string().min(32).max(64).optional(),
  network_id: stableId.optional(),
  settlement_program_version: stableId.optional(),
  character_owner_markup_usdc_atomic: atomicAmount,
  platform_fee_usdc_atomic: atomicAmount,
  additional_beneficiaries: z.array(AdditionalBeneficiaryV1Schema).max(REALIZE_MAX_PAYOUT_RECIPIENTS).optional(),
  total_amount_usdc_atomic: positiveAtomicAmount,
  payout_recipients: z.array(PayoutRecipientV1Schema).min(1).max(REALIZE_MAX_PAYOUT_RECIPIENTS),
  expires_at: isoDate,
  issued_at: isoDate,
  rights_agreement_reference: stableId,
  rights_policy_mode: z.enum(["signed_agreement", "first_party"]).optional(),
  rights_agreement_version: z.number().int().positive().optional(),
  rights_agreement_hash: digest.optional(),
  issuer_id: stableId,
  issuer_key_id: stableId,
  issuer_public_key: ed25519PublicKey,
  canonical_quote_hash: digest,
  signature
}).strict().superRefine((quote, context) => {
  const beneficiaries = quote.additional_beneficiaries ?? [];
  // Zod refinements can run after a primitive has reported a format error.
  // Never pass malformed wire amounts to BigInt or malformed JSON to hashing.
  const amounts = [quote.provider_base_price_usdc_atomic, quote.character_owner_markup_usdc_atomic,
    quote.platform_fee_usdc_atomic, quote.total_amount_usdc_atomic,
    ...beneficiaries.map((entry) => entry.amount_usdc_atomic), ...quote.payout_recipients.map((entry) => entry.amount_usdc_atomic)];
  if (!amounts.every(validAmount)) return;
  if (new Set(quote.payout_recipients.map((entry) => entry.payout_id)).size !== quote.payout_recipients.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "payout_id values must be unique"});
  if (new Set(beneficiaries.map((entry) => JSON.stringify([entry.recipient_id, entry.role]))).size !== beneficiaries.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["additional_beneficiaries"], message: "beneficiary recipient and role pairs must be unique"});
  const components = sumAmounts([
    quote.provider_base_price_usdc_atomic,
    quote.character_owner_markup_usdc_atomic,
    quote.platform_fee_usdc_atomic,
    ...beneficiaries.map((beneficiary) => beneficiary.amount_usdc_atomic)
  ]);
  const payouts = sumAmounts(quote.payout_recipients.map((recipient) => recipient.amount_usdc_atomic));
  const total = BigInt(quote.total_amount_usdc_atomic);
  if (quote.provider_cost_usdc_atomic !== undefined && BigInt(quote.provider_cost_usdc_atomic) > BigInt(quote.provider_base_price_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["provider_base_price_usdc_atomic"], message: "provider allocation must cover the quoted provider cost"});
  if (quote.revenue_allocation_policy) {
    const policy = quote.revenue_allocation_policy;
    if (quote.network_id !== "solana:mainnet-beta") context.addIssue({code: z.ZodIssueCode.custom, path: ["revenue_allocation_policy"], message: "revenue allocation policy is only valid for Mainnet quotes"});
    if (BigInt(policy.minimum_total_usdc_atomic) < 1_000_000n) context.addIssue({code: z.ZodIssueCode.custom, path: ["revenue_allocation_policy", "minimum_total_usdc_atomic"], message: "Mainnet quote minimum may not be below 1 USDC"});
    if (BigInt(policy.maximum_total_usdc_atomic) > 10_000_000_000n) context.addIssue({code: z.ZodIssueCode.custom, path: ["revenue_allocation_policy", "maximum_total_usdc_atomic"], message: "Mainnet quote maximum may not exceed 10000 USDC"});
    if (policy.provider_basis_points + policy.character_owner_basis_points + policy.platform_basis_points !== 10_000) context.addIssue({code: z.ZodIssueCode.custom, path: ["revenue_allocation_policy"], message: "allocation shares must total 10000 basis points"});
    if (total < BigInt(policy.minimum_total_usdc_atomic) || total > BigInt(policy.maximum_total_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["total_amount_usdc_atomic"], message: "Mainnet quote total is outside its pinned payment limits"});
    const shares = [
      {role: "generation_provider", basis_points: policy.provider_basis_points},
      {role: "character_owner", basis_points: policy.character_owner_basis_points},
      {role: "platform", basis_points: policy.platform_basis_points}
    ].map((share, index) => {
      const numerator = total * BigInt(share.basis_points);
      return {...share, index, amount: numerator / 10_000n, remainder: numerator % 10_000n};
    });
    let undistributed = total - shares.reduce((sum, share) => sum + share.amount, 0n);
    const rankedShares = [...shares].sort((left, right) => left.remainder === right.remainder
      ? (left.role < right.role ? -1 : left.role > right.role ? 1 : left.index - right.index)
      : left.remainder > right.remainder ? -1 : 1);
    for (let index = 0; undistributed > 0n; index += 1, undistributed -= 1n) rankedShares[index % rankedShares.length]!.amount += 1n;
    const expectedRoleAmounts = new Map(shares.map((share) => [share.role, share.amount]));
    if (BigInt(quote.provider_base_price_usdc_atomic) !== expectedRoleAmounts.get("generation_provider") || BigInt(quote.character_owner_markup_usdc_atomic) !== expectedRoleAmounts.get("character_owner") || BigInt(quote.platform_fee_usdc_atomic) !== expectedRoleAmounts.get("platform")) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "Mainnet quote amounts do not match the pinned revenue allocation"});
  }
  if (components !== total) context.addIssue({code: z.ZodIssueCode.custom, path: ["total_amount_usdc_atomic"], message: "total must equal provider base price + owner markup + platform fee + additional beneficiaries"});
  if (payouts !== total) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "sum(recipient amounts) must equal total payment"});
  const sumRole = (role: z.infer<typeof PayoutRoleV1Schema>) => sumAmounts(quote.payout_recipients.filter((recipient) => recipient.role === role).map((recipient) => recipient.amount_usdc_atomic));
  if (sumRole("generation_provider") !== BigInt(quote.provider_base_price_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "generation-provider payouts must equal provider_base_price_usdc_atomic"});
  if (sumRole("character_owner") !== BigInt(quote.character_owner_markup_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "character-owner payouts must equal character_owner_markup_usdc_atomic"});
  if (sumRole("platform") !== BigInt(quote.platform_fee_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "platform payouts must equal platform_fee_usdc_atomic"});
  for (const beneficiary of beneficiaries) {
    const amount = sumAmounts(quote.payout_recipients.filter((recipient) => recipient.recipient_id === beneficiary.recipient_id && recipient.role === beneficiary.role).map((recipient) => recipient.amount_usdc_atomic));
    if (amount !== BigInt(beneficiary.amount_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["additional_beneficiaries"], message: `payout amount for ${beneficiary.recipient_id} does not match its declared amount`});
  }
  const declaredBeneficiaryKeys = new Set(beneficiaries.map((entry) => JSON.stringify([entry.recipient_id, entry.role])));
  for (const recipient of quote.payout_recipients) {
    if (["commissioner", "referrer", "sponsor", "additional_beneficiary"].includes(recipient.role) && !declaredBeneficiaryKeys.has(JSON.stringify([recipient.recipient_id, recipient.role]))) {
      context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: `payout ${recipient.payout_id} has no matching additional beneficiary`});
    }
    if (recipient.role === "generation_provider" && quote.generation_provider_recipient_ids && !quote.generation_provider_recipient_ids.includes(recipient.recipient_id)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "generation-provider payout recipient must be declared in generation_provider_recipient_ids"});
    if (recipient.role === "character_owner" && quote.character_owner_recipient_ids && !quote.character_owner_recipient_ids.includes(recipient.recipient_id)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "character-owner payout recipient must be declared in character_owner_recipient_ids"});
  }
  if (Date.parse(quote.expires_at) <= Date.parse(quote.issued_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["expires_at"], message: "quote expiration must be later than issue time"});
  try {
    if (computeRealizeQuoteHash(quote) !== quote.canonical_quote_hash) context.addIssue({code: z.ZodIssueCode.custom, path: ["canonical_quote_hash"], message: "canonical quote hash does not match the immutable quote payload"});
  } catch {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["canonical_quote_hash"], message: "quote payload is not canonical JSON"});
  }
});

export const CommissionStateV1Schema = z.enum([
  "DRAFT", "QUOTED", "AWAITING_PAYMENT", "FUNDED", "GENERATING", "COMPLETED", "SETTLED",
  "FAILED", "REFUND_PENDING", "REFUNDED", "MANUAL_REVIEW", "EXPIRED"
]);
type CommissionStateValue = z.infer<typeof CommissionStateV1Schema>;
export const CommissionPaymentStateV1Schema = z.enum(["not_started", "pending", "authorized", "captured", "failed", "refund_pending", "refunded", "settled"]);
export const CommissionFulfillmentStateV1Schema = z.enum(["not_started", "queued", "generating", "completed", "failed", "canceled"]);

export const REALIZE_COMMISSION_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(["QUOTED", "FAILED", "EXPIRED"] as const),
  QUOTED: Object.freeze(["AWAITING_PAYMENT", "FAILED", "EXPIRED"] as const),
  AWAITING_PAYMENT: Object.freeze(["FUNDED", "FAILED", "EXPIRED", "MANUAL_REVIEW"] as const),
  FUNDED: Object.freeze(["GENERATING", "FAILED", "REFUND_PENDING", "MANUAL_REVIEW"] as const),
  GENERATING: Object.freeze(["COMPLETED", "FAILED", "REFUND_PENDING", "MANUAL_REVIEW"] as const),
  COMPLETED: Object.freeze(["SETTLED", "REFUND_PENDING", "MANUAL_REVIEW"] as const),
  SETTLED: Object.freeze([]),
  FAILED: Object.freeze(["REFUND_PENDING", "MANUAL_REVIEW"] as const),
  REFUND_PENDING: Object.freeze(["REFUNDED", "FAILED", "MANUAL_REVIEW"] as const),
  REFUNDED: Object.freeze([]),
  MANUAL_REVIEW: Object.freeze(["COMPLETED", "REFUND_PENDING"] as const),
  // A payer may submit a signature after expiry while recovering a transfer
  // that was already broadcast. Reopen only into payment verification; the API
  // decides from finalized chain time whether it can fulfill or needs review.
  EXPIRED: Object.freeze(["AWAITING_PAYMENT", "FUNDED", "MANUAL_REVIEW"] as const)
} as const satisfies Readonly<Record<CommissionStateValue, readonly CommissionStateValue[]>>);

export function canTransitionRealizeCommission(from: CommissionStateValue, to: CommissionStateValue): boolean {
  return (REALIZE_COMMISSION_TRANSITIONS[from] as readonly CommissionStateValue[]).includes(to);
}

/** Allowed projections of the overall state onto the independent state fields. */
export const REALIZE_COMMISSION_STATE_REQUIREMENTS = Object.freeze({
  DRAFT: {payment: ["not_started"], fulfillment: ["not_started"]},
  QUOTED: {payment: ["not_started"], fulfillment: ["not_started"]},
  AWAITING_PAYMENT: {payment: ["pending", "authorized"], fulfillment: ["not_started"]},
  FUNDED: {payment: ["captured"], fulfillment: ["not_started", "queued"]},
  GENERATING: {payment: ["captured"], fulfillment: ["queued", "generating"]},
  COMPLETED: {payment: ["captured"], fulfillment: ["completed"]},
  SETTLED: {payment: ["settled"], fulfillment: ["completed"]},
  FAILED: {payment: ["not_started", "pending", "authorized", "captured", "failed", "refund_pending"], fulfillment: ["not_started", "queued", "failed", "canceled", "completed"]},
  REFUND_PENDING: {payment: ["refund_pending"], fulfillment: ["not_started", "failed", "canceled", "completed"]},
  REFUNDED: {payment: ["refunded"], fulfillment: ["not_started", "failed", "canceled", "completed"]},
  MANUAL_REVIEW: {payment: ["captured", "refund_pending"], fulfillment: ["not_started", "queued", "generating", "failed", "canceled", "completed"]},
  EXPIRED: {payment: ["not_started", "pending", "failed"], fulfillment: ["not_started", "canceled"]}
} as const);
for (const requirements of Object.values(REALIZE_COMMISSION_STATE_REQUIREMENTS)) {
  Object.freeze(requirements.payment);
  Object.freeze(requirements.fulfillment);
  Object.freeze(requirements);
}

export const CommissionV1Schema = z.object({
  protocol_version: protocolVersion,
  commission_id: stableId,
  commissioner_id: stableId,
  creator_id: stableId,
  capability_id: stableId,
  requested_generation_parameters: GenerationParametersV1Schema,
  quote_id: stableId.optional(),
  accepted_quote_hash: digest.optional(),
  rights_agreement_reference: stableId,
  state: CommissionStateV1Schema,
  payment_state: CommissionPaymentStateV1Schema,
  fulfillment_state: CommissionFulfillmentStateV1Schema,
  payment_intent_id: stableId.optional(),
  fulfillment_request_id: stableId.optional(),
  created_at: isoDate,
  updated_at: isoDate
}).strict().superRefine((commission, context) => {
  const quoteRequired = ["QUOTED", "AWAITING_PAYMENT", "FUNDED", "GENERATING", "COMPLETED", "SETTLED", "MANUAL_REVIEW"].includes(commission.state);
  const acceptedQuoteRequired = ["AWAITING_PAYMENT", "FUNDED", "GENERATING", "COMPLETED", "SETTLED", "MANUAL_REVIEW"].includes(commission.state);
  if (quoteRequired && !commission.quote_id) context.addIssue({code: z.ZodIssueCode.custom, path: ["quote_id"], message: "this commission state requires a quote"});
  if (acceptedQuoteRequired && !commission.accepted_quote_hash) context.addIssue({code: z.ZodIssueCode.custom, path: ["accepted_quote_hash"], message: "accepted quote hash is required once payment is requested"});
  if ((["captured", "refund_pending", "refunded", "settled"].includes(commission.payment_state) || ["REFUND_PENDING", "REFUNDED"].includes(commission.state)) && (!commission.quote_id || !commission.accepted_quote_hash)) context.addIssue({code: z.ZodIssueCode.custom, path: ["accepted_quote_hash"], message: "funded and refund states retain the accepted quote binding"});
  if (commission.accepted_quote_hash && !commission.quote_id) context.addIssue({code: z.ZodIssueCode.custom, path: ["quote_id"], message: "an accepted hash requires a quote ID"});
  if (["DRAFT", "QUOTED"].includes(commission.state) && commission.accepted_quote_hash) context.addIssue({code: z.ZodIssueCode.custom, path: ["accepted_quote_hash"], message: "an unaccepted commission cannot have an accepted quote hash"});
  const requirements = REALIZE_COMMISSION_STATE_REQUIREMENTS[commission.state];
  if (!(requirements.payment as readonly string[]).includes(commission.payment_state)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payment_state"], message: `payment state is inconsistent with ${commission.state}`});
  if (!(requirements.fulfillment as readonly string[]).includes(commission.fulfillment_state)) context.addIssue({code: z.ZodIssueCode.custom, path: ["fulfillment_state"], message: `fulfillment state is inconsistent with ${commission.state}`});
  if (Date.parse(commission.updated_at) < Date.parse(commission.created_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["updated_at"], message: "update time may not precede creation"});
});

export const PaymentIntentV1Schema = z.object({
  protocol_version: protocolVersion,
  payment_intent_id: stableId,
  commission_id: stableId,
  quote_id: stableId,
  accepted_quote_hash: digest,
  payer_id: stableId,
  amount_usdc_atomic: positiveAtomicAmount,
  asset: z.literal("USDC"),
  network_id: stableId,
  status: z.enum(["created", "requires_action", "processing", "authorized", "captured", "failed", "refund_pending", "refunded", "settled"]),
  idempotency_key: z.string().min(1).max(256),
  expires_at: isoDate,
  created_at: isoDate
}).strict().superRefine((intent, context) => {
  if (Date.parse(intent.expires_at) <= Date.parse(intent.created_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["expires_at"], message: "payment intent expiration must follow creation"});
});

export const SettlementInstructionV1Schema = z.object({
  protocol_version: protocolVersion,
  settlement_id: stableId,
  commission_id: stableId,
  payment_intent_id: stableId,
  quote_id: stableId,
  canonical_quote_hash: digest.optional(),
  asset: z.literal("USDC"),
  network_id: stableId,
  usdc_mint: z.string().min(32).max(64).optional(),
  settlement_program_version: stableId.optional(),
  total_amount_usdc_atomic: positiveAtomicAmount,
  payout_recipients: z.array(PayoutRecipientV1Schema.extend({destination: z.string().min(1).max(512)})).min(1).max(REALIZE_MAX_PAYOUT_RECIPIENTS),
  transaction_batches: z.array(z.object({
    transaction_index: z.number().int().min(0).max(REALIZE_MAX_TRANSACTION_BATCHES - 1),
    payout_ids: z.array(stableId).min(1).max(REALIZE_MAX_RECIPIENTS_PER_TRANSACTION),
    compute_units: z.number().int().min(1).max(REALIZE_MAX_COMPUTE_UNITS_PER_TRANSACTION),
    serialized_size_bytes: z.number().int().min(1).max(REALIZE_MAX_TRANSACTION_BYTES)
  }).strict()).min(1).max(REALIZE_MAX_TRANSACTION_BATCHES),
  created_at: isoDate
}).strict().superRefine((instruction, context) => {
  if (![instruction.total_amount_usdc_atomic, ...instruction.payout_recipients.map((recipient) => recipient.amount_usdc_atomic)].every(validAmount)) return;
  const total = sumAmounts(instruction.payout_recipients.map((recipient) => recipient.amount_usdc_atomic));
  if (total !== BigInt(instruction.total_amount_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "sum(recipient amounts) must equal total payment"});
  const ids = instruction.payout_recipients.map((recipient) => recipient.payout_id);
  if (new Set(ids).size !== ids.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["payout_recipients"], message: "payout_id values must be unique"});
  const planned = instruction.transaction_batches.flatMap((batch) => batch.payout_ids);
  if (planned.length !== ids.length || new Set(planned).size !== planned.length || ids.some((id) => !planned.includes(id))) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["transaction_batches"], message: "transaction batches must include every payout_id exactly once"});
  }
  instruction.transaction_batches.forEach((batch, index) => {
    if (batch.transaction_index !== index) context.addIssue({code: z.ZodIssueCode.custom, path: ["transaction_batches", index, "transaction_index"], message: "transaction indexes must be contiguous and ordered from zero"});
  });
});

export const FulfillmentRequestV1Schema = z.object({
  protocol_version: protocolVersion,
  fulfillment_request_id: stableId,
  commission_id: stableId,
  quote_id: stableId,
  accepted_quote_hash: digest,
  generation_provider_id: stableId,
  requested_generation_parameters: GenerationParametersV1Schema,
  output_media_types: z.array(z.string().min(1).max(128)).min(1).max(32),
  callback_uri: z.string().url().max(2_048).optional(),
  idempotency_key: z.string().min(1).max(256),
  created_at: isoDate
}).strict();

export const FulfillmentResultV1Schema = z.object({
  protocol_version: protocolVersion,
  fulfillment_request_id: stableId,
  commission_id: stableId,
  generation_provider_id: stableId,
  status: z.enum(["queued", "generating", "completed", "failed"]),
  outputs: z.array(z.object({
    uri: z.string().url().max(2_048),
    page_url: z.string().url().max(2_048).optional(),
    media_type: z.string().min(1).max(128),
    sha256: digest,
    byte_length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }).strict()).max(64),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  error_message: z.string().max(2_000).optional(),
  started_at: isoDate.optional(),
  completed_at: isoDate.optional(),
  provenance_record_id: stableId.optional()
}).strict().superRefine((result, context) => {
  if (["completed", "failed"].includes(result.status) && !result.completed_at) context.addIssue({code: z.ZodIssueCode.custom, path: ["completed_at"], message: "terminal fulfillment requires completed_at"});
  if (["queued", "generating"].includes(result.status) && result.completed_at) context.addIssue({code: z.ZodIssueCode.custom, path: ["completed_at"], message: "in-progress fulfillment may not claim a completion time"});
  if (result.started_at && result.completed_at && Date.parse(result.completed_at) < Date.parse(result.started_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["completed_at"], message: "completion time may not precede start time"});
  if (result.status === "completed" && result.outputs.length === 0) context.addIssue({code: z.ZodIssueCode.custom, path: ["outputs"], message: "completed fulfillment must include at least one output"});
  if (result.status === "failed" && !result.error_code) context.addIssue({code: z.ZodIssueCode.custom, path: ["error_code"], message: "failed fulfillment must include an error_code"});
});

export const RightsArtifactScopeV1Schema = z.object({
  subject_type: z.enum(["commission", "artifact", "output", "post"]),
  subject_id: stableId,
  artifact_sha256: digest.optional()
}).strict();

/** Server-published operational rights policy for VOX-owned first-party AI characters.
 * It is not a creator-signed rights agreement; the commissioner accepts it in checkout. */
export const FirstPartyRealizeRightsPolicyV1Schema = z.object({
  protocol_version: protocolVersion,
  policy_id: stableId,
  version: z.literal(1),
  creator_id: stableId,
  character_owner_id: stableId,
  rights_subject_id: stableId,
  statement: z.string().min(1).max(2_000)
}).strict();
export type FirstPartyRealizeRightsPolicyV1 = z.infer<typeof FirstPartyRealizeRightsPolicyV1Schema>;

export function computeFirstPartyRealizeRightsPolicyHash(policy: FirstPartyRealizeRightsPolicyV1): string {
  return bytesToHex(domainHash("vox.realize.first-party-rights-policy.v1", canonicalBytes(policy)));
}

export const RightsPartyV1Schema = z.object({
  party_id: stableId,
  role: z.enum(["creator", "commissioner", "character_owner", "distributor", "provider", "platform", "beneficiary"])
}).strict();

export const RightsAllocationV1Schema = z.object({
  beneficiary_id: stableId,
  basis_points: z.number().int().min(1).max(10_000)
}).strict();

export const RIGHTS_TRANSACTION_TYPES = [
  "commission", "artifact_sale", "license", "streaming", "advertising",
  "distribution", "subscription", "secondary_sale"
] as const;

export const RightsAgreementAcceptanceV1Schema = z.object({
  party_id: stableId,
  key_id: stableId,
  public_key: ed25519PublicKey,
  terms_hash: digest,
  accepted_at: isoDate,
  signature
}).strict();

export const RevenueRightsAgreementV1Schema = z.object({
  protocol_version: protocolVersion,
  agreement_id: stableId,
  version: z.number().int().positive().max(1_000_000),
  artifact_scope: RightsArtifactScopeV1Schema,
  parties: z.array(RightsPartyV1Schema).min(2).max(64),
  grant: z.object({
    work_scope: z.string().min(1).max(2_000),
    rights: z.array(z.enum(["generate", "reproduce", "display", "distribute", "commercial_use", "create_derivatives", "train_models"])).min(1).max(16),
    license_type: z.enum(["non_exclusive", "exclusive"]),
    territory: z.array(z.string().min(1).max(128)).min(1).max(64),
    attribution_required: z.boolean(),
    starts_at: isoDate,
    expires_at: isoDate.optional()
  }).strict(),
  revenue_definition: z.object({
    basis: z.enum(["gross_received", "net_received"]),
    description: z.string().min(1).max(2_000),
    permitted_deductions: z.array(z.enum(["payment_processing", "refunds", "chargebacks", "taxes", "distribution_costs"])).max(5)
  }).strict(),
  eligible_transaction_types: z.array(z.enum(RIGHTS_TRANSACTION_TYPES)).min(1).max(RIGHTS_TRANSACTION_TYPES.length),
  allocations: z.array(RightsAllocationV1Schema).min(1).max(64),
  duration: z.object({starts_at: isoDate, ends_at: isoDate.optional()}).strict(),
  termination_conditions: z.array(z.enum(["mutual_consent", "material_breach_after_notice", "artifact_withdrawal", "legal_requirement", "term_expiry"])).min(1).max(5),
  modification_policy: z.object({
    proposer_party_ids: z.array(stableId).min(1).max(64),
    required_acceptance_party_ids: z.array(stableId).min(2).max(64)
  }).strict(),
  required_acceptance_party_ids: z.array(stableId).min(2).max(64),
  termination_policy: z.object({
    authorized_party_ids: z.array(stableId).min(1).max(64),
    required_acceptance_party_ids: z.array(stableId).min(1).max(64)
  }).strict(),
  provenance_references: z.array(z.object({
    category: z.enum(["authorship", "character_ownership", "commissioning", "distribution", "copyright", "contractual_revenue_rights"]),
    party_id: stableId,
    record_id: stableId
  }).strict()).min(1).max(128),
  attribution: z.array(z.object({party_id: stableId, credit_text: z.string().min(1).max(512)}).strict()).max(64),
  acceptances: z.array(RightsAgreementAcceptanceV1Schema).max(64),
  created_at: isoDate
}).strict().superRefine((agreement, context) => {
  const totalBasisPoints = agreement.allocations.reduce((total, share) => total + share.basis_points, 0);
  if (totalBasisPoints > 10_000) context.addIssue({code: z.ZodIssueCode.custom, path: ["allocations"], message: "revenue allocations may not exceed 10000 basis points"});
  if (agreement.duration.ends_at && Date.parse(agreement.duration.ends_at) <= Date.parse(agreement.duration.starts_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["duration", "ends_at"], message: "duration end must be later than its start"});
  if (agreement.grant.expires_at && Date.parse(agreement.grant.expires_at) <= Date.parse(agreement.grant.starts_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["grant", "expires_at"], message: "grant expiration must be later than its start"});
  if (agreement.grant.starts_at !== agreement.duration.starts_at || agreement.grant.expires_at !== agreement.duration.ends_at) context.addIssue({code: z.ZodIssueCode.custom, path: ["duration"], message: "grant and revenue-rights duration must match"});
  const partyIds = new Set(agreement.parties.map((party) => party.party_id));
  if (new Set(agreement.parties.map((party) => party.party_id)).size !== agreement.parties.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["parties"], message: "party IDs must be unique"});
  if (new Set(agreement.eligible_transaction_types).size !== agreement.eligible_transaction_types.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["eligible_transaction_types"], message: "eligible transaction types must be unique"});
  if (new Set(agreement.allocations.map((share) => share.beneficiary_id)).size !== agreement.allocations.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["allocations"], message: "each beneficiary may appear only once"});
  if (agreement.allocations.some((share) => !partyIds.has(share.beneficiary_id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["allocations"], message: "every revenue beneficiary must be a declared party"});
  if (new Set(agreement.required_acceptance_party_ids).size !== agreement.required_acceptance_party_ids.length || agreement.required_acceptance_party_ids.some((id) => !partyIds.has(id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["required_acceptance_party_ids"], message: "required acceptors must be unique declared parties"});
  if (new Set(agreement.modification_policy.proposer_party_ids).size !== agreement.modification_policy.proposer_party_ids.length || agreement.modification_policy.proposer_party_ids.some((id) => !partyIds.has(id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["modification_policy", "proposer_party_ids"], message: "modification proposers must be unique declared parties"});
  if (new Set(agreement.modification_policy.required_acceptance_party_ids).size !== agreement.modification_policy.required_acceptance_party_ids.length || agreement.modification_policy.required_acceptance_party_ids.some((id) => !partyIds.has(id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["modification_policy", "required_acceptance_party_ids"], message: "modification acceptors must be unique declared parties"});
  if (new Set(agreement.termination_policy.authorized_party_ids).size !== agreement.termination_policy.authorized_party_ids.length || agreement.termination_policy.authorized_party_ids.some((id) => !partyIds.has(id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["termination_policy", "authorized_party_ids"], message: "termination proposers must be unique declared parties"});
  if (new Set(agreement.termination_policy.required_acceptance_party_ids).size !== agreement.termination_policy.required_acceptance_party_ids.length || agreement.termination_policy.required_acceptance_party_ids.some((id) => !partyIds.has(id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["termination_policy", "required_acceptance_party_ids"], message: "termination acceptors must be unique declared parties"});
  if (agreement.acceptances.some((acceptance) => !agreement.required_acceptance_party_ids.includes(acceptance.party_id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["acceptances"], message: "every acceptance must belong to a required party"});
  if (new Set(agreement.acceptances.map((acceptance) => acceptance.party_id)).size !== agreement.acceptances.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["acceptances"], message: "a party may accept a version only once"});
  if (agreement.provenance_references.some((entry) => !partyIds.has(entry.party_id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["provenance_references"], message: "provenance parties must be declared parties"});
  if (agreement.attribution.some((entry) => !partyIds.has(entry.party_id))) context.addIssue({code: z.ZodIssueCode.custom, path: ["attribution"], message: "attribution parties must be declared parties"});
});

export const RightsTerminationAcceptanceV1Schema = z.object({
  party_id: stableId,
  key_id: stableId,
  public_key: ed25519PublicKey,
  accepted_at: isoDate,
  signature
}).strict();

export const RightsAgreementTerminationV1Schema = z.object({
  protocol_version: protocolVersion,
  agreement_id: stableId,
  version: z.number().int().positive(),
  condition: z.enum(["mutual_consent", "material_breach_after_notice", "artifact_withdrawal", "legal_requirement", "term_expiry"]),
  terms_hash: digest,
  proposed_at: isoDate,
  acceptances: z.array(RightsTerminationAcceptanceV1Schema).min(1).max(64)
}).strict().superRefine((termination, context) => {
  if (new Set(termination.acceptances.map((acceptance) => acceptance.party_id)).size !== termination.acceptances.length) context.addIssue({code: z.ZodIssueCode.custom, path: ["acceptances"], message: "a party may accept termination only once"});
});

export const RightsRevenueEventV1Schema = z.object({
  protocol_version: protocolVersion,
  event_id: stableId,
  source_transaction_id: stableId,
  artifact_scope: RightsArtifactScopeV1Schema,
  transaction_type: z.enum(RIGHTS_TRANSACTION_TYPES),
  buyer_id: stableId,
  seller_id: stableId,
  gross_proceeds_usdc_atomic: positiveAtomicAmount,
  /** Separately verified distributor commission pool; used only for referral rewards. */
  eligible_commission_usdc_atomic: atomicAmount.optional(),
  deductions: z.array(z.object({type: z.enum(["payment_processing", "refunds", "chargebacks", "taxes", "distribution_costs"]), amount_usdc_atomic: atomicAmount}).strict()).max(32),
  verification: z.object({status: z.literal("verified"), verifier_id: stableId, evidence_sha256: digest, evidence_uri: z.string().url().max(2_048).optional(), verified_at: isoDate}).strict(),
  occurred_at: isoDate,
  recorded_at: isoDate
}).strict().superRefine((event, context) => {
  if (![event.gross_proceeds_usdc_atomic, ...event.deductions.map((item) => item.amount_usdc_atomic)].every(validAmount)) return;
  if (event.buyer_id === event.seller_id) context.addIssue({code: z.ZodIssueCode.custom, path: ["seller_id"], message: "a revenue transaction must have distinct buyer and seller"});
  if (sumAmounts(event.deductions.map((item) => item.amount_usdc_atomic)) > BigInt(event.gross_proceeds_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["deductions"], message: "deductions may not exceed gross proceeds"});
  if (event.eligible_commission_usdc_atomic !== undefined && validAmount(event.eligible_commission_usdc_atomic) && BigInt(event.eligible_commission_usdc_atomic) > BigInt(event.gross_proceeds_usdc_atomic)) context.addIssue({code: z.ZodIssueCode.custom, path: ["eligible_commission_usdc_atomic"], message: "eligible commission may not exceed gross proceeds"});
});

export const ReferralAttributionV1Schema = z.object({
  protocol_version: protocolVersion,
  attribution_id: stableId,
  referrer_id: stableId,
  referred_party_id: stableId,
  reward_basis_points: z.number().int().min(1).max(10_000),
  attributed_at: isoDate,
  expires_at: isoDate,
  accepted_at: isoDate,
  accepted_by_key_id: stableId,
  accepted_by_public_key: ed25519PublicKey,
  signature,
  referrer_accepted_at: isoDate,
  referrer_key_id: stableId,
  referrer_public_key: ed25519PublicKey,
  referrer_signature: signature
}).strict().superRefine((attribution, context) => {
  if (attribution.referrer_id === attribution.referred_party_id) context.addIssue({code: z.ZodIssueCode.custom, path: ["referred_party_id"], message: "self-referral is not allowed"});
  if (Date.parse(attribution.expires_at) <= Date.parse(attribution.attributed_at)) context.addIssue({code: z.ZodIssueCode.custom, path: ["expires_at"], message: "referral expiration must be later than attribution"});
});

export const RightsRevenueAllocationV1Schema = z.object({
  protocol_version: protocolVersion,
  allocation_id: stableId,
  event_id: stableId,
  agreement_id: stableId,
  agreement_version: z.number().int().positive(),
  beneficiary_id: stableId,
  basis_points: z.number().int().min(1).max(10_000),
  eligible_proceeds_usdc_atomic: atomicAmount,
  amount_usdc_atomic: atomicAmount,
  asset: z.literal("USDC"),
  payment_status: z.enum(["pending", "processing", "paid", "failed", "reversed"]),
  created_at: isoDate,
  updated_at: isoDate
}).strict();

export const DistributionRewardV1Schema = z.object({
  protocol_version: protocolVersion,
  reward_id: stableId,
  attribution_id: stableId,
  referrer_id: stableId,
  referred_transaction_id: stableId,
  event_id: stableId,
  eligible_commission_usdc_atomic: atomicAmount,
  reward_basis_points: z.number().int().min(1).max(10_000),
  reward_amount_usdc_atomic: atomicAmount,
  asset: z.literal("USDC"),
  payment_status: z.enum(["pending", "processing", "paid", "failed", "reversed"]),
  created_at: isoDate,
  updated_at: isoDate
}).strict();

/** Shared payout handoff contract; it is data only and does not execute a transfer. */
export const RightsPayoutInstructionV1Schema = z.object({
  protocol_version: protocolVersion,
  instruction_id: stableId,
  ledger_entry_id: stableId,
  beneficiary_id: stableId,
  asset: z.literal("USDC"),
  amount_usdc_atomic: positiveAtomicAmount,
  network_id: stableId.optional(),
  destination: z.string().min(1).max(512).optional(),
  payment_status: z.enum(["pending", "processing", "paid", "failed", "reversed"]),
  created_at: isoDate
}).strict();

export const RightsAuditEventV1Schema = z.object({
  event_id: stableId,
  agreement_id: stableId,
  version: z.number().int().positive(),
  kind: z.enum(["proposed", "accepted", "terminated", "superseded", "revenue_recorded", "allocation_status_changed", "referral_attributed", "referral_reward_recorded"]),
  actor_id: stableId,
  record_hash: digest,
  occurred_at: isoDate,
  evidence_reference: stableId.optional()
}).strict();

export const ProvenanceRecordV1Schema = z.object({
  protocol_version: protocolVersion,
  provenance_record_id: stableId,
  subject_type: z.enum(["commission", "fulfillment", "output"]),
  subject_id: stableId,
  creator_id: stableId,
  generation_provider_id: stableId,
  commission_id: stableId,
  quote_hash: digest,
  rights_agreement_reference: stableId,
  /** Included in public provenance only after the commissioner signs this explicit opt-in. */
  public_attribution: z.string().trim().min(1).max(120).optional(),
  inputs: z.array(z.object({uri: z.string().url().max(2_048).optional(), sha256: digest, media_type: z.string().min(1).max(128)}).strict()).max(64),
  outputs: z.array(z.object({uri: z.string().url().max(2_048).optional(), sha256: digest, media_type: z.string().min(1).max(128), byte_length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict()).min(1).max(64),
  model_id: stableId.optional(),
  model_version: stableId.optional(),
  parent_record_ids: z.array(stableId).max(64),
  rights_provenance: z.array(z.object({
    category: z.enum(["authorship", "character_ownership", "commissioning", "distribution", "copyright", "contractual_revenue_rights"]),
    party_id: stableId,
    record_id: stableId
  }).strict()).max(128).optional(),
  created_at: isoDate,
  issuer_id: stableId,
  issuer_key_id: stableId,
  signature
}).strict();

export type RightsAgreementAcceptanceV1 = z.infer<typeof RightsAgreementAcceptanceV1Schema>;
export type RevenueRightsAgreementV1 = z.infer<typeof RevenueRightsAgreementV1Schema>;
export type RightsAgreementTerminationV1 = z.infer<typeof RightsAgreementTerminationV1Schema>;
export type RightsTerminationAcceptanceV1 = z.infer<typeof RightsTerminationAcceptanceV1Schema>;
export type RightsArtifactScopeV1 = z.infer<typeof RightsArtifactScopeV1Schema>;
export type RightsPartyV1 = z.infer<typeof RightsPartyV1Schema>;
export type RightsAllocationV1 = z.infer<typeof RightsAllocationV1Schema>;
export type RightsRevenueEventV1 = z.infer<typeof RightsRevenueEventV1Schema>;
export type ReferralAttributionV1 = z.infer<typeof ReferralAttributionV1Schema>;
export type RightsRevenueAllocationV1 = z.infer<typeof RightsRevenueAllocationV1Schema>;
export type DistributionRewardV1 = z.infer<typeof DistributionRewardV1Schema>;
export type RightsAuditEventV1 = z.infer<typeof RightsAuditEventV1Schema>;
export type RightsPayoutInstructionV1 = z.infer<typeof RightsPayoutInstructionV1Schema>;

export function computeRevenueRightsAgreementHash(agreement: RevenueRightsAgreementV1): string {
  const {acceptances: _acceptances, ...terms} = agreement;
  return bytesToHex(domainHash("vox.realize.rights.agreement.v1", utf8(canonicalize(terms))));
}

export function rightsAgreementAcceptancePayload(agreementId: string, version: number, acceptance: Omit<RightsAgreementAcceptanceV1, "signature">): Uint8Array {
  const digestValue = hexToBytes(acceptance.terms_hash);
  return concatBytes(
    utf8("vox.realize.rights.acceptance.v1"), new Uint8Array([0]),
    digestValue,
    utf8(canonicalize({agreement_id: agreementId, version, ...acceptance}))
  );
}

export function signRightsAgreementAcceptance(agreementId: string, version: number, acceptance: Omit<RightsAgreementAcceptanceV1, "signature">, secretKey: Uint8Array): string {
  return signBytes(rightsAgreementAcceptancePayload(agreementId, version, acceptance), secretKey);
}

export function verifyRightsAgreementAcceptance(agreementId: string, version: number, acceptance: RightsAgreementAcceptanceV1): boolean {
  try {
    const {signature: acceptanceSignature, ...unsigned} = acceptance;
    return verifyBytes(rightsAgreementAcceptancePayload(agreementId, version, unsigned), acceptanceSignature, acceptance.public_key);
  } catch {
    return false;
  }
}

export function rightsTerminationAcceptancePayload(termination: Pick<RightsAgreementTerminationV1, "agreement_id" | "version" | "condition" | "terms_hash" | "proposed_at">, acceptance: Omit<RightsTerminationAcceptanceV1, "signature">): Uint8Array {
  const terms = {agreement_id: termination.agreement_id, version: termination.version, condition: termination.condition, terms_hash: termination.terms_hash, proposed_at: termination.proposed_at};
  return concatBytes(utf8("vox.realize.rights.termination.v1"), new Uint8Array([0]), hexToBytes(termination.terms_hash), utf8(canonicalize({...terms, ...acceptance})));
}

export function signRightsTerminationAcceptance(termination: Pick<RightsAgreementTerminationV1, "agreement_id" | "version" | "condition" | "terms_hash" | "proposed_at">, acceptance: Omit<RightsTerminationAcceptanceV1, "signature">, secretKey: Uint8Array): string {
  return signBytes(rightsTerminationAcceptancePayload(termination, acceptance), secretKey);
}

export function verifyRightsTerminationAcceptance(termination: Pick<RightsAgreementTerminationV1, "agreement_id" | "version" | "condition" | "terms_hash" | "proposed_at">, acceptance: RightsTerminationAcceptanceV1): boolean {
  try {
    const {signature: acceptanceSignature, ...unsigned} = acceptance;
    return verifyBytes(rightsTerminationAcceptancePayload(termination, unsigned), acceptanceSignature, acceptance.public_key);
  } catch {
    return false;
  }
}

export function referralAttributionSigningPayload(attribution: Omit<ReferralAttributionV1, "signature" | "referrer_signature"> & {referrer_signature?: string}, signerRole: "referred" | "referrer" = "referred"): Uint8Array {
  const {signature: _referredSignature, referrer_signature: _referrerSignature, ...unsigned} = attribution as ReferralAttributionV1;
  return concatBytes(utf8(`vox.realize.referral.attribution.${signerRole}.v1`), new Uint8Array([0]), utf8(canonicalize(unsigned)));
}

export function signReferralAttribution(attribution: Omit<ReferralAttributionV1, "signature" | "referrer_signature"> & {referrer_signature?: string}, secretKey: Uint8Array, signerRole: "referred" | "referrer" = "referred"): string {
  return signBytes(referralAttributionSigningPayload(attribution, signerRole), secretKey);
}

export function verifyReferralAttribution(attribution: ReferralAttributionV1): boolean {
  try {
    const {signature: _signature, ...unsigned} = attribution;
    return verifyBytes(referralAttributionSigningPayload(unsigned, "referred"), attribution.signature, attribution.accepted_by_public_key) &&
      verifyBytes(referralAttributionSigningPayload(unsigned, "referrer"), attribution.referrer_signature, attribution.referrer_public_key);
  } catch {
    return false;
  }
}

/** Integer-only largest-remainder allocation with a half-up aggregate target. */
export function calculateRevenueAllocations(amountUsdcAtomic: string, allocations: Array<{beneficiary_id: string; basis_points: number}>): Array<{beneficiary_id: string; basis_points: number; amount_usdc_atomic: string}> {
  const amount = BigInt(UsdcAtomicV1Schema.parse(amountUsdcAtomic));
  if (allocations.length === 0) throw new Error("at least one beneficiary allocation is required");
  if (amount < 0n || allocations.some((item) => !Number.isInteger(item.basis_points) || item.basis_points <= 0 || item.basis_points > 10_000)) throw new Error("invalid revenue amount or percentage allocation");
  if (new Set(allocations.map((item) => item.beneficiary_id)).size !== allocations.length) throw new Error("beneficiaries must be unique");
  const totalBasisPoints = allocations.reduce((sum, item) => sum + item.basis_points, 0);
  if (totalBasisPoints > 10_000) throw new Error("revenue allocations may not exceed 10000 basis points");
  const denominator = 10_000n;
  const rows = allocations.map((item) => {
    const numerator = amount * BigInt(item.basis_points);
    return {beneficiary_id: item.beneficiary_id, basis_points: item.basis_points, base: numerator / denominator, remainder: numerator % denominator};
  });
  const floorTotal = rows.reduce((sum, row) => sum + row.base, 0n);
  const roundedTarget = (amount * BigInt(totalBasisPoints) + 5_000n) / denominator;
  const remaining = roundedTarget - floorTotal;
  const byRemainder = [...rows].sort((left, right) => left.remainder === right.remainder
    ? left.beneficiary_id < right.beneficiary_id ? -1 : left.beneficiary_id > right.beneficiary_id ? 1 : 0
    : left.remainder > right.remainder ? -1 : 1);
  const extra = new Set(byRemainder.slice(0, Number(remaining)).map((row) => row.beneficiary_id));
  return rows.map((row) => ({
    beneficiary_id: row.beneficiary_id,
    basis_points: row.basis_points,
    amount_usdc_atomic: (row.base + (extra.has(row.beneficiary_id) ? 1n : 0n)).toString()
  }));
}

export type GenerationParametersV1 = z.infer<typeof GenerationParametersV1Schema>;
export type PayoutRoleV1 = z.infer<typeof PayoutRoleV1Schema>;
export type PayoutRecipientV1 = z.infer<typeof PayoutRecipientV1Schema>;
export type AdditionalBeneficiaryV1 = z.infer<typeof AdditionalBeneficiaryV1Schema>;
export type CreatorCapabilitiesV1 = z.infer<typeof CreatorCapabilitiesV1Schema>;
export type CreatorPricingRequestV1 = z.infer<typeof CreatorPricingRequestV1Schema>;
export type CreatorPricingResponseV1 = z.infer<typeof CreatorPricingResponseV1Schema>;
export type ProviderPriceQuoteV1 = z.infer<typeof ProviderPriceQuoteV1Schema>;
export type ProviderPricingRequestV1 = z.infer<typeof ProviderPricingRequestV1Schema>;
export type RealizeQuoteV1 = z.infer<typeof RealizeQuoteV1Schema>;
export type CommissionStateV1 = z.infer<typeof CommissionStateV1Schema>;
export type CommissionPaymentStateV1 = z.infer<typeof CommissionPaymentStateV1Schema>;
export type CommissionFulfillmentStateV1 = z.infer<typeof CommissionFulfillmentStateV1Schema>;
export type CommissionV1 = z.infer<typeof CommissionV1Schema>;
export type PaymentIntentV1 = z.infer<typeof PaymentIntentV1Schema>;
export type SettlementInstructionV1 = z.infer<typeof SettlementInstructionV1Schema>;
export type FulfillmentRequestV1 = z.infer<typeof FulfillmentRequestV1Schema>;
export type FulfillmentResultV1 = z.infer<typeof FulfillmentResultV1Schema>;
export type ProvenanceRecordV1 = z.infer<typeof ProvenanceRecordV1Schema>;

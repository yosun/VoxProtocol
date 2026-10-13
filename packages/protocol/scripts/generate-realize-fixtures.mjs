import {writeFile} from "node:fs/promises";
import {
  generateKeyPair, publicKeyBase64, agentIdFromPublicKey, humanIdFromPublicKey,
  computeRealizeQuoteHash, signRealizeQuote, RealizeQuoteV1Schema,
  CommissionV1Schema, FulfillmentResultV1Schema, PaymentIntentV1Schema,
  SettlementInstructionV1Schema, RevenueRightsAgreementV1Schema,
  computeRevenueRightsAgreementHash, signRightsAgreementAcceptance,
  ProviderPricingRequestV1Schema, ProviderPriceQuoteV1Schema, ProviderFulfillmentRequestV1Schema,
  ProvenanceRecordV1Schema, signProvenanceRecord, canonicalBytes, bytesToHex, domainHash
} from "../dist/index.js";

// Public, deterministic fixture keys only. Never use these identities in production.
const bobKey = generateKeyPair(new Uint8Array(32).fill(41));
const commissionerKey = generateKeyPair(new Uint8Array(32).fill(42));
const bobId = agentIdFromPublicKey(bobKey.publicKey);
const commissionerId = humanIdFromPublicKey(commissionerKey.publicKey);
const issuedAt = "2026-10-11T18:00:00.000Z";
const parameters = {concept: "Bob's special video", duration_seconds: 6, style: "special"};
const unsignedBob = {
  protocol_version: "realize/1", quote_id: "quote:bob-special-video-001",
  pricing_request_id: "pricing:bob-special-video-001", creator_id: bobId,
  generation_provider_id: "provider:video:example", requested_generation_parameters: parameters,
  provider_base_price_usdc_atomic: "750000", character_owner_markup_usdc_atomic: "200000",
  platform_fee_usdc_atomic: "50000", total_amount_usdc_atomic: "1000000",
  payout_recipients: [
    {payout_id: "payout:bob:provider", recipient_id: "provider:video:example", role: "generation_provider", amount_usdc_atomic: "750000"},
    {payout_id: "payout:bob:owner", recipient_id: bobId, role: "character_owner", amount_usdc_atomic: "200000"},
    {payout_id: "payout:bob:platform", recipient_id: "platform:vox.gold", role: "platform", amount_usdc_atomic: "50000"}
  ],
  expires_at: "2026-10-11T23:00:00.000Z", issued_at: issuedAt,
  rights_agreement_reference: "rights:bob-special-video-v1", issuer_id: bobId,
  issuer_key_id: "key:bob-realize-01", issuer_public_key: publicKeyBase64(bobKey.publicKey)
};
function signedQuote(unsigned) {
  const canonical_quote_hash = computeRealizeQuoteHash(unsigned);
  return RealizeQuoteV1Schema.parse({...unsigned, canonical_quote_hash, signature: signRealizeQuote(canonical_quote_hash, bobKey.secretKey)});
}
const bob = signedQuote(unsignedBob);
const providerRequest = ProviderPricingRequestV1Schema.parse({
  protocol_version: "realize/1", request_id: bob.pricing_request_id, creator_id: bob.creator_id,
  capability_id: "video:short-form", generation_provider_id: bob.generation_provider_id,
  requested_generation_parameters: parameters,
  requested_generation_parameters_hash: bytesToHex(domainHash("vox.realize.generation.parameters.v1", canonicalBytes(parameters))),
  rights_agreement_reference: bob.rights_agreement_reference, requested_at: issuedAt
});
const providerPrice = ProviderPriceQuoteV1Schema.parse({
  protocol_version: "realize/1", request_id: providerRequest.request_id, provider_quote_id: "provider-quote:bob-video-001",
  creator_id: bob.creator_id, capability_id: providerRequest.capability_id, generation_provider_id: bob.generation_provider_id,
  requested_generation_parameters_hash: providerRequest.requested_generation_parameters_hash,
  price_usdc_atomic: bob.provider_base_price_usdc_atomic, issued_at: issuedAt, expires_at: bob.expires_at
});
const expired = signedQuote({...unsignedBob, quote_id: "quote:expired-001", pricing_request_id: "pricing:expired-001", issued_at: "2026-10-01T12:00:00.000Z", expires_at: "2026-10-01T12:15:00.000Z"});
const failedCommission = CommissionV1Schema.parse({
  protocol_version: "realize/1", commission_id: "commission:bob-video-failed",
  commissioner_id: commissionerId, creator_id: bobId, capability_id: "video:short-form",
  requested_generation_parameters: parameters, quote_id: bob.quote_id,
  accepted_quote_hash: bob.canonical_quote_hash, rights_agreement_reference: bob.rights_agreement_reference,
  state: "FAILED", payment_state: "captured", fulfillment_state: "failed",
  payment_intent_id: "payment-intent:bob-video-failed", fulfillment_request_id: "fulfillment:bob-video-failed",
  created_at: "2026-10-11T18:01:00.000Z", updated_at: "2026-10-11T18:09:00.000Z"
});
const failure = FulfillmentResultV1Schema.parse({
  protocol_version: "realize/1", fulfillment_request_id: failedCommission.fulfillment_request_id,
  commission_id: failedCommission.commission_id, generation_provider_id: bob.generation_provider_id,
  status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED",
  error_message: "The generation provider could not complete this request.",
  started_at: "2026-10-11T18:02:00.000Z", completed_at: failedCommission.updated_at
});
const recipients = Array.from({length: 10}, (_, index) => ({
  payout_id: `payout:multi:${index + 1}`, recipient_id: `beneficiary:${index + 1}`,
  role: index === 0 ? "generation_provider" : index === 1 ? "character_owner" : index === 2 ? "platform" : "additional_beneficiary",
  amount_usdc_atomic: "100000", destination: `solana:devnet:fixture-wallet-${index + 1}`
}));
const multiQuote = signedQuote({...unsignedBob, quote_id: "quote:multi-001", pricing_request_id: "pricing:multi-001",
  commission_id: "commission:multi-001", provider_base_price_usdc_atomic: "100000",
  character_owner_markup_usdc_atomic: "100000", platform_fee_usdc_atomic: "100000",
  additional_beneficiaries: recipients.slice(3).map(({recipient_id, role, amount_usdc_atomic}) => ({recipient_id, role, amount_usdc_atomic})),
  payout_recipients: recipients
});
const settlement = SettlementInstructionV1Schema.parse({
  protocol_version: "realize/1", settlement_id: "settlement:multi-001", commission_id: "commission:multi-001",
  payment_intent_id: "payment-intent:multi-001", quote_id: multiQuote.quote_id, canonical_quote_hash: multiQuote.canonical_quote_hash, asset: "USDC",
  network_id: "solana:devnet", total_amount_usdc_atomic: "1000000", payout_recipients: recipients,
  transaction_batches: [
    {transaction_index: 0, payout_ids: recipients.slice(0, 8).map((recipient) => recipient.payout_id), compute_units: 600000, serialized_size_bytes: 1100},
    {transaction_index: 1, payout_ids: recipients.slice(8).map((recipient) => recipient.payout_id), compute_units: 180000, serialized_size_bytes: 520}
  ], created_at: issuedAt
});
const intent = PaymentIntentV1Schema.parse({
  protocol_version: "realize/1", payment_intent_id: "payment-intent:commission-001", commission_id: "commission:001",
  quote_id: bob.quote_id, accepted_quote_hash: bob.canonical_quote_hash, payer_id: commissionerId,
  amount_usdc_atomic: bob.total_amount_usdc_atomic, asset: "USDC", network_id: "solana:devnet", status: "captured",
  idempotency_key: "pay:commission-001", expires_at: bob.expires_at, created_at: "2026-10-11T18:01:00.000Z"
});
const providerFulfillment = ProviderFulfillmentRequestV1Schema.parse({
  protocol_version: "realize/1", fulfillment_request_id: "fulfillment:bob-video-001", commission_id: intent.commission_id,
  quote_id: bob.quote_id, accepted_quote_hash: bob.canonical_quote_hash, generation_provider_id: bob.generation_provider_id,
  requested_generation_parameters: parameters, output_media_types: ["video/mp4"],
  callback_uri: "https://vox.example.invalid/v1/realize/webhooks/populi", idempotency_key: "fulfillment:bob-video-001",
  created_at: "2026-10-11T18:02:00.000Z", provider_quote_id: providerPrice.provider_quote_id,
  funding_authorization: {
    protocol_version: "realize/1", authorization_id: "funding-authorization:bob-video-001",
    payment_intent_id: intent.payment_intent_id, commission_id: intent.commission_id, accepted_quote_hash: bob.canonical_quote_hash,
    asset: "USDC", total_amount_usdc_atomic: "1000000", provider_amount_usdc_atomic: "750000",
    network_id: intent.network_id, payment_reference: "tx:sample-001", verified_by: "instance:vox-fixture",
    verified_at: "2026-10-11T18:01:30.000Z"
  }
});
const completed = FulfillmentResultV1Schema.parse({
  protocol_version: "realize/1", fulfillment_request_id: providerFulfillment.fulfillment_request_id,
  commission_id: providerFulfillment.commission_id, generation_provider_id: bob.generation_provider_id,
  status: "completed", outputs: [{uri: "https://artifacts.example.invalid/bob-special-video-001.mp4", page_url: "https://populi.cam/bob/action-001", media_type: "video/mp4", sha256: "a".repeat(64), byte_length: 1000000}],
  started_at: providerFulfillment.created_at, completed_at: "2026-10-11T18:08:00.000Z", provenance_record_id: "provenance:bob-video-001"
});
const unsignedProvenance = {
  protocol_version: "realize/1", provenance_record_id: completed.provenance_record_id,
  subject_type: "fulfillment", subject_id: completed.fulfillment_request_id, creator_id: bob.creator_id,
  generation_provider_id: bob.generation_provider_id, commission_id: completed.commission_id,
  quote_hash: bob.canonical_quote_hash, rights_agreement_reference: bob.rights_agreement_reference,
  inputs: [{sha256: providerRequest.requested_generation_parameters_hash, media_type: "application/json"}],
  outputs: completed.outputs.map(({uri, sha256, media_type, byte_length}) => ({uri, sha256, media_type, byte_length})), parent_record_ids: [], created_at: completed.completed_at,
  issuer_id: bob.creator_id, issuer_key_id: "key:bob-realize-01"
};
const provenance = ProvenanceRecordV1Schema.parse({...unsignedProvenance, signature: signProvenanceRecord(unsignedProvenance, bobKey.secretKey)});
const agreement = RevenueRightsAgreementV1Schema.parse({
  protocol_version: "realize/1", agreement_id: "rights:commissioner-participation-001", version: 1,
  artifact_scope: {subject_type: "commission", subject_id: "commission:participation-001"},
  parties: [{party_id: bobId, role: "creator"}, {party_id: commissionerId, role: "commissioner"}],
  grant: {
    work_scope: "Short-form video generated from the accepted commission.",
    rights: ["generate", "reproduce", "display", "commercial_use"], license_type: "non_exclusive",
    territory: ["worldwide"], attribution_required: true, starts_at: issuedAt
  },
  revenue_definition: {basis: "gross_received", description: "USDC actually received from eligible downstream transactions.", permitted_deductions: []},
  eligible_transaction_types: ["artifact_sale", "license", "streaming", "secondary_sale"],
  allocations: [{beneficiary_id: commissionerId, basis_points: 1000}, {beneficiary_id: bobId, basis_points: 9000}],
  duration: {starts_at: issuedAt}, termination_conditions: ["mutual_consent", "legal_requirement"],
  modification_policy: {proposer_party_ids: [bobId, commissionerId], required_acceptance_party_ids: [bobId, commissionerId]},
  required_acceptance_party_ids: [bobId, commissionerId],
  termination_policy: {authorized_party_ids: [bobId, commissionerId], required_acceptance_party_ids: [bobId, commissionerId]},
  provenance_references: [{category: "commissioning", party_id: commissionerId, record_id: "provenance:commission:participation-001"}],
  attribution: [{party_id: bobId, credit_text: "Created by Bob."}, {party_id: commissionerId, credit_text: "Commissioned by the requester."}],
  acceptances: [], created_at: issuedAt
});
const terms_hash = computeRevenueRightsAgreementHash(agreement);
agreement.acceptances = [{party_id: bobId, key_id: "key:bob-root-01", key: bobKey}, {party_id: commissionerId, key_id: "key:commissioner-42", key: commissionerKey}].map(({key, ...party}) => {
  const unsigned = {...party, public_key: publicKeyBase64(key.publicKey), terms_hash, accepted_at: issuedAt};
  return {...unsigned, signature: signRightsAgreementAcceptance(agreement.agreement_id, agreement.version, unsigned, key.secretKey)};
});
RevenueRightsAgreementV1Schema.parse(agreement);

const fixtures = {
  "bob-one-dollar-special-video.quote.json": bob,
  "multiple-payout-recipients.settlement.json": settlement,
  "multiple-payout-recipients.quote.json": multiQuote,
  "failed-generation.json": {scenario: "failed_generation", commission: failedCommission, fulfillment_result: failure, expected_follow_up: "REFUND_PENDING"},
  "expired-quote.json": {scenario: "expired_quote", quote: expired, attempted_acceptance_at: "2026-10-01T12:15:00.001Z", expected_error_code: "QUOTE_EXPIRED"},
  "duplicate-payment.json": {
    scenario: "duplicate_payment", payment_intent: intent,
    first_receipt: {payment_reference: "tx:sample-001", commission_id: intent.commission_id, amount_usdc_atomic: intent.amount_usdc_atomic},
    same_intent_retry: {payment_reference: "tx:sample-001", commission_id: intent.commission_id, expected_action: "return_existing_result"},
    duplicate_attempt: {payment_reference: "tx:sample-001", commission_id: "commission:002", amount_usdc_atomic: intent.amount_usdc_atomic},
    expected_error_code: "PAYMENT_REPLAYED"
  },
  "commissioner-revenue-participation.json": agreement,
  "provider-pricing.request.json": providerRequest,
  "provider-price.response.json": providerPrice,
  "provider-fulfillment.request.json": providerFulfillment,
  "fulfillment-completed.result.json": completed,
  "provenance-record.json": provenance
};
for (const [name, fixture] of Object.entries(fixtures)) await writeFile(new URL(`../fixtures/realize/${name}`, import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Generated ${Object.keys(fixtures).length} deterministic Realize fixtures.`);

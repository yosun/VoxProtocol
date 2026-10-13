import {canonicalize} from "./canonical.js";
import {concatBytes, utf8} from "./encoding.js";
import {signBytes, verifyBytes} from "./realize-crypto.js";
import {
  CommissionV1Schema, ProvenanceRecordV1Schema, RealizeQuoteV1Schema, SettlementInstructionV1Schema,
  canTransitionRealizeCommission, verifyRealizeQuoteSignature,
  type CommissionV1, type RealizeQuoteV1, type ProvenanceRecordV1, type SettlementInstructionV1
} from "./realize.js";
import {RealizeContractError} from "./realize-contracts.js";
import {z} from "zod";

export type DeepReadonly<T> = T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? {readonly [K in keyof T]: DeepReadonly<T[K]>} : T;
function freezeDeep<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** The authorized key must come from a trusted registry, never request JSON. */
export function freezeAcceptedRealizeQuote(input: unknown, expectedHash: string, acceptedAt: string, authorizedPublicKey: string): DeepReadonly<RealizeQuoteV1> {
  const quote = RealizeQuoteV1Schema.parse(input);
  const at = Date.parse(z.string().datetime({offset: true}).parse(acceptedAt));
  if (quote.canonical_quote_hash !== expectedHash) throw new RealizeContractError("QUOTE_HASH_MISMATCH", "accepted hash does not match the issued quote");
  if (at >= Date.parse(quote.expires_at)) throw new RealizeContractError("QUOTE_EXPIRED", "quote has expired");
  if (at < Date.parse(quote.issued_at)) throw new RealizeContractError("INVALID_REQUEST", "quote cannot be accepted before it was issued");
  if (quote.issuer_public_key !== authorizedPublicKey || !verifyRealizeQuoteSignature(quote, authorizedPublicKey)) throw new RealizeContractError("QUOTE_SIGNATURE_INVALID", "quote issuer signature is invalid or unauthorized");
  // Zod creates an independent snapshot; freezing does not mutate the caller's object.
  return freezeDeep(quote);
}

const paymentTransitions: Readonly<Record<string, readonly string[]>> = {
  not_started: ["pending", "failed"], pending: ["authorized", "captured", "failed"],
  authorized: ["captured", "failed"], captured: ["refund_pending", "settled"],
  failed: [], refund_pending: ["refunded", "captured"], refunded: [], settled: []
};
const fulfillmentTransitions: Readonly<Record<string, readonly string[]>> = {
  not_started: ["queued", "generating", "failed", "canceled"],
  queued: ["generating", "completed", "failed", "canceled"],
  generating: ["completed", "failed", "canceled"], completed: [], failed: [], canceled: []
};

/** Guard a durable update before compare-and-swap persistence. Same-state retries are allowed. */
export function assertRealizeCommissionUpdate(previousInput: unknown, nextInput: unknown): CommissionV1 {
  const previous = CommissionV1Schema.parse(previousInput);
  const next = CommissionV1Schema.parse(nextInput);
  if (previous.commission_id !== next.commission_id || previous.commissioner_id !== next.commissioner_id || previous.creator_id !== next.creator_id || previous.created_at !== next.created_at || Date.parse(next.updated_at) < Date.parse(previous.updated_at)) {
    throw new RealizeContractError("INVALID_REQUEST", "commission identity and creation time are immutable; updates must be monotonic");
  }
  if (previous.state !== next.state && !canTransitionRealizeCommission(previous.state, next.state)) throw new RealizeContractError("INVALID_STATE_TRANSITION", `${previous.state} cannot transition to ${next.state}`);
  if (["SETTLED", "REFUNDED", "EXPIRED"].includes(previous.state) && canonicalize(previous) !== canonicalize(next)) throw new RealizeContractError("INVALID_STATE_TRANSITION", "terminal commissions cannot change");
  if (previous.payment_state !== next.payment_state && !paymentTransitions[previous.payment_state]!.includes(next.payment_state)) throw new RealizeContractError("INVALID_STATE_TRANSITION", "invalid independent payment-state transition");
  if (previous.fulfillment_state !== next.fulfillment_state && !fulfillmentTransitions[previous.fulfillment_state]!.includes(next.fulfillment_state)) throw new RealizeContractError("INVALID_STATE_TRANSITION", "invalid independent fulfillment-state transition");
  if (!previous.accepted_quote_hash && next.accepted_quote_hash && (previous.state !== "QUOTED" || next.state !== "AWAITING_PAYMENT" || previous.quote_id !== next.quote_id || previous.capability_id !== next.capability_id || previous.rights_agreement_reference !== next.rights_agreement_reference || canonicalize(previous.requested_generation_parameters) !== canonicalize(next.requested_generation_parameters))) throw new RealizeContractError("QUOTE_IMMUTABLE", "acceptance must bind the existing quoted commission");
  if (previous.accepted_quote_hash && (previous.accepted_quote_hash !== next.accepted_quote_hash || previous.quote_id !== next.quote_id || previous.capability_id !== next.capability_id || previous.rights_agreement_reference !== next.rights_agreement_reference || canonicalize(previous.requested_generation_parameters) !== canonicalize(next.requested_generation_parameters))) {
    throw new RealizeContractError("QUOTE_IMMUTABLE", "accepted quote binding, rights, capability, and parameters cannot change");
  }
  if (next.state === "REFUND_PENDING" && !["captured", "refund_pending"].includes(previous.payment_state)) throw new RealizeContractError("PAYMENT_REQUIRED", "only captured funds can enter refund processing");
  if ((previous.payment_intent_id && previous.payment_intent_id !== next.payment_intent_id) || (previous.fulfillment_request_id && previous.fulfillment_request_id !== next.fulfillment_request_id)) throw new RealizeContractError("IDEMPOTENCY_CONFLICT", "payment and fulfillment identities cannot be replaced once assigned");
  return next;
}

/** Creates protocol data only; persistence and payment evidence remain adapter responsibilities. */
export function acceptRealizeCommissionQuote(commissionInput: unknown, quoteInput: unknown, acceptedAt: string, authorizedPublicKey: string): {commission: CommissionV1; quote: DeepReadonly<RealizeQuoteV1>} {
  const commission = CommissionV1Schema.parse(commissionInput);
  const parsedQuote = RealizeQuoteV1Schema.parse(quoteInput);
  const quote = freezeAcceptedRealizeQuote(parsedQuote, parsedQuote.canonical_quote_hash, acceptedAt, authorizedPublicKey);
  if (commission.state !== "QUOTED" || commission.quote_id !== quote.quote_id) throw new RealizeContractError("INVALID_STATE_TRANSITION", "commission must be quoted with this quote before acceptance");
  if (commission.creator_id !== quote.creator_id || (quote.commission_id && quote.commission_id !== commission.commission_id) || (quote.capability_id && quote.capability_id !== commission.capability_id) || commission.rights_agreement_reference !== quote.rights_agreement_reference || canonicalize(commission.requested_generation_parameters) !== canonicalize(quote.requested_generation_parameters)) throw new RealizeContractError("QUOTE_HASH_MISMATCH", "quote does not describe this commission");
  return {quote, commission: assertRealizeCommissionUpdate(commission, {...commission, accepted_quote_hash: quote.canonical_quote_hash, state: "AWAITING_PAYMENT", payment_state: "pending", updated_at: acceptedAt})};
}

/** Bind the full payout plan to a previously accepted, authorized quote snapshot. */
export function assertRealizeSettlementMatchesQuote(instructionInput: unknown, quoteInput: unknown): SettlementInstructionV1 {
  const instruction = SettlementInstructionV1Schema.parse(instructionInput);
  const quote = RealizeQuoteV1Schema.parse(quoteInput);
  if (instruction.quote_id !== quote.quote_id || instruction.canonical_quote_hash !== quote.canonical_quote_hash ||
    instruction.total_amount_usdc_atomic !== quote.total_amount_usdc_atomic ||
    (quote.commission_id && instruction.commission_id !== quote.commission_id) ||
    (quote.network_id && instruction.network_id !== quote.network_id) ||
    (quote.usdc_mint && instruction.usdc_mint !== quote.usdc_mint) ||
    (quote.settlement_program_version && instruction.settlement_program_version !== quote.settlement_program_version)) {
    throw new RealizeContractError("SETTLEMENT_MISMATCH", "settlement does not bind to the accepted quote");
  }
  const quoted = new Map(quote.payout_recipients.map((recipient) => [recipient.payout_id, recipient]));
  if (quoted.size !== instruction.payout_recipients.length || instruction.payout_recipients.some((recipient) => {
    const expected = quoted.get(recipient.payout_id);
    return !expected || expected.recipient_id !== recipient.recipient_id || expected.role !== recipient.role || expected.amount_usdc_atomic !== recipient.amount_usdc_atomic || (expected.destination !== undefined && expected.destination !== recipient.destination);
  })) throw new RealizeContractError("SETTLEMENT_MISMATCH", "settlement recipients differ from accepted payouts");
  return instruction;
}

export function provenanceRecordSigningPayload(record: Omit<ProvenanceRecordV1, "signature">): Uint8Array {
  return concatBytes(utf8("vox.realize.provenance.v1"), new Uint8Array([0]), utf8(canonicalize(record)));
}
export function signProvenanceRecord(record: Omit<ProvenanceRecordV1, "signature">, secretKey: Uint8Array): string {
  return signBytes(provenanceRecordSigningPayload(record), secretKey);
}
export function verifyProvenanceRecord(input: unknown, authorizedPublicKey: string | Uint8Array): boolean {
  const parsed = ProvenanceRecordV1Schema.safeParse(input);
  if (!parsed.success) return false;
  const {signature, ...unsigned} = parsed.data;
  return verifyBytes(provenanceRecordSigningPayload(unsigned), signature, authorizedPublicKey);
}

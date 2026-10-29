import {canonicalize} from "@vox/protocol";
import type {RealizeCommissionRecord} from "./types.js";

/** Recovery may advance status, but never rewrite the customer's accepted
 * transfer instructions or the verified receipt used for settlement/refund. */
export function assertImmutableRealizePaymentEvidence(current: RealizeCommissionRecord, next: RealizeCommissionRecord): void {
  const immutable = (before: unknown, after: unknown, label: string) => {
    if (before !== undefined && (after === undefined || canonicalize(before) !== canonicalize(after))) throw new Error(`${label} is immutable`);
  };
  for (const field of [
    "payer_wallet", "payout_configuration_version", "direct_funding", "escrow_funding", "rights_reviewed_at",
    "funding_signature", "funding_network_id", "funding_verified_at", "funding_block_time", "funding_timing_status", "funded_at",
    "provenance_record_id", "settlement_instruction"
  ] as const) immutable(current[field], next[field], `Realize ${field}`);
  immutable(current.commission.payment_intent_id, next.commission.payment_intent_id, "Realize payment intent id");
  if (current.payment_intent) {
    const {status: _priorStatus, ...binding} = current.payment_intent;
    const {status: _nextStatus, ...nextBinding} = next.payment_intent ?? {};
    immutable(binding, next.payment_intent && nextBinding, "Realize payment intent binding");
  }
  if (current.commission.accepted_quote_hash && current.public_attribution !== next.public_attribution) throw new Error("Realize public attribution consent is immutable after quote acceptance");
  if (current.fulfillment_result?.status === "completed") immutable(current.fulfillment_result, next.fulfillment_result, "Realize verified completed fulfillment");
}

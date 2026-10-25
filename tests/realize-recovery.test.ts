import {describe, expect, it} from "vitest";
import {assertRealizeCommissionUpdate, type CommissionV1} from "@vox/protocol";

const expired: CommissionV1 = {
  protocol_version: "realize/1", commission_id: "commission:expired", commissioner_id: "human:customer",
  creator_id: "creator:bob", capability_id: "video:short-form", requested_generation_parameters: {concept: "An expired scene"},
  quote_id: "quote:original", accepted_quote_hash: "a".repeat(64), payment_intent_id: "payment:original",
  rights_agreement_reference: "rights:original", state: "EXPIRED", payment_state: "failed", fulfillment_state: "not_started",
  created_at: "2026-10-24T10:00:00.000Z", updated_at: "2026-10-24T10:05:00.000Z"
};

describe("expired accepted payment recovery contract", () => {
  it("retains the original accepted terms and payment identity while recording capture and review before generation", () => {
    expect(assertRealizeCommissionUpdate(expired, {...expired, state: "AWAITING_PAYMENT", payment_state: "pending", updated_at: "2026-10-24T10:06:00.000Z"})).toMatchObject({state: "AWAITING_PAYMENT", payment_state: "pending"});
    const funded = assertRealizeCommissionUpdate(expired, {...expired, state: "FUNDED", payment_state: "captured", updated_at: "2026-10-24T10:06:00.000Z"});
    expect(assertRealizeCommissionUpdate(funded, {...funded, state: "MANUAL_REVIEW"})).toMatchObject({state: "MANUAL_REVIEW", payment_state: "captured", fulfillment_state: "not_started"});
  });

  it("cannot change accepted terms/payment identities or revive an unaccepted or provider-started commission", () => {
    const funded = {...expired, state: "FUNDED", payment_state: "captured"};
    for (const altered of [
      {...funded, quote_id: "quote:replacement"},
      {...funded, accepted_quote_hash: "b".repeat(64)},
      {...funded, payment_intent_id: "payment:replacement"},
      {...funded, requested_generation_parameters: {concept: "Changed terms"}},
      {...funded, fulfillment_state: "queued"}
    ]) expect(() => assertRealizeCommissionUpdate(expired, altered)).toThrow();
    const {accepted_quote_hash: _hash, payment_intent_id: _intent, ...unaccepted} = expired;
    expect(() => assertRealizeCommissionUpdate(unaccepted, funded)).toThrow();
    expect(() => assertRealizeCommissionUpdate(expired, {...expired, updated_at: "2026-10-24T10:06:00.000Z"})).toThrow();
  });
});

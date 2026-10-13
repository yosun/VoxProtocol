import {createHmac} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {createAgent, createHuman} from "@vox/identity";
import {parseSecretKey, realizeClientRequestSigningPayload, signBytes} from "@vox/protocol";
import {RealizeProviderHttpError, type PopuliRealizeClient, type RealizeCreatorPayoutConfigurationV1} from "../apps/api/src/realize-engine.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup() {
  const store = new MemoryStore();
  const creator = createAgent({display_name: "Staging creator", handle: "@staging-creator", description: "test"});
  const human = createHuman({display_name: "Commissioner", handle: "@commissioner", description: "test"});
  await store.registerAgent(creator.registration);
  await store.registerHuman(human.registration);
  const quote = JSON.parse(readFileSync(new URL("../packages/protocol/fixtures/realize/bob-one-dollar-special-video.quote.json", import.meta.url), "utf8"));
  quote.creator_id = creator.registration.agent_id;
  quote.commission_id = "vox:commission:encoded:test";
  quote.payout_configuration_version = 1;
  await store.createRealizeQuote(quote);
  const configuration = {creator_id: creator.registration.agent_id, version: 1, rights_agreement_reference: "rights:staging-pinned"} as RealizeCreatorPayoutConfigurationV1;
  await store.createRealizePayoutConfiguration(configuration);
  const now = new Date().toISOString();
  const record = {commission: {protocol_version: "realize/1", commission_id: quote.commission_id, commissioner_id: human.registration.human_id, creator_id: creator.registration.agent_id, capability_id: "video:short-form", requested_generation_parameters: quote.requested_generation_parameters, rights_agreement_reference: quote.rights_agreement_reference, state: "GENERATING", payment_state: "captured", fulfillment_state: "queued", quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, fulfillment_request_id: "fulfillment:staging", created_at: now, updated_at: now}, fulfillment_request: {generation_provider_id: "provider:video:example"}, fulfillment_deadline_at: new Date(Date.now() + 600_000).toISOString(), settlement_status: "not_started", created_at: now, updated_at: now} as RealizeCommissionRecord;
  await store.createRealizeCommission(record, "test-key");
  const getFulfillment = vi.fn(async () => ({protocol_version: "realize/1" as const, fulfillment_request_id: "fulfillment:staging", commission_id: quote.commission_id, generation_provider_id: "provider:video:example", status: "generating" as const, outputs: []}));
  const requestFulfillment = vi.fn();
  const provider: PopuliRealizeClient = {
    getCapabilities: async () => ({protocol_version: "realize/1", creator_id: creator.registration.agent_id, generation_provider_ids: ["provider:video:example"], capabilities: [{capability_id: "video:short-form", input_schema_uri: "https://provider.example.test/v1/realize/schemas/video", output_media_types: ["video/mp4"], max_duration_seconds: 15}], updated_at: now}),
    getInputSchema: async () => ({type: "object", properties: {concept: {type: "string"}}}),
    getCurrentPrice: vi.fn(), requestFulfillment, getFulfillment
  };
  app = await buildApp({store, populiRealizeClient: provider});
  async function request(path: string, method: "GET" | "POST" = "GET", body?: unknown, signingPath = path) {
    const issued_at = new Date().toISOString();
    const principal_id = human.registration.human_id;
    const signature = signBytes(realizeClientRequestSigningPayload({method, path: signingPath, principal_id, issued_at, ...(body === undefined ? {} : {body})}), parseSecretKey(human.key_material.identitySecretKey));
    const response = await app!.inject({method, url: path, ...(body === undefined ? {} : {payload: body}), headers: {"x-vox-realize-human-id": principal_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signature}});
    return {status: response.statusCode, body: response.json()};
  }
  return {store, creator, record, getFulfillment, requestFulfillment, request};
}

describe("Realize API checkout integration", () => {
  it("returns VOX's pinned rights reference when Populi omits the optional field", async () => {
    const {creator} = await setup();
    const response = await app!.inject(`/v1/realize/creators/${encodeURIComponent(creator.registration.agent_id)}/capabilities`);
    expect(response.statusCode).toBe(200);
    expect(response.json().rights_agreement_references).toEqual(["rights:staging-pinned"]);
  });

  it("verifies the encoded commission path and polls generation without a callback", async () => {
    const {record, request, getFulfillment} = await setup();
    const path = `/v1/realize/commissions/${encodeURIComponent(record.commission.commission_id)}`;
    const response = await request(path);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.commission.fulfillment_state).toBe("generating");
    expect(getFulfillment).toHaveBeenCalledOnce();
    await Promise.all([request(path), request(path)]);
    expect(getFulfillment).toHaveBeenCalledOnce();
  });

  it("honors the provider Retry-After without resubmitting generation", async () => {
    const {record, store, request, getFulfillment, requestFulfillment} = await setup();
    getFulfillment.mockRejectedValueOnce(new RealizeProviderHttpError(429, 60_000));
    const path = `/v1/realize/commissions/${encodeURIComponent(record.commission.commission_id)}`;
    const before = Date.now();
    expect((await request(path)).status).toBe(200);
    const saved = await store.getRealizeCommission(record.commission.commission_id);
    expect(Date.parse(saved!.provider_poll_not_before!) - before).toBeGreaterThanOrEqual(60_000);
    expect((await request(path)).status).toBe(200);
    expect(getFulfillment).toHaveBeenCalledOnce();
    expect(requestFulfillment).not.toHaveBeenCalled();
  });

  it("keeps provider failure pending before deadline and never resubmits a generation job", async () => {
    const {record, store, request, getFulfillment, requestFulfillment} = await setup();
    getFulfillment.mockResolvedValueOnce({protocol_version: "realize/1", fulfillment_request_id: "fulfillment:staging", commission_id: record.commission.commission_id, generation_provider_id: "provider:video:example", status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED", completed_at: new Date().toISOString()});
    const path = `/v1/realize/commissions/${encodeURIComponent(record.commission.commission_id)}`;
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.body.commission.state).toBe("GENERATING");
    expect(response.body.failure_reason).toMatch(/signed terminal confirmation/);
    const saved = await store.getRealizeCommission(record.commission.commission_id);
    expect(saved?.failure_evidence).toBeUndefined();
    expect(requestFulfillment).not.toHaveBeenCalled();
  });

  it("moves ambiguous status after deadline to manual review without issuing a refund", async () => {
    const {record, store, request, getFulfillment, requestFulfillment} = await setup();
    const stale = {...record, fulfillment_deadline_at: new Date(Date.now() - 1_000).toISOString(), updated_at: new Date(Date.now() + 1).toISOString()};
    await store.updateRealizeCommission(stale, record.updated_at);
    getFulfillment.mockResolvedValueOnce({protocol_version: "realize/1", fulfillment_request_id: "fulfillment:staging", commission_id: record.commission.commission_id, generation_provider_id: "provider:video:example", status: "generating", outputs: []});
    const response = await request(`/v1/realize/commissions/${encodeURIComponent(record.commission.commission_id)}`);
    expect(response.status).toBe(200);
    expect(response.body.commission.state).toBe("MANUAL_REVIEW");
    expect(response.body.resolution_outcome).toBe("manual_review");
    expect(response.body.resolution_reason).toBe("provider_status_ambiguous_after_deadline");
    expect(response.body.failure_evidence).toBeUndefined();
    expect(requestFulfillment).not.toHaveBeenCalled();
  });

  it("accepts a signed terminal failure once, then ignores a late success callback", async () => {
    vi.stubEnv("VOX_REALIZE_POPULI_WEBHOOK_SECRET", "test-only-populi-webhook-secret");
    const {record, store} = await setup();
    async function callback(deliveryId: string, result: unknown) {
      const timestamp = Math.floor(Date.now() / 1_000).toString();
      const rawBody = JSON.stringify(result);
      const signature = `v1=${createHmac("sha256", "test-only-populi-webhook-secret").update(`${timestamp}.`).update(rawBody).digest("hex")}`;
      return app!.inject({method: "POST", url: "/v1/realize/webhooks/populi", payload: rawBody, headers: {"x-realize-webhook-id": deliveryId, "x-realize-webhook-timestamp": timestamp, "x-realize-webhook-signature": signature, "content-type": "application/json"}});
    }
    const failed = {protocol_version: "realize/1", fulfillment_request_id: "fulfillment:staging", commission_id: record.commission.commission_id, generation_provider_id: "provider:video:example", status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED", completed_at: new Date().toISOString()};
    const rejected = await callback("terminal-failure-1", failed);
    expect(rejected.statusCode).toBe(200);
    expect((await store.getRealizeCommission(record.commission.commission_id))?.commission.state).toBe("REFUND_PENDING");
    const duplicate = await callback("terminal-failure-1", failed);
    expect(duplicate.json().duplicate).toBe(true);
    const completed = {protocol_version: "realize/1", fulfillment_request_id: "fulfillment:staging", commission_id: record.commission.commission_id, generation_provider_id: "provider:video:example", status: "completed", outputs: [{uri: "https://artifacts.example.test/output.mp4", media_type: "video/mp4", sha256: "a".repeat(64), byte_length: 1}], started_at: new Date(Date.now() - 2_000).toISOString(), completed_at: new Date().toISOString()};
    const late = await callback("late-completion-1", completed);
    expect(late.statusCode).toBe(200);
    const saved = await store.getRealizeCommission(record.commission.commission_id);
    expect(saved?.commission.state).toBe("REFUND_PENDING");
    expect(saved?.provenance_record_id).toBeUndefined();
    expect(saved?.resolution_events?.some((event) => event.action === "late_callback_ignored")).toBe(true);
  });

  it("authenticates encoded accept, fund and refund paths before checking state", async () => {
    const {record, request} = await setup();
    const base = `/v1/realize/commissions/${encodeURIComponent(record.commission.commission_id)}`;
    const payer = "45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr";
    const bodies = {"accept-quote": {quote_id: record.commission.quote_id, canonical_quote_hash: record.commission.accepted_quote_hash, payer_wallet: payer, rights_reviewed: true}, fund: {payer_wallet: payer, transaction_signature: "1".repeat(88)}, refund: {payer_wallet: payer, transaction_signature: "1".repeat(88)}};
    for (const [action, body] of Object.entries(bodies)) {
      const response = await request(`${base}/${action}`, "POST", body);
      expect(response.status).not.toBe(401);
      expect(response.body.code).not.toBe("invalid_signature");
    }
    const invalid = await request(base, "GET", undefined, `/v1/realize/commissions/${record.commission.commission_id}`);
    expect(invalid.status).toBe(401);
  });
});

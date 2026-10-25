import {createHash} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Keypair} from "@solana/web3.js";
import {createAgent} from "@vox/identity";
import {bytesToHex, domainHash, generateKeyPair, publicKeyBase64, utf8, type FulfillmentResultV1, type ProviderFulfillmentRequestV1} from "@vox/protocol";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {buildRealizeQuote, createFirstPartyRealizeRightsPolicy, generationParametersHash, RealizeCreatorPayoutConfigurationV1Schema, RealizeProviderHttpError, type PopuliRealizeClient} from "../apps/api/src/realize-engine.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function setup(expired = false) {
  const store = new MemoryStore();
  const creator = createAgent({display_name: "Submission recovery", handle: "submission-recovery", description: "Synthetic first-party creator"});
  await store.registerAgent(creator.registration);
  vi.stubEnv("VOX_REALIZE_FIRST_PARTY_CREATOR_IDS", creator.registration.agent_id);
  const issuer = generateKeyPair();
  const instanceId = "vox.test.submission";
  const instancePublicKey = publicKeyBase64(issuer.publicKey);
  const issuerKeyId = `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${instanceId}\u0000${instancePublicKey}`)))}`;
  const wallet = Keypair.generate().publicKey.toBase58();
  const policy = createFirstPartyRealizeRightsPolicy({creator_id: creator.registration.agent_id, character_owner_id: creator.registration.agent_id, rights_subject_id: `vox:creator:${creator.registration.agent_id}`});
  const configuration = RealizeCreatorPayoutConfigurationV1Schema.parse({
    protocol_version: "realize/1", creator_id: creator.registration.agent_id, version: 1, populi_api_base_url: "https://populi.example.test",
    rights_agreement_reference: policy.policy.policy_id, rights_agreement_version: 1, rights_agreement_hash: policy.terms_hash, rights_subject_id: policy.policy.rights_subject_id,
    rights_policy_mode: "first_party", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, settlement_program_version: "spl-usdc-mainnet-v1", funding_destination_token_account: wallet,
    provider_payouts: [{provider_id: "provider:video:example", recipients: [{recipient_id: "provider:test", destination: wallet, basis_points: 10_000}]}], character_owner_id: creator.registration.agent_id,
    character_owner_markup: {fee: {}, recipients: [{recipient_id: creator.registration.agent_id, destination: wallet, basis_points: 10_000}]}, platform_fee: {fee: {}, recipients: [{recipient_id: "vox:platform", destination: wallet, basis_points: 10_000}]}, additional_beneficiaries: []
  });
  await store.createRealizePayoutConfiguration(configuration);
  const issuedAt = new Date(Date.now() - (expired ? 600_000 : 1_000)).toISOString();
  const fundedAt = new Date(Date.parse(issuedAt) + 100).toISOString();
  const createdAt = new Date(Date.parse(issuedAt) + 200).toISOString();
  const parameters = {concept: "Synthetic submission recovery", duration_seconds: 6};
  const commissionId = "vox:commission:submission-recovery";
  const quote = buildRealizeQuote({configuration, commissionId, pricingRequestId: "pricing:submission", pricingRequestHash: "b".repeat(64), capabilityId: "video:short-form", generationProviderId: "provider:video:example", generationParameters: parameters, outputMediaTypes: ["video/mp4"], issuedAt,
    providerPrice: {protocol_version: "realize/1", request_id: "pricing:submission", provider_quote_id: "provider-price:submission", creator_id: creator.registration.agent_id, capability_id: "video:short-form", generation_provider_id: "provider:video:example", requested_generation_parameters_hash: generationParametersHash(parameters), price_usdc_atomic: "100000", issued_at: issuedAt, expires_at: new Date(Date.parse(issuedAt) + 600_000).toISOString()},
    issuerId: instanceId, issuerKeyId, issuerPublicKey: instancePublicKey, issuerSecretKey: issuer.secretKey});
  await store.createRealizeQuote(quote);
  const intentId = `vox:payment-intent:${hash(`${commissionId}\u0000${quote.canonical_quote_hash}`)}`;
  const requestId = `vox:fulfillment:${hash(`${commissionId}\u0000${quote.canonical_quote_hash}`)}`;
  const fundingSignature = "1".repeat(88);
  const paymentReference = `vox:realize:payment:${intentId}:${quote.canonical_quote_hash}`;
  const request: ProviderFulfillmentRequestV1 = {protocol_version: "realize/1", fulfillment_request_id: requestId, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, generation_provider_id: quote.generation_provider_id, requested_generation_parameters: parameters, output_media_types: ["video/mp4"], provider_quote_id: quote.provider_price_quote_id!, idempotency_key: requestId, callback_uri: "https://vox.example.test/v1/realize/webhooks/populi", created_at: createdAt,
    funding_authorization: {protocol_version: "realize/1", authorization_id: `vox:funding-authorization:${hash(`${commissionId}\u0000${quote.canonical_quote_hash}\u0000${fundingSignature}`)}`, payment_intent_id: intentId, commission_id: commissionId, accepted_quote_hash: quote.canonical_quote_hash, asset: "USDC", total_amount_usdc_atomic: quote.total_amount_usdc_atomic, provider_amount_usdc_atomic: quote.provider_cost_usdc_atomic!, network_id: quote.network_id!, payment_reference: paymentReference, verified_by: instanceId, verified_at: fundedAt}};
  const now = new Date().toISOString();
  const record: RealizeCommissionRecord = {
    commission: {protocol_version: "realize/1", commission_id: commissionId, commissioner_id: "human:submission-test", creator_id: creator.registration.agent_id, capability_id: "video:short-form", requested_generation_parameters: parameters, rights_agreement_reference: configuration.rights_agreement_reference, state: "GENERATING", payment_state: "captured", fulfillment_state: "queued", quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, payment_intent_id: intentId, fulfillment_request_id: requestId, created_at: issuedAt, updated_at: now},
    payment_intent: {protocol_version: "realize/1", payment_intent_id: intentId, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, payer_id: "human:submission-test", amount_usdc_atomic: quote.total_amount_usdc_atomic, asset: "USDC", network_id: quote.network_id!, status: "captured", idempotency_key: intentId, expires_at: quote.expires_at, created_at: issuedAt},
    direct_funding: {mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, destination_token_account: wallet, destination_owner: wallet, amount_usdc_atomic: quote.total_amount_usdc_atomic, payment_reference: paymentReference, payer_wallet: wallet, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, expires_at: quote.expires_at},
    payer_wallet: wallet, rights_reviewed_at: issuedAt, funding_signature: fundingSignature, funding_network_id: quote.network_id!, funding_verified_at: fundedAt, funded_at: fundedAt, fulfillment_request: request, fulfillment_deadline_at: new Date(Date.now() + 600_000).toISOString(), settlement_status: "not_started", created_at: issuedAt, updated_at: now
  };
  await store.createRealizeCommission(record);
  const result: FulfillmentResultV1 = {protocol_version: "realize/1", fulfillment_request_id: requestId, commission_id: commissionId, generation_provider_id: quote.generation_provider_id, status: "queued", outputs: []};
  const jobs = new Map<string, FulfillmentResultV1>();
  const getFulfillment = vi.fn(async () => {
    const prior = jobs.get(requestId);
    if (!prior) throw new RealizeProviderHttpError(404, 5_000, "COMMISSION_NOT_FOUND");
    return prior;
  });
  const requestFulfillment = vi.fn(async (_config: unknown, submitted: ProviderFulfillmentRequestV1) => {
    const prior = jobs.get(submitted.fulfillment_request_id);
    if (!prior) jobs.set(submitted.fulfillment_request_id, result);
    return prior ?? result;
  });
  const provider = {getCapabilities: vi.fn(), getInputSchema: vi.fn(), getCurrentPrice: vi.fn(), getFulfillment, requestFulfillment} satisfies PopuliRealizeClient;
  app = await buildApp({store, instanceId, instanceSecretKey: issuer.secretKey, internalToken: "test-only-submission-token", populiRealizeClient: provider});
  const run = () => app!.inject({method: "POST", url: "/v1/internal/realize/reconcile", headers: {"x-vox-internal-token": "test-only-submission-token"}, payload: {limit: 1}});
  const latest = () => store.getRealizeCommission(commissionId);
  const permitPoll = async () => {
    const current = (await latest())!;
    await store.updateRealizeCommission({...current, provider_poll_not_before: "1970-01-01T00:00:00.000Z"}, current.updated_at);
  };
  return {store, record, quote, request, result, jobs, getFulfillment, requestFulfillment, run, latest, permitPoll};
}

describe("durable provider submission recovery", () => {
  it("recovers a crash before POST with the exact persisted body, key and timestamps", async () => {
    const test = await setup();
    const response = await test.run();
    expect(response.statusCode).toBe(200);
    expect(test.getFulfillment).toHaveBeenCalledOnce();
    expect(test.requestFulfillment).toHaveBeenCalledExactlyOnceWith(expect.anything(), test.request);
    expect(test.jobs.size).toBe(1);
    expect(await test.latest()).toMatchObject({fulfillment_request: test.request, fulfillment_result: test.result, fulfillment_submission_recovery_attempts: 1, commission: {payment_state: "captured", state: "GENERATING"}});
  });

  it("finds an existing provider job after a lost initial response without another POST", async () => {
    const test = await setup();
    test.jobs.set(test.request.fulfillment_request_id, test.result);
    await test.run();
    expect(test.requestFulfillment).not.toHaveBeenCalled();
    expect(await test.latest()).toMatchObject({fulfillment_result: test.result});
  });

  it("keeps an ambiguous POST captured and recovers it by lookup without a second job", async () => {
    const test = await setup();
    test.requestFulfillment.mockImplementationOnce(async (_configuration, request) => { test.jobs.set(request.fulfillment_request_id, test.result); throw new Error("response lost after provider commit"); });
    await test.run();
    expect(await test.latest()).toMatchObject({commission: {state: "GENERATING", payment_state: "captured"}});
    expect((await test.latest())?.failure_evidence).toBeUndefined();
    await test.permitPoll();
    await test.run();
    expect(test.jobs.size).toBe(1);
    expect(test.requestFulfillment).toHaveBeenCalledOnce();
    expect(await test.latest()).toMatchObject({fulfillment_result: test.result});
  });

  it("serializes concurrent recovery attempts and never changes the stored request", async () => {
    const test = await setup();
    await Promise.all([test.run(), test.run()]);
    expect(test.requestFulfillment).toHaveBeenCalledOnce();
    expect(test.jobs.size).toBe(1);
    const current = (await test.latest())!;
    await expect(test.store.updateRealizeCommission({...current, fulfillment_request: {...test.request, created_at: new Date().toISOString()}}, current.updated_at)).rejects.toThrow("persisted Realize provider request and idempotency key are immutable");
  });

  it("never retries a plain/malformed HTTP missing response or provider throttling", async () => {
    const test = await setup();
    for (const error of [new RealizeProviderHttpError(404, 5_000), new RealizeProviderHttpError(404, 5_000, "CREATOR_NOT_FOUND"), new RealizeProviderHttpError(429, 60_000)]) {
      test.getFulfillment.mockRejectedValueOnce(error);
      await test.run();
      expect(test.requestFulfillment).not.toHaveBeenCalled();
      await test.permitPoll();
    }
  });

  it("keeps a missing job after quote expiry in manual review without failure evidence or a refund", async () => {
    const test = await setup(true);
    await test.run();
    expect(test.requestFulfillment).not.toHaveBeenCalled();
    expect(await test.latest()).toMatchObject({commission: {state: "MANUAL_REVIEW", payment_state: "captured"}, resolution_reason: "provider_submission_window_expired"});
    expect((await test.latest())?.failure_evidence).toBeUndefined();
    expect((await test.latest())?.refund_response).toBeUndefined();
  });

  it.each(["REFUND_PENDING", "COMPLETED"] as const)("does not submit after a concurrent %s transition", async (state) => {
    const test = await setup();
    test.getFulfillment.mockImplementationOnce(async () => {
      const current = (await test.latest())!;
      await test.store.updateRealizeCommission({...current, commission: {...current.commission, state, payment_state: state === "REFUND_PENDING" ? "refund_pending" : "captured", fulfillment_state: state === "REFUND_PENDING" ? "failed" : "completed"}, updated_at: new Date(Date.parse(current.updated_at) + 1).toISOString()}, current.updated_at);
      throw new RealizeProviderHttpError(404, 5_000, "COMMISSION_NOT_FOUND");
    });
    await test.run();
    expect(test.requestFulfillment).not.toHaveBeenCalled();
    expect((await test.latest())?.commission.state).toBe(state);
  });

  it("does not recreate a previously acknowledged provider job that later disappears", async () => {
    const test = await setup();
    await test.store.updateRealizeCommission({...test.record, fulfillment_result: test.result}, test.record.updated_at);
    await test.run();
    expect(test.requestFulfillment).not.toHaveBeenCalled();
    expect((await test.latest())?.resolution_reason).toBe("provider_record_missing_after_acceptance");
  });

  it("bounds exact-body retries and leaves unresolved outcomes for review", async () => {
    const test = await setup();
    test.requestFulfillment.mockRejectedValue(new Error("transport unavailable"));
    for (let attempt = 0; attempt < 4; attempt += 1) { await test.run(); await test.permitPoll(); }
    expect(test.requestFulfillment).toHaveBeenCalledTimes(3);
    expect(test.jobs.size).toBe(0);
    expect(await test.latest()).toMatchObject({commission: {state: "MANUAL_REVIEW", payment_state: "captured"}, resolution_reason: "provider_submission_recovery_exhausted"});
    expect((await test.latest())?.failure_evidence).toBeUndefined();
  });
});

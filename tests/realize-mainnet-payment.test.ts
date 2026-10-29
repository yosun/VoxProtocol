import {afterEach, describe, expect, it, vi} from "vitest";
import {createHash, createHmac} from "node:crypto";
import {Keypair, PublicKey} from "@solana/web3.js";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {createAgent, createHuman} from "@vox/identity";
import {
  bytesToHex, computeRevenueRightsAgreementHash, domainHash, generateKeyPair,
  publicKeyBase64, parseSecretKey, signRealizeClientRequest, signRightsAgreementAcceptance, utf8,
  REALIZE_COMMISSIONER_ROLE_PARTY_ID, RevenueRightsAgreementV1Schema, type RealizeQuoteV1
} from "@vox/protocol";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {buildRealizeQuote, createFirstPartyRealizeRightsPolicy, generationParametersHash, RealizeCreatorPayoutConfigurationV1Schema} from "../apps/api/src/realize-engine.js";
import {MainnetSplUsdcRealizePaymentRail, SOLANA_MAINNET_GENESIS_HASH, type MainnetSplUsdcFundingAuthorization, type RealizePaymentRail} from "../apps/api/src/realize-payment.js";
import type {PopuliRealizeClient, RealizeRefundResponseV1} from "../apps/api/src/realize-engine.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";

const payer = Keypair.generate().publicKey.toBase58();
const treasuryOwner = Keypair.generate().publicKey.toBase58();
const treasuryTokenAccount = getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC_MINT), new PublicKey(treasuryOwner)).toBase58();
/** Fabricated encoded receipt bytes for mocked chain responses. They do not
 * sign any message and are never broadcast or claimed as live refund proof. */
function mockReceiptSignature(fill: number, leadingZeroBytes = 0): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(64).fill(fill);
  bytes.fill(0, 0, leadingZeroBytes);
  let value = bytes.reduce((encoded, byte) => encoded * 256n + BigInt(byte), 0n);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)]! + encoded;
    value /= 58n;
  }
  const firstNonzero = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(firstNonzero < 0 ? bytes.length : firstNonzero) + encoded;
}
const mainnetSignature = mockReceiptSignature(1);
const refundSignature = mockReceiptSignature(9);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.setSystemTime();
  vi.useRealTimers();
});

/** Exercise the real signed API/operator routes without a wallet, RPC or paid provider. */
async function refundAuditHarness() {
  const store = new MemoryStore();
  const creator = createAgent({display_name: "Refund audit creator", handle: "@refund-audit", description: "test"});
  const customer = createHuman({display_name: "Refund audit customer", handle: "@refund-customer", description: "test"});
  const operator = createHuman({display_name: "Refund audit operator", handle: "@refund-operator", description: "test"});
  await store.registerAgent(creator.registration);
  await store.registerHuman(customer.registration);
  await store.registerHuman(operator.registration);
  const policyTerms = {creator_id: creator.registration.agent_id, character_owner_id: creator.registration.agent_id, rights_subject_id: "vox:creator:refund-audit"};
  const policy = createFirstPartyRealizeRightsPolicy(policyTerms);
  const configuration = RealizeCreatorPayoutConfigurationV1Schema.parse({
    ...policyTerms, protocol_version: "realize/1", version: 1,
    populi_api_base_url: "https://provider.example.test", artifact_hosts: ["provider.example.test"],
    rights_policy_mode: "first_party", rights_agreement_reference: policy.policy.policy_id, rights_agreement_version: 1, rights_agreement_hash: policy.terms_hash,
    usdc_mint: MAINNET_USDC_MINT, network_id: "solana:mainnet-beta", settlement_program_version: "spl-usdc-mainnet-v1",
    funding_destination_token_account: treasuryTokenAccount, quote_ttl_seconds: 300,
    provider_payouts: [{provider_id: "provider:audit", recipients: [{recipient_id: "provider:audit", destination: treasuryOwner, basis_points: 10_000}]}],
    character_owner_markup: {fee: {}, recipients: [{recipient_id: creator.registration.agent_id, destination: treasuryOwner, basis_points: 10_000}]},
    platform_fee: {fee: {}, recipients: [{recipient_id: "vox:platform", destination: treasuryOwner, basis_points: 10_000}]}, additional_beneficiaries: []
  });
  await store.createRealizePayoutConfiguration(configuration);
  const issuer = generateKeyPair();
  const instanceId = "instance:refund-audit";
  const instancePublicKey = publicKeyBase64(issuer.publicKey);
  const issuedAt = new Date().toISOString();
  const commissionId = "vox:commission:refund-audit";
  const quote = buildRealizeQuote({configuration, commissionId, pricingRequestId: "pricing:refund-audit", pricingRequestHash: "a".repeat(64),
    capabilityId: "video:short-form", generationProviderId: "provider:audit", generationParameters: {concept: "An audit scene"}, outputMediaTypes: ["video/mp4"],
    providerPrice: {protocol_version: "realize/1", request_id: "pricing:refund-audit", provider_quote_id: "provider-price:refund-audit", creator_id: creator.registration.agent_id,
      capability_id: "video:short-form", generation_provider_id: "provider:audit", requested_generation_parameters_hash: generationParametersHash({concept: "An audit scene"}),
      price_usdc_atomic: "250000", issued_at: issuedAt, expires_at: new Date(Date.now() + 600_000).toISOString()},
    issuedAt, issuerId: instanceId, issuerKeyId: `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${instanceId}\u0000${instancePublicKey}`)))}`,
    issuerPublicKey: instancePublicKey, issuerSecretKey: issuer.secretKey});
  await store.createRealizeQuote(quote);
  await store.createRealizeCommission({commission: {protocol_version: "realize/1", commission_id: commissionId, commissioner_id: customer.registration.human_id,
    creator_id: creator.registration.agent_id, capability_id: "video:short-form", requested_generation_parameters: quote.requested_generation_parameters,
    rights_agreement_reference: policy.policy.policy_id, quote_id: quote.quote_id, state: "QUOTED", payment_state: "not_started", fulfillment_state: "not_started", created_at: issuedAt, updated_at: issuedAt},
    payout_configuration_version: 1, settlement_status: "not_started", created_at: issuedAt, updated_at: issuedAt});
  vi.stubEnv("VOX_REALIZE_FIRST_PARTY_CREATOR_IDS", creator.registration.agent_id);
  vi.stubEnv("VOX_REALIZE_OPERATOR_HUMAN_IDS", operator.registration.human_id);
  vi.stubEnv("VOX_REALIZE_SETTLEMENT_URL", "https://settlement.example.test");
  vi.stubEnv("VOX_REALIZE_SETTLEMENT_TOKEN", "test-only-token");
  vi.stubEnv("VOX_REALIZE_POPULI_WEBHOOK_SECRET", "test-only-webhook-secret");
  const verifyFunding = vi.fn(async () => ({finalized: true, matched: true, block_time: Math.floor(Date.now() / 1_000)}));
  const rail: RealizePaymentRail<MainnetSplUsdcFundingAuthorization> = {mode: "direct", networkId: "solana:mainnet-beta", usdcMint: MAINNET_USDC_MINT,
    prepareFunding: async ({quote: accepted, commission, payerWallet}) => ({mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT,
      destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner, amount_usdc_atomic: accepted.total_amount_usdc_atomic,
      payment_reference: `vox:realize:payment:${commission.payment_intent_id}:${accepted.canonical_quote_hash}`, payer_wallet: payerWallet,
      commission_id: commissionId, quote_id: accepted.quote_id, accepted_quote_hash: accepted.canonical_quote_hash, expires_at: accepted.expires_at}), verifyFunding};
  const requestFulfillment = vi.fn(async (_configuration: unknown, request: {fulfillment_request_id: string}) => ({protocol_version: "realize/1" as const,
    fulfillment_request_id: request.fulfillment_request_id, commission_id: commissionId, generation_provider_id: "provider:audit", status: "queued" as const, outputs: []}));
  const provider = {getCapabilities: vi.fn(), getInputSchema: vi.fn(), getCurrentPrice: vi.fn(), getFulfillment: vi.fn(), requestFulfillment};
  const refundId = `vox:refund:${createHash("sha256").update(`vox:refund:${commissionId}:${quote.canonical_quote_hash}`).digest("hex")}`;
  let reserved = false;
  const response = (): RealizeRefundResponseV1 => ({refund_id: refundId, status: "processing", updated_at: new Date().toISOString()});
  const settlement = {requestSettlement: vi.fn(), getSettlement: vi.fn(),
    getPaymentIntentResolution: vi.fn(async (paymentIntentId: string) => ({payment_intent_id: paymentIntentId, kind: reserved ? "refund" : "none", ...(reserved ? {record_id: refundId, state: "active"} : {})})),
    requestRefund: vi.fn(async () => { reserved = true; return response(); }), getRefund: vi.fn(async () => response())};
  app = await buildApp({store, instanceId, instanceSecretKey: issuer.secretKey, internalToken: "test-only-internal-token", mainnetRealizePaymentRail: rail,
    populiRealizeClient: provider, solanaRealizeSettlementClient: settlement as never});
  const base = `/v1/realize/commissions/${encodeURIComponent(commissionId)}`;
  const approvalPath = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/refund-approval`;
  async function signed(path: string, body?: unknown, signer = customer) {
    const method = body === undefined ? "GET" as const : "POST" as const;
    const issued_at = new Date().toISOString();
    return app!.inject({method, url: path, ...(body === undefined ? {} : {payload: body}), headers: {
      "x-vox-internal-token": "test-only-internal-token", "x-vox-realize-human-id": signer.registration.human_id, "x-vox-realize-timestamp": issued_at,
      "x-vox-realize-signature": signRealizeClientRequest({method, path, principal_id: signer.registration.human_id, issued_at, ...(body === undefined ? {} : {body})}, parseSecretKey(signer.key_material.identitySecretKey))}});
  }
  const accepted = await signed(`${base}/accept-quote`, {quote_id: quote.quote_id, canonical_quote_hash: quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
  expect(accepted.statusCode, accepted.body).toBe(201);
  async function fund() {
    const funded = await signed(`${base}/fund`, {payer_wallet: payer, transaction_signature: mainnetSignature});
    expect(funded.statusCode, funded.body).toBe(202);
    return funded;
  }
  async function providerCallback(callbackResult: Record<string, unknown>, deliveryId: string) {
    const current = (await store.getRealizeCommission(commissionId))!;
    const body = JSON.stringify({protocol_version: "realize/1", fulfillment_request_id: current.commission.fulfillment_request_id,
      commission_id: commissionId, generation_provider_id: "provider:audit", completed_at: new Date().toISOString(), ...callbackResult});
    const timestamp = Math.floor(Date.now() / 1_000).toString();
    const result = await app!.inject({method: "POST", url: "/v1/realize/webhooks/populi", payload: body, headers: {"content-type": "application/json",
      "x-realize-webhook-id": deliveryId, "x-realize-webhook-timestamp": timestamp,
      "x-realize-webhook-signature": `v1=${createHmac("sha256", "test-only-webhook-secret").update(`${timestamp}.`).update(body).digest("hex")}`}});
    expect(result.statusCode, result.body).toBe(200);
  }
  const failProvider = () => providerCallback({status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED"}, "refund-audit-failure");
  const approval = {payer_wallet: payer, funding_signature: mainnetSignature, payment_intent_id: accepted.json().payment_intent.payment_intent_id,
    accepted_quote_hash: quote.canonical_quote_hash, amount_usdc_atomic: quote.total_amount_usdc_atomic, reason: "Refund the exact verified original payment under the audit."};
  return {store, quote, commissionId, base, refundId, rail, settlement, requestFulfillment, signed, fund, failProvider, providerCallback, approval,
    approve: (body = approval) => signed(approvalPath, body, operator)};
}

describe("Mainnet refund terminal evidence", () => {
  it("records a failed payout after delivery without refunding or losing the successful fulfillment", async () => {
    const audit = await refundAuditHarness();
    await audit.fund();
    const settlementId = `vox:settlement:${createHash("sha256").update(`${audit.commissionId}\u0000${audit.quote.canonical_quote_hash}`).digest("hex")}`;
    audit.settlement.requestSettlement.mockResolvedValue({protocol_version: "realize/1", settlement_id: settlementId, accepted: true});
    const failedSettlement = {settlement_id: settlementId, status: "failed", settled_amount_usdc_atomic: "0", failed_payout_ids: audit.quote.payout_recipients.map((payout) => payout.payout_id), transaction_signatures: [mockReceiptSignature(8)], updated_at: new Date().toISOString()};
    audit.settlement.getSettlement.mockResolvedValue(failedSettlement);
    const content = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(content, {headers: {"content-type": "video/mp4"}})));
    await audit.providerCallback({status: "completed", outputs: [{uri: "https://provider.example.test/completed.mp4", media_type: "video/mp4", byte_length: content.length, sha256: createHash("sha256").update(content).digest("hex")}]}, "refund-audit-completed");
    const delivered = await audit.signed(audit.base);
    expect(delivered.json()).toMatchObject({commission: {state: "COMPLETED", payment_state: "captured", fulfillment_state: "completed"}, resolution_outcome: "fulfilled", settlement_status: "failed", settlement_response: failedSettlement});
    expect(delivered.json().failure_reason).toMatch(/payout.*review/);
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.provenance_record_id).toEqual(expect.any(String));
    expect((await audit.approve()).statusCode).toBe(409);
    expect(audit.settlement.requestRefund).not.toHaveBeenCalled();
    expect(audit.requestFulfillment).toHaveBeenCalledOnce();
  });

  it("preserves the exact accepted payer, payment authorization and finalized funding receipt during updates", async () => {
    const audit = await refundAuditHarness();
    const accepted = (await audit.store.getRealizeCommission(audit.commissionId))!;
    for (const changes of [
      {payer_wallet: Keypair.generate().publicKey.toBase58()},
      {payment_intent: {...accepted.payment_intent!, amount_usdc_atomic: "1000001"}},
      {commission: {...accepted.commission, payment_intent_id: "payment:replacement"}},
      {direct_funding: {...accepted.direct_funding!, destination_token_account: Keypair.generate().publicKey.toBase58()}},
      {rights_reviewed_at: undefined}
    ]) await expect(audit.store.updateRealizeCommission({...accepted, ...changes}, accepted.updated_at)).rejects.toThrow(/immutable/);
    await audit.fund();
    const funded = (await audit.store.getRealizeCommission(audit.commissionId))!;
    for (const changes of [
      {funding_signature: mainnetSignature.slice(1)}, {funding_signature: undefined}, {funding_network_id: "solana:devnet"},
      {funding_verified_at: undefined}, {funding_timing_status: "after_quote_expiry" as const}
    ]) await expect(audit.store.updateRealizeCommission({...funded, ...changes}, funded.updated_at)).rejects.toThrow(/immutable/);
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.funding_signature).toBe(mainnetSignature);
  });

  it("completes an exact refund after a late payment without ever requesting a provider render", async () => {
    const audit = await refundAuditHarness();
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date(Date.parse(audit.quote.expires_at) + 2_000));
    const funded = await audit.fund();
    expect(funded.json()).toMatchObject({state: "MANUAL_REVIEW", payment_state: "captured", fulfillment_state: "not_started"});
    audit.settlement.requestRefund.mockResolvedValueOnce({refund_id: audit.refundId, status: "refunded", transaction_signature: refundSignature, updated_at: new Date().toISOString()});
    const refunded = await audit.approve();
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json()).toMatchObject({commission: {state: "REFUNDED", payment_state: "refunded", fulfillment_state: "not_started"}, resolution_outcome: "refunded"});
    const saved = (await audit.store.getRealizeCommission(audit.commissionId))!;
    expect(saved.resolution_events?.map((event) => event.action)).toEqual(["manual_review_required", "refund_approved", "refund_finalized"]);
    expect(saved.fulfillment_request).toBeUndefined();
    expect(audit.requestFulfillment).not.toHaveBeenCalled();
    expect(audit.settlement.requestRefund).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({payer_wallet: payer, funding_transaction_signature: mainnetSignature,
      amount_usdc_atomic: audit.quote.total_amount_usdc_atomic, payment_intent_id: audit.approval.payment_intent_id}));
    const retry = await audit.signed(audit.base);
    expect(retry.json().commission.state).toBe("REFUNDED");
    expect(audit.settlement.requestRefund).toHaveBeenCalledOnce();
  });

  it.each(["processing", "refunded"] as const)("rejects a %s response for a different refund", async (status) => {
    const audit = await refundAuditHarness();
    await audit.fund();
    await audit.failProvider();
    audit.settlement.requestRefund.mockResolvedValueOnce({refund_id: "vox:refund:another-payment", status, transaction_signature: refundSignature, updated_at: new Date().toISOString()});
    const response = await audit.approve();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({commission: {state: "MANUAL_REVIEW"}, resolution_reason: "refund_response_mismatch"});
    const current = await audit.store.getRealizeCommission(audit.commissionId);
    expect(current?.refund_response).toBeUndefined();
    expect(current?.resolution_events?.some((event) => event.action === "refund_finalized")).toBe(false);
  });

  it("rejects terminal refund claims without a transaction signature", async () => {
    const audit = await refundAuditHarness();
    await audit.fund();
    await audit.failProvider();
    audit.settlement.requestRefund.mockResolvedValueOnce({refund_id: audit.refundId, status: "refunded", updated_at: new Date().toISOString()});
    const response = await audit.approve();
    expect(response.json()).toMatchObject({commission: {state: "MANUAL_REVIEW"}, resolution_reason: "refund_finalization_evidence_missing"});
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.resolution_outcome).toBe("manual_review");
  });

  it.each([
    ["truncated", "a".repeat(64)],
    ["overlong", "z".repeat(88)],
    ["extra leading-zero byte", `1${refundSignature}`]
  ])("rejects a %s terminal receipt whose decoded signature is not 64 bytes", async (_description, transactionSignature) => {
    const audit = await refundAuditHarness();
    await audit.fund();
    await audit.failProvider();
    audit.settlement.requestRefund.mockResolvedValueOnce({refund_id: audit.refundId, status: "refunded", transaction_signature: transactionSignature, updated_at: new Date().toISOString()});
    const response = await audit.approve();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({commission: {state: "MANUAL_REVIEW"}, resolution_reason: "refund_finalization_evidence_missing"});
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.resolution_events?.some((event) => event.action === "refund_finalized")).toBe(false);
  });

  it("preserves canonical leading-zero signature bytes in mocked terminal refund evidence", async () => {
    const audit = await refundAuditHarness();
    await audit.fund();
    await audit.failProvider();
    const withLeadingZeros = mockReceiptSignature(9, 2);
    expect(withLeadingZeros.startsWith("11")).toBe(true);
    audit.settlement.requestRefund.mockResolvedValueOnce({refund_id: audit.refundId, status: "refunded", transaction_signature: withLeadingZeros, updated_at: new Date().toISOString()});
    const response = await audit.approve();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({commission: {state: "REFUNDED"}, refund_response: {transaction_signature: withLeadingZeros}});
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.refund_response?.transaction_signature).toBe(withLeadingZeros);
  });

  it("does not approve a refund when an empty resolution contradicts evidence of a payout", async () => {
    const audit = await refundAuditHarness();
    await audit.fund();
    await audit.failProvider();
    audit.settlement.getPaymentIntentResolution.mockResolvedValueOnce({payment_intent_id: audit.approval.payment_intent_id, kind: "none", settled_amount_usdc_atomic: "1"} as never);
    const response = await audit.approve();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("settlement_requires_review");
    expect(audit.settlement.requestRefund).not.toHaveBeenCalled();
    expect((await audit.store.getRealizeCommission(audit.commissionId))?.refund_approval).toBeUndefined();
  });
});

describe("Mainnet SPL USDC Realize payment rail", () => {
  it("issues a quote-bound treasury transfer authorization and verifies its mainnet, memo, mint, amount, recipient and payer", async () => {
    const verifyTransfer = vi.fn(async () => ({finalized: true, matched: true, network_matches: true, usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, amount_atomic: "2000000", source_token_account: Keypair.generate().publicKey.toBase58()}));
    const validateTreasury = vi.fn(async () => undefined);
    const rail = new MainnetSplUsdcRealizePaymentRail({
      rpcUrl: "https://rpc.example.test/mainnet",
      treasuryTokenAccount,
      treasuryOwner,
      maxPaymentAtomic: "2500000",
      getGenesisHash: async () => SOLANA_MAINNET_GENESIS_HASH,
      validateTreasury,
      verifyTransfer
    });
    const quote = {network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, total_amount_usdc_atomic: "2000000", expires_at: new Date(Date.now() + 60_000).toISOString(), canonical_quote_hash: "a".repeat(64), quote_id: "quote:mainnet", commission_id: "vox:commission:mainnet"} as RealizeQuoteV1;
    const commission = {commission_id: "vox:commission:mainnet", quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash} as never;
    const funding = await rail.prepareFunding({quote, commission, payerWallet: payer, authorizedIssuerPublicKey: "unused"});
    expect(validateTreasury).toHaveBeenCalledOnce();
    expect(funding).toMatchObject({mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner, amount_usdc_atomic: "2000000", payer_wallet: payer, accepted_quote_hash: quote.canonical_quote_hash});
    const verification = await rail.verifyFunding(funding, mainnetSignature, payer);
    expect(verification).toEqual({finalized: true, matched: true});
    expect(verifyTransfer).toHaveBeenCalledWith(expect.objectContaining({network_id: "solana:mainnet-beta", rpc_url: "https://rpc.example.test/mainnet", transaction_signature: mainnetSignature, usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, amount_atomic: "2000000", payer_address: payer, payment_reference: funding.payment_reference}));
    for (const malformed of ["a".repeat(64), "z".repeat(88), `1${mainnetSignature}`]) {
      const calls = verifyTransfer.mock.calls.length;
      expect(await rail.verifyFunding(funding, malformed, payer)).toMatchObject({finalized: true, matched: false, reason: "Payment transaction signature is invalid."});
      expect(verifyTransfer).toHaveBeenCalledTimes(calls);
    }
    const leadingZeroFixture = mockReceiptSignature(1, 2);
    expect(await rail.verifyFunding(funding, leadingZeroFixture, payer)).toMatchObject({finalized: true, matched: true});
    expect(verifyTransfer).toHaveBeenLastCalledWith(expect.objectContaining({transaction_signature: leadingZeroFixture}));
  });

  it("allows an uninitialized treasury ATA and binds the first payment to its exact owner", async () => {
    const owner = Keypair.generate().publicKey;
    const mint = new PublicKey(MAINNET_USDC_MINT);
    const treasuryAta = getAssociatedTokenAddressSync(mint, owner);
    const rail = new MainnetSplUsdcRealizePaymentRail({
      rpcUrl: "https://rpc.example.test/mainnet", treasuryTokenAccount: treasuryAta.toBase58(), treasuryOwner: owner.toBase58(),
      maxPaymentAtomic: "2500000"
    });
    vi.spyOn(rail.connection, "getGenesisHash").mockResolvedValue(SOLANA_MAINNET_GENESIS_HASH);
    vi.spyOn(rail.connection, "getAccountInfo").mockResolvedValue(null);
    const quote = {network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, total_amount_usdc_atomic: "2000000", expires_at: new Date(Date.now() + 60_000).toISOString(), canonical_quote_hash: "d".repeat(64), quote_id: "quote:first-payment", commission_id: "vox:commission:first-payment"} as RealizeQuoteV1;
    const commission = {commission_id: quote.commission_id, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash} as never;
    const funding = await rail.prepareFunding({quote, commission, payerWallet: payer, authorizedIssuerPublicKey: "unused"});
    expect(funding.destination_token_account).toBe(treasuryAta.toBase58());
    expect(funding.destination_owner).toBe(owner.toBase58());
  });

  it("allows a $1 default minimum and rejects smaller Mainnet transfer authorizations", async () => {
    const rail = new MainnetSplUsdcRealizePaymentRail({rpcUrl: "https://rpc.example.test/mainnet", treasuryTokenAccount, treasuryOwner, maxPaymentAtomic: "10000000000", getGenesisHash: async () => SOLANA_MAINNET_GENESIS_HASH, validateTreasury: async () => undefined});
    const quote = {network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, total_amount_usdc_atomic: "999999", expires_at: new Date(Date.now() + 60_000).toISOString(), canonical_quote_hash: "e".repeat(64), quote_id: "quote:below-minimum", commission_id: "vox:commission:below-minimum"} as RealizeQuoteV1;
    const commission = {commission_id: quote.commission_id, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash} as never;
    await expect(rail.prepareFunding({quote, commission, payerWallet: payer, authorizedIssuerPublicKey: "unused"})).rejects.toThrow("minimum payment");

    const oneDollarQuote = {...quote, total_amount_usdc_atomic: "1000000", quote_id: "quote:one-dollar", commission_id: "vox:commission:one-dollar"} as RealizeQuoteV1;
    const oneDollarCommission = {commission_id: oneDollarQuote.commission_id, quote_id: oneDollarQuote.quote_id, accepted_quote_hash: oneDollarQuote.canonical_quote_hash} as never;
    const authorization = await rail.prepareFunding({quote: oneDollarQuote, commission: oneDollarCommission, payerWallet: payer, authorizedIssuerPublicKey: "unused"});
    expect(authorization.amount_usdc_atomic).toBe("1000000");
  });

  it("fails closed for wrong-network quotes, excessive prices, and an RPC serving the wrong cluster", async () => {
    const rail = new MainnetSplUsdcRealizePaymentRail({
      rpcUrl: "https://rpc.example.test/mainnet", treasuryTokenAccount, treasuryOwner,
      maxPaymentAtomic: "2000000", getGenesisHash: async () => "devnet-genesis",
      validateTreasury: async () => undefined,
      verifyTransfer: vi.fn(async () => ({finalized: true, matched: true, usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, amount_atomic: "2000000"}))
    });
    const baseQuote = {network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, total_amount_usdc_atomic: "2000000", expires_at: new Date(Date.now() + 60_000).toISOString(), canonical_quote_hash: "b".repeat(64), quote_id: "quote:mainnet", commission_id: "vox:commission:mainnet"} as RealizeQuoteV1;
    const commission = {commission_id: baseQuote.commission_id, quote_id: baseQuote.quote_id, accepted_quote_hash: baseQuote.canonical_quote_hash} as never;
    await expect(rail.prepareFunding({quote: {...baseQuote, network_id: "solana:devnet"}, commission, payerWallet: payer, authorizedIssuerPublicKey: "unused"})).rejects.toThrow("mainnet-beta");
    await expect(rail.prepareFunding({quote: {...baseQuote, total_amount_usdc_atomic: "2000001"}, commission, payerWallet: payer, authorizedIssuerPublicKey: "unused"})).rejects.toThrow("per-payment limit");
    const commissionId = "vox:commission:wrong-rpc";
    const paymentIntentId = `vox:payment-intent:${createHash("sha256").update(`${commissionId}\u0000${baseQuote.canonical_quote_hash}`).digest("hex")}`;
    const auth = {...baseQuote, mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner, amount_usdc_atomic: "2000000", payment_reference: `vox:realize:payment:${paymentIntentId}:${baseQuote.canonical_quote_hash}`, payer_wallet: payer, commission_id: commissionId, quote_id: "quote:mainnet", accepted_quote_hash: baseQuote.canonical_quote_hash, expires_at: baseQuote.expires_at} as MainnetSplUsdcFundingAuthorization;
    await expect(rail.verifyFunding(auth, mainnetSignature, payer)).rejects.toThrow("does not serve Solana mainnet-beta");
  });

  it("verifies and recovers Mainnet payments across expiry, retries, refunds and replay protection", async () => {
    vi.stubEnv("VOX_REALIZE_SETTLEMENT_URL", "https://settlement.example.test");
    vi.stubEnv("VOX_REALIZE_SETTLEMENT_TOKEN", "test-only-token");
    const store = new MemoryStore();
    const creator = createAgent({display_name: "Realize creator", handle: "@realize-creator", description: "test"}, new Uint8Array(32).fill(31));
    const owner = createAgent({display_name: "Realize owner", handle: "@realize-owner", description: "test"}, new Uint8Array(32).fill(32));
    const providerPayee = createAgent({display_name: "Video provider", handle: "@video-provider", description: "test"}, new Uint8Array(32).fill(33));
    const platformPayee = createAgent({display_name: "VOX platform", handle: "@vox-platform", description: "test"}, new Uint8Array(32).fill(34));
    const human = createHuman({display_name: "Commissioner", handle: "@realize-customer", description: "test"}, new Uint8Array(32).fill(35));
    const operator = createHuman({display_name: "Refund operator", handle: "@realize-operator", description: "test"}, new Uint8Array(32).fill(37));
    for (const agent of [creator, owner, providerPayee, platformPayee]) await store.registerAgent(agent.registration);
    await store.registerHuman(human.registration);
    await store.registerHuman(operator.registration);

    const now = new Date().toISOString();
    const rightsSubjectId = `vox:post:${"c".repeat(64)}`;
    const agreementId = "rights:mainnet-payment-test";
    const unsignedAgreement = RevenueRightsAgreementV1Schema.parse({
      protocol_version: "realize/1", agreement_id: agreementId, version: 1,
      artifact_scope: {subject_type: "post", subject_id: rightsSubjectId},
      parties: [
        {party_id: creator.registration.agent_id, role: "creator"},
        {party_id: owner.registration.agent_id, role: "character_owner"},
        {party_id: providerPayee.registration.agent_id, role: "provider"},
        {party_id: platformPayee.registration.agent_id, role: "platform"},
        {party_id: REALIZE_COMMISSIONER_ROLE_PARTY_ID, role: "commissioner"}
      ],
      grant: {work_scope: "A generated short-form video", rights: ["generate", "reproduce", "display"], license_type: "non_exclusive", territory: ["worldwide"], attribution_required: false, starts_at: now},
      revenue_definition: {basis: "gross_received", description: "USDC received from eligible downstream transactions", permitted_deductions: []},
      eligible_transaction_types: ["commission"], allocations: [{beneficiary_id: creator.registration.agent_id, basis_points: 10_000}],
      duration: {starts_at: now}, termination_conditions: ["mutual_consent"],
      modification_policy: {proposer_party_ids: [creator.registration.agent_id, owner.registration.agent_id], required_acceptance_party_ids: [creator.registration.agent_id, owner.registration.agent_id]},
      required_acceptance_party_ids: [creator.registration.agent_id, owner.registration.agent_id],
      termination_policy: {authorized_party_ids: [creator.registration.agent_id, owner.registration.agent_id], required_acceptance_party_ids: [creator.registration.agent_id, owner.registration.agent_id]},
      provenance_references: [{category: "authorship", party_id: creator.registration.agent_id, record_id: "record:mainnet-payment-test"}],
      attribution: [{party_id: creator.registration.agent_id, credit_text: "Created by the creator."}], acceptances: [], created_at: now
    });
    const termsHash = computeRevenueRightsAgreementHash(unsignedAgreement);
    const rightsRecord = {agreement: unsignedAgreement, terms_hash: termsHash, status: "proposed" as const, audit_history: [], created_at: now, updated_at: now};
    await store.createRightsAgreement(rightsRecord);
    const accepting = [creator, owner].map((agent) => {
      const unsigned = {party_id: agent.registration.agent_id, key_id: "root", public_key: agent.registration.identity_public_key, terms_hash: termsHash, accepted_at: now};
      return {...unsigned, signature: signRightsAgreementAcceptance(agreementId, 1, unsigned, parseSecretKey(agent.key_material.identitySecretKey))};
    });
    const activeAgreement = RevenueRightsAgreementV1Schema.parse({...unsignedAgreement, acceptances: accepting});
    await store.acceptRightsAgreement(agreementId, 1, {...rightsRecord, agreement: activeAgreement, status: "active", updated_at: now}, {event_id: "rights-audit:mainnet-payment-test", agreement_id: agreementId, version: 1, kind: "accepted", actor_id: creator.registration.agent_id, record_hash: termsHash, occurred_at: now, evidence_reference: "test"});

    const config = RealizeCreatorPayoutConfigurationV1Schema.parse({
      protocol_version: "realize/1", creator_id: creator.registration.agent_id, version: 1,
      populi_api_base_url: "https://provider.example.test", populi_api_token_env: "VOX_POPULI_API_TOKEN",
      artifact_hosts: ["provider.example.test"], rights_agreement_reference: agreementId, rights_agreement_version: 1,
      rights_subject_id: rightsSubjectId, rights_agreement_hash: termsHash,
      usdc_mint: MAINNET_USDC_MINT, network_id: "solana:mainnet-beta", settlement_program_version: "spl-usdc-mainnet-v1",
      funding_destination_token_account: treasuryTokenAccount, quote_ttl_seconds: 300,
      provider_payouts: [{provider_id: "provider:video:example", recipients: [{recipient_id: providerPayee.registration.agent_id, destination: Keypair.generate().publicKey.toBase58(), basis_points: 10_000}]}],
      character_owner_id: owner.registration.agent_id,
      character_owner_markup: {fee: {fixed_amount_usdc_atomic: "200000", percent_basis_points: 0, minimum_amount_usdc_atomic: "0", percentage_basis: "provider_base"}, recipients: [{recipient_id: owner.registration.agent_id, destination: Keypair.generate().publicKey.toBase58(), basis_points: 10_000}]},
      platform_fee: {fee: {fixed_amount_usdc_atomic: "50000", percent_basis_points: 0, minimum_amount_usdc_atomic: "0", percentage_basis: "provider_base"}, recipients: [{recipient_id: platformPayee.registration.agent_id, destination: Keypair.generate().publicKey.toBase58(), basis_points: 10_000}]},
      additional_beneficiaries: []
    });
    await store.createRealizePayoutConfiguration(config);

    const issuer = generateKeyPair(new Uint8Array(32).fill(36));
    const instanceId = "vox.mainnet.payment.test";
    const instancePublicKey = publicKeyBase64(issuer.publicKey);
    const issuerKeyId = `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${instanceId}\u0000${instancePublicKey}`)))}`;
    const parameters = {concept: "A short test scene", duration_seconds: 6, style: "cinematic"};
    const capabilityId = "video:short-form";
    const providerPrice = {protocol_version: "realize/1" as const, request_id: "pricing:mainnet-test", provider_quote_id: "provider-price:mainnet-test", creator_id: creator.registration.agent_id, capability_id: capabilityId, generation_provider_id: "provider:video:example", requested_generation_parameters_hash: generationParametersHash(parameters), price_usdc_atomic: "750000", issued_at: now, expires_at: new Date(Date.now() + 600_000).toISOString()};

    async function addCommission(suffix: string) {
      const commissionId = `vox:commission:mainnet-${suffix}`;
      const quote = buildRealizeQuote({configuration: config, commissionId, pricingRequestId: `pricing:mainnet-${suffix}`, pricingRequestHash: "d".repeat(64), capabilityId, generationProviderId: "provider:video:example", generationParameters: parameters, outputMediaTypes: ["video/mp4"], providerPrice: {...providerPrice, request_id: `pricing:${suffix}`, provider_quote_id: `provider-price:${suffix}`} , issuedAt: now, issuerId: instanceId, issuerKeyId, issuerPublicKey: instancePublicKey, issuerSecretKey: issuer.secretKey});
      await store.createRealizeQuote(quote);
      const commission = {protocol_version: "realize/1" as const, commission_id: commissionId, commissioner_id: human.registration.human_id, creator_id: creator.registration.agent_id, capability_id: capabilityId, requested_generation_parameters: parameters, quote_id: quote.quote_id, rights_agreement_reference: agreementId, state: "QUOTED" as const, payment_state: "not_started" as const, fulfillment_state: "not_started" as const, created_at: now, updated_at: now};
      await store.createRealizeCommission({commission, payout_configuration_version: 1, settlement_status: "not_started", created_at: now, updated_at: now} as RealizeCommissionRecord);
      return {commissionId, quote};
    }

    const first = await addCommission("one");
    const second = await addCommission("two");
    expect(first.quote.payout_recipients.every((recipient) => recipient.destination.startsWith("solana:mainnet-beta:"))).toBe(true);
    let latePaymentExpiresAt = 0;
    let boundaryPaymentExpiresAt = 0;
    let retryPaymentExpiresAt = 0;
    let retryRpcFailuresRemaining = 1;
    const lateSignature = mockReceiptSignature(2);
    const retrySignature = mockReceiptSignature(3);
    const boundarySignature = mockReceiptSignature(4);
    const verifyFunding = vi.fn(async (_funding: MainnetSplUsdcFundingAuthorization, signature: string) => {
      if (signature === lateSignature) return {finalized: true, matched: true, block_time: Math.floor(latePaymentExpiresAt / 1_000) + 1};
      if (signature === boundarySignature) return {finalized: true, matched: true, block_time: Math.floor(boundaryPaymentExpiresAt / 1_000)};
      if (signature === retrySignature) {
        if (retryRpcFailuresRemaining-- > 0) throw new Error("temporary Mainnet RPC timeout after signature submission");
        return {finalized: true, matched: true, block_time: Math.floor(retryPaymentExpiresAt / 1_000) - 1};
      }
      return {finalized: true, matched: true, block_time: Math.floor(Date.now() / 1_000)};
    });
    const prepareFunding = vi.fn(async ({quote, commission, payerWallet}: {quote: RealizeQuoteV1; commission: {commission_id: string}; payerWallet: string}) => {
        const paymentIntentId = `vox:payment-intent:${createHash("sha256").update(`${commission.commission_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
        return {mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT, destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner, amount_usdc_atomic: quote.total_amount_usdc_atomic, payment_reference: `vox:realize:payment:${paymentIntentId}:${quote.canonical_quote_hash}`, payer_wallet: payerWallet, commission_id: commission.commission_id, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, expires_at: quote.expires_at};
    });
    const rail: RealizePaymentRail<MainnetSplUsdcFundingAuthorization> = {
      mode: "direct", networkId: "solana:mainnet-beta", usdcMint: MAINNET_USDC_MINT,
      prepareFunding,
      verifyFunding
    };
    const requestFulfillment = vi.fn(async (configuration: never, request: any) => ({protocol_version: "realize/1" as const, fulfillment_request_id: request.fulfillment_request_id, commission_id: request.commission_id, generation_provider_id: request.generation_provider_id, status: "queued" as const, outputs: [], started_at: new Date().toISOString()}));
    const populi: PopuliRealizeClient = {getCapabilities: vi.fn(), getInputSchema: vi.fn(), getCurrentPrice: vi.fn(), requestFulfillment, getFulfillment: vi.fn()};
    const reservedRefunds = new Map<string, string>();
    const settlement = {
      requestSettlement: vi.fn(), getSettlement: vi.fn(),
      getPaymentIntentResolution: vi.fn(async (paymentIntentId: string) => ({payment_intent_id: paymentIntentId, kind: reservedRefunds.has(paymentIntentId) ? "refund" : "none", ...(reservedRefunds.has(paymentIntentId) ? {record_id: reservedRefunds.get(paymentIntentId), state: "active", batch_statuses: ["prepared"]} : {})})),
      requestRefund: vi.fn(async (input: {payment_intent_id: string; idempotency_key: string}) => {
        const refundId = `vox:refund:${createHash("sha256").update(input.idempotency_key).digest("hex")}`;
        reservedRefunds.set(input.payment_intent_id, refundId);
        return {refund_id: refundId, status: "processing", updated_at: new Date().toISOString()};
      }),
      getRefund: vi.fn(async (refundId: string) => ({refund_id: refundId, status: "processing", updated_at: new Date().toISOString()}))
    };
    vi.stubEnv("VOX_REALIZE_POPULI_WEBHOOK_SECRET", "test-only-populi-webhook-secret");
    vi.stubEnv("VOX_INTERNAL_TOKEN", "test-only-internal-token");
    vi.stubEnv("VOX_REALIZE_OPERATOR_HUMAN_IDS", operator.registration.human_id);
    app = await buildApp({store, mainnetRealizePaymentRail: rail, instanceId, instanceSecretKey: issuer.secretKey, populiRealizeClient: populi, solanaRealizeSettlementClient: settlement as never});

    async function signedRequest(path: string, body: unknown, extraHeaders: Record<string, string> = {}, signer = human) {
      const issuedAt = new Date().toISOString();
      return app!.inject({method: "POST", url: path, payload: body, headers: {
        "x-vox-realize-human-id": signer.registration.human_id,
        "x-vox-realize-timestamp": issuedAt,
        "x-vox-realize-signature": signRealizeClientRequest({method: "POST", path, principal_id: signer.registration.human_id, issued_at: issuedAt, body}, parseSecretKey(signer.key_material.identitySecretKey)),
        ...extraHeaders
      }});
    }
    async function signedGet(path: string, signer = human, extraHeaders: Record<string, string> = {}) {
      const issuedAt = new Date().toISOString();
      return app!.inject({method: "GET", url: path, headers: {
        "x-vox-realize-human-id": signer.registration.human_id,
        "x-vox-realize-timestamp": issuedAt,
        "x-vox-realize-signature": signRealizeClientRequest({method: "GET", path, principal_id: signer.registration.human_id, issued_at: issuedAt}, parseSecretKey(signer.key_material.identitySecretKey)),
        ...extraHeaders
      }});
    }
    const acceptPath = `/v1/realize/commissions/${encodeURIComponent(first.commissionId)}/accept-quote`;
    const notReviewed = await signedRequest(acceptPath, {quote_id: first.quote.quote_id, canonical_quote_hash: first.quote.canonical_quote_hash, payer_wallet: payer});
    expect(notReviewed.statusCode).toBe(400);
    expect(prepareFunding).not.toHaveBeenCalled();
    const accepted = await signedRequest(acceptPath, {quote_id: first.quote.quote_id, canonical_quote_hash: first.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true, nft_publication_consent: true});
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().funding).toMatchObject({mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner});
    expect(accepted.json().funding).not.toHaveProperty("program_id");
    const changedConsentRetry = await signedRequest(acceptPath, {quote_id: first.quote.quote_id, canonical_quote_hash: first.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true, nft_publication_consent: false});
    expect(changedConsentRetry.statusCode).toBe(409);
    expect(changedConsentRetry.json().code).toBe("quote_acceptance_conflict");

    const fundPath = `/v1/realize/commissions/${encodeURIComponent(first.commissionId)}/fund`;
    const fundBody = {payer_wallet: payer, transaction_signature: mainnetSignature};
    const fundedResults = await Promise.all([signedRequest(fundPath, fundBody), signedRequest(fundPath, fundBody)]);
    expect(fundedResults.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(verifyFunding).toHaveBeenCalled();
    expect(requestFulfillment).toHaveBeenCalledOnce();
    const stored = await store.getRealizeCommission(first.commissionId);
    expect(stored).toMatchObject({funding_network_id: "solana:mainnet-beta", funding_signature: mainnetSignature, direct_funding: {custody_model: "backend_managed"}, nft_publication_consent: true, nft_publication_consent_at: expect.any(String), commission: {state: "GENERATING", payment_state: "captured"}});
    await expect(store.updateRealizeCommission({...stored!, nft_publication_consent: false}, stored!.updated_at)).rejects.toThrow("Realize NFT publication consent is immutable");
    await store.updateRealizeCommission({...stored!, nft_media_ids: ["vox:media:historic-output"]}, stored!.updated_at);
    const accountOrders = await signedGet("/v1/realize/commissions?limit=30");
    expect(accountOrders.statusCode, accountOrders.body).toBe(200);
    expect(accountOrders.json().items.find((item: any) => item.commission.commission_id === first.commissionId).nft_media_ids).toEqual(["vox:media:historic-output"]);
    const savedQuote = await store.getRealizeQuote(first.quote.quote_id);
    expect(savedQuote?.payout_recipients.reduce((total, payout) => total + BigInt(payout.amount_usdc_atomic), 0n).toString()).toBe(first.quote.total_amount_usdc_atomic);

    const secondAccepted = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(second.commissionId)}/accept-quote`, {quote_id: second.quote.quote_id, canonical_quote_hash: second.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
    expect(secondAccepted.statusCode).toBe(201);
    const reused = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(second.commissionId)}/fund`, {payer_wallet: payer, transaction_signature: mainnetSignature});
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("payment_replayed");
    expect(requestFulfillment).toHaveBeenCalledOnce();

    {
    // Delayed reporting/finalization must not hide a payment already received.
    const late = await addCommission("late");
    const lateAccepted = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(late.commissionId)}/accept-quote`, {quote_id: late.quote.quote_id, canonical_quote_hash: late.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
    expect(lateAccepted.statusCode, lateAccepted.body).toBe(201);
    const lateRecord = (await store.getRealizeCommission(late.commissionId))!;
    await store.updateRealizeCommission({...lateRecord, commission: {...lateRecord.commission, state: "EXPIRED", payment_state: "failed"}}, lateRecord.updated_at);
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date(Date.parse(late.quote.expires_at) + 60_000));
    try {
      const latePath = `/v1/realize/commissions/${encodeURIComponent(late.commissionId)}/fund`;
      const lateBody = {payer_wallet: payer, transaction_signature: mockReceiptSignature(6)};
      verifyFunding.mockResolvedValueOnce({finalized: false, matched: false});
      expect((await signedRequest(latePath, lateBody)).json().code).toBe("payment_pending");
      expect((await store.getRealizeCommission(late.commissionId))?.funding_signature).toBeUndefined();
      verifyFunding.mockResolvedValueOnce({finalized: true, matched: false});
      expect((await signedRequest(latePath, lateBody)).json().code).toBe("payment_unverified");
      verifyFunding.mockResolvedValueOnce({finalized: true, matched: true, block_time: Math.floor(Date.now() / 1000)});
      const recovered = await signedRequest(latePath, lateBody);
      expect(recovered.statusCode, recovered.body).toBe(202);
      expect(recovered.json()).toMatchObject({state: "MANUAL_REVIEW", payment_state: "captured"});
      expect(await store.getRealizeCommission(late.commissionId)).toMatchObject({funding_signature: lateBody.transaction_signature, resolution_reason: "late_payment_after_quote_expiry", payment_intent: {status: "captured"}});
      expect((await signedRequest(latePath, lateBody)).statusCode).toBe(200);
      expect(requestFulfillment).toHaveBeenCalledOnce();
      const lateStored = (await store.getRealizeCommission(late.commissionId))!;
      const lateApprovalPath = `/v1/internal/realize/commissions/${encodeURIComponent(late.commissionId)}/refund-approval`;
      const lateApproval = {payer_wallet: payer, funding_signature: lateBody.transaction_signature, payment_intent_id: lateStored.payment_intent!.payment_intent_id, accepted_quote_hash: late.quote.canonical_quote_hash, amount_usdc_atomic: late.quote.total_amount_usdc_atomic, reason: "Refund the verified expired payment; no provider request was created."};
      expect((await signedRequest(lateApprovalPath, lateApproval, {"x-vox-internal-token": "test-only-internal-token"})).statusCode).toBe(403);
      expect(settlement.requestRefund).not.toHaveBeenCalled();
      vi.mocked(settlement.requestRefund).mockResolvedValueOnce({refund_id: `vox:refund:${createHash("sha256").update(`vox:refund:${late.commissionId}:${late.quote.canonical_quote_hash}`).digest("hex")}`, status: "processing", updated_at: new Date().toISOString()});
      verifyFunding.mockRejectedValueOnce(new Error("temporary funding RPC outage"));
      const transientApproval = await signedRequest(lateApprovalPath, lateApproval, {"x-vox-internal-token": "test-only-internal-token"}, operator);
      expect(transientApproval.statusCode).toBe(500);
      expect((await store.getRealizeCommission(late.commissionId))?.resolution_reason).toBe("refund_preflight_failed");
      expect(settlement.requestRefund).not.toHaveBeenCalled();
      const lateApproved = await signedRequest(lateApprovalPath, lateApproval, {"x-vox-internal-token": "test-only-internal-token"}, operator);
      expect(lateApproved.statusCode, lateApproved.body).toBe(200);
      expect(lateApproved.json()).toMatchObject({commission: {state: "REFUND_PENDING", fulfillment_state: "not_started"}});
      expect(settlement.requestRefund).toHaveBeenCalledOnce();
      vi.mocked(settlement.requestRefund).mockClear();
    } finally { vi.useRealTimers(); }

    }

    const failedResult = {protocol_version: "realize/1", fulfillment_request_id: stored!.commission.fulfillment_request_id!, commission_id: first.commissionId, generation_provider_id: "provider:video:example", status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED", completed_at: new Date().toISOString()};
    const callbackTimestamp = Math.floor(Date.now() / 1_000).toString();
    const callbackBody = JSON.stringify(failedResult);
    const callbackSignature = `v1=${createHmac("sha256", "test-only-populi-webhook-secret").update(`${callbackTimestamp}.`).update(callbackBody).digest("hex")}`;
    const callback = await app.inject({method: "POST", url: "/v1/realize/webhooks/populi", payload: callbackBody, headers: {"content-type": "application/json", "x-realize-webhook-id": "mainnet-failure-1", "x-realize-webhook-timestamp": callbackTimestamp, "x-realize-webhook-signature": callbackSignature}});
    expect(callback.statusCode).toBe(200);
    expect((await store.getRealizeCommission(first.commissionId))?.commission.state).toBe("REFUND_PENDING");
    expect(settlement.requestRefund).not.toHaveBeenCalled();

    const previewPath = `/v1/internal/realize/commissions/${encodeURIComponent(first.commissionId)}/refund-preview`;
    const customerPreview = await signedGet(previewPath, human, {"x-vox-internal-token": "test-only-internal-token"});
    expect(customerPreview.statusCode).toBe(403);
    expect(customerPreview.json().code).toBe("realize_operator_forbidden");
    const preview = await signedGet(previewPath, operator, {"x-vox-internal-token": "test-only-internal-token"});
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      commission: {commission_id: first.commissionId, state: "REFUND_PENDING", payment_state: "refund_pending"},
      quote: {network_id: "solana:mainnet-beta", canonical_quote_hash: first.quote.canonical_quote_hash},
      payment: {payer_wallet: payer, funding_signature: mainnetSignature, amount_usdc_atomic: first.quote.total_amount_usdc_atomic},
      refund_approval_exists: false
    });

    const approvalPath = `/v1/internal/realize/commissions/${encodeURIComponent(first.commissionId)}/refund-approval`;
    const approval = {payer_wallet: payer, funding_signature: mainnetSignature, payment_intent_id: stored!.payment_intent!.payment_intent_id, accepted_quote_hash: first.quote.canonical_quote_hash, amount_usdc_atomic: first.quote.total_amount_usdc_atomic, reason: "The signed provider failure is confirmed; refund the exact original payment."};
    const customerApproval = await signedRequest(approvalPath, approval, {"x-vox-internal-token": "test-only-internal-token"});
    expect(customerApproval.statusCode).toBe(403);
    expect(customerApproval.json().code).toBe("realize_operator_forbidden");
    const approvalResponse = await signedRequest(approvalPath, approval, {"x-vox-internal-token": "test-only-internal-token"}, operator);
    expect(approvalResponse.statusCode, approvalResponse.body).toBe(200);
    expect(approvalResponse.json()).toMatchObject({commission: {state: "REFUND_PENDING"}, refund_response: {status: "processing"}});
    expect(settlement.requestRefund).toHaveBeenCalledOnce();
    const savedApproval = (await store.getRealizeCommission(first.commissionId))?.refund_approval;
    expect(savedApproval).toMatchObject({operator_human_id: operator.registration.human_id, payer_wallet: payer, funding_signature: mainnetSignature, payment_intent_id: approval.payment_intent_id, accepted_quote_hash: approval.accepted_quote_hash, amount_usdc_atomic: approval.amount_usdc_atomic});
    expect((await store.getRealizeCommission(first.commissionId))?.resolution_events?.some((event) => event.action === "refund_approved" && event.actor_type === "operator")).toBe(true);

    vi.mocked(settlement.getPaymentIntentResolution).mockRejectedValueOnce(new Error("settlement resolution timed out"));
    const reconciled = await signedGet(`/v1/realize/commissions/${encodeURIComponent(first.commissionId)}`);
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json()).toMatchObject({commission: {state: "MANUAL_REVIEW"}, resolution_outcome: "manual_review"});
    expect((await store.getRealizeCommission(first.commissionId))?.resolution_events?.some((event) => event.reason_code === "mainnet_refund_outcome_uncertain")).toBe(true);

    const late = await addCommission("late-payment");
    const boundary = await addCommission("expiry-boundary");
    const retry = await addCommission("lost-response-retry");
    for (const commission of [late, boundary, retry]) {
      const acceptedAt = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(commission.commissionId)}/accept-quote`, {quote_id: commission.quote.quote_id, canonical_quote_hash: commission.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
      expect(acceptedAt.statusCode, acceptedAt.body).toBe(201);
    }
    const previouslyExpired = await store.getRealizeCommission(late.commissionId);
    const expiredAt = new Date(Date.parse(previouslyExpired!.updated_at) + 1).toISOString();
    await store.updateRealizeCommission({...previouslyExpired!, commission: {...previouslyExpired!.commission, state: "EXPIRED", payment_state: "failed", updated_at: expiredAt}, updated_at: expiredAt}, previouslyExpired!.updated_at);
    latePaymentExpiresAt = Date.parse(late.quote.expires_at);
    boundaryPaymentExpiresAt = Date.parse(boundary.quote.expires_at);
    retryPaymentExpiresAt = Date.parse(retry.quote.expires_at);
    vi.setSystemTime(new Date(Math.max(latePaymentExpiresAt, boundaryPaymentExpiresAt, retryPaymentExpiresAt) + 2_000));

    const lateResponse = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(late.commissionId)}/fund`, {payer_wallet: payer, transaction_signature: lateSignature});
    expect(lateResponse.statusCode, lateResponse.body).toBe(202);
    const lateRecord = await store.getRealizeCommission(late.commissionId);
    expect(lateRecord).toMatchObject({funding_submission_signature: lateSignature, funding_signature: lateSignature, funding_timing_status: "after_quote_expiry", commission: {state: "MANUAL_REVIEW", payment_state: "captured"}, resolution_reason: "late_payment_after_quote_expiry"});
    expect(requestFulfillment).toHaveBeenCalledOnce();

    const boundaryResponse = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(boundary.commissionId)}/fund`, {payer_wallet: payer, transaction_signature: boundarySignature});
    expect(boundaryResponse.statusCode, boundaryResponse.body).toBe(202);
    expect(await store.getRealizeCommission(boundary.commissionId)).toMatchObject({funding_signature: boundarySignature, funding_timing_status: "ambiguous_at_expiry", commission: {state: "MANUAL_REVIEW", payment_state: "captured"}, resolution_reason: "funding_time_ambiguous_at_expiry"});
    expect(requestFulfillment).toHaveBeenCalledOnce();

    vi.mocked(settlement.getPaymentIntentResolution).mockImplementation(async (paymentIntentId) => ({payment_intent_id: paymentIntentId, kind: "none"}));
    const lateApproval = {
      payer_wallet: payer,
      funding_signature: lateSignature,
      payment_intent_id: lateRecord!.payment_intent!.payment_intent_id,
      accepted_quote_hash: late.quote.canonical_quote_hash,
      amount_usdc_atomic: late.quote.total_amount_usdc_atomic,
      reason: "The exact transfer arrived after quote expiry; refund the captured funds."
    };
    const approvedLateRefund = await signedRequest(`/v1/internal/realize/commissions/${encodeURIComponent(late.commissionId)}/refund-approval`, lateApproval, {"x-vox-internal-token": "test-only-internal-token"}, operator);
    expect(approvedLateRefund.statusCode, approvedLateRefund.body).toBe(200);
    expect(approvedLateRefund.json()).toMatchObject({commission: {state: "REFUND_PENDING"}, refund_response: {status: "processing"}});
    expect(settlement.requestRefund).toHaveBeenCalledTimes(2);

    const retryPath = `/v1/realize/commissions/${encodeURIComponent(retry.commissionId)}/fund`;
    const retryBody = {payer_wallet: payer, transaction_signature: retrySignature};
    const lostResponse = await signedRequest(retryPath, retryBody);
    expect(lostResponse.statusCode).toBe(500);
    expect(await store.getRealizeCommission(retry.commissionId)).toMatchObject({funding_submission_signature: retrySignature, commission: {state: "AWAITING_PAYMENT"}});
    const recoveredByRead = await signedGet(`/v1/realize/commissions/${encodeURIComponent(retry.commissionId)}`);
    expect(recoveredByRead.statusCode, recoveredByRead.body).toBe(200);
    expect(recoveredByRead.json().commission.state).toBe("GENERATING");
    expect(await store.getRealizeCommission(retry.commissionId)).toMatchObject({funding_signature: retrySignature, funding_timing_status: "within_quote_window", commission: {state: "GENERATING", payment_state: "captured"}});
    expect(requestFulfillment).toHaveBeenCalledTimes(2);
    const duplicateRetry = await signedRequest(retryPath, retryBody);
    expect(duplicateRetry.statusCode).toBe(200);
    expect(requestFulfillment).toHaveBeenCalledTimes(2);

    // A failed submitted transfer cannot leave the next successful receipt
    // trapped behind the server's durable pending-signature reservation.
    vi.setSystemTime(new Date(now));
    const failedRetry = await addCommission("finalized-failure-retry");
    const acceptedRetry = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(failedRetry.commissionId)}/accept-quote`, {quote_id: failedRetry.quote.quote_id, canonical_quote_hash: failedRetry.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
    expect(acceptedRetry.statusCode, acceptedRetry.body).toBe(201);
    const failedPath = `/v1/realize/commissions/${encodeURIComponent(failedRetry.commissionId)}/fund`;
    const failedSignature = mockReceiptSignature(7);
    const replacementSignature = mockReceiptSignature(8);
    verifyFunding.mockResolvedValueOnce({finalized: false, matched: false});
    const pendingFailure = await signedRequest(failedPath, {payer_wallet: payer, transaction_signature: failedSignature});
    expect(pendingFailure.statusCode, pendingFailure.body).toBe(409);
    expect(pendingFailure.json().code).toBe("payment_pending");
    for (const previousResult of [
      {finalized: false, matched: false},
      {finalized: true, matched: false},
      {finalized: true, matched: true, block_time: Math.floor(Date.now() / 1000)}
    ]) {
      verifyFunding.mockResolvedValueOnce(previousResult);
      const conflict = await signedRequest(failedPath, {payer_wallet: payer, transaction_signature: replacementSignature});
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(await store.getRealizeCommission(failedRetry.commissionId)).toMatchObject({funding_submission_signature: failedSignature});
    }
    verifyFunding.mockResolvedValueOnce({finalized: true, matched: false, execution_failed: true} as never);
    verifyFunding.mockResolvedValueOnce({finalized: true, matched: true, block_time: Math.floor(Date.now() / 1000)});
    const replacedFailure = await signedRequest(failedPath, {payer_wallet: payer, transaction_signature: replacementSignature});
    expect(replacedFailure.statusCode, replacedFailure.body).toBe(202);
    expect(await store.getRealizeCommission(failedRetry.commissionId)).toMatchObject({funding_submission_signature: replacementSignature, funding_signature: replacementSignature, commission: {state: "GENERATING", payment_state: "captured"}});
    expect(requestFulfillment).toHaveBeenCalledTimes(3);
  }, 15_000);
});

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
import {buildRealizeQuote, generationParametersHash, RealizeCreatorPayoutConfigurationV1Schema} from "../apps/api/src/realize-engine.js";
import {MainnetSplUsdcRealizePaymentRail, SOLANA_MAINNET_GENESIS_HASH, type MainnetSplUsdcFundingAuthorization, type RealizePaymentRail} from "../apps/api/src/realize-payment.js";
import type {PopuliRealizeClient} from "../apps/api/src/realize-engine.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";

const payer = Keypair.generate().publicKey.toBase58();
const treasuryOwner = Keypair.generate().publicKey.toBase58();
const treasuryTokenAccount = getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC_MINT), new PublicKey(treasuryOwner)).toBase58();
const mainnetSignature = "1".repeat(88);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("verifies a Mainnet payment intent before fulfillment, stores its payout allocation, and rejects transaction reuse", async () => {
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
    const verifyFunding = vi.fn(async () => ({finalized: true, matched: true}));
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
    let refundReserved = false;
    const refundId = `vox:refund:${createHash("sha256").update(`vox:refund:${first.commissionId}:${first.quote.canonical_quote_hash}`).digest("hex")}`;
    const settlement = {
      requestSettlement: vi.fn(), getSettlement: vi.fn(),
      getPaymentIntentResolution: vi.fn(async (paymentIntentId: string) => ({payment_intent_id: paymentIntentId, kind: refundReserved ? "refund" : "none", ...(refundReserved ? {record_id: refundId, state: "active", batch_statuses: ["prepared"]} : {})})),
      requestRefund: vi.fn(async () => { refundReserved = true; return {refund_id: refundId, status: "processing", updated_at: new Date().toISOString()}; }),
      getRefund: vi.fn(async () => ({refund_id: refundId, status: "processing", updated_at: new Date().toISOString()}))
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
    async function signedGet(path: string) {
      const issuedAt = new Date().toISOString();
      return app!.inject({method: "GET", url: path, headers: {
        "x-vox-realize-human-id": human.registration.human_id,
        "x-vox-realize-timestamp": issuedAt,
        "x-vox-realize-signature": signRealizeClientRequest({method: "GET", path, principal_id: human.registration.human_id, issued_at: issuedAt}, parseSecretKey(human.key_material.identitySecretKey))
      }});
    }
    const acceptPath = `/v1/realize/commissions/${encodeURIComponent(first.commissionId)}/accept-quote`;
    const notReviewed = await signedRequest(acceptPath, {quote_id: first.quote.quote_id, canonical_quote_hash: first.quote.canonical_quote_hash, payer_wallet: payer});
    expect(notReviewed.statusCode).toBe(400);
    expect(prepareFunding).not.toHaveBeenCalled();
    const accepted = await signedRequest(acceptPath, {quote_id: first.quote.quote_id, canonical_quote_hash: first.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json().funding).toMatchObject({mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", destination_token_account: treasuryTokenAccount, destination_owner: treasuryOwner});
    expect(accepted.json().funding).not.toHaveProperty("program_id");

    const fundPath = `/v1/realize/commissions/${encodeURIComponent(first.commissionId)}/fund`;
    const fundBody = {payer_wallet: payer, transaction_signature: mainnetSignature};
    const fundedResults = await Promise.all([signedRequest(fundPath, fundBody), signedRequest(fundPath, fundBody)]);
    expect(fundedResults.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(verifyFunding).toHaveBeenCalled();
    expect(requestFulfillment).toHaveBeenCalledOnce();
    const stored = await store.getRealizeCommission(first.commissionId);
    expect(stored).toMatchObject({funding_network_id: "solana:mainnet-beta", funding_signature: mainnetSignature, direct_funding: {custody_model: "backend_managed"}, commission: {state: "GENERATING", payment_state: "captured"}});
    const savedQuote = await store.getRealizeQuote(first.quote.quote_id);
    expect(savedQuote?.payout_recipients.reduce((total, payout) => total + BigInt(payout.amount_usdc_atomic), 0n).toString()).toBe(first.quote.total_amount_usdc_atomic);

    const secondAccepted = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(second.commissionId)}/accept-quote`, {quote_id: second.quote.quote_id, canonical_quote_hash: second.quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
    expect(secondAccepted.statusCode).toBe(201);
    const reused = await signedRequest(`/v1/realize/commissions/${encodeURIComponent(second.commissionId)}/fund`, {payer_wallet: payer, transaction_signature: mainnetSignature});
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("payment_replayed");
    expect(requestFulfillment).toHaveBeenCalledOnce();

    const failedResult = {protocol_version: "realize/1", fulfillment_request_id: stored!.commission.fulfillment_request_id!, commission_id: first.commissionId, generation_provider_id: "provider:video:example", status: "failed", outputs: [], error_code: "GENERATION_PROVIDER_FAILED", completed_at: new Date().toISOString()};
    const callbackTimestamp = Math.floor(Date.now() / 1_000).toString();
    const callbackBody = JSON.stringify(failedResult);
    const callbackSignature = `v1=${createHmac("sha256", "test-only-populi-webhook-secret").update(`${callbackTimestamp}.`).update(callbackBody).digest("hex")}`;
    const callback = await app.inject({method: "POST", url: "/v1/realize/webhooks/populi", payload: callbackBody, headers: {"content-type": "application/json", "x-realize-webhook-id": "mainnet-failure-1", "x-realize-webhook-timestamp": callbackTimestamp, "x-realize-webhook-signature": callbackSignature}});
    expect(callback.statusCode).toBe(200);
    expect((await store.getRealizeCommission(first.commissionId))?.commission.state).toBe("REFUND_PENDING");
    expect(settlement.requestRefund).not.toHaveBeenCalled();

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
  });
});

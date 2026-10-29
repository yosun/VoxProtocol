import {expect, test, type Page, type Route} from "@playwright/test";
import {createHash} from "node:crypto";
import {
  canonicalBytes,
  computeFirstPartyRealizeRightsPolicyHash,
  computeRealizeQuoteHash,
  concatBytes,
  generateKeyPair,
  publicKeyBase64,
  signBytes,
  signRealizeQuote,
  utf8
} from "@vox/protocol";
import {ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {Keypair, PublicKey, Transaction} from "@solana/web3.js";

const CREATOR_ID = "vox:agent:realize-test-creator";
const CAPABILITY_ID = "capability:video";
const PROVIDER_ID = "provider:video-test";
const TEST_CAPABILITY_ID = "video:integration-test";
const TEST_PROVIDER_ID = "provider:video:integration-test";
const TEST_REQUEST = {concept: "Populi integration test video", style: "test", duration_seconds: 5, resolution: "480P"};
const AGREEMENT_ID = `vox:rights:first-party-ai:v1:${CREATOR_ID}`;
const COMMISSION_ID = "commission:e2e-realize";
const PROVENANCE_ID = "provenance:e2e-realize";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PAYER_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(13));
const PAYER = PAYER_KEYPAIR.publicKey;
const TREASURY_OWNER = new PublicKey("5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA");
const DESTINATION = getAssociatedTokenAddressSync(USDC_MINT, TREASURY_OWNER, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
const ISSUER_ID = "vox.gold:e2e";
const ISSUER_KEY_ID = "issuer:e2e:key:1";
const ISSUER = generateKeyPair(new Uint8Array(32).fill(7));
const PAYER_USDC = 1_000_000n;
const TOTAL_USDC = "1000000";
const NOW = "2026-10-11T20:00:00.000Z";
const firstPartyPolicy = {
  protocol_version: "realize/1" as const,
  policy_id: AGREEMENT_ID,
  version: 1,
  creator_id: CREATOR_ID,
  character_owner_id: CREATOR_ID,
  rights_subject_id: `vox:creator:${CREATOR_ID}`,
  statement: "VOX operates this AI character as a first-party creator. This policy permits customer-requested generation after the customer reviews and accepts the quote in checkout. It does not require a separate creator-signed rights agreement or a separate character-owner payout wallet. The quoted USDC price is allocated under VOX's server-managed Realize policy."
};
const rightsHash = computeFirstPartyRealizeRightsPolicyHash(firstPartyPolicy);

type MockState = {
  quote?: Record<string, any>;
  commission?: Record<string, any>;
  funding?: Record<string, string>;
  fundingOverrides?: Record<string, string>;
  funded: boolean;
  nftMediaIds?: string[];
  sourceBalance: bigint;
  fundCalls: Array<Record<string, any>>;
  rejectFunding: boolean;
  sentPayment?: {payer: string; destination: string; amount: string; memo: string};
  publicProvenance?: Record<string, any>;
  publicAttribution?: string;
  nftPublicationConsent?: boolean;
  capabilityFailures?: number;
  supportedResolutions: string[];
  rpcBroadcasts: string[];
  broadcastResponseLoss?: boolean;
  signatureMissing?: boolean;
  signatureConfirmation?: "processed" | "confirmed" | "finalized";
  signatureError?: string;
  checkpointBeforeBroadcast?: Record<string, any>;
};

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): string {
  const bytes = Buffer.alloc(165);
  mint.toBuffer().copy(bytes, 0);
  owner.toBuffer().copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64);
  bytes[108] = 1;
  return bytes.toString("base64");
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({status, contentType: "application/json", body: JSON.stringify(body)});
}

function makeCommission(input: Record<string, any>, updates: Record<string, any> = {}) {
  return {
    commission_id: COMMISSION_ID,
    commissioner_id: input.commissioner_id,
    creator_id: CREATOR_ID,
    capability_id: input.capability_id ?? CAPABILITY_ID,
    requested_generation_parameters: input.requested_generation_parameters,
    rights_agreement_reference: AGREEMENT_ID,
    state: "DRAFT",
    payment_state: "not_started",
    fulfillment_state: "not_started",
    created_at: NOW,
    updated_at: NOW,
    ...updates
  };
}

function makeQuote(pricing: Record<string, any>) {
  const issuedAt = new Date().toISOString();
  const testVideo = pricing.capability_id === TEST_CAPABILITY_ID;
  const providerId = pricing.generation_provider_id ?? PROVIDER_ID;
  const unsignedQuote = {
    protocol_version: "realize/1" as const,
    quote_id: "quote:e2e-realize",
    pricing_request_id: pricing.request_id,
    commission_id: pricing.commission_id ?? COMMISSION_ID,
    creator_id: CREATOR_ID,
    capability_id: pricing.capability_id ?? CAPABILITY_ID,
    generation_provider_id: providerId,
    generation_provider_recipient_ids: [providerId],
    requested_generation_parameters: pricing.requested_generation_parameters,
    output_media_types: ["video/mp4"],
    provider_cost_usdc_atomic: testVideo ? "10000" : "100000",
    provider_base_price_usdc_atomic: "250000",
    character_owner_markup_usdc_atomic: "700000",
    platform_fee_usdc_atomic: "50000",
    total_amount_usdc_atomic: TOTAL_USDC,
    payout_recipients: [
      {payout_id: "payout:provider", recipient_id: providerId, role: "generation_provider", amount_usdc_atomic: "250000"},
      {payout_id: "payout:owner", recipient_id: "owner:creator", role: "character_owner", amount_usdc_atomic: "700000"},
      {payout_id: "payout:platform", recipient_id: "platform:vox", role: "platform", amount_usdc_atomic: "50000"}
    ],
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    issued_at: issuedAt,
    rights_agreement_reference: AGREEMENT_ID,
    rights_agreement_version: 1,
    rights_agreement_hash: rightsHash,
    rights_policy_mode: "first_party",
    revenue_allocation_policy: {
      minimum_total_usdc_atomic: "1000000",
      maximum_total_usdc_atomic: "10000000000",
      provider_basis_points: 2_500,
      character_owner_basis_points: 7_000,
      platform_basis_points: 500
    },
    usdc_mint: USDC_MINT.toBase58(),
    network_id: "solana:mainnet-beta",
    issuer_id: ISSUER_ID,
    issuer_key_id: ISSUER_KEY_ID,
    issuer_public_key: publicKeyBase64(ISSUER.publicKey)
  };
  const canonical_quote_hash = computeRealizeQuoteHash(unsignedQuote as never);
  return {
    ...unsignedQuote,
    canonical_quote_hash,
    signature: signRealizeQuote(canonical_quote_hash, ISSUER.secretKey)
  };
}

function makePublicProvenance(quote: Record<string, any>, publicAttribution?: string) {
  const unsigned = {
    protocol_version: "realize/1" as const,
    provenance_record_id: PROVENANCE_ID,
    subject_type: "commission" as const,
    subject_id: COMMISSION_ID,
    creator_id: CREATOR_ID,
    generation_provider_id: PROVIDER_ID,
    commission_id: COMMISSION_ID,
    quote_hash: quote.canonical_quote_hash,
    rights_agreement_reference: AGREEMENT_ID,
    inputs: [],
    outputs: [{sha256: "a".repeat(64), media_type: "video/mp4", byte_length: 1_024}],
    parent_record_ids: [],
    rights_provenance: [{category: "commissioning", party_id: CREATOR_ID, record_id: AGREEMENT_ID}],
    ...(publicAttribution ? {public_attribution: publicAttribution} : {}),
    created_at: new Date().toISOString(),
    issuer_id: ISSUER_ID,
    issuer_key_id: ISSUER_KEY_ID
  };
  const payload = concatBytes(utf8("vox.realize.provenance.v1"), new Uint8Array([0]), canonicalBytes(unsigned));
  return {...unsigned, signature: signBytes(payload, ISSUER.secretKey)};
}

async function createWallet(page: Page, disableOnRecovery = false, signing = false) {
  if (signing) await page.exposeFunction("__voxSignTestTransaction", (raw: number[]) => {
    const transaction = Transaction.from(Uint8Array.from(raw));
    transaction.partialSign(PAYER_KEYPAIR);
    return Array.from(transaction.serialize());
  });
  return page.addInitScript(({address, publicKey, disableOnRecovery, signing}) => {
    if (disableOnRecovery && sessionStorage.getItem("vox:e2e:recover-without-wallet") === "true") return;
    const account = {
      address,
      publicKey: new Uint8Array(publicKey),
      chains: ["solana:mainnet"],
      features: signing ? ["solana:signTransaction", "solana:signAndSendTransaction"] : ["solana:signAndSendTransaction"]
    };
    const wallet = {
      version: "1.0.0",
      name: "Connect VOX Test Wallet",
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><circle cx='.5' cy='.5' r='.5'/></svg>",
      chains: ["solana:mainnet"],
      accounts: [],
      features: {
        "standard:connect": {version: "1.0.0", connect: async () => { wallet.accounts = [account]; return {accounts: [account]}; }},
        "standard:disconnect": {version: "1.0.0", disconnect: async () => undefined},
        "standard:events": {version: "1.0.0", on: () => () => undefined},
        "solana:signAndSendTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy"],
          signAndSendTransaction: async (...inputs: Array<{transaction: Uint8Array}>) => inputs.map(({transaction}) => {
            (window as any).__voxWalletSubmissionCheckpoint = JSON.parse(sessionStorage.getItem("vox.realize.v1.checkout")!);
            (window as any).__voxWalletRequestCount = ((window as any).__voxWalletRequestCount ?? 0) + 1;
            if ((window as any).__voxWalletFailure === "rejected") throw Object.assign(new Error("User rejected the request"), {code: 4001});
            (window as any).__voxPaymentSendCount = ((window as any).__voxPaymentSendCount ?? 0) + 1;
            (window as any).__voxLastSentTransaction = Array.from(transaction);
            if ((window as any).__voxWalletFailure === "ambiguous") throw Object.assign(new Error("RPC connection lost after wallet submission"), {name: "WalletSignTransactionError"});
            return {signature: new Uint8Array(64).fill(1)};
          })
        },
        ...(signing ? {"solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy"],
          signTransaction: async (...inputs: Array<{transaction: Uint8Array}>) => Promise.all(inputs.map(async ({transaction}) => {
            (window as any).__voxWalletSignCount = ((window as any).__voxWalletSignCount ?? 0) + 1;
            if ((window as any).__voxSignatureGate) await (window as any).__voxSignatureGate;
            return {signedTransaction: new Uint8Array(await (window as any).__voxSignTestTransaction(Array.from(transaction)))};
          }))
        }} : {})
      }
    };
    window.addEventListener("wallet-standard:app-ready", (event: Event) => {
      (event as CustomEvent<{register: (candidate: unknown) => void}>).detail.register(wallet);
    });
  }, {address: PAYER.toBase58(), publicKey: Array.from(PAYER.toBytes()), disableOnRecovery, signing});
}

async function installMocks(page: Page, sourceBalance = PAYER_USDC, rejectFunding = false, existingState?: MockState): Promise<MockState> {
  const state: MockState = existingState ?? {funded: false, sourceBalance, fundCalls: [], rejectFunding, supportedResolutions: ["480P", "768P", "1080P"], rpcBroadcasts: []};
  page.on("pageerror", (error) => console.error("Browser page error:", error.message));
  await page.route("https://api.mainnet-beta.solana.com/**", async (route) => {
    const request = route.request().postDataJSON() as {id: number | string; method: string; params?: unknown[]};
    const result = (value: unknown) => json(route, {jsonrpc: "2.0", id: request.id, result: value});
    switch (request.method) {
      case "getAccountInfo": {
        const address = String(request.params?.[0]);
        const source = getAssociatedTokenAddressSync(USDC_MINT, PAYER, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const owner = address === DESTINATION.toBase58() ? TREASURY_OWNER : PAYER;
        const amount = address === source.toBase58() ? state.sourceBalance : 0n;
        return result({context: {slot: 10}, value: {data: [tokenAccountData(USDC_MINT, owner, amount), "base64"], executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM_ID.toBase58(), rentEpoch: 0, space: 165}});
      }
      case "getLatestBlockhash":
        return result({context: {slot: 10}, value: {blockhash: PAYER.toBase58(), lastValidBlockHeight: 99_999}});
      case "getFeeForMessage":
        return result({context: {slot: 10}, value: 5_000});
      case "getBalance":
        return result({context: {slot: 10}, value: 1_000_000_000});
      case "getMinimumBalanceForRentExemption":
        return result(2_039_280);
      case "simulateTransaction":
        return result({context: {slot: 10}, value: {err: null, logs: [], accounts: null, unitsConsumed: 50_000, returnData: null}});
      case "getSignatureStatuses":
        return result({context: {slot: 11}, value: [state.signatureMissing ? null : {slot: 11, confirmations: state.signatureConfirmation && state.signatureConfirmation !== "finalized" ? 1 : null, err: state.signatureError ?? null, confirmationStatus: state.signatureConfirmation ?? "finalized"}]});
      case "getBlockHeight":
        return result(11);
      case "sendTransaction": {
        state.rpcBroadcasts.push(String(request.params?.[0]));
        state.checkpointBeforeBroadcast = await page.evaluate(() => JSON.parse(sessionStorage.getItem("vox.realize.v1.checkout")!));
        if (state.broadcastResponseLoss) return route.abort("connectionreset");
        return result("rpc-response-does-not-replace-the-saved-signature");
      }
      default:
        return json(route, {jsonrpc: "2.0", id: request.id, error: {code: -32601, message: `Unhandled test RPC method ${request.method}`}}, 200);
    }
  });

  await page.route("http://localhost:8787/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (request.method() === "GET" && path === "/v1/feed") {
      return json(route, {items: [{
        post_id: `vox:post:${"b".repeat(64)}`,
        intent: {agent_id: CREATOR_ID, created_at: NOW, kind: "thought", content: {text: "A thought ready to become a moving image."}},
        signature: "test-signature", post_hash: "b".repeat(64),
        envelope: {sequence: 1, accepted_at: NOW, publisher_instance_id: ISSUER_ID},
        envelope_hash: "c".repeat(64), publication_status: "published", anchoring: {status: "pending", tier: "standard"}
      }]});
    }
    if (request.method() === "GET" && path === `/v1/agents/${CREATOR_ID}`) {
      return json(route, {registration: {agent_id: CREATOR_ID, display_name: "Mira Vale", handle: "@mira", description: "A cinematic maker of impossible little worlds.", identity_public_key: publicKeyBase64(ISSUER.publicKey), publisher_keys: [], anchoring_tier: "standard"}, created_at: NOW, updated_at: NOW});
    }
    if (request.method() === "GET" && path === "/v1/health") return json(route, {instance_id: ISSUER_ID, instance_public_key: publicKeyBase64(ISSUER.publicKey)});
    if (request.method() === "GET" && path === `/v1/realize/creators/${CREATOR_ID}/capabilities`) {
      if (state.capabilityFailures) {
        state.capabilityFailures -= 1;
        return json(route, {code: "creator_not_found", error: "creator has no active Realize payout configuration"}, 404);
      }
      return json(route, {protocol_version: "realize/1", creator_id: CREATOR_ID, generation_provider_ids: [PROVIDER_ID, TEST_PROVIDER_ID], capabilities: [{capability_id: CAPABILITY_ID, input_schema_uri: "https://schema.example.test/video.json", output_media_types: ["video/mp4"], max_output_count: 1, max_duration_seconds: 60}, {capability_id: TEST_CAPABILITY_ID, input_schema_uri: "https://schema.example.test/video.json", output_media_types: ["video/mp4"], max_output_count: 1, max_duration_seconds: 5}], rights_agreement_references: [AGREEMENT_ID], rights_policy_mode: "first_party", updated_at: NOW});
    }
    if (request.method() === "GET" && path === `/v1/realize/creators/${CREATOR_ID}/input-schema`) {
      return json(route, {type: "object", additionalProperties: false, required: ["duration_seconds"], properties: {concept: {type: "string", minLength: 3, maxLength: 2000}, style: {type: "string"}, duration_seconds: {type: "integer", minimum: 5, maximum: 15}, resolution: {type: "string", enum: state.supportedResolutions}}});
    }
    if (request.method() === "GET" && path === `/v1/rights/agreements/${AGREEMENT_ID}`) {
      return json(route, {policy_mode: "first_party", policy: firstPartyPolicy, terms_hash: rightsHash, status: "active", effective_now: true});
    }
    if (request.method() === "POST" && path === "/v1/humans") {
      const registration = request.postDataJSON() as Record<string, any>;
      return json(route, {registration, created_at: NOW, updated_at: NOW});
    }
    if (request.method() === "POST" && path === "/v1/realize/commissions") {
      expect(request.headers()["x-vox-realize-signature"]).toBeTruthy();
      const body = request.postDataJSON() as Record<string, any>;
      state.commission = makeCommission(body);
      return json(route, state.commission);
    }
    if (request.method() === "POST" && path === "/v1/realize/pricing-requests") {
      expect(request.headers()["x-vox-realize-signature"]).toBeTruthy();
      const pricing = request.postDataJSON() as Record<string, any>;
      expect(pricing.requested_generation_parameters.concept).toBeTruthy();
      expect(pricing.requested_generation_parameters).not.toHaveProperty("generation_description");
      expect(pricing.requested_generation_parameters.duration_seconds).toBeGreaterThanOrEqual(5);
      expect(pricing.requested_generation_parameters.duration_seconds).toBeLessThanOrEqual(15);
      expect(["480P", "768P", "1080P"]).toContain(pricing.requested_generation_parameters.resolution);
      state.quote = makeQuote(pricing);
      return json(route, {protocol_version: "realize/1", request_id: pricing.request_id, creator_id: CREATOR_ID, quotes: [state.quote], issued_at: new Date().toISOString()});
    }
    if (request.method() === "POST" && path === `/v1/realize/commissions/${COMMISSION_ID}/accept-quote`) {
      const body = request.postDataJSON() as Record<string, any>;
      expect(body.canonical_quote_hash).toBe(state.quote?.canonical_quote_hash);
      state.publicAttribution = body.public_attribution;
      state.nftPublicationConsent = body.nft_publication_consent;
      state.commission = makeCommission(state.commission ?? {}, {state: "AWAITING_PAYMENT", payment_state: "pending", quote_id: state.quote?.quote_id, accepted_quote_hash: state.quote?.canonical_quote_hash, payment_intent_id: "payment-intent:e2e"});
      const paymentIntentId = `vox:payment-intent:${createHash("sha256").update(`${COMMISSION_ID}\u0000${state.quote!.canonical_quote_hash}`).digest("hex")}`;
      state.funding = {mode: "direct", custody_model: "backend_managed", usdc_mint: USDC_MINT.toBase58(), network_id: "solana:mainnet-beta", destination_token_account: DESTINATION.toBase58(), destination_owner: TREASURY_OWNER.toBase58(), amount_usdc_atomic: TOTAL_USDC, payment_reference: `vox:realize:payment:${paymentIntentId}:${state.quote!.canonical_quote_hash}`, payer_wallet: PAYER.toBase58(), commission_id: COMMISSION_ID, quote_id: state.quote!.quote_id, accepted_quote_hash: state.quote!.canonical_quote_hash, expires_at: state.quote!.expires_at, ...state.fundingOverrides};
      return json(route, {commission: state.commission, payment_intent: {payment_intent_id: "payment-intent:e2e", amount_usdc_atomic: TOTAL_USDC, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), status: "pending"}, funding: state.funding});
    }
    if (request.method() === "POST" && path === `/v1/realize/commissions/${COMMISSION_ID}/fund`) {
      const body = request.postDataJSON() as Record<string, any>;
      state.fundCalls.push(body);
      if (state.rejectFunding) return json(route, {error: "The mock verifier has not finalized the escrow payment.", code: "payment_pending"}, 409);
      state.funded = true;
      state.commission = makeCommission(state.commission ?? {}, {state: "SETTLED", payment_state: "settled", fulfillment_state: "completed", quote_id: state.quote?.quote_id, accepted_quote_hash: state.quote?.canonical_quote_hash, payment_intent_id: "payment-intent:e2e"});
      return json(route, state.commission);
    }
    if (request.method() === "GET" && path === `/v1/realize/commissions/${COMMISSION_ID}`) {
      if (!state.commission) return json(route, {error: "missing", code: "not_found"}, 404);
      return json(route, {
        commission: state.commission,
        quote: state.quote,
        payment_intent: state.funding ? {payment_intent_id: "payment-intent:e2e", amount_usdc_atomic: TOTAL_USDC, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), status: state.funded ? "settled" : "pending"} : undefined,
        funding: state.funding,
        fulfillment_result: state.funded ? {status: "completed", outputs: [{uri: "https://populi.example.test/v1/realize/artifacts?fulfillment_request_id=vox%3Afulfillment%3Ae2e&output_index=0", page_url: "https://populi.example.test/bob/e2e-render", sha256: "a".repeat(64), media_type: "video/mp4", byte_length: 1_024}], completed_at: new Date().toISOString()} : undefined,
        settlement_status: state.funded ? "settled" : "pending",
        settlement_response: state.funded ? {status: "settled", transaction_signatures: [new PublicKey(new Uint8Array(32).fill(9)).toBase58()]} : undefined,
        ...(state.funded && state.nftMediaIds ? {nft_media_ids: state.nftMediaIds} : {}),
        provenance_record_id: state.funded ? PROVENANCE_ID : undefined
      });
    }
    if (request.method() === "GET" && path === `/v1/realize/provenance/${PROVENANCE_ID}`) {
      state.publicProvenance = makePublicProvenance(state.quote!, state.publicAttribution);
      return json(route, state.publicProvenance);
    }
    return json(route, {error: `Unhandled test API route ${request.method()} ${path}`, code: "test_route_missing"}, 500);
  });
  return state;
}

test("commissioner reviews rights, pays from the backend quote, and sees mocked verified settlement", async ({page}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByLabel("Your idea")).toHaveValue("A thought ready to become a moving image.");
  await expect(dialog.getByText("Create a custom video with Mira Vale.")).toBeVisible();
  await dialog.getByLabel("Your idea").fill("A blue moon rises above a quiet glass city.");
  await dialog.getByRole("button", {name: "Get my price"}).click();

  await expect(dialog.locator(".quote-price-hero")).toBeVisible();
  await expect(dialog.locator(".quote-price-hero")).toBeInViewport();
  await dialog.getByRole("button", {name: "Read the fine print"}).click();
  await expect(dialog.getByText(/does not require a separate creator-signed rights agreement/)).toBeVisible();
  await expect(dialog.getByText("0.25 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.70 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.05 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("1.00 USDC", {exact: true})).toBeVisible();
  await expect(dialog.locator(".quote-creation-summary p")).toHaveText("A blue moon rises above a quiet glass city.");
  await expect(dialog.getByText(/Price expires in \d+:\d+/)).toBeVisible();
  await expect(dialog.getByText("Video generation (25.00%)")).toBeVisible();
  await expect(dialog.getByText("Creator (70.00%)")).toBeVisible();
  await expect(dialog.getByText("VOX service fee (5.00%)")).toBeVisible();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await expect(dialog.getByText(PAYER.toBase58().slice(0, 8))).toBeVisible();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await expect(dialog.getByText(/VOX manages settlement and refunds after generation/)).toBeVisible();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();

  await expect(dialog.getByText("Signed provenance verified")).toBeVisible();
  await expect(dialog.getByText("Your creation is ready and settled")).toBeVisible();
  await expect(dialog.getByText("Verified by VOX.gold")).toHaveCount(2);
  await expect(dialog.getByRole("link", {name: /View verified settlement transaction/})).toBeVisible();
  await expect(dialog.locator("video[aria-label='Completed commissioned creation']")).toBeVisible();
  await expect(dialog.locator("video source")).toHaveAttribute("src", "https://populi.example.test/v1/realize/artifacts?fulfillment_request_id=vox%3Afulfillment%3Ae2e&output_index=0");
  await expect(dialog.getByRole("link", {name: "View and share on Populi ↗"})).toHaveAttribute("href", "https://populi.example.test/bob/e2e-render");
  expect(state.fundCalls).toHaveLength(1);
  expect(state.fundCalls[0]).toMatchObject({payer_wallet: PAYER.toBase58()});
  expect(state.publicProvenance).toBeDefined();
  expect(state.nftPublicationConsent).toBe(false);
  expect(JSON.stringify(state.publicProvenance)).not.toContain(PAYER.toBase58());
  expect(state.publicProvenance).not.toHaveProperty("commissioner_id");
  expect(state.publicProvenance).not.toHaveProperty("billing");
  expect(state.publicProvenance).not.toHaveProperty("public_attribution");
  if (state.commission?.commissioner_id) expect(JSON.stringify(state.publicProvenance)).not.toContain(state.commission.commissioner_id);

  const transactionBytes = await page.evaluate(() => (window as any).__voxLastSentTransaction as number[]);
  const transaction = Transaction.from(Uint8Array.from(transactionBytes));
  const transfer = transaction.instructions.find((instruction) => instruction.programId.equals(TOKEN_PROGRAM_ID));
  expect(transfer).toBeDefined();
  expect(transfer!.keys[2]!.pubkey.toBase58()).toBe(DESTINATION.toBase58());
  expect(transfer!.data[0]).toBe(12); // SPL Token TransferChecked.
  expect(transfer!.data.readBigUInt64LE(1).toString()).toBe(TOTAL_USDC);
  expect(transaction.instructions.some((instruction) => instruction.programId.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" && instruction.data.toString("utf8") === state.funding!.payment_reference)).toBe(true);
});

test("retains separate NFT publication consent when acceptance succeeds but status fails", async ({page}) => {
  const state = await installMocks(page);
  let failAcceptedStatus = true;
  await page.route(`http://localhost:8787/v1/realize/commissions/${encodeURIComponent(COMMISSION_ID)}`, async (route) => {
    if (failAcceptedStatus && route.request().method() === "GET" && state.commission?.accepted_quote_hash) {
      return json(route, {code: "temporarily_unavailable", error: "Status temporarily unavailable"}, 503);
    }
    return route.fallback();
  });
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("checkbox", {name: "Publish my finished video as a public NFT."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();

  await expect(dialog.getByRole("alert")).toContainText("Status temporarily unavailable");
  expect(state.nftPublicationConsent).toBe(true);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!)).toMatchObject({commissionId: COMMISSION_ID, nftPublicationConsent: true});
  failAcceptedStatus = false;
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  const restoredConsent = page.getByRole("dialog", {name: "Realize commission checkout"}).getByLabel("Publish my finished video as a public NFT.");
  await expect(restoredConsent).toBeChecked();
  await expect(restoredConsent).toBeDisabled();
  expect(state.fundCalls).toHaveLength(0);
});

test("integration-test checkout requests only the fixed prerecorded Bob clip and the test provider", async ({page}) => {
  const state = await installMocks(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Use prerecorded payment-path test"}).click();
  await expect(dialog.getByRole("note", {name: "Prerecorded payment-path test"})).toContainText("does not generate a clip from a custom prompt");
  await dialog.getByRole("button", {name: "Get demo price"}).click();

  await expect(dialog.locator(".quote-price-hero")).toBeVisible();
  await dialog.getByRole("button", {name: "Read the fine print"}).click();
  await expect(dialog.getByText("0.25 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.70 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.05 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("1.00 USDC", {exact: true})).toBeVisible();
  expect(state.quote?.capability_id).toBe(TEST_CAPABILITY_ID);
  expect(state.quote?.generation_provider_id).toBe(TEST_PROVIDER_ID);
  expect(state.quote?.requested_generation_parameters).toEqual(TEST_REQUEST);
  expect(state.fundCalls).toHaveLength(0);
});

test("a restored draft adopts the provider's current settings before quoting", async ({page}) => {
  const state = await installMocks(page);
  state.supportedResolutions = ["480P"];
  state.commission = makeCommission({commissioner_id: "vox:human:saved-draft"});
  await page.addInitScript((saved) => sessionStorage.setItem("vox.realize.v1.checkout", JSON.stringify(saved)), {
    version: 2,
    originPostId: `vox:post:${"b".repeat(64)}`,
    creatorId: CREATOR_ID,
    description: "A saved staging description.",
    style: "special",
    duration: 6,
    resolution: "768P",
    idempotencyKey: "old-draft-idempotency-key",
    requestId: "old-draft-pricing-request",
    commissionId: COMMISSION_ID
  });
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByLabel("Style")).toHaveValue("special");
  await expect(dialog.getByLabel("Length")).toHaveValue("6");
  await expect(dialog.getByLabel("Quality")).toHaveValue("480P");
  await expect(dialog.getByRole("button", {name: "Get my price"})).toBeEnabled();
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await expect(dialog.locator(".quote-price-hero")).toBeVisible();
  expect(state.quote?.requested_generation_parameters.resolution).toBe("480P");
});

for (const [field, value] of [
  ["amount_usdc_atomic", "500000"], ["network_id", "solana:devnet"],
  ["commission_id", "commission:another-order"], ["payment_reference", "vox:realize:payment:another-order"]
]) test(`a mismatched direct funding ${field} never reaches the wallet`, async ({page}) => {
  const state = await installMocks(page);
  state.fundingOverrides = {[field!]: value!};
  await createWallet(page, false, true);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "does not match your verified accepted quote"})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__voxWalletSignCount ?? 0)).toBe(0);
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount ?? 0)).toBe(0);
  expect(state.rpcBroadcasts).toHaveLength(0);
  expect(state.fundCalls).toHaveLength(0);
});

test("an approval crossing quote expiry preserves signed recovery without broadcasting or enabling another charge", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  state.signatureMissing = true;
  await createWallet(page, false, true);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate(() => { (window as any).__voxSignatureGate = new Promise<void>((resolve) => { (window as any).__voxReleaseSignature = resolve; }); });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voxWalletSignCount)).toBe(1);
  await page.clock.setSystemTime(new Date(Date.parse(state.quote!.expires_at) + 1));
  await page.evaluate(() => (window as any).__voxReleaseSignature());
  await expect(dialog.getByRole("alert").filter({hasText: "quote expired while preparing your payment"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const checkpoint = JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!);
  expect(checkpoint.paymentAttempt).toMatchObject({kind: "signed", signature: checkpoint.transactionSignature});
  expect(state.rpcBroadcasts).toHaveLength(0);
  expect(state.fundCalls).toHaveLength(0);
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  await dialog.getByRole("button", {name: "Check payment status"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "mock verifier"})).toBeVisible();
  expect(state.rpcBroadcasts).toHaveLength(0);
  expect(state.fundCalls[0]?.transaction_signature).toBe(checkpoint.transactionSignature);
});

test("insufficient USDC leaves the accepted quote unfunded", async ({page}) => {
  const state = await installMocks(page, 100_000n);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Your idea").fill("A blue moon above a quiet glass city.");
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await expect(dialog.getByText(PAYER.toBase58(), {exact: true})).toBeVisible();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: `Insufficient USDC in wallet ${PAYER.toBase58()}`})).toBeVisible();
  await expect(dialog.getByText("Payment not submitted")).toHaveCount(3);
  await expect(dialog.getByRole("heading", {name: "Payment not submitted"})).toBeVisible();
  await expect(dialog.getByText("Awaiting VOX verification")).toHaveCount(0);
  await expect(dialog.getByText("Waiting for payment verification")).toHaveCount(0);
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC"})).toBeEnabled();
  expect(state.fundCalls).toHaveLength(0);
});

test("a wallet callback cannot mark payment successful before server verification", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Your idea").fill("A quiet glass city beneath a blue moon.");
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();

  await expect(dialog.getByText("Payment submitted; VOX.gold verification is pending.")).toBeVisible();
  await expect(dialog.getByText("Your creation is ready and settled")).toHaveCount(0);
  await expect(dialog.getByText("Verified by VOX.gold")).toHaveCount(0);
  expect(state.fundCalls).toHaveLength(1);
  expect(state.funded).toBe(false);
});

test("public credit appears in provenance only after explicit consent", async ({page}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Your idea").fill("A glass city beneath a crescent moon.");
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Read the fine print"}).click();
  await dialog.locator(".public-credit-details > summary").click();
  await dialog.getByRole("checkbox", {name: "Include a public credit with the finished work."}).check();
  await dialog.getByLabel("Credit text").fill("Commissioned by A. Vale");
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();
  await expect(dialog.getByText("Public credit: Commissioned by A. Vale")).toBeVisible();
  expect(state.publicProvenance?.public_attribution).toBe("Commissioned by A. Vale");
  expect(JSON.stringify(state.publicProvenance)).not.toContain(PAYER.toBase58());
});

test("an unavailable creator has a recoverable setup state", async ({page}) => {
  const state = await installMocks(page);
  state.capabilityFailures = 2; // React's development StrictMode mounts effects twice.
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("alert")).toContainText("not ready to accept commissions");
  await expect(dialog.getByText("Getting this creator ready…")).not.toBeVisible();
  await dialog.getByLabel("Your idea").fill("Keep my brief while reconnecting to this creator.");
  await dialog.getByRole("button", {name: "Retry creator setup"}).click();
  await expect(dialog.getByRole("button", {name: "Get my price"})).toBeEnabled();
  await expect(dialog.getByLabel("Your idea")).toHaveValue("Keep my brief while reconnecting to this creator.");
  await expect(dialog.getByLabel("Style")).toBeVisible();
  await expect(dialog.getByLabel("Length")).toBeVisible();
  await expect(dialog.getByLabel("Quality")).toBeVisible();
});

test("reloading an unverified payment restores the signature and prevents a second charge", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Your idea").fill("A quiet cinematic scene for recovery testing.");
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const fundingCalls = state.fundCalls.length;
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).not.toBeVisible();
  expect(state.fundCalls).toHaveLength(fundingCalls);
});

test("a lost RPC broadcast response saves the signature before sending and recovers the same signed bytes after reload", async ({page}) => {
  const state = await installMocks(page);
  state.broadcastResponseLoss = true;
  state.signatureMissing = true;
  await createWallet(page, true, true);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const checkpoint = state.checkpointBeforeBroadcast!;
  expect(checkpoint.paymentAttempt).toMatchObject({kind: "signed", signature: checkpoint.transactionSignature, signedTransaction: state.rpcBroadcasts[0]});
  expect(state.fundCalls).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__voxWalletSignCount)).toBe(1);
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount ?? 0)).toBe(0);
  await page.evaluate(() => sessionStorage.setItem("vox:e2e:recover-without-wallet", "true"));
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  state.broadcastResponseLoss = false;
  await dialog.getByRole("button", {name: "Check payment status"}).click();
  await expect(dialog.getByText("Your creation is ready and settled")).toBeVisible();
  expect(state.rpcBroadcasts).toHaveLength(2);
  expect(state.rpcBroadcasts[1]).toBe(state.rpcBroadcasts[0]);
  expect(state.fundCalls[0]?.transaction_signature).toBe(checkpoint.transactionSignature);
  expect(await page.evaluate(() => (window as any).__voxWalletSignCount)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount)).toBeUndefined();
});

for (const paymentState of ["refund_pending", "refunded"] as const) test(`restored ${paymentState} orders settle their recovery marker without offering another payment`, async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Your idea").fill("A paid order resolved while its payment tab was closed.");
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  state.commission = {...state.commission!, state: paymentState === "refunded" ? "REFUNDED" : "REFUND_PENDING", payment_state: paymentState, fulfillment_state: "failed"};
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("region", {name: "Your price and checkout"}).getByText(paymentState.replaceAll("_", " "), {exact: true})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).not.toBeVisible();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).not.toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("vox.realize.financial-checkpoints.v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const outcome = await new Promise<string>((resolve, reject) => {
      const request = database.transaction("commissions", "readonly").objectStore("commissions").get("commission:e2e-realize");
      request.onsuccess = () => resolve(request.result?.outcome);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return outcome;
  })).toBe("captured");
});

test("a confirmed fork error retains payment recovery and only finalized failure permits another payment", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  state.broadcastResponseLoss = true;
  await createWallet(page, false, true);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const originalSignature = state.checkpointBeforeBroadcast!.transactionSignature;
  state.signatureConfirmation = "confirmed";
  state.signatureError = "AccountInUse";
  await dialog.getByRole("button", {name: "Check payment status"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "mock verifier"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!).paymentAttempt.signature).toBe(originalSignature);
  expect(state.rpcBroadcasts).toHaveLength(1);
  state.signatureConfirmation = "finalized";
  await dialog.getByRole("button", {name: "Check payment status"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "The Solana transaction failed"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toBeEnabled();
  const checkpoint = JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!);
  expect(checkpoint.paymentAttempt).toBeUndefined();
  expect(checkpoint.transactionSignature).toBeUndefined();
  expect(state.rpcBroadcasts).toHaveLength(1);
  expect(state.fundCalls).toHaveLength(1);
});

for (const signed of [true, false]) test(`closing the payment tab restores the ${signed ? "signed bytes" : "uncertain wallet receipt"} in a new tab`, async ({page, context}) => {
  const state = await installMocks(page);
  state.broadcastResponseLoss = signed;
  state.signatureMissing = signed;
  await createWallet(page, false, signed);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  if (!signed) await page.evaluate(() => { (window as any).__voxWalletFailure = "ambiguous"; });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const originalBytes = state.rpcBroadcasts[0];
  expect(state.fundCalls).toHaveLength(0);
  await page.close();

  const reopened = await context.newPage();
  await installMocks(reopened, PAYER_USDC, false, state);
  await reopened.goto("/");
  expect(await reopened.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout"))).toBeNull();
  await reopened.getByRole("button", {name: "Realize by post"}).click();
  const restored = reopened.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(restored.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(restored.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  await expect(restored.getByRole("button", {name: "Update my price"})).toBeDisabled();
  if (signed) {
    state.broadcastResponseLoss = false;
    await restored.getByRole("button", {name: "Check payment status"}).click();
  } else {
    await expect(restored.getByText("Payment outcome needs checking.")).toBeVisible();
    await restored.getByLabel("Transaction signature from your wallet").fill("2".repeat(88));
    await restored.getByRole("button", {name: "Verify wallet receipt"}).click();
    expect(state.rpcBroadcasts).toHaveLength(0);
  }
  await expect(restored.getByText("Your creation is ready and settled")).toBeVisible();
  if (signed) expect(state.rpcBroadcasts).toEqual([originalBytes, originalBytes]);
  expect(state.fundCalls).toHaveLength(1);
  expect(await reopened.evaluate(() => (window as any).__voxWalletSignCount)).toBeUndefined();
  expect(await reopened.evaluate(() => (window as any).__voxPaymentSendCount)).toBeUndefined();
});

test("two payment tabs share one signing lock and restore the first payment instead of charging twice", async ({page, context}) => {
  const state = await installMocks(page);
  state.broadcastResponseLoss = true;
  await createWallet(page, false, true);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const first = page.getByRole("dialog", {name: "Realize commission checkout"});
  await first.getByRole("button", {name: "Get my price"}).click();
  await first.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await first.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await first.getByRole("button", {name: "Continue to payment"}).click();
  const session = await page.evaluate(() => Object.entries(sessionStorage));
  const secondPage = await context.newPage();
  await installMocks(secondPage, PAYER_USDC, false, state);
  await createWallet(secondPage, false, true);
  await secondPage.addInitScript((values) => { for (const [key, value] of values) sessionStorage.setItem(key, value); }, session);
  await secondPage.goto("/");
  await secondPage.getByRole("button", {name: "Realize by post"}).click();
  const second = secondPage.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(second.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toBeEnabled();
  await page.evaluate(() => { (window as any).__voxSignatureGate = new Promise<void>((resolve) => { (window as any).__voxReleaseSignature = resolve; }); });
  await first.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as any).__voxWalletSignCount)).toBe(1);
  await second.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  expect(await secondPage.evaluate(() => (window as any).__voxWalletSignCount ?? 0)).toBe(0);
  await page.evaluate(() => (window as any).__voxReleaseSignature());
  await expect(first.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(second.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(second.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  expect(await secondPage.evaluate(() => (window as any).__voxWalletSignCount ?? 0)).toBe(0);
  expect(state.rpcBroadcasts).toHaveLength(1);
  expect(state.fundCalls).toHaveLength(0);
});

test("the atomic financial journal rejects stale failure cleanup after a newer attempt starts", async ({page}) => {
  await installMocks(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/financial-checkpoints.ts";
    const journal = await import(modulePath);
    const first = {sourcePostId: "source:journal-test", commissionId: "order:journal-test", attemptId: "attempt:first", outcome: "pending", updatedAt: 1, checkout: {transactionSignature: "first-signature"}};
    await journal.writeFinancialCheckpoint(first, {startAttempt: true});
    await journal.writeFinancialCheckpoint({...first, outcome: "failed", updatedAt: 2, checkout: {}}, {expectedAttemptId: first.attemptId, expectedSignature: "first-signature"});
    const second = {...first, attemptId: "attempt:second", updatedAt: 3, checkout: {transactionSignature: "second-signature"}};
    await journal.writeFinancialCheckpoint(second, {startAttempt: true, expectedAttemptId: first.attemptId});
    let rejected = false;
    try { await journal.writeFinancialCheckpoint({...first, outcome: "failed", updatedAt: 4, checkout: {}}, {expectedAttemptId: first.attemptId, expectedSignature: "first-signature"}); }
    catch { rejected = true; }
    let crossSourceRejected = false;
    try { await journal.writeFinancialCheckpoint({...second, sourcePostId: "source:other", attemptId: "attempt:other"}, {startAttempt: true}); }
    catch { crossSourceRejected = true; }
    const racing = await Promise.allSettled(["left", "right"].map((name) => journal.writeFinancialCheckpoint({...first, sourcePostId: "source:atomic-race", commissionId: `order:${name}`, attemptId: `attempt:${name}`}, {startAttempt: true})));
    return {rejected, crossSourceRejected, raceResults: racing.map((item) => item.status).sort(), current: await journal.readFinancialCheckpoint(first.sourcePostId)};
  });
  expect(result.rejected).toBe(true);
  expect(result.crossSourceRejected).toBe(true);
  expect(result.raceResults).toEqual(["fulfilled", "rejected"]);
  expect(result.current).toMatchObject({attemptId: "attempt:second", outcome: "pending", checkout: {transactionSignature: "second-signature"}});
});

test("an older session-only payment checkpoint migrates before its tab is closed", async ({page, context}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate(() => {
    const saved = JSON.parse(sessionStorage.getItem("vox.realize.v1.checkout")!);
    saved.transactionSignature = "2".repeat(88);
    sessionStorage.setItem("vox.realize.v1.checkout", JSON.stringify(saved));
    sessionStorage.removeItem("vox.realize.v1.checkpoints");
  });
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await page.close();
  const reopened = await context.newPage();
  await installMocks(reopened, PAYER_USDC, false, state);
  await reopened.goto("/");
  await reopened.getByRole("button", {name: "Realize by post"}).click();
  const restored = reopened.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(restored.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  await restored.getByRole("button", {name: "Check payment status"}).click();
  await expect(restored.getByText("Your creation is ready and settled")).toBeVisible();
  expect(state.fundCalls[0]?.transaction_signature).toBe("2".repeat(88));
  expect(state.rpcBroadcasts).toHaveLength(0);
});

test("an ambiguous sign-and-send wallet failure survives expiry and reload and accepts only a verified receipt", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page, true);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate(() => { (window as any).__voxWalletFailure = "ambiguous"; });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByText("Payment outcome needs checking.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__voxWalletSubmissionCheckpoint.paymentAttempt.kind)).toBe("wallet_submission");
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount)).toBe(1);
  expect(state.fundCalls).toHaveLength(0);
  await page.evaluate(() => sessionStorage.setItem("vox:e2e:recover-without-wallet", "true"));
  await page.clock.setSystemTime(Date.now() + 20 * 60_000);
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByText("Payment outcome needs checking.")).toBeVisible();
  await expect(dialog.getByText("Price expired · update it to continue")).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  await expect(dialog.getByRole("button", {name: "Update my price"})).toBeDisabled();
  await expect(dialog.getByLabel("Your idea")).toBeDisabled();
  await dialog.getByLabel("Transaction signature from your wallet").fill("2".repeat(88));
  state.signatureMissing = true;
  await dialog.getByRole("button", {name: "Verify wallet receipt"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "Solana has not finalized this receipt"})).toBeVisible();
  expect(state.fundCalls).toHaveLength(0);
  state.signatureMissing = false;
  await dialog.getByRole("button", {name: "Verify wallet receipt"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "mock verifier"})).toBeVisible();
  await expect(dialog.getByText("Verified by VOX.gold")).toHaveCount(0);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!).paymentAttempt.kind).toBe("wallet_submission");
  state.rejectFunding = false;
  await dialog.getByRole("button", {name: "Verify wallet receipt"}).click();
  await expect(dialog.getByText("Your creation is ready and settled")).toBeVisible();
  expect(state.fundCalls).toHaveLength(2);
  expect(state.fundCalls[1]?.transaction_signature).toBe("2".repeat(88));
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount)).toBeUndefined();
});

test("an explicit wallet rejection clears the unresolved marker and permits the customer to try again", async ({page}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate(() => { (window as any).__voxWalletFailure = "rejected"; });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "Payment canceled in your wallet"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toBeEnabled();
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout")))!).paymentAttempt).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount ?? 0)).toBe(0);
  expect(state.fundCalls).toHaveLength(0);
  await page.evaluate(() => { (window as any).__voxWalletFailure = undefined; });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByText("Your creation is ready and settled")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount)).toBe(1);
});

test("disabled durable browser storage stops payment before a sign-and-send wallet is invoked", async ({page}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate(() => { IDBFactory.prototype.open = () => { throw new Error("Storage unavailable"); }; });
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "Durable payment recovery is unavailable"})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__voxWalletRequestCount ?? 0)).toBe(0);
  expect(state.fundCalls).toHaveLength(0);
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toBeEnabled();
});

for (const unavailable of ["quota", "coordination"] as const) test(`${unavailable} failure stops payment before the wallet is invoked`, async ({page}) => {
  const state = await installMocks(page);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await page.evaluate((kind) => {
    if (kind === "quota") IDBObjectStore.prototype.put = () => { throw new DOMException("Payment recovery quota exceeded", "QuotaExceededError"); };
    else Object.defineProperty(navigator, "locks", {value: undefined});
  }, unavailable);
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("alert").filter({hasText: unavailable === "quota" ? "quota exceeded" : "cannot coordinate payments across tabs"})).toBeVisible();
  expect(await page.evaluate(() => (window as any).__voxWalletRequestCount ?? 0)).toBe(0);
  expect(state.fundCalls).toHaveLength(0);
});

test("an expired submitted payment can be verified after reload without reconnecting or sending again", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page, true);
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const originalFunding = state.fundCalls[0];
  expect(originalFunding?.transaction_signature).toBeTruthy();
  await page.route("**/v1/realize/commissions/*/fund", async (route) => {
    const body = route.request().postDataJSON();
    state.fundCalls.push(body);
    state.commission = {...state.commission, state: "MANUAL_REVIEW", payment_state: "captured", fulfillment_state: "not_started"};
    return json(route, state.commission);
  });
  await page.evaluate(() => sessionStorage.setItem("vox:e2e:recover-without-wallet", "true"));
  await page.clock.setSystemTime(Date.now() + 20 * 60_000);
  await page.reload();
  await page.getByRole("button", {name: "Realize by post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByText("Price expired · update it to continue")).toBeVisible();
  await expect(dialog.getByText("Reconnect the payer wallet to fund this accepted quote.")).toBeVisible();
  await dialog.getByRole("button", {name: "Check payment status"}).click();
  await expect(dialog.getByRole("heading", {name: "Commission needs review"})).toBeVisible();
  expect(state.fundCalls).toHaveLength(2);
  expect(state.fundCalls[1]).toEqual(originalFunding);
  expect(await page.evaluate(() => (window as any).__voxLastSentTransaction)).toBeUndefined();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
});

test("keeps in-flight checkout recovery isolated until its quote request finishes", async ({page}) => {
  await installMocks(page);
  let requested = false;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/v1/realize/pricing-requests", async (route) => {
    requested = true;
    const pricing = route.request().postDataJSON();
    await delayed;
    return json(route, {protocol_version: "realize/1", request_id: pricing.request_id, creator_id: CREATOR_ID, quotes: [makeQuote(pricing)], issued_at: new Date().toISOString()});
  });
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await expect.poll(() => requested).toBe(true);
  await expect(dialog.getByRole("button", {name: "Close realization"})).toBeDisabled();
  await page.locator(".drawer-backdrop").click({position: {x: 5, y: 5}});
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByText("✓ Price verified", {exact: true})).toBeVisible();
  await dialog.getByRole("button", {name: "Close realization"}).click();
  await expect(dialog).toHaveCount(0);
});

test("preserves a submitted payment when another source post opens a new checkout", async ({page}) => {
  const first = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  const firstPostId = `vox:post:${"b".repeat(64)}`;
  const secondPostId = `vox:post:${"d".repeat(64)}`;
  const secondCommissionId = "commission:e2e-second-post";
  await page.route("**/v1/feed?**", (route) => json(route, {items: [firstPostId, secondPostId].map((id, index) => ({
    post_id: id, intent: {agent_id: CREATOR_ID, created_at: NOW, kind: "thought", content: {text: index ? "A second source post for another video." : "The original source post with a pending payment."}},
    signature: "test-signature", post_hash: id.slice("vox:post:".length), envelope: {sequence: index + 1, accepted_at: NOW, publisher_instance_id: ISSUER_ID}, envelope_hash: "c".repeat(64), publication_status: "published", anchoring: {status: "pending", tier: "standard"}
  }))}));
  await page.route("**/v1/realize/commissions", async (route) => {
    const body = route.request().postDataJSON();
    if (body.source_post_id !== secondPostId) return route.fallback();
    return json(route, makeCommission(body, {commission_id: secondCommissionId}));
  });
  await page.route("**/v1/realize/pricing-requests", async (route) => {
    const pricing = route.request().postDataJSON();
    if (pricing.commission_id !== secondCommissionId) return route.fallback();
    return json(route, {protocol_version: "realize/1", request_id: pricing.request_id, creator_id: CREATOR_ID, quotes: [makeQuote(pricing)], issued_at: new Date().toISOString()});
  });
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).nth(0).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const originalSignature = first.fundCalls[0]?.transaction_signature;
  expect(originalSignature).toBeTruthy();
  // Simulate an existing customer upgrading from the previous singleton checkpoint.
  await page.evaluate(() => sessionStorage.removeItem("vox.realize.v1.checkpoints"));
  await dialog.getByRole("button", {name: "Close realization"}).click();
  await page.getByRole("button", {name: "Realize by post"}).nth(1).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await expect(dialog.getByText("✓ Price verified", {exact: true})).toBeVisible();
  const checkpoints = await page.evaluate(() => JSON.parse(sessionStorage.getItem("vox.realize.v1.checkpoints")!));
  expect(checkpoints.entries[`commission:${COMMISSION_ID}`]).toMatchObject({originPostId: firstPostId, transactionSignature: originalSignature});
  expect(checkpoints.entries[`commission:${secondCommissionId}`]).toMatchObject({originPostId: secondPostId, commissionId: secondCommissionId});
  await dialog.getByRole("button", {name: "Close realization"}).click();
  await page.getByRole("button", {name: "Realize by post"}).nth(0).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__voxPaymentSendCount)).toBe(1);
  expect(first.fundCalls).toHaveLength(1);
});

test("mints a chosen completed output on Monad and keeps refreshing after settlement", async ({page}) => {
  const state = await installMocks(page);
  state.nftMediaIds = ["vox:media:nft-e2e-0", "vox:media:nft-e2e-1"];
  await createWallet(page);
  const recipient = "0x" + "2".repeat(40);
  const contract = "0x" + "3".repeat(40);
  const tx = "0x" + "4".repeat(64);
  let mintState = "claimable";
  let claims = 0;
  let syncs = 0;
  await page.addInitScript(({recipient}) => {
    let chain = "0x1";
    (window as any).__voxEvmCalls = [];
    (window as any).ethereum = {async request({method, params}: {method: string; params: any[]}) {
      (window as any).__voxEvmCalls.push({method, params});
      if (method === "eth_requestAccounts") return [recipient];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") { chain = params[0].chainId; return null; }
      if (method === "personal_sign") return "0x" + "1".repeat(130);
      throw new Error("Unexpected wallet method " + method);
    }};
  }, {recipient});
  const media = (index: number) => ({
    media_id: state.nftMediaIds![index], source_kind: "realize_commission", source_id: COMMISSION_ID,
    output_index: index, provider_id: PROVIDER_ID, media_uri: "https://media.example.test/completed.mp4",
    media_type: "video/mp4", media_sha256: "a".repeat(64), metadata_hash: "b".repeat(64),
    metadata_uri: "https://vox.example.test/metadata", created_at: NOW,
    mints: [{mint_id: `mint:e2e:${index}`, chain: "monad:mainnet", state: index === 1 ? mintState : "claimable",
      created_at: "2026-10-12T01:00:00.000Z", ...(index === 1 && mintState !== "claimable" ? {owner_wallet: recipient, transaction_id: tx, asset_address: contract, explorer_url: `https://monadscan.com/tx/${tx}`} : {}),
      ...(index === 1 && mintState === "finalized" ? {token_id: "42"} : {})}]
  });
  await page.route("**/v1/nft/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path.endsWith("/claim")) {
      claims += 1;
      expect(path).toContain("mint:e2e:1");
      expect(route.request().postDataJSON().wallet).toBe(recipient);
      expect(route.request().headers()["x-vox-realize-signature"]).toBeTruthy();
      mintState = "submitted";
      return json(route, {state: mintState}, 202);
    }
    if (path.endsWith("/sync")) { syncs += 1; if (syncs >= 2) mintState = "finalized"; return json(route, media(1)); }
    return json(route, media(path.endsWith("nft-e2e-1") ? 1 : 0));
  });
  await page.goto("/");
  await page.getByRole("button", {name: "Realize by post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Get my price"}).click();
  await dialog.getByRole("checkbox", {name: "I agree to the usage terms and this price."}).check();
  await dialog.getByRole("button", {name: "Connect VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Continue to payment"}).click();
  await expect(dialog.getByRole("button", {name: "Mint on Monad"})).toHaveCount(0);
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();
  await expect(dialog.getByRole("button", {name: "Mint on Monad"})).toHaveCount(2);
  await dialog.getByRole("button", {name: "Mint on Monad"}).nth(1).click();
  await expect(dialog.getByText("Minted · Token #42", {exact: true})).toBeVisible({timeout: 20_000});
  await expect(dialog.getByRole("link", {name: "View your NFT ↗"})).toHaveAttribute("href", `https://monadscan.com/token/${contract}?a=42`);
  expect(claims).toBe(1);
  expect(syncs).toBeGreaterThanOrEqual(2);
  const calls = await page.evaluate(() => (window as any).__voxEvmCalls);
  expect(calls.some((call: any) => call.method === "wallet_switchEthereumChain" && call.params[0].chainId === "0x8f")).toBe(true);
  const signedMessage = Buffer.from(calls.find((call: any) => call.method === "personal_sign").params[0].slice(2), "hex").toString("utf8");
  expect(signedMessage).toContain("Created: 2026-10-12T01:00:00.000Z");
  expect(signedMessage).toContain("Mint: mint:e2e:1");
});

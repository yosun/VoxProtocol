import {expect, test, type Page, type Route} from "@playwright/test";
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
import {PublicKey, Transaction} from "@solana/web3.js";

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
const PAYER = new PublicKey("11111111111111111111111111111111");
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
  funded: boolean;
  sourceBalance: bigint;
  fundCalls: Array<Record<string, any>>;
  rejectFunding: boolean;
  sentPayment?: {payer: string; destination: string; amount: string; memo: string};
  publicProvenance?: Record<string, any>;
  publicAttribution?: string;
  capabilityFailures?: number;
  supportedResolutions: string[];
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
    commission_id: COMMISSION_ID,
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

function createWallet(page: Page) {
  return page.addInitScript(({address, publicKey}) => {
    const account = {
      address,
      publicKey: new Uint8Array(publicKey),
      chains: ["solana:mainnet"],
      features: ["solana:signAndSendTransaction"]
    };
    const wallet = {
      version: "1.0.0",
      name: "VOX Test Wallet",
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
            (window as any).__voxLastSentTransaction = Array.from(transaction);
            return {signature: new Uint8Array(64).fill(1)};
          })
        }
      }
    };
    window.addEventListener("wallet-standard:app-ready", (event: Event) => {
      (event as CustomEvent<{register: (candidate: unknown) => void}>).detail.register(wallet);
    });
  }, {address: PAYER.toBase58(), publicKey: Array.from(PAYER.toBytes())});
}

async function installMocks(page: Page, sourceBalance = PAYER_USDC, rejectFunding = false): Promise<MockState> {
  const state: MockState = {funded: false, sourceBalance, fundCalls: [], rejectFunding, supportedResolutions: ["480P", "768P", "1080P"]};
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
        return result({context: {slot: 11}, value: [{slot: 11, confirmations: null, err: null, confirmationStatus: "finalized"}]});
      case "getBlockHeight":
        return result(11);
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
      state.commission = makeCommission(state.commission ?? {}, {state: "AWAITING_PAYMENT", payment_state: "pending", quote_id: state.quote?.quote_id, accepted_quote_hash: state.quote?.canonical_quote_hash, payment_intent_id: "payment-intent:e2e"});
      state.funding = {mode: "direct", custody_model: "backend_managed", usdc_mint: USDC_MINT.toBase58(), network_id: "solana:mainnet-beta", destination_token_account: DESTINATION.toBase58(), destination_owner: TREASURY_OWNER.toBase58(), amount_usdc_atomic: TOTAL_USDC, payment_reference: "vox:realize:payment:e2e", payer_wallet: PAYER.toBase58()};
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
  await page.getByRole("button", {name: "Realize post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByLabel("Generation description")).toHaveValue("A thought ready to become a moving image.");
  await expect(dialog.getByText("Mira Vale", {exact: true})).toBeVisible();
  await expect(dialog.getByText("A VOX first-party AI character")).toBeVisible();
  await expect(dialog.getByText(/does not require a separate creator-signed rights agreement/)).toBeVisible();
  await dialog.getByLabel("Generation description").fill("A blue moon rises above a quiet glass city.");
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();

  await expect(dialog.getByRole("heading", {name: "The full price"})).toBeVisible();
  await expect(dialog.getByText("0.25 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.70 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("0.05 USDC", {exact: true})).toBeVisible();
  await expect(dialog.getByText("1.00 USDC", {exact: true})).toBeVisible();
  await expect(dialog.locator(".quote-creation-summary p")).toHaveText("A blue moon rises above a quiet glass city.");
  await expect(dialog.getByText(/Expires in \d+:\d+ ·/)).toBeVisible();
  await expect(dialog.getByText("Provider allocation (25.00%)")).toBeVisible();
  await expect(dialog.getByText("Character owner (70.00%)")).toBeVisible();
  await expect(dialog.getByText("VOX platform (5.00%)")).toBeVisible();
  await dialog.getByRole("checkbox", {name: /I reviewed the first-party generation policy/}).check();
  await dialog.getByRole("button", {name: "VOX Test Wallet"}).click();
  await expect(dialog.getByText(PAYER.toBase58().slice(0, 8))).toBeVisible();
  await dialog.getByRole("button", {name: "Accept rights and continue to payment"}).click();
  await expect(dialog.getByText(/VOX manages settlement and any refund after the standard USDC transfer/)).toBeVisible();
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
  expect(transaction.instructions.some((instruction) => instruction.programId.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" && instruction.data.toString("utf8") === "vox:realize:payment:e2e")).toBe(true);
});

test("integration-test checkout requests only the fixed prerecorded Bob clip and the test provider", async ({page}) => {
  const state = await installMocks(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByRole("button", {name: "Use prerecorded payment-path test"}).click();
  await expect(dialog.getByRole("note", {name: "Prerecorded payment-path test"})).toContainText("does not generate a clip from a custom prompt");
  await dialog.getByRole("button", {name: "Get prerecorded test quote"}).click();

  await expect(dialog.getByRole("heading", {name: "The full price"})).toBeVisible();
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
  await page.getByRole("button", {name: "Realize post"}).click();

  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByLabel("Style")).toHaveCount(0);
  await expect(dialog.getByLabel("Duration")).toHaveCount(0);
  await expect(dialog.getByLabel("Resolution")).toHaveCount(0);
  await expect(dialog.getByRole("button", {name: "Get dynamic quote"})).toBeEnabled();
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();
  await expect(dialog.getByRole("heading", {name: "The full price"})).toBeVisible();
  expect(state.quote?.requested_generation_parameters.resolution).toBe("480P");
});

test("insufficient USDC leaves the accepted quote unfunded", async ({page}) => {
  const state = await installMocks(page, 100_000n);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Generation description").fill("A blue moon above a quiet glass city.");
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();
  await dialog.getByRole("checkbox", {name: /I reviewed the first-party generation policy/}).check();
  await dialog.getByRole("button", {name: "VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Accept rights and continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();
  await expect(dialog.getByRole("alert").filter({hasText: "Insufficient USDC"})).toBeVisible();
  await expect(dialog.getByText("Awaiting server verification")).toHaveCount(2);
  expect(state.fundCalls).toHaveLength(0);
});

test("a wallet callback cannot mark payment successful before server verification", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Generation description").fill("A quiet glass city beneath a blue moon.");
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();
  await dialog.getByRole("checkbox", {name: /I reviewed the first-party generation policy/}).check();
  await dialog.getByRole("button", {name: "VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Accept rights and continue to payment"}).click();
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
  await page.getByRole("button", {name: "Realize post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Generation description").fill("A glass city beneath a crescent moon.");
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();
  await dialog.getByRole("checkbox", {name: /I reviewed the first-party generation policy/}).check();
  await dialog.getByRole("checkbox", {name: "Optionally include a public credit in provenance."}).check();
  await dialog.getByLabel("Public credit text").fill("Commissioned by A. Vale");
  await dialog.getByRole("button", {name: "VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Accept rights and continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC"}).click();
  await expect(dialog.getByText("Public credit: Commissioned by A. Vale")).toBeVisible();
  expect(state.publicProvenance?.public_attribution).toBe("Commissioned by A. Vale");
  expect(JSON.stringify(state.publicProvenance)).not.toContain(PAYER.toBase58());
});

test("an unavailable creator has a recoverable setup state", async ({page}) => {
  const state = await installMocks(page);
  state.capabilityFailures = 2; // React's development StrictMode mounts effects twice.
  await page.goto("/");
  await page.getByRole("button", {name: "Realize post"}).click();
  const dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("alert")).toContainText("not ready to accept commissions");
  await expect(dialog.getByText("Loading this creator’s active rights agreement…")).not.toBeVisible();
  await dialog.getByLabel("Generation description").fill("Keep my brief while reconnecting to this creator.");
  await dialog.getByRole("button", {name: "Retry creator setup"}).click();
  await expect(dialog.getByRole("button", {name: "Get dynamic quote"})).toBeEnabled();
  await expect(dialog.getByLabel("Generation description")).toHaveValue("Keep my brief while reconnecting to this creator.");
  await expect(dialog.getByLabel("Style")).toHaveCount(0);
  await expect(dialog.getByLabel("Duration")).toHaveCount(0);
  await expect(dialog.getByLabel("Resolution")).toHaveCount(0);
});

test("reloading an unverified payment restores the signature and prevents a second charge", async ({page}) => {
  const state = await installMocks(page, PAYER_USDC, true);
  await createWallet(page);
  await page.goto("/");
  await page.getByRole("button", {name: "Realize post"}).click();
  let dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await dialog.getByLabel("Generation description").fill("A quiet cinematic scene for recovery testing.");
  await dialog.getByRole("button", {name: "VOX Test Wallet"}).click();
  await dialog.getByRole("button", {name: "Get dynamic quote"}).click();
  await dialog.getByRole("checkbox", {name: /I reviewed the first-party generation policy/}).check();
  await dialog.getByRole("button", {name: "Accept rights and continue to payment"}).click();
  await dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true}).click();
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  const fundingCalls = state.fundCalls.length;
  await page.reload();
  await page.getByRole("button", {name: "Realize post"}).click();
  dialog = page.getByRole("dialog", {name: "Realize commission checkout"});
  await expect(dialog.getByRole("button", {name: "Check payment status"})).toBeVisible();
  await expect(dialog.getByRole("button", {name: "Pay 1.00 USDC", exact: true})).not.toBeVisible();
  expect(state.fundCalls).toHaveLength(fundingCalls);
});

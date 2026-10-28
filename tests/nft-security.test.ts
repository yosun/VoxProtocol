import {createHash} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";
import {createHuman} from "@vox/identity";
import {parseSecretKey, realizeClientRequestSigningPayload, signBytes, utf8} from "@vox/protocol";
import {buildApp} from "../apps/api/src/app.js";
import {legacyRealizationToNftInput, NftMintService, nftClaimMessage, type NftChainAdapter, type NftMediaInput} from "../apps/api/src/nft.js";
import {MemoryStore} from "../apps/api/src/store.js";
import type {NftChain, NftMediaRecord, NftMintRecord, RealizeCommissionRecord} from "../apps/api/src/types.js";
import {seedPaidNftSource} from "./nft-fixtures.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function adapter(chain: NftChain) {
  return {
    chain,
    prepare: vi.fn(async () => ({transaction_id: "mock-nft-tx", signed_transaction: "mock-signed-bytes"})),
    submit: vi.fn(async () => ({state: "finalized" as const, transaction_id: "mock-nft-tx"})),
    reconcile: vi.fn(async () => ({state: "finalized" as const, transaction_id: "mock-nft-tx"}))
  } satisfies NftChainAdapter;
}

function input(): NftMediaInput {
  return {
    source_kind: "realize_commission", publication_consent: true, source_id: "commission:nft-security", output_index: 0,
    creator_id: "creator:nft-security", owner_id: "human:nft-security", provider_id: "provider:nft-security",
    owner_wallets: {monad: `0x${"1".repeat(40)}`}, request_parameters: {concept: "A verified customer artifact"},
    media_uri: "https://artifacts.example.test/real.mp4", media_sha256: "b".repeat(64), media_type: "video/mp4", byte_length: 512,
    provenance_record_id: "provenance:nft-security"
  };
}

function legacyInput(ownerId = "human:nft-security"): NftMediaInput {
  return {...legacyRealizationToNftInput({realizationId: "legacy:mock", ownerId, providerId: "vox.mock-media.v1", postId: "post:mock", requestParameters: {}, mediaUri: "https://example.invalid/vox/mock.mp4", mediaHash: "c".repeat(64), publicBaseUrl: "https://vox.example.test"}), owner_wallets: {monad: `0x${"1".repeat(40)}`}};
}

function expectNoChainCalls(chain: ReturnType<typeof adapter>) {
  expect(chain.prepare).not.toHaveBeenCalled();
  expect(chain.submit).not.toHaveBeenCalled();
  expect(chain.reconcile).not.toHaveBeenCalled();
}

async function injectedMint(store: MemoryStore, media: NftMediaRecord, state: NftMintRecord["state"], wallet = `0x${"1".repeat(40)}`) {
  return store.createNftMint({
    mint_id: `vox:nft:${createHash("sha256").update(`${media.media_id}\u0000monad:mainnet`).digest("hex")}`,
    media_id: media.media_id, chain: "monad:mainnet", owner_id: media.owner_id, owner_wallet: wallet,
    metadata_uri: media.metadata_uri, metadata_hash: media.metadata_hash, state, attempts: 1,
    ...(state === "signed" || state === "submitted" ? {transaction_id: "preexisting-tx", signed_transaction: "preexisting-signed-bytes"} : {}),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
}

describe("Mainnet NFT payment eligibility", () => {
  it("does not provision Mainnet entitlements from repeated unpaid legacy API requests or lazy reads", async () => {
    vi.stubEnv("VOX_PAYMENT_MODE", "mock");
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const postId = `vox:post:${"a".repeat(64)}`;
    await store.createQuote({quote_id: "quote:legacy", post_id: postId, requester_id: "human:legacy", style: "cinematic", duration_seconds: 1, generation_description: "", amount_usdc_atomic: "1000000", currency: "USDC", expires_at: new Date(Date.now() + 60_000).toISOString(), provider_id: "vox.mock-media.v1", mock: true, status: "issued", created_at: new Date().toISOString()});
    app = await buildApp({store, nftService: service});
    for (const reference of ["unpaid-one", "unpaid-two"]) {
      const response = await app.inject({method: "POST", url: "/v1/realizations", payload: {post_id: postId, quote_id: "quote:legacy", requester_id: "human:legacy", payment_reference: reference}});
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({status: "delivered", mock: true});
      expect(response.json().nft_media_ids).toBeUndefined();
      const read = await app.inject(`/v1/realizations/${response.json().realization_id}`);
      expect(read.statusCode).toBe(200);
      expect(read.json().nft_media_ids).toBeUndefined();
    }
    expect((await store.snapshot()).nft_mints).toHaveLength(0);
    await service.processPending(store);
    expectNoChainCalls(chain);
  });

  it("keeps mock entitlements on testnets when testnet and Mainnet adapters are mixed", async () => {
    const store = new MemoryStore();
    const mainnet = adapter("monad:mainnet");
    const testnet = adapter("monad:testnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [mainnet, testnet]});
    const media = await service.ensureMedia(store, legacyInput());
    expect((await store.listNftMintsForMedia(media.media_id)).map((mint) => mint.chain)).toEqual(["monad:testnet"]);
    await service.processPending(store);
    expect(testnet.prepare).toHaveBeenCalledOnce();
    expect(testnet.submit).toHaveBeenCalledOnce();
    expectNoChainCalls(mainnet);
  });

  it.each(["COMPLETED", "SETTLED"] as const)("allows a paid, consented, verified %s Mainnet Realize output exactly once per chain", async (state) => {
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const mediaInput = input();
    const source = await seedPaidNftSource(store, mediaInput);
    if (state === "SETTLED") await store.updateRealizeCommission({...source, commission: {...source.commission, state, payment_state: "settled"}, settlement_status: "settled"}, source.updated_at);
    const media = await service.ensureMedia(store, mediaInput);
    await service.ensureMedia(store, mediaInput);
    expect(await service.processPending(store)).toMatchObject([{state: "finalized"}]);
    await service.processPending(store);
    expect(await store.listNftMintsForMedia(media.media_id)).toHaveLength(1);
    expect(chain.prepare).toHaveBeenCalledOnce();
    expect(chain.submit).toHaveBeenCalledOnce();
  });

  it("checks payment eligibility again after entitlement creation before signing", async () => {
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const mediaInput = input();
    const source = await seedPaidNftSource(store, mediaInput);
    const media = await service.ensureMedia(store, mediaInput);
    expect(await store.listNftMintsForMedia(media.media_id)).toHaveLength(1);
    vi.spyOn(store, "getRealizeCommission").mockResolvedValue({...source, commission: {...source.commission, state: "REFUND_PENDING", payment_state: "refund_pending"}});
    expect(await service.processPending(store)).toMatchObject([{state: "manual_review"}]);
    expectNoChainCalls(chain);
  });

  it("requires a persisted commission before granting a Mainnet entitlement", async () => {
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const media = await service.ensureMedia(store, input());
    expect(await store.listNftMintsForMedia(media.media_id)).toHaveLength(0);
    expectNoChainCalls(chain);
  });

  const badSources: Array<[string, (record: RealizeCommissionRecord) => void]> = [
    ["missing verified funding", (record) => { delete record.funding_verified_at; }],
    ["Devnet funding", (record) => { record.funding_network_id = "solana:devnet"; }],
    ["uncaptured payment", (record) => { record.payment_intent!.status = "authorized"; }],
    ["a different payer", (record) => { record.payment_intent!.payer_id = "human:other"; }],
    ["a different amount", (record) => { record.direct_funding!.amount_usdc_atomic = "1"; }],
    ["missing public consent", (record) => { record.nft_publication_consent = false; }],
    ["a refund", (record) => { record.commission.state = "REFUNDED"; record.commission.payment_state = "refunded"; }],
    ["unverified artifact bytes", (record) => { record.fulfillment_result!.outputs[0]!.sha256 = "a".repeat(64); }],
    ["missing provenance", (record) => { delete record.provenance_record_id; }]
  ];
  it.each(badSources)("rejects %s before creating Mainnet entitlement", async (_name, corrupt) => {
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const mediaInput = input();
    const source = structuredClone(await seedPaidNftSource(store, mediaInput));
    corrupt(source);
    vi.spyOn(store, "getRealizeCommission").mockResolvedValue(source);
    const media = await service.ensureMedia(store, mediaInput);
    expect(await store.listNftMintsForMedia(media.media_id)).toHaveLength(0);
    expectNoChainCalls(chain);
  });

  it.each(["queued", "signed", "submitted"] as const)("blocks preexisting ineligible %s records before a Mainnet processor can sign or rebroadcast", async (state) => {
    const store = new MemoryStore();
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const media = await service.ensureMedia(store, legacyInput());
    const mint = await injectedMint(store, media, state);
    expect(await service.processPending(store)).toMatchObject([{mint_id: mint.mint_id, state: "manual_review"}]);
    expect(await store.getNftMint(mint.mint_id)).toMatchObject({state: "manual_review", ...(state === "queued" ? {} : {transaction_id: mint.transaction_id, signed_transaction: mint.signed_transaction})});
    expectNoChainCalls(chain);
  });

  it("preserves a preexisting signed ineligible mint through claim and blocks its sync broadcast", async () => {
    const store = new MemoryStore();
    const human = createHuman({display_name: "Collector", handle: "@legacy-collector", description: "test"});
    await store.registerHuman(human.registration);
    const key = new Uint8Array(32).fill(11);
    const wallet = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20)).toString("hex")}`;
    const chain = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const media = await service.ensureMedia(store, legacyInput(human.registration.human_id));
    const mint = await injectedMint(store, media, "signed", wallet);
    const message = nftClaimMessage(mint, wallet);
    const signature = secp256k1.sign(keccak_256(utf8(`\x19Ethereum Signed Message:\n${utf8(message).length}${message}`)), key);
    const body = {wallet, signature: `0x${Buffer.from(signature.toCompactRawBytes()).toString("hex")}${(27 + signature.recovery!).toString(16)}`};
    const headers = (path: string, payload: unknown) => {
      const issued_at = new Date().toISOString();
      return {"x-vox-realize-human-id": human.registration.human_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signBytes(realizeClientRequestSigningPayload({method: "POST", path, principal_id: human.registration.human_id, issued_at, body: payload}), parseSecretKey(human.key_material.identitySecretKey))};
    };
    app = await buildApp({store, nftService: service});
    const claimPath = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/claim`;
    expect((await app.inject({method: "POST", url: claimPath, payload: body, headers: headers(claimPath, body)})).json().state).toBe("signed");
    expectNoChainCalls(chain);
    const syncPath = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/sync`;
    expect((await app.inject({method: "POST", url: syncPath, payload: {}, headers: headers(syncPath, {})})).statusCode).toBe(200);
    expect(await store.getNftMint(mint.mint_id)).toMatchObject({state: "manual_review", transaction_id: "preexisting-tx", signed_transaction: "preexisting-signed-bytes"});
    expectNoChainCalls(chain);
  });
});

import {afterEach, describe, expect, it, vi} from "vitest";
import nacl from "tweetnacl";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";
import {Keypair, type Connection} from "@solana/web3.js";
import {AuthorityType, decodeSetAuthorityInstruction} from "@solana/spl-token";
import {createHuman} from "@vox/identity";
import {parseSecretKey, realizeClientRequestSigningPayload, signBytes, utf8} from "@vox/protocol";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {createSolanaNftMintInstructions, EvmNftAdapter, NftMintService, SolanaNftAdapter, nftClaimMessage, type NftChainAdapter, type NftMediaInput, type NftPreparedTransaction} from "../apps/api/src/nft.js";
import type {NftChain, NftMediaRecord, NftMintRecord} from "../apps/api/src/types.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

function adapter(chain: NftChain, options: {fail?: boolean} = {}): NftChainAdapter & {prepared: number; submitted: number} {
  const state = {prepared: 0, submitted: 0};
  const implementation = {
    chain,
    get prepared() { return state.prepared; },
    get submitted() { return state.submitted; },
    async prepare(input: {media: NftMediaRecord; mint: NftMintRecord}): Promise<NftPreparedTransaction> {
      state.prepared += 1;
      return {transaction_id: `tx-${chain}-${input.mint.attempts}`, signed_transaction: `signed-${chain}-${input.mint.attempts}`, asset_address: `asset-${chain}`, explorer_url: `https://explorer.example.test/${encodeURIComponent(chain)}`};
    },
    async submit(mint: NftMintRecord) {
      state.submitted += 1;
      return options.fail ? {state: "retryable_failure" as const, error: `temporary ${chain} failure`, transaction_id: mint.transaction_id} : {state: "finalized" as const, transaction_id: mint.transaction_id!, asset_address: mint.asset_address, explorer_url: mint.explorer_url};
    },
    async reconcile(mint: NftMintRecord) {
      return {state: "submitted" as const, transaction_id: mint.transaction_id, explorer_url: mint.explorer_url};
    }
  };
  return implementation;
}

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder]! + encoded;
    value /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return "1".repeat(zeroes) + encoded;
}

function input(ownerWallet?: string): NftMediaInput {
  return {
    source_kind: "realize_commission",
    source_id: "vox:commission:test",
    output_index: 0,
    source_post_id: "vox:post:" + "a".repeat(64),
    creator_id: "vox:agent:test",
    owner_id: "vox:human:test",
    publication_consent: true,
    ...(ownerWallet ? {owner_wallets: {solana: ownerWallet}} : {}),
    provider_id: "provider:video:test",
    source_content: "A public source thought.",
    request_parameters: {concept: "A silver sunrise over an ocean", duration_seconds: 5},
    media_uri: "https://media.example.test/render.mp4",
    media_type: "video/mp4",
    media_sha256: "b".repeat(64),
    byte_length: 1234,
    provenance_record_id: "vox:provenance:test"
  };
}

function evmWallet(seed: number) {
  const key = new Uint8Array(32).fill(seed);
  const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20)).toString("hex")}`;
  return {address, sign(message: string) {
    const bytes = utf8(message);
    const signature = secp256k1.sign(keccak_256(utf8(`\x19Ethereum Signed Message:\n${bytes.length}${message}`)), key);
    return `0x${Buffer.from(signature.toCompactRawBytes()).toString("hex")}${(27 + signature.recovery!).toString(16)}`;
  }};
}

function headers(human: ReturnType<typeof createHuman>, path: string, body: unknown) {
  const issued_at = new Date().toISOString();
  return {"x-vox-realize-human-id": human.registration.human_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signBytes(realizeClientRequestSigningPayload({method: "POST", path, principal_id: human.registration.human_id, issued_at, body}), parseSecretKey(human.key_material.identitySecretKey))};
}

describe("cross-chain NFT entitlements", () => {
  it("recovers an expired signing lease before any transaction was submitted", async () => {
    const store = new MemoryStore();
    const chain = adapter("solana:devnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [chain]});
    const media = await service.ensureMedia(store, input(Keypair.generate().publicKey.toBase58()));
    const mint = (await store.listNftMintsForMedia(media.media_id))[0]!;
    const interrupted = (await store.claimNftMint(mint.mint_id, "crashed-worker", 300))!;
    expect(interrupted.state).toBe("signing");
    expect(await service.processPending(store)).toEqual([]);
    await store.updateNftMint({...interrupted, lease_expires_at: "1970-01-01T00:00:00.000Z"}, interrupted.updated_at);
    expect(await service.processPending(store)).toEqual([{mint_id: mint.mint_id, state: "finalized"}]);
    expect(chain.prepared).toBe(1);
    expect(chain.submitted).toBe(1);
  });

  it("waits for a finalized Solana failure before allowing a replacement mint", async () => {
    const getSignatureStatuses = vi.fn()
      .mockResolvedValueOnce({value: [{err: {InstructionError: [0, "Custom"]}, confirmationStatus: "confirmed"}]})
      .mockResolvedValueOnce({value: [{err: {InstructionError: [0, "Custom"]}, confirmationStatus: "finalized"}]});
    const chain = new SolanaNftAdapter({chain: "solana:devnet", rpcUrl: "https://rpc.example.test", keypair: Keypair.generate(), connection: {getSignatureStatuses} as unknown as Connection});
    const mint = {transaction_id: "test-transaction"} as NftMintRecord;
    expect(await chain.reconcile(mint)).toMatchObject({state: "submitted", transaction_id: mint.transaction_id});
    expect(await chain.reconcile(mint)).toMatchObject({state: "retryable_failure", transaction_id: mint.transaction_id});
  });

  it("waits for the configured EVM confirmations before retrying a reverted mint", async () => {
    const contract = `0x${"1".repeat(40)}`;
    const tx = `0x${"a".repeat(64)}`;
    let latest = "0x64";
    const fetcher = (async (_url: unknown, init: RequestInit) => {
      const {method} = JSON.parse(init.body as string);
      const result = method === "eth_getTransactionReceipt" ? {status: "0x0", to: contract, transactionHash: tx, logs: [], blockNumber: "0x64"} : method === "eth_blockNumber" ? latest : method === "eth_sendRawTransaction" ? tx : undefined;
      if (result === undefined) throw new Error(`unexpected RPC method ${method}`);
      return new Response(JSON.stringify({result}), {status: 200});
    }) as typeof fetch;
    const chain = new EvmNftAdapter({chain: "monad:testnet", rpcUrl: "https://rpc.example.test", chainId: 10143, contractAddress: contract, privateKey: new Uint8Array(32).fill(15), confirmations: 12, explorerBaseUrl: "https://explorer.example.test", fetcher});
    const mint = {transaction_id: tx, signed_transaction: "0x02"} as NftMintRecord;
    expect(await chain.reconcile(mint)).toMatchObject({state: "submitted", transaction_id: tx});
    latest = "0x6f";
    expect(await chain.reconcile(mint)).toMatchObject({state: "retryable_failure", transaction_id: tx});
  });

  it("rejects missing or declined public publication consent before creating an entitlement", async () => {
    const store = new MemoryStore();
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [adapter("solana:devnet")]});
    for (const publication_consent of [undefined, false]) {
      await expect(service.ensureMedia(store, {...input(), publication_consent})).rejects.toThrow("explicit public publication consent");
    }
    expect((await store.snapshot()).nft_media).toHaveLength(0);
  });

  it("encodes complete Token Metadata V3 data and retains mint authority until metadata creation", () => {
    const authority = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const uri = "https://vox.example.test/metadata/test.json";
    const instructions = createSolanaNftMintInstructions({authority, mint, owner, rentLamports: 1_500_000, metadataUri: uri, name: "VOX test"});
    const metadataIndex = instructions.findIndex((instruction) => instruction.programId.toBase58() === "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    const metadata = instructions[metadataIndex]!;
    let offset = 1;
    const readString = () => {
      const length = metadata.data.readUInt32LE(offset);
      offset += 4;
      const value = metadata.data.subarray(offset, offset + length).toString("utf8");
      offset += length;
      return value;
    };
    expect(metadata.data[0]).toBe(33);
    expect([readString(), readString(), readString()]).toEqual(["VOX test", "VOX", uri]);
    // DataV2: fee u16, creators/collection/uses Option tags; then mutable and collection details.
    expect([...metadata.data.subarray(offset)]).toEqual([0, 0, 0, 0, 0, 1, 0]);
    const mintRevocation = decodeSetAuthorityInstruction(instructions[metadataIndex + 1]!);
    const freezeRevocation = decodeSetAuthorityInstruction(instructions[metadataIndex + 2]!);
    expect(mintRevocation.data).toMatchObject({authorityType: AuthorityType.MintTokens, newAuthority: null});
    expect(freezeRevocation.data).toMatchObject({authorityType: AuthorityType.FreezeAccount, newAuthority: null});
    expect(metadata.keys[2]).toMatchObject({pubkey: authority, isSigner: true});
  });

  it("creates one idempotent entitlement per chain and preserves walletless claims", async () => {
    const store = new MemoryStore();
    const solana = Keypair.generate().publicKey.toBase58();
    const adapters = [adapter("solana:devnet"), adapter("base:sepolia"), adapter("monad:testnet")];
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters});
    const first = await service.ensureMedia(store, input(solana));
    const second = await service.ensureMedia(store, input(solana));
    expect(second.media_id).toBe(first.media_id);
    const mints = await store.listNftMintsForMedia(first.media_id);
    expect(mints).toHaveLength(3);
    expect(mints.find((mint) => mint.chain === "solana:devnet")?.state).toBe("queued");
    expect(mints.filter((mint) => mint.state === "claimable")).toHaveLength(2);
    expect(first.metadata_uri).toBe(`https://vox.example.test/v1/nft/metadata/${encodeURIComponent(first.media_id)}`);
    expect(first.metadata_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("supports Arbitrum, Ethereum L1, HyperEVM, and Robinhood Chain namespaces", async () => {
    const store = new MemoryStore();
    const chains = ["arbitrum:mainnet", "ethereum:mainnet", "hyperevm:mainnet", "robinhood:mainnet"] as const;
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: chains.map((chain) => adapter(chain))});
    const media = await service.ensureMedia(store, input());
    expect((await store.listNftMintsForMedia(media.media_id)).map((mint) => mint.chain)).toEqual([...chains].sort());
  });

  it("mints chains independently and retries only the failed chain", async () => {
    const store = new MemoryStore();
    const solana = adapter("solana:devnet");
    const base = adapter("base:sepolia", {fail: true});
    const monad = adapter("monad:testnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [solana, base, monad]});
    const mediaInput = input(Keypair.generate().publicKey.toBase58());
    mediaInput.owner_wallets = {solana: mediaInput.owner_wallets!.solana, base: `0x${"1".repeat(40)}`, monad: `0x${"2".repeat(40)}`};
    const media = await service.ensureMedia(store, mediaInput);
    const outcomes = await service.processPending(store, 10);
    expect(outcomes.map((item) => item.state)).toEqual(expect.arrayContaining(["finalized", "retryable_failure"]));
    expect(solana.submitted).toBe(1);
    expect(monad.submitted).toBe(1);
    expect((await store.listNftMintsForMedia(media.media_id)).find((item) => item.chain === "base:sepolia")?.state).toBe("retryable_failure");
    expect((await store.listNftMintsForMedia(media.media_id)).find((item) => item.chain === "solana:devnet")?.state).toBe("finalized");
  });

  it("requires a signed destination-wallet proof before queuing a walletless entitlement", async () => {
    const store = new MemoryStore();
    const human = createHuman({display_name: "NFT claimant", handle: "@nft-claimant", description: "test"});
    await store.registerHuman(human.registration);
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [adapter("solana:devnet")]});
    const mediaInput = input();
    mediaInput.owner_id = human.registration.human_id;
    const media = await service.ensureMedia(store, mediaInput);
    const mint = (await store.listNftMintsForMedia(media.media_id))[0]!;
    const wallet = Keypair.generate();
    const walletAddress = wallet.publicKey.toBase58();
    const walletSignature = base58(nacl.sign.detached(utf8(nftClaimMessage(mint, walletAddress)), wallet.secretKey));
    const body = {wallet: walletAddress, signature: walletSignature};
    const path = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/claim`;
    const issued_at = new Date().toISOString();
    const requestSignature = signBytes(realizeClientRequestSigningPayload({method: "POST", path, principal_id: human.registration.human_id, issued_at, body}), parseSecretKey(human.key_material.identitySecretKey));
    app = await buildApp({store, publicBaseUrl: "https://vox.example.test", nftService: service});
    const response = await app.inject({method: "POST", url: path, payload: body, headers: {"x-vox-realize-human-id": human.registration.human_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": requestSignature}});
    expect(response.statusCode).toBe(202);
    expect((await store.getNftMint(mint.mint_id))?.state).toBe("queued");
    expect((await store.getNftMint(mint.mint_id))?.owner_wallet).toBe(walletAddress);
  });

  it("exposes the canonical media record, metadata, and all chain statuses", async () => {
    const store = new MemoryStore();
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [adapter("solana:devnet"), adapter("base:sepolia"), adapter("monad:testnet")]});
    const media = await service.ensureMedia(store, input(Keypair.generate().publicKey.toBase58()));
    app = await buildApp({store, publicBaseUrl: "https://vox.example.test", nftService: service});
    const status = await app.inject(`/v1/nft/media/${encodeURIComponent(media.media_id)}`);
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json().media_id).toBe(media.media_id);
    expect(status.json().mints).toHaveLength(3);
    const metadata = await app.inject(`/v1/nft/metadata/${encodeURIComponent(media.media_id)}`);
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().media_id).toBe(media.media_id);
    expect(metadata.json().external_url).toBe(`https://vox.example.test/media/${encodeURIComponent(media.media_id)}`);
    const page = await app.inject(`/media/${encodeURIComponent(media.media_id)}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(media.media_id);
  });

  it("claims a completed output on Monad immediately and never mints again on replay", async () => {
    const store = new MemoryStore();
    const human = createHuman({display_name: "Monad collector", handle: "@monad-collector", description: "test"});
    await store.registerHuman(human.registration);
    const monad = adapter("monad:mainnet");
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [monad]});
    const media = await service.ensureMedia(store, {...input(), owner_id: human.registration.human_id});
    const mint = (await store.listNftMintsForMedia(media.media_id))[0]!;
    const wallet = evmWallet(11);
    const path = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/claim`;
    const body = {wallet: wallet.address, signature: wallet.sign(nftClaimMessage(mint, wallet.address))};
    app = await buildApp({store, nftService: service});
    const first = await app.inject({method: "POST", url: path, payload: body, headers: headers(human, path, body)});
    expect(first.statusCode).toBe(200);
    expect(first.json().state).toBe("finalized");
    const replay = await app.inject({method: "POST", url: path, payload: body, headers: headers(human, path, body)});
    expect(replay.json().state).toBe("finalized");
    expect(monad.prepared).toBe(1);
    expect(monad.submitted).toBe(1);
    const publicStatus = (await app.inject(`/v1/nft/media/${encodeURIComponent(media.media_id)}`)).json();
    expect(publicStatus.mints[0].created_at).toBe(mint.created_at);
  });

  it("rejects another collector and an invalid destination proof; preserves uncertain transactions", async () => {
    const store = new MemoryStore();
    const human = createHuman({display_name: "Owner", handle: "@owner", description: "test"});
    const other = createHuman({display_name: "Other", handle: "@other", description: "test"});
    await store.registerHuman(human.registration);
    await store.registerHuman(other.registration);
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [adapter("monad:mainnet")]});
    const media = await service.ensureMedia(store, {...input(), owner_id: human.registration.human_id});
    const mint = (await store.listNftMintsForMedia(media.media_id))[0]!;
    const wallet = evmWallet(12);
    const path = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/claim`;
    const body = {wallet: wallet.address, signature: wallet.sign(nftClaimMessage(mint, wallet.address))};
    app = await buildApp({store, nftService: service});
    expect((await app.inject({method: "POST", url: path, payload: body, headers: headers(other, path, body)})).statusCode).toBe(403);
    const wrong = {...body, wallet: evmWallet(13).address};
    expect((await app.inject({method: "POST", url: path, payload: wrong, headers: headers(human, path, wrong)})).statusCode).toBe(401);
    const uncertain = {...mint, owner_wallet: wallet.address, state: "manual_review" as const, transaction_id: "saved-tx", signed_transaction: "saved-bytes", updated_at: new Date().toISOString()};
    await store.updateNftMint(uncertain, mint.updated_at);
    expect((await app.inject({method: "POST", url: path, payload: body, headers: headers(human, path, body)})).json().state).toBe("manual_review");
    expect(await store.getNftMint(mint.mint_id)).toMatchObject({state: "manual_review", transaction_id: "saved-tx", signed_transaction: "saved-bytes"});
    const syncPath = `/v1/nft/mints/${encodeURIComponent(mint.mint_id)}/sync`;
    expect((await app.inject({method: "POST", url: syncPath, payload: {}, headers: headers(other, syncPath, {})})).statusCode).toBe(403);
  });

  it("serializes transactions for the same chain across processor instances", async () => {
    const store = new MemoryStore();
    expect(await store.claimNftChain("monad:mainnet", "worker-a", 300)).toBe(true);
    expect(await store.claimNftChain("monad:mainnet", "worker-b", 300)).toBe(false);
    await store.releaseNftChain("monad:mainnet", "worker-b");
    expect(await store.claimNftChain("monad:mainnet", "worker-c", 300)).toBe(false);
    await store.releaseNftChain("monad:mainnet", "worker-a");
    expect(await store.claimNftChain("monad:mainnet", "worker-b", 300)).toBe(true);
  });

  it("does not report an EVM mint as finalized without the expected recipient Transfer", async () => {
    const contract = `0x${"1".repeat(40)}`;
    const tx = `0x${"a".repeat(64)}`;
    const evm = new EvmNftAdapter({chain: "monad:mainnet", rpcUrl: "https://rpc.example.test", chainId: 143, contractAddress: contract, privateKey: new Uint8Array(32).fill(15), explorerBaseUrl: "https://monadscan.com", fetcher: (async (_url, init) => new Response(JSON.stringify({result: JSON.parse(init!.body as string).method === "eth_blockNumber" ? "0x100" : {status: "0x1", to: contract, transactionHash: tx, logs: [], blockNumber: "0x1"}}), {status: 200})) as typeof fetch});
    const store = new MemoryStore();
    const service = new NftMintService({publicBaseUrl: "https://vox.example.test", adapters: [evm]});
    const media = await service.ensureMedia(store, input());
    const mint = (await store.listNftMintsForMedia(media.media_id))[0]!;
    expect(await evm.reconcile({...mint, owner_wallet: evmWallet(16).address, transaction_id: tx})).toMatchObject({state: "manual_review"});
  });
});

import {readFileSync} from "node:fs";
import {createHash, randomUUID} from "node:crypto";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";
import nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import {canonicalBytes, utf8, type FulfillmentResultV1} from "@vox/protocol";
import type {NftChain, NftMediaRecord, NftMintRecord, VoxStore} from "./types.js";

const SOLANA_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SOLANA_NFT_SYMBOL = "VOX";
const MAX_SOLANA_METADATA_URI_BYTES = 200;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EVM_PRIVATE_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const PROCESSING_STATES = new Set<NftMintRecord["state"]>(["queued", "signing", "signed", "submitted", "retryable_failure"]);

export interface NftMediaInput {
  source_kind: NftMediaRecord["source_kind"];
  source_id: string;
  output_index: number;
  source_post_id?: string;
  creator_id?: string;
  owner_id: string;
  owner_wallets?: Partial<Record<"solana" | "base" | "monad" | "arbitrum" | "ethereum" | "hyperevm" | "robinhood", string>>;
  provider_id: string;
  source_content?: string;
  request_parameters: Record<string, unknown>;
  media_uri: string;
  media_page_url?: string;
  media_type: string;
  media_sha256: string;
  byte_length?: number;
  provenance_record_id?: string;
}

export interface NftPreparedTransaction {
  transaction_id: string;
  signed_transaction: string;
  token_id?: string;
  asset_address?: string;
  explorer_url?: string;
  nonce?: string;
  blockhash?: string;
  last_valid_block_height?: number;
}

type NftObservedTransaction = {transaction_id?: string; explorer_url?: string; token_id?: string; asset_address?: string};
export type NftChainObservation =
  | ({state: "submitted"; next_attempt_at?: string} & NftObservedTransaction)
  | ({state: "finalized"} & NftObservedTransaction)
  | ({state: "retryable_failure"; error: string} & NftObservedTransaction)
  | ({state: "manual_review"; error: string} & NftObservedTransaction);

export interface NftChainAdapter {
  readonly chain: NftChain;
  prepare(input: {media: NftMediaRecord; mint: NftMintRecord}): Promise<NftPreparedTransaction>;
  submit(mint: NftMintRecord): Promise<NftChainObservation>;
  reconcile(mint: NftMintRecord): Promise<NftChainObservation>;
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let result = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = alphabet[remainder]! + result;
    number /= 58n;
  }
  return "1".repeat(zeroes) + result;
}

function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("wallet signature is not valid base58");
    number = number * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number % 256n));
    number /= 256n;
  }
  bytes.reverse();
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes += 1;
  return Uint8Array.from([...new Array<number>(zeroes).fill(0), ...bytes]);
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) throw new Error("hex value is invalid");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function chainWalletKey(chain: NftChain): "solana" | "base" | "monad" | "arbitrum" | "ethereum" | "hyperevm" | "robinhood" {
  const [network] = chain.split(":");
  if (network === "solana") return "solana";
  if (network === "base") return "base";
  if (network === "monad") return "monad";
  if (network === "arbitrum") return "arbitrum";
  if (network === "ethereum") return "ethereum";
  if (network === "hyperevm") return "hyperevm";
  if (network === "robinhood") return "robinhood";
  throw new Error(`unsupported NFT chain wallet namespace: ${chain}`);
}

function metadataSummary(input: NftMediaInput): string {
  const source = input.source_content?.replace(/\s+/g, " ").trim();
  const parameters = input.request_parameters;
  const request = typeof parameters.prompt === "string" ? parameters.prompt : typeof parameters.concept === "string" ? parameters.concept : undefined;
  const sourcePart = source ? `Source: ${source.slice(0, 220)}${source.length > 220 ? "…" : ""}.` : "A VOX commissioned media record.";
  const requestPart = request ? ` Request: ${request.slice(0, 220)}${request.length > 220 ? "…" : ""}.` : "";
  return `${sourcePart}${requestPart}`.trim();
}

function mediaIdFor(input: Pick<NftMediaInput, "source_kind" | "source_id" | "output_index" | "media_sha256">): string {
  return `vox:media:${sha256Hex(`${input.source_kind}\u0000${input.source_id}\u0000${input.output_index}\u0000${input.media_sha256}`)}`;
}

function mintIdFor(mediaId: string, chain: NftChain): string {
  return `vox:nft:${sha256Hex(`${mediaId}\u0000${chain}`)}`;
}

function metadataFor(input: NftMediaInput, mediaId: string, metadataUri: string, mediaPageUrl: string): Record<string, unknown> {
  const mediaAttributes = [
    {trait_type: "VOX media ID", value: mediaId},
    {trait_type: "Media type", value: input.media_type},
    {trait_type: "Provider", value: input.provider_id},
    {trait_type: "Media SHA-256", value: input.media_sha256},
    {trait_type: "Request SHA-256", value: canonicalHash(input.request_parameters)},
    {trait_type: "Output index", value: String(input.output_index)},
    ...(input.source_post_id ? [{trait_type: "Source post", value: input.source_post_id}] : []),
    ...(input.creator_id ? [{trait_type: "Creator", value: input.creator_id}] : [])
  ];
  return {
    name: `VOX Realization · ${mediaId.slice(-12)}`,
    description: metadataSummary(input),
    ...(input.media_type.startsWith("image/") ? {image: input.media_uri} : {}),
    ...(input.media_type.startsWith("video/") || input.media_type.startsWith("audio/") ? {animation_url: input.media_uri} : {}),
    external_url: mediaPageUrl,
    media_id: mediaId,
    source: {
      kind: input.source_kind,
      id: input.source_id,
      ...(input.source_post_id ? {post_id: input.source_post_id} : {}),
      ...(input.creator_id ? {creator_id: input.creator_id} : {})
    },
    request: {
      summary: typeof input.request_parameters.prompt === "string" ? input.request_parameters.prompt.slice(0, 240) : typeof input.request_parameters.concept === "string" ? input.request_parameters.concept.slice(0, 240) : "Private generation request",
      sha256: canonicalHash(input.request_parameters)
    },
    media: {
      uri: input.media_uri,
      type: input.media_type,
      sha256: input.media_sha256,
      ...(input.byte_length === undefined ? {} : {byte_length: input.byte_length})
    },
    ...(input.provenance_record_id ? {provenance: {record_id: input.provenance_record_id}} : {}),
    metadata_uri: metadataUri,
    attributes: mediaAttributes
  };
}

function ownerWalletFor(input: NftMediaInput, chain: NftChain): string | undefined {
  return input.owner_wallets?.[chainWalletKey(chain)];
}

function cleanBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || !["http:", "https:"].includes(url.protocol)) throw new Error("NFT public base URL must be an http(s) origin without credentials or query parameters");
  return url.href.replace(/\/+$/, "");
}

function clearLease(record: NftMintRecord): NftMintRecord {
  const {lease_owner: _owner, lease_expires_at: _expires, ...withoutLease} = record;
  return withoutLease;
}

function clearTransient(record: NftMintRecord): NftMintRecord {
  const {lease_owner: _owner, lease_expires_at: _expires, next_attempt_at: _nextAttempt, last_error: _lastError, ...withoutTransient} = record;
  return withoutTransient;
}

function nextAttempt(attempts: number): string {
  const delay = Math.min(60 * 60_000, Math.max(5_000, 2 ** Math.min(attempts, 10) * 1_000));
  return new Date(Date.now() + delay).toISOString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : "NFT chain operation failed";
}

export class NftMintService {
  readonly publicBaseUrl: string;
  readonly adapters: readonly NftChainAdapter[];

  constructor(options: {publicBaseUrl: string; adapters: readonly NftChainAdapter[]}) {
    this.publicBaseUrl = cleanBaseUrl(options.publicBaseUrl);
    const chains = new Set(options.adapters.map((adapter) => adapter.chain));
    if (chains.size !== options.adapters.length) throw new Error("NFT chain adapters must be unique");
    this.adapters = options.adapters;
  }

  async ensureMedia(store: VoxStore, input: NftMediaInput): Promise<NftMediaRecord> {
    if (!/^https:\/\//.test(input.media_uri) && process.env.NODE_ENV === "production") throw new Error("production NFT media must use HTTPS");
    if (!/^[0-9a-f]{64}$/.test(input.media_sha256)) throw new Error("NFT media SHA-256 must be lowercase hexadecimal");
    const mediaId = mediaIdFor(input);
    const metadataUri = `${this.publicBaseUrl}/v1/nft/metadata/${encodeURIComponent(mediaId)}`;
    const mediaPageUrl = input.media_page_url ?? `${this.publicBaseUrl}/media/${encodeURIComponent(mediaId)}`;
    const metadata = metadataFor(input, mediaId, metadataUri, mediaPageUrl);
    const now = new Date().toISOString();
    const record: NftMediaRecord = {
      media_id: mediaId,
      source_kind: input.source_kind,
      source_id: input.source_id,
      output_index: input.output_index,
      ...(input.source_post_id ? {source_post_id: input.source_post_id} : {}),
      ...(input.creator_id ? {creator_id: input.creator_id} : {}),
      owner_id: input.owner_id,
      provider_id: input.provider_id,
      ...(input.source_content ? {source_content: input.source_content} : {}),
      request_parameters: structuredClone(input.request_parameters),
      request_hash: canonicalHash(input.request_parameters),
      media_uri: input.media_uri,
      ...(input.media_page_url ? {media_page_url: input.media_page_url} : {media_page_url: mediaPageUrl}),
      media_type: input.media_type,
      media_sha256: input.media_sha256,
      ...(input.byte_length === undefined ? {} : {byte_length: input.byte_length}),
      ...(input.provenance_record_id ? {provenance_record_id: input.provenance_record_id} : {}),
      metadata_uri: metadataUri,
      metadata_hash: canonicalHash(metadata),
      metadata,
      created_at: now,
      updated_at: now
    };
    const media = await store.createNftMedia(record);
    for (const adapter of this.adapters) {
      const mintId = mintIdFor(media.media_id, adapter.chain);
      const ownerWallet = ownerWalletFor(input, adapter.chain);
      const mint: NftMintRecord = {
        mint_id: mintId,
        media_id: media.media_id,
        chain: adapter.chain,
        owner_id: media.owner_id,
        ...(ownerWallet ? {owner_wallet: ownerWallet} : {}),
        state: ownerWallet ? "queued" : "claimable",
        metadata_uri: media.metadata_uri,
        metadata_hash: media.metadata_hash,
        attempts: 0,
        created_at: now,
        updated_at: now
      };
      await store.createNftMint(mint);
    }
    return media;
  }

  async processPending(store: VoxStore, limit = 30, workerId = "vox-nft-reconcile"): Promise<Array<{mint_id: string; state: NftMintRecord["state"]; error?: string}>> {
    const candidates = await store.listNftMintsForProcessing(Math.min(Math.max(limit, 1), 100));
    return this.processCandidates(store, candidates, workerId);
  }

  async processMint(store: VoxStore, mintId: string, workerId: string): Promise<void> {
    const mint = await store.getNftMint(mintId);
    if (mint && PROCESSING_STATES.has(mint.state)) await this.processCandidates(store, [mint], workerId);
  }

  private async processCandidates(store: VoxStore, candidates: NftMintRecord[], workerId: string): Promise<Array<{mint_id: string; state: NftMintRecord["state"]; error?: string}>> {
    const outcomes: Array<{mint_id: string; state: NftMintRecord["state"]; error?: string}> = [];
    for (const candidate of candidates) {
      const chainLeaseOwner = `${workerId}:${randomUUID()}`;
      if (!await store.claimNftChain(candidate.chain, chainLeaseOwner, 300)) continue;
      try {
        const claimed = await store.claimNftMint(candidate.mint_id, workerId, 300);
        if (!claimed) continue;
        const adapter = this.adapters.find((item) => item.chain === claimed.chain);
        if (!adapter) {
          const failed = clearLease({...claimed, state: "retryable_failure", last_error: "configured NFT chain adapter is unavailable", next_attempt_at: nextAttempt(claimed.attempts), updated_at: new Date().toISOString()});
          const saved = await store.updateNftMint(failed, claimed.updated_at).catch(() => failed);
          outcomes.push({mint_id: saved.mint_id, state: saved.state, ...(saved.last_error ? {error: saved.last_error} : {})});
          continue;
        }
        try {
          let observation: NftChainObservation;
          let currentForObservation = claimed;
          if (claimed.state === "signed") {
            observation = await adapter.submit(claimed);
          } else if (claimed.state === "submitted") {
            observation = await adapter.reconcile(claimed);
          } else {
            if (!claimed.owner_wallet) {
              const claimable = clearLease({...claimed, state: "claimable", updated_at: new Date().toISOString()});
              const saved = await store.updateNftMint(claimable, claimed.updated_at);
              outcomes.push({mint_id: saved.mint_id, state: saved.state});
              continue;
            }
            const media = await store.getNftMedia(claimed.media_id);
            if (!media) throw new Error("canonical NFT media record is missing");
            const prepared = await adapter.prepare({media, mint: claimed});
            const signed = {...claimed, state: "signed" as const, transaction_id: prepared.transaction_id, ...(prepared.token_id ? {token_id: prepared.token_id} : {}), ...(prepared.asset_address ? {asset_address: prepared.asset_address} : {}), ...(prepared.explorer_url ? {explorer_url: prepared.explorer_url} : {}), signed_transaction: prepared.signed_transaction, ...(prepared.nonce ? {nonce: prepared.nonce} : {}), ...(prepared.blockhash ? {blockhash: prepared.blockhash} : {}), ...(prepared.last_valid_block_height === undefined ? {} : {last_valid_block_height: prepared.last_valid_block_height}), updated_at: new Date().toISOString()};
            const stored = await store.updateNftMint(signed, claimed.updated_at);
            observation = await adapter.submit(stored);
            currentForObservation = stored;
          }
          const updated = this.applyObservation(currentForObservation, observation);
          const saved = await store.updateNftMint(updated, currentForObservation.updated_at).catch(async () => await store.getNftMint(currentForObservation.mint_id) ?? updated);
          outcomes.push({mint_id: saved.mint_id, state: saved.state, ...(saved.last_error ? {error: saved.last_error} : {})});
        } catch (error) {
          const latest = await store.getNftMint(claimed.mint_id) ?? claimed;
          const uncertain = latest.state === "signed" || latest.state === "submitted";
          const failed = clearLease({
            ...latest,
            state: uncertain ? "manual_review" : "retryable_failure",
            last_error: errorText(error),
            ...(uncertain ? {} : {next_attempt_at: nextAttempt(latest.attempts)}),
            updated_at: new Date().toISOString()
          });
          const saved = await store.updateNftMint(failed, latest.updated_at).catch(() => failed);
          outcomes.push({mint_id: saved.mint_id, state: saved.state, ...(saved.last_error ? {error: saved.last_error} : {})});
        }
      } finally {
        await store.releaseNftChain(candidate.chain, chainLeaseOwner);
      }
    }
    return outcomes;
  }

  private applyObservation(current: NftMintRecord, observation: NftChainObservation): NftMintRecord {
    const {last_error: _lastError, next_attempt_at: _nextAttemptAt, ...withoutPriorError} = current;
    const common = {
      ...withoutPriorError,
      ...(observation.transaction_id ? {transaction_id: observation.transaction_id} : {}),
      ...(observation.token_id ? {token_id: observation.token_id} : {}),
      ...(observation.asset_address ? {asset_address: observation.asset_address} : {}),
      ...(observation.explorer_url ? {explorer_url: observation.explorer_url} : {}),
      updated_at: new Date().toISOString()
    };
    if (observation.state === "finalized") return clearLease({...common, state: "finalized"});
    if (observation.state === "submitted") return clearLease({...common, state: "submitted", next_attempt_at: observation.next_attempt_at ?? new Date(Date.now() + 30_000).toISOString()});
    if (observation.state === "manual_review") return clearLease({...common, state: "manual_review", last_error: observation.error});
    return clearLease({...common, state: "retryable_failure", next_attempt_at: nextAttempt(current.attempts), last_error: observation.error});
  }
}

export function nftMediaIdFor(input: Pick<NftMediaInput, "source_kind" | "source_id" | "output_index" | "media_sha256">): string {
  return mediaIdFor(input);
}

export function nftClaimMessage(mint: Pick<NftMintRecord, "mint_id" | "chain" | "created_at">, wallet: string): string {
  return `VOX NFT claim\nMint: ${mint.mint_id}\nChain: ${mint.chain}\nWallet: ${wallet}\nCreated: ${mint.created_at}`;
}

export function verifyNftWalletProof(mint: NftMintRecord, wallet: string, signature: string): boolean {
  try {
    const message = nftClaimMessage(mint, wallet);
    if (mint.chain.startsWith("solana:")) {
      if (signature.length < 80 || !PublicKey.isOnCurve(new PublicKey(wallet).toBytes())) return false;
      return nacl.sign.detached.verify(utf8(message), base58Decode(signature), new PublicKey(wallet).toBytes());
    }
    if (!EVM_ADDRESS_PATTERN.test(wallet) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    const signatureBytes = hexToBytes(signature);
    const recovery = signatureBytes[64] === 27 || signatureBytes[64] === 28 ? signatureBytes[64] - 27 : signatureBytes[64];
    if (recovery !== 0 && recovery !== 1) return false;
    const prefix = utf8(`\x19Ethereum Signed Message:\n${new TextEncoder().encode(message).length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...utf8(message)]));
    const point = secp256k1.Signature.fromCompact(signatureBytes.slice(0, 64)).addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
    const recovered = `0x${bytesToHex(keccak_256(point.slice(1)).slice(-20))}`;
    return recovered.toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

function encodeMetadataString(value: string): Uint8Array {
  const bytes = utf8(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return new Uint8Array([...length, ...bytes]);
}

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("metadata"), SOLANA_METADATA_PROGRAM_ID.toBytes(), mint.toBytes()], SOLANA_METADATA_PROGRAM_ID)[0];
}

function createMetadataAccountV3Instruction(input: {metadata: PublicKey; mint: PublicKey; authority: PublicKey; payer: PublicKey; uri: string; name: string}): TransactionInstruction {
  const data = new Uint8Array([
    33,
    ...encodeMetadataString(input.name.slice(0, 32)),
    ...encodeMetadataString(SOLANA_NFT_SYMBOL),
    ...encodeMetadataString(input.uri),
    0,
    0,
    0,
    0,
    1,
    0
  ]);
  return new TransactionInstruction({
    programId: SOLANA_METADATA_PROGRAM_ID,
    keys: [
      {pubkey: input.metadata, isSigner: false, isWritable: true},
      {pubkey: input.mint, isSigner: false, isWritable: false},
      {pubkey: input.authority, isSigner: true, isWritable: false},
      {pubkey: input.payer, isSigner: true, isWritable: true},
      {pubkey: input.authority, isSigner: true, isWritable: false},
      {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
      {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false}
    ],
    data: Buffer.from(data)
  });
}

export interface SolanaNftAdapterOptions {
  chain: "solana:devnet" | "solana:mainnet-beta";
  rpcUrl: string;
  keypair: Keypair;
  connection?: Connection;
  explorerCluster?: "devnet" | "mainnet-beta";
}

export class SolanaNftAdapter implements NftChainAdapter {
  readonly chain: "solana:devnet" | "solana:mainnet-beta";
  readonly connection: Connection;
  private readonly signer: Keypair;
  private readonly explorerCluster: "devnet" | "mainnet-beta";

  constructor(options: SolanaNftAdapterOptions) {
    const rpc = new URL(options.rpcUrl);
    if (rpc.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && rpc.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(rpc.hostname))) throw new Error("NFT Solana RPC must be HTTPS outside local development");
    this.chain = options.chain;
    this.signer = options.keypair;
    this.connection = options.connection ?? new Connection(rpc.href, "finalized");
    this.explorerCluster = options.explorerCluster ?? (options.chain === "solana:devnet" ? "devnet" : "mainnet-beta");
  }

  async prepare(input: {media: NftMediaRecord; mint: NftMintRecord}): Promise<NftPreparedTransaction> {
    if (!input.mint.owner_wallet || !PublicKey.isOnCurve(new PublicKey(input.mint.owner_wallet).toBytes())) throw new Error("Solana NFT owner wallet is invalid");
    if (input.media.metadata_uri.length > MAX_SOLANA_METADATA_URI_BYTES) throw new Error("NFT metadata URI exceeds the Solana Token Metadata limit");
    const owner = new PublicKey(input.mint.owner_wallet);
    const mint = Keypair.generate();
    const metadata = metadataPda(mint.publicKey);
    const tokenAccount = getAssociatedTokenAddressSync(mint.publicKey, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const {blockhash, lastValidBlockHeight} = await this.connection.getLatestBlockhash("finalized");
    const rent = await this.connection.getMinimumBalanceForRentExemption(MINT_SIZE, "finalized");
    const transaction = new Transaction({feePayer: this.signer.publicKey, recentBlockhash: blockhash});
    transaction.add(
      SystemProgram.createAccount({fromPubkey: this.signer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID}),
      createInitializeMintInstruction(mint.publicKey, 0, this.signer.publicKey, this.signer.publicKey, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, tokenAccount, owner, mint.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createMintToInstruction(mint.publicKey, tokenAccount, this.signer.publicKey, 1, [], TOKEN_PROGRAM_ID),
      createSetAuthorityInstruction(mint.publicKey, this.signer.publicKey, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
      createSetAuthorityInstruction(mint.publicKey, this.signer.publicKey, AuthorityType.FreezeAccount, null, [], TOKEN_PROGRAM_ID),
      createMetadataAccountV3Instruction({metadata, mint: mint.publicKey, authority: this.signer.publicKey, payer: this.signer.publicKey, uri: input.media.metadata_uri, name: String(input.media.metadata.name ?? `VOX ${input.media.media_id}`).slice(0, 32)})
    );
    transaction.sign(this.signer, mint);
    const simulation = await this.connection.simulateTransaction(transaction);
    if (simulation.value.err) throw new Error(`Solana NFT transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
    const signature = transaction.signature;
    if (!signature) throw new Error("Solana NFT transaction was not signed");
    const transactionId = base58Encode(signature);
    return {
      transaction_id: transactionId,
      signed_transaction: transaction.serialize().toString("base64"),
      asset_address: mint.publicKey.toBase58(),
      explorer_url: `https://explorer.solana.com/tx/${encodeURIComponent(transactionId)}?cluster=${this.explorerCluster}`,
      blockhash,
      last_valid_block_height: lastValidBlockHeight
    };
  }

  async submit(mint: NftMintRecord): Promise<NftChainObservation> {
    return this.sendAndObserve(mint);
  }

  async reconcile(mint: NftMintRecord): Promise<NftChainObservation> {
    return this.observe(mint);
  }

  private async sendAndObserve(mint: NftMintRecord): Promise<NftChainObservation> {
    const observed = await this.observe(mint);
    if (observed.state !== "submitted") return observed;
    if (!mint.signed_transaction || !mint.transaction_id || !mint.blockhash || mint.last_valid_block_height === undefined) throw new Error("stored Solana NFT transaction is incomplete");
    try {
      const sent = await this.connection.sendRawTransaction(Buffer.from(mint.signed_transaction, "base64"), {preflightCommitment: "confirmed", maxRetries: 3});
      if (sent !== mint.transaction_id) return {state: "manual_review", error: "Solana RPC returned a different NFT transaction signature", transaction_id: sent, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    } catch {
      // Rebroadcasting the same signed transaction is safe; the subsequent status read decides the outcome.
    }
    try { await this.connection.confirmTransaction({signature: mint.transaction_id, blockhash: mint.blockhash, lastValidBlockHeight: mint.last_valid_block_height}, "finalized"); } catch { /* reconcile below */ }
    return this.observe(mint);
  }

  private async observe(mint: NftMintRecord): Promise<NftChainObservation> {
    if (!mint.transaction_id) return {state: "manual_review", error: "Solana NFT transaction identity is missing"};
    const status = (await this.connection.getSignatureStatuses([mint.transaction_id], {searchTransactionHistory: true})).value[0];
    if (!status) {
      if (mint.last_valid_block_height !== undefined && await this.connection.getBlockHeight("finalized") > mint.last_valid_block_height) return {state: "manual_review", error: "Solana NFT transaction blockhash expired without a resolvable result", transaction_id: mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
      return {state: "submitted", transaction_id: mint.transaction_id, ...(mint.asset_address ? {asset_address: mint.asset_address} : {}), ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    }
    if (status.err) return {state: "retryable_failure", error: `Solana NFT transaction failed: ${JSON.stringify(status.err)}`, transaction_id: mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    if (status.confirmationStatus === "finalized") return {state: "finalized", transaction_id: mint.transaction_id, ...(mint.asset_address ? {asset_address: mint.asset_address} : {}), ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    return {state: "submitted", transaction_id: mint.transaction_id, ...(mint.asset_address ? {asset_address: mint.asset_address} : {}), ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
  }
}

interface RlpValue {
  bytes?: Uint8Array;
  list?: RlpValue[];
}

function rlpBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0]! < 0x80) return value;
  if (value.length <= 55) return Uint8Array.from([0x80 + value.length, ...value]);
  const length = bigintBytes(BigInt(value.length));
  return Uint8Array.from([0xb7 + length.length, ...length, ...value]);
}

function rlpList(values: RlpValue[]): Uint8Array {
  const payload = Uint8Array.from(values.flatMap((value) => value.list ? [...rlpList(value.list)] : [...rlpBytes(value.bytes ?? new Uint8Array())]));
  if (payload.length <= 55) return Uint8Array.from([0xc0 + payload.length, ...payload]);
  const length = bigintBytes(BigInt(payload.length));
  return Uint8Array.from([0xf7 + length.length, ...length, ...payload]);
}

function bigintBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const bytes: number[] = [];
  let current = value;
  while (current > 0n) {
    bytes.push(Number(current & 0xffn));
    current >>= 8n;
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}

function rlpBigint(value: bigint): RlpValue {
  return {bytes: bigintBytes(value)};
}

function rlpHex(value: string): RlpValue {
  return {bytes: hexToBytes(value)};
}

function pad32(value: Uint8Array): Uint8Array {
  if (value.length > 32) throw new Error("EVM ABI value exceeds 32 bytes");
  return Uint8Array.from([...new Array<number>(32 - value.length).fill(0), ...value]);
}

function evmMintCalldata(owner: string, metadataUri: string): string {
  const selector = keccak_256(utf8("mint(address,string)")).slice(0, 4);
  const addressWord = pad32(hexToBytes(owner));
  const offsetWord = pad32(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64]));
  const uri = utf8(metadataUri);
  const uriLength = pad32(bigintBytes(BigInt(uri.length)));
  const paddedUri = Uint8Array.from([...uri, ...new Array<number>((32 - (uri.length % 32)) % 32).fill(0)]);
  return `0x${bytesToHex(Uint8Array.from([...selector, ...addressWord, ...offsetWord, ...uriLength, ...paddedUri]))}`;
}

function privateKeyFromFile(path: string): Uint8Array {
  const raw = readFileSync(path, "utf8").trim();
  if (EVM_PRIVATE_KEY_PATTERN.test(raw)) return hexToBytes(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("EVM NFT signer file must contain a 32-byte hex key or byte array"); }
  if (!Array.isArray(parsed) || parsed.length !== 32 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("EVM NFT signer file must contain a 32-byte byte array");
  return Uint8Array.from(parsed as number[]);
}

function evmAddressFromPrivateKey(privateKey: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20))}`;
}

function rpcHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function parseRpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${label} RPC quantity is invalid`);
  return BigInt(value);
}

export interface EvmNftAdapterOptions {
  chain: "base:sepolia" | "base:mainnet" | "monad:testnet" | "monad:mainnet" | "arbitrum:mainnet" | "ethereum:mainnet" | "hyperevm:mainnet" | "robinhood:mainnet";
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  privateKey: Uint8Array;
  confirmations?: number;
  explorerBaseUrl: string;
  fetcher?: typeof fetch;
}

export class EvmNftAdapter implements NftChainAdapter {
  readonly chain: EvmNftAdapterOptions["chain"];
  private readonly rpcUrl: string;
  private readonly chainId: number;
  private readonly contractAddress: string;
  private readonly privateKey: Uint8Array;
  private readonly signerAddress: string;
  private readonly confirmations: number;
  private readonly explorerBaseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: EvmNftAdapterOptions) {
    const rpc = new URL(options.rpcUrl);
    if (rpc.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && rpc.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(rpc.hostname))) throw new Error("EVM NFT RPC must be HTTPS outside local development");
    if (!Number.isInteger(options.chainId) || options.chainId <= 0) throw new Error("EVM NFT chain ID is invalid");
    if (!EVM_ADDRESS_PATTERN.test(options.contractAddress)) throw new Error("EVM NFT contract address is invalid");
    if (options.privateKey.length !== 32) throw new Error("EVM NFT signer key must be 32 bytes");
    this.chain = options.chain;
    this.rpcUrl = rpc.href;
    this.chainId = options.chainId;
    this.contractAddress = options.contractAddress.toLowerCase();
    this.privateKey = new Uint8Array(options.privateKey);
    this.signerAddress = evmAddressFromPrivateKey(this.privateKey);
    this.confirmations = Math.max(1, options.confirmations ?? 12);
    this.explorerBaseUrl = options.explorerBaseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  async prepare(input: {media: NftMediaRecord; mint: NftMintRecord}): Promise<NftPreparedTransaction> {
    if (!input.mint.owner_wallet || !EVM_ADDRESS_PATTERN.test(input.mint.owner_wallet)) throw new Error("EVM NFT owner wallet is invalid");
    const chainId = parseRpcQuantity(await this.rpc("eth_chainId", []), "chain");
    if (chainId !== BigInt(this.chainId)) throw new Error(`EVM NFT RPC chain ID ${chainId} does not match configured ${this.chainId}`);
    const nonce = parseRpcQuantity(await this.rpc("eth_getTransactionCount", [this.signerAddress, "pending"]), "nonce");
    const priority = await this.rpc("eth_maxPriorityFeePerGas", []).then((value) => parseRpcQuantity(value, "priority fee")).catch(() => 1_000_000_000n);
    const gasPrice = parseRpcQuantity(await this.rpc("eth_gasPrice", []), "gas price");
    const maxFee = gasPrice * 2n + priority;
    const data = evmMintCalldata(input.mint.owner_wallet, input.media.metadata_uri);
    const estimate = parseRpcQuantity(await this.rpc("eth_estimateGas", [{from: this.signerAddress, to: this.contractAddress, value: "0x0", data}]), "gas estimate");
    const gasLimit = estimate + estimate / 5n + 10_000n;
    const unsigned = rlpList([
      rlpBigint(BigInt(this.chainId)), rlpBigint(nonce), rlpBigint(priority), rlpBigint(maxFee), rlpBigint(gasLimit), rlpHex(this.contractAddress), rlpBigint(0n), rlpHex(data), {list: []}
    ]);
    const signingPayload = Uint8Array.from([2, ...unsigned]);
    const digest = keccak_256(signingPayload);
    const signature = secp256k1.sign(digest, this.privateKey, {lowS: true});
    const signed = rlpList([
      rlpBigint(BigInt(this.chainId)), rlpBigint(nonce), rlpBigint(priority), rlpBigint(maxFee), rlpBigint(gasLimit), rlpHex(this.contractAddress), rlpBigint(0n), rlpHex(data), {list: []}, rlpBigint(BigInt(signature.recovery ?? 0)), rlpBigint(BigInt(`0x${bytesToHex(signature.toCompactRawBytes().slice(0, 32))}`)), rlpBigint(BigInt(`0x${bytesToHex(signature.toCompactRawBytes().slice(32))}`))
    ]);
    const raw = Uint8Array.from([2, ...signed]);
    const transactionId = `0x${bytesToHex(keccak_256(raw))}`;
    return {transaction_id: transactionId, signed_transaction: `0x${bytesToHex(raw)}`, asset_address: this.contractAddress, explorer_url: `${this.explorerBaseUrl}/tx/${transactionId}`, nonce: nonce.toString()};
  }

  async submit(mint: NftMintRecord): Promise<NftChainObservation> {
    const observed = await this.observe(mint);
    if (observed.state !== "submitted") return observed;
    if (!mint.signed_transaction || !mint.transaction_id) throw new Error("stored EVM NFT transaction is incomplete");
    try {
      const sent = await this.rpc("eth_sendRawTransaction", [mint.signed_transaction]);
      if (typeof sent !== "string" || sent.toLowerCase() !== mint.transaction_id.toLowerCase()) return {state: "manual_review", error: "EVM RPC returned a different NFT transaction hash", transaction_id: typeof sent === "string" ? sent : mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    } catch {
      // The signed bytes are durable and are intentionally retried unchanged.
    }
    return this.observe(mint);
  }

  async reconcile(mint: NftMintRecord): Promise<NftChainObservation> {
    return this.submit(mint);
  }

  private async observe(mint: NftMintRecord): Promise<NftChainObservation> {
    if (!mint.transaction_id) return {state: "manual_review", error: "EVM NFT transaction identity is missing"};
    const receipt = await this.rpc("eth_getTransactionReceipt", [mint.transaction_id]);
    if (receipt === null) return {state: "submitted", transaction_id: mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    if (!receipt || typeof receipt !== "object") return {state: "manual_review", error: "EVM NFT receipt response is invalid", transaction_id: mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    const receiptObject = receipt as {status?: unknown; blockNumber?: unknown; logs?: unknown; to?: unknown; transactionHash?: unknown};
    if (typeof receiptObject.to !== "string" || receiptObject.to.toLowerCase() !== this.contractAddress || typeof receiptObject.transactionHash !== "string" || receiptObject.transactionHash.toLowerCase() !== mint.transaction_id.toLowerCase()) return {state: "manual_review", error: "EVM NFT receipt does not match the configured contract and transaction", transaction_id: mint.transaction_id};
    if (receiptObject.status !== "0x1") return {state: "retryable_failure", error: "EVM NFT transaction reverted", transaction_id: mint.transaction_id, ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    const tokenId = this.receiptTokenId(receiptObject.logs, mint.owner_wallet);
    if (!tokenId) return {state: "manual_review", error: "EVM NFT receipt has no mint Transfer to the bound owner wallet", transaction_id: mint.transaction_id};
    const blockNumber = parseRpcQuantity(receiptObject.blockNumber, "receipt block");
    const latest = parseRpcQuantity(await this.rpc("eth_blockNumber", []), "latest block");
    if (latest + 1n - blockNumber < BigInt(this.confirmations)) return {state: "submitted", transaction_id: mint.transaction_id, ...(mint.asset_address ? {asset_address: mint.asset_address} : {}), ...(tokenId ? {token_id: tokenId} : {}), ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
    const uriData = `0x${bytesToHex(keccak_256(utf8("tokenURI(uint256)")).slice(0, 4))}${bytesToHex(pad32(bigintBytes(BigInt(tokenId))))}`;
    const encodedUri = await this.rpc("eth_call", [{to: this.contractAddress, data: uriData}, "latest"]);
    if (typeof encodedUri !== "string") return {state: "manual_review", error: "EVM NFT token URI is unavailable", transaction_id: mint.transaction_id};
    const uriBytes = hexToBytes(encodedUri);
    const offset = Number(BigInt(`0x${bytesToHex(uriBytes.slice(0, 32)) || "0"}`));
    const length = Number(BigInt(`0x${bytesToHex(uriBytes.slice(offset, offset + 32)) || "0"}`));
    if (offset !== 32 || !Number.isSafeInteger(length) || length < 1 || offset + 32 + length > uriBytes.length || new TextDecoder().decode(uriBytes.slice(offset + 32, offset + 32 + length)) !== mint.metadata_uri) return {state: "manual_review", error: "EVM NFT token URI does not match canonical VOX metadata", transaction_id: mint.transaction_id};
    return {state: "finalized", transaction_id: mint.transaction_id, ...(mint.asset_address ? {asset_address: mint.asset_address} : {}), ...(tokenId ? {token_id: tokenId} : {}), ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {})};
  }

  private receiptTokenId(rawLogs: unknown, ownerWallet: string | undefined): string | undefined {
    if (!ownerWallet || !EVM_ADDRESS_PATTERN.test(ownerWallet)) return undefined;
    if (!Array.isArray(rawLogs)) return undefined;
    const transferTopic = `0x${bytesToHex(keccak_256(utf8("Transfer(address,address,uint256)")))}`;
    for (const rawLog of rawLogs) {
      if (!rawLog || typeof rawLog !== "object") continue;
      const log = rawLog as {address?: unknown; topics?: unknown};
      if (typeof log.address !== "string" || log.address.toLowerCase() !== this.contractAddress || !Array.isArray(log.topics) || log.topics.length < 4 || log.topics[0] !== transferTopic || log.topics[1] !== `0x${"0".repeat(64)}`) continue;
      if (typeof log.topics[2] !== "string" || log.topics[2].toLowerCase() !== `0x${ownerWallet.slice(2).toLowerCase().padStart(64, "0")}`) continue;
      const tokenTopic = log.topics[3];
      if (typeof tokenTopic === "string" && /^0x[0-9a-f]+$/i.test(tokenTopic)) return BigInt(tokenTopic).toString();
    }
    return undefined;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.rpcUrl, {method: "POST", headers: {"content-type": "application/json"}, body: jsonString({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error(`EVM RPC returned HTTP ${response.status}`);
    const payload = await response.json() as {result?: unknown; error?: {message?: string}};
    if (payload.error) throw new Error(payload.error.message ?? `EVM RPC ${method} failed`);
    return payload.result;
  }
}

function keyPath(env: Readonly<Record<string, string | undefined>>, chain: NftChain, suffix: "RPC_URL" | "SIGNER_KEY_PATH" | "CONTRACT" | "CHAIN_ID"): string | undefined {
  const key = chain.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return env[`VOX_NFT_${key}_${suffix}`]?.trim() || undefined;
}

function solanaSigner(path: string): Keypair {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Solana NFT signer file is not valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Solana NFT signer file must contain a 64-byte byte array");
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

function explorerBase(chain: NftChain): string {
  switch (chain) {
    case "solana:devnet": return "https://explorer.solana.com";
    case "solana:mainnet-beta": return "https://explorer.solana.com";
    case "base:sepolia": return "https://sepolia.basescan.org";
    case "base:mainnet": return "https://basescan.org";
    case "monad:testnet": return "https://testnet.monadexplorer.com";
    case "monad:mainnet": return "https://monadscan.com";
    case "arbitrum:mainnet": return "https://arbiscan.io";
    case "ethereum:mainnet": return "https://etherscan.io";
    case "hyperevm:mainnet": return "https://hyperevmscan.io";
    case "robinhood:mainnet": return "https://robinhoodchain.blockscout.com";
  }
}

function chainExplorerSuffix(chain: NftChain): "devnet" | "mainnet-beta" | undefined {
  return chain === "solana:devnet" ? "devnet" : chain === "solana:mainnet-beta" ? "mainnet-beta" : undefined;
}

export function configuredNftService(publicBaseUrl: string, env: Readonly<Record<string, string | undefined>> = process.env): NftMintService | undefined {
  if (env.VOX_NFT_ENABLED !== "true") return undefined;
  const rawChains = (env.VOX_NFT_CHAINS ?? "").split(",").map((value) => value.trim()).filter(Boolean) as NftChain[];
  const supportedChains = ["solana:devnet", "solana:mainnet-beta", "base:sepolia", "base:mainnet", "monad:testnet", "monad:mainnet", "arbitrum:mainnet", "ethereum:mainnet", "hyperevm:mainnet", "robinhood:mainnet"] as const;
  if (rawChains.length === 0 || rawChains.some((chain) => !(supportedChains as readonly string[]).includes(chain))) throw new Error("VOX_NFT_CHAINS must contain supported, comma-separated chain IDs");
  const adapters: NftChainAdapter[] = [];
  for (const chain of [...new Set(rawChains)]) {
    const mainnet = chain.endsWith(":mainnet") || chain === "solana:mainnet-beta";
    if (mainnet && (env.VOX_NFT_MAINNET_ENABLED !== "true" || env.VOX_CONFIRM_NFT_MAINNET !== "1" || env.VOX_DEPLOYMENT_ENV !== "production")) throw new Error("NFT Mainnet requires VOX_NFT_MAINNET_ENABLED=true, VOX_CONFIRM_NFT_MAINNET=1, and VOX_DEPLOYMENT_ENV=production");
    const rpcUrl = keyPath(env, chain, "RPC_URL");
    const signerPath = keyPath(env, chain, "SIGNER_KEY_PATH");
    if (!rpcUrl || !signerPath) throw new Error(`NFT ${chain} requires an RPC URL and dedicated signer key path`);
    if (chain.startsWith("solana:")) {
      const explorerCluster = chainExplorerSuffix(chain);
      adapters.push(new SolanaNftAdapter({chain: chain as SolanaNftAdapterOptions["chain"], rpcUrl, keypair: solanaSigner(signerPath), ...(explorerCluster ? {explorerCluster} : {})}));
      continue;
    }
    const contract = keyPath(env, chain, "CONTRACT");
    const chainIdText = keyPath(env, chain, "CHAIN_ID");
    if (!contract || !chainIdText || !/^[1-9][0-9]{0,10}$/.test(chainIdText)) throw new Error(`NFT ${chain} requires a deployed contract and numeric chain ID`);
    const privateKey = privateKeyFromFile(signerPath);
    const confirmations = Number.parseInt(env.VOX_NFT_EVM_CONFIRMATIONS ?? "12", 10);
    if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 256) throw new Error("VOX_NFT_EVM_CONFIRMATIONS must be an integer from 1 to 256");
    adapters.push(new EvmNftAdapter({chain: chain as EvmNftAdapterOptions["chain"], rpcUrl, chainId: Number(chainIdText), contractAddress: contract, privateKey, confirmations, explorerBaseUrl: explorerBase(chain)}));
  }
  return new NftMintService({publicBaseUrl, adapters});
}

export function fulfillmentOutputToNftInput(input: {commissionId: string; ownerId: string; ownerWallet?: string; creatorId: string; providerId: string; sourcePostId?: string; sourceContent?: string; requestParameters: Record<string, unknown>; provenanceRecordId?: string; result: FulfillmentResultV1; outputIndex: number; publicBaseUrl: string}): NftMediaInput {
  const output = input.result.outputs[input.outputIndex];
  if (!output) throw new Error("fulfillment output does not exist");
  return {
    source_kind: "realize_commission",
    source_id: input.commissionId,
    output_index: input.outputIndex,
    ...(input.sourcePostId ? {source_post_id: input.sourcePostId} : {}),
    creator_id: input.creatorId,
    owner_id: input.ownerId,
    ...(input.ownerWallet ? {owner_wallets: {solana: input.ownerWallet}} : {}),
    provider_id: input.providerId,
    ...(input.sourceContent ? {source_content: input.sourceContent} : {}),
    request_parameters: input.requestParameters,
    media_uri: output.uri,
    media_page_url: `${input.publicBaseUrl}/media/${encodeURIComponent(mediaIdFor({source_kind: "realize_commission", source_id: input.commissionId, output_index: input.outputIndex, media_sha256: output.sha256}))}`,
    media_type: output.media_type,
    media_sha256: output.sha256,
    byte_length: output.byte_length,
    ...(input.provenanceRecordId ? {provenance_record_id: input.provenanceRecordId} : {})
  };
}

export function legacyRealizationToNftInput(input: {realizationId: string; ownerId: string; ownerWallet?: string; providerId: string; postId: string; sourceContent?: string; requestParameters: Record<string, unknown>; mediaUri: string; mediaHash: string; publicBaseUrl: string}): NftMediaInput {
  return {
    source_kind: "realization",
    source_id: input.realizationId,
    output_index: 0,
    source_post_id: input.postId,
    owner_id: input.ownerId,
    ...(input.ownerWallet ? {owner_wallets: {solana: input.ownerWallet}} : {}),
    provider_id: input.providerId,
    ...(input.sourceContent ? {source_content: input.sourceContent} : {}),
    request_parameters: input.requestParameters,
    media_uri: input.mediaUri,
    media_page_url: `${input.publicBaseUrl}/media/${encodeURIComponent(mediaIdFor({source_kind: "realization", source_id: input.realizationId, output_index: 0, media_sha256: input.mediaHash}))}`,
    media_type: "video/mp4",
    media_sha256: input.mediaHash
  };
}

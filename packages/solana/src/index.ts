import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Commitment
} from "@solana/web3.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  domainHash,
  hexToBytes,
  sha256,
  utf8,
  type AnchorReceiptV1
} from "@vox/protocol";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAGIC = utf8("VOX");
const COMMITMENT_VERSION = 1;
const PAYLOAD_LENGTH = 3 + 1 + 1 + 32 + 32 + 32 + 32;

export type CommitmentType = "BATCH" | "POST";

export interface CommitmentInput {
  type: CommitmentType;
  authority_id: string;
  reference_hash: string;
  root_or_post_hash: string;
  manifest_hash?: string;
}

export interface DecodedCommitment {
  version: number;
  type: CommitmentType;
  authority_hash: string;
  reference_hash: string;
  root_or_post_hash: string;
  manifest_hash: string;
}

function authorityHash(authorityId: string): Uint8Array {
  return domainHash("vox.anchor.authority.v1", utf8(authorityId));
}

export function isValidSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function epochReferenceHash(epoch: string): string {
  return bytesToHex(domainHash("vox.epoch.v1", utf8(epoch)));
}

export function encodeCommitment(input: CommitmentInput): Uint8Array {
  const reference = hexToBytes(input.reference_hash);
  const root = hexToBytes(input.root_or_post_hash);
  if (reference.length !== 32 || root.length !== 32) throw new Error("Commitment hashes must be SHA-256 digests");
  const manifest = input.manifest_hash ? hexToBytes(input.manifest_hash) : new Uint8Array(32);
  if (manifest.length !== 32) throw new Error("Manifest hash must be a SHA-256 digest");
  return concatBytes(
    MAGIC,
    new Uint8Array([COMMITMENT_VERSION, input.type === "BATCH" ? 1 : 2]),
    authorityHash(input.authority_id),
    reference,
    root,
    manifest
  );
}

export function decodeCommitment(payload: Uint8Array): DecodedCommitment | undefined {
  if (payload.length !== PAYLOAD_LENGTH || !payload.slice(0, 3).every((byte, index) => byte === MAGIC[index])) return undefined;
  if (payload[3] !== COMMITMENT_VERSION || (payload[4] !== 1 && payload[4] !== 2)) return undefined;
  return {
    version: payload[3]!,
    type: payload[4] === 1 ? "BATCH" : "POST",
    authority_hash: bytesToHex(payload.slice(5, 37)),
    reference_hash: bytesToHex(payload.slice(37, 69)),
    root_or_post_hash: bytesToHex(payload.slice(69, 101)),
    manifest_hash: bytesToHex(payload.slice(101, 133))
  };
}

export function commitmentMatches(payload: Uint8Array, input: CommitmentInput): boolean {
  const decoded = decodeCommitment(payload);
  return !!decoded && decoded.type === input.type &&
    decoded.authority_hash === bytesToHex(authorityHash(input.authority_id)) &&
    decoded.reference_hash === input.reference_hash &&
    decoded.root_or_post_hash === input.root_or_post_hash &&
    decoded.manifest_hash === (input.manifest_hash ?? "0".repeat(64));
}

export function createMemoTransaction(payload: Uint8Array): Transaction {
  if (payload.length > 566) throw new Error("Memo payload exceeds the conservative Solana transaction data budget");
  return new Transaction().add(new TransactionInstruction({programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(payload)}));
}

export function keypairFromSecretKeyBase64Url(value: string): Keypair {
  const secret = base64UrlToBytes(value);
  if (secret.length !== 64) throw new Error("Solana anchor secret key must be a 64-byte Ed25519 secret key");
  return Keypair.fromSecretKey(secret);
}

export interface SubmitCommitmentInput {
  rpc_url: string;
  anchor_secret_key: string;
  commitment: CommitmentInput;
  commitment_level?: Commitment;
}

export class SolanaSubmissionUncertainError extends Error {
  readonly signature: string | undefined;

  constructor(message: string, signature?: string) {
    super(message);
    this.name = "SolanaSubmissionUncertainError";
    if (signature !== undefined) this.signature = signature;
  }
}

export interface CommitmentInspection {
  status: "missing" | "confirmed" | "finalized" | "failed";
  matches: boolean;
  finalized: boolean;
  payload_base64url?: string;
}

export async function submitCommitment(input: SubmitCommitmentInput): Promise<{signature: string; finalized: boolean; payload_base64url: string}> {
  const connection = new Connection(input.rpc_url, input.commitment_level ?? "confirmed");
  const payer = keypairFromSecretKeyBase64Url(input.anchor_secret_key);
  const payload = encodeCommitment(input.commitment);
  const transaction = createMemoTransaction(payload);
  let signature: string;
  try {
    signature = await connection.sendTransaction(transaction, [payer]);
  } catch (error) {
    throw new SolanaSubmissionUncertainError(error instanceof Error ? error.message : "Solana transaction submission failed");
  }
  try {
    const confirmation = await connection.confirmTransaction(signature, input.commitment_level ?? "confirmed");
    if (confirmation.value.err) throw new Error("Solana transaction was rejected");
  } catch (error) {
    throw new SolanaSubmissionUncertainError(error instanceof Error ? error.message : "Solana transaction confirmation failed", signature);
  }
  const finalized = await verifyFinalizedTransaction(input.rpc_url, signature, payload);
  return {signature, finalized, payload_base64url: bytesToBase64Url(payload)};
}


function base58Decode(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base58 transaction data");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const current = bytes[index]! * 58 + carry;
      bytes[index] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let index = 0; index < value.length && value[index] === "1"; index += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

async function transactionMemoPayloadAt(rpcUrl: string, signature: string, commitment: "confirmed" | "finalized"): Promise<Uint8Array | undefined> {
  const connection = new Connection(rpcUrl, commitment);
  const transaction = await connection.getParsedTransaction(signature, {commitment, maxSupportedTransactionVersion: 0});
  if (!transaction || transaction.meta?.err) return undefined;
  for (const instruction of transaction.transaction.message.instructions) {
    if ("data" in instruction && instruction.programId.equals(MEMO_PROGRAM_ID)) {
      try { return base58Decode(instruction.data); } catch { return undefined; }
    }
  }
  return undefined;
}

export async function transactionMemoPayload(rpcUrl: string, signature: string): Promise<Uint8Array | undefined> {
  return transactionMemoPayloadAt(rpcUrl, signature, "finalized");
}

export async function inspectCommitment(rpcUrl: string, signature: string, expectedPayload: Uint8Array): Promise<CommitmentInspection> {
  const connection = new Connection(rpcUrl, "finalized");
  const statuses = await connection.getSignatureStatuses([signature], {searchTransactionHistory: true});
  const status = statuses.value[0];
  if (!status) return {status: "missing", matches: false, finalized: false};
  if (status.err) return {status: "failed", matches: false, finalized: false};
  const finalized = status.confirmationStatus === "finalized";
  const payload = await transactionMemoPayloadAt(rpcUrl, signature, finalized ? "finalized" : "confirmed");
  const matches = !!payload && payload.length === expectedPayload.length && payload.every((byte, index) => byte === expectedPayload[index]);
  return {status: finalized ? "finalized" : "confirmed", matches, finalized, ...(payload ? {payload_base64url: bytesToBase64Url(payload)} : {})};
}

export async function verifyFinalizedTransaction(rpcUrl: string, signature: string, expectedPayload: Uint8Array): Promise<boolean> {
  const actual = await transactionMemoPayload(rpcUrl, signature);
  if (!actual || actual.length !== expectedPayload.length) return false;
  return actual.every((byte, index) => byte === expectedPayload[index]);
}

export function explorerTransactionUrl(signature: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}`;
}

export function receiptFromSubmission(input: {
  commitment: CommitmentInput;
  signature: string;
  finalized: boolean;
  payload_base64url: string;
  cluster?: string;
}): AnchorReceiptV1 {
  return {
    protocol: "vox/1",
    commitment_type: input.commitment.type,
    authority_id: input.commitment.authority_id,
    reference: input.commitment.reference_hash,
    root_or_post_hash: input.commitment.root_or_post_hash,
    manifest_hash: input.commitment.manifest_hash ?? "0".repeat(64),
    payload_base64url: input.payload_base64url,
    transaction_signature: input.signature,
    finalized: input.finalized,
    explorer_url: explorerTransactionUrl(input.signature, input.cluster ?? "devnet")
  };
}

export function hashPayload(payload: Uint8Array): string {
  return bytesToHex(sha256(payload));
}

export interface UsdcTransferExpectation {
  rpc_url: string;
  transaction_signature: string;
  network_id?: "solana:mainnet-beta";
  usdc_mint: string;
  destination_token_account: string;
  amount_atomic: string;
  source_token_account?: string;
  payer_address?: string;
  payment_reference?: string;
}

export interface UsdcTransferVerification {
  finalized: boolean;
  matched: boolean;
  network_matches?: boolean;
  reason?: string;
  /** Solana transaction block time, in Unix seconds, when exposed by RPC. */
  block_time?: number;
  usdc_mint: string;
  destination_token_account: string;
  amount_atomic: string;
  source_token_account?: string;
}

async function tokenAccountBelongsTo(connection: Connection, source: string, mint: string, owner: string): Promise<boolean> {
  try {
    const account = await connection.getParsedAccountInfo(new PublicKey(source), {commitment: "finalized"});
    const value = account.value;
    if (!value) return false;
    const parsedData = value.data as unknown as {parsed?: {type?: string; info?: {mint?: string; owner?: string}}};
    return parsedData.parsed?.type === "account" && parsedData.parsed.info?.mint === mint && parsedData.parsed.info.owner === owner;
  } catch {
    return false;
  }
}

function transactionContainsPaymentReference(transaction: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>, reference: string): boolean {
  return transaction.transaction.message.instructions.some((rawInstruction) => {
    const instruction = rawInstruction as unknown as {programId?: PublicKey; data?: string; parsed?: unknown};
    if (!instruction.programId?.equals(MEMO_PROGRAM_ID)) return false;
    if (typeof instruction.data === "string") {
      try {
        if (new TextDecoder().decode(base58Decode(instruction.data)) === reference) return true;
      } catch {
        // Some RPC parsers expose a Memo as parsed text rather than raw base58 data.
      }
    }
    if (instruction.parsed === reference) return true;
    if (instruction.parsed && typeof instruction.parsed === "object" && "memo" in instruction.parsed) return (instruction.parsed as {memo?: unknown}).memo === reference;
    return false;
  });
}

/**
 * Verifies a finalized parsed SPL-token transfer. A direct merchant transfer
 * is intentionally not escrow: the caller must still apply quote expiry,
 * replay protection, and refund/accounting rules before creating a job.
 */
export async function verifyFinalizedUsdcTransfer(input: UsdcTransferExpectation): Promise<UsdcTransferVerification> {
  const connection = new Connection(input.rpc_url, "finalized");
  if (input.network_id === "solana:mainnet-beta" && await connection.getGenesisHash() !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") {
    return {finalized: true, matched: false, network_matches: false, reason: "Configured RPC endpoint does not serve Solana mainnet-beta.", usdc_mint: input.usdc_mint, destination_token_account: input.destination_token_account, amount_atomic: input.amount_atomic, ...(input.source_token_account ? {source_token_account: input.source_token_account} : {})};
  }
  const transaction = await connection.getParsedTransaction(input.transaction_signature, {commitment: "finalized", maxSupportedTransactionVersion: 1});
  const base = {finalized: !!transaction && !transaction.meta?.err, matched: false, ...(input.network_id ? {network_matches: true} : {}), ...(Number.isSafeInteger(transaction?.blockTime) ? {block_time: transaction!.blockTime!} : {}), usdc_mint: input.usdc_mint, destination_token_account: input.destination_token_account, amount_atomic: input.amount_atomic};
  if (!transaction || transaction.meta?.err) return input.source_token_account ? {...base, source_token_account: input.source_token_account} : base;
  if (input.payment_reference && !transactionContainsPaymentReference(transaction, input.payment_reference)) return input.source_token_account ? {...base, source_token_account: input.source_token_account} : base;
  if (input.payer_address && !transaction.transaction.message.accountKeys.some((account) => account.pubkey.toBase58() === input.payer_address && account.signer)) return {...base, reason: "Payer wallet did not sign the finalized payment transaction.", ...(input.source_token_account ? {source_token_account: input.source_token_account} : {})};
  const matches: string[] = [];
  for (const instruction of transaction.transaction.message.instructions) {
    const candidate = instruction as unknown as {programId?: PublicKey; parsed?: {type?: string; info?: {mint?: string; destination?: string; source?: string; authority?: string; amount?: string; tokenAmount?: {amount?: string; decimals?: number}}}};
    if (!candidate.programId?.equals(TOKEN_PROGRAM_ID)) continue;
    const info = candidate.parsed?.info;
    if (!info || candidate.parsed?.type !== "transferChecked") continue;
    const amount = info.amount ?? info.tokenAmount?.amount;
    if (info.mint !== input.usdc_mint || info.destination !== input.destination_token_account || amount !== input.amount_atomic || info.tokenAmount?.decimals !== 6 || (input.payer_address && info.authority !== input.payer_address) || (input.source_token_account && info.source !== input.source_token_account)) continue;
    if (input.payer_address && (!info.source || !(await tokenAccountBelongsTo(connection, info.source, input.usdc_mint, input.payer_address)))) continue;
    if (info.source) matches.push(info.source);
  }
  if (matches.length === 1) return {...base, matched: true, source_token_account: matches[0]!};
  if (matches.length > 1) return {...base, reason: "Finalized transaction contains multiple identical quote-bound transfers."};
  return input.source_token_account ? {...base, source_token_account: input.source_token_account} : base;
}

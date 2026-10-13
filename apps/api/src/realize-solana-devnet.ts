import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import {resolve} from "node:path";
import {AccountRole, address, getAddressDecoder} from "@solana/kit";
import {Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction} from "@solana/web3.js";
import {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, unpackAccount} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  DEVNET_USDC_MINT, PROTOCOL_VERSION,
  SETTLEMENT_NETWORKS, assertConfigMatchesNetwork,
  configAddress, decodeConfigAccount, getEscrowInstruction,
  prepareEscrow, settlementNetworksFromEnvironment,
  usdcAta,
  type SettlementNetworkConfig
} from "@vox/realize-solana";
import {bytesToBase64Url, bytesToHex, sha256, utf8, type CommissionV1, type RealizeQuoteV1} from "@vox/protocol";
import type {RealizePaymentRail} from "./realize-payment.js";

const ESCROW_DISCRIMINATOR = sha256(utf8("account:Escrow")).slice(0, 8);
const FUND_DISCRIMINATOR = sha256(utf8("global:fund")).slice(0, 8);
const CLAIM_DISCRIMINATOR = sha256(utf8("global:claim")).slice(0, 8);
const REFUND_DISCRIMINATOR = sha256(utf8("global:refund")).slice(0, 8);
const STATUS_NAMES = ["Draft", "Ready", "Funded", "Fulfilled", "Refundable", "Settled", "Refunded", "Canceled", "Expired"] as const;

export interface EscrowFundingAuthorization {
  mode: "escrow";
  network_id: "solana:devnet";
  rpc_url: string;
  program_id: string;
  config: string;
  escrow: string;
  quote_used: string;
  vault: string;
  usdc_mint: string;
  token_program: string;
  payer_wallet: string;
  commission_id: string;
  quote_id: string;
  accepted_quote_hash: string;
  amount_usdc_atomic: string;
  commission_seed: string;
  commitment: string;
  quote_domain_hash: string;
  quote_domain_signature: string;
  quote_expires_at: string;
  refund_after: string;
  create_args: {
    commission: number[];
    quote_hash: number[];
    quote_domain_hash: number[];
    commitment: number[];
    total: string;
    recipient_count: number;
    quote_expires_at: string;
    refund_after: string;
  };
  payouts: Array<{recipient: string; amount_usdc_atomic: string}>;
  progress?: EscrowProgress;
}

export interface EscrowProgress {
  status: typeof STATUS_NAMES[number] | "Absent";
  payout_count: number;
  allocated_usdc_atomic: string;
  paid_usdc_atomic: string;
  claimed_bitmap: string;
  total_usdc_atomic: string;
}

interface EscrowSnapshot extends EscrowProgress {
  config: string;
  payer: string;
  commission: Uint8Array;
  quote_hash: Uint8Array;
  quote_domain_hash: Uint8Array;
  commitment: Uint8Array;
  fulfillment_authority: string;
  mint: string;
  token_program: string;
  cluster: number;
  protocol_version: number;
  config_revision: bigint;
  recipient_count: number;
  quote_expires_at: bigint;
  refund_after: bigint;
  running_hash: Uint8Array;
  fulfillment_hash: Uint8Array;
  bump: number;
  payouts: Array<{recipient: string; amount: bigint}>;
}

export interface EscrowVerification {
  finalized: boolean;
  matched: boolean;
  reason?: string;
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must point to the protected Devnet signer file`);
  return resolve(value);
}

async function readDevnetSigner(name: string, expectedAddress?: string): Promise<Keypair> {
  const path = requiredPath(name);
  const metadata = await stat(path);
  const permissions = metadata.mode & 0o777;
  const cloudRunSecretMount = Boolean(process.env.K_SERVICE) && path.startsWith("/run/secrets/vox-realize-devnet/");
  if (cloudRunSecretMount ? (permissions & 0o222) !== 0 : (permissions & 0o077) !== 0) {
    throw new Error(`${name} must reference an owner-only file or a read-only Cloud Run Secret Manager mount`);
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`${name} does not contain a valid Devnet signer`);
  }
  const signer = Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  if (expectedAddress && signer.publicKey.toBase58() !== expectedAddress) throw new Error(`${name} does not match the configured Devnet authority`);
  return signer;
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigInt64(0, true);
}

function readAddress(data: Uint8Array, offset: number): string {
  return address(getAddressDecoder().decode(data.slice(offset, offset + 32)));
}

function decodeEscrow(owner: string, expectedProgram: string, data: Uint8Array): EscrowSnapshot {
  if (owner !== expectedProgram) throw new Error("Escrow account has the wrong program owner");
  if (data.length < 426 || ESCROW_DISCRIMINATOR.some((byte, index) => data[index] !== byte)) throw new Error("Invalid escrow account data");
  const payoutCount = new DataView(data.buffer, data.byteOffset + 422, 4).getUint32(0, true);
  if (payoutCount > 64 || data.length < 426 + payoutCount * 40) throw new Error("Invalid escrow payout list");
  const statusIndex = data[388]!;
  const status = STATUS_NAMES[statusIndex];
  if (!status) throw new Error("Unknown escrow status");
  const payouts = Array.from({length: payoutCount}, (_, index) => {
    const offset = 426 + index * 40;
    return {recipient: readAddress(data, offset), amount: readU64(data, offset + 32)};
  });
  return {
    config: readAddress(data, 8), payer: readAddress(data, 40),
    commission: data.slice(72, 104), quote_hash: data.slice(104, 136),
    quote_domain_hash: data.slice(136, 168), commitment: data.slice(168, 200),
    fulfillment_authority: readAddress(data, 232), mint: readAddress(data, 264), token_program: readAddress(data, 296),
    cluster: data[328]!, protocol_version: new DataView(data.buffer, data.byteOffset + 329, 2).getUint16(0, true),
    config_revision: readU64(data, 331),
    quote_expires_at: readI64(data, 339), refund_after: readI64(data, 347),
    total_usdc_atomic: readU64(data, 355).toString(), allocated_usdc_atomic: readU64(data, 363).toString(),
    paid_usdc_atomic: readU64(data, 371).toString(), claimed_bitmap: readU64(data, 379).toString(),
    recipient_count: data[387]!, status, payout_count: payoutCount,
    running_hash: data.slice(200, 232), fulfillment_hash: data.slice(389, 421), bump: data[421]!, payouts
  };
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Expected a 32-byte hex digest");
  return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function fundingSignatureText(value: string): string {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)) throw new Error("Invalid Solana transaction signature");
  return value;
}

function sameDigest(actual: Uint8Array, expectedHex: string): boolean {
  try { return equalBytes(actual, fromHex(expectedHex)); } catch { return false; }
}

export class DevnetRealizeEscrowClient implements RealizePaymentRail<EscrowFundingAuthorization> {
  readonly mode = "escrow" as const;
  readonly network: SettlementNetworkConfig;
  readonly connection: Connection;

  get networkId(): string { return this.network.clusterIdentity; }
  get usdcMint(): string { return this.network.usdcMint; }

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.network = settlementNetworksFromEnvironment(env).devnet;
    if (!this.network.active || !this.network.programId || !this.network.quoteAuthority || !this.network.fulfillmentAuthority) {
      throw new Error("Devnet Realize escrow is disabled or missing a public deployment setting");
    }
    if (this.network.usdcMint !== DEVNET_USDC_MINT || this.network.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Devnet Realize escrow deployment profile is incompatible with this client");
    }
    this.connection = new Connection(this.network.rpcEndpoint, "confirmed");
  }

  private async config() {
    const program = this.network.programId!;
    const expected = await configAddress(program);
    const info = await this.connection.getAccountInfo(new PublicKey(expected), "confirmed");
    if (!info) throw new Error("Devnet Realize escrow config account is not initialized");
    const config = decodeConfigAccount(program, address(info.owner.toBase58()), expected, info.data);
    assertConfigMatchesNetwork(this.network, config);
    return config;
  }

  private fundingPayouts(funding: EscrowFundingAuthorization) {
    return funding.payouts.map((payout) => ({recipient: payout.recipient, amount: BigInt(payout.amount_usdc_atomic)}));
  }

  async prepareFunding(input: {quote: RealizeQuoteV1; commission: CommissionV1; payerWallet: string; authorizedIssuerPublicKey: string}): Promise<EscrowFundingAuthorization> {
    const config = await this.config();
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    const prepared = await prepareEscrow({
      quote: input.quote, commission: input.commission,
      authorizedIssuerPublicKey: input.authorizedIssuerPublicKey,
      network: this.network, config, payer: address(input.payerWallet),
      nowSeconds, refundAfter: nowSeconds + 7n * 24n * 60n * 60n
    });
    const quoteAuthority = await readDevnetSigner("VOX_REALIZE_DEVNET_QUOTE_AUTHORITY_KEYPAIR_PATH", this.network.quoteAuthority!);
    const signature = nacl.sign.detached(prepared.quoteDomainHash, quoteAuthority.secretKey);
    return {
      mode: "escrow", network_id: "solana:devnet", rpc_url: this.network.rpcEndpoint,
      program_id: this.network.programId!, config: prepared.accounts.config, escrow: prepared.accounts.escrow,
      quote_used: prepared.accounts.quoteUsed, vault: prepared.accounts.vault, usdc_mint: this.network.usdcMint,
      token_program: this.network.tokenProgram, payer_wallet: input.payerWallet, commission_id: input.commission.commission_id, quote_id: input.quote.quote_id,
      accepted_quote_hash: input.quote.canonical_quote_hash, amount_usdc_atomic: input.quote.total_amount_usdc_atomic,
      commission_seed: bytesToHex(prepared.header.commission), commitment: prepared.commitmentHex,
      quote_domain_hash: bytesToHex(prepared.quoteDomainHash), quote_domain_signature: bytesToBase64Url(signature),
      quote_expires_at: prepared.header.quoteExpiresAt.toString(), refund_after: prepared.header.refundAfter.toString(),
      create_args: {
        commission: Array.from(prepared.createArgs.commission), quote_hash: Array.from(prepared.createArgs.quote_hash),
        quote_domain_hash: Array.from(prepared.createArgs.quote_domain_hash), commitment: Array.from(prepared.createArgs.commitment),
        total: prepared.createArgs.total.toString(), recipient_count: prepared.createArgs.recipient_count,
        quote_expires_at: prepared.createArgs.quote_expires_at.toString(), refund_after: prepared.createArgs.refund_after.toString()
      },
      payouts: prepared.payouts.map((payout) => ({recipient: payout.recipient, amount_usdc_atomic: payout.amount.toString()}))
    };
  }

  private async snapshot(funding: EscrowFundingAuthorization): Promise<EscrowSnapshot | undefined> {
    if (funding.program_id !== this.network.programId || funding.usdc_mint !== this.network.usdcMint || funding.network_id !== this.network.clusterIdentity) throw new Error("Funding authorization targets a different Devnet profile");
    const info = await this.connection.getAccountInfo(new PublicKey(funding.escrow), "confirmed");
    if (!info) return undefined;
    const snapshot = decodeEscrow(info.owner.toBase58(), funding.program_id, info.data);
    const config = await this.config();
    const expectedCommission = fromHex(funding.commission_seed);
    if (snapshot.config !== config.address || snapshot.payer !== funding.payer_wallet || !equalBytes(snapshot.commission, expectedCommission) || !sameDigest(snapshot.quote_hash, funding.accepted_quote_hash) || !sameDigest(snapshot.quote_domain_hash, funding.quote_domain_hash) || !sameDigest(snapshot.commitment, funding.commitment) || snapshot.mint !== funding.usdc_mint || snapshot.token_program !== funding.token_program || snapshot.fulfillment_authority !== config.fulfillmentAuthority || snapshot.cluster !== 1 || snapshot.protocol_version !== PROTOCOL_VERSION || snapshot.config_revision !== config.revision || snapshot.quote_expires_at.toString() !== funding.quote_expires_at || snapshot.refund_after.toString() !== funding.refund_after || snapshot.recipient_count !== funding.payouts.length || snapshot.total_usdc_atomic !== funding.amount_usdc_atomic) {
      throw new Error("On-chain escrow does not match its backend-authorized quote");
    }
    const expectedPayouts = this.fundingPayouts(funding);
    if (snapshot.payouts.length > expectedPayouts.length || snapshot.payouts.some((payout, index) => payout.recipient !== expectedPayouts[index]?.recipient || payout.amount !== expectedPayouts[index]?.amount)) throw new Error("On-chain payout entries differ from the signed quote");
    return snapshot;
  }

  async fundingProgress(funding: EscrowFundingAuthorization): Promise<EscrowProgress> {
    const snapshot = await this.snapshot(funding);
    return snapshot ? {
      status: snapshot.status, payout_count: snapshot.payout_count, allocated_usdc_atomic: snapshot.allocated_usdc_atomic,
      paid_usdc_atomic: snapshot.paid_usdc_atomic, claimed_bitmap: snapshot.claimed_bitmap, total_usdc_atomic: snapshot.total_usdc_atomic
    } : {status: "Absent", payout_count: 0, allocated_usdc_atomic: "0", paid_usdc_atomic: "0", claimed_bitmap: "0", total_usdc_atomic: funding.amount_usdc_atomic};
  }

  async findFundingSignature(funding: EscrowFundingAuthorization): Promise<string | undefined> {
    const signatures = await this.connection.getSignaturesForAddress(new PublicKey(funding.escrow), {limit: 64}, "finalized");
    for (const item of signatures) {
      if (item.err) continue;
      const transaction = await this.connection.getTransaction(item.signature, {commitment: "finalized", maxSupportedTransactionVersion: 0}).catch(() => null);
      if (!transaction || transaction.meta?.err) continue;
      const message = transaction.transaction.message;
      const keys = message.version === 0
        ? message.getAccountKeys({accountKeysFromLookups: transaction.meta?.loadedAddresses ?? {writable: [], readonly: []}}).keySegments().flat()
        : message.accountKeys;
      const payerIndex = keys.findIndex((key) => key.toBase58() === funding.payer_wallet);
      const programIndex = keys.findIndex((key) => key.toBase58() === funding.program_id);
      const escrowIndex = keys.findIndex((key) => key.toBase58() === funding.escrow);
      if (payerIndex < 0 || payerIndex >= message.header.numRequiredSignatures || programIndex < 0 || escrowIndex < 0) continue;
      const hasFund = message.compiledInstructions.some((instruction) => {
        if (instruction.programIdIndex !== programIndex || !instruction.accountKeyIndexes.includes(escrowIndex)) return false;
        return equalBytes(instruction.data.slice(0, 8), FUND_DISCRIMINATOR);
      });
      if (hasFund) return item.signature;
    }
    return undefined;
  }

  async verifyFunding(funding: EscrowFundingAuthorization, transactionSignature: string, payerWallet: string): Promise<EscrowVerification> {
    if (payerWallet !== funding.payer_wallet) return {finalized: true, matched: false, reason: "The funding wallet differs from the accepted quote."};
    const signature = fundingSignatureText(transactionSignature);
    const status = (await this.connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
    if (!status) return {finalized: false, matched: false, reason: "The funding transaction is not yet visible on Devnet."};
    if (status.err) return {finalized: true, matched: false, reason: "The funding transaction failed on Devnet."};
    if (status.confirmationStatus !== "finalized") return {finalized: false, matched: false, reason: "The funding transaction is awaiting final confirmation."};
    const recorded = await this.findFundingSignature(funding);
    if (recorded !== signature) return {finalized: true, matched: false, reason: "The finalized transaction does not contain the authorized escrow funding instruction."};
    const snapshot = await this.snapshot(funding);
    if (!snapshot || snapshot.status !== "Funded" && snapshot.status !== "Fulfilled" && snapshot.status !== "Refundable" && snapshot.status !== "Settled" && snapshot.status !== "Refunded") return {finalized: true, matched: false, reason: "The authorized escrow has not reached its funded state."};
    if (snapshot.payout_count !== funding.payouts.length || snapshot.allocated_usdc_atomic !== funding.amount_usdc_atomic) return {finalized: true, matched: false, reason: "The escrow payout commitment is incomplete."};
    const vaultAddress = new PublicKey(funding.vault);
    const vaultInfo = await this.connection.getAccountInfo(vaultAddress, "finalized").catch(() => undefined);
    if (!vaultInfo || !vaultInfo.owner.equals(TOKEN_PROGRAM_ID)) return {finalized: true, matched: false, reason: "The escrow vault is not a classic USDC token account."};
    const vault = unpackAccount(vaultAddress, vaultInfo, TOKEN_PROGRAM_ID);
    if (!vault.mint.equals(new PublicKey(funding.usdc_mint)) || !vault.owner.equals(new PublicKey(funding.escrow)) || (snapshot.status !== "Settled" && snapshot.status !== "Refunded" && vault.amount.toString() !== funding.amount_usdc_atomic)) return {finalized: true, matched: false, reason: "The escrow vault balance does not match the accepted total."};
    return {finalized: true, matched: true};
  }

  async attestFulfillment(funding: EscrowFundingAuthorization, fulfillmentHash: string, success: boolean): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(fulfillmentHash)) throw new Error("Fulfillment evidence hash is invalid");
    const snapshot = await this.snapshot(funding);
    if (success && snapshot && ["Fulfilled", "Settled"].includes(snapshot.status)) {
      if (!sameDigest(snapshot.fulfillment_hash, fulfillmentHash)) throw new Error("The escrow was fulfilled with different evidence");
      return "";
    }
    if (!success && snapshot && ["Refundable", "Refunded"].includes(snapshot.status)) {
      if (!sameDigest(snapshot.fulfillment_hash, fulfillmentHash)) throw new Error("The escrow refund was attested with different failure evidence");
      return "";
    }
    if (!snapshot || snapshot.status !== "Funded") throw new Error("Only a funded Devnet escrow can receive a fulfillment attestation");
    const config = await this.config();
    const authority = await readDevnetSigner("VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY_KEYPAIR_PATH", this.network.fulfillmentAuthority!);
    const feePayer = await readDevnetSigner("VOX_REALIZE_DEVNET_FEE_PAYER_KEYPAIR_PATH");
    const instruction = getEscrowInstruction("attest", {
      fulfillment_authority: address(authority.publicKey.toBase58()), config: config.address, escrow: funding.escrow as never
    }, {
      quote_hash: Array.from(fromHex(funding.accepted_quote_hash)), fulfillment_hash: Array.from(fromHex(fulfillmentHash)), success
    }, this.network.programId!);
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({feePayer: feePayer.publicKey, recentBlockhash: latest.blockhash});
    transaction.add(new TransactionInstruction({
      programId: new PublicKey(instruction.programAddress),
      keys: (instruction.accounts ?? []).map((account) => ({
        pubkey: new PublicKey(account.address),
        isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
        isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER
      })), data: Buffer.from(instruction.data ?? new Uint8Array())
    }));
    const signature = await sendAndConfirmTransaction(this.connection, transaction, [feePayer, authority], {commitment: "finalized", preflightCommitment: "confirmed"});
    return signature;
  }

  async claimUnclaimedPayouts(funding: EscrowFundingAuthorization): Promise<string[]> {
    let snapshot = await this.snapshot(funding);
    if (!snapshot || !["Fulfilled", "Settled"].includes(snapshot.status)) return [];
    const feePayer = await readDevnetSigner("VOX_REALIZE_DEVNET_FEE_PAYER_KEYPAIR_PATH");
    const mint = new PublicKey(funding.usdc_mint);
    const vault = new PublicKey(funding.vault);
    const signatures: string[] = [];
    for (let index = 0; index < snapshot.payouts.length; index += 1) {
      const bit = 1n << BigInt(index);
      if ((BigInt(snapshot.claimed_bitmap) & bit) !== 0n) continue;
      const payout = snapshot.payouts[index]!;
      const recipient = new PublicKey(payout.recipient);
      const destination = new PublicKey(await usdcAta(address(payout.recipient), address(funding.usdc_mint)));
      const destinationInfo = await this.connection.getAccountInfo(destination, "confirmed");
      if (destinationInfo) {
        if (!destinationInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("A committed payout ATA is owned by a different token program");
        const token = unpackAccount(destination, destinationInfo, TOKEN_PROGRAM_ID);
        if (!token.mint.equals(mint) || !token.owner.equals(recipient)) throw new Error("A committed payout ATA does not belong to its authorized USDC recipient");
      }
      const instruction = getEscrowInstruction("claim", {
        escrow: address(funding.escrow), mint: address(funding.usdc_mint), vault: address(funding.vault),
        recipient: address(payout.recipient), destination: address(destination.toBase58()),
        token_program: address(TOKEN_PROGRAM_ID.toBase58()), associated_token_program: address(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
      }, {index}, this.network.programId!);
      const transaction = new Transaction();
      if (!destinationInfo) transaction.add(createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, destination, recipient, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      transaction.add(new TransactionInstruction({
        programId: new PublicKey(instruction.programAddress),
        keys: (instruction.accounts ?? []).map((account) => ({
          pubkey: new PublicKey(account.address),
          isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
          isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER
        })),
        data: Buffer.from(instruction.data ?? new Uint8Array())
      }));
      const latest = await this.connection.getLatestBlockhash("confirmed");
      transaction.feePayer = feePayer.publicKey;
      transaction.recentBlockhash = latest.blockhash;
      const [fee, balance, ataRent] = await Promise.all([
        this.connection.getFeeForMessage(transaction.compileMessage(), "confirmed"),
        this.connection.getBalance(feePayer.publicKey, "confirmed"),
        destinationInfo ? Promise.resolve(0) : this.connection.getMinimumBalanceForRentExemption(165, "confirmed")
      ]);
      if (BigInt(balance) < BigInt(fee.value ?? 5_000) + BigInt(ataRent)) throw new Error("The configured Devnet fee payer has insufficient SOL for escrow claims");
      const simulation = await this.connection.simulateTransaction(transaction);
      if (simulation.value.err) throw new Error(`Devnet payout claim simulation failed: ${JSON.stringify(simulation.value.err)}`);
      const signature = await sendAndConfirmTransaction(this.connection, transaction, [feePayer], {commitment: "finalized", preflightCommitment: "confirmed"});
      signatures.push(signature);
      snapshot = await this.snapshot(funding);
      if (!snapshot || !["Fulfilled", "Settled"].includes(snapshot.status)) break;
    }
    return signatures;
  }

  async getSettlement(funding: EscrowFundingAuthorization) {
    const snapshot = await this.snapshot(funding);
    const escrowSignatures = await this.connection.getSignaturesForAddress(new PublicKey(funding.escrow), {limit: 64}, "finalized").catch(() => []);
    const claimSignatures: string[] = [];
    for (const item of escrowSignatures) {
      if (item.err) continue;
      const transaction = await this.connection.getTransaction(item.signature, {commitment: "finalized", maxSupportedTransactionVersion: 0}).catch(() => null);
      if (!transaction || transaction.meta?.err) continue;
      const message = transaction.transaction.message;
      const keys = message.version === 0
        ? message.getAccountKeys({accountKeysFromLookups: transaction.meta?.loadedAddresses ?? {writable: [], readonly: []}}).keySegments().flat()
        : message.accountKeys;
      const programIndex = keys.findIndex((key) => key.toBase58() === funding.program_id);
      const escrowIndex = keys.findIndex((key) => key.toBase58() === funding.escrow);
      const hasClaim = message.compiledInstructions.some((instruction) => {
        if (instruction.programIdIndex !== programIndex || !instruction.accountKeyIndexes.includes(escrowIndex)) return false;
        return equalBytes(instruction.data.slice(0, 8), CLAIM_DISCRIMINATOR);
      });
      if (hasClaim) claimSignatures.push(item.signature);
    }
    const settled = snapshot?.status === "Settled" && snapshot.paid_usdc_atomic === funding.amount_usdc_atomic;
    const status = settled ? "settled" as const : snapshot?.paid_usdc_atomic !== "0" ? "partial" as const : snapshot?.status === "Refundable" || snapshot?.status === "Refunded" ? "failed" as const : "processing" as const;
    return {
      settlement_id: `vox:settlement:${createHash("sha256").update(`${funding.commission_id}\u0000${funding.accepted_quote_hash}`).digest("hex")}`,
      status,
      transaction_signatures: claimSignatures,
      settled_amount_usdc_atomic: snapshot?.paid_usdc_atomic ?? "0",
      failed_payout_ids: [],
      updated_at: new Date().toISOString()
    };
  }

  async requestRefundAttestation(funding: EscrowFundingAuthorization, failureHash: string): Promise<string> {
    const snapshot = await this.snapshot(funding);
    if (snapshot && ["Refundable", "Refunded"].includes(snapshot.status)) {
      if (!sameDigest(snapshot.fulfillment_hash, failureHash)) throw new Error("The escrow refund was attested with different failure evidence");
      return "";
    }
    return this.attestFulfillment(funding, failureHash, false);
  }

  async verifyRefund(funding: EscrowFundingAuthorization, signature: string, payerWallet: string): Promise<EscrowVerification> {
    if (payerWallet !== funding.payer_wallet) return {finalized: true, matched: false, reason: "The refund wallet differs from the accepted payer."};
    const value = fundingSignatureText(signature);
    const status = (await this.connection.getSignatureStatuses([value], {searchTransactionHistory: true})).value[0];
    if (!status) return {finalized: false, matched: false, reason: "The refund transaction is not yet visible on Devnet."};
    if (status.err) return {finalized: true, matched: false, reason: "The refund transaction failed on Devnet."};
    if (status.confirmationStatus !== "finalized") return {finalized: false, matched: false, reason: "The refund transaction is awaiting final confirmation."};
    const transaction = await this.connection.getTransaction(value, {commitment: "finalized", maxSupportedTransactionVersion: 0}).catch(() => null);
    if (!transaction || transaction.meta?.err) return {finalized: false, matched: false, reason: "The finalized refund transaction is not yet available."};
    const message = transaction.transaction.message;
    const keys = message.version === 0
      ? message.getAccountKeys({accountKeysFromLookups: transaction.meta?.loadedAddresses ?? {writable: [], readonly: []}}).keySegments().flat()
      : message.accountKeys;
    const payerIndex = keys.findIndex((key) => key.toBase58() === funding.payer_wallet);
    const programIndex = keys.findIndex((key) => key.toBase58() === funding.program_id);
    const escrowIndex = keys.findIndex((key) => key.toBase58() === funding.escrow);
    const hasRefund = payerIndex >= 0 && payerIndex < message.header.numRequiredSignatures && message.compiledInstructions.some((instruction) => {
      if (instruction.programIdIndex !== programIndex || !instruction.accountKeyIndexes.includes(escrowIndex)) return false;
      return equalBytes(instruction.data.slice(0, 8), REFUND_DISCRIMINATOR);
    });
    if (!hasRefund) return {finalized: true, matched: false, reason: "The finalized transaction does not contain this payer’s escrow refund instruction."};
    const snapshot = await this.snapshot(funding);
    if (!snapshot || snapshot.status !== "Refunded") return {finalized: true, matched: false, reason: "The escrow has not recorded the payer refund."};
    return {finalized: true, matched: true};
  }

  async getRefund(funding: EscrowFundingAuthorization) {
    const progress = await this.fundingProgress(funding);
    const status = progress.status === "Refunded" ? "refunded" as const : progress.status === "Refundable" ? "processing" as const : "accepted" as const;
    return {
      refund_id: `vox:refund:${createHash("sha256").update(`${funding.payer_wallet}\u0000${funding.accepted_quote_hash}`).digest("hex")}`,
      status,
      updated_at: new Date().toISOString()
    };
  }
}

export function configuredDevnetRealizeEscrow(env: Readonly<Record<string, string | undefined>> = process.env): DevnetRealizeEscrowClient | undefined {
  if (env.VOX_REALIZE_DEVNET_ENABLED !== "true") return undefined;
  return new DevnetRealizeEscrowClient(env);
}

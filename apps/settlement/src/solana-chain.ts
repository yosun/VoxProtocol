import {readFileSync} from "node:fs";
import {Connection, Keypair, PublicKey, Transaction} from "@solana/web3.js";
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  unpackAccount
} from "@solana/spl-token";
import {verifyFinalizedUsdcTransfer} from "@vox/solana";
import {MAINNET_GENESIS_HASH, MAINNET_USDC_MINT, type MainnetSettlementChain, type PreparedSettlementBatch, type RefundRequest, type SettlementTransfer, SettlementError} from "./engine.js";

export interface SolanaSettlementOptions {
  rpcUrl: string;
  treasuryOwner: string;
  treasuryTokenAccount: string;
  keypair: Keypair;
  maxPaymentAtomic: bigint;
  minimumSolReserveLamports?: bigint;
  connection?: Connection;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58_ALPHABET[remainder]! + encoded;
    number /= 58n;
  }
  return "1".repeat(zeroes) + encoded;
}

export function loadTreasuryKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("treasury keypair secret must be a 64-byte JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export class SolanaMainnetSettlementChain implements MainnetSettlementChain {
  readonly connection: Connection;
  readonly owner: PublicKey;
  readonly tokenAccount: PublicKey;
  readonly mint = new PublicKey(MAINNET_USDC_MINT);
  private readonly reserveLamports: bigint;

  constructor(private readonly options: SolanaSettlementOptions) {
    const rpc = new URL(options.rpcUrl);
    if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash) throw new Error("settlement RPC must be an HTTPS URL without credentials");
    this.owner = new PublicKey(options.treasuryOwner);
    this.tokenAccount = new PublicKey(options.treasuryTokenAccount);
    if (!options.keypair.publicKey.equals(this.owner)) throw new Error("treasury signing key does not match the configured owner");
    this.connection = options.connection ?? new Connection(rpc.href, "finalized");
    this.reserveLamports = options.minimumSolReserveLamports ?? 5_000_000n;
    if (options.maxPaymentAtomic <= 0n) throw new Error("Mainnet payment limit must be positive");
  }

  async ensureTreasury(): Promise<void> {
    if (await this.connection.getGenesisHash() !== MAINNET_GENESIS_HASH) throw new SettlementError(503, "wrong_network", "settlement RPC is not Solana Mainnet");
    const expectedAta = await getAssociatedTokenAddress(this.mint, this.owner, false, TOKEN_PROGRAM_ID);
    if (!expectedAta.equals(this.tokenAccount)) throw new SettlementError(503, "treasury_mismatch", "configured treasury token account is not the owner's classic USDC associated account");
    const info = await this.connection.getAccountInfo(this.tokenAccount, "finalized");
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) throw new SettlementError(503, "treasury_not_ready", "treasury USDC associated account has not been created");
    const token = unpackAccount(this.tokenAccount, info, TOKEN_PROGRAM_ID);
    if (!token.owner.equals(this.owner) || !token.mint.equals(this.mint)) throw new SettlementError(503, "treasury_mismatch", "treasury token account owner or mint is incorrect");
  }

  async verifyFunding(input: RefundRequest): Promise<boolean> {
    const result = await verifyFinalizedUsdcTransfer({
      rpc_url: this.connection.rpcEndpoint,
      transaction_signature: input.funding_transaction_signature,
      network_id: "solana:mainnet-beta",
      usdc_mint: MAINNET_USDC_MINT,
      destination_token_account: this.tokenAccount.toBase58(),
      amount_atomic: input.amount_usdc_atomic,
      payer_address: input.payer_wallet,
      payment_reference: input.payment_reference
    });
    return result.finalized && result.matched && result.network_matches !== false;
  }

  async prepareBatch(input: {recordId: string; batchIndex: number; transfers: SettlementTransfer[]}): Promise<PreparedSettlementBatch> {
    await this.ensureTreasury();
    if (!input.transfers.length || input.transfers.some((transfer) => !/^[1-9][0-9]{0,19}$/.test(transfer.amount_usdc_atomic) || BigInt(transfer.amount_usdc_atomic) > this.options.maxPaymentAtomic || !/^[A-Za-z0-9:._-]{1,256}$/.test(transfer.payout_id))) {
      throw new SettlementError(400, "invalid_payout", "settlement payout is invalid");
    }
    const total = input.transfers.reduce((sum, transfer) => sum + BigInt(transfer.amount_usdc_atomic), 0n);
    if (total > this.options.maxPaymentAtomic) throw new SettlementError(400, "payment_limit_exceeded", "settlement batch exceeds the configured payment limit");
    const externalTransfers = input.transfers.filter((transfer) => !new PublicKey(transfer.destination).equals(this.owner));
    const base = {
      batch_index: input.batchIndex,
      payout_ids: input.transfers.map((transfer) => transfer.payout_id),
      amount_usdc_atomic: total.toString(),
      updated_at: new Date().toISOString()
    };
    if (externalTransfers.length === 0) return {...base, status: "finalized"};
    const recipientAccounts = await Promise.all(externalTransfers.map(async (transfer) => {
      if (transfer.destination.length < 32 || transfer.destination.length > 64) throw new SettlementError(400, "invalid_destination", "payout destination is invalid");
      const owner = new PublicKey(transfer.destination);
      const tokenAccount = await getAssociatedTokenAddress(this.mint, owner, false, TOKEN_PROGRAM_ID);
      return {transfer, owner, tokenAccount};
    }));
    const treasuryBalance = BigInt((await this.connection.getTokenAccountBalance(this.tokenAccount, "finalized")).value.amount);
    const outgoingAmount = externalTransfers.reduce((sum, transfer) => sum + BigInt(transfer.amount_usdc_atomic), 0n);
    if (treasuryBalance < outgoingAmount) throw new SettlementError(503, "treasury_usdc_low", "treasury USDC balance is below the requested settlement amount");
    const missingAccounts = await Promise.all(recipientAccounts.map(async ({tokenAccount}) => !(await this.connection.getAccountInfo(tokenAccount, "finalized"))));
    const {blockhash, lastValidBlockHeight} = await this.connection.getLatestBlockhash("finalized");
    const transaction = new Transaction({feePayer: this.owner, recentBlockhash: blockhash});
    recipientAccounts.forEach(({transfer, owner, tokenAccount}) => {
      transaction.add(createAssociatedTokenAccountIdempotentInstruction(this.owner, tokenAccount, owner, this.mint, TOKEN_PROGRAM_ID));
      transaction.add(createTransferCheckedInstruction(this.tokenAccount, this.mint, tokenAccount, this.owner, BigInt(transfer.amount_usdc_atomic), 6, [], TOKEN_PROGRAM_ID));
    });
    const fee = (await this.connection.getFeeForMessage(transaction.compileMessage(), "finalized")).value;
    if (fee === null) throw new SettlementError(503, "fee_estimate_unavailable", "treasury transaction fee could not be estimated");
    const rent = await this.connection.getMinimumBalanceForRentExemption(AccountLayout.span, "finalized");
    const requiredLamports = BigInt(fee) + BigInt(rent) * BigInt(missingAccounts.filter(Boolean).length) + this.reserveLamports;
    if (BigInt(await this.connection.getBalance(this.owner, "finalized")) < requiredLamports) throw new SettlementError(503, "treasury_sol_low", "treasury needs more SOL for recipient account rent, transaction fees, and its reserve");
    transaction.sign(this.options.keypair);
    if (!transaction.signature) throw new SettlementError(503, "signing_failed", "treasury did not sign the settlement transaction");
    const raw = transaction.serialize();
    return {
      ...base, status: "prepared", transaction_signature: encodeBase58(transaction.signature),
      raw_transaction_base64: raw.toString("base64"), blockhash, last_valid_block_height: lastValidBlockHeight
    };
  }

  async executeBatch(batch: PreparedSettlementBatch): Promise<"prepared" | "finalized" | "failed" | "uncertain"> {
    if (batch.status === "finalized" || batch.status === "failed") return batch.status;
    if (!batch.transaction_signature || !batch.raw_transaction_base64 || !batch.blockhash || batch.last_valid_block_height === undefined) throw new SettlementError(500, "transaction_record_invalid", "persisted settlement transaction is incomplete");
    const signature = batch.transaction_signature;
    const readStatus = async () => (await this.connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
    let status = await readStatus();
    if (status?.confirmationStatus === "finalized") return status.err ? "failed" : "finalized";
    if (status) return "prepared";
    const blockHeight = await this.connection.getBlockHeight("finalized");
    // Once a signed transaction's blockhash expires, never replace it
    // automatically. Manual reconciliation avoids paying twice if the RPC is
    // temporarily unable to find a transaction that already landed.
    if (!status && blockHeight > batch.last_valid_block_height) return "uncertain";
    try {
      const sentSignature = await this.connection.sendRawTransaction(Buffer.from(batch.raw_transaction_base64, "base64"), {maxRetries: 3, preflightCommitment: "confirmed"});
      if (sentSignature !== signature) throw new SettlementError(502, "signature_mismatch", "RPC returned a different settlement transaction signature");
    } catch (error) {
      if (error instanceof SettlementError) throw error;
      // An RPC may report already processed for the same signed bytes that the
      // durable ledger intentionally rebroadcasts.
    }
    try {
      await this.connection.confirmTransaction({signature, blockhash: batch.blockhash, lastValidBlockHeight: batch.last_valid_block_height}, "finalized");
    } catch {
      // Timeouts and blockhash expiry are reconciled from the signature status.
    }
    status = await readStatus();
    if (status?.confirmationStatus === "finalized") return status.err ? "failed" : "finalized";
    return "prepared";
  }
}

export function configuredSettlementChain(env: Readonly<Record<string, string | undefined>> = process.env): SolanaMainnetSettlementChain {
  const rpcUrl = env.VOX_REALIZE_MAINNET_RPC_URL?.trim();
  const owner = env.VOX_REALIZE_MAINNET_TREASURY_OWNER?.trim();
  const tokenAccount = env.VOX_REALIZE_MAINNET_TREASURY_TOKEN_ACCOUNT?.trim();
  const keyPath = env.VOX_REALIZE_TREASURY_KEYPAIR_PATH?.trim();
  const maxPayment = env.VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC?.trim();
  if (!rpcUrl || !owner || !tokenAccount || !keyPath || !maxPayment || !/^[1-9][0-9]{0,19}$/.test(maxPayment)) throw new Error("Mainnet settlement RPC, treasury addresses, keypair path, and payment limit are required");
  const keypair = loadTreasuryKeypair(keyPath);
  return new SolanaMainnetSettlementChain({rpcUrl, treasuryOwner: owner, treasuryTokenAccount: tokenAccount, keypair, maxPaymentAtomic: BigInt(maxPayment)});
}

import {Buffer} from "buffer";
import {PublicKey, Connection, Transaction, TransactionInstruction} from "@solana/web3.js";
import {AccountRole, address} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount
} from "@solana/spl-token";
import {SolanaSignAndSendTransaction, SolanaSignTransaction, type SolanaSignAndSendTransactionFeature, type SolanaSignTransactionFeature} from "@solana/wallet-standard-features";
import {getWalletForHandle} from "@wallet-standard/ui-registry";
import type {WalletState} from "@solana/kit-plugin-wallet";
import {base64UrlToBytes, bytesToHex, sha256, utf8, verifyBytes, verifyRealizeQuoteSignature, type CommissionV1, type RealizeQuoteV1} from "@vox/protocol";
import {
  DEVNET_USDC_MINT, INSTRUCTIONS_SYSVAR, SETTLEMENT_NETWORKS,
  SYSTEM_PROGRAM, TOKEN_PROGRAM, assertConfigMatchesNetwork, commissionSeed, configAddress,
  decodeConfigAccount, escrowAddresses, getEscrowInstruction, prepareEscrow,
  quoteVerificationInstruction
} from "@vox/realize-solana";
import type {RealizeCommission, RealizeEscrowFunding, RealizeQuote} from "./api.js";
import {walletChainForCluster} from "./solana-wallet.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_DECIMALS = 6;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ESCROW_DISCRIMINATOR = sha256(utf8("account:Escrow")).slice(0, 8);
const ESCROW_STATUSES = ["Draft", "Ready", "Funded", "Fulfilled", "Refundable", "Settled", "Refunded", "Canceled", "Expired"] as const;

export type ConnectedWallet = NonNullable<WalletState["connected"]>;
export type DiscoveredWallet = WalletState["wallets"][number];

export interface UsdcPaymentAuthorization {
  payerAddress: string;
  usdcMint: string;
  destinationTokenAccount: string;
  destinationOwnerAddress: string;
  amountAtomic: string;
  paymentReference: string;
  cluster: string;
}

export type UsdcPaymentAttempt = {
  version: 1;
  authorization: UsdcPaymentAuthorization;
} & ({kind: "wallet_submission"} | {
  kind: "signed";
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: number;
});

export interface SendUsdcPaymentInput extends UsdcPaymentAuthorization {
  wallet: ConnectedWallet["wallet"];
  account: ConnectedWallet["account"];
  supportedTransactionVersions: ConnectedWallet["supportedTransactionVersions"];
  rpcUrl?: string;
  /** Must durably save this attempt or throw, before any possible broadcast. */
  onPrepared: (attempt: UsdcPaymentAttempt) => void;
  onWalletApprovalRequested?: () => void;
  onSubmitted?: (signature: string, explorerUrl: string) => void;
}

export interface SolanaPaymentResult {
  signature: string;
  explorerUrl: string;
  confirmation: "finalized" | "pending" | "failed";
  fundingComplete?: boolean;
}

function walletRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {code?: unknown; message?: unknown};
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  // Generic signing/connection errors can also mean an accepted broadcast lost
  // its response. Only an explicit user rejection is safe to treat as canceled.
  return value.code === 4001 || /\buser (?:rejected|declined|denied)\b|\b(?:rejected|declined|denied) by (?:the )?user\b/.test(message);
}

export {walletRejected};

function paymentMemoInstruction(reference: string): TransactionInstruction {
  if (!reference || reference.length > 240) throw new Error("The quote authorization reference is invalid.");
  return new TransactionInstruction({programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(reference, "utf8")});
}

function encodeBase58(value: Uint8Array): string {
  if (value.length === 0) return "";
  const digits = [0];
  for (const byte of value) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const current = digits[index]! * 256 + carry;
      digits[index] = current % 58;
      carry = Math.floor(current / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of value) {
    if (byte !== 0) break;
    result += "1";
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) result += BASE58_ALPHABET[digits[index]!]!;
  return result;
}

function baseSolanaRpcUrl(cluster: string): string {
  if (cluster === "mainnet-beta") return "https://api.mainnet-beta.solana.com";
  if (cluster === "testnet") return "https://api.testnet.solana.com";
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  throw new Error("This checkout supports Solana devnet, testnet, and mainnet-beta.");
}

function walletSigningFeatures(wallet: ConnectedWallet["wallet"]) {
  const standardWallet = getWalletForHandle(wallet as unknown as Parameters<typeof getWalletForHandle>[0]);
  const typed = standardWallet as unknown as {features: SolanaSignAndSendTransactionFeature & SolanaSignTransactionFeature};
  return typed.features;
}

function paymentAuthorization(input: UsdcPaymentAuthorization): UsdcPaymentAuthorization {
  const {payerAddress, usdcMint, destinationTokenAccount, destinationOwnerAddress, amountAtomic, paymentReference, cluster} = input;
  return {payerAddress, usdcMint, destinationTokenAccount, destinationOwnerAddress, amountAtomic, paymentReference, cluster};
}

function paymentExplorerUrl(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}`;
}

function directPaymentTransaction(input: UsdcPaymentAuthorization, createSource: boolean): Transaction {
  const owner = new PublicKey(input.payerAddress);
  const mint = new PublicKey(input.usdcMint);
  const destination = new PublicKey(input.destinationTokenAccount);
  const destinationOwner = new PublicKey(input.destinationOwnerAddress);
  const source = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const transaction = new Transaction();
  if (createSource) transaction.add(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  transaction.add(createAssociatedTokenAccountIdempotentInstruction(owner, destination, destinationOwner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  transaction.add(createTransferCheckedInstruction(source, mint, destination, owner, BigInt(input.amountAtomic), USDC_DECIMALS, [], TOKEN_PROGRAM_ID));
  transaction.add(paymentMemoInstruction(input.paymentReference));
  transaction.feePayer = owner;
  transaction.setSigners(owner);
  return transaction;
}

function verifiedSignedPayment(transaction: Transaction, bytes: Uint8Array): {signature: string; signedTransaction: string} {
  const signed = Transaction.from(bytes);
  if (!signed.serializeMessage().equals(transaction.serializeMessage()) || !signed.signature || !signed.verifySignatures()) {
    throw new Error("The wallet returned a transaction that does not match the authorized payment, or its signature is invalid.");
  }
  return {signature: encodeBase58(signed.signature), signedTransaction: Buffer.from(bytes).toString("base64")};
}

/** Recovery never builds a new payment: only the exact saved signature/bytes may be retried. */
export async function recoverUsdcPayment(attempt: UsdcPaymentAttempt, authorization: UsdcPaymentAuthorization, options: {rpcUrl?: string; quoteExpiresAt: string}): Promise<SolanaPaymentResult> {
  if (attempt.kind !== "signed" || attempt.version !== 1 || JSON.stringify(paymentAuthorization(attempt.authorization)) !== JSON.stringify(paymentAuthorization(authorization))) {
    throw new Error("The saved payment does not match this accepted quote. Do not pay again; verify the original wallet receipt.");
  }
  const mayRebroadcast = authorization.cluster !== "mainnet-beta" || import.meta.env.VITE_REALIZE_MAINNET_ENABLED === "true";
  const bytes = Buffer.from(attempt.signedTransaction, "base64");
  const signed = Transaction.from(bytes);
  const expected = directPaymentTransaction(authorization, signed.instructions.length === 4);
  expected.recentBlockhash = signed.recentBlockhash!;
  const verified = verifiedSignedPayment(expected, bytes);
  if (verified.signature !== attempt.signature || !Number.isSafeInteger(attempt.lastValidBlockHeight) || attempt.lastValidBlockHeight < 0) throw new Error("The saved payment recovery data is invalid. Verify the original wallet receipt before continuing.");
  const connection = new Connection(options.rpcUrl ?? import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? baseSolanaRpcUrl(authorization.cluster), "confirmed");
  const explorerUrl = paymentExplorerUrl(attempt.signature, authorization.cluster);
  let confirmation: SolanaPaymentResult["confirmation"] = "pending";
  try {
    const status = (await connection.getSignatureStatuses([attempt.signature], {searchTransactionHistory: true})).value[0];
    if (status?.err) confirmation = "failed";
    else if (status?.confirmationStatus === "finalized") confirmation = "finalized";
    else if (!status && mayRebroadcast && await connection.getBlockHeight("confirmed") <= attempt.lastValidBlockHeight && Date.parse(options.quoteExpiresAt) > Date.now()) {
      // An RPC timeout cannot establish whether it accepted the previous request.
      // Rebroadcasting identical signed bytes is idempotent on Solana.
      await connection.sendRawTransaction(bytes, {preflightCommitment: "confirmed"});
    }
  } catch { /* Keep the original identity, including after blockhash expiry or RPC failure. */ }
  return {signature: attempt.signature, explorerUrl, confirmation};
}

async function pollFinality(connection: Connection, signature: string, lastValidBlockHeight: number): Promise<"finalized" | "pending" | "failed"> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const [status, blockHeight] = await Promise.all([
        connection.getSignatureStatuses([signature], {searchTransactionHistory: true}),
        connection.getBlockHeight("confirmed")
      ]);
      const transaction = status.value[0];
      if (transaction?.err) return "failed";
      if (transaction?.confirmationStatus === "finalized") return "finalized";
      // A missing history result after blockhash expiry can still be delayed by an
      // RPC indexer, so preserve the signature and let server verification decide.
      if (blockHeight > lastValidBlockHeight && !transaction) return "pending";
    } catch {
      // Preserve the transaction signature if confirmation polling is interrupted.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  }
  return "pending";
}

/**
 * Builds only the single payment described by the backend-issued quote and its
 * server-provided authorization reference. It never reads payout destinations
 * from user input or commission data.
 */
export async function sendUsdcPayment(input: SendUsdcPaymentInput): Promise<SolanaPaymentResult> {
  if (input.cluster === "mainnet-beta" && import.meta.env.VITE_REALIZE_MAINNET_ENABLED !== "true") {
    throw new Error("Realize Mainnet checkout is disabled in this web build.");
  }
  if (!/^\d+$/.test(input.amountAtomic) || BigInt(input.amountAtomic) <= 0n || BigInt(input.amountAtomic) > 0xffffffffffffffffn) {
    throw new Error("The backend quote contains an invalid USDC amount.");
  }
  if (input.paymentReference.length > 240 || input.paymentReference.length < 1) throw new Error("The backend quote is missing its payment authorization reference.");
  const chain = walletChainForCluster(input.cluster);
  if (!chain || !input.account.chains.includes(chain as never)) throw new Error(`Wrong network. Switch your wallet to Solana ${input.cluster} and reconnect.`);
  if (!input.supportedTransactionVersions.has("legacy")) throw new Error("This wallet cannot sign the legacy Solana transaction format required by the current checkout.");

  let owner: PublicKey;
  let mint: PublicKey;
  let destination: PublicKey;
  let destinationOwner: PublicKey;
  try {
    owner = new PublicKey(input.payerAddress);
    mint = new PublicKey(input.usdcMint);
    destination = new PublicKey(input.destinationTokenAccount);
    destinationOwner = new PublicKey(input.destinationOwnerAddress);
  } catch {
    throw new Error("The backend-issued quote contains an invalid Solana payment address.");
  }
  if (input.account.address !== owner.toBase58()) throw new Error("The connected wallet changed. Reconnect the wallet that requested this quote.");

  const connection = new Connection(input.rpcUrl ?? import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? baseSolanaRpcUrl(input.cluster), "confirmed");
  const source = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const expectedDestination = getAssociatedTokenAddressSync(mint, destinationOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  if (!expectedDestination.equals(destination)) throw new Error("The quoted treasury account is not the associated account for the quoted wallet and USDC mint.");
  const [sourceInfo, destinationInfo] = await Promise.all([
    connection.getAccountInfo(source, "confirmed"),
    connection.getAccountInfo(destination, "confirmed")
  ]);
  if (destinationInfo) {
    if (!destinationInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("The quoted destination is not a USDC token account.");
    const destinationToken = unpackAccount(destination, destinationInfo, TOKEN_PROGRAM_ID);
    if (!destinationToken.mint.equals(mint) || !destinationToken.owner.equals(destinationOwner)) throw new Error("The quoted destination token account does not match the quoted wallet and USDC mint.");
  }
  if (sourceInfo && !sourceInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("The wallet’s associated token account is not owned by the USDC token program.");
  const sourceAmount = sourceInfo ? unpackAccount(source, sourceInfo, TOKEN_PROGRAM_ID).amount : 0n;
  if (sourceInfo && !unpackAccount(source, sourceInfo, TOKEN_PROGRAM_ID).mint.equals(mint)) throw new Error("The wallet’s associated token account does not hold the authorized USDC mint.");
  if (sourceAmount < BigInt(input.amountAtomic)) {
    throw new Error(`Insufficient USDC in wallet ${input.payerAddress}. It has ${(Number(sourceAmount) / 1_000_000).toFixed(2)} USDC in its associated account; the quote requires ${(Number(BigInt(input.amountAtomic)) / 1_000_000).toFixed(2)} USDC.`);
  }

  // If this is the first Mainnet payment, the payer creates the treasury ATA
  // and pays its one-time rent in the same transaction as the USDC transfer.
  const transaction = directPaymentTransaction(input, !sourceInfo);
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = owner;
  transaction.setSigners(owner);
  transaction.recentBlockhash = latestBlockhash.blockhash;

  const [fee, solBalance] = await Promise.all([
    connection.getFeeForMessage(transaction.compileMessage(), "confirmed"),
    connection.getBalance(owner, "confirmed")
  ]);
  const accountRent = sourceInfo && destinationInfo ? 0 : await connection.getMinimumBalanceForRentExemption(AccountLayout.span, "confirmed");
  const accountCount = Number(!sourceInfo) + Number(!destinationInfo);
  const requiredLamports = BigInt(fee.value ?? 5_000) + BigInt(accountRent) * BigInt(accountCount);
  if (BigInt(solBalance) < requiredLamports) {
    throw new Error(`Insufficient SOL for network fees${accountCount ? " and token-account rent" : ""}. Add SOL on ${input.cluster} before paying.`);
  }

  // Passing an empty signer array makes web3.js call `transaction.sign()` with
  // no signers. Omit it to simulate the unsigned transaction before the wallet
  // signs and submits it.
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    const details = typeof simulation.value.err === "string" ? simulation.value.err : JSON.stringify(simulation.value.err);
    throw new Error(`Solana rejected the payment simulation: ${details}`);
  }

  const features = walletSigningFeatures(input.wallet);
  input.onWalletApprovalRequested?.();
  let signature: string;
  if (features[SolanaSignTransaction]) {
    const [signed] = await features[SolanaSignTransaction].signTransaction({
      account: input.account,
      transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}),
      chain,
      options: {preflightCommitment: "confirmed"}
    });
    if (!signed?.signedTransaction) throw new Error("The wallet did not return a signed Solana transaction.");
    const prepared = verifiedSignedPayment(transaction, signed.signedTransaction);
    signature = prepared.signature;
    input.onPrepared({version: 1, kind: "signed", authorization: paymentAuthorization(input), ...prepared, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight});
    // Derive and durably save the signature before broadcast. A lost RPC
    // response must retain it rather than enable a newly signed payment.
    input.onSubmitted?.(signature, paymentExplorerUrl(signature, input.cluster));
    try {
      await connection.sendRawTransaction(signed.signedTransaction, {preflightCommitment: "confirmed"});
    } catch {
      return {signature, explorerUrl: paymentExplorerUrl(signature, input.cluster), confirmation: "pending"};
    }
  } else if (features[SolanaSignAndSendTransaction]) {
    // These wallets may broadcast without returning a signature. Persist an
    // unresolved attempt before calling them, so a timeout survives refresh.
    input.onPrepared({version: 1, kind: "wallet_submission", authorization: paymentAuthorization(input)});
    const [sent] = await features[SolanaSignAndSendTransaction].signAndSendTransaction({
      account: input.account,
      transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}),
      chain,
      options: {preflightCommitment: "confirmed", commitment: "confirmed", skipPreflight: false}
    });
    if (sent?.signature?.length !== 64) throw new Error("The wallet did not return a valid Solana transaction signature. Check the original wallet receipt before continuing.");
    signature = encodeBase58(sent.signature);
    input.onSubmitted?.(signature, paymentExplorerUrl(signature, input.cluster));
  } else {
    throw new Error("This wallet does not support Solana transaction signing.");
  }

  const explorerUrl = paymentExplorerUrl(signature, input.cluster);
  const confirmation = await pollFinality(connection, signature, latestBlockhash.lastValidBlockHeight);
  return {
    signature,
    confirmation,
    explorerUrl
  };
}

function digestBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("The backend escrow authorization contains an invalid digest.");
  return Uint8Array.from(value.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function accountAddress(data: Uint8Array, offset: number): string {
  return new PublicKey(data.slice(offset, offset + 32)).toBase58();
}

function escrowProgressFromAccount(info: NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>, funding: RealizeEscrowFunding, payer: string, payouts: Array<{recipient: string; amount_usdc_atomic: string}>) {
  const data = info.data;
  if (!info.owner.equals(new PublicKey(funding.program_id)) || data.length < 426 || ESCROW_DISCRIMINATOR.some((byte, index) => data[index] !== byte)) throw new Error("The escrow account is not owned by the authorized Realize program.");
  const readU64 = (offset: number) => new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
  const payoutCount = new DataView(data.buffer, data.byteOffset + 422, 4).getUint32(0, true);
  const status = ESCROW_STATUSES[data[388]!];
  if (!status || payoutCount > 64 || data.length < 426 + payoutCount * 40) throw new Error("The on-chain escrow account has an invalid state.");
  if (accountAddress(data, 40) !== payer || accountAddress(data, 264) !== funding.usdc_mint || readU64(355).toString() !== funding.amount_usdc_atomic || payoutCount > payouts.length) throw new Error("The on-chain escrow does not match the accepted payer and USDC quote.");
  if (bytesToHex(data.slice(72, 104)) !== funding.commission_seed || bytesToHex(data.slice(104, 136)) !== funding.accepted_quote_hash || bytesToHex(data.slice(136, 168)) !== funding.quote_domain_hash || bytesToHex(data.slice(168, 200)) !== funding.commitment) throw new Error("The on-chain escrow hashes differ from the accepted quote authorization.");
  let allocated = 0n;
  for (let index = 0; index < payoutCount; index += 1) {
    const offset = 426 + index * 40;
    const payout = payouts[index]!;
    const amount = readU64(offset + 32);
    if (accountAddress(data, offset) !== payout.recipient || amount.toString() !== payout.amount_usdc_atomic) throw new Error("The on-chain escrow recipients differ from the backend-authorized quote.");
    allocated += amount;
  }
  if (readU64(363) !== allocated) throw new Error("The escrow allocation does not match its on-chain payout entries.");
  return {status, payout_count: payoutCount, allocated_usdc_atomic: allocated.toString()};
}

export async function checkSolanaTransaction(signature: string, cluster: string): Promise<"finalized" | "pending" | "failed"> {
  const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? baseSolanaRpcUrl(cluster), "confirmed");
  try {
    const status = (await connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
    if (!status) return "pending";
    if (status.err) return "failed";
    return status.confirmationStatus === "finalized" ? "finalized" : "pending";
  } catch { return "pending"; }
}

function web3Instruction(instruction: ReturnType<typeof getEscrowInstruction> | ReturnType<typeof quoteVerificationInstruction>): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER,
      isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER
    })),
    data: Buffer.from(instruction.data ?? new Uint8Array())
  });
}

/** Wallet-funded escrow setup uses only the accepted VOX quote and server-signed domain authorization. */
export async function sendRealizeEscrowPayment(input: {
  wallet: ConnectedWallet["wallet"];
  account: ConnectedWallet["account"];
  supportedTransactionVersions: ConnectedWallet["supportedTransactionVersions"];
  payerAddress: string;
  commission: RealizeCommission;
  quote: RealizeQuote;
  issuerPublicKey: string;
  funding: RealizeEscrowFunding;
  cluster: string;
  onWalletApprovalRequested?: () => void;
  onSubmitted?: (signature: string, explorerUrl: string) => void;
}): Promise<SolanaPaymentResult> {
  if (input.funding.mode !== "escrow" || input.cluster !== "devnet") throw new Error("This escrow authorization is not configured for Devnet.");
  if (import.meta.env.VITE_REALIZE_DEVNET_ENABLED !== "true") throw new Error("Realize Devnet escrow is disabled in this web build.");
  const chain = walletChainForCluster(input.cluster);
  if (!chain || !input.account.chains.includes(chain as never)) throw new Error("Wrong network. Switch your wallet to Solana Devnet and reconnect.");
  if (!input.supportedTransactionVersions.has("legacy")) throw new Error("This wallet cannot sign the legacy Solana transactions required by the Devnet escrow.");
  if (input.account.address !== input.payerAddress || input.payerAddress !== input.funding.payer_wallet) throw new Error("The connected payer wallet differs from the wallet authorized for this quote.");
  if (input.funding.program_id !== SETTLEMENT_NETWORKS.devnet.programId || input.funding.usdc_mint !== DEVNET_USDC_MINT || input.quote.network_id !== "solana:devnet" || input.quote.usdc_mint !== DEVNET_USDC_MINT || input.funding.accepted_quote_hash !== input.quote.canonical_quote_hash || input.funding.quote_id !== input.quote.quote_id || input.funding.commission_id !== input.commission.commission_id || input.commission.accepted_quote_hash !== input.quote.canonical_quote_hash) {
    throw new Error("The escrow authorization does not match the accepted VOX quote.");
  }
  if (Math.floor(Date.now() / 1_000) >= Number(input.funding.quote_expires_at)) throw new Error("This escrow quote has expired. Request a fresh quote before funding.");

  const program = address(input.funding.program_id);
  const network = {...SETTLEMENT_NETWORKS.devnet, active: true};
  const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? network.rpcEndpoint, "confirmed");
  const expectedConfig = await configAddress(program);
  if (expectedConfig !== input.funding.config) throw new Error("The backend authorization names a different escrow config account.");
  const rawConfig = await connection.getAccountInfo(new PublicKey(expectedConfig), "confirmed");
  if (!rawConfig) throw new Error("Devnet escrow is not initialized. Payment is unavailable.");
  const config = decodeConfigAccount(program, address(rawConfig.owner.toBase58()), expectedConfig, rawConfig.data);
  assertConfigMatchesNetwork(network, config);

  const refundAfter = BigInt(input.funding.refund_after);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
  const prepared = await prepareEscrow({
    quote: input.quote, commission: input.commission as unknown as CommissionV1,
    authorizedIssuerPublicKey: input.issuerPublicKey, network, config,
    payer: address(input.payerAddress), nowSeconds, refundAfter
  });
  if (prepared.accounts.config !== input.funding.config || prepared.accounts.escrow !== input.funding.escrow || prepared.accounts.quoteUsed !== input.funding.quote_used || prepared.accounts.vault !== input.funding.vault || bytesToHex(prepared.header.commission) !== input.funding.commission_seed || prepared.commitmentHex !== input.funding.commitment || bytesToHex(prepared.quoteDomainHash) !== input.funding.quote_domain_hash) {
    throw new Error("The backend escrow authorization does not match the quote’s payout commitment.");
  }
  if (!verifyBytes(prepared.quoteDomainHash, input.funding.quote_domain_signature, new PublicKey(network.quoteAuthority!).toBytes())) throw new Error("The settlement quote authority signature is invalid.");
  if (input.funding.create_args.total !== prepared.createArgs.total.toString() || input.funding.create_args.recipient_count !== prepared.createArgs.recipient_count || input.funding.create_args.quote_expires_at !== prepared.createArgs.quote_expires_at.toString() || input.funding.create_args.refund_after !== prepared.createArgs.refund_after.toString() || JSON.stringify(input.funding.create_args.commission) !== JSON.stringify(Array.from(prepared.createArgs.commission)) || JSON.stringify(input.funding.create_args.quote_hash) !== JSON.stringify(Array.from(prepared.createArgs.quote_hash)) || JSON.stringify(input.funding.create_args.quote_domain_hash) !== JSON.stringify(Array.from(prepared.createArgs.quote_domain_hash)) || JSON.stringify(input.funding.create_args.commitment) !== JSON.stringify(Array.from(prepared.createArgs.commitment))) {
    throw new Error("The backend escrow instruction arguments do not match the verified signed quote.");
  }
  const committedPayouts = prepared.payouts.map((payout) => ({recipient: payout.recipient, amount_usdc_atomic: payout.amount.toString()}));
  if (JSON.stringify(committedPayouts) !== JSON.stringify(input.funding.payouts)) throw new Error("The backend payout list differs from the signed quote.");
  const expectedAddresses = await escrowAddresses(program, commissionSeed(input.commission.commission_id), digestBytes(input.quote.canonical_quote_hash));
  if (expectedAddresses.config !== input.funding.config || expectedAddresses.escrow !== input.funding.escrow || expectedAddresses.quoteUsed !== input.funding.quote_used || expectedAddresses.vault !== input.funding.vault) throw new Error("The backend authorization contains an invalid escrow address.");

  const owner = new PublicKey(input.payerAddress);
  const mint = new PublicKey(input.funding.usdc_mint);
  const escrow = new PublicKey(input.funding.escrow);
  const source = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const [sourceInfo, latestUsdc, escrowInfo] = await Promise.all([connection.getAccountInfo(source, "confirmed"), connection.getTokenSupply(mint, "confirmed"), connection.getAccountInfo(new PublicKey(input.funding.escrow), "confirmed")]);
  if (latestUsdc.value.decimals !== USDC_DECIMALS) throw new Error("The configured Devnet USDC mint has an unexpected decimal count.");
  if (sourceInfo && !sourceInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("The wallet’s associated account is not owned by the classic SPL Token program.");
  const sourceToken = sourceInfo ? unpackAccount(source, sourceInfo, TOKEN_PROGRAM_ID) : undefined;
  if (sourceToken && !sourceToken.mint.equals(mint)) throw new Error("The wallet’s associated account does not hold the authorized USDC mint.");
  const sourceAmount = sourceToken?.amount ?? 0n;
  if (sourceAmount < BigInt(input.funding.amount_usdc_atomic)) throw new Error(`Insufficient USDC in wallet ${input.payerAddress}. It has ${(Number(sourceAmount) / 1_000_000).toFixed(2)} USDC; the quote requires ${(Number(BigInt(input.funding.amount_usdc_atomic)) / 1_000_000).toFixed(2)} USDC.`);

  const sourceAta = address(source.toBase58());
  const progress = escrowInfo
    ? escrowProgressFromAccount(escrowInfo, input.funding, input.payerAddress, committedPayouts)
    : {status: "Absent" as const, payout_count: 0, allocated_usdc_atomic: "0"};
  let payoutStart = progress.payout_count;
  let createNeeded = progress.status === "Absent";
  if (["Funded", "Fulfilled", "Refundable", "Settled", "Refunded"].includes(progress.status)) throw new Error("This escrow already has an on-chain payment. Refresh the commission status before trying again.");
  if (!createNeeded && progress.status !== "Draft" && progress.status !== "Ready") throw new Error("The escrow is not in a payable state. Refresh this commission before continuing.");
  if (progress.status === "Ready" && payoutStart !== prepared.payouts.length) throw new Error("The ready escrow has an inconsistent payout count.");
  const createInstruction = getEscrowInstruction("create_escrow", {
    payer: address(owner.toBase58()), config: prepared.accounts.config, escrow: prepared.accounts.escrow,
    quote_used: prepared.accounts.quoteUsed, mint: address(mint.toBase58()), vault: prepared.accounts.vault,
    token_program: TOKEN_PROGRAM, instructions: INSTRUCTIONS_SYSVAR, system_program: SYSTEM_PROGRAM
  }, {args: prepared.createArgs}, program);
  const authoritySignature = base64UrlToBytes(input.funding.quote_domain_signature);
  const verifyInstruction = quoteVerificationInstruction(address(network.quoteAuthority!), authoritySignature, prepared.quoteDomainHash);
  const appendInstruction = (from: number, to: number) => getEscrowInstruction("append_payouts", {
    payer: address(owner.toBase58()), escrow: prepared.accounts.escrow
  }, {payouts: prepared.payouts.slice(from, to).map((payout) => ({recipient: payout.recipient, amount: payout.amount}))}, program);
  const sealInstruction = getEscrowInstruction("seal", {payer: address(owner.toBase58()), escrow: prepared.accounts.escrow}, {}, program);
  const fundInstruction = getEscrowInstruction("fund", {
    payer: address(owner.toBase58()), config: prepared.accounts.config, escrow: prepared.accounts.escrow,
    mint: address(mint.toBase58()), source: sourceAta, vault: prepared.accounts.vault, token_program: TOKEN_PROGRAM
  }, {}, program);

  const fundingTransactions: Array<{instructions: TransactionInstruction[]; createsEscrow: boolean; createsAta: boolean}> = [];
  if (createNeeded) {
    const firstEnd = Math.min(8, prepared.payouts.length);
    const firstInstructions = [web3Instruction(verifyInstruction), web3Instruction(createInstruction), web3Instruction(appendInstruction(0, firstEnd))];
    createNeeded = false;
    payoutStart = firstEnd;
    if (payoutStart === prepared.payouts.length) {
      if (progress.status !== "Ready") firstInstructions.push(web3Instruction(sealInstruction));
      if (!sourceInfo) firstInstructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      firstInstructions.push(web3Instruction(fundInstruction));
      fundingTransactions.push({instructions: firstInstructions, createsEscrow: true, createsAta: !sourceInfo});
    } else fundingTransactions.push({instructions: firstInstructions, createsEscrow: true, createsAta: false});
  }
  while (payoutStart < prepared.payouts.length) {
    const end = Math.min(payoutStart + 8, prepared.payouts.length);
    const instructions = [web3Instruction(appendInstruction(payoutStart, end))];
    payoutStart = end;
    const lastBatch = payoutStart === prepared.payouts.length;
    if (lastBatch) {
      instructions.push(web3Instruction(sealInstruction));
      if (!sourceInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      instructions.push(web3Instruction(fundInstruction));
    }
    fundingTransactions.push({instructions, createsEscrow: false, createsAta: lastBatch && !sourceInfo});
  }
  if (progress.status === "Ready") {
    const instructions = [];
    if (!sourceInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    instructions.push(web3Instruction(fundInstruction));
    fundingTransactions.push({instructions, createsEscrow: false, createsAta: !sourceInfo});
  } else if (!createNeeded && payoutStart === prepared.payouts.length && progress.status === "Draft" && fundingTransactions.length === 0) {
    const instructions = [web3Instruction(sealInstruction)];
    if (!sourceInfo) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, source, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    instructions.push(web3Instruction(fundInstruction));
    fundingTransactions.push({instructions, createsEscrow: false, createsAta: !sourceInfo});
  }

  const features = walletSigningFeatures(input.wallet);
  let finalSignature = "";
  let finalExplorerUrl = "";
  for (const batch of fundingTransactions) {
    const transaction = new Transaction();
    transaction.add(...batch.instructions);
    const blockhash = await connection.getLatestBlockhash("confirmed");
    transaction.feePayer = owner;
    transaction.setSigners(owner);
    transaction.recentBlockhash = blockhash.blockhash;
    const [fee, balance, escrowRent, ataRent] = await Promise.all([
      connection.getFeeForMessage(transaction.compileMessage(), "confirmed"),
      connection.getBalance(owner, "confirmed"),
      batch.createsEscrow ? connection.getMinimumBalanceForRentExemption(2_986, "confirmed") : Promise.resolve(0),
      batch.createsAta ? connection.getMinimumBalanceForRentExemption(AccountLayout.span, "confirmed") : Promise.resolve(0)
    ]);
    const requiredLamports = BigInt(fee.value ?? 5_000) + BigInt(escrowRent) + BigInt(ataRent);
    if (BigInt(balance) < requiredLamports) throw new Error(`Insufficient SOL for network fees${escrowRent ? " and escrow rent" : ""}${ataRent ? " and USDC account rent" : ""}. Add SOL on Devnet before funding.`);
    const simulation = await connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      const details = typeof simulation.value.err === "string" ? simulation.value.err : JSON.stringify(simulation.value.err);
      throw new Error(`Devnet escrow simulation failed: ${details}`);
    }
    let signature: string;
    input.onWalletApprovalRequested?.();
    if (features[SolanaSignAndSendTransaction]) {
      const [sent] = await features[SolanaSignAndSendTransaction].signAndSendTransaction({
        account: input.account,
        transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}),
        chain,
        options: {preflightCommitment: "confirmed", commitment: "confirmed", skipPreflight: false}
      });
      if (!sent?.signature) throw new Error("The wallet did not return a Devnet transaction signature.");
      signature = encodeBase58(sent.signature);
    } else if (features[SolanaSignTransaction]) {
      const [signed] = await features[SolanaSignTransaction].signTransaction({
        account: input.account,
        transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}),
        chain, options: {preflightCommitment: "confirmed"}
      });
      if (!signed?.signedTransaction) throw new Error("The wallet did not return a signed Devnet transaction.");
      signature = await connection.sendRawTransaction(signed.signedTransaction, {preflightCommitment: "confirmed"});
    } else throw new Error("This wallet does not support Solana transaction signing.");
    const explorerUrl = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
    input.onSubmitted?.(signature, explorerUrl);
    const confirmation = await pollFinality(connection, signature, blockhash.lastValidBlockHeight);
    if (confirmation === "failed") return {signature, explorerUrl, confirmation, fundingComplete: false};
    if (confirmation !== "finalized") return {signature, explorerUrl, confirmation, fundingComplete: false};
    finalSignature = signature;
    finalExplorerUrl = explorerUrl;
  }
  if (!finalSignature) throw new Error("No escrow funding transaction was submitted. Refresh this commission and try again.");
  return {signature: finalSignature, explorerUrl: finalExplorerUrl, confirmation: "finalized", fundingComplete: true};
}

/** Claims a Devnet refund only from the server-authorized escrow to its recorded payer ATA. */
export async function sendRealizeEscrowRefund(input: {
  wallet: ConnectedWallet["wallet"];
  account: ConnectedWallet["account"];
  supportedTransactionVersions: ConnectedWallet["supportedTransactionVersions"];
  payerAddress: string;
  commission: RealizeCommission;
  quote: RealizeQuote;
  issuerPublicKey: string;
  funding: RealizeEscrowFunding;
  cluster: string;
  onSubmitted?: (signature: string, explorerUrl: string) => void;
}): Promise<SolanaPaymentResult> {
  if (input.funding.mode !== "escrow" || input.cluster !== "devnet" || import.meta.env.VITE_REALIZE_DEVNET_ENABLED !== "true") throw new Error("This refund is not configured for Devnet escrow.");
  const chain = walletChainForCluster(input.cluster);
  if (!chain || !input.account.chains.includes(chain as never)) throw new Error("Wrong network. Switch your wallet to Solana Devnet and reconnect.");
  if (!input.supportedTransactionVersions.has("legacy")) throw new Error("This wallet cannot sign the legacy Solana refund transaction.");
  if (input.account.address !== input.payerAddress || input.payerAddress !== input.funding.payer_wallet) throw new Error("Reconnect the payer wallet authorized for this refund.");
  if (!verifyRealizeQuoteSignature(input.quote as unknown as RealizeQuoteV1, base64UrlToBytes(input.issuerPublicKey)) || input.quote.canonical_quote_hash !== input.funding.accepted_quote_hash || input.quote.quote_id !== input.funding.quote_id || input.commission.commission_id !== input.funding.commission_id || input.commission.accepted_quote_hash !== input.funding.accepted_quote_hash) throw new Error("The refund does not match the verified accepted VOX quote.");
  if (input.funding.program_id !== SETTLEMENT_NETWORKS.devnet.programId || input.funding.usdc_mint !== DEVNET_USDC_MINT || input.quote.network_id !== "solana:devnet" || input.quote.usdc_mint !== DEVNET_USDC_MINT) throw new Error("The refund authorization targets a different Solana deployment.");

  const program = address(input.funding.program_id);
  const network = {...SETTLEMENT_NETWORKS.devnet, active: true};
  const connection = new Connection(import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? network.rpcEndpoint, "confirmed");
  const expected = await escrowAddresses(program, commissionSeed(input.commission.commission_id), digestBytes(input.quote.canonical_quote_hash));
  if (expected.config !== input.funding.config || expected.escrow !== input.funding.escrow || expected.quoteUsed !== input.funding.quote_used || expected.vault !== input.funding.vault) throw new Error("The refund authorization contains an invalid escrow address.");
  const configInfo = await connection.getAccountInfo(new PublicKey(expected.config), "confirmed");
  if (!configInfo) throw new Error("The Devnet escrow config account is unavailable.");
  const config = decodeConfigAccount(program, address(configInfo.owner.toBase58()), expected.config, configInfo.data);
  assertConfigMatchesNetwork(network, config);
  const escrowInfo = await connection.getAccountInfo(new PublicKey(expected.escrow), "confirmed");
  if (!escrowInfo) throw new Error("The escrow account is not available on Devnet.");
  const data = escrowInfo.data;
  if (!escrowInfo.owner.equals(new PublicKey(input.funding.program_id)) || data.length < 426 || ESCROW_DISCRIMINATOR.some((byte, index) => data[index] !== byte) || accountAddress(data, 40) !== input.payerAddress || accountAddress(data, 264) !== input.funding.usdc_mint || bytesToHex(data.slice(104, 136)) !== input.funding.accepted_quote_hash || bytesToHex(data.slice(136, 168)) !== input.funding.quote_domain_hash || new DataView(data.buffer, data.byteOffset + 355, 8).getBigUint64(0, true).toString() !== input.funding.amount_usdc_atomic) throw new Error("The escrow account does not match this payer’s accepted quote.");
  if (ESCROW_STATUSES[data[388]!] !== "Refundable") throw new Error("This escrow is not yet eligible for a refund.");
  const quoteDomainHash = digestBytes(input.funding.quote_domain_hash);
  if (!verifyBytes(quoteDomainHash, input.funding.quote_domain_signature, new PublicKey(network.quoteAuthority!).toBytes())) throw new Error("The server-authorized settlement signature is invalid.");

  const payer = new PublicKey(input.payerAddress);
  const mint = new PublicKey(input.funding.usdc_mint);
  const destination = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const refundInstruction = getEscrowInstruction("refund", {
    payer: address(payer.toBase58()), escrow: expected.escrow, mint: address(mint.toBase58()), vault: expected.vault,
    destination: address(destination.toBase58()), token_program: TOKEN_PROGRAM, associated_token_program: address(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
  }, {}, program);
  const destinationInfo = await connection.getAccountInfo(destination, "confirmed");
  const transaction = new Transaction();
  if (!destinationInfo) transaction.add(createAssociatedTokenAccountIdempotentInstruction(payer, destination, payer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
  transaction.add(web3Instruction(refundInstruction));
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = payer;
  transaction.setSigners(payer);
  transaction.recentBlockhash = blockhash.blockhash;
  const [fee, balance, ataRent] = await Promise.all([
    connection.getFeeForMessage(transaction.compileMessage(), "confirmed"), connection.getBalance(payer, "confirmed"),
    destinationInfo ? Promise.resolve(0) : connection.getMinimumBalanceForRentExemption(AccountLayout.span, "confirmed")
  ]);
  if (BigInt(balance) < BigInt(fee.value ?? 5_000) + BigInt(ataRent)) throw new Error(`Insufficient SOL for refund network fees${ataRent ? " and USDC account rent" : ""}.`);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error(`Devnet refund simulation failed: ${JSON.stringify(simulation.value.err)}`);
  const features = walletSigningFeatures(input.wallet);
  let signature: string;
  if (features[SolanaSignAndSendTransaction]) {
    const [sent] = await features[SolanaSignAndSendTransaction].signAndSendTransaction({account: input.account, transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}), chain, options: {preflightCommitment: "confirmed", commitment: "confirmed", skipPreflight: false}});
    if (!sent?.signature) throw new Error("The wallet did not return a Devnet refund signature.");
    signature = encodeBase58(sent.signature);
  } else if (features[SolanaSignTransaction]) {
    const [signed] = await features[SolanaSignTransaction].signTransaction({account: input.account, transaction: transaction.serialize({requireAllSignatures: false, verifySignatures: false}), chain, options: {preflightCommitment: "confirmed"}});
    if (!signed?.signedTransaction) throw new Error("The wallet did not return a signed Devnet refund transaction.");
    signature = await connection.sendRawTransaction(signed.signedTransaction, {preflightCommitment: "confirmed"});
  } else throw new Error("This wallet does not support Solana transaction signing.");
  const explorerUrl = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
  input.onSubmitted?.(signature, explorerUrl);
  const confirmation = await pollFinality(connection, signature, blockhash.lastValidBlockHeight);
  return {signature, explorerUrl, confirmation};
}

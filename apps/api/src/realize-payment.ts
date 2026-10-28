import {Connection, PublicKey} from "@solana/web3.js";
import {getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount} from "@solana/spl-token";
import {createHash} from "node:crypto";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {verifyFinalizedUsdcTransfer, isValidSolanaAddress} from "@vox/solana";
import type {CommissionV1, RealizeQuoteV1} from "@vox/protocol";

export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export interface RealizePaymentVerification {
  finalized: boolean;
  matched: boolean;
  /** A finalized execution error is distinct from an ambiguous nonmatching receipt. */
  execution_failed?: boolean;
  reason?: string;
  /** Finalized Solana transaction block time, in Unix seconds. */
  block_time?: number;
}

export interface MainnetSplUsdcFundingAuthorization {
  mode: "direct";
  custody_model: "backend_managed";
  network_id: "solana:mainnet-beta";
  usdc_mint: string;
  destination_token_account: string;
  destination_owner: string;
  amount_usdc_atomic: string;
  payment_reference: string;
  payer_wallet: string;
  commission_id: string;
  quote_id: string;
  accepted_quote_hash: string;
  expires_at: string;
}

export type RealizePaymentAuthorization = MainnetSplUsdcFundingAuthorization | import("./realize-solana-devnet.js").EscrowFundingAuthorization;

export interface RealizePaymentRail<Authorization extends RealizePaymentAuthorization = RealizePaymentAuthorization> {
  readonly mode: Authorization["mode"];
  readonly networkId: string;
  readonly usdcMint: string;
  prepareFunding(input: {quote: RealizeQuoteV1; commission: CommissionV1; payerWallet: string; authorizedIssuerPublicKey: string}): Promise<Authorization>;
  verifyFunding(funding: Authorization, transactionSignature: string, payerWallet: string): Promise<RealizePaymentVerification>;
}

export interface MainnetRealizePaymentRailOptions {
  rpcUrl: string;
  treasuryTokenAccount: string;
  treasuryOwner: string;
  minPaymentAtomic?: string;
  maxPaymentAtomic: string;
  verifyTransfer?: typeof verifyFinalizedUsdcTransfer;
  getGenesisHash?: () => Promise<string>;
  validateTreasury?: () => Promise<void>;
}

function requiredAddress(value: string, label: string): string {
  if (!isValidSolanaAddress(value)) throw new Error(`${label} is not a valid Solana address`);
  return new PublicKey(value).toBase58();
}

function paymentReference(paymentIntentId: string, quoteHash: string): string {
  return `vox:realize:payment:${paymentIntentId}:${quoteHash}`;
}

/** Mainnet direct-transfer rail. Funds are paid to a configured treasury account;
 * settlement and refunds remain backend-managed and are not trustless escrow. */
export class MainnetSplUsdcRealizePaymentRail implements RealizePaymentRail<MainnetSplUsdcFundingAuthorization> {
  readonly mode = "direct" as const;
  readonly networkId = "solana:mainnet-beta" as const;
  readonly usdcMint = MAINNET_USDC_MINT;
  readonly connection: Connection;
  private readonly verifyTransfer: typeof verifyFinalizedUsdcTransfer;
  private readonly getGenesisHash: () => Promise<string>;
  private readonly validateTreasuryOverride: (() => Promise<void>) | undefined;
  private readonly treasuryTokenAccount: string;
  private readonly treasuryOwner: string;
  private readonly minPaymentAtomic: bigint;
  private readonly maxPaymentAtomic: bigint;

  constructor(options: MainnetRealizePaymentRailOptions) {
    const rpc = new URL(options.rpcUrl);
    if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash) throw new Error("Mainnet Realize RPC must be an HTTPS URL without embedded credentials");
    const minimum = options.minPaymentAtomic ?? "1000000";
    if (!/^[1-9][0-9]{0,10}$/.test(minimum) || BigInt(minimum) < 1_000_000n) throw new Error("Mainnet Realize minimum payment must be at least 1 USDC");
    if (!/^[1-9][0-9]{0,10}$/.test(options.maxPaymentAtomic) || BigInt(options.maxPaymentAtomic) > 10_000_000_000n) throw new Error("Mainnet Realize maximum payment must be a positive USDC amount no greater than 10000 USDC");
    if (BigInt(options.maxPaymentAtomic) < BigInt(minimum)) throw new Error("Mainnet Realize maximum payment must be at least its minimum");
    this.connection = new Connection(rpc.href, "finalized");
    this.getGenesisHash = options.getGenesisHash ?? (() => this.connection.getGenesisHash());
    this.validateTreasuryOverride = options.validateTreasury;
    this.treasuryTokenAccount = requiredAddress(options.treasuryTokenAccount, "Mainnet treasury USDC token account");
    this.treasuryOwner = requiredAddress(options.treasuryOwner, "Mainnet treasury owner");
    this.minPaymentAtomic = BigInt(minimum);
    this.maxPaymentAtomic = BigInt(options.maxPaymentAtomic);
    this.verifyTransfer = options.verifyTransfer ?? verifyFinalizedUsdcTransfer;
  }

  private async assertMainnet(): Promise<void> {
    if (await this.getGenesisHash() !== SOLANA_MAINNET_GENESIS_HASH) throw new Error("Configured Realize RPC does not serve Solana mainnet-beta");
  }

  private async assertTreasury(): Promise<void> {
    await this.assertMainnet();
    const key = new PublicKey(this.treasuryTokenAccount);
    const owner = new PublicKey(this.treasuryOwner);
    const expectedAta = getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC_MINT), owner);
    if (!expectedAta.equals(key)) throw new Error("Configured Mainnet treasury token account is not the treasury owner's classic USDC associated account");
    if (this.validateTreasuryOverride) {
      await this.validateTreasuryOverride();
      return;
    }
    const info = await this.connection.getAccountInfo(key, "finalized");
    // Let the first payer create the treasury ATA in the same transaction as
    // their transfer. The wallet pays the one-time rent; settlement still
    // requires a separately funded treasury SOL reserve.
    if (!info) return;
    if (!info.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("Configured Mainnet treasury destination is not a classic SPL Token account");
    const token = unpackAccount(key, info, TOKEN_PROGRAM_ID);
    if (token.mint.toBase58() !== MAINNET_USDC_MINT || token.owner.toBase58() !== this.treasuryOwner) throw new Error("Configured Mainnet treasury account does not match the official USDC mint and treasury owner");
  }

  async prepareFunding(input: {quote: RealizeQuoteV1; commission: CommissionV1; payerWallet: string; authorizedIssuerPublicKey: string}): Promise<MainnetSplUsdcFundingAuthorization> {
    const {quote, commission} = input;
    if (quote.network_id !== this.networkId || quote.usdc_mint !== this.usdcMint) throw new Error("Mainnet Realize accepts only standard SPL USDC quotes on Solana mainnet-beta");
    if (quote.commission_id !== commission.commission_id || commission.quote_id !== quote.quote_id || commission.accepted_quote_hash !== quote.canonical_quote_hash) throw new Error("Mainnet payment intent must match the accepted commission quote");
    if (BigInt(quote.total_amount_usdc_atomic) < this.minPaymentAtomic) throw new Error("Quote is below the configured Mainnet Realize minimum payment");
    if (BigInt(quote.total_amount_usdc_atomic) > this.maxPaymentAtomic) throw new Error("Quote exceeds the configured Mainnet Realize per-payment limit");
    if (Date.parse(quote.expires_at) <= Date.now()) throw new Error("Mainnet Realize quote has expired");
    requiredAddress(input.payerWallet, "Realize payer wallet");
    await this.assertTreasury();
    const paymentIntentId = `vox:payment-intent:${createHash("sha256").update(`${commission.commission_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
    return {
      mode: "direct", custody_model: "backend_managed", network_id: this.networkId,
      usdc_mint: this.usdcMint, destination_token_account: this.treasuryTokenAccount, destination_owner: this.treasuryOwner,
      amount_usdc_atomic: quote.total_amount_usdc_atomic,
      payment_reference: paymentReference(paymentIntentId, quote.canonical_quote_hash),
      payer_wallet: input.payerWallet, commission_id: commission.commission_id,
      quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash,
      expires_at: quote.expires_at
    };
  }

  async verifyFunding(funding: MainnetSplUsdcFundingAuthorization, transactionSignature: string, payerWallet: string): Promise<RealizePaymentVerification> {
    const paymentIntentId = `vox:payment-intent:${createHash("sha256").update(`${funding.commission_id}\u0000${funding.accepted_quote_hash}`).digest("hex")}`;
    if (funding.mode !== "direct" || funding.custody_model !== "backend_managed" || funding.network_id !== this.networkId || funding.usdc_mint !== this.usdcMint || funding.destination_token_account !== this.treasuryTokenAccount || funding.destination_owner !== this.treasuryOwner || funding.payer_wallet !== payerWallet || funding.payment_reference !== paymentReference(paymentIntentId, funding.accepted_quote_hash) || !/^[1-9][0-9]{0,19}$/.test(funding.amount_usdc_atomic) || BigInt(funding.amount_usdc_atomic) < this.minPaymentAtomic || BigInt(funding.amount_usdc_atomic) > this.maxPaymentAtomic) {
      return {finalized: true, matched: false, reason: "Payment authorization does not match the configured Mainnet treasury and USDC policy."};
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(transactionSignature)) return {finalized: true, matched: false, reason: "Payment transaction signature is invalid."};
    await this.assertMainnet();
    const result = await this.verifyTransfer({
      rpc_url: this.connection.rpcEndpoint,
      transaction_signature: transactionSignature,
      network_id: this.networkId,
      usdc_mint: this.usdcMint,
      destination_token_account: this.treasuryTokenAccount,
      amount_atomic: funding.amount_usdc_atomic,
      payer_address: payerWallet,
      payment_reference: funding.payment_reference
    });
    return {finalized: result.finalized, matched: result.matched && result.network_matches !== false, ...(result.execution_failed === true ? {execution_failed: true} : {}), ...(result.block_time === undefined ? {} : {block_time: result.block_time}), ...(!result.matched || result.network_matches === false ? {reason: result.reason ?? "Finalized transaction does not match the Mainnet quote-bound USDC payment intent."} : {})};
  }
}

export function configuredMainnetRealizePaymentRail(env: Readonly<Record<string, string | undefined>> = process.env): MainnetSplUsdcRealizePaymentRail | undefined {
  if (env.VOX_REALIZE_MAINNET_ENABLED !== "true") return undefined;
  const rpcUrl = env.VOX_REALIZE_MAINNET_RPC_URL?.trim();
  const treasuryTokenAccount = env.VOX_REALIZE_MAINNET_TREASURY_TOKEN_ACCOUNT?.trim();
  const treasuryOwner = env.VOX_REALIZE_MAINNET_TREASURY_OWNER?.trim();
  const maxPaymentAtomic = env.VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC?.trim();
  const minPaymentAtomic = env.VOX_REALIZE_MAINNET_MIN_PAYMENT_USDC_ATOMIC?.trim() || "1000000";
  const configuredMaxPaymentAtomic = maxPaymentAtomic || "10000000000";
  if (!rpcUrl || !treasuryTokenAccount || !treasuryOwner) throw new Error("Mainnet Realize is enabled but its RPC, treasury account, or treasury owner is not configured");
  if (env.VOX_REALIZE_MAINNET_USDC_MINT && env.VOX_REALIZE_MAINNET_USDC_MINT !== MAINNET_USDC_MINT) throw new Error("Mainnet Realize USDC mint must be the official classic SPL USDC mint");
  return new MainnetSplUsdcRealizePaymentRail({rpcUrl, treasuryTokenAccount, treasuryOwner, minPaymentAtomic, maxPaymentAtomic: configuredMaxPaymentAtomic});
}

export function isManagedRealizeSettlementConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const endpoint = env.VOX_REALIZE_SETTLEMENT_URL?.trim();
  if (!endpoint || !env.VOX_REALIZE_SETTLEMENT_TOKEN?.trim()) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

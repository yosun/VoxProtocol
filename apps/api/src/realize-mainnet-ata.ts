import {ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {PublicKey} from "@solana/web3.js";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";

/** Derive the classic SPL Mainnet USDC ATA for a treasury owner. */
export function deriveMainnetTreasuryUsdcAta(owner: string, mint: string = MAINNET_USDC_MINT): string {
  if (mint !== MAINNET_USDC_MINT) throw new Error("treasury ATA derivation is pinned to the official Mainnet USDC mint");
  return getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  ).toBase58();
}

/** Resolve the deployment value while rejecting a manually supplied mismatch. */
export function resolveMainnetTreasuryUsdcAta(owner: string, mint: string, configured?: string): string {
  const derived = deriveMainnetTreasuryUsdcAta(owner, mint);
  if (configured && configured !== derived) throw new Error("configured Mainnet treasury USDC account does not match the owner and mint derived ATA");
  return derived;
}

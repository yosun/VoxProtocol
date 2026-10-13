import {createClient} from "@solana/kit";
import {solanaRpc} from "@solana/kit-plugin-rpc";
import {walletSigner} from "@solana/kit-plugin-wallet";

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

const configuredCluster = (import.meta.env.VITE_SOLANA_CLUSTER as SolanaCluster | undefined) ?? "devnet";
const chain: `${string}:${string}` = configuredCluster === "mainnet-beta" ? "solana:mainnet" : `solana:${configuredCluster}`;
const defaultRpcUrl = configuredCluster === "mainnet-beta"
  ? "https://api.mainnet-beta.solana.com"
  : `https://api.${configuredCluster}.solana.com`;

/** Wallet Standard discovery and signer lifecycle for Phantom, Solflare, Backpack, and compatible wallets. */
export const solanaWalletClient = createClient()
  .use(walletSigner({chain, storage: typeof window === "undefined" ? null : window.sessionStorage}))
  .use(solanaRpc({rpcUrl: import.meta.env.VITE_SOLANA_RPC_URL as string | undefined ?? defaultRpcUrl}));

export function walletChainForCluster(cluster: string): `${string}:${string}` | undefined {
  if (cluster === "mainnet-beta") return "solana:mainnet";
  if (cluster === "devnet" || cluster === "testnet") return `solana:${cluster}`;
  return undefined;
}

export function configuredWalletCluster(): SolanaCluster {
  return configuredCluster;
}

import {getBase58Decoder, getBase58Encoder} from "@solana/kit";
import type {PublicKey} from "@solana/web3.js";
import type {SolanaSignAndSendTransactionFeature} from "@solana/wallet-standard-features";
import SolflareWalletProvider from "@solflare-wallet/sdk/lib/esm/adapters/WalletProvider.js";
import {getWallets} from "@wallet-standard/app";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import type {StandardConnectFeature, StandardDisconnectFeature, StandardEventsFeature, StandardEventsListeners} from "@wallet-standard/features";
import type {SolanaCluster} from "./solana-wallet.js";

const SOLFLARE_PROVIDER = "https://solflare.com/provider";
const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMTgiIGZpbGw9IiNmZjk1MDAiLz48Y2lyY2xlIGN4PSIyMCIgY3k9IjIwIiByPSI4IiBmaWxsPSIjMTExIi8+PC9zdmc+";

type SolflareProvider = {
  readonly connected: boolean;
  readonly publicKey: PublicKey | null;
  readonly _popup: Window | null;
  on(event: "connect" | "disconnect", listener: () => void): unknown;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  _sendRequest(method: string, params: unknown): Promise<unknown>;
};

/** Adapt Solflare's browser wallet to the same Wallet Standard interface as installed wallets. */
class SolflareWebWallet implements Wallet {
  readonly version = "1.0.0" as const;
  readonly name = "Solflare Web Wallet";
  readonly icon = ICON as Wallet["icon"];
  readonly chains: Wallet["chains"];
  private currentAccount: WalletAccount | undefined;
  private provider: SolflareProvider | undefined;
  private connecting: Promise<void> | undefined;
  private closeMonitor: number | undefined;
  private readonly listeners = new Set<StandardEventsListeners["change"]>();

  constructor(private readonly cluster: SolanaCluster, private readonly chain: `${string}:${string}`) {
    this.chains = [chain];
  }

  get accounts(): readonly WalletAccount[] { return this.currentAccount ? [this.currentAccount] : []; }

  private setAccount(publicKey: PublicKey | null | undefined): void {
    const address = publicKey?.toBase58();
    if (address === this.currentAccount?.address) return;
    this.currentAccount = publicKey ? {
      address: address!, publicKey: publicKey.toBytes(), chains: this.chains, features: ["solana:signAndSendTransaction"]
    } : undefined;
    for (const listener of this.listeners) listener({accounts: this.accounts});
  }

  private finish(provider: SolflareProvider): void {
    if (this.provider !== provider) return;
    if (this.closeMonitor !== undefined) window.clearInterval(this.closeMonitor);
    this.closeMonitor = undefined;
    this.provider = undefined;
    this.setAccount(undefined);
  }

  private connect(): Promise<void> {
    if (this.provider?.connected && this.currentAccount) return Promise.resolve();
    if (this.connecting) return this.connecting;
    // Use the pinned SDK's web provider directly so its popup opens during the
    // user's click. It validates both the popup's origin and its window source.
    const Provider = SolflareWalletProvider as unknown as new (url: string, network: string) => SolflareProvider;
    const provider = new Provider(SOLFLARE_PROVIDER, this.cluster);
    this.provider = provider;
    provider.on("connect", () => { if (this.provider === provider) this.setAccount(provider.publicKey); });
    provider.on("disconnect", () => this.finish(provider));
    const pending = provider.connect();
    const popup = provider._popup;
    if (!popup) {
      void provider.disconnect();
      this.finish(provider);
      return Promise.reject(new Error("The Solflare window was blocked. Allow popups for VOX and try again."));
    }
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      this.closeMonitor = window.setInterval(() => {
        if (!popup.closed) return;
        void provider.disconnect();
        this.finish(provider);
        if (!settled) {
          settled = true;
          reject(new Error("Solflare connection was canceled. Try again."));
        }
      }, 250);
      pending.then(() => {
        if (settled) return;
        settled = true;
        if (this.provider === provider && this.currentAccount) resolve();
        else reject(new Error("Solflare did not return a wallet account."));
      }, (reason: unknown) => {
        if (settled) return;
        settled = true;
        this.finish(provider);
        reject(reason instanceof Error ? reason : new Error("Solflare connection was canceled. Try again."));
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  readonly features: StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature & SolanaSignAndSendTransactionFeature = {
    "standard:connect": {version: "1.0.0", connect: async (input) => {
      // A browser wallet needs an explicit click to open its window after reload.
      if (!input?.silent) await this.connect();
      return {accounts: this.accounts};
    }},
    "standard:disconnect": {version: "1.0.0", disconnect: async () => {
      const provider = this.provider;
      if (provider) {
        await provider.disconnect();
        this.finish(provider);
      }
    }},
    "standard:events": {version: "1.0.0", on: (_event, listener) => {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    }},
    "solana:signAndSendTransaction": {version: "1.0.0", supportedTransactionVersions: ["legacy"], signAndSendTransaction: async (...inputs) => {
      const results = [];
      for (const input of inputs) {
        const provider = this.provider;
        if (!provider?.connected || !provider.publicKey || provider.publicKey.toBase58() !== input.account.address || this.currentAccount?.address !== input.account.address || provider._popup?.closed !== false) throw new Error("Reconnect the wallet that accepted this quote.");
        if (input.chain !== this.chain) throw new Error(`Connect Solflare on Solana ${this.cluster} before continuing.`);
        const response = await provider._sendRequest("signAndSendTransaction", {
          transaction: getBase58Decoder().decode(input.transaction),
          options: {
            ...(input.options?.preflightCommitment ? {preflightCommitment: input.options.preflightCommitment} : {}),
            ...(input.options?.skipPreflight !== undefined ? {skipPreflight: input.options.skipPreflight} : {}),
            ...(input.options?.maxRetries !== undefined ? {maxRetries: input.options.maxRetries} : {})
          }
        }) as {signature?: unknown} | null;
        // The provider may already have submitted the transaction. Preserve a
        // usable signature for VOX's on-chain verification even if extra response
        // fields are absent; never infer payment from this response alone.
        const missingSignature = "Solflare did not return a usable transaction signature. Check your wallet activity before trying again.";
        if (typeof response?.signature !== "string") throw new Error(missingSignature);
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(getBase58Encoder().encode(response.signature)); }
        catch { throw new Error(missingSignature); }
        if (bytes.length !== 64) throw new Error(missingSignature);
        results.push({signature: bytes});
      }
      return results;
    }}
  };
}

export function registerSolflareWebWallet(cluster: SolanaCluster, chain: `${string}:${string}`): void {
  if (typeof window !== "undefined") getWallets().register(new SolflareWebWallet(cluster, chain));
}

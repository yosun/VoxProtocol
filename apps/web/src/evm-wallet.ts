export interface Eip1193Provider {
  request(input: {method: string; params?: unknown[] | object}): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

interface EvmNetwork {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: {name: string; symbol: string; decimals: number};
}

const NETWORKS: Record<string, EvmNetwork> = {
  "base:mainnet": {chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"], nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}},
  "monad:mainnet": {chainId: "0x8f", chainName: "Monad", rpcUrls: ["https://rpc.monad.xyz"], blockExplorerUrls: ["https://monadscan.com"], nativeCurrency: {name: "MON", symbol: "MON", decimals: 18}},
  "monad:testnet": {chainId: "0x279f", chainName: "Monad Testnet", rpcUrls: ["https://testnet-rpc.monad.xyz"], blockExplorerUrls: ["https://testnet.monadscan.com"], nativeCurrency: {name: "MON", symbol: "MON", decimals: 18}},
  "arbitrum:mainnet": {chainId: "0xa4b1", chainName: "Arbitrum One", rpcUrls: ["https://arb1.arbitrum.io/rpc"], blockExplorerUrls: ["https://arbiscan.io"], nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}},
  "ethereum:mainnet": {chainId: "0x1", chainName: "Ethereum", rpcUrls: ["https://ethereum.publicnode.com"], blockExplorerUrls: ["https://etherscan.io"], nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}},
  "hyperevm:mainnet": {chainId: "0x3e7", chainName: "HyperEVM", rpcUrls: ["https://rpc.hyperliquid.xyz/evm"], blockExplorerUrls: ["https://hyperevmscan.io"], nativeCurrency: {name: "HYPE", symbol: "HYPE", decimals: 18}},
  "robinhood:mainnet": {chainId: "0x1237", chainName: "Robinhood Chain", rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"], blockExplorerUrls: ["https://robinhoodchain.blockscout.com"], nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}}
};

function provider(): Eip1193Provider {
  if (!window.ethereum) throw new Error("No compatible EVM wallet was found. Install or unlock an EVM wallet such as MetaMask.");
  return window.ethereum;
}

function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("The EVM wallet returned an invalid address.");
  return value;
}

export function nftClaimMessage(input: {mint_id: string; chain: string; created_at: string}, wallet: string): string {
  return `VOX NFT claim\nMint: ${input.mint_id}\nChain: ${input.chain}\nWallet: ${wallet}\nCreated: ${input.created_at}`;
}

export async function connectEvmWallet(chain: string): Promise<{wallet: Eip1193Provider; address: string; network: EvmNetwork}> {
  const network = NETWORKS[chain];
  if (!network) throw new Error(`No EVM wallet configuration exists for ${chain}.`);
  const wallet = provider();
  const accounts = await wallet.request({method: "eth_requestAccounts"});
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  const account = address(first);
  const currentChain = String(await wallet.request({method: "eth_chainId"})).toLowerCase();
  if (currentChain !== network.chainId.toLowerCase()) {
    try {
      await wallet.request({method: "wallet_switchEthereumChain", params: [{chainId: network.chainId}]});
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as {code?: unknown}).code : undefined;
      if (code !== 4902) throw error;
      await wallet.request({method: "wallet_addEthereumChain", params: [network]});
    }
    const switched = String(await wallet.request({method: "eth_chainId"})).toLowerCase();
    if (switched !== network.chainId.toLowerCase()) throw new Error(`Switch your wallet to ${network.chainName} before claiming.`);
  }
  return {wallet, address: account, network};
}

export async function signNftClaim(chain: string, input: {mint_id: string; created_at: string}): Promise<{wallet: string; signature: string}> {
  const connected = await connectEvmWallet(chain);
  const message = nftClaimMessage({mint_id: input.mint_id, chain, created_at: input.created_at}, connected.address);
  const messageHex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const signature = await connected.wallet.request({method: "personal_sign", params: [messageHex, connected.address]});
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("The EVM wallet returned an invalid claim signature.");
  return {wallet: connected.address, signature};
}

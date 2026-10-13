# `@vox/realize-solana` 0.2.0

VOX Realize's network-aware Solana escrow client and generated IDL. Build it from the repository root with `npm run build --workspace @vox/realize-solana`.

The devnet and mainnet profiles have separate RPC, program ID, USDC mint, admin, quote-authority, and fulfillment-authority fields. Configure them with the matching `VOX_REALIZE_DEVNET_*` and `VOX_REALIZE_MAINNET_*` variables shown in the root `.env.example`, then call `settlementNetworksFromEnvironment(process.env)`. The package pins the official USDC mint for each cluster and rejects a different mint. Both profiles remain disabled unless explicitly enabled after deployment and on-chain configuration verification.

Version `0.2.0` is deployed and configured on Devnet at `GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb`. The generated IDL at `src/idl.json` matches the on-chain build (SHA-256 `39c8992069bfeff7a35630195b53f0c287f5a1db25e080feaacf26c9137f4d24`). Its config PDA is `DZdQE4QRJSq1yusCtV8X4Jt3AXE97YLpqQVkp1magdfm`, and its authorized Devnet USDC mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Local adversarial tests and live Devnet funding, two-recipient claim settlement, and refund-path tests passed. The refund test deliberately simulated a failure attestation; it did not represent a failed generation job. The package remains opt-in: runtime settlement requires the Devnet enablement flag plus an on-chain config match. Mainnet is prepared but undeployed and disabled. See [`docs/realize-devnet-operations.md`](../../docs/realize-devnet-operations.md), [`docs/realize-solana-escrow.md`](../../docs/realize-solana-escrow.md), and [`deployments/realize-settlement.json`](../../deployments/realize-settlement.json) for deployment facts and the trust model.

## Integration outline

```ts
import {
  assertConfigMatchesNetwork,
  configAddress,
  decodeConfigAccount,
  prepareEscrow,
  quoteVerificationInstruction,
  getEscrowInstruction,
  settlementNetworksFromEnvironment,
  INSTRUCTIONS_SYSVAR,
  SYSTEM_PROGRAM,
} from "@vox/realize-solana";

const networks = settlementNetworksFromEnvironment(process.env);
const network = networks.devnet;
if (!network.active || !network.programId) throw new Error("Devnet settlement is disabled or has no configured program ID");

const expectedConfigAddress = await configAddress(network.programId);
const rawConfig = await fetchProgramAccount(network.rpcEndpoint, expectedConfigAddress);
const config = decodeConfigAccount(network.programId, rawConfig.owner, expectedConfigAddress, rawConfig.data);
assertConfigMatchesNetwork(network, config);

const prepared = await prepareEscrow({
  quote, commission, authorizedIssuerPublicKey, network, config,
  payer: payerAddress, nowSeconds, refundAfter,
});

// The settlement quote authority verifies the accepted VOX quote and payout
// list, then signs prepared.quoteDomainHash on the server. The client receives
// that signature; it never receives the authority's private key.
const verifyQuote = quoteVerificationInstruction(
  network.quoteAuthority!, quoteDomainSignature, prepared.quoteDomainHash,
);
const createEscrow = getEscrowInstruction("create_escrow", {
  payer: payerAddress,
  config: prepared.accounts.config,
  escrow: prepared.accounts.escrow,
  quote_used: prepared.accounts.quoteUsed,
  mint: network.usdcMint,
  vault: prepared.accounts.vault,
  token_program: network.tokenProgram,
  instructions: INSTRUCTIONS_SYSVAR,
  system_program: SYSTEM_PROGRAM,
}, { args: prepared.createArgs }, network.programId);
// Include verifyQuote immediately before createEscrow in one transaction.
```

Append the exact prepared payout entries in batches of at most eight, seal the escrow, and fund it. After successful off-chain fulfillment, the configured fulfillment authority attests once. Each committed recipient can then claim its exact amount to its associated token account. Clients should simulate each real transaction and resume from the on-chain claim bitmap after interruption.

# VOX Realize Solana escrow 0.2.0

## Release and deployment status

This is a versioned, unaudited settlement service. The crate is `realize-escrow` 0.2.0, the protocol domain is version 2, and the client package is `@vox/realize-solana` 0.2.0. It is deployed and configured on Devnet; it has no mainnet deployment. Anchor CLI 1.2.1 generates the canonical IDL from the compiled Anchor program; the output matches the checked-in artifacts at `idl/realize_escrow.json` and `packages/realize-solana/src/idl.json`.

The deployed Devnet program ID is `GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb`; its reproducible program keypair is stored locally as documented in [Devnet operations](realize-devnet-operations.md). The config PDA `DZdQE4QRJSq1yusCtV8X4Jt3AXE97YLpqQVkp1magdfm` is initialized with the Devnet USDC mint and documented settlement authorities. Local adversarial tests and live Devnet funding, N-way claim settlement, and refund tests pass. Runtime settlement is disabled by default and requires explicit `VOX_REALIZE_DEVNET_ENABLED=true` plus an on-chain config check. Mainnet remains `prepared-inactive` and undeployed.

The official classic SPL Token USDC mint values used by deployment profiles are devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` and mainnet-beta `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; both use six decimals. Devnet and mainnet are separate builds (`devnet` and `mainnet` Cargo features). The shared Rust escrow logic does not embed a cluster mint: the one-time config account stores the deployment's authorized mint, while the versioned network profile pins the official mint and rejects a mismatching on-chain config. During initialization the program checks the mint's classic Token Program owner and six decimals; the deployment operator must choose the official mint for that cluster. Localnet deliberately permits a test mint so validator tests can create isolated test assets.

The mint values follow [Circle's Solana USDC page](https://www.circle.com/multi-chain-usdc/solana) and [Circle's token address reference](https://developers.circle.com/stablecoins/usdc-contract-addresses). Solana's [production readiness guidance](https://solana.com/docs/tools/production-readiness) likewise recommends cluster-specific environment settings and mint allowlists rather than accepting token mints from an untrusted client.

## Network configuration

`deployments/realize-settlement.json` is the public, non-secret deployment registry. The TypeScript client exposes `settlementNetworksFromEnvironment(env)` to apply independent RPC endpoint, program ID, expected mint, admin, quote-authority, and fulfillment-authority settings from `.env`. Mint values are pinned to the official cluster values and rejected if overridden. Both runtime profiles are disabled by default and require explicit enablement plus config verification. The registry records Devnet as deployed and tested; the sample environment leaves it opt-in. An endpoint override changes where the client connects; on-chain config and program checks still determine whether settlement is accepted.

The program's singleton config PDA is initialized once. The initializer must sign as the current loader-v3 upgrade authority for this program, verified against ProgramData. The config records the cluster compiled into that binary, protocol version, configured official mint, classic SPL Token program, admin, quote authority, and fulfillment authority. Mint, token program, cluster, and protocol version are immutable. Initialization cannot be repeated. Only the config admin may rotate quote/fulfillment authorities; each change increments a revision and invalidates prior signatures. Admin transfer requires both current and replacement admins to sign. Emergency pause can be set for at most one hour and only blocks new creation, funding, and attestation; it cannot stop claims or timeout refunds. No admin withdrawal or recipient rerouting instruction exists.

The deployed program's upgrade authority remains a privileged code authority until explicitly revoked or placed under the operator's governance. The same operator-controlled authority initializes the config. Production operations must protect it and must pin the deployed binary/program address and config account before accepting payments. The config admin can renew one-hour pauses repeatedly; a compromised admin can therefore keep new activity paused, although existing claims and eligible refunds continue.

Solana's [program deployment documentation](https://solana.com/docs/core/programs/program-deployment) describes the loader-v3 upgrade authority and the effect of revoking it; this program deliberately requires that authority to initialize its config account.

## Escrow design and settlement choice

The program uses **claim-based settlement**. Direct atomic distribution is simpler for a small, fixed recipient set: one transaction either transfers to everyone or fails, and no balances remain for beneficiaries to claim. It becomes a poor fit as N grows because every recipient ATA must be writable in the settlement transaction, account and instruction limits constrain the batch, and the full multi-recipient CPI transaction must fit the current transaction and compute budgets. Splitting direct transfers over transactions would need persistent progress state anyway and introduces partially paid batches.

Claims move the transfer to beneficiary-selected transactions. VOX records a committed entitlement list, and a shared 64-bit bitmap records one-time claims. This bounds the maximum list at 64 recipients but removes the requirement that every recipient fit in one payout transaction. Payouts are appended in batches of at most eight; `seal` only succeeds when the count is exact, the integer sum equals the quote total, and the full commitment matches. A claim transfers only the stored amount to the exact recipient's associated token account. The bit and paid counter are updated atomically with the token CPI; a failed/interrupted transaction leaves the claim available. The terminal `Settled` state requires every bit set and paid total equal to escrow total.

This design has tradeoffs: a beneficiary must retain access to its wallet and pay or obtain a transaction fee sponsor; a frozen or unavailable account may remain unclaimed; and there is no admin sweep or reassignment. The 64-recipient maximum is a deliberate bounded v1 limit, not arbitrary N. A larger version would need a different storage and proof design such as sharded claim accounts or a Merkle root.

## Quote, payout, and replay commitments

Before escrow creation, the VOX settlement quote authority must validate the accepted Realize quote and exact commission/payout records off-chain. It signs the 32-byte `quoteDomainHash` returned by `prepareEscrow`; the Ed25519 verification instruction must be immediately before `create_escrow`. The signed domain contains:

- cluster identity, program ID, protocol version, config PDA and config revision;
- authorized mint, token program, quote authority, and fulfillment authority;
- unique commission digest and canonical accepted quote hash;
- payer, complete payout commitment, total atomic USDC amount, recipient count, quote expiry, and refund deadline.

The payout commitment independently hashes the deployment/commission header and every `(index, recipient, integer amount)` pair. It excludes the domain signature itself to avoid a circular digest; the domain signature then authorizes that final payout commitment. Consequently, a client cannot change payout recipients or amounts while reusing a quote-authority signature. The escrow PDA binds the config and commission digest. A second PDA keyed by the accepted quote hash prevents replay of the same accepted quote under another commission. All signatures are cluster- and program-domain-separated; a devnet signature fails on localnet or mainnet and a signature for another program address fails.

The program verifies the Ed25519 precompile's immediately preceding instruction using the Instructions sysvar, then recomputes the domain on-chain. It does not trust frontend network checks. Mint address, mint decimals, mint owner, token program, source owner, source mint, vault PDA/authority/mint, and destination ATA owner/mint are checked against the initialized config or escrow snapshot on-chain. Only classic SPL Token is supported in this protocol version; Token-2022 is rejected.

The program verifies the quote authority's signed binary commitment, not the quote JSON itself. The quote authority is responsible for validating the issuer signature, commission acceptance, payout destinations, and amounts against the shared Realize protocol contracts before signing. See the client package example for the server/client boundary.

## Trust and authority model

- **Quote authority:** trusted server-side signer that verifies the accepted quote/commission and signs the exact commission and payout commitment. A compromised quote key can authorize a malicious payout list at new escrow creation, but cannot withdraw funds from an existing escrow or change an already signed allocation. Rotate it through the config admin; rotation increments the deployment revision.
- **Fulfillment authority:** narrowly scoped service key that attests success or failure once for a funded escrow before the refund deadline. The chain cannot independently determine whether video generation succeeded. A compromised attester can falsely release funds early, but the payout commitment and recipient accounts are already fixed by the quote-authority signature, so it cannot redirect funds. A failure attestation makes payer refund eligible.
- **Config admin:** begins as the program upgrade authority. It may rotate the two settlement authorities, transfer admin with both signatures, and set a bounded pause. It cannot choose a new mint after initialization, edit an escrow, withdraw, or redirect claims.
- **Payer:** creates and funds its commission escrow, edits only its draft/ready payout list, and can cancel only before funding. After funding the payer cannot cancel unilaterally.
- **Beneficiaries/relayers:** a claim can be submitted permissionlessly, but payment goes only to the committed beneficiary's associated token account. The caller cannot substitute a destination.

Timeout refund eligibility is deterministic: a funded escrow becomes refundable at `unix_timestamp >= refund_after` unless the fulfillment authority has already attested success or failure. A failure attestation permits immediate payer refund. Success permanently disables refund and enables beneficiary claims. Draft/ready escrows can expire at `quote_expires_at`; only the payer can cancel them before funding. These paths cannot race a successful claim because Solana executes each account mutation atomically.

## PDA rules

All seeds use the program's deployed address and Solana's standard PDA derivation:

- Config: `[b"config", b"vox-realize-v1"]`
- Escrow: `[b"escrow", config_pubkey, commission_digest_32]`
- Quote replay guard: `[b"quote", config_pubkey, accepted_quote_hash_32]`
- Vault: `[b"vault", escrow_pubkey]`
- Beneficiary token account: associated-token PDA for `[recipient, classic_token_program, configured_usdc_mint]`

`commission_digest_32` is `domainHash("vox.realize.solana.commission.v1", utf8(commission_id))`. Use `configAddress`, `commissionSeed`, and `escrowAddresses` from the client package; do not duplicate these derivations in application code.

## Build and deployment procedure

Build explicit network variants from the repository root. These commands compile; they do not deploy:

```sh
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml --no-default-features --features devnet
cargo build-sbf --manifest-path programs/realize-escrow/Cargo.toml --no-default-features --features mainnet
```

The disposable Devnet program, fee-payer, upgrade, quote, and fulfillment keypairs are provisioned under `.vox-local/realize-devnet/` with owner-only file permissions. The deployed program is `GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb`; its deployment signature, config initialization signature, binary hash, mint, authorities, and live test results are recorded in `realize-devnet-operations.md` and `deployments/realize-settlement.json`. Program-sized account rent is locked on Devnet. To rerun the live integration test with disposable test quotes, ensure the fee payer has at least 1.45 test USDC, then run `npm run test:realize-escrow:devnet`. Runtime apps still need explicit enablement and must compare the fetched on-chain config against the selected profile.

Mainnet has an inactive-feature build only. There is no mainnet signer or deployment, and the network profile remains disabled. No mainnet transaction has been submitted. Mainnet deployment requires separate explicit approval.

## Tests and generated artifacts

Run the complete local suite with:

```sh
npm run test:realize-escrow
```

It formats and builds localnet, devnet, and mainnet SBF variants, runs Rust property tests for cluster/domain binding, integer overflow and randomized claim order/conservation, regenerates and byte-compares both IDL copies, builds the protocol/client packages, runs client/protocol tests, and starts a disposable `solana-test-validator` to execute the compiled program and classic Token CPIs. The validator tests unauthorized initialization, wrong mint/program/token program, config/account/PDA substitution, altered payout commitment, cross-cluster replay, quote replay, wrong source and destination token accounts, unauthorized settlement/refund, premature timeout refund rejection, failure-attestation refund, interrupted N-way claims, exact payout amounts, and duplicate funding/settlement/withdrawal. It creates only local test mints and removes its temporary ledger on exit.

Generated interface locations:

- Source program: `programs/realize-escrow/src/lib.rs`
- Generated canonical IDL: `idl/realize_escrow.json`
- Client-bundled IDL: `packages/realize-solana/src/idl.json`
- Versioned integration client: `packages/realize-solana/` (`@vox/realize-solana` 0.2.0)
- Deployment registry: `deployments/realize-settlement.json`

This test suite is not an audit. It does not prove safety, test Circle freeze/blacklist behavior, or validate production fee sponsorship, monitoring, quote-server operations, or fulfillment evidence. Independent security review and production rehearsal are still required.

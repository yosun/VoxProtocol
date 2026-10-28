# Payment and crypto integration audit

Audit date: October 27, 2026, America/Los_Angeles.

## Remediation status

Source fixes are prepared on `codex/payment-audit-20261027-release`, based on current `main` at `334d374e3add8f9a62552afb1739da52088b49a6`. The separate release worktree preserves the original checkout and its uncommitted application work. The changes are for one protected pull request to `main`; no production deployment or live financial transaction was performed.

| Finding | Source resolution |
| --- | --- |
| F1 Unpaid Mainnet NFT minting | Only verified, consented, completed Mainnet Realize outputs receive Mainnet entitlements. Processing rechecks payment, artifact, provenance, and entitlement bindings before signing or rebroadcasting; old ineligible records enter manual review with transaction evidence preserved. Testnet mock entitlements stay isolated. |
| F2 Treasury transaction collisions | Signed memos bind the record, batch, and attempt. Refund replacement requires the next durable attempt and a distinct signature; retries retain the original signed bytes. Actual serialized batch size is checked. |
| F3 Duplicate customer payments | Signed receipts and bytes commit to IndexedDB before broadcast. Per-source Web Locks coordinate tabs; atomic attempt and signature checks prevent stale cleanup. Recovery survives tab closure, migrates old session checkpoints, and preserves ambiguous sign-and-send outcomes for receipt verification. Signing honors account capabilities. Only finalized failure permits retry; the API independently releases a failed prior submission without replacing uncertain funds. Refunded orders cannot offer another payment. |
| F4 Historical source ownership | Payment and original-funding refund checks use transaction-time token ownership and ordered lifecycle evidence. Present account existence is irrelevant. Ambiguous execution history fails closed. |
| F5 Contract receiver compatibility | Both ERC-721 transfer overloads use typed receiver calls and ABI decoding. Seven Solidity tests cover acceptance, rejection, and rollback. Existing deployed collections are non-upgradeable and still require a separately planned contract deployment or migration to receive this fix. |
| F6 Expiry recovery | Preserved from current `main`, including durable submission signatures, transaction block-time checks, and review of late or ambiguous funds. |
| F7 Settlement destinations and liabilities | Preserved from current `main`: qualified destinations are normalized at the chain boundary and treasury-held allocations remain liabilities. |
| F8 Solana NFT construction | Preserved from current `main`: metadata is created before authority revocation using the corrected encoding. |

Final local verification passed:

- `npm test`: complete build and type checks; 268 tests passed. The eight emulator-dependent tests skipped by this command were exercised separately below.
- `VOX_E2E_PORT=5191 npm run test:e2e`: all 35 browser scenarios passed against mocked APIs and chain responses.
- `npm run test:firestore`: all eight local Firestore emulator tests passed, including competing refund replacements and preservation of the winning signed bytes.
- `npm run test:nft-contract`: all seven Solidity receiver tests passed. This check now runs in the existing required CI verification job using pinned Foundry and Solidity versions.
- `npm audit --omit=dev`: zero advisories. Current `main` already contains the dependency patches absent from the original checkout; no dependency version migration was needed in this batch.
- `git diff --check origin/main`: clean. Independent cross-reviews covered Mainnet NFT eligibility, treasury verification, and the durable payment journal. The receipt-retry and refund-state follow-ups also passed focused regression tests.

Recovery applies within the same browser profile and origin while its IndexedDB remains intact. Browser data deletion or eviction and separate devices remain outside browser coordination. Existing signed treasury records are intentionally not rewritten or automatically reissued. These offline checks do not establish a live customer payment, provider render, payout, or refund.

## Original audit result

The original audit found payment reliability and security defects under retries and partial failures. The most urgent findings were an unpaid path to sponsored Mainnet NFT minting and treasury transactions that did not uniquely identify their settlement or refund. The starting checkout also omitted several payment fixes already present in the production release. The remaining sections retain that audit snapshot and its original verification results.

This audit covers the current working tree, the public source associated with the production release, read-only Cloud Run and Secret Manager metadata, public Solana treasury balances, dependency advisories, and offline tests. No customer payment, payout, refund, provider render, production exploit, secret-value access, or deployment was performed. Existing application edits were preserved.

## Production snapshot

Production API revision `vox-api-00123-qin` and settlement revision `vox-realize-settlement-00009-leb` each receive 100% traffic. Both use image digest `sha256:2d34ae25bc2e3cf98487fc9d0e72a080b327743881e301257aecab2d338e2b61`. Their CI tag identifies [production run 40395647419](https://github.com/yosun/VoxProtocol/actions/runs/40395647419), whose source commit is `334d374e3add8f9a62552afb1739da52088b49a6`. Release-source findings below refer to that commit; they were not exercised against live payment endpoints.

| Setting | Observed value |
| --- | --- |
| Realize Mainnet payments | Enabled, official classic SPL USDC mint |
| Realize payment limits | 1 to 10,000 USDC |
| Generic legacy payment mode | `mock`, with legacy Solana cluster `devnet` |
| Production NFT minting | Enabled for `monad:mainnet` |
| Refund operator configuration | An operator identity is configured |
| Production API identity | `vox-api@voxprotocol.iam.gserviceaccount.com` |
| Settlement identity | `vox-realize-settlement@voxprotocol.iam.gserviceaccount.com` |
| Staging | `crueltycam`, Devnet enabled and Mainnet disabled |

The approved treasury owner and USDC associated token account match project policy. A finalized public RPC read returned **8,506,560 lamports (0.00850656 SOL)** and **0 atomic USDC**. The USDC account exists and reports the expected mint and owner. This balance snapshot does not establish treasury solvency against a complete liability ledger. Runtime bindings and secret inventories were inspected by name; effective IAM permissions were not exhaustively audited.

## Findings affecting production release source

### F1 High severity Unpaid legacy requests can trigger sponsored Mainnet NFT minting

The legacy realization endpoint accepts an arbitrary payment reference when the generic payment mode is `mock`. It then provisions NFT entitlements for the mock provider's delivered result without requiring a verified payment or excluding mock media. A registered collector can claim the resulting Monad entitlement, and that claim immediately invokes the server's mint adapter. Production currently combines the relevant settings: legacy mock payments and Monad Mainnet NFT minting.

An offline API reproduction reused one quote with two unpaid references. It created two entitlements and reached the mocked Mainnet adapter's prepare and submit operations twice. The corresponding legacy provisioning and claim paths remain in release source. This can consume the dedicated minter's gas balance and mint tokens referencing synthetic media; it is not a demonstrated drain of the USDC settlement treasury.

References: [legacy payment handling](../apps/api/src/app.ts#L2995), [NFT provisioning](../apps/api/src/app.ts#L3079), [immediate Monad claim](../apps/api/src/app.ts#L2724), and [release provisioning source](https://github.com/yosun/VoxProtocol/blob/334d374e3add8f9a62552afb1739da52088b49a6/apps/api/src/app.ts#L3331).

**Fix:** require eligible, verified economic records and real verified media before creating any Mainnet entitlement. Enforce that restriction again before signing a mint. Keep mock entitlements isolated from production adapters and apply a bounded sponsored-mint policy.

### F2 High severity Independent settlements and refunds can share one transaction

The treasury transaction includes its payer, blockhash, account creations, and token transfers, but neither `recordId` nor `batchIndex` enters the signed message. Two independent records with the same recipient amounts and blockhash therefore produce identical signed bytes and the same signature. Blockchain deduplication executes that transaction once, while both ledger records can report successful payment.

This was reproduced against both working-tree code and the downloaded production release implementation: two one-USDC settlement records reported settled with **one unique signed transaction**. Refunds use the same batch builder, so equal refunds to the same payer have the same risk.

References: [transaction construction](../apps/settlement/src/solana-chain.ts#L113), [batch processing](../apps/settlement/src/engine.ts#L184), and [release transaction construction](https://github.com/yosun/VoxProtocol/blob/334d374e3add8f9a62552afb1739da52088b49a6/apps/settlement/src/solana-chain.ts#L127).

**Fix:** include the durable record, batch, and attempt identity in the transaction, for example through a memo. Preserve identical bytes for retries of the same attempt and enforce signature uniqueness across independent economic records.

### F3 High severity Losing a broadcast response can permit a second customer payment

In the wallet `signTransaction` fallback, the client sends signed bytes before recording their signature. If the RPC accepts the transaction but the response is lost, `sendRawTransaction` throws before `onSubmitted` runs. Checkout then retains no pending signature and clears its submitted flag, allowing another payment attempt. The server cannot reconcile an attempt whose signature never reached it.

This finding follows the client control flow; a real RPC response-loss scenario was not induced. The production release contains the same payment-client implementation.

References: [broadcast before signature persistence](../apps/web/src/solana-payment.ts#L226) and [checkout submission recovery](../apps/web/src/RealizeCheckout.tsx#L508).

**Fix:** derive and persist the signature and signed bytes before broadcasting, then reconcile or rebroadcast those bytes. For wallets that only expose sign-and-send, retain an uncertain-payment state and recover by the unique payment reference before allowing another transfer.

### F4 Medium severity Payment and refund verification depends on present token account state

The USDC verifier checks ownership by fetching the source token account's current state. A customer can make a valid finalized payment and subsequently close or change that account. The same historical transfer then fails verification, including the original-payment checks required for a refund.

Offline reproductions against both working-tree and release code supplied a finalized matching transfer and its historical owner metadata, then returned a closed source account. Both verifiers rejected the payment solely because the account no longer existed.

References: [current account lookup](../packages/solana/src/index.ts#L262), [payment match](../packages/solana/src/index.ts#L312), and [release verifier](https://github.com/yosun/VoxProtocol/blob/334d374e3add8f9a62552afb1739da52088b49a6/packages/solana/src/index.ts#L262). Solana exposes transaction-time token balance metadata in its [RPC structures](https://solana.com/docs/rpc/json-structures).

**Fix:** verify transaction-time ownership and authority from historical transaction evidence, including account lifecycle instructions where necessary. Do not make a past payment's validity depend on the account still existing today.

### F5 Medium severity The NFT contract rejects standard contract recipients

Both `safeTransferFrom` overloads require the receiver call's return data to contain exactly four bytes. A standard Solidity `onERC721Received` returns an ABI-encoded `bytes4`, which occupies 32 bytes. Correct receiver contracts therefore cause transfers to revert.

The contract source is identical in this checkout and the production release. This is a source and ABI finding; deployed contract bytecode was not independently matched or exercised.

References: [first receiver check](../contracts/VoxMediaNFT.sol#L110), [second receiver check](../contracts/VoxMediaNFT.sol#L118), the [ERC-721 receiver specification](https://eips.ethereum.org/EIPS/eip-721), and [Solidity ABI encoding](https://docs.soliditylang.org/en/latest/abi-spec.html).

**Fix:** use a typed receiver call or decode the ABI return value and compare its selector. Cover both overloads with a real receiver contract test. Check the deployed instance before choosing a migration strategy because the collection source is non-upgradeable.

## Regressions in the current checkout

These findings must not be attributed to the current production release: release source already contains the relevant fixes.

### F6 High severity Quote expiry prevents recognition of transferred funds

The local funding endpoint expires the order before asking the payment verifier about its signature. Reconciliation also expires awaiting-payment orders without checking a submitted Mainnet transfer. A timely on-chain payment reported after expiry can become a terminal `EXPIRED` order with no recorded funding signature and no normal refund path.

An offline API reproduction confirmed that the verifier was never called and the signature was not recorded. Production release source instead persists the submitted signature, checks transaction block time, and captures late or ambiguous funds for review.

References: [local expiry rejection](../apps/api/src/app.ts#L2593), [local reconciliation](../apps/api/src/app.ts#L1153), and [release recovery](https://github.com/yosun/VoxProtocol/blob/334d374e3add8f9a62552afb1739da52088b49a6/apps/api/src/app.ts#L846).

**Fix:** preserve the deployed funding recovery implementation when integrating this branch.

### F7 High severity The local settlement service rejects destinations emitted by its quote builder

Quotes use network-qualified destinations such as `solana:mainnet-beta:<wallet>`, and settlement instruction creation preserves them. The local settlement processor instead validates the entire string as a bare Solana public key. Normal generated instructions therefore fail with `invalid_destination` before payout processing.

Production release source correctly validates the network prefix and normalizes addresses inside the chain adapter. It also keeps treasury allocations as liabilities; local code still has the older shortcut that calls a treasury-only batch finalized without an external transfer.

References: [quote destination format](../apps/api/src/realize-engine.ts#L452), [instruction creation](../apps/api/src/realize-engine.ts#L522), [incompatible validation](../apps/settlement/src/engine.ts#L81), and [treasury shortcut](../apps/settlement/src/solana-chain.ts#L102).

**Fix:** restore the deployed destination normalization and held-liability semantics together. Test the real quote builder against the real settlement processor; hand-written bare-address fixtures miss this mismatch.

### F8 Medium severity Local Solana NFT metadata creation follows mint authority revocation

The local transaction revokes mint authority before creating Token Metadata. Metaplex validates the current mint authority during metadata creation and rejects a revoked authority. Production release source already creates metadata before revocation and includes a corrected metadata encoding byte.

References: [local instruction order](../apps/api/src/nft.ts#L490), [Metaplex authority validation](https://github.com/metaplex-foundation/mpl-token-metadata/blob/main/programs/token-metadata/program/src/assertions/misc.rs#L42), and [release instruction builder](https://github.com/yosun/VoxProtocol/blob/334d374e3add8f9a62552afb1739da52088b49a6/apps/api/src/nft.ts#L462).

**Fix:** preserve the deployed instruction builder and verify metadata encoding through a program-level test before enabling Solana minting from this branch. Production currently enables Monad rather than Solana NFT minting.

## Original verification and dependency results

| Check | Result |
| --- | --- |
| `npm test` | Stopped during API compilation at [character-account.ts](../apps/api/src/character-account.ts#L154): `string \| undefined` assigned to `string` |
| Focused existing payment, settlement, provider, Solana client, and NFT suites | 49 passed; 8 NFT tests failed because fixtures omit required publication consent |
| Temporary offline audit reproductions | 6 passed, demonstrating four defect scenarios; collision and closed-account scenarios also ran against release source |
| Existing Rust escrow adversarial/property tests | 4 passed with `cargo test -p realize-escrow --test adversarial --locked --offline` |
| Production dependency advisory query | 20 affected entries: 5 high and 15 moderate; no critical entries reported |

The high dependency entries include Fastify, Zod, and the `bigint-buffer` dependency chain through SPL Token. These are advisory results, not five independently reproduced payment exploits. The [bigint-buffer advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) and [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) warrant reachability review. The suggested SPL Token downgrade is a breaking change and should not be applied mechanically. Restore consent-bearing test fixtures rather than weakening the consent requirement.

Signed quote validation, integer pricing, Mainnet genesis and official-mint binding, payment-signature reservations, webhook authentication, durable settlement bytes, and operator approval checks are present. Passing injected-adapter tests does not establish live payment, generation, payout, or refund success. Firestore concurrency, receiver-contract execution, complete liability reconciliation, and the full validator/browser-wallet flow remain outside the executed checks.

## Remediation order

1. Block mock and unpaid records from production NFT signing.
2. Make independent treasury transfers unique and persist customer transaction identity before broadcast.
3. Validate historical payments from transaction-time evidence and repair receiver ABI handling.
4. Integrate onto current production source so expiry recovery, qualified destinations, held liabilities, and Solana mint fixes are retained.
5. Repair the build and fixtures, triage dependency advisories, and run the combined required release checks before any protected release.

The original audit turn added only this report. The remediation branch described above contains the subsequent source fixes and regression tests; production and live financial operations remain unchanged.

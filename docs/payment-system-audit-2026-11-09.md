# Payment system audit and wallet connection repair

Audit date: November 9, 2026, America/Los_Angeles. Production observations were taken on November 10 at approximately 06:30–06:40 UTC.

## Result

The grey checkout button is a frontend defect. It says “Connect a wallet to continue” but invokes quote acceptance, which requires an already-connected wallet and disables the button without one. When no compatible wallet is discovered, checkout offers no connection action at that point. After acceptance, it also removes the inline wallet connection controls, leaving a disconnected payer without an inline recovery path.

The repair in this release makes **Connect wallet** open the wallet chooser or installation guidance, preserves separate quote and terms acceptance, and keeps connection and wallet management available for accepted unpaid orders. The chooser now supports disconnecting, initial focus, contained keyboard navigation, Escape, and focus restoration. Official Phantom and Solflare installation links and mobile wallet-browser guidance explain the no-wallet state. Deployment is tracked by the protected release workflow; the observations below describe the audited production baseline before that release.

The accessible production browser reported **No compatible wallet detected**. This establishes that browser's discovery result; it does not establish which wallet or browser the owner used. Existing production payment protections passed the automated checks described below. The production ledger still contains no verified Mainnet Realize payment, so a successful live paid lifecycle remains unverified.

## Source and deployed snapshot

The review baseline is protected `main` at `5856536dedacdfe2f05c5bf1c12fb4d43028ea3e`, released by the successful [production workflow](https://github.com/yosun/VoxProtocol/actions/runs/42591262257). The repair is isolated on `codex/payment-audit-20261109`.

The subsequent deployment preflight confirmed the same API/settlement revisions and image. Reconciliation had expired the remaining quote: the 25 commissions were then 23 expired and two draft, still with no submitted or verified funding receipt and no settlement records. Database protection and backup-schedule findings were unchanged. A fresh public smoke check and read-only Monad contract verification passed. The wallet-only code diff and this report form the release; the remaining operational findings are follow-up work.

| Component | Observation |
| --- | --- |
| Production API | `voxprotocol/us-central1`, `vox-api-00137-tav`, 100% traffic |
| Mainnet settlement | `vox-realize-settlement-00023-vup`, 100% traffic |
| Shared API, settlement and reconciliation image | `sha256:a0bfdcf42681fbb004cf0356ba24c3b34b6b0ba263783dd44703f3f8c473be19` |
| Realize payment rail | Backend-managed classic SPL USDC on Solana Mainnet; enabled |
| Generic legacy payment rail | `mock`, separate from Mainnet Realize |
| Bob and Luna payout configurations | Versions 6 and 1; official Mainnet USDC and approved treasury; 1–10,000 USDC; 25/70/5 allocation |
| Settlement serialization | One maximum instance, concurrency one |
| Reconciliation | Enabled every five minutes; four sampled completed executions succeeded, with the newest execution still pending when listed |
| Staging | `crueltycam/us-east1`, `vox-realize-staging-00023-9l2`, isolated `vox-realize-staging` database; Devnet enabled, Mainnet disabled |
| Monad NFT collection | Active receiver-fix contract `0xd5b3c636292b47fb6edbeea064323c0c0a32f494`; read-only verification passed against both configured public RPCs |

The owner's original development checkout is 21 commits behind this production baseline and contains extensive uncommitted application work. Its `npm test` stops at a pre-existing TypeScript error, TS2322: a possibly undefined string is assigned to a required string. It also lacks payment recovery work already deployed on `main`. Its test result and source must not be substituted for current production, or released as a complete application snapshot without integration. This audit preserved those edits.

## Findings and remaining work

### F1 Medium Checkout wallet connection is a dead end

**Status: corrected by this release; pre-release production was affected.**

The primary button's disabled predicate includes the connected-wallet requirement for quote acceptance. Changing its label does not turn it into a connection action. The absence of wallet-specific buttons when discovery is empty makes this particularly confusing. Accepted orders also lose the connection panel even though their payer can disconnect or change accounts.

The repair adds a separate connection action, keeps quote acceptance behind its existing checks, and restores payer reconnection and wallet switching within checkout. Three new browser regressions verify no-wallet setup, connection before terms acceptance without accepting or funding the quote, and disconnection/reconnection after acceptance. Existing tests continue to enforce payer, network, rights, quote, expiry and payment-verification checks.

References: [checkout](../apps/web/src/RealizeCheckout.tsx), [wallet chooser](../apps/web/src/WalletConnectDialog.tsx), [browser regressions](../tests/e2e/realize-checkout.spec.ts).

For the current deployed page, use a browser with an enabled compatible Solana wallet extension, or open VOX.gold inside a supported mobile wallet browser. An embedded browser with no injected wallet cannot connect an extension installed in another browser.

### F2 High operational risk The financial database has no configured recovery protections

**Status: open; confirmed again in production.**

The default production Firestore database reports `DELETE_PROTECTION_DISABLED` and `POINT_IN_TIME_RECOVERY_DISABLED`. The backup schedule API returned zero schedules, and the `nam5` backup inventory returned zero backups. The recent earliest-version time does not supply a retained financial recovery history.

Commission records, funding reservations, refund approvals, settlement attempts, signed transaction recovery bytes and liabilities depend on durable database records. Loss of those records can prevent safe reconciliation or make duplicate-payment prevention difficult to reconstruct, even when chain transactions remain visible.

Enable deletion protection and an approved retention policy, configure retained backups/PITR, and demonstrate an isolated restore and financial reconciliation. No cloud protection or billing setting was changed by this audit.

### F3 Medium Guest order access can be lost with browser storage

**Status: open.**

Guest checkout automatically creates a non-exportable Ed25519 commissioner key in origin-scoped IndexedDB. The Solana payer wallet is a separate identity. The financial journal and Web Locks protect retries across tabs within the same browser profile while storage remains intact; they do not restore a deleted commissioner key or move it to another device. An account backup created later does not recover an older separate guest key.

Provide a recoverable-account or explicit guest-recovery choice before payment, and explain the current limitation. A future wallet recovery route must prove ownership of the original order rather than reassigning it from a public wallet address alone.

References: [checkout identity](../apps/web/src/realize-identity.ts), [financial checkpoints](../apps/web/src/financial-checkpoints.ts), [account recovery](../apps/web/src/human-account.ts).

### F4 Acceptance gap Production has no recorded completed paid lifecycle

**Status: open verification requirement.**

A bounded, direct Firestore inventory found 25 Realize commissions: 22 expired, one quoted and two draft. Payment states were 18 `not_started` and seven `failed`. There were zero submitted funding signatures, zero verified funding signatures and zero settlement records or payment-intent locks. All 25 reported settlement `not_started`. The separate legacy collection contains one captured record; its generic route remains mock and does not establish Mainnet Realize funding.

Health, capabilities, signed quote logic, mocked checkout tests and the historical Devnet escrow rehearsal do not demonstrate a real Mainnet customer payment, Populi generation, external payout or refund. Use the existing [acceptance verifier](../scripts/verify-realize-mainnet.ts) when an explicitly authorized real commission exists. A paid rehearsal requires its own exact payer, amount, cluster and fee authorization; no such transaction was initiated here.

### F5 Medium Production dependencies retain moderate advisories

**Status: open; no high or critical advisory reported.**

`npm audit --omit=dev` reports six moderate affected package entries: `gaxios`, `gcp-metadata`, `google-gax`, `glob`, `minimatch` and `rimraf`. They propagate two advisory families: [glob cancellation and continued traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249). Fixes are reported available. No payment exploit through those dependency paths was demonstrated.

Patch the affected dependency paths in a reviewed update and rerun the required checks. This wallet repair does not change dependencies.

### F6 Medium operational risk No native monitoring is configured for payment failures

**Status: open within the inspected GCP project.**

Cloud Monitoring returned zero alert policies and zero uptime-check configurations. Scheduled reconciliation is running, but scheduled execution alone does not alert an operator to a growing manual-review queue, a stuck refund, provider failures, database recovery failures or treasury fee depletion. A bounded API error-log query returned zero entries for November 3 onward; that is not an alerting mechanism or evidence that all customer outcomes succeeded. Equivalent monitoring outside this project was not established.

Configure alerts for API/settlement availability, reconciliation failures, aged captured/manual-review/refund orders, database protection failures and low treasury SOL. Verify that each alert reaches an accountable operator.

## Treasury and custody observations

A finalized public Solana read at slot `467621474` returned **8,506,560 lamports (0.00850656 SOL)** and **zero atomic USDC**. The classic USDC account is initialized and matches the approved mint and owner:

- Owner: `5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA`.
- Token account: `C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26`.
- Mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

The balance is 3,506,560 lamports above the settlement adapter's default 5,000,000-lamport reserve. Fees and recipient account rent still require live checks before any authorized operation. This snapshot is not an independent solvency certification.

Both active creator configurations direct all configured provider, owner and platform allocations to the approved treasury. The reviewed settlement implementation treats those allocations as held liabilities, with no treasury self-transfer presented as an external payout. External recipients remain unconfigured; no recipient was invented or changed.

The treasury secret's inspected accessor binding grants the settlement service identity access. The API has no project-wide Secret Manager accessor role in the inspected project policy. API and settlement identities both have the existing datastore role; project administrators, deployment/impersonation privileges and inheritance remain part of the custody boundary. Organization/folder inheritance and independent signer backup recovery were not exhaustively verified. Secret values and private keys were not retrieved.

Mainnet remains a custodial backend-managed rail. Settlement authentication is privileged authority; it is not a public trustless escrow guarantee. The custom escrow program remains a separate Devnet path.

## Controls reviewed

| Area | Source and automated evidence |
| --- | --- |
| Quote integrity and economics | Issuer signature, canonical quote hash, pinned configuration and rights, integer atomic arithmetic, live provider cost binding, 1–10,000 USDC limits and 25/70/5 allocation |
| Wallet authorization | Exact accepted quote/funding binding, payer and chain checks, account signing capabilities, balance/fee checks, simulation and expiry checks before browser-controlled submission |
| Duplicate payment recovery | Signed signature/bytes committed before broadcast; ambiguous sign-and-send markers; atomic IndexedDB journal; cross-tab Web Locks; identical-byte retries; finalized failure required to release an uncertain attempt |
| Server funding verification | Mainnet genesis, official classic mint, exact TransferChecked amount/decimals/destination/memo, payer signature and historical source ownership, finality, transaction-time expiry and atomic signature reuse reservation |
| Provider fulfillment | Captured payment before generation, persisted idempotent request, pinned provider quote and funding authorization, signed callback checks, artifact/provenance verification and ambiguous outcome handling |
| Settlement | Record/batch/attempt memo identity, stored signed bytes before broadcast, durable intent reservation, terminal-state guards, exact retry identity, explicit treasury-held liabilities and serialized runtime |
| Refunds | Internal authorization plus allowlisted human signature over exact approval, original-funding revalidation, no conflicting payouts, deterministic refund binding, finalized evidence and bounded failed-attempt replacement |
| NFT sponsorship | Verified completed paid outputs and separate publication consent required for Mainnet eligibility; contract receiver regression tests; active Monad bytecode/authority/deployment receipt checked read-only |
| Environment isolation | Production Mainnet and staging Devnet flags, projects and databases inspected separately; current protected production workflow succeeded |

Relevant implementations: [payment client](../apps/web/src/solana-payment.ts), [Mainnet rail](../apps/api/src/realize-payment.ts), [SPL verifier](../packages/solana/src/index.ts), [commission routes and resolution](../apps/api/src/app.ts), [Firestore invariants](../apps/api/src/firestore-store.ts), [settlement processor](../apps/settlement/src/engine.ts), [signed treasury transactions](../apps/settlement/src/solana-chain.ts), [settlement ledger](../apps/settlement/src/ledger.ts), and [NFT eligibility](../apps/api/src/nft.ts).

## Verification

- Three new wallet browser regressions passed.
- `npm test`: complete build, application and payment-operations typechecks; **440 passed**. Its nine skipped emulator-dependent tests were exercised separately below.
- Full browser suite: **48 passed**, using mocked APIs, wallets, RPC, provider outputs and minting.
- Firestore emulator: **9 passed**, including competing transaction replacements and immutable accepted payment evidence.
- Solidity receiver suite: **7 passed**.
- `NO_DNA=1 cargo test -p realize-escrow --test adversarial --locked --offline`: **4 passed**, covering deployment-cluster selection, quote-domain separation, allocation overflow and conservation.
- Live Monad verification: passed on both configured RPCs without submitting transactions.
- Public API and settlement health, Bob/Luna capabilities and Bob's short-form input schema returned HTTP 200.
- Production dependency audit: **6 moderate, 0 high, 0 critical** entries.
- `git diff --check`: clean.

## Scope and release boundary

This is an engineering audit of the current source, tests and the stated runtime observations. It is not an independent penetration assessment or proof that every defect has been found. Browser coverage here is Chromium with test wallets; the owner's actual wallet/browser combination and live mobile-extension behavior remain unverified.

Production financial inspection used health/capability endpoints, direct Firestore reads and public RPC reads. The authenticated per-commission status GET can trigger financial reconciliation and was deliberately excluded from live inspection. Browser mutation requests were blocked, including automatic private-human registration. No quote reservation, customer acceptance, wallet signature, payment, paid render, payout, refund or mint was initiated. The owner subsequently authorized the protected application release containing this wallet repair and report.

Release the scoped wallet fix through the protected PR workflow. Integrate against current `main`; preserve unrelated application work and existing payment protections. Prioritize database recovery, customer identity recovery, monitoring and an explicitly bounded live acceptance rehearsal as separate follow-up work.

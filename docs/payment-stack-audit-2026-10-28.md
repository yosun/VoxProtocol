# Payment stack audit and refund rehearsal

Audit date: October 28, 2026, America/Los_Angeles. Cloud observations after midnight UTC are dated October 29 UTC.

## Result and scope

The review found additional payment, refund, and deployment defects after the [October 27 remediation](payment-crypto-audit-2026-10-27.md). This release candidate fixes the verified source defects and includes regressions that reproduced the affected behavior. It does not establish a completed Mainnet customer payment or refund, independent key recovery, or replacement of an existing on-chain NFT contract.

Scope covers browser payment authorization and recovery; signed quotes and economics; finalized classic SPL USDC verification; commission and provider resolution; operator refund approval; settlement transaction construction, persistence and retries; Memory/Firestore invariants; deployment entry points; and read-only production/staging configuration. This is an engineering security review, not an independent third-party audit or a guarantee that every defect has been found.

The baseline is protected `main` at `d0fffade53ac0be1835d85895033bffc78fa18fb`. The existing development checkout and its uncommitted application work were preserved. Only the following isolated contributions belong to this batch:

| Contribution | Owned area | Included work |
| --- | --- | --- |
| Wallet review | Browser payment and checkout modules | Bind direct funding to the verified quote; stop new submission after expiry; release only an expired marker proven to precede wallet invocation. |
| API review | Commission/refund API and store guards | Bind approval and response evidence; preserve accepted payment/receipt fields; retain failed payout evidence after delivery. |
| Settlement review | Settlement ledger/adapter and Solana verifier | Monotonic terminal states, safe failed-attempt reconciliation, complete signature evidence, and validation before broadcast. |
| Coordinator review | Preflight, protected release, operational verification | Verify actual staging revisions and scoped client; remove callable obsolete production tags; retain rollback revisions. |

Existing branches and other chats' changes are not imported into this batch.

## Verified findings and fixes

| Finding | Trigger and effect before the fix | Corrected behavior |
| --- | --- | --- |
| Direct funding did not match the signed quote | A signed 1-USDC quote paired with a 0.5-USDC funding response proceeded through the mocked browser payment path. | Before signing or recovery, bind amount, network, official mint, commission, quote, accepted hash, expiry, custody mode and deterministic memo to the verified quote. The configured destination owner/ATA still receives on-chain validation. |
| Quote expired during asynchronous approval | Preparation, wallet approval or durable storage could outlast the quote and the browser still newly broadcast it. | Recheck immediately before the last browser-controlled submission boundary. Preserve signed bytes and genuinely uncertain wallet attempts; clear only a marker proven to precede wallet invocation. Server transaction-time verification remains authoritative. |
| Incorrect refund response finalized a commission | A response for another refund, or a terminal response without valid transaction-signature evidence, could mark an order refunded. | Require the deterministic refund ID and canonical Base58 evidence of exactly 64 decoded signature bytes. Rebind the persisted operator approval before execution. |
| Contradictory settlement resolution permitted approval | A response claiming no record while reporting paid funds could pass refund preflight. | Require internally consistent empty/no-payout resolution, or the exact deterministic failed-settlement/refund record. |
| Recovery could change accepted financial evidence | Store updates could rewrite the accepted payer, funding authorization, intent or verified receipt independently of the frozen quote. | Apply shared immutable-evidence checks inside MemoryStore CAS and Firestore transactions; permit status progress without changing accepted financial bindings. |
| Delayed failure raced with a successful replacement | An old failed attempt could throw a binding error after replacement or downgrade the record from refunded. | Recognize only the exact retained failed attempt as stale; keep refunded terminal and reject contradictory success claims. |
| Corrupted persisted bytes reached the broadcast boundary | A mismatched stored signature/blockhash could be sent before its returned ID was checked. | Decode and verify the stored signed transaction, treasury fee payer, single signer, blockhash and signature before RPC access. Reject an RPC payment response for a different requested signature. |
| Unusable treasury passed readiness | A frozen or uninitialized classic token account passed owner/mint checks. | Require initialized, unfrozen treasury token state before preparing transfers. |
| Failed payout after delivery lost evidence | An attempted refund transition conflicted with the immutable fulfilled outcome, preventing failed payout status from persisting. | Keep delivered work `COMPLETED`/`fulfilled`; preserve the failed payout evidence for operator resolution. Delivery failure and payout failure do not have the same refund policy. |
| Old vulnerable revisions remained callable | The pre-hardening API revision `vox-api-00123-qin` returned HTTP 200 through its old CI tag despite zero normal traffic. Its old mock-payment/Mainnet-NFT settings were still present. | After candidate checks, promote the pinned image with obsolete tags cleared and verify the result. Remove the current candidate tag on failure. Keep previous revisions for deliberate rollback without alternate public tag URLs. |
| Staging preflight could report false isolation | The script printed local manifest flags and could fall back to another capabilities client, without validating the serving runtime. | Validate the staging project before credential access, inspect all traffic-bearing and tagged revisions, enforce Devnet/Mainnet-disabled/isolated-database settings, and require the exact scoped verifier client. Parse/access failures do not print secret contents. |

## Operational observations

At the initial read-only production check, the API routed all traffic to `vox-api-00129-xev` and settlement to `vox-realize-settlement-00015-woz`. They were deployed by the successful [production workflow for d0fffad](https://github.com/yosun/VoxProtocol/actions/runs/40780974365). These observations precede this candidate's release.

- API health, hosted JavaScript/CSS, Bob/Luna capabilities, and Bob's short-form input schema returned HTTP 200. Settlement `/health` reported Mainnet health. These are availability checks, not financial proof.
- The five-minute reconciliation schedule was enabled. The latest five observed job executions completed successfully, including `vox-realize-reconcile-r5qsb` at `2026-10-29T01:12:11Z`.
- Settlement retained the dedicated runtime identity, one maximum instance and concurrency one. Its treasury secret version 1 remained enabled. Runtime startup loads the keypair and checks that its public key matches the configured owner. Treasury/NFT private key values were not retrieved by this review.
- Finalized public RPC checks found 8,506,560 treasury lamports and zero USDC. The initialized classic token account matched the recorded owner and official Mainnet USDC mint. This is an asset snapshot, not a liability reconciliation.
- Production contained 24 commission records, no verified/captured Mainnet funding, no potentially refundable funded commission, and no settlement ledger record. The one legacy payment record was mock/offchain. There is no real production payment available to refund as part of this review.
- Bob payout version 6 and Luna version 1 matched the approved treasury and official Mainnet mint, with a 1-USDC minimum, 10,000-USDC maximum and 25% provider / 70% owner / 5% platform policy.
- The configured refund operator exists in the production human registry; its public registration signature is valid and its identity matches the allowlist. No operator private key was retrieved.
- Staging revision `vox-realize-staging-00023-9l2` was verified in `crueltycam/us-east1` with Devnet enabled, Mainnet disabled, and the isolated staging database. The existing scoped staging provider credential was used only in memory for capabilities/schema GET requests; it was not logged. No quote, render, wallet transaction or deployment was submitted by that preflight.
- The earlier staging refund's funding and refund signatures were independently rechecked on Devnet and both remained finalized without errors. [Historical proof](../deployments/realize-staging-refund-rehearsal-proof.json) records a 1-test-USDC refund and zero payer USDC delta. That escrow flow is separate from the Mainnet treasury adapter.

## Verification

The initial clean-main baseline passed build/typechecks and 268 tests, plus eight Firestore emulator tests and seven Solidity receiver tests. Production dependencies had zero reported advisories in `npm audit --omit=dev`.

The final audit candidate on that baseline passed:

- `npm test`: full build/typechecks and 339 tests. The nine emulator-dependent tests skipped by this command were run separately.
- `npm run test:firestore`: all nine Firestore emulator tests, including accepted receipt immutability and delayed refund failure races.
- `VOX_E2E_PORT=5199 npm run test:e2e`: all 43 browser scenarios against mocked APIs and chain responses, with source/build output stable during the run.
- `npm run test:nft-contract`: seven Solidity receiver tests.
- `NO_DNA=1 cargo test -p realize-escrow --test adversarial --locked --offline`: four Rust adversarial/property tests.
- `npm audit --omit=dev`: zero reported production dependency advisories.
- Read-only production smoke and the corrected live staging preflight: passed.
- `git diff --check`: clean.

Required CI now also starts the local Firestore emulator and runs its transaction suite. Agent-focused checks are supporting evidence; the complete protected CI result after integrating the current main branch is authoritative.

No offline/mock test establishes live customer payment, provider generation, Mainnet settlement or Mainnet refund. Test-only keypairs and fabricated receipt fixtures do not represent real financial evidence.

## Remaining custody and deployment boundaries

Secret presence and a healthy signer process are evidence of service access, not a tested independent backup or recovery procedure. Only one enabled version was observed for each managed signer secret. Project-level access analysis also includes the owner and service-account impersonation/deployment capabilities; a secret-level accessor list is not the complete custody boundary. Organization-level IAM visibility was unavailable. This review does not change IAM grants, secrets, treasury ownership, payout recipients or financial approval policy.

The API and settlement bearer credential remain trusted custody components. Refunds independently reverify original funding in the settlement service; the API enforces exact human approval and provider/quote policy. A compromised privileged service is outside the protection offered by public request authentication alone.

The configured SOL reserve is checked per batch, not globally reserved across concurrent instances. Preserve settlement serialization and fund enough fee/rent liquidity; check live rent and fees rather than assuming fixed account costs. A public RPC endpoint is currently configured; rate limits, provider unavailability and missing transaction history can force manual review. Never replace an expired transaction merely because an RPC cannot find it.

The deployed Monad collection at `0x87ef9e71625878a0babeee7864fa7d96ed4e3571` is non-upgradeable. Read-only `eth_getCode` on chain ID 143 returned 8,412 bytes. After removing compiler metadata, the runtime matched the pre-fix contract from `334d374`, and did not match the corrected 7,764-byte build. Thus the existing on-chain collection retains the earlier ERC-721 contract-receiver compatibility defect; an application deployment cannot fix it. A separate approved contract deployment/migration is required. No contract transaction was submitted.

## Bounded Mainnet refund rehearsal

The existing API supports a no-provider-render late-payment recovery path. It is suitable for a controlled operator rehearsal, not a workaround for customer checkout expiry checks. It requires a user-controlled payer and an explicit approved amount/fee ceiling before any funds move. Do not use a production synthetic failure hook or assume that a provider's `integration-test` capability has no cost.

1. Obtain the public payer address and agreed USDC/fee ceilings. Do not request a private key or recovery phrase. Use a dedicated controlled commission under a registered identity; obtain a fresh live quote and verify its signed amount, economics and exact funding authorization. A quote may exceed 1 USDC.
2. Accept the quote and rights while valid. Save the exact accepted quote and server authorization. Do not request provider generation.
3. For this explicitly approved expiry-recovery test, wait until finalized cluster time is at least 60 seconds beyond quote expiry. Prepare the authorized classic SPL transfer with a fresh blockhash and exact memo, and simulate without broadcasting. Record payer, destination, network, mint, atomic amount, estimated fee, account rent and maximum permitted spend for owner review. Browser checkout correctly refuses this intentionally expired submission; use only a dedicated reviewed rehearsal flow.
4. After exact funding authorization, the controlled wallet signs and sends once, preserving its transaction identity before broadcast. Verify finalized payment on Mainnet. Submit that same receipt to `/fund`; require `MANUAL_REVIEW` with `late_payment_after_quote_expiry`, captured funds, and no provider request or render. Stop if any binding or state differs.
5. Verify treasury liquidity, original payer token-account requirements, live rent and fee, zero prior payouts, and the exact operator refund preview. Obtain the existing signed operator approval for that commission, original funding signature, quote hash, payer, amount and reason. Approval invokes the refund path; do not call it as a dry run.
6. Require a finalized successful refund transaction transferring the exact USDC amount to the original payer. Independently check on-chain evidence, terminal `REFUNDED` state, immutable approval/audit records, zero provider jobs and zero external payout activity. Re-read the same outcome to verify it does not create a second transfer. Preserve public evidence only.

The missing input is a confirmed user-controlled public payer address and acceptable quote/fee limits. No Mainnet financial transaction is authorized by a normal protected code release. The existing [Mainnet policy](../AGENTS.md) and exact operator approval checks remain mandatory.

## Release record

The release branch is `codex/payment-stack-audit-20261028`. The accompanying pull request and protected workflow record integration and deployment status. This document records the pre-release observations and verification above; a code release is not evidence that a live refund has occurred. No Mainnet payment, payout, refund or paid provider rehearsal was performed during this audit.

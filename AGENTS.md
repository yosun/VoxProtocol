# Project memory

## Agent batch releases

- When the owner asks to handle multiple independent fixes together, split the
  work into bounded agent tasks when parallel work is useful. Give each task an
  isolated worktree on its own branch; do not have agents edit the same
  checkout.
- Keep each agent's changes scoped to its assigned fix. The coordinating agent
  integrates the finished changes onto one release branch, preserves unrelated
  user changes, resolves conflicts, and reviews the combined diff.
- Package a batch as one reviewable pull request to `main`. Do not merge each
  agent's work separately into `main`: the production workflow deploys on each
  default-branch push and releases the complete verified application snapshot.
- Let the required pull-request checks run on the combined result. An owner
  deployment request authorizes an agent to review and merge that release PR
  once the checks pass. Merge the batch once; never bypass branch protection.
- Production deployments run automatically after agent review and successful CI.
  Keep the `production-sensitive` environment for Workload Identity Federation
  and deployment variables; it no longer requires an owner deployment review.
  Never initiate a Mainnet payment, payout, or refund as part of release work.
- If independent agent tasks live in separate Codex chats or repositories and
  cannot be gathered into the current task's worktrees, ask the owner to select
  which completed branches belong in the batch rather than guessing.

## Current automatic deployment policy (2026-10-26)

This policy supersedes every older instruction requiring the owner to approve
production deployments or the `production-sensitive` environment. Do not ask the
owner for routine deployment approval again. A deployment request authorizes
normal agent review and merge of its release PR after required checks pass;
protected-branch rules and required checks remain mandatory.

- Every push to protected `main` runs the complete `automatic-production`
  profile: API, web/Hosting, settlement, reconciliation, anchor, additive indexes,
  and browser checks. Manual workflow-dispatch profiles remain available on
  `main`; local/manual deployment scripts cannot substitute for CI.
- Production releases use the `production-sensitive` environment without
  required human reviewers. The exact repository, protected `main` branch,
  production workflow, successful verification, and allowed push/dispatch event
  are required before cloud authentication. `VOX_PRODUCTION_VERIFIED=true`
  records successful CI; it is not payment or refund authorization.
- Production jobs share one queue with `cancel-in-progress: false`. Before cloud
  authentication, discard stale runs whose SHA no longer matches `origin/main`.
  The next full release covers targets from failed or skipped earlier runs.
- Keep the separate application and index provisioning identities and their
  existing least-privilege access. Do not change secrets, treasury ownership,
  payout recipients, or financial approval policies as part of deployment.
- Mainnet customer payments, payouts, and refunds still need their own explicit
  authorization and the existing exact operator approval checks. Automatic
  deployment does not authorize transactions or paid provider rehearsals.

Read `docs/realize-staging-status.md` before working on the Realize flow or asking
the owner about its staging credentials. Discover and verify existing GCP
resources and Secret Manager entries first; never print secret values.

Production VOX is in `voxprotocol`. Populi/CrueltyCam and its existing Realize
staging services and credentials are in `crueltycam`. Keep production and staging
resources, payments, and records isolated. Never infer that a passing mocked
browser test proves the live payment → generation → settlement flow has passed.

## Current approved Mainnet policy (2026-10-12)

- Mainnet checkout uses classic SPL USDC transfers handled by VOX's backend. It
  is not trustless escrow; the custom VOX program remains Devnet-only.
- Price each generation from Populi's current provider quote, with a hard floor
  of 1 USDC and a configurable ceiling of 10,000 USDC. Apply the approved
  25% provider / 70% character owner (Bob) / 5% VOX allocation. At that split,
  total price is the greater of 1 USDC or four times the provider quote, rounded
  up to an atomic USDC unit.
- Bob is VOX's first-party AI character. Use the published first-party rights
  policy; no separate creator-signed agreement or Bob-specific wallet is
  required. The customer still reviews and accepts the quote before generation.
- Keep the existing treasury identity below; never invent or silently replace
  treasury or payout addresses. Unknown external recipients must remain
  unconfigured. Allocations held in the treasury are ledger liabilities, not
  completed external payouts.
- Production Mainnet Realize is enabled on Cloud Run revision
  `vox-api-00064-dep` (100% traffic; checked 2026-10-12 23:16 UTC). The active
  Bob payout configuration is Firestore version 5, with a 1 USDC minimum and
  10,000 USDC maximum. The legacy
  `VOX_PAYMENT_MODE=mock` and `VOX_SOLANA_CLUSTER=devnet` settings remain for
  other payment routes; Realize selects its separate direct Mainnet SPL USDC
  rail from the quote's pinned network and official USDC mint.
- A $1 quote is possible only when Populi's live provider quote is at most
  $0.25; otherwise the total is four times the provider quote. Bob's production
  capabilities and input schema return HTTP 200. No real customer quote,
  payment, provider render, settlement, or refund has been submitted or verified
  by the $1 policy update. Never initiate a Mainnet payment, payout, or refund
  without explicit authorization.

## Verified production Realize setup (2026-10-12)

- Production VOX is Cloud Run `vox-api` in `voxprotocol/us-central1`. Revision
  `vox-api-00064-dep` has 100% traffic; `vox-api-00052-nih` remains available
  for rollback. The generic payment mode remains `mock`, but Mainnet Realize is
  separately enabled and uses the dedicated backend-managed SPL USDC rail.
- Production Bob configuration is version 5. It retains the first-party rights
  policy, existing recipients, official Mainnet USDC mint, and 25% provider /
  70% owner / 5% VOX allocation. Runtime and Firestore minimums are 1 USDC;
  the maximum remains 10,000 USDC. Health, Bob capabilities, and the short-form
  video input schema returned HTTP 200 after deployment. A live provider price,
  customer payment, generation, settlement, and refund have not been verified.
- Keep Populi and VOX credentials in their existing Secret Manager projects and
  never print or copy secret values. Do not change Secret Manager values,
  treasury ownership, or payout recipients as part of routine application
  work.
- The existing dedicated Mainnet treasury in `voxprotocol` has owner
  `5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA`; classic USDC associated token
  account `C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26`. Its keypair lives only
  in Secret Manager secret `vox-realize-mainnet-treasury-keypair`, accessible
  to `vox-realize-settlement@voxprotocol.iam.gserviceaccount.com`. The
  settlement API token is `vox-realize-settlement-token`; the VOX API and
  settlement service identities can access that token. Do not expose the
  treasury keypair or replace its owner. Verify current on-chain balances and
  any destination account requirements before any settlement operation.
- `vox-api` previously had project-wide Secret Manager access. It now has
  per-secret access only for its runtime/Realize secrets; the treasury signing
  key is not accessible to that identity. Keep this least-privilege arrangement
  when updating deployment scripts. Do not infer a successful live render,
  settlement, or refund from API health or mocked tests; follow
  `docs/realize-staging-status.md` for the remaining integration verification.
- At the 2026-10-12 23:16 UTC check, the Mainnet settlement service still sent
  100% traffic to revision `vox-realize-settlement-00001-25s`; candidate
  `00002-hax` had no traffic. The reconciliation job still used image tag
  `20261012081652`. The current API image includes the refund-resolution routes,
  but the updated settlement service still needs a protected release. The source
  snapshot is published in public repository `yosun/VoxProtocol`. Its `main`
  branch requires pull requests and passing production scope/test checks. The
  `production-sensitive` environment required owner approval at that historical
  check. That deployment-review requirement is superseded by the current
  automatic deployment policy above. The historical note is not a requirement
  to ask for deployment approval again.

## Realize frontend verification

- Current staging is the `vox-realize-staging` Cloud Run service in
  `crueltycam/us-east1`. On 2026-10-12 it was deployed as revision
  `vox-realize-staging-00020-rwp` from image
  `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-fail-closed-refund-v3`.
  Runtime flags are Devnet enabled and Mainnet disabled. Populi's canonical
  staging API/schema origin is `https://staging.populi.cam`; use this in the
  deployment manifest and active Firestore payout configuration because the
  provider advertises schema URIs on this hostname.
- The active Firestore payout configuration is version 2. Its only changes
  from version 1 were the Populi API origin and matching artifact host; the
  staged rights agreement, Devnet network, USDC mint, escrow destination, and
  payout allocations were preserved.
- The deployed live checkout opened from the source-post Realize button,
  loaded Bob's schema and staged rights, and produced an issuer-verified
  0.85-USDC Devnet quote in the browser (0.60 provider + 0.20 owner + 0.05
  platform). The customer rights checkbox was not accepted. The browser had no
  compatible Solana wallet, so no payment or render was submitted. The prior
  one-render rehearsal approval has already been used.
- Staging Secret Manager is in project `crueltycam`. Relevant secret names are
  `populi-realize-staging-realize-clients`,
  `populi-realize-staging-realize-webhook-secret`,
  `vox-realize-staging-instance-key`, `vox-realize-staging-internal-token`,
  `vox-realize-staging-populi-token`,
  `vox-realize-staging-devnet-quote-authority`,
  `vox-realize-staging-devnet-fulfillment-authority`, and
  `vox-realize-staging-devnet-fee-payer`. Read values only from Secret Manager;
  never print or copy secret values into project memory.
- `npm run test:e2e` uses a mocked Wallet Standard wallet, mocked Solana RPC,
  and mocked VOX API. It verifies the customer-facing checkout and result UI,
  including the inline artifact and Populi link, but it does not prove an actual
  wallet signature, Devnet funding transaction, provider render, or settlement.
- Keep Playwright's dedicated port and explicit feature flags. Reusing a Vite
  server with stale flags can make the Mainnet mock checkout appear enabled or
  disabled incorrectly.

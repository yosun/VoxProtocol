# Realize staging: verified operational memory

Verified 2026-10-12. This file contains public resource metadata only.
The current production state is summarized first; later dated sections retain
historical snapshots and may describe superseded deployment states.

## Current approved Mainnet policy (2026-10-12)

- Mainnet uses backend-managed transfers of standard Solana SPL USDC. It is not
  trustless escrow; the custom VOX escrow program stays on Devnet.
- Generate each quote from Populi's live provider price. The total is at least
  1 USDC and at most the configurable 10,000 USDC cap, with the approved
  provider/Bob/VOX allocation of 25/70/5. The total is the greater of 1 USDC or
  four times provider cost, rounded up to one atomic USDC unit; a $0.75 provider
  quote therefore becomes a $3.00 checkout price.
- Bob is a VOX first-party AI character. The VOX first-party policy needs no
  separate creator-signed rights agreement or Bob-specific wallet. Customers
  still review and accept the quote before generation.
- The existing GCP treasury is the only approved treasury identity. Do not
  invent recipient wallets. A share held in the treasury is a recorded
  allocation/liability until an authorized settlement pays its recipient.
- Production Mainnet Realize is enabled on `vox-api-00064-dep`, with 100%
  traffic, and Bob's active Firestore payout configuration is version 5. The
  API retains its legacy `VOX_PAYMENT_MODE=mock` for other payment routes;
  Mainnet Realize uses a separate direct classic SPL USDC path pinned to
  `solana:mainnet-beta`. No real customer payment was submitted.
- The live minimum is 1 USDC and the ceiling is 10,000 USDC. A quote reaches
  exactly $1 only when Populi's current provider price is at most $0.25; higher
  provider prices yield four times the provider price. The 25% provider / 70%
  Bob / 5% VOX allocation and existing rights and recipients were preserved.
- Full `npm test` passed on 2026-10-12: 80 tests passed and two Firestore
  integration tests were skipped because the external test database was not
  configured. Tests inject payment verification and settlement/provider
  adapters; they do not prove live Mainnet RPC, real refunds, or a production
  Populi render. `npm run test:e2e` also passed all eight browser checkout
  scenarios against mocked Mainnet RPC/API responses. Those tests and HTTP 200
  capability/schema checks do not prove a live customer quote, payment, video
  generation, settlement, or refund.

## Existing production and staging resources

- VOX production: project `voxprotocol`, region `us-central1`, service `vox-api`,
  public origin `https://vox.gold`. Revision `vox-api-00064-dep` has 100% API
  traffic. Bob's active payout configuration is version 5. Legacy non-Realize
  payments report `mode: mock`.
- Bob's stable creator ID:
  `vox:agent:A4KzQOc_iHZyTQOmSqqrmSlpjrpSMwigXmwzcXFCDiM`.
- Populi staging: project `crueltycam`, region `us-east1`, service
  `populi-realize-staging`, direct Cloud Run URL
  `https://populi-realize-staging-icin5yj4aa-ue.a.run.app`; the canonical
  authenticated API and schema origin advertised by its capabilities is
  `https://staging.populi.cam`.
- Provider worker: `populi-realize-worker-staging`, same project and region.
- Provider runtime service account:
  `populi-realize-stage@crueltycam.iam.gserviceaccount.com`.
- Staging media origin: `https://storage.googleapis.com/crueltycam-populi-realize-staging`.

## Credential discovery

These Secret Manager entries already exist in **`crueltycam`**, not `voxprotocol`:

- `populi-realize-staging-realize-clients`: JSON array of scoped service clients.
  Read and parse server-side; never print the token or put it in browser code.
  The synthetic client `vox-staging-mock` uses verifier ID
  `instance:vox-staging-mock`. The staging runtime client is
  `vox-realize-staging`, verifier ID `instance:vox-realize-staging`, with
  scopes `capabilities:read`, `provider-prices:create`, `fulfillments:create`,
  `fulfillments:read`, and `funding:assert`.
- `populi-realize-staging-realize-webhook-secret`: shared callback signing secret.
- `populi-realize-staging-admin-token`: staging administration only.
- `populi-realize-staging-database-url`: provider staging database only.
- VOX staging runtime secrets in the same `crueltycam` project are
  `vox-realize-staging-instance-key`, `vox-realize-staging-internal-token`,
  `vox-realize-staging-populi-token`,
  `vox-realize-staging-devnet-quote-authority`,
  `vox-realize-staging-devnet-fulfillment-authority`, and
  `vox-realize-staging-devnet-fee-payer`. Secret values must remain in Secret
  Manager and must never be printed or copied into project memory.

The staging deploy script adds the actual VOX staging origin to the callback
allowlists of the Populi staging API and worker services only. Production
callback settings remain separate.

## Verified provider behavior

Authenticated capabilities return HTTP 200 at the direct Cloud Run URL and
advertise input-schema URIs on `https://staging.populi.cam`. The schema route
returns HTTP 200 on that canonical origin and HTTP 404 on the direct Cloud Run
hostname; VOX must use the advertised canonical origin for both requests.
Capabilities advertise `video:short-form` and `video:special`, providers
`provider:video:example` and `provider:video:h3-reference`, and a 15-second limit.
They currently omit the optional rights agreement references.

The video schema accepts `concept` or `prompt` (3–2,000 characters), integer
`duration_seconds` (5–15), optional `style`, resolution `480P`, and up to four
reference image URLs. It rejects additional properties, including VOX's old
`generation_description`. The default image-to-video pipeline takes no reference
images; the reference pipeline requires them.

VOX owns its pinned rights agreement and final payout policy. The fixture's
special-video example is 0.75 USDC provider, 0.20 owner, 0.05 VOX; these are example
amounts, not proof that an approved payout policy is installed.

## Current acceptance boundary

Before this work there was no VOX staging service/project configuration. Four
existing browser tests passed against mocked API and Solana responses; none
demonstrated a real checkout reaching Populi and settling after a Devnet payment.
The separately deployed Devnet escrow and synthetic settlement/refund tests are
documented in `realize-devnet-operations.md`.

## Staging brought up on 2026-10-12

- VOX staging is deployed as `vox-realize-staging` in `crueltycam` / `us-east1`,
  origin `https://vox-realize-staging-icin5yj4aa-ue.a.run.app`.
- Runtime service account: `vox-realize-stage@crueltycam.iam.gserviceaccount.com`.
- Durable, isolated Firestore database: `vox-realize-staging`; all five composite
  indexes were verified `READY`.
- Private avatar bucket: `crueltycam-vox-realize-staging-avatars`.
- New Populi scoped client: `vox-realize-staging`; exact verifier ID
  `instance:vox-realize-staging`. Its token is stored in
  `vox-realize-staging-populi-token`. Existing synthetic client was preserved.
- Both Populi **staging** services now allow the VOX staging origin for callbacks.
- Staging-only instance key, internal token, and service authority secret names
  start with `vox-realize-staging-`. Each escrow authority is mounted in its own
  directory underneath `/run/secrets/vox-realize-devnet/`; Cloud Run cannot mount
  different secrets in the same directory.
- Creator fixture: Bob's existing public, signed registration, plus a new staged
  source post. No production posts, payments or database state were copied.
- Rights: `rights:bob-realize-staging-v1`, explicitly fictional integration-test
  terms; no commercial grant or real future revenue. Disposable owner/provider/
  platform identities are stored server-side in
  `vox-realize-staging-fixture-identities`.
- Test payout policy v1 uses the previously used disposable Devnet wallets:
  provider 0.75 + platform 0.05 USDC to
  `45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr`; owner 0.20 USDC to
  `4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL`.
- Real Populi reservation → signed, independently verified VOX quote passed:
  provider 750000, owner 200000, platform 50000, total 1000000 USDC atomic units.
  See `deployments/realize-staging-evidence.json` for the current evidence.
- Validation: workspace build/typecheck and 46 automated tests passed, with two
  Firestore-emulator tests skipped in the default suite. Six browser checkout
  tests passed. The live named Firestore database and quote persistence were
  verified separately across staging service revisions.
- Before any live payer transaction, run `npm run prepare:realize-staging-payment`.
  It renews an expired quote, accepts test-only terms, validates escrow bindings,
  and **simulates an unsigned transaction only**. It cannot sign or send funds.
- The actual combined escrow create/append/seal/fund transaction simulated
  successfully on Devnet: **50,469–54,969 compute units**, **977 bytes**, `err: null`.
  The observed 100k-style planning estimate is a budget, not measured usage or
  USDC. The tested transaction uses no priority unit price. Its RPC-reported network fee is 10,000 lamports (0.00001 Devnet SOL), with a conservative initial account-rent estimate of 18,465,800 lamports (0.0184658 Devnet SOL). Initial account rent
  is separate from its network fee; preparation records both. The owner approved
  one live rehearsal for 1.00 test USDC, a 0.03 Devnet SOL fees/rent ceiling, and
  one quoted $0.75 provider-cost Fal render. That rehearsal passed below.

## Live rehearsal passed on 2026-10-12

- Commission `vox:commission:1e4bc2843f397e1ede6da8a03d98b182847be54279231ecf44f4dc4e11ba9a7a`
  reached `SETTLED`; payment settled, generation completed, all three payout bits
  claimed, exact 1,000,000 atomic USDC paid, and vault balance zero.
- Funding transaction:
  `3nbbX41y1n2akPmHc5AKynZg4fEJyt1TKDdCNMqgsLwA5CHashoDXZVgZf3zvKdG8Dd2bTQpDPvtDZjMR6WLD3Ff`.
  VOX independently verified finalization before submitting the single provider job.
- Real six-second `video/mp4` artifact: 768,834 bytes. SHA-256
  `9615dde42f709f031ddd6c5862c3f70156baa9d57149176def4c861143f41185`.
  The immutable Populi-origin stream's bytes, length, and media type were verified
  independently, and the video was opened and inspected in the browser.
- Signed provenance independently verified against the staging issuer. Record:
  `vox:provenance:42c1844a9d3d034834744f2a9bff8350e2909080f87f7cc3b876a387b8fc0be0`.
- Payer balance delta was exactly -0.20 test USDC after its 1.00 deposit and 0.80
  payout; owner balance increased exactly 0.20 test USDC. Five finalized on-chain
  transactions cover funding, fulfillment attestation, and three recipient claims.
- Actual funding execution used 50,469 compute units. Total network fees across
  all five transactions were 35,000 lamports (0.000035 Devnet SOL); account rent
  was 18,323,560 lamports. Combined payer cost **0.01835856 Devnet SOL**, below
  the approved 0.03 limit.
- Durable proof: `deployments/realize-staging-rehearsal-proof.json`. Latest quote
  state remains in `deployments/realize-staging-evidence.json`; retain the durable
  proof when making future reservations. Private execution journal is ignored at
  `.vox-local/realize-staging-rehearsal.json`, mode 0600. Resuming that journal
  never submits a second payment or provider job; a completed run returns its proof.
- Staging revision `vox-realize-staging-00006-qvz` uses image
  `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-flow-v5`.
  Production was rechecked unchanged at `vox-api-00046-fqt` with Realize disabled.
- This proves the live staging payment → generation → provenance → settlement
  happy path. Browser wallet interaction has six automated tests but was not
  performed with a real injected browser wallet. A provider-failure/refund rehearsal
  was outside this one-render approval; earlier standalone Devnet escrow refund
  tests remain separate. Production commercial rights/payouts are not activated.

Reproducible commands:

1. `npm run preflight:realize-staging` (read-only discovery).
2. Build the same-origin web/API image with Devnet Realize enabled.
3. `npm run deploy:realize-staging -- --apply --image=<reviewed staging image>`.
4. `npm run bootstrap:realize-staging -- --apply` (staging records and quote only).
5. `npm run prepare:realize-staging-payment` (unsigned simulation, no funds).
6. After approval of the exact fixed bounds only,
   `npm run rehearse:realize-staging -- --execute-approved`. The approved one-job
   journal is already complete; this now returns the recorded proof without spending.

Defects found by staging and fixed: incorrect generation parameter name and
controls; missing optional provider rights references; encoded-path signature
mismatch; generation polling recovery and `Retry-After`; payment signature
durability during submission; checkout restoration races; invalid secret mounts;
millisecond quote timestamps crashing escrow deadline conversion; and API quotes
omitting the network prefix required on escrow payout destinations. The quote
builder now commits `solana:devnet:<wallet>` (or the equivalent network-qualified
destination) before signing. A regression test runs an API-built quote through
the escrow SDK, including real timestamp precision. Browser
tests now cover the provider schema and payment recovery, and actual API-handler
tests verify signed routes and polling behavior.

The live happy-path acceptance criteria above are satisfied. Do not infer
production readiness or live provider-failure/refund coverage from that result.
Any additional wallet transaction or paid provider rehearsal requires approval
of its concrete recipient, token, amount, fee payer, and Devnet cluster.

## Production readiness recheck on 2026-10-12

This readiness check captured the preimplementation production state. The
phased Mainnet path has since been implemented locally; it remains disabled
until its external integration rehearsals pass and production configuration is
installed.

- At the time of the check, API funding/refund routes only supported
  `devnetRealizeEscrowClient`. The current code now has a separate Mainnet direct
  SPL USDC path, while `infrastructure/gcp/deploy.sh` continues to prevent the
  Devnet escrow profile from being used in production.
- `deployments/realize-settlement.json` has no mainnet program ID or production
  authorities; its mainnet artifact is compiled but not deployed. Disposable
  Devnet keys and fixture recipients must never become production authorities
  or commercial payout policy.
- At the 2026-10-12 production recheck VOX capabilities returned HTTP 404,
  `creator_not_found`, "creator has no active Realize payout configuration".
  This records the observed production state then; the approved code path now
  supports Bob's first-party policy without a creator-signed agreement. A
  production payout configuration still has not been installed.
- At the initial production recheck, Populi was deployed in `crueltycam` as
  Cloud Run service `cruelty-web` (`https://populi.cam`, region `us-east1`), but
  provider routes were disabled and `cruelty-populi-realize-clients` contained
  an empty JSON array. Its callback origin already allowed `https://vox.gold`,
  and the enabled `cruelty-vox-realize-populi-webhook-secret` was already bound
  to Populi as `VOX_REALIZE_POPULI_WEBHOOK_SECRET`.
- Production VOX is project `voxprotocol`, service `vox-api` in `us-central1`.
  Its latest ready revision is `vox-api-00046-fqt`; it uses payment mode `mock`
  and has no Realize Mainnet environment. Its Secret Manager inventory contains
  `vox-instance-secret` and `vox-internal-token`. Do not confuse this with the
  provider-side secrets in `crueltycam`; the local gcloud default is also
  `crueltycam`, so production commands must pass `--project` explicitly.
- Before production activation, exercise an actual browser wallet and the
  provider-failure/refund recovery path. The completed staging API rehearsal
  proved its happy path, not these two additional cases.
- In the user's active staging browser on 2026-10-12, checkout visibly reports
  "No compatible wallet found" and disables quote acceptance/payment. The user's
  in-app browser currently has no Solana wallet connector, so a real browser-wallet
  signature needs the user to take over from a browser with an installed,
  connected Wallet Standard wallet.
- The provider API contract has no documented failure-injection control. Do not
  try to induce an error with a real Fal prompt: an accidental success would
  trigger another paid render. A real funded-failure/refund test needs a provider
  test hook that guarantees no render, or another explicitly bounded job/payment.
- Bob is the sole first-party creator/rightsholder; do not invent a co-owner or
  treat the commission as a copyright transfer. A signed multi-party revenue
  rights agreement applies only to the third-party rights mode. The approved
  first-party path uses VOX's published policy and still requires checkout
  acceptance from the customer.

### Production credential names

Production Secret Manager layout is split across projects. In `voxprotocol`,
`vox-instance-secret` signs VOX quotes/provenance and `vox-internal-token`
authenticates internal rights/payout configuration. Populi owns
`cruelty-populi-realize-clients` and the shared
`cruelty-vox-realize-populi-webhook-secret` in `crueltycam`; VOX's dedicated
service token and webhook mirror live in `voxprotocol`. Never store secret values
in this document or reuse staging client credentials.

## Production Populi integration follow-up on 2026-10-12

- Corrected the project map: `crueltycam` is the Populi provider project and the
  local gcloud default, while production VOX is `voxprotocol`. All GCP commands
  must name the intended project explicitly.
- Added the scoped `vox-realize-production` provider client to a new version of
  `cruelty-populi-realize-clients`, preserving the prior version. The client has
  `capabilities:read`, `provider-prices:create`, `fulfillments:create`,
  `fulfillments:read`, and `funding:assert` scopes, with verifier ID
  `voxprotocol.api`. The matching token is Secret Manager secret
  `vox-populi-api-token` in `voxprotocol`.
- Mirrored the existing shared callback signing key into the new
  `vox-realize-populi-webhook-secret` secret in `voxprotocol`; values were never
  printed. Granted only `vox-api@voxprotocol.iam.gserviceaccount.com` access to
  those two VOX secrets.
- `POPULI_REALIZE_ENABLED` was briefly enabled on the existing production Populi
  service. A subsequent Terraform apply created revision
  `cruelty-web-00100-xkt` and restored the flag to `false`, so the current
  production provider routes are disabled. The Terraform variable
  `populi_realize_enabled` defaults to false; future changes must be made in the
  CrueltyCam Terraform source and deployed through its reviewed release flow.
- While revision `00099` was live, the new token returned HTTP 200 for Bob's
  public capabilities and both advertised schemas. No provider price
  reservation, fulfillment, payment, or render was submitted. The current
  revision has no Bob rights-reference value configured.
- Production VOX remains on `vox-api-00046-fqt` with payment mode `mock` and
  returns 404 for Bob's Realize capabilities. The two VOX provider secrets are
  stored in Secret Manager but are not referenced by that deployed revision.

Those program, authority, and fee-payer requirements apply only to a future
custom Mainnet escrow deployment. They are not required by the phased Mainnet
SPL USDC payment path described below.

## Staging checkout recovery follow-up on 2026-10-12

The read-only provider preflight initially failed because Populi advertises its
schema as a same-origin URL with `?creator_id=...`; VOX rejected all schema query
strings. `HttpPopuliRealizeClient.getInputSchema` now permits only one matching
`creator_id`, requires the configured Populi origin and Realize schema path, and
forwards that query without allowing credentials or arbitrary URLs. The preflight
now passes, and the public VOX input-schema route returns Populi's current schema.

The active provider schema currently offers 480P. A checkout restored from an old
draft could display the first option while retaining an unsupported saved value in
React state. Populi returned HTTP 422 for the stale pricing attempt; the 768P
parameter is the likely cause based on the current schema and visible checkout.
Saved-draft recovery now waits for commission status and updates unsupported
settings only when there is no unexpired quote or pending payment/refund. A
browser regression test covers that transition.

Staging image `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-schema-restore-v7`
is live as revision `vox-realize-staging-00010-glb`. After refreshing the current
checkout, Populi accepted a new provider-price request and VOX issued a valid,
issuer-verified Devnet quote for the fixture: 0.75 USDC provider base + 0.20
owner fee + 0.05 platform fee = 1.00 USDC. No terms checkbox was accepted, and
no wallet payment or generation was submitted. The in-app browser still reports
no compatible Solana wallet.

Verification for this follow-up: `npm run preflight:realize-staging`, `npm run
typecheck`, 17 targeted API/client/escrow tests, and all 7 Realize checkout
browser tests pass. The previous single approved live render is still the only
funded rehearsal. Real wallet signing requires a user-controlled connected wallet
and handoff at the transaction step. The provider contract exposes no documented
failure-injection control, so a real provider-failure/refund test still needs a
guaranteed no-render staging hook or a separately bounded rehearsal approval.

## Phased Mainnet SPL payment implementation

Implementation added 2026-10-12. Nothing has been deployed and no production
secret has been changed; no Mainnet payment or provider render has been
submitted.

- The shared `RealizePaymentRail` contract now separates Devnet custom escrow
  funding from the Mainnet standard SPL USDC transfer path. The Mainnet path is
  explicitly backend-managed and is never described as trustless escrow.
- Mainnet payment intents bind the commission, signed quote hash, payer, amount,
  network, USDC mint, treasury token account, unique transaction memo, and quote
  expiry. VOX checks the Mainnet genesis hash, classic SPL token account owner and
  mint, finalized transaction status, payer signature/source ownership, exact
  `TransferChecked` amount and decimals, memo, and destination before fulfillment.
- Finalized transaction signatures are reserved atomically in Firestore across
  commissions, so a transaction cannot fund another commission. File and memory
  stores preserve the same reservation behavior. Checkout requires the customer
  to sign `rights_reviewed: true` and stores its acceptance time. Immediately
  before Populi fulfillment, VOX revalidates a signed active agreement in
  third-party mode or the pinned first-party policy for Bob.
- Provider, creator/owner, platform, and other payout allocations remain pinned
  in the signed quote and settlement instruction. The isolated Mainnet settlement
  service now uses standard SPL transfers, Firestore idempotency records, saved
  signed transactions, finalized-status checks, and original-payment verification
  before refunds. An unresolved transaction is held for manual reconciliation,
  never automatically replaced. Checkout refuses Mainnet acceptance unless the
  settlement adapter is configured. Mainnet per-payment amount, treasury token
  account, treasury owner, RPC URL, and official USDC mint are separate config.
- `infrastructure/gcp/deploy.sh` now has an explicit production-only Mainnet
  profile. It checks that required secrets already exist and does not create or
  update their values. With explicit Mainnet enablement, it builds a separate
  `vox-realize-settlement` Cloud Run service under its own service account and
  wires its URL into VOX. It requires production Populi credentials, treasury
  account/owner, and a positive per-payment limit. The wallet build targets
  Mainnet only for this separate production profile; staging stays on Devnet escrow.
- A dedicated treasury identity is now provisioned in GCP Secret Manager. Its
  owner is `5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA`; its Mainnet classic
  USDC associated account is `C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26`.
  The keypair is in `vox-realize-mainnet-treasury-keypair` and accessible only
  to `vox-realize-settlement@voxprotocol.iam.gserviceaccount.com`. The separate
  settlement auth token is in `vox-realize-settlement-token`. Mainnet RPC
  confirms the treasury has zero SOL and its USDC account has not been created.
  Current rent is 0.00148844 SOL for that token account and one transaction
  costs 0.000005 SOL. The first customer's payment transaction can create the
  treasury account and pays its one-time rent. Before settlement, the treasury
  still needs the service's 0.005 SOL reserve, transaction fees, and rent for
  any payout recipients whose USDC accounts do not yet exist.
- The settlement service and production-only reconciliation Cloud Run Job and
  Scheduler configuration are implemented locally but have not been deployed;
  no settlement URL or reconciliation schedule is live. The approved quote
  limits are 1–10,000 USDC, dynamic from provider price, with 25/70/5
  provider/owner/VOX allocation.
  Bob's first-party mode is approved and does not need a signed creator
  agreement or separate wallet. A production payout configuration and verified
  external recipient addresses are not installed. Populi provider routes and
  VOX Mainnet checkout remain disabled. Complete the live payment, settlement,
  refund/reconciliation, and provider integration rehearsals before deployment.
- Automated Mainnet tests use an injected chain verifier, settlement adapter, and
  provider. They cover signed API acceptance → verified payment → generation,
  payout sums, wrong-network/over-limit rejection, and transaction reuse rejection.
  They do not prove live Mainnet RPC, treasury settlement, real refunds, or a
  production provider run.

## Frontend checkout verification before rollout on 2026-10-12

- The live VOX staging checkout opened from the source-post Realize button and
  loaded Bob's schema and staged rights. Requesting a fresh quote through that
  page succeeded and displayed an issuer-verified 1.00 Devnet USDC quote
  (0.75 provider + 0.20 owner + 0.05 platform). The rights checkbox was not
  accepted, and no wallet payment or render was started in this browser session.
- The Codex in-app browser reports no compatible Solana wallet. The local
  Playwright wallet is a test double and must not be described as a real wallet
  signature or live payment rehearsal.
- The Playwright suite now starts its own Vite server on port 5181 with an
  explicit test-only Mainnet feature flag, so it cannot silently reuse a server
  built with different payment flags. All seven browser checkout tests pass.
  The end-to-end mock verifies quote review, wallet transaction construction,
  server-side payment verification gating, payment recovery, signed provenance,
  inline video rendering, and the Populi share link. The full workspace suite
  passes 63 tests; two Firestore integration tests remain skipped without the
  external emulator.
- The checkout copy now distinguishes Devnet escrow refunds from Mainnet
  treasury-managed settlement and refunds. This frontend copy/test change is
  included in the staging image described below. A live browser-wallet payment
  and render still requires a wallet-enabled browser and a new bounded rehearsal
  approval; the previous one-render approval has already been used.

## Current Devnet staging rollout on 2026-10-12

- Deployed VOX staging revision `vox-realize-staging-00012-6l5` from image
  `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-realize-journey-1518`.
  Its runtime has `VOX_REALIZE_DEVNET_ENABLED=true`,
  `VOX_REALIZE_MAINNET_ENABLED=false`, and `VOX_SOLANA_CLUSTER=devnet`.
- The authenticated Populi capabilities response advertises input schema URLs
  on `https://staging.populi.cam`, while its direct Cloud Run URL returns 404
  for the schema route. `deployments/realize-staging.json` now uses the
  advertised origin. The active Firestore payout configuration advanced to
  version 2 with only `populi_api_base_url` and the matching artifact host
  changed; the rights agreement, network, mint, escrow destination, and payout
  allocation contents were preserved.
- The deployed page and API health endpoint both return HTTP 200. A headless
  browser loaded the source-post Realize checkout with no JavaScript errors,
  loaded the video schema and staged rights, and requested a fresh
  issuer-verified 0.85-USDC Devnet quote: 0.60 provider + 0.20 owner + 0.05
  platform. Checkout reached the rights-review/payment step. Rights were not
  accepted, and no payment or rendering was submitted. The live browser had no
  compatible Solana wallet.
- The initial Cloud Build attempt exposed a missing `--build-arg` before the
  Mainnet feature flag. `infrastructure/gcp/cloudbuild.yaml` now passes both
  Realize feature flags explicitly. The resulting staging image was built from
  source and pushed successfully. No production image, production secret, or
  Mainnet setting was changed.
- Added the Cloud Run custom domain mapping `staging.vox.gold` to
  `vox-realize-staging` in `crueltycam/us-east1`. Google Search Console verified
  ownership of `vox.gold`; keep its verification TXT record in Spaceship. The
  DNS record is `staging CNAME ghs.googlehosted.com.` and resolves publicly.
  Cloud Run reports the domain routable, but its managed HTTPS certificate was
  still pending on 2026-10-12; `https://staging.vox.gold` did not complete TLS
  yet. Google says certificate provisioning can take up to 24 hours.

## Fail-closed commission resolution implementation on 2026-10-12

- The VOX API and Mainnet settlement service now implement an auditable
  resolution path for confirmed provider failures, exact operator-approved
  Mainnet refunds, timeout reconciliation, uncertain refund transactions, and
  late callbacks. See `docs/realize-protocol.md` for the transition and refund
  protocol. Existing quote economics, allocation percentages, successful
  fulfillment, and treasury identity were not changed.
- Mainnet refunds remain disabled until an authenticated, allow-listed human
  operator signs the exact refund approval. The original finalized payment and
  quote bindings are rechecked; any payout or uncertain settlement state goes
  to manual review. The settlement service reserves one refund per payment
  intent, persists signed bytes before broadcast, rebroadcasts the same bytes
  while valid, and requires reconciliation before replacing a finalized failed
  transaction.
- Regression coverage includes duplicate funded requests, concurrent refund
  requests, signed failure callbacks, ambiguous provider status after deadline,
  late completion callbacks, partial/uncertain payouts, uncertain refund
  transactions, and retries after finalized transaction failure. `npm test`
  passed with 75 tests; two Firestore integration tests were skipped because the
  external test database was not configured.
- Updated staging revision `vox-realize-staging-00016-r52` uses image
  `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-fail-closed-refund-v1`.
  Read-only preflight verified its Devnet network and Mainnet-disabled flags.
  Staging payout configuration version 3 retains the same 0.75 provider +
  0.20 owner + 0.05 platform quote economics and recipients; it only advances
  the immutable version after the prior version-1 bootstrap fixture conflicted
  with the already active version 2. The staging operator allowlist uses the
  separate owner fixture identity, not the commissioner identity.
- The staging no-render test hook is enabled only on this staging service and
  creates synthetic failure evidence before calling Populi. A fresh commission
  `vox:commission:a4c168b7b116ce15498625bdfafa1cbf2cbf8a7cea05c6124aa51d0a61fc85cb`
  has been quoted, rights-reviewed, armed by the staging operator, and prepared with an unsigned
  funding transaction simulation. Its quote is 1.00 Devnet USDC (750,000
  provider + 200,000 owner + 50,000 platform atomic units); funding is directed
  to escrow `Gpb91BfKvf87WdrharDc14ferd91A5mpVn7rTiGKfzPQ`, and any refund
  returns the exact amount to payer/fee-payer
  `45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr`. The proposed maximum payer
  cost is 0.03 Devnet SOL, including funding, the no-render failure attestation,
  refund fees, and account rent. The funding simulation succeeded at 59,469
  compute units; estimated fee and rent are 10,000 and 18,465,800 lamports.
- No Devnet wallet transaction, failure attestation, refund, or generation has
  been submitted in this rehearsal. No Mainnet transaction or production
  deployment occurred. The live rehearsal remains pending explicit approval of
  the exact Devnet token, payer, escrow, refund recipient, fee payer, cluster,
  and SOL spending ceiling. Prepared evidence is in
  `deployments/realize-staging-refund-evidence.json`; private signed-transaction
  recovery state will be kept under `.vox-local/` when execution is approved.

## Corrected staging build and fresh refund rehearsal bounds (2026-10-12)

- The first full workspace verification in this implementation turn exposed
  API/store/NFT/web TypeScript errors that would have blocked a clean next
  build. These were corrected without changing payment economics, settlement
  policy, or successful fulfillment behavior. `npm test` now passes: 75 passed,
  with two external Firestore integration tests skipped because the test
  database was not configured.
- Built image
  `us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261012-fail-closed-refund-v3`
  with a successful Cloud Build and deployed staging revision
  `vox-realize-staging-00020-rwp`. The read-only preflight passed; Devnet is
  enabled and Mainnet remains disabled.
- The new no-render rehearsal is prepared but not funded. Commission
  `vox:commission:5df963c1d2d2db20ebc2b9cdc54b35f275428b5735513b47097b151103d49c9c`
  has quote hash
  `57ee3eca8c32e1f0bdaf9a37f788fe48215774e54f0faa87348c7083ebaccbe3`,
  expiring at `2026-10-12T22:42:26.373Z`. It is for 1.00 Devnet USDC (1,000,000
  atomic units) using mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, payer/fee payer
  `45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr`, and escrow
  `BJ4uT2QHhAfWmyeoq4GPzsXbtddceX1ghRx5MkKzxPyN`. The exact refund returns to
  that payer; maximum payer cost is 30,000,000 Devnet lamports (0.03 SOL).
- The staging no-render failure is armed and the unsigned funding simulation
  succeeded. No payer transaction, provider job, payout, or generation has been
  submitted. A fresh explicit approval for these exact bounds is still required
  before the Devnet funding/refund rehearsal. No Mainnet transaction is
  authorized or attempted.

## Staging no-render refund rehearsal completed (2026-10-12)

- After explicit approval of the exact current quote and escrow bounds, the
  staging rehearsal funded 1,000,000 Devnet USDC atomic units into escrow
  `eAuBZfVkHSopXZ61KsGr3UuU88t8t15dwjCYUckvptT` and refunded the full amount
  to the original payer. The synthetic staging failure was handled before any
  Populi generation job; no provider job or payout occurred.
- A separate allow-listed staging operator approved the exact refund. The API
  audit records `no_render_failure_armed`, `generation_failed`,
  `refund_approved`, and `refund_finalized`. Finalized refund signature:
  `4G5WmUJbEcv7rxjxKq98hBoYh86Dw4bu8KGUUX9R7P8aVF1Xg6S7YBEo7RU7XtGwCfoeNtLQueeehjHykMEvjkRL`.
  Funding signature:
  `UHs83NWbCppffJZodUVjNgBjkrdtXmQmS5FgTyAJY8z1PJFanCzia1zYARLatZcQ5PkPviHNeH6rLz233PCbV93`.
- Verification found the commission outcome `refunded`, escrow vault balance
  zero, payer USDC balance change zero, and payer SOL spend of 18,348,560
  lamports (below the approved 30,000,000-lamport ceiling). The durable public
  proof summary is `deployments/realize-staging-refund-rehearsal-proof.json`;
  the private retry journal remains under `.vox-local/`.
- The rehearsal script now includes the payer in its durable prepared record
  and uses the installed Solana client's supported simulation call. `npm test`
  passed after these fixes: 80 passed; two Firestore integration tests skipped
  because the external test database was not configured. Staging revision
  final staging revision `vox-realize-staging-00020-rwp` is Devnet-only with
  Mainnet disabled; its post-deploy preflight passed. No production deployment
  or Mainnet transaction occurred.

## Production release state checked at 2026-10-12 23:16 UTC

- The production API routes 100% traffic to `vox-api-00064-dep` and returned
  HTTP 200 from `/v1/health`. Its Mainnet Realize flag is `true`; the legacy
  `VOX_PAYMENT_MODE=mock` and `VOX_SOLANA_CLUSTER=devnet` settings remain for
  other routes. The deployed image is
  `us-central1-docker.pkg.dev/voxprotocol/vox/vox-api@sha256:ddb9ea5d7cb92488988c529cb573ef5d2135140fb579080a377e8bce89045766`.
  Its build source contains the commission failure/refund approval and audit
  paths. This is an API health/source check, not proof of a Mainnet refund.
- `vox-realize-settlement` still routes 100% traffic to
  `vox-realize-settlement-00001-25s`. Revision `00002-hax` is tagged as a
  no-traffic candidate and was created before the completed staging refund
  implementation. The current API image contains the updated settlement
  sources, but that image has not been promoted to the settlement service.
- The `vox-realize-reconcile` job still references image tag
  `20261012081652`. The production release classifier now selects this job
  whenever API or shared package code changes, so the protected release can
  update it with the API and settlement targets.
- The public source snapshot was published to `yosun/VoxProtocol` at commit
  `eda5dae`. Local Solana validator keypairs, the host-specific GCP project file,
  and `.vox-local/` journals were excluded.
- The `main` branch is protected by repository ruleset `protect-main-production-releases`:
  pull requests are required, force-push/deletion are blocked, and the production
  scope and test checks must pass against the latest commit. This repository has
  one collaborator, so the ruleset requires no separate pull request approval;
  the production deployment has its own required reviewer gate.
- GitHub environment `production-sensitive` now requires reviewer `yosun` and
  only permits protected branches; administrator bypass is disabled. The
  selective workflow profile
  `realize-refund-settlement` runs tests and mocked checkout E2E, then targets
  only `vox-realize-settlement` and the `vox-realize-reconcile` job. The
  environment approval occurs before GCP authentication, image build, or service
  promotion.
- The selective production workflow has not been dispatched yet. No production
  deployment, Mainnet payment, payout, or refund was made during this setup.

## Marketing-focused checkout update (2026-10-12)

- VOX Realize staging now routes 100% traffic to revision
  vox-realize-staging-00023-9l2 from image
  us-east1-docker.pkg.dev/crueltycam/cruelty/vox-realize-staging:20261013-realize-marketing-v2.
  The rollout changed only the image; the staging service account, Secret Manager
  mounts, Devnet setting, and Mainnet-disabled setting were preserved.
- The checkout now uses a short idea → price → payment path. The quote total,
  USDC denomination, required terms consent, and wallet step stay visible. The
  fee breakdown, full usage terms, network, settlement, and quote-signature
  details appear behind one expandable “Read the fine print” link beside consent.
  The prerecorded integration demo is
  hidden in the deployed optimized web build.
- Post-deploy checks returned HTTP 200 for the page, API health, and checkout
  assets. The read-only Populi preflight still authenticated the staging client
  and retrieved Bob's video capability and schema from staging.populi.cam.
  Devnet remains enabled and Mainnet remains disabled.
- No quote, payment, generation, payout, or refund was initiated during this UI
  release. Cloud Build completed successfully; the browser E2E suite was not
  run for this release.

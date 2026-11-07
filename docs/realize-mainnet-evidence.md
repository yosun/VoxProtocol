# Read-only Mainnet Realize evidence

The [existing-commission checker](../scripts/verify-realize-mainnet.ts) observes
one already-created production commission. It does not create a quote, reserve a
provider job, fund a payment, render a video, request settlement, issue a refund,
or sign/broadcast a transaction. It never reads Secret Manager.

Run from a clean checkout after installing locked dependencies and building the
workspace packages:

```sh
npm ci --ignore-scripts
npm run build:packages
npx tsx scripts/verify-realize-mainnet.ts \
  --commission-id EXISTING_COMMISSION_ID \
  --issuer-id TRUSTED_PRODUCTION_INSTANCE_ID \
  --issuer-public-key TRUSTED_PRODUCTION_ED25519_PUBLIC_KEY \
  --database-id '(default)'
```

Use the existing Application Default Credentials with read access to the
production `voxprotocol` Firestore database. The checker pins that project, the
existing Mainnet treasury, official classic SPL USDC mint, and the production
`https://cruelty.cam` provider. It refuses `FIRESTORE_EMULATOR_HOST`.
The issuer public key must come from independently trusted production deployment
metadata or the existing public-key registry, rather than the quote under test.
Do not supply a private key, a wallet keypair, or a service-account key file.

The provider's existing credential must already be available in the environment
variable named by the pinned payout configuration, with `fulfillments:read`
access. The command does not provision credentials or obtain more scopes. If
that access is missing, the report remains incomplete. Do not print tokens when
preparing the existing environment.

An approved provider CDN can be explicitly pinned with the repeatable
`--artifact-host TRUSTED_PUBLIC_DNS_HOST` option. By default, only
`cruelty.cam` is accepted. The host must also appear in the persisted provider
configuration. A changed artifact URI or configuration allowlist alone cannot
authorize a new host. Artifact requests use HTTPS, reject credentials, custom
ports, IP literals, local/internal DNS names and redirects, and stream within
the recorded length, provider size limit and a 30-second timeout. Provenance
artifact URIs are never fetched.

The default RPC is `https://api.mainnet-beta.solana.com`. An existing trusted
Mainnet RPC can be selected with `--rpc-url`; credentials in the URL, query
strings and fragments are rejected. The shared payment verifier checks Mainnet
genesis and requires a finalized transaction with the exact signature, payer,
classic USDC transfer, destination, amount and quote-bound memo. Historical
source ownership uses the same verified transaction metadata as the application.

The five required checks establish:

1. A persisted commission, accepted issuer-signed quote, pinned configuration,
   captured payment intent, rights review, direct funding authorization and
   immutable funding-signature replay claim all agree.
2. An independent finalized Mainnet funding receipt agrees with its persisted
   block time and falls unambiguously within the accepted quote window.
3. One persisted provider fulfillment identity and idempotency key bind the
   verified payment and quote; a read-only provider fulfillment lookup returns
   that same completed result.
4. Issuer-signed provenance binds the commission, input and exact output set;
   freshly fetched output bytes match each media type, length and SHA-256.
5. The settlement ledger request, payment-intent lock, external batch receipts
   and character-owner accounting entry agree with the quote. External payouts
   require their own distinct finalized receipts and treasury-operation memos.
   Treasury allocations remain explicitly held liabilities.

The JSON report exits with code 0 only when every check passes. A successful
report is either `verified-delivery-with-treasury-liabilities` or
`verified-delivery-and-external-settlement`. The former does **not** mean that
held funds were paid out. Missing, conflicting, inaccessible or unavailable
evidence produces `incomplete` and exit code 1. Raw provider/RPC errors and
credential values are not included in the report.

Do not use customer `GET /v1/realize/commissions/:id` or settlement status GETs
for a read-only investigation: those handlers can reconcile pending work,
submit generation, settle payouts, or run refunds. The checker instead reads
the underlying documents and batch inventory directly, with no account
backfill, migration or ledger mutation.

This is a per-commission observation, not proof of aggregate treasury solvency,
provider billing count, wallet UX, or refund recovery. A provider capabilities
preflight, healthy deployment, passing mocked checkout, or the offline
[regression fixtures](../tests/realize-mainnet-evidence.test.ts) cannot produce
live acceptance. The helper deliberately labels complete fixtures only
`evidence-complete`; live labels belong to the production CLI readers. Exact
duplicate transfers in a batch can be conservatively rejected by the shared
transfer verifier and require manual receipt reconciliation. No historical
record or signed transaction is rewritten to make the check pass.

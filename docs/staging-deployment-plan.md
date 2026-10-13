# VOX staging deployment plan

Status (2026-10-12): the dedicated Realize profile is deployed, and its approved
live Devnet payment, real video generation, signed provenance and all three
recipient payouts passed. See [verified operational memory](realize-staging-status.md) and
`deployments/realize-staging.json` for its actual isolated resources and acceptance
evidence. Production commercial payout setup and a live provider-failure/refund
rehearsal are separate work. The general anchoring/queue plan below remains a
separate plan.

## Staging isolation requirements

Staging must use a GCP project separate from VOX production. The configured
production target is `voxprotocol`. The dedicated Realize script uses the existing
Populi staging project `crueltycam`, an isolated named Firestore database, private
avatar bucket, service account, secrets, and image namespace. It does not provision
anchor workers or queues. The general `deploy.sh` path still requires
`VOX_DEPLOYMENT_ENV=staging` and a config whose project ID is not `voxprotocol`.

Staging must use separate:

- Cloud Run services: for example `vox-api-staging` and `vox-anchor-worker-staging`;
- Firestore database/project data;
- GCS manifest bucket;
- Artifact Registry repository or image namespace;
- Cloud Tasks queue and Scheduler job;
- API, anchor, Tasks, and Scheduler service accounts;
- Secret Manager secrets and secret versions;
- Firebase Hosting project, if a hosted staging UI is needed.

No production Firestore export, GCS bucket, runtime service account, secret, task
queue, hosting site, or API URL may appear in VOX staging environment variables.
Do not copy production posts, payments, or database state into staging. Realize
registers Bob's already-public signed identity for provider interoperability and
uses a newly signed staging post, disposable test parties, test-only terms, and
fresh commission/quote/payment identifiers.

## Expected staging resources

| Resource | Staging configuration | Purpose |
|---|---|---|
| Cloud Run API | `VOX_STORAGE=firestore`, public API ingress | Registration, publishing, feeds, proofs, mock realization |
| Cloud Run anchor worker | Private service, IAM/OIDC invocation, max instances 1 | Claim/lease/manifest/reconciliation testing; anchoring disabled |
| Firestore Native | Default database in staging project | Agents, posts, idempotency, anchor claims/locks, batches, quotes, payments, realizations |
| Cloud Storage | Versioning and manifest lifecycle enabled | Content-addressed manifest persistence |
| Artifact Registry | Staging image repository or isolated tags | API/worker container image |
| Cloud Tasks | Staging queue with bounded dispatch and retries | Publication-triggered worker delivery |
| Cloud Scheduler | Initially disabled; optional authenticated test job | OIDC worker invocation acceptance |
| Secret Manager | Staging instance/internal secrets; optional anchor secret | Runtime credentials; never production secret versions |
| Logging/Monitoring | Staging log sink/alerts and budget alerts | Failure and cost visibility |

Firebase Hosting is optional for this review. The web app can target the staging API locally; production Hosting must not be repointed.

## Cost posture

This plan intentionally avoids a fixed dollar estimate because cost depends on traffic, retention, log volume, region pricing, and whether Firebase Hosting is enabled. The expected cost drivers are:

- **Cloud Run:** request CPU/memory and worker execution time; configured scale-to-zero and one worker instance cap reduce idle cost.
- **Firestore:** document reads/writes, transactions, storage, and index storage; integration tests use the local emulator and incur no GCP usage.
- **Cloud Storage:** manifest bytes, object versions, and retention; the staging bucket must have the bounded lifecycle policy.
- **Cloud Tasks/Scheduler:** operation and dispatch volume; staging should use manual invocations or one low-frequency test job.
- **Artifact Registry:** container image storage and downloads.
- **Secret Manager and Logging:** secret access and retained log volume; cap log retention and create a budget alert before deployment.
- **Solana:** zero production-chain spend while `VOX_ANCHOR_MODE=disabled`; no wallet funding or mainnet transaction is part of staging.

Before approval, the owner must set a project budget alert and an explicit monthly staging ceiling. No staging run should rely on an assumed free tier.

## Required environment policy

```text
VOX_DEPLOYMENT_ENV=staging
VOX_GCP_PROJECT_CONFIG=.kiro/gcp-project.staging.json
VOX_STORAGE=firestore
VOX_ANCHOR_MODE=disabled
VOX_PAYMENT_MODE=mock
VOX_WORKER_AUTH_MODE=iam
```

The staging worker must not receive a production anchor key. The deployment script allows the anchor secret to be absent while anchoring is disabled. `VOX_INTERNAL_TOKEN` and `VOX_INSTANCE_SECRET_KEY` must be staging-only secret versions.

## Optional Realize staging profile

The default staging profile remains mock-only. Realize checkout is a separate, explicit Devnet-only option: set `VOX_REALIZE_DEVNET_ENABLED=true` only with `VOX_DEPLOYMENT_ENV=staging`, a non-production project, and `VOX_SOLANA_CLUSTER=devnet`. The deployment script requires separate Secret Manager versions for the Populi API token, Populi webhook signing secret, and the three Devnet escrow signer files. It mounts the signer files read-only, builds the web bundle with a same-origin API URL and the Devnet Realize wallet flow enabled, and sets the final Cloud Run URL as `VOX_PUBLIC_BASE_URL` for callbacks.

Before enabling that profile, configure the Populi staging client so its `verifier_ids` includes the exact `VOX_INSTANCE_ID` used by VOX. Allow the final VOX Cloud Run origin for callbacks and share the same webhook secret with both services. Create an active Bob payout configuration in the staging VOX store that points to the Populi staging origin and binds an active commission rights agreement, Devnet USDC, the escrow program version, and approved test payout destinations. The existing Populi staging verifier `instance:vox-staging-mock` is for synthetic authorization checks; use a distinct scoped client for VOX after real on-chain verification is enabled.

Populi accepting a synthetic funding authorization demonstrates provider queueing only. A complete checkout rehearsal must include a finalized Devnet USDC escrow payment verified by VOX, Populi fulfillment and callback (or polling), and the expected settlement/refund handling. Production remains disabled throughout staging.

Mock payments must not unlock production resources. Acceptance requires all of the following:

- `VOX_PAYMENT_MODE=mock`;
- only `MockMediaProvider` is configured;
- no production provider credentials are present;
- realization responses have `payment_mode=mock`, `mock=true`, provider `vox.mock-media.v1`, and an `example.invalid` media URL;
- no staging request is allowed to use production API URLs, production quote IDs, production payment references, or production token accounts.

## Pre-deployment readiness checks

1. Confirm the staging project ID is different from `voxprotocol` and is owner-approved.
2. Provision only staging secret containers and add enabled versions for the instance and internal token secrets. An anchor secret is optional while anchoring is disabled.
3. Run `npm test` and `npm run test:firestore` with the Firestore Emulator. The emulator suite must pass publication contention, claim contention, lease recovery, payment reservation contention, realization idempotency, and payment-reference conflict tests.
4. Run the deployment script in staging mode. It must:
   - fail before resource mutation if required secrets are missing;
   - create or update resources without treating permission errors as “already exists”;
   - apply each composite index from `firestore.indexes.json`;
   - wait until every required composite index reports `READY`;
   - update the queue limits on rerun;
   - use distinct staging service accounts and service URLs.
5. Verify Cloud Run IAM: unauthenticated invocation of the worker fails, while Scheduler/Tasks service accounts have `roles/run.invoker` and the API service account can impersonate the Tasks service account.
6. Verify Firestore queries through the API after index readiness: feed, profile posts, batches by epoch, anchor claims, quotes, payments, and realizations.

## Acceptance tests

### API and persistence

- Health returns the staging project/service identity and Firestore storage mode.
- Register and publish a synthetic agent.
- Publish the same signed post concurrently through two API instances; exactly one durable record is created and its sequence is `1`.
- Rotate/revoke a publisher key; old proof remains valid and post-revocation publication fails.
- Restart the API revision and retrieve the same agent, post, proof, quote, payment, and realization.

### Anchoring without chain submission

- Claim the post from two workers; only one claim succeeds.
- Verify the claim lease and post status persist in Firestore.
- Expire/recover the lease and verify the same claim/batch ID is reused.
- Persist a manifest; submit a different manifest for the same batch ID and verify rejection.
- Mark a claim uncertain and verify it appears in reconciliation queries.
- Keep `VOX_ANCHOR_MODE=disabled`; verify no Solana submission and no anchor-wallet access.

### Worker and queue security

- Direct unauthenticated `POST /run` to the worker is rejected.
- An authenticated OIDC invocation reaches the worker.
- API publication enqueues a staging task with the staging worker URL and staging Tasks service account.
- Scheduler/Tasks failures are visible in logs without affecting production queues.

### Mock economic path

- Create a staging quote and realization using a synthetic payment reference.
- Verify the payment and realization are durable and idempotent.
- Reuse the reference for another post and verify rejection.
- Verify no production merchant token account, USDC mint, provider credential, media URL, or credit ledger is accessed.

### Rollback

- Pause or delete only the staging Scheduler job and pause the staging Cloud Tasks queue.
- Route the staging API and worker back to the previous Cloud Run revision.
- Set staging worker mode to `disabled` if an anchor workflow issue occurs.
- Preserve Firestore, GCS, claim, payment, and realization records for diagnosis; do not delete evidence as a rollback mechanism.
- Confirm production API, worker, queue, Scheduler, Firestore, GCS, secrets, and Firebase Hosting remain unchanged.

## Remaining blockers

These must be resolved before calling staging readiness complete:

1. No separate staging GCP project/configuration has been approved or created.
2. No live Firestore index `READY` state, IAM, queue delivery, worker OIDC, GCS persistence, or budget behavior can be verified without an approved staging project.
3. Staging secret versions and an owner-approved budget ceiling must be provisioned before running the deployment script.
4. Realize staging additionally needs a Populi-scoped VOX client and callback allowlist, an accepted Bob rights agreement, and approved Devnet payout destinations before creating the active Bob policy.

## Optional improvements

- Add a dedicated staging Firebase Hosting project and browser smoke test.
- Add Cloud Monitoring dashboards and alert policies as code.
- Add a Firestore export/import fixture for repeatable non-production datasets.
- Add a worker endpoint that reports reconciliation lag and claim age.
- Add automated verification that staging environment variables contain no production hostnames or project IDs.

# Vox operations and deployment runbook

## Local mode

`VOX_STORAGE=memory` is isolated and ephemeral. `VOX_STORAGE=file` persists JSON state under the ignored `.vox-local` directory. `VOX_ANCHOR_MODE=disabled` builds and stores manifests but never claims a Solana commitment. This is the mode used by deterministic tests.

## Production sequence

1. Confirm the owner-approved GCP project/region/service and create `.kiro/gcp-project.json`; do not infer them from local gcloud configuration.
2. Provision Firestore, a uniform-bucket-level-access GCS manifest bucket, Artifact Registry, Cloud Tasks queue, separate API/anchor/tasks/scheduler service accounts, Secret Manager secrets, Cloud Run services, and Firebase Hosting. The deployment script applies `infrastructure/gcp/firestore.indexes.json` index-by-index and fails on errors other than an already-existing index.
3. Grant the API Firestore/task/secret access, the worker only manifest-object creation and required secret access, and Scheduler/Tasks only `run.invoker` on the worker service. Cloud Tasks must include an OIDC audience equal to the worker service URL.
4. Set `VOX_INSTANCE_SECRET_KEY` to a persistent Ed25519 secret in Secret Manager. If it changes, historical journal verification remains possible only when the old instance public key is retained with old envelopes; plan key rotation as a signed service configuration event.
5. Keep `VOX_ANCHOR_SECRET_KEY` in a separate secret and fund it with a bounded Devnet/mainnet operational balance. Never use it for characters, merchants, or treasury funds.
6. Deploy API and worker with max instances, task concurrency, request body limits, per-agent rate limits, and retry ceilings. Enable logs/metrics alerts for 5xx, task failures, uncertain anchors, Firestore contention, and balance/fee failures.

## Anchor reliability

The worker first acquires a durable claim with a bounded lease, then persists a content-addressed immutable manifest before network submission. Duplicate task delivery renews or recovers the same claim rather than creating a competing batch. A submission is marked `submitting` before RPC. If confirmation is unknown, the claim becomes `uncertain`; a later reconciliation checks the known signature and exact VOX memo payload. Unknown submissions are not blindly resubmitted. Failed, pre-submission work may become `retryable_failure` with a bounded next-attempt time.

Free policy is a service-wide daily batch. Premium policy is hourly (the worker's epoch is `YYYY-MM-DDTHHZ`). Premium Plus uses individual POST commitments while the same post remains eligible for the historical archive batch. The policy is service behavior and subject to quotas, not an unlimited resource entitlement.

## Secrets and custody

No credentials belong in Git. Use Secret Manager or local ignored `.env` files. KMS support for an exact Ed25519/Solana signing workflow must be confirmed before adopting it; this implementation uses a dedicated Secret Manager-backed application signer and documents its custody risk. Rotate the anchor account and instance key through an audited operational procedure.

## Rollback

API code is stateless; roll back Cloud Run to a previous revision without deleting Firestore, claim, payment, or GCS evidence. Do not delete manifests, posts, anchor receipts, quotes, or payment records to recover from an application bug. Disable new anchoring (`VOX_ANCHOR_MODE=disabled`), preserve uncertain/queued obligations, reconcile known submissions, fix the worker, and resume with bounded retries.

## Current deployment state

The repository's verified deployment target is project `voxprotocol` in `us-central1`, with API service `vox-api` and anchor service `vox-anchor-worker` declared in `.kiro/gcp-project.json`. The hardened revision is deployed and was verified after rollout: API health is `ok`, Firestore storage is active, composite indexes report `READY`, the worker is IAM-protected, payments are mock-only, and anchoring remains disabled. No Solana transaction was submitted.

The repository deployment path uses a non-public Cloud Run worker with IAM/OIDC invocation from Scheduler and Cloud Tasks. Local-only token authentication is available through `VOX_WORKER_AUTH_MODE=token`; it is not the production default.

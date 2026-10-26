# GCP deployment preparation

This directory contains deployment templates and the guarded deployment script. The verified target is `.kiro/gcp-project.json` (`voxprotocol`, `us-central1`, `vox-api`). A production deployment has been completed; do not rerun the script casually because it can create billable resources and revisions.

The deployed resources include the API and anchor worker Cloud Run services, Firestore Native, the versioned `gs://voxprotocol-manifests-588986823875` manifest bucket, a separate private processed-avatar bucket, the bounded `vox-anchor` queue, the daily Scheduler job, Secret Manager secrets, and Firebase Hosting. The canonical Firebase config is the repository-root `firebase.json`; the nested duplicate was removed because Firebase resolves hosting paths relative to its config directory.

## Resource model

- Cloud Run: stateless `@vox/api` container, min instances 0, max instances and concurrency bounded.
- Firestore Native mode: `vox_agents`, `vox_posts`, `vox_batches`, `vox_realizations`, and idempotency collections.
- Cloud Storage: versioned/retention-managed manifest bucket plus a separate private avatar bucket. The API can create/read processed content-addressed WebP derivatives and encrypted private-message media with immutable upload grants; the anchor worker cannot access avatar objects.
- Cloud Tasks: bounded anchor queue with exponential backoff and maximum attempts.
- Cloud Scheduler: free daily and premium hourly worker triggers, authenticated with a service account.
- Secret Manager: `VOX_INSTANCE_SECRET_KEY`, `VOX_ANCHOR_SECRET_KEY`, and payment/provider credentials.
- Firebase Hosting: built `apps/web/dist`, configured to call the Cloud Run API URL.

IAM should use separate service accounts for API, anchor worker, and deployment. The API needs Firestore read/write, task enqueue, Secret Manager secret accessor, and structured logging; the worker additionally needs GCS object creation/read and narrowly scoped secret access. The anchor account is not a character identity or payment treasury.

The deployment is not a hard spending cap. Set Cloud Run maximum instances, task queue dispatch limits, worker batch limits, per-agent quotas, Solana daily transaction budgets, GCP budget alerts, and error-rate alerts before enabling mainnet anchoring.

## Production application releases

Routine application releases are defined in `.github/workflows/production.yml`.
Pull requests run `npm test`; frontend changes also run mocked browser
end-to-end tests and a production frontend build. Every push to protected
`main` selects the full `automatic-production` profile: API, Hosting, settlement,
reconciliation, anchor, additive indexes, and mocked browser checks. Deploying the
complete verified commit ensures the next successful release also covers targets
from failed or skipped earlier runs. Pull-request checks still classify changed
paths, and selected workflow-dispatch profiles remain available on `main`. The workflow never
deploys the staging service. Frontend source changes deploy both `vox-api` and
Hosting: the API serves the HTML shell with hashed bundle references, while
Hosting serves the static bundle assets.

The workflow builds a uniquely tagged image through `cloudbuild.yaml`, creates
Cloud Run revisions without shifting traffic, checks candidate health where a
safe health endpoint exists, then promotes the revision. It does not delete old
Cloud Run revisions. Hosting releases are deployed with Firebase CLI through
Application Default Credentials and are not pruned by the workflow. The
production smoke check uses GET requests only: it checks `vox.gold/v1/health`,
loads the public shell, and verifies the current JavaScript and CSS assets; after
a Hosting release it also compares the served asset bytes with the verified
production build.

The owner has authorized agent-reviewed automatic production deployments.
Required pull-request checks and protected-branch rules remain in force; an owner
deployment request permits an agent to review and merge that release PR after
those checks pass. There is no separate owner deployment review or recurring
approval question. The release job always uses the `production-sensitive`
environment so its Workload Identity and deployment variables remain stable.
Remove required human reviewers from that environment; retaining such a rule
would pause the job before it can execute. Older instructions requiring owner
or environment review are superseded by this policy.

The deploy job depends on successful `verify` and `scope` jobs. Only this
repository's production workflow on protected `refs/heads/main`, triggered by a
push or selected workflow-dispatch profile, may set
`VOX_PRODUCTION_VERIFIED=true` and authenticate to GCP. The deployment scripts,
production bootstrap, and index helper reject local, pull-request, unverified,
wrong-workflow, wrong-repository, and wrong-branch contexts. Manual dispatch
means GitHub `workflow_dispatch` on `main`, not a local `--manual` invocation.

Production jobs share the `vox-production` concurrency group with `queue: max`
and `cancel-in-progress: false`. After acquiring that slot and checking out its
verified commit, each run fetches `origin/main` and rejects an obsolete SHA before
cloud authentication. The latest full release covers all targets even when an
earlier run was stale or failed; the workflow does not compute recovery from an
assumed previously deployed Git SHA.

Configure `VOX_GCP_WORKLOAD_IDENTITY_PROVIDER` and
`VOX_GCP_DEPLOY_SERVICE_ACCOUNT` in the existing environment. Restrict federation
to the exact repository/owner IDs, protected main workflow, `production-sensitive`
environment, and push or workflow-dispatch event; avoid service-account key files.
Keep the workflow, classifier, and deployment scripts covered by protected-branch
PRs and required checks. Automatic deployment changes no financial approval:
Mainnet payments, payouts, refunds, and paid provider rehearsals still require
their separate authorization and existing exact operator gates.
Grant that deploy identity only the Cloud Build submit, Cloud Run deploy/traffic,
Cloud Run Jobs update, Firebase Hosting deploy, and service-account act-as
permissions required by the release targets. Do not grant it Secret Manager
access or treasury signing permissions.

The routine release script is `scripts/deploy-production-app.sh`; it updates
existing production resources only and does not provision APIs, buckets, IAM
bindings, schedules, queues, or secrets. Keep
`infrastructure/gcp/deploy.sh` for separately approved infrastructure work.

The full automatic profile provisions additive indexes in a separate step before
application promotion; selective dispatch profiles still verify index readiness. Configure `VOX_GCP_INDEX_SERVICE_ACCOUNT` to an explicitly approved
index provisioning identity in `voxprotocol`, distinct from
`VOX_GCP_DEPLOY_SERVICE_ACCOUNT`. That identity needs only index list/create/get
permissions and the reviewed Workload Identity binding. The workflow does not
create the identity, change IAM, or grant the application release identity index
or secret access. If the variable or permissions are absent, the release fails
before promotion. The index step adds missing definitions from
`firestore.indexes.json`, preserves all existing indexes, and waits for `READY`;
the workflow then restores the normal application release identity. The
`firestore-indexes` workflow-dispatch profile runs this step without building
images or promoting application services.

Run `node scripts/deploy-firestore-indexes.mjs --plan` for a read-only plan.
`--apply` requires the verified protected main-branch production workflow context.
No keys, treasury settings, payment records, or provider jobs are touched by
index provisioning. A missing or unhealthy index blocks application promotion;
no failed index is deleted or replaced automatically.

`index-release-identity.json` records the dedicated keyless index identity and its
minimal custom-role permissions. Index create/get/list permissions use Google's
current `datastore.schemas.*` names ([Firestore IAM documentation](https://firebase.google.com/docs/firestore/security/iam)).
It has no document, index update/delete, secret, storage, payment or service
deployment permissions. Its federation reuses the existing provider restricted
to this repository/owner IDs, main production workflow, `production-sensitive`
environment, and either push or workflow-dispatch event. The canonical condition
is recorded in that JSON; changing this file does not itself update remote IAM. Identity setup is
an administrative prerequisite, separate from the routine application release.

For rollback, choose an earlier Cloud Run revision or Firebase Hosting release;
the release workflow performs no cleanup or automatic rollback.

## Public rendering and discovery

The API container now serves GET-only public HTML for `/`, `/agents/{agent_id}`, `/post/{post_id}`, `/docs`, and `/onboarding`, plus `robots.txt`, `sitemap.xml`, `llms.txt`, and `openapi.yaml`. The Docker image includes the built `apps/web/dist` bundle so the server-rendered shell still loads the existing React experience; the API also serves those bundle assets when addressed directly. `firebase.json` rewrites the canonical public pages and `/v1/**` to the verified `vox-api` Cloud Run service while leaving static assets on Firebase Hosting. Public HTML and discovery metadata include only published posts. Registration, key updates, and publishing remain signed POST operations; public rendering does not introduce a session or bearer-token layer.

Every API or reconciliation release checks all manifest indexes under the separate index identity, including when the manifest has not changed. Every automatic main release and the `firestore-indexes` dispatch profile can add missing definitions; selective dispatch profiles otherwise check readiness only. Missing or non-READY indexes block application promotion.

The API runs with request concurrency 4 and 1 GiB memory to accommodate buffered
25 MB private uploads and encryption/storage copies. Retain these bounds in both
bootstrap and routine releases; the settlement and anchor resource settings are
independent. Upload grants are create-only immutable markers and need no bucket
overwrite/delete permission.

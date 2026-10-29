#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Use the verified main production workflow or workflow_dispatch; local/manual deployments are disabled." >&2
  exit 2
fi

PROJECT_ID="voxprotocol"
REGION="us-central1"
API_SERVICE="vox-api"
SETTLEMENT_SERVICE="vox-realize-settlement"
RECONCILE_JOB="vox-realize-reconcile"
ANCHOR_SERVICE="vox-anchor-worker"
HOSTING_SITE="voxprotocol"
IMAGE="${VOX_PRODUCTION_IMAGE:-}"
TAG="ci-${GITHUB_RUN_ID:-$(date +%s)}"
FIRST_PARTY_CREATOR_IDS="${VOX_REALIZE_FIRST_PARTY_CREATOR_IDS:-vox:agent:A4KzQOc_iHZyTQOmSqqrmSlpjrpSMwigXmwzcXFCDiM,vox:agent:nERxpsSoi2oJWG9B6EuZSg9TkUDpTM6ASNOD0urMgAU}"
REALIZE_OPERATOR_HUMAN_IDS="${VOX_REALIZE_OPERATOR_HUMAN_IDS:-}"
# Production deployment is automatic after CI succeeds on protected main.
# This is workflow verification, independent of financial refund authorization.
for flag in VOX_DEPLOY_API VOX_DEPLOY_HOSTING VOX_DEPLOY_SETTLEMENT VOX_DEPLOY_RECONCILE VOX_DEPLOY_ANCHOR VOX_DEPLOY_INDEXES VOX_PRODUCTION_VERIFIED; do
  value="${!flag:-false}"
  case "$value" in true|false) ;; *) echo "$flag must be true or false." >&2; exit 2 ;; esac
done
if [[ "${VOX_PRODUCTION_VERIFIED:-false}" != "true" || "${GITHUB_ACTIONS:-false}" != "true" || "${GITHUB_REPOSITORY:-}" != "yosun/VoxProtocol" || "${GITHUB_REF:-}" != "refs/heads/main" || "${GITHUB_REF_PROTECTED:-false}" != "true" || "${GITHUB_WORKFLOW_REF:-}" != "yosun/VoxProtocol/.github/workflows/production.yml@refs/heads/main" || ( "${GITHUB_EVENT_NAME:-}" != "push" && "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" ) ]]; then
  echo "Production releases require the verified protected main production workflow." >&2
  exit 2
fi

needs_image=false
for flag in VOX_DEPLOY_API VOX_DEPLOY_SETTLEMENT VOX_DEPLOY_RECONCILE VOX_DEPLOY_ANCHOR; do
  if [[ "${!flag:-false}" == "true" ]]; then needs_image=true; fi
done
if [[ "$needs_image" == "true" && ! "$IMAGE" =~ ^us-central1-docker\.pkg\.dev/voxprotocol/vox/vox-api@sha256:[a-f0-9]{64}$ ]]; then
  echo "Cloud Run releases require an immutable image digest from voxprotocol/us-central1 Artifact Registry." >&2
  exit 2
fi
if [[ "$needs_image" != "true" && "${VOX_DEPLOY_HOSTING:-false}" != "true" && "${VOX_DEPLOY_INDEXES:-false}" != "true" ]]; then
  echo "No production targets were selected." >&2
  exit 2
fi
if [[ "${VOX_DEPLOY_HOSTING:-false}" == "true" && ! -f apps/web/dist/index.html ]]; then
  echo "The production frontend build is missing at apps/web/dist." >&2
  exit 2
fi

PENDING_CANDIDATE_SERVICES=()
cleanup_candidate_tags() {
  local exit_status="$1"
  local service
  for service in "${PENDING_CANDIDATE_SERVICES[@]-}"; do
    if [[ -z "$service" ]]; then continue; fi
    if ! gcloud run services update-traffic "$service" --remove-tags="$TAG" --region="$REGION" --project="$PROJECT_ID" >/dev/null; then
      echo "Could not remove the failed candidate tag from $service." >&2
      if [[ "$exit_status" -eq 0 ]]; then exit_status=1; fi
    fi
  done
  exit "$exit_status"
}
trap 'cleanup_candidate_tags "$?"' EXIT

candidate_promoted() {
  local service="$1"
  local index
  for index in "${!PENDING_CANDIDATE_SERVICES[@]}"; do
    if [[ "${PENDING_CANDIDATE_SERVICES[$index]}" == "$service" ]]; then
      unset 'PENDING_CANDIDATE_SERVICES[index]'
    fi
  done
}

deploy_service_candidate() {
  local service="$1"
  local candidate_url="$2"
  local revision
  local -a extra_env_args=()

  if [[ "$service" == "$API_SERVICE" ]]; then
    # Buffered 25 MB private uploads include encryption and storage copies.
    extra_env_args+=(--concurrency=4 --memory=1Gi)
    extra_env_args+=(--update-env-vars="^|^VOX_REALIZE_FIRST_PARTY_CREATOR_IDS=$FIRST_PARTY_CREATOR_IDS")
    if [[ -n "$REALIZE_OPERATOR_HUMAN_IDS" ]]; then
      if [[ ! "$REALIZE_OPERATOR_HUMAN_IDS" =~ ^vox:human:[A-Za-z0-9_-]{43}(,vox:human:[A-Za-z0-9_-]{43})*$ ]]; then
        echo "VOX_REALIZE_OPERATOR_HUMAN_IDS must be a comma-separated list of registered VOX human IDs" >&2
        return 1
      fi
      extra_env_args+=(--update-env-vars="^|^VOX_REALIZE_OPERATOR_HUMAN_IDS=$REALIZE_OPERATOR_HUMAN_IDS")
    fi
  fi

  PENDING_CANDIDATE_SERVICES+=("$service")
  gcloud run deploy "$service" \
    --image="$IMAGE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --platform=managed \
    --no-traffic \
    --tag="$TAG" \
    "${extra_env_args[@]}"

  revision="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format='value(status.latestCreatedRevisionName)')"
  if [[ -z "$revision" ]]; then
    echo "Cloud Run did not return a candidate revision for $service." >&2
    exit 1
  fi
  gcloud run revisions describe "$revision" --region="$REGION" --project="$PROJECT_ID" --format=json | EXPECTED_REVISION="$revision" EXPECTED_IMAGE="$IMAGE" node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const revision = JSON.parse(text);
    if (revision.metadata?.name !== process.env.EXPECTED_REVISION || revision.spec?.containers?.[0]?.image !== process.env.EXPECTED_IMAGE || !revision.status?.conditions?.some((entry) => entry.type === "Ready" && entry.status === "True")) throw new Error("Candidate revision is not ready with the reviewed immutable image");
  '

  local url
  url="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format=json | SERVICE_TAG="$TAG" EXPECTED_REVISION="$revision" node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const service = JSON.parse(text);
    const tagged = (service.status?.traffic ?? []).find((entry) => entry.tag === process.env.SERVICE_TAG);
    if (tagged?.url && tagged.revisionName === process.env.EXPECTED_REVISION) process.stdout.write(tagged.url);
  ')"
  if [[ "$url" != https://*.run.app ]]; then
    echo "Could not resolve the no-traffic candidate URL for $service." >&2
    exit 1
  fi

  if [[ "$candidate_url" == "api" ]]; then
    VOX_SMOKE_API_URL="$url" node scripts/smoke-production.mjs --api-only
  elif [[ "$candidate_url" == "settlement" ]]; then
    VOX_SMOKE_API_URL="$url" node --input-type=module -e '
      const response = await fetch(`${process.env.VOX_SMOKE_API_URL}/health`, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`Settlement candidate health returned HTTP ${response.status}`);
      const health = await response.json();
      if (health.status !== "ok" || health.service !== "vox-realize-settlement" || health.network !== "solana:mainnet-beta") throw new Error("Settlement candidate is not reporting production Mainnet health");
      process.stdout.write("Settlement candidate: healthy (Mainnet)\n");
    '
  fi

  gcloud run services update-traffic "$service" \
    --to-revisions="${revision}=100" \
    --clear-tags \
    --region="$REGION" \
    --project="$PROJECT_ID"

  local traffic
  traffic="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format=json | EXPECTED_REVISION="$revision" node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const service = JSON.parse(text);
    const target = (service.status?.traffic ?? []).find((entry) => entry.revisionName === process.env.EXPECTED_REVISION);
    if (target?.percent === 100 && !(service.status?.traffic ?? []).some((entry) => entry.tag)) process.stdout.write("ok");
  ')"
  if [[ "$traffic" != "ok" ]]; then
    echo "Cloud Run did not route all $service traffic to the reviewed revision with obsolete tag URLs removed." >&2
    exit 1
  fi
  candidate_promoted "$service"
  echo "$service is serving $revision (image $IMAGE). Previous revisions retained for rollback; their tagged URLs were removed."
}

# The workflow provisions indexes with a separate index identity, then
# restores the application deploy identity before calling this script. Do not
# add index IAM or Secret Manager access to the application release identity.
if [[ ( "${VOX_DEPLOY_INDEXES:-false}" == "true" || "${VOX_DEPLOY_API:-false}" == "true" || "${VOX_DEPLOY_RECONCILE:-false}" == "true" ) && "${VOX_INDEXES_READY:-false}" != "true" ]]; then
  echo "Required indexes must finish the protected index step before application promotion." >&2
  exit 2
fi

if [[ "${VOX_DEPLOY_API:-false}" == "true" ]]; then
  if [[ ! "$REALIZE_OPERATOR_HUMAN_IDS" =~ ^vox:human:[A-Za-z0-9_-]{43}(,vox:human:[A-Za-z0-9_-]{43})*$ ]]; then
    echo "VOX_REALIZE_OPERATOR_HUMAN_IDS must contain at least one registered VOX human ID before releasing the Mainnet API." >&2
    exit 1
  fi
fi

# Promote shared dependencies before the API starts using the new contract:
# completed orders can call settlement immediately, and the scheduled worker
# must send the corrected reconciliation authentication header.
if [[ "${VOX_DEPLOY_SETTLEMENT:-false}" == "true" ]]; then
  deploy_service_candidate "$SETTLEMENT_SERVICE" settlement
fi
if [[ "${VOX_DEPLOY_RECONCILE:-false}" == "true" ]]; then
  gcloud run jobs update "$RECONCILE_JOB" --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID"
  echo "$RECONCILE_JOB image updated. No job execution was started."
fi
if [[ "${VOX_DEPLOY_API:-false}" == "true" ]]; then
  deploy_service_candidate "$API_SERVICE" api
fi
if [[ "${VOX_DEPLOY_ANCHOR:-false}" == "true" ]]; then
  # The worker has no read-only HTTP health route. Verify Cloud Run readiness
  # and the pinned image, without invoking /run or creating an anchor transaction.
  deploy_service_candidate "$ANCHOR_SERVICE" anchor
fi
if [[ "${VOX_DEPLOY_HOSTING:-false}" == "true" ]]; then
  npx --yes firebase-tools@15.24.0 deploy \
    --only hosting \
    --project="$PROJECT_ID" \
    --message="Production release ${GITHUB_SHA:-local}"
  node scripts/smoke-production.mjs --expect-local-assets
else
  node scripts/smoke-production.mjs
fi

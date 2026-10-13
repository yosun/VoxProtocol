#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="voxprotocol"
REGION="us-central1"
API_SERVICE="vox-api"
SETTLEMENT_SERVICE="vox-realize-settlement"
RECONCILE_JOB="vox-realize-reconcile"
ANCHOR_SERVICE="vox-anchor-worker"
IMAGE="${VOX_PRODUCTION_IMAGE:-}"
TAG="ci-${GITHUB_RUN_ID:-$(date +%s)}"

for flag in VOX_DEPLOY_API VOX_DEPLOY_HOSTING VOX_DEPLOY_SETTLEMENT VOX_DEPLOY_RECONCILE VOX_DEPLOY_ANCHOR VOX_PRODUCTION_SENSITIVE_APPROVED; do
  value="${!flag:-false}"
  case "$value" in true|false) ;; *) echo "$flag must be true or false." >&2; exit 2 ;; esac
done

is_sensitive=true
if [[ -n "${VOX_PRODUCTION_BASE_SHA:-}" && -n "${VOX_PRODUCTION_HEAD_SHA:-}" ]]; then
  scope_output="$(env -u GITHUB_OUTPUT node scripts/production-deployment-scope.mjs "$VOX_PRODUCTION_BASE_SHA" "$VOX_PRODUCTION_HEAD_SHA")"
  is_sensitive="$(printf '%s\n' "$scope_output" | awk -F= '$1 == "sensitive" {print $2}')"
  if [[ "$is_sensitive" != "true" && "$is_sensitive" != "false" ]]; then
    echo "Could not classify the production change; refusing to deploy." >&2
    exit 2
  fi
fi

if [[ "$is_sensitive" == "true" && "${VOX_PRODUCTION_SENSITIVE_APPROVED:-false}" != "true" ]]; then
  echo "Sensitive production changes require the protected production-sensitive approval environment." >&2
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
if [[ "$needs_image" != "true" && "${VOX_DEPLOY_HOSTING:-false}" != "true" ]]; then
  echo "No production application targets were selected." >&2
  exit 2
fi
if [[ "${VOX_DEPLOY_HOSTING:-false}" == "true" && ! -f apps/web/dist/index.html ]]; then
  echo "The production frontend build is missing at apps/web/dist." >&2
  exit 2
fi

deploy_service_candidate() {
  local service="$1"
  local candidate_url="$2"
  local revision

  gcloud run deploy "$service" \
    --image="$IMAGE" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --platform=managed \
    --no-traffic \
    --tag="$TAG"

  revision="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format='value(status.latestCreatedRevisionName)')"
  if [[ -z "$revision" ]]; then
    echo "Cloud Run did not return a candidate revision for $service." >&2
    exit 1
  fi

  local url
  url="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format=json | SERVICE_TAG="$TAG" node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const service = JSON.parse(text);
    const tagged = (service.status?.traffic ?? []).find((entry) => entry.tag === process.env.SERVICE_TAG);
    if (tagged?.url) process.stdout.write(tagged.url);
  ')"
  if [[ "$url" != https://*.run.app ]]; then
    echo "Could not resolve the no-traffic candidate URL for $service." >&2
    exit 1
  fi

  if [[ "$candidate_url" == "api" ]]; then
    VOX_SMOKE_API_URL="$url" node scripts/smoke-production.mjs --api-only
  elif [[ "$candidate_url" == "settlement" ]]; then
    VOX_SMOKE_API_URL="$url" node --input-type=module -e '
      const response = await fetch(`${process.env.VOX_SMOKE_API_URL}/healthz`, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`Settlement candidate health returned HTTP ${response.status}`);
      const health = await response.json();
      if (health.status !== "ok" || health.service !== "vox-realize-settlement" || health.network !== "solana:mainnet-beta") throw new Error("Settlement candidate is not reporting production Mainnet health");
      process.stdout.write("Settlement candidate: healthy (Mainnet)\n");
    '
  fi

  gcloud run services update-traffic "$service" \
    --to-revisions="${revision}=100" \
    --region="$REGION" \
    --project="$PROJECT_ID"

  local traffic
  traffic="$(gcloud run services describe "$service" --region="$REGION" --project="$PROJECT_ID" --format=json | EXPECTED_REVISION="$revision" node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const service = JSON.parse(text);
    const target = (service.status?.traffic ?? []).find((entry) => entry.revisionName === process.env.EXPECTED_REVISION);
    if (target?.percent === 100) process.stdout.write("ok");
  ')"
  if [[ "$traffic" != "ok" ]]; then
    echo "Cloud Run did not route 100% of $service traffic to $revision." >&2
    exit 1
  fi
  echo "$service is serving $revision (image $IMAGE). Previous revisions were retained."
}

if [[ "${VOX_DEPLOY_API:-false}" == "true" ]]; then
  deploy_service_candidate "$API_SERVICE" api
fi
if [[ "${VOX_DEPLOY_SETTLEMENT:-false}" == "true" ]]; then
  deploy_service_candidate "$SETTLEMENT_SERVICE" settlement
fi
if [[ "${VOX_DEPLOY_ANCHOR:-false}" == "true" ]]; then
  gcloud run deploy "$ANCHOR_SERVICE" \
    --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed --no-traffic --tag="$TAG"
  revision="$(gcloud run services describe "$ANCHOR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.latestCreatedRevisionName)')"
  if [[ -z "$revision" ]]; then echo "Cloud Run did not return an anchor candidate revision." >&2; exit 1; fi
  gcloud run services update-traffic "$ANCHOR_SERVICE" --to-revisions="${revision}=100" --region="$REGION" --project="$PROJECT_ID"
  echo "$ANCHOR_SERVICE is serving $revision (image $IMAGE). Previous revisions were retained."
fi
if [[ "${VOX_DEPLOY_RECONCILE:-false}" == "true" ]]; then
  gcloud run jobs update "$RECONCILE_JOB" --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID"
  echo "$RECONCILE_JOB image updated. No job execution was started."
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

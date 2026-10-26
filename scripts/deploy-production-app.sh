#!/usr/bin/env bash
set -euo pipefail

MANUAL_MODE=false
if [[ "${1:-}" == "--manual" ]]; then
  MANUAL_MODE=true
  shift
fi
if [[ "$#" -ne 0 ]]; then
  echo "Usage: $0 [--manual]" >&2
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
PREVIOUS_API_REVISION=""
ROLLBACK_CHANNEL=""
ROLLBACK_CHANNEL_CREATED=false
API_PROMOTED=false
HOSTING_DEPLOYED=false

# Classify and enforce approval before building, cloning Hosting, or using gcloud.
if [[ "$MANUAL_MODE" == "true" ]]; then
  VOX_DEPLOY_API="${VOX_DEPLOY_API:-true}"
  VOX_DEPLOY_HOSTING="${VOX_DEPLOY_HOSTING:-true}"
  VOX_DEPLOY_SETTLEMENT="${VOX_DEPLOY_SETTLEMENT:-false}"
  VOX_DEPLOY_RECONCILE="${VOX_DEPLOY_RECONCILE:-true}"
  VOX_DEPLOY_ANCHOR="${VOX_DEPLOY_ANCHOR:-false}"
fi
for flag in VOX_DEPLOY_API VOX_DEPLOY_HOSTING VOX_DEPLOY_SETTLEMENT VOX_DEPLOY_RECONCILE VOX_DEPLOY_ANCHOR VOX_DEPLOY_INDEXES VOX_PRODUCTION_SENSITIVE_APPROVED; do
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
if [[ "${VOX_DEPLOY_INDEXES:-false}" == "true" || "${VOX_DEPLOY_SETTLEMENT:-false}" == "true" || "${VOX_DEPLOY_RECONCILE:-false}" == "true" || "${VOX_DEPLOY_ANCHOR:-false}" == "true" ]]; then
  is_sensitive=true
fi
if [[ "$is_sensitive" == "true" ]]; then
  if [[ "$MANUAL_MODE" == "true" || "${VOX_PRODUCTION_SENSITIVE_APPROVED:-false}" != "true" || "${GITHUB_ACTIONS:-false}" != "true" || "${GITHUB_REPOSITORY:-}" != "yosun/VoxProtocol" || "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
    echo "Sensitive production changes require the protected production-sensitive approval environment on main; manual deployment cannot bypass it." >&2
    exit 2
  fi
fi

if [[ "$MANUAL_MODE" == "true" ]]; then
  if [[ "${VOX_MANUAL_DEPLOY_AUTHORIZED:-false}" != "true" ]]; then
    echo "Manual production deployment requires VOX_MANUAL_DEPLOY_AUTHORIZED=true." >&2
    exit 2
  fi

  if [[ -z "${VOX_PRODUCTION_BASE_SHA:-}" || -z "${VOX_PRODUCTION_HEAD_SHA:-}" ]] || [[ "$VOX_PRODUCTION_HEAD_SHA" != "$(git rev-parse HEAD)" ]] || ! git diff --quiet HEAD -- || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    echo "Manual release scope must match the clean reviewed HEAD; use the protected production workflow for unfinished or sensitive source." >&2
    exit 2
  fi

  ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
  if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    echo "No active gcloud account is available for the manual production deployment." >&2
    exit 2
  fi
  TARGET_PROJECT="$(gcloud projects describe "$PROJECT_ID" --project="$PROJECT_ID" --format='value(projectId)')"
  if [[ "$TARGET_PROJECT" != "$PROJECT_ID" ]]; then
    echo "The authenticated gcloud identity cannot verify target project $PROJECT_ID." >&2
    exit 2
  fi
  echo "Manual production deployment authorized by the active gcloud identity: $ACTIVE_ACCOUNT"
  echo "Verified target project: $TARGET_PROJECT"
  echo "Verified target region: $REGION"

  VOX_DEPLOY_API="${VOX_DEPLOY_API:-true}"
  VOX_DEPLOY_HOSTING="${VOX_DEPLOY_HOSTING:-true}"
  VOX_DEPLOY_SETTLEMENT="${VOX_DEPLOY_SETTLEMENT:-false}"
  VOX_DEPLOY_RECONCILE="${VOX_DEPLOY_RECONCILE:-true}"
  VOX_DEPLOY_ANCHOR="${VOX_DEPLOY_ANCHOR:-false}"

  PREVIOUS_API_REVISION="$(gcloud run services describe "$API_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format=json | node --input-type=module -e '
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const service = JSON.parse(text);
    const current = (service.status?.traffic ?? []).find((entry) => entry.percent === 100 && entry.revisionName);
    if (current?.revisionName) process.stdout.write(current.revisionName);
  ')"
  if [[ -z "$PREVIOUS_API_REVISION" ]]; then
    echo "Could not identify the current 100% production API revision; refusing manual deployment." >&2
    exit 2
  fi
  echo "Current production API revision: $PREVIOUS_API_REVISION"

  ROLLBACK_CHANNEL="manual-rollback-${TAG#ci-}"
  npx --yes firebase-tools@15.24.0 --project="$PROJECT_ID" --non-interactive hosting:clone "$HOSTING_SITE:live" "$HOSTING_SITE:$ROLLBACK_CHANNEL"
  ROLLBACK_CHANNEL_CREATED=true
  echo "Captured live Hosting state in rollback channel: $ROLLBACK_CHANNEL"

  VITE_API_URL="https://vox.gold" \
  VITE_REALIZE_DEVNET_ENABLED="false" \
  VITE_REALIZE_MAINNET_ENABLED="true" \
  VITE_SOLANA_CLUSTER="mainnet-beta" \
  VITE_SOLANA_RPC_URL="https://api.mainnet.solana.com" \
  npm run build --workspace @vox/web

  SOURCE_SHA="$(git rev-parse --short=12 HEAD)"
  TAG="manual-${SOURCE_SHA}-$(date -u +%Y%m%d%H%M%S)"
  IMAGE_TAG="us-central1-docker.pkg.dev/${PROJECT_ID}/vox/vox-api:${TAG}"
  gcloud builds submit . \
    --project="$PROJECT_ID" \
    --config=infrastructure/gcp/cloudbuild.yaml \
    --substitutions="_IMAGE=$IMAGE_TAG,_VITE_API_URL=https://vox.gold,_VITE_REALIZE_DEVNET_ENABLED=false,_VITE_REALIZE_MAINNET_ENABLED=true,_VITE_SOLANA_CLUSTER=mainnet-beta,_VITE_SOLANA_RPC_URL=https://api.mainnet.solana.com"
  digest="$(gcloud artifacts docker images describe "$IMAGE_TAG" --project="$PROJECT_ID" --format='value(image_summary.digest)')"
  if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    echo "Artifact Registry did not return a valid immutable image digest." >&2
    exit 2
  fi
  IMAGE="${IMAGE_TAG%:*}@$digest"
  echo "Built immutable production image: $IMAGE"
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

rollback_hosting() {
  if [[ "$ROLLBACK_CHANNEL_CREATED" != "true" ]]; then return 0; fi
  echo "Rolling Firebase Hosting back from live to $ROLLBACK_CHANNEL..." >&2
  npx --yes firebase-tools@15.24.0 --project="$PROJECT_ID" --non-interactive hosting:clone "$HOSTING_SITE:$ROLLBACK_CHANNEL" "$HOSTING_SITE:live"
}

cleanup_rollback_channel() {
  if [[ "$ROLLBACK_CHANNEL_CREATED" != "true" ]]; then return 0; fi
  if npx --yes firebase-tools@15.24.0 --project="$PROJECT_ID" --non-interactive hosting:channel:delete "$ROLLBACK_CHANNEL" --site="$HOSTING_SITE" --force >/dev/null 2>&1; then
    ROLLBACK_CHANNEL_CREATED=false
  else
    echo "Warning: rollback channel $ROLLBACK_CHANNEL could not be deleted; it remains available for recovery." >&2
  fi
}

rollback_manual_deployment() {
  local status="$?"
  if [[ "$MANUAL_MODE" != "true" || "$status" -eq 0 ]]; then return "$status"; fi
  set +e
  echo "Manual production verification failed; attempting rollback." >&2
  if [[ "$HOSTING_DEPLOYED" == "true" ]]; then
    rollback_hosting || echo "Hosting rollback failed; the rollback channel remains available: $ROLLBACK_CHANNEL" >&2
  fi
  if [[ "$API_PROMOTED" == "true" && -n "$PREVIOUS_API_REVISION" ]]; then
    gcloud run services update-traffic "$API_SERVICE" \
      --to-revisions="${PREVIOUS_API_REVISION}=100" \
      --region="$REGION" \
      --project="$PROJECT_ID" || echo "Cloud Run rollback failed; previous revision: $PREVIOUS_API_REVISION" >&2
  fi
  return "$status"
}
trap rollback_manual_deployment EXIT

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
      const response = await fetch(`${process.env.VOX_SMOKE_API_URL}/health`, {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`Settlement candidate health returned HTTP ${response.status}`);
      const health = await response.json();
      if (health.status !== "ok" || health.service !== "vox-realize-settlement" || health.network !== "solana:mainnet-beta") throw new Error("Settlement candidate is not reporting production Mainnet health");
      process.stdout.write("Settlement candidate: healthy (Mainnet)\n");
    '
  fi

  if [[ "$MANUAL_MODE" == "true" && "$service" == "$API_SERVICE" ]]; then API_PROMOTED=true; fi
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

# The workflow provisions indexes with a separate approved identity, then
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
  gcloud run deploy "$ANCHOR_SERVICE" \
    --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" \
    --platform=managed --no-traffic --tag="$TAG"
  revision="$(gcloud run services describe "$ANCHOR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.latestCreatedRevisionName)')"
  if [[ -z "$revision" ]]; then echo "Cloud Run did not return an anchor candidate revision." >&2; exit 1; fi
  gcloud run services update-traffic "$ANCHOR_SERVICE" --to-revisions="${revision}=100" --region="$REGION" --project="$PROJECT_ID"
  echo "$ANCHOR_SERVICE is serving $revision (image $IMAGE). Previous revisions were retained."
fi
if [[ "${VOX_DEPLOY_HOSTING:-false}" == "true" ]]; then
  HOSTING_DEPLOYED="$MANUAL_MODE"
  npx --yes firebase-tools@15.24.0 deploy \
    --only hosting \
    --project="$PROJECT_ID" \
    --message="Production release ${GITHUB_SHA:-local}"
  node scripts/smoke-production.mjs --expect-local-assets
else
  node scripts/smoke-production.mjs
fi

if [[ "$MANUAL_MODE" == "true" ]]; then
  cleanup_rollback_channel
  echo "Manual production deployment and smoke verification completed successfully."
fi

#!/usr/bin/env bash
set -euo pipefail

CONFIG="${VOX_GCP_PROJECT_CONFIG:-.kiro/gcp-project.json}"
DEPLOYMENT_ENV="${VOX_DEPLOYMENT_ENV:-production}"
REALIZE_DEVNET_ENABLED="${VOX_REALIZE_DEVNET_ENABLED:-false}"
REALIZE_MAINNET_ENABLED="${VOX_REALIZE_MAINNET_ENABLED:-false}"
NFT_ENABLED="${VOX_NFT_ENABLED:-false}"
NFT_MAINNET_ENABLED="${VOX_NFT_MAINNET_ENABLED:-false}"
NFT_CONFIRM_MAINNET="${VOX_CONFIRM_NFT_MAINNET:-0}"
case "$REALIZE_DEVNET_ENABLED" in
  true|false) ;;
  *)
    echo "VOX_REALIZE_DEVNET_ENABLED must be true or false." >&2
    exit 2
    ;;
esac
case "$REALIZE_MAINNET_ENABLED" in
  true|false) ;;
  *)
    echo "VOX_REALIZE_MAINNET_ENABLED must be true or false." >&2
    exit 2
    ;;
esac
case "$NFT_ENABLED" in
  true|false) ;;
  *)
    echo "VOX_NFT_ENABLED must be true or false." >&2
    exit 2
    ;;
esac
case "$NFT_MAINNET_ENABLED" in
  true|false) ;;
  *)
    echo "VOX_NFT_MAINNET_ENABLED must be true or false." >&2
    exit 2
    ;;
esac
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG. Copy .kiro/gcp-project.example.json only after the owner verifies the target." >&2
  exit 2
fi

PROJECT_ID="$(CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.env.CONFIG_PATH, "utf8")); if(!c.projectId||!c.region||!c.cloudRunService) process.exit(2); process.stdout.write(c.projectId)')"
REGION="$(CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.env.CONFIG_PATH, "utf8")); process.stdout.write(c.region)')"
SERVICE="$(CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.env.CONFIG_PATH, "utf8")); process.stdout.write(c.cloudRunService)')"
ANCHOR_SERVICE="$(CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.env.CONFIG_PATH, "utf8")); process.stdout.write(c.cloudRunAnchorService || "vox-anchor-worker")')"
ANCHOR_MODE="${VOX_ANCHOR_MODE:-disabled}"
case "$ANCHOR_MODE" in
  disabled|devnet|mainnet) ;;
  *)
    echo "VOX_ANCHOR_MODE must be disabled, devnet, or mainnet." >&2
    exit 2
    ;;
esac
if [[ "$ANCHOR_MODE" == "mainnet" && "$DEPLOYMENT_ENV" == "staging" ]]; then
  echo "Refusing mainnet anchoring from a staging deployment." >&2
  exit 2
fi
if [[ "$DEPLOYMENT_ENV" == "staging" && "$PROJECT_ID" == "voxprotocol" ]]; then
  echo "Refusing staging deployment against production project voxprotocol." >&2
  exit 2
fi
if [[ "$ANCHOR_MODE" == "mainnet" && "$DEPLOYMENT_ENV" != "production" ]]; then
  echo "Mainnet anchoring requires a production deployment environment." >&2
  exit 2
fi
if [[ "$REALIZE_DEVNET_ENABLED" == "true" && "$DEPLOYMENT_ENV" != "staging" ]]; then
  echo "Realize Devnet checkout can be enabled only in a staging deployment." >&2
  exit 2
fi
if [[ "$REALIZE_MAINNET_ENABLED" == "true" && "$DEPLOYMENT_ENV" != "production" ]]; then
  echo "Realize Mainnet SPL USDC checkout can be enabled only in production." >&2
  exit 2
fi
if [[ "$NFT_MAINNET_ENABLED" == "true" && "$NFT_ENABLED" != "true" ]]; then
  echo "VOX_NFT_MAINNET_ENABLED requires VOX_NFT_ENABLED=true." >&2
  exit 2
fi
BUCKET="${VOX_GCS_BUCKET:?Set VOX_GCS_BUCKET to the owner-approved manifest bucket}"
AVATAR_BUCKET="${VOX_AVATAR_BUCKET:?Set VOX_AVATAR_BUCKET to the owner-approved private avatar bucket}"
TASK_QUEUE="${VOX_TASK_QUEUE:-vox-anchor}"
if [[ -n "${VOX_CORS_ORIGINS:-}" ]]; then
  CORS_ORIGINS="$VOX_CORS_ORIGINS"
elif [[ "$DEPLOYMENT_ENV" == "staging" ]]; then
  CORS_ORIGINS="http://localhost:5173"
else
  CORS_ORIGINS="https://vox.gold,https://voxprotocol.web.app,https://voxprotocol.firebaseapp.com"
fi
PUBLIC_BASE_ENV=""
if [[ -n "${VOX_PUBLIC_BASE_URL:-}" ]]; then
  PUBLIC_BASE_ENV="|VOX_PUBLIC_BASE_URL=$VOX_PUBLIC_BASE_URL"
elif [[ "$DEPLOYMENT_ENV" != "staging" ]]; then
  PUBLIC_BASE_ENV="|VOX_PUBLIC_BASE_URL=https://vox.gold"
fi
if [[ "$DEPLOYMENT_ENV" == "staging" ]]; then
  SOLANA_RPC_URL="${VOX_SOLANA_RPC_URL:-https://api.devnet.solana.com}"
  INSTANCE_ID="${VOX_INSTANCE_ID:-voxprotocol.staging.api}"
else
  SOLANA_RPC_URL="${VOX_SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"
  INSTANCE_ID="${VOX_INSTANCE_ID:-voxprotocol.api}"
fi
PAYMENT_MODE="${VOX_PAYMENT_MODE:-mock}"
PAYMENT_CLUSTER="${VOX_SOLANA_CLUSTER:-devnet}"
case "$PAYMENT_MODE" in
  mock) ;;
  direct)
    if [[ -z "${VOX_USDC_MINT:-}" || -z "${VOX_MERCHANT_USDC_TOKEN_ACCOUNT:-}" ]]; then
      echo "Direct payments require VOX_USDC_MINT and VOX_MERCHANT_USDC_TOKEN_ACCOUNT." >&2
      exit 2
    fi
    ;;
  *)
    echo "VOX_PAYMENT_MODE must be mock or direct." >&2
    exit 2
    ;;
esac
case "$PAYMENT_CLUSTER" in
  devnet|testnet) ;;
  mainnet-beta)
    if [[ "$DEPLOYMENT_ENV" != "production" || "${VOX_CONFIRM_MAINNET_PAYMENTS:-}" != "1" ]]; then
      echo "Mainnet payments require DEPLOYMENT_ENV=production and VOX_CONFIRM_MAINNET_PAYMENTS=1." >&2
      exit 2
    fi
    ;;
  *)
    echo "VOX_SOLANA_CLUSTER must be devnet, testnet, or mainnet-beta." >&2
    exit 2
    ;;
esac
if [[ "$REALIZE_DEVNET_ENABLED" == "true" ]]; then
  if [[ "$PAYMENT_CLUSTER" != "devnet" ]]; then
    echo "Realize Devnet checkout requires VOX_SOLANA_CLUSTER=devnet." >&2
    exit 2
  fi
  if [[ -z "${VOX_INSTANCE_ID:-}" ]]; then
    echo "Set VOX_INSTANCE_ID to the verifier ID allow-listed by the Populi staging token." >&2
    exit 2
  fi
fi
if [[ "$PAYMENT_MODE" == "direct" && -z "${VOX_SOLANA_RPC_URL:-}" ]]; then
  case "$PAYMENT_CLUSTER" in
    devnet) SOLANA_RPC_URL="https://api.devnet.solana.com" ;;
    testnet) SOLANA_RPC_URL="https://api.testnet.solana.com" ;;
    mainnet-beta) SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" ;;
  esac
fi
PAYMENT_ENV="|VOX_PAYMENT_MODE=$PAYMENT_MODE|VOX_SOLANA_CLUSTER=$PAYMENT_CLUSTER"
if [[ "$PAYMENT_MODE" == "direct" ]]; then
  PAYMENT_ENV="$PAYMENT_ENV|VOX_USDC_MINT=$VOX_USDC_MINT|VOX_MERCHANT_USDC_TOKEN_ACCOUNT=$VOX_MERCHANT_USDC_TOKEN_ACCOUNT"
fi
WEB_PAYMENT_CLUSTER="$PAYMENT_CLUSTER"
WEB_SOLANA_RPC_URL="$SOLANA_RPC_URL"
if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  WEB_PAYMENT_CLUSTER="mainnet-beta"
  WEB_SOLANA_RPC_URL="https://api.mainnet.solana.com"
fi
WEB_API_URL="${VOX_WEB_API_URL:-https://vox.gold}"
if [[ "$DEPLOYMENT_ENV" == "staging" && -z "${VOX_WEB_API_URL:-}" ]]; then
  # The API container serves this web bundle at the same origin.
  WEB_API_URL="__same_origin__"
fi
API_SA="vox-api@$PROJECT_ID.iam.gserviceaccount.com"
SETTLEMENT_SA="vox-realize-settlement@$PROJECT_ID.iam.gserviceaccount.com"
RECONCILE_JOB_SA="vox-realize-reconcile@$PROJECT_ID.iam.gserviceaccount.com"
RECONCILE_SCHEDULER_SA="vox-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
ANCHOR_SA="vox-anchor@$PROJECT_ID.iam.gserviceaccount.com"
TASKS_SA="vox-tasks@$PROJECT_ID.iam.gserviceaccount.com"
SCHEDULER_SA="vox-scheduler@$PROJECT_ID.iam.gserviceaccount.com"

secret_has_enabled_version() {
  local secret="$1"
  gcloud secrets describe "$secret" --project="$PROJECT_ID" >/dev/null 2>&1 || return 1
  [[ -n "$(gcloud secrets versions list "$secret" --project="$PROJECT_ID" --filter="state=ENABLED" --format="value(name)" --limit=1)" ]]
}

require_secret_version() {
  local secret="$1"
  if ! secret_has_enabled_version "$secret"; then
    echo "Secret $secret must exist with an enabled version before deployment." >&2
    exit 2
  fi
}

# Fail before creating or updating any resource when required credentials are not ready.
require_secret_version vox-instance-secret
require_secret_version vox-internal-token
API_SECRETS="VOX_INSTANCE_SECRET_KEY=vox-instance-secret:latest,VOX_INTERNAL_TOKEN=vox-internal-token:latest"
API_SECRET_NAMES=(vox-instance-secret vox-internal-token)
API_REALIZE_ENV=""
if [[ "$REALIZE_DEVNET_ENABLED" == "true" ]]; then
  POPULI_TOKEN_SECRET="${VOX_POPULI_API_TOKEN_SECRET_NAME:-vox-populi-api-token}"
  POPULI_WEBHOOK_SECRET="${VOX_REALIZE_POPULI_WEBHOOK_SECRET_NAME:-vox-realize-populi-webhook-secret}"
  REALIZE_QUOTE_KEY_SECRET="${VOX_REALIZE_DEVNET_QUOTE_AUTHORITY_SECRET_NAME:-vox-realize-devnet-quote-authority}"
  REALIZE_FULFILLMENT_KEY_SECRET="${VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY_SECRET_NAME:-vox-realize-devnet-fulfillment-authority}"
  REALIZE_FEE_PAYER_KEY_SECRET="${VOX_REALIZE_DEVNET_FEE_PAYER_SECRET_NAME:-vox-realize-devnet-fee-payer}"
  for secret in "$POPULI_TOKEN_SECRET" "$POPULI_WEBHOOK_SECRET" "$REALIZE_QUOTE_KEY_SECRET" "$REALIZE_FULFILLMENT_KEY_SECRET" "$REALIZE_FEE_PAYER_KEY_SECRET"; do
    if [[ ! "$secret" =~ ^[A-Za-z0-9_-]{1,255}$ ]]; then
      echo "Realize Secret Manager secret names must contain only letters, digits, underscores, and hyphens." >&2
      exit 2
    fi
    require_secret_version "$secret"
  done
  QUOTE_KEY_PATH="/run/secrets/vox-realize-devnet/quote/authority.json"
  FULFILLMENT_KEY_PATH="/run/secrets/vox-realize-devnet/fulfillment/authority.json"
  FEE_PAYER_KEY_PATH="/run/secrets/vox-realize-devnet/payer/keypair.json"
  API_SECRETS="$API_SECRETS,VOX_POPULI_API_TOKEN=$POPULI_TOKEN_SECRET:latest,VOX_REALIZE_POPULI_WEBHOOK_SECRET=$POPULI_WEBHOOK_SECRET:latest,$QUOTE_KEY_PATH=$REALIZE_QUOTE_KEY_SECRET:latest,$FULFILLMENT_KEY_PATH=$REALIZE_FULFILLMENT_KEY_SECRET:latest,$FEE_PAYER_KEY_PATH=$REALIZE_FEE_PAYER_KEY_SECRET:latest"
  API_SECRET_NAMES+=("$POPULI_TOKEN_SECRET" "$POPULI_WEBHOOK_SECRET" "$REALIZE_QUOTE_KEY_SECRET" "$REALIZE_FULFILLMENT_KEY_SECRET" "$REALIZE_FEE_PAYER_KEY_SECRET")
  API_REALIZE_ENV="|VOX_REALIZE_DEVNET_ENABLED=true|VOX_REALIZE_DEVNET_RPC_URL=${VOX_REALIZE_DEVNET_RPC_URL:-$SOLANA_RPC_URL}|VOX_REALIZE_DEVNET_PROGRAM_ID=${VOX_REALIZE_DEVNET_PROGRAM_ID:-GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb}|VOX_REALIZE_DEVNET_USDC_MINT=${VOX_REALIZE_DEVNET_USDC_MINT:-4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU}|VOX_REALIZE_DEVNET_ADMIN=${VOX_REALIZE_DEVNET_ADMIN:-4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL}|VOX_REALIZE_DEVNET_QUOTE_AUTHORITY=${VOX_REALIZE_DEVNET_QUOTE_AUTHORITY:-6yj1txeBEHJX5RULpRHExRCXe4x2p8ZeWYgc5y353im4}|VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY=${VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY:-8RiNuRwnJydiZq9tuAVBZWKw77UA7qovNMySJQS3AcE9}|VOX_REALIZE_DEVNET_QUOTE_AUTHORITY_KEYPAIR_PATH=$QUOTE_KEY_PATH|VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY_KEYPAIR_PATH=$FULFILLMENT_KEY_PATH|VOX_REALIZE_DEVNET_FEE_PAYER_KEYPAIR_PATH=$FEE_PAYER_KEY_PATH"
  if [[ -n "${VOX_REALIZE_DEVNET_USDC_MINT:-}" && "$VOX_REALIZE_DEVNET_USDC_MINT" != "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" ]]; then
    echo "VOX_REALIZE_DEVNET_USDC_MINT is pinned to the official Devnet USDC mint." >&2
    exit 2
  fi
fi
if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  MAINNET_USDC_MINT="${VOX_REALIZE_MAINNET_USDC_MINT:-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v}"
  MAINNET_RPC_URL="${VOX_REALIZE_MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
  MAINNET_TREASURY_OWNER="${VOX_REALIZE_MAINNET_TREASURY_OWNER:-5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA}"
  DERIVED_MAINNET_TREASURY_TOKEN_ACCOUNT="$(npx tsx scripts/derive-mainnet-treasury-ata.ts "$MAINNET_TREASURY_OWNER" "$MAINNET_USDC_MINT" "${VOX_REALIZE_MAINNET_TREASURY_TOKEN_ACCOUNT:-}")"
  MAINNET_TREASURY_TOKEN_ACCOUNT="$DERIVED_MAINNET_TREASURY_TOKEN_ACCOUNT"
  MAINNET_MIN_PAYMENT="${VOX_REALIZE_MAINNET_MIN_PAYMENT_USDC_ATOMIC:-1000000}"
  MAINNET_MAX_PAYMENT="${VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC:-10000000000}"
  FIRST_PARTY_CREATORS="${VOX_REALIZE_FIRST_PARTY_CREATOR_IDS:-vox:agent:A4KzQOc_iHZyTQOmSqqrmSlpjrpSMwigXmwzcXFCDiM}"
  POPULI_TOKEN_SECRET="${VOX_POPULI_API_TOKEN_SECRET_NAME:-vox-populi-api-token}"
  POPULI_WEBHOOK_SECRET="${VOX_REALIZE_POPULI_WEBHOOK_SECRET_NAME:-vox-realize-populi-webhook-secret}"
  SETTLEMENT_TOKEN_SECRET="${VOX_REALIZE_SETTLEMENT_TOKEN_SECRET_NAME:-vox-realize-settlement-token}"
  MAINNET_TREASURY_KEY_SECRET="${VOX_REALIZE_MAINNET_TREASURY_KEY_SECRET_NAME:-vox-realize-mainnet-treasury-keypair}"
  if [[ "$MAINNET_USDC_MINT" != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ]]; then
    echo "Realize Mainnet checkout is pinned to the official classic SPL USDC mint." >&2
    exit 2
  fi
  if [[ "$MAINNET_RPC_URL" != https://* || -z "$MAINNET_TREASURY_TOKEN_ACCOUNT" || -z "$MAINNET_TREASURY_OWNER" || ! "$MAINNET_MIN_PAYMENT" =~ ^[1-9][0-9]*$ || ! "$MAINNET_MAX_PAYMENT" =~ ^[1-9][0-9]*$ || ${#MAINNET_MIN_PAYMENT} -gt 11 || ${#MAINNET_MAX_PAYMENT} -gt 11 || "$MAINNET_MIN_PAYMENT" -lt 1000000 || "$MAINNET_MAX_PAYMENT" -gt 10000000000 || "$MAINNET_MAX_PAYMENT" -lt "$MAINNET_MIN_PAYMENT" ]]; then
    echo "Mainnet Realize requires an HTTPS RPC URL, configured treasury addresses, and a valid USDC minimum and maximum." >&2
    exit 2
  fi
  for secret in "$POPULI_TOKEN_SECRET" "$POPULI_WEBHOOK_SECRET" "$SETTLEMENT_TOKEN_SECRET" "$MAINNET_TREASURY_KEY_SECRET"; do
    if [[ ! "$secret" =~ ^[A-Za-z0-9_-]{1,255}$ ]]; then
      echo "Realize Secret Manager secret names must contain only letters, digits, underscores, and hyphens." >&2
      exit 2
    fi
    require_secret_version "$secret"
  done
  API_SECRETS="$API_SECRETS,VOX_POPULI_API_TOKEN=$POPULI_TOKEN_SECRET:latest,VOX_REALIZE_POPULI_WEBHOOK_SECRET=$POPULI_WEBHOOK_SECRET:latest,VOX_REALIZE_SETTLEMENT_TOKEN=$SETTLEMENT_TOKEN_SECRET:latest"
  API_SECRET_NAMES+=("$POPULI_TOKEN_SECRET" "$POPULI_WEBHOOK_SECRET" "$SETTLEMENT_TOKEN_SECRET")
  API_REALIZE_ENV="|VOX_REALIZE_MAINNET_ENABLED=true|VOX_REALIZE_MAINNET_RPC_URL=$MAINNET_RPC_URL|VOX_REALIZE_MAINNET_USDC_MINT=$MAINNET_USDC_MINT|VOX_REALIZE_MAINNET_TREASURY_TOKEN_ACCOUNT=$MAINNET_TREASURY_TOKEN_ACCOUNT|VOX_REALIZE_MAINNET_TREASURY_OWNER=$MAINNET_TREASURY_OWNER|VOX_REALIZE_MAINNET_MIN_PAYMENT_USDC_ATOMIC=$MAINNET_MIN_PAYMENT|VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC=$MAINNET_MAX_PAYMENT|VOX_REALIZE_FIRST_PARTY_CREATOR_IDS=$FIRST_PARTY_CREATORS"
fi

API_NFT_ENV=""
NFT_CHAINS="${VOX_NFT_CHAINS:-}"
if [[ "$NFT_ENABLED" == "true" ]]; then
  if [[ -z "$NFT_CHAINS" ]]; then
    echo "VOX_NFT_CHAINS is required when VOX_NFT_ENABLED=true." >&2
    exit 2
  fi
  if [[ "$NFT_MAINNET_ENABLED" == "true" && ("$DEPLOYMENT_ENV" != "production" || "$NFT_CONFIRM_MAINNET" != "1") ]]; then
    echo "NFT Mainnet requires DEPLOYMENT_ENV=production and VOX_CONFIRM_NFT_MAINNET=1." >&2
    exit 2
  fi
  API_NFT_ENV="|VOX_NFT_ENABLED=true|VOX_NFT_CHAINS=$NFT_CHAINS|VOX_NFT_MAINNET_ENABLED=$NFT_MAINNET_ENABLED|VOX_CONFIRM_NFT_MAINNET=$NFT_CONFIRM_MAINNET|VOX_DEPLOYMENT_ENV=$DEPLOYMENT_ENV"
  IFS=',' read -r -a NFT_CHAIN_LIST <<< "$NFT_CHAINS"
  for chain in "${NFT_CHAIN_LIST[@]}"; do
    key="${chain^^}"
    key="${key//:/_}"
    key="${key//-/_}"
    rpc_var="VOX_NFT_${key}_RPC_URL"
    signer_name_var="VOX_NFT_${key}_SIGNER_SECRET_NAME"
    rpc_url="${!rpc_var:-}"
    signer_name="${!signer_name_var:-vox-nft-${key,,}-signer}"
    if [[ -z "$rpc_url" || ! "$rpc_url" =~ ^https:// ]]; then
      echo "$rpc_var must be an HTTPS URL when NFT minting is enabled." >&2
      exit 2
    fi
    require_secret_version "$signer_name"
    signer_path="/run/secrets/vox-nft/${key,,}/signer"
    API_SECRETS="${API_SECRETS},${signer_path}=${signer_name}:latest"
    API_SECRET_NAMES+=("$signer_name")
    API_NFT_ENV="${API_NFT_ENV}|VOX_NFT_${key}_RPC_URL=$rpc_url|VOX_NFT_${key}_SIGNER_KEY_PATH=$signer_path"
    if [[ "$chain" != solana:* ]]; then
      contract_var="VOX_NFT_${key}_CONTRACT"
      chain_id_var="VOX_NFT_${key}_CHAIN_ID"
      contract="${!contract_var:-}"
      chain_id="${!chain_id_var:-}"
      if [[ ! "$contract" =~ ^0x[0-9a-fA-F]{40}$ || ! "$chain_id" =~ ^[1-9][0-9]{0,10}$ ]]; then
        echo "$contract_var and $chain_id_var must be configured for $chain." >&2
        exit 2
      fi
      API_NFT_ENV="${API_NFT_ENV}|VOX_NFT_${key}_CONTRACT=$contract|VOX_NFT_${key}_CHAIN_ID=$chain_id"
    fi
  done
fi
ANCHOR_SECRET_SET=""
if secret_has_enabled_version vox-anchor-secret; then
  ANCHOR_SECRET_SET="VOX_ANCHOR_SECRET_KEY=vox-anchor-secret:latest"
elif [[ "$ANCHOR_MODE" != "disabled" ]]; then
  echo "Secret vox-anchor-secret must have an enabled version when VOX_ANCHOR_MODE=$ANCHOR_MODE." >&2
  exit 2
else
  echo "Warning: vox-anchor-secret has no enabled version; anchoring remains disabled." >&2
fi

# Every command names the verified project and region. This script is preparation
# only; do not run it without explicit deployment approval and owner-approved
# bucket, secret, wallet, and budget settings.
if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  if ! MAINNET_TREASURY_SOL_BALANCE="$(VOX_REALIZE_MAINNET_RPC_URL="$MAINNET_RPC_URL" VOX_REALIZE_MAINNET_TREASURY_OWNER="$MAINNET_TREASURY_OWNER" node --input-type=module -e '
    import {Connection, PublicKey} from "@solana/web3.js";
    try {
      const connection = new Connection(process.env.VOX_REALIZE_MAINNET_RPC_URL, "finalized");
      const genesisHash = await connection.getGenesisHash();
      if (genesisHash !== "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") process.exit(2);
      const balance = await connection.getBalance(new PublicKey(process.env.VOX_REALIZE_MAINNET_TREASURY_OWNER), "finalized");
      process.stdout.write(String(balance));
    } catch {
      process.exit(2);
    }
  ')"; then
    echo "Could not verify the Mainnet treasury SOL reserve; refusing to enable Realize Mainnet." >&2
    exit 2
  fi
  if [[ ! "$MAINNET_TREASURY_SOL_BALANCE" =~ ^[0-9]+$ ]] || (( MAINNET_TREASURY_SOL_BALANCE < 5000000 )); then
    echo "Realize Mainnet requires at least 0.005 SOL in the treasury for settlement and refund fees before checkout is enabled." >&2
    exit 2
  fi
fi
gcloud services enable run.googleapis.com firestore.googleapis.com storage.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com --project="$PROJECT_ID"
if ! gcloud firestore databases describe --database="(default)" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native --project="$PROJECT_ID"
fi
INDEX_COUNT="$(node -e 'const c=require("./infrastructure/gcp/firestore.indexes.json"); process.stdout.write(String(c.indexes.length))')"
for ((index = 0; index < INDEX_COUNT; index += 1)); do
  collection_group="$(INDEX_INDEX="$index" node -e 'const c=require("./infrastructure/gcp/firestore.indexes.json").indexes[Number(process.env.INDEX_INDEX)]; process.stdout.write(c.collectionGroup)')"
  field_count="$(INDEX_INDEX="$index" node -e 'const c=require("./infrastructure/gcp/firestore.indexes.json").indexes[Number(process.env.INDEX_INDEX)]; process.stdout.write(String(c.fields.length))')"
  field_args=()
  for ((field = 0; field < field_count; field += 1)); do
    field_config="$(INDEX_INDEX="$index" FIELD_INDEX="$field" node -e 'const f=require("./infrastructure/gcp/firestore.indexes.json").indexes[Number(process.env.INDEX_INDEX)].fields[Number(process.env.FIELD_INDEX)]; process.stdout.write(f.order ? `field-path=${f.fieldPath},order=${f.order.toLowerCase()}` : `field-path=${f.fieldPath},array-config=${f.arrayConfig.toLowerCase()}`)')"
    field_args+=(--field-config="$field_config")
  done
  INDEX_OUTPUT="$(gcloud firestore indexes composite create --collection-group="$collection_group" --database="(default)" --project="$PROJECT_ID" "${field_args[@]}" 2>&1)" || {
    if [[ "$INDEX_OUTPUT" != *"already exists"* && "$INDEX_OUTPUT" != *"ALREADY_EXISTS"* ]]; then
      echo "$INDEX_OUTPUT" >&2
      exit 1
    fi
  }
done
INDEX_READY_TIMEOUT_SECONDS="${VOX_INDEX_READY_TIMEOUT_SECONDS:-900}"
INDEX_DEADLINE="$(( $(date +%s) + INDEX_READY_TIMEOUT_SECONDS ))"
while true; do
  INDEX_STATE="$(gcloud firestore indexes composite list --database="(default)" --project="$PROJECT_ID" --format=json)"
  INDEX_READINESS="$(INDEX_STATE="$INDEX_STATE" node -e 'const wanted=require("./infrastructure/gcp/firestore.indexes.json").indexes; const raw=JSON.parse(process.env.INDEX_STATE || "[]"); const actual=Array.isArray(raw) ? raw : raw.indexes || []; const ready=actual.filter((index) => index.state === "READY"); const matches=(expected) => ready.some((index) => { const collectionGroup=index.collectionGroup || index.name?.match(/collectionGroups\/([^/]+)/)?.[1]; return collectionGroup === expected.collectionGroup && expected.fields.every((field) => index.fields.some((candidate) => candidate.fieldPath === field.fieldPath && (field.order ? candidate.order === field.order : candidate.arrayConfig === field.arrayConfig))); }); process.stdout.write(wanted.every(matches) ? "ready" : "pending");')"
  if [[ "$INDEX_READINESS" == "ready" ]]; then
    break
  fi
  if (( $(date +%s) >= INDEX_DEADLINE )); then
    echo "Timed out waiting for Firestore composite indexes to reach READY." >&2
    exit 1
  fi
  sleep 5
done
if ! gcloud storage buckets describe "gs://$BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --project="$PROJECT_ID"
fi
gcloud storage buckets update "gs://$BUCKET" --versioning --lifecycle-file=infrastructure/gcp/manifest-bucket-lifecycle.json --project="$PROJECT_ID"
if ! gcloud storage buckets describe "gs://$AVATAR_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$AVATAR_BUCKET" --location="$REGION" --uniform-bucket-level-access --pap --project="$PROJECT_ID"
else
  gcloud storage buckets update "gs://$AVATAR_BUCKET" --uniform-bucket-level-access --pap --project="$PROJECT_ID"
fi
if ! gcloud tasks queues describe "$TASK_QUEUE" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud tasks queues create "$TASK_QUEUE" --location="$REGION" --max-concurrent-dispatches=2 --max-dispatches-per-second=0.2 --max-attempts=8 --project="$PROJECT_ID"
else
  gcloud tasks queues update "$TASK_QUEUE" --location="$REGION" --max-concurrent-dispatches=2 --max-dispatches-per-second=0.2 --max-attempts=8 --project="$PROJECT_ID"
fi
if ! gcloud artifacts repositories describe vox --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create vox --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
fi

for account in vox-api vox-realize-settlement vox-realize-reconcile vox-anchor vox-tasks vox-scheduler; do
  if ! gcloud iam service-accounts describe "$account@$PROJECT_ID.iam.gserviceaccount.com" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$account" --display-name="VOX $account" --project="$PROJECT_ID"
  fi
done

# Runtime permissions contain no credential values; secret payloads are supplied
# separately through Secret Manager by the owner.
gcloud projects add-iam-policy-binding "$PROJECT_ID" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/datastore.user" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/cloudtasks.enqueuer" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$TASKS_SA" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/iam.serviceAccountUser" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project="$PROJECT_ID" --member="serviceAccount:$ANCHOR_SA" --role="roles/storage.objectCreator" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$AVATAR_BUCKET" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/storage.objectCreator" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://$AVATAR_BUCKET" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/storage.objectViewer" >/dev/null

for secret in "${API_SECRET_NAMES[@]}"; do
  gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT_ID" --member="serviceAccount:$API_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
done
gcloud secrets add-iam-policy-binding vox-internal-token --project="$PROJECT_ID" --member="serviceAccount:$ANCHOR_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --project="$PROJECT_ID" --member="serviceAccount:$SETTLEMENT_SA" --role="roles/datastore.user" >/dev/null
  gcloud secrets add-iam-policy-binding "$SETTLEMENT_TOKEN_SECRET" --project="$PROJECT_ID" --member="serviceAccount:$SETTLEMENT_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
  gcloud secrets add-iam-policy-binding "$MAINNET_TREASURY_KEY_SECRET" --project="$PROJECT_ID" --member="serviceAccount:$SETTLEMENT_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
  gcloud secrets add-iam-policy-binding vox-internal-token --project="$PROJECT_ID" --member="serviceAccount:$RECONCILE_JOB_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
fi
if [[ -n "$ANCHOR_SECRET_SET" ]]; then
  gcloud secrets add-iam-policy-binding vox-anchor-secret --project="$PROJECT_ID" --member="serviceAccount:$ANCHOR_SA" --role="roles/secretmanager.secretAccessor" >/dev/null
fi
WORKER_SECRETS="VOX_INTERNAL_TOKEN=vox-internal-token:latest"
if [[ -n "$ANCHOR_SECRET_SET" ]]; then
  WORKER_SECRETS="$WORKER_SECRETS,$ANCHOR_SECRET_SET"
fi

IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/vox/vox-api:$(date +%Y%m%d%H%M%S)"
gcloud builds submit --project="$PROJECT_ID" --config=infrastructure/gcp/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE,_VITE_API_URL=$WEB_API_URL,_VITE_REALIZE_DEVNET_ENABLED=$REALIZE_DEVNET_ENABLED,_VITE_REALIZE_MAINNET_ENABLED=$REALIZE_MAINNET_ENABLED,_VITE_SOLANA_CLUSTER=$WEB_PAYMENT_CLUSTER,_VITE_SOLANA_RPC_URL=$WEB_SOLANA_RPC_URL" .

if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  MAINNET_TREASURY_KEY_PATH="/run/secrets/vox-realize-mainnet/treasury/keypair.json"
  gcloud run deploy vox-realize-settlement --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" --platform=managed --service-account="$SETTLEMENT_SA" --min-instances=0 --max-instances=1 --concurrency=1 --cpu=1 --memory=512Mi --timeout=300 --port=8080 --allow-unauthenticated --command=node --args=apps/settlement/dist/server.js --set-env-vars="^|^GOOGLE_CLOUD_PROJECT=$PROJECT_ID|VOX_FIRESTORE_DATABASE=(default)|VOX_REALIZE_MAINNET_RPC_URL=$MAINNET_RPC_URL|VOX_REALIZE_MAINNET_USDC_MINT=$MAINNET_USDC_MINT|VOX_REALIZE_MAINNET_TREASURY_TOKEN_ACCOUNT=$MAINNET_TREASURY_TOKEN_ACCOUNT|VOX_REALIZE_MAINNET_TREASURY_OWNER=$MAINNET_TREASURY_OWNER|VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC=$MAINNET_MAX_PAYMENT|VOX_REALIZE_TREASURY_KEYPAIR_PATH=$MAINNET_TREASURY_KEY_PATH" --set-secrets="VOX_REALIZE_SETTLEMENT_TOKEN=$SETTLEMENT_TOKEN_SECRET:latest,$MAINNET_TREASURY_KEY_PATH=$MAINNET_TREASURY_KEY_SECRET:latest"
  SETTLEMENT_URL="$(gcloud run services describe vox-realize-settlement --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
  if [[ "$SETTLEMENT_URL" != https://*.run.app ]]; then
    echo "The Mainnet settlement service did not return its expected HTTPS Cloud Run URL." >&2
    exit 2
  fi
  API_REALIZE_ENV="$API_REALIZE_ENV|VOX_REALIZE_SETTLEMENT_URL=$SETTLEMENT_URL"
fi

# Bootstrap the API so the worker can receive its stable API URL. The second API
# deployment below adds the worker URL after the worker service is created.
gcloud run deploy "$SERVICE" --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" --platform=managed --port=8080 --service-account="$API_SA" --min-instances=0 --max-instances=5 --concurrency=40 --cpu=1 --memory=512Mi --allow-unauthenticated --set-env-vars="^|^GOOGLE_CLOUD_PROJECT=$PROJECT_ID|VOX_STORAGE=firestore|VOX_FIRESTORE_DATABASE=(default)|VOX_GCS_BUCKET=$BUCKET|VOX_AVATAR_BUCKET=$AVATAR_BUCKET$PAYMENT_ENV$API_REALIZE_ENV$API_NFT_ENV$PUBLIC_BASE_ENV|VOX_INSTANCE_ID=$INSTANCE_ID|VOX_ANCHOR_MODE=$ANCHOR_MODE|SOLANA_RPC_URL=$SOLANA_RPC_URL|VOX_CORS_ORIGIN=$CORS_ORIGINS|VOX_TASKS_LOCATION=$REGION|VOX_TASKS_QUEUE=$TASK_QUEUE|VOX_TASKS_SERVICE_ACCOUNT=$TASKS_SA" --set-secrets="$API_SECRETS"
API_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
if [[ "$DEPLOYMENT_ENV" == "staging" && -z "${VOX_PUBLIC_BASE_URL:-}" ]]; then
  # Populi callbacks need a reachable VOX origin. The Cloud Run URL is only
  # available after the bootstrap deployment, so pin it on the final revision.
  PUBLIC_BASE_ENV="|VOX_PUBLIC_BASE_URL=$API_URL"
fi

# Cloud Run IAM protects this endpoint. The worker process uses iam mode and
# does not accept the internal API token as an inbound worker credential.
gcloud run deploy "$ANCHOR_SERVICE" --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" --platform=managed --service-account="$ANCHOR_SA" --min-instances=0 --max-instances=1 --concurrency=1 --cpu=1 --memory=512Mi --timeout=900 --port=8080 --no-allow-unauthenticated --command=node --args=workers/anchor/dist/server.js --set-env-vars="^|^GOOGLE_CLOUD_PROJECT=$PROJECT_ID|VOX_API_URL=$API_URL|VOX_GCS_BUCKET=$BUCKET|VOX_ANCHOR_MODE=$ANCHOR_MODE|VOX_ANCHOR_AUTHORITY_ID=vox:anchor:vox.blog|VOX_ANCHOR_WORKER_ID=$ANCHOR_SERVICE|VOX_WORKER_AUTH_MODE=iam|VOX_ANCHOR_LEASE_SECONDS=300|SOLANA_RPC_URL=$SOLANA_RPC_URL" --set-secrets="$WORKER_SECRETS"
WORKER_BASE_URL="$(gcloud run services describe "$ANCHOR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')"
WORKER_URL="$WORKER_BASE_URL/run"

# Both Cloud Tasks and Scheduler receive a Google-signed OIDC token whose
# audience is the worker service URL (without the /run path).
gcloud run services add-iam-policy-binding "$ANCHOR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --member="serviceAccount:$TASKS_SA" --role="roles/run.invoker" >/dev/null
gcloud run services add-iam-policy-binding "$ANCHOR_SERVICE" --region="$REGION" --project="$PROJECT_ID" --member="serviceAccount:$SCHEDULER_SA" --role="roles/run.invoker" >/dev/null

# Redeploy the API with the now-known worker URL so publication tasks use the
# same IAM/OIDC path as Scheduler.
gcloud run deploy "$SERVICE" --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" --platform=managed --port=8080 --service-account="$API_SA" --min-instances=0 --max-instances=5 --concurrency=40 --cpu=1 --memory=512Mi --allow-unauthenticated --set-env-vars="^|^GOOGLE_CLOUD_PROJECT=$PROJECT_ID|VOX_STORAGE=firestore|VOX_FIRESTORE_DATABASE=(default)|VOX_GCS_BUCKET=$BUCKET|VOX_AVATAR_BUCKET=$AVATAR_BUCKET$PAYMENT_ENV$API_REALIZE_ENV$API_NFT_ENV$PUBLIC_BASE_ENV|VOX_INSTANCE_ID=$INSTANCE_ID|VOX_ANCHOR_MODE=$ANCHOR_MODE|SOLANA_RPC_URL=$SOLANA_RPC_URL|VOX_CORS_ORIGIN=$CORS_ORIGINS|VOX_TASKS_LOCATION=$REGION|VOX_TASKS_QUEUE=$TASK_QUEUE|VOX_TASKS_SERVICE_ACCOUNT=$TASKS_SA|VOX_ANCHOR_WORKER_URL=$WORKER_URL|VOX_ANCHOR_WORKER_AUDIENCE=$WORKER_BASE_URL" --set-secrets="$API_SECRETS"

if [[ "$REALIZE_MAINNET_ENABLED" == "true" ]]; then
  gcloud run jobs deploy vox-realize-reconcile --image="$IMAGE" --region="$REGION" --project="$PROJECT_ID" --service-account="$RECONCILE_JOB_SA" --tasks=1 --parallelism=1 --max-retries=2 --task-timeout=300 --command=node --args=apps/api/dist/realize-reconcile-job.js --set-env-vars="VOX_API_URL=$API_URL,VOX_REALIZE_RECONCILE_LIMIT=10" --set-secrets="VOX_INTERNAL_TOKEN=vox-internal-token:latest"
  gcloud run jobs add-iam-policy-binding vox-realize-reconcile --region="$REGION" --project="$PROJECT_ID" --member="serviceAccount:$RECONCILE_SCHEDULER_SA" --role="roles/run.invoker" >/dev/null
  RECONCILE_JOB_URI="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/vox-realize-reconcile:run"
  RECONCILE_SCHEDULE_ARGS=(--location="$REGION" --project="$PROJECT_ID" --schedule="*/5 * * * *" --uri="$RECONCILE_JOB_URI" --http-method=POST --oauth-service-account-email="$RECONCILE_SCHEDULER_SA" --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" --message-body='{}')
  if gcloud scheduler jobs describe vox-realize-reconcile --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud scheduler jobs update http vox-realize-reconcile "${RECONCILE_SCHEDULE_ARGS[@]}" --update-headers="Content-Type=application/json"
  else
    gcloud scheduler jobs create http vox-realize-reconcile "${RECONCILE_SCHEDULE_ARGS[@]}" --headers="Content-Type=application/json"
  fi
fi

SCHEDULE_ARGS=(--location="$REGION" --schedule="17 0 * * *" --uri="$WORKER_URL" --http-method=POST --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$WORKER_BASE_URL" --project="$PROJECT_ID")
gcloud scheduler jobs update http vox-anchor-daily "${SCHEDULE_ARGS[@]}" 2>/dev/null || gcloud scheduler jobs create http vox-anchor-daily "${SCHEDULE_ARGS[@]}"

echo "API $SERVICE and IAM-protected worker $ANCHOR_SERVICE prepared in $PROJECT_ID/$REGION. Verify Cloud Run, Firestore, GCS, Tasks, Scheduler, secrets, and logs manually before any production traffic or chain anchoring."

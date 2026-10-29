import {execFileSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";
import {derivePublicKeyFromSecret, verifyHumanAccount} from "@vox/identity";
import {parseSecretKey, realizeClientRequestSigningPayload, signBytes} from "@vox/protocol";
import {parseSecretJson} from "./secret-json.mjs";

const PROJECT_ID = "voxprotocol";
const API_ORIGIN = "https://vox.gold";
const OPERATOR_SECRET = "vox-realize-admin-human-identity";
const INTERNAL_TOKEN_SECRET = "vox-internal-token";
const usage = "Usage: npm run realize:approve-mainnet-refund -- --commission-id <id> --reason <explanation>";

type AdminHumanBundle = {
  format: "vox-human-identity/v1";
  registration: {human_id: string; identity_public_key: string};
  key_material: {identitySecretKey: string};
};

type RefundPreview = {
  commission: {commission_id: string; state: string; payment_state: string; fulfillment_state: string; resolution_outcome?: string; resolution_reason?: string; funding_timing_status?: string};
  quote: {quote_id: string; network_id: string; usdc_mint: string; canonical_quote_hash: string; total_amount_usdc_atomic: string};
  payment: {payment_intent_id: string; payer_wallet: string; funding_signature: string; amount_usdc_atomic: string};
  failure_evidence?: {source: string; status?: string; error_code?: string};
  settlement_status: string;
  settlement?: {status: string; settled_amount_usdc_atomic?: string; held_amount_usdc_atomic?: string; transaction_signatures?: string[]};
  refund_approval_exists: boolean;
};

function argument(name: string): string | undefined {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readSecret(name: string): string {
  try {
    return execFileSync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${PROJECT_ID}`], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  } catch {
    throw new Error(`Could not access Secret Manager entry ${name}; check gcloud authentication and project access.`);
  }
}

function usdc(atomic: string): string {
  if (!/^\d+$/.test(atomic)) return "unknown";
  const value = BigInt(atomic);
  const whole = (value / 1_000_000n).toString();
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${(fraction || "00").padEnd(2, "0")}`;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) { console.log(usage); return; }
  const commissionId = argument("--commission-id");
  const reason = argument("--reason")?.trim();
  if (!commissionId || !/^vox:commission:[^\s]{1,220}$/.test(commissionId) || !reason || reason.length < 10 || reason.length > 1_000) throw new Error(usage);
  if (process.argv.slice(2).some((value) => value.startsWith("--") && !["--commission-id", "--reason"].includes(value))) throw new Error(usage);
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Run this command in an interactive terminal so a person can confirm the exact refund.");

  let internalToken = "";
  let bundle: AdminHumanBundle | undefined;
  let secretKey: Uint8Array | undefined;
  try {
    internalToken = readSecret(INTERNAL_TOKEN_SECRET);
    bundle = parseSecretJson(readSecret(OPERATOR_SECRET), "Stored VOX Admin identity") as AdminHumanBundle;
    if (bundle.format !== "vox-human-identity/v1" || !bundle.registration?.human_id || !bundle.registration.identity_public_key || !bundle.key_material?.identitySecretKey || !verifyHumanAccount(bundle.registration as never) || derivePublicKeyFromSecret(bundle.key_material.identitySecretKey) !== bundle.registration.identity_public_key) {
      throw new Error("The stored VOX Admin identity failed its registration or key-pair check.");
    }
    const operatorHumanId = bundle.registration.human_id;
    secretKey = parseSecretKey(bundle.key_material.identitySecretKey);

    async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
      const issued_at = new Date().toISOString();
      const signature = signBytes(realizeClientRequestSigningPayload({method, path, principal_id: operatorHumanId, issued_at, ...(body === undefined ? {} : {body})}), secretKey!);
      const response = await fetch(`${API_ORIGIN}${path}`, {
        method,
        headers: {"content-type": "application/json", "x-vox-internal-token": internalToken, "x-vox-realize-human-id": operatorHumanId, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signature},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: AbortSignal.timeout(30_000)
      });
      const result = await response.json().catch(() => ({})) as {code?: string; error?: string} & T;
      if (!response.ok) throw new Error(`VOX returned HTTP ${response.status} (${result.code ?? "request_failed"}): ${result.error ?? "request failed"}`);
      return result;
    }

    const path = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/refund-preview`;
    const preview = await request<RefundPreview>("GET", path);
    if (preview.commission.commission_id !== commissionId || preview.quote.network_id !== "solana:mainnet-beta" || !["captured", "refund_pending"].includes(preview.commission.payment_state) || !["REFUND_PENDING", "MANUAL_REVIEW"].includes(preview.commission.state)) throw new Error("VOX did not return an eligible unresolved Mainnet refund preview.");
    if (preview.refund_approval_exists) throw new Error("An operator approval is already recorded for this commission; use reconciliation to check its outcome.");

    console.log(`Commission: ${preview.commission.commission_id}`);
    console.log(`State: ${preview.commission.state} · ${preview.commission.payment_state} · ${preview.commission.fulfillment_state}`);
    console.log(`Resolution: ${preview.commission.resolution_reason ?? "unresolved"}${preview.commission.funding_timing_status ? ` · payment timing ${preview.commission.funding_timing_status}` : ""}`);
    console.log(`Refund amount: ${usdc(preview.payment.amount_usdc_atomic)} USDC`);
    console.log(`Payer wallet: ${preview.payment.payer_wallet}`);
    console.log(`Funding transaction: ${preview.payment.funding_signature}`);
    console.log(`Accepted quote: ${preview.quote.quote_id} · ${preview.quote.canonical_quote_hash}`);
    console.log(`Settlement: ${preview.settlement_status}${preview.settlement ? ` · paid ${usdc(preview.settlement.settled_amount_usdc_atomic ?? "0")} USDC · held ${usdc(preview.settlement.held_amount_usdc_atomic ?? "0")} USDC · ${preview.settlement.transaction_signatures?.length ?? 0} transactions` : ""}`);
    if (preview.failure_evidence) console.log(`Failure evidence: ${preview.failure_evidence.source}${preview.failure_evidence.status ? ` · ${preview.failure_evidence.status}` : ""}${preview.failure_evidence.error_code ? ` · ${preview.failure_evidence.error_code}` : ""}`);
    console.log(`Reason: ${reason}`);

    const confirmation = createInterface({input: stdin, output: stdout});
    const typed = await confirmation.question(`\nTo send this exact refund approval, type REFUND ${commissionId}: `);
    confirmation.close();
    if (typed.trim() !== `REFUND ${commissionId}`) { console.log("No refund approval was submitted."); return; }

    const approvalPath = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/refund-approval`;
    const approvalBody = {
      payer_wallet: preview.payment.payer_wallet,
      funding_signature: preview.payment.funding_signature,
      payment_intent_id: preview.payment.payment_intent_id,
      accepted_quote_hash: preview.quote.canonical_quote_hash,
      amount_usdc_atomic: preview.payment.amount_usdc_atomic,
      reason
    };
    const result = await request<{commission: {state: string}; resolution_outcome?: string; refund_response?: {status?: string; transaction_signature?: string}}>("POST", approvalPath, approvalBody);
    console.log(`Refund approval recorded. Commission state: ${result.commission.state}; outcome: ${result.resolution_outcome ?? "pending"}; refund status: ${result.refund_response?.status ?? "pending"}.`);
    if (result.refund_response?.transaction_signature) console.log(`Refund transaction: ${result.refund_response.transaction_signature}`);
  } finally {
    secretKey?.fill(0);
    if (bundle) bundle.key_material.identitySecretKey = "";
    internalToken = "";
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Mainnet refund approval failed.");
  process.exitCode = 1;
});

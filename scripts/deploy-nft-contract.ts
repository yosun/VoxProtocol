/** Monad collection replacement: explicit read-only plan; offline signature and exact approval are required to broadcast. */
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {compileBinding, MONAD, planHash, preflightApply, prepareMigration, validateManifest, validatePlan, validateSignedTransaction, verifyDeployment, decimal, type MigrationPlan, type Rpc} from "./lib/nft-contract-migration.js";
import {persistSubmission, submitJournaledTransaction, writeNewJson, type SubmissionJournal} from "./lib/nft-migration-journal.js";

function usage(): never {
  throw new Error("Usage: tsx scripts/deploy-nft-contract.ts plan --rpc <https-url> --plan <new.json> --max-gas <integer> --max-fee-per-gas-wei <integer> --max-priority-fee-per-gas-wei <integer> --max-total-fee-wei <integer> --minimum-remaining-balance-wei <integer> [--confirmations 12] [--lifetime-seconds 900]\napply --rpc <https-url> --plan <json> --approve-plan-sha256 <digest> --signed-transaction <public-raw-hex-file> --journal <new-or-matching.json>\nverify --rpc <https-url> --plan <json> --journal <json>\nNo private key is accepted. No command changes production configuration or existing NFTs.");
}
const mode = process.argv[2];
if (mode !== "plan" && mode !== "apply" && mode !== "verify") usage();
const args = new Map<string, string>();
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index]!; const value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || value.startsWith("--") || args.has(key)) usage();
  args.set(key, value);
}
const common = ["--rpc", "--plan"];
const modeArgs = mode === "plan" ? ["--max-gas", "--max-fee-per-gas-wei", "--max-priority-fee-per-gas-wei", "--max-total-fee-wei", "--minimum-remaining-balance-wei", "--confirmations", "--lifetime-seconds"] : mode === "apply" ? ["--approve-plan-sha256", "--signed-transaction", "--journal"] : ["--journal"];
for (const key of args.keys()) if (![...common, ...modeArgs].includes(key)) usage();
function required(name: string): string { const value = args.get(name); if (!value) usage(); return value; }
const rpcUrl = new URL(required("--rpc"));
if (rpcUrl.protocol !== "https:" || rpcUrl.username || rpcUrl.password || rpcUrl.search || rpcUrl.hash) throw new Error("RPC must be a clean HTTPS URL without credentials or query parameters");
let requestId = 0;
const rpc: Rpc = async (method, params) => {
  const id = ++requestId;
  const response = await fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id, method, params}), signal: AbortSignal.timeout(20_000), redirect: "error"});
  if (!response.ok) throw new Error(`RPC ${method} returned HTTP ${response.status}`);
  const payload = await response.json() as {jsonrpc?: string; id?: number; result?: unknown; error?: unknown};
  if (payload.jsonrpc !== "2.0" || payload.id !== id || payload.error || !("result" in payload)) throw new Error(`RPC ${method} returned an invalid/error response`);
  return payload.result;
};
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "contracts/VoxMediaNFT.sol", "deployments/nft-mainnet.json"], {cwd: root, stdio: "pipe"});
const manifestSha = validateManifest(readFileSync(resolve(root, "deployments/nft-mainnet.json"), "utf8"));
// Rebuild in a fresh directory so a stale or hand-edited cached artifact cannot be approved or applied.
const scratch = mkdtempSync(resolve(tmpdir(), "vox-nft-migration-"));
let compiled;
try {
  execFileSync("forge", ["build", "--root", root, "--contracts", "contracts", "--use", "0.8.33", "--evm-version", "cancun", "--out", resolve(scratch, "out"), "--cache-path", resolve(scratch, "cache"), "--offline", "--force"], {cwd: root, stdio: "pipe"});
  compiled = compileBinding(readFileSync(resolve(root, "contracts/VoxMediaNFT.sol"), "utf8"), JSON.parse(readFileSync(resolve(scratch, "out/VoxMediaNFT.sol/VoxMediaNFT.json"), "utf8")));
} finally { rmSync(scratch, {recursive: true, force: true}); }
const planPath = resolve(required("--plan"));
if (mode === "plan") {
  const plan = await prepareMigration(rpc, compiled, manifestSha, sourceCommit, {
    gasCap: decimal(required("--max-gas"), "gas cap"),
    maxFeePerGas: decimal(required("--max-fee-per-gas-wei"), "max fee"),
    maxPriorityFeePerGas: decimal(required("--max-priority-fee-per-gas-wei"), "priority fee"),
    maxTotalFee: decimal(required("--max-total-fee-wei"), "total fee"),
    minimumRemainingBalance: decimal(required("--minimum-remaining-balance-wei"), "reserve"),
    confirmations: Number(args.get("--confirmations") ?? "12"), lifetimeSeconds: Number(args.get("--lifetime-seconds") ?? "900"),
  });
  writeNewJson(planPath, plan);
  console.log(JSON.stringify({mode, plan_path: planPath, plan_sha256: plan.plan_sha256, chain: plan.chain, chain_id: plan.chain_id, existing_contract: plan.existing_contract, preserved_owner_and_minter: plan.preserved_owner, existing_next_token_id: plan.existing_next_token_id, predicted_contract: plan.predicted_contract, deployer: MONAD.owner, nonce: plan.transaction.nonce, value_native_wei: "0", gas_estimate: plan.estimated_gas, gas_limit: plan.transaction.gas, maximum_fee_native_wei: (BigInt(plan.transaction.gas) * BigInt(plan.transaction.maxFeePerGas)).toString(), proposed_total_fee_cap_wei: plan.max_total_fee_wei, minimum_remaining_balance_wei: plan.minimum_remaining_balance_wei, signing_digest: plan.signing_digest, expires_at: plan.expires_at, source_sha256: plan.artifact.source_sha256, runtime_sha256: plan.artifact.runtime_sha256, status: "unsigned_read_only_plan_requires_owner_transaction_approval"}, null, 2));
} else {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as MigrationPlan;
  validatePlan(plan, compiled, manifestSha);
  const journalPath = resolve(required("--journal"));
  let journal: SubmissionJournal;
  if (mode === "apply") {
    if (required("--approve-plan-sha256") !== planHash(plan)) throw new Error("explicit approval must exactly match the reviewed plan SHA-256");
    const raw = readFileSync(resolve(required("--signed-transaction")), "utf8").trim().toLowerCase();
    const transactionHash = validateSignedTransaction(plan.transaction, MONAD.owner, raw);
    journal = {schema: "vox-nft-contract-submission-v1", plan_sha256: plan.plan_sha256, transaction_hash: transactionHash, signed_transaction: raw};
    // A conflicting journal stops even recovery; never silently replace evidence.
    if (existsSync(journalPath)) persistSubmission(journalPath, journal);
    await submitJournaledTransaction(rpc, journal, () => persistSubmission(journalPath, journal), () => preflightApply(rpc, plan));
  } else {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as typeof journal;
    if (journal.schema !== "vox-nft-contract-submission-v1" || journal.plan_sha256 !== plan.plan_sha256 || validateSignedTransaction(plan.transaction, MONAD.owner, journal.signed_transaction) !== journal.transaction_hash) throw new Error("journal does not match the reviewed plan and signed transaction");
  }
  const result = await verifyDeployment(rpc, plan, journal.transaction_hash, compiled);
  console.log(JSON.stringify({mode, plan_sha256: plan.plan_sha256, journal_path: journalPath, ...result, configuration_changed: false, historical_tokens_migrated: false}, null, 2));
  if (result.state !== "finalized") {
    console.error("Deployment is pending or lacks the required finalized-block depth. Keep the journal and run verify again; no success or cutover is implied.");
    process.exitCode = 2;
  }
}

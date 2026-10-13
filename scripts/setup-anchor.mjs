#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Keypair} from "@solana/web3.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANCHOR_SECRET = "vox-anchor-secret";
const KNOWN_PRODUCTION_BUCKET = "voxprotocol-manifests-588986823875";
const MODES = new Set(["devnet", "mainnet"]);

function usage() {
  console.log(`VOX anchor setup

Guided setup for the existing Cloud Run anchor worker.

Usage:
  npm run anchor:setup
  npm run anchor:setup -- --mode devnet --deploy
  npm run anchor:setup -- --mode mainnet --deploy --confirm-mainnet

Options:
  --mode devnet|mainnet       Chain to use (default: devnet)
  --bucket NAME               GCS manifest bucket name
  --rpc URL                   Solana RPC URL
  --keypair PATH              Existing Solana CLI keypair JSON; otherwise generate one
  --deploy                    Apply the guarded GCP deployment after preflight
  --confirm-mainnet           Required for any mainnet setup
  --allow-production-devnet   Explicitly allow Devnet on the configured production project
  --yes                       Skip non-mainnet confirmation prompts
  --dry-run                   Show the plan without contacting GCP or changing anything
  --help                      Show this help

The private key is streamed directly to Secret Manager and is never printed or written by this installer.`);
}

function parseArgs(argv) {
  const options = {
    mode: process.env.VOX_ANCHOR_MODE === "mainnet" ? "mainnet" : "devnet",
    bucket: process.env.VOX_GCS_BUCKET,
    rpc: process.env.VOX_SOLANA_RPC_URL,
    keypair: process.env.VOX_ANCHOR_KEYPAIR,
    deploy: false,
    confirmMainnet: false,
    allowProductionDevnet: false,
    yes: false,
    dryRun: false,
    configPath: process.env.VOX_GCP_PROJECT_CONFIG ?? ".kiro/gcp-project.json",
    deploymentEnv: process.env.VOX_DEPLOYMENT_ENV
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === "--help" || argument === "-h") return {...options, help: true};
    if (argument === "--mode") options.mode = next();
    else if (argument === "--bucket") options.bucket = next();
    else if (argument === "--rpc") options.rpc = next();
    else if (argument === "--keypair") options.keypair = next();
    else if (argument === "--config") options.configPath = next();
    else if (argument === "--deployment-env") options.deploymentEnv = next();
    else if (argument === "--deploy") options.deploy = true;
    else if (argument === "--confirm-mainnet") options.confirmMainnet = true;
    else if (argument === "--allow-production-devnet") options.allowProductionDevnet = true;
    else if (argument === "--yes") options.yes = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.help) return options;
  if (!MODES.has(options.mode)) throw new Error(`--mode must be devnet or mainnet, not ${options.mode}`);
  if (options.deploy && options.dryRun) throw new Error("--deploy and --dry-run cannot be used together");
  return options;
}

function commandAvailable(command) {
  const result = spawnSync("which", [command], {stdio: "ignore"});
  return result.status === 0;
}

function gcloudArgs(args, projectId) {
  return [...args, `--project=${projectId}`];
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function succeeds(command, args) {
  const result = spawnSync(command, args, {cwd: ROOT, stdio: "ignore"});
  return result.status === 0;
}

function runInteractive(command, args, env = process.env) {
  const result = spawnSync(command, args, {cwd: ROOT, env, stdio: "inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function streamSecretToGcloud(args, secretBytes) {
  const result = spawnSync("gcloud", args, {
    cwd: ROOT,
    input: Buffer.from(secretBytes),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`gcloud failed while storing the anchor secret${detail ? `: ${detail}` : ""}`);
  }
}

function interactive() {
  return Boolean(input.isTTY && output.isTTY);
}

async function ask(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function confirm(rl, question, defaultValue = false) {
  const answer = (await ask(rl, `${question} ${defaultValue ? "Y/n" : "y/N"}`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

async function promptStandalone(question, defaultValue = "") {
  if (!interactive()) throw new Error(`${question} requires an interactive terminal or an explicit command-line option`);
  const rl = createInterface({input, output});
  try {
    return await ask(rl, question, defaultValue);
  } finally {
    rl.close();
  }
}

async function readProjectConfig(configPath) {
  const absolutePath = resolve(ROOT, configPath);
  let raw;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    throw new Error(`Missing ${configPath}. Create it from .kiro/gcp-project.example.json only after verifying the target.`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`${configPath} is not valid JSON`);
  }
  for (const field of ["projectId", "region", "cloudRunService"]) {
    if (typeof config[field] !== "string" || !config[field]) throw new Error(`${configPath} must define ${field}`);
  }
  return {path: absolutePath, ...config, cloudRunAnchorService: config.cloudRunAnchorService ?? "vox-anchor-worker"};
}

function normalizeBucket(value) {
  return value.replace(/^gs:\/\//, "").replace(/\/+$/, "");
}

function validateBucket(value) {
  if (!value || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(value)) {
    throw new Error("Manifest bucket must be a valid GCS bucket name without the gs:// prefix");
  }
}

function defaultRpc(mode) {
  return mode === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
}

async function loadKeypair(path) {
  let raw;
  try {
    raw = JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
  } catch {
    throw new Error(`Could not read Solana keypair JSON at ${path}`);
  }
  if (!Array.isArray(raw)) throw new Error("Solana keypair JSON must contain an array of secret-key bytes");
  const bytes = Uint8Array.from(raw);
  if (bytes.length !== 64) throw new Error("Solana anchor keypair must contain exactly 64 secret-key bytes");
  return Keypair.fromSecretKey(bytes);
}

function secretExists(projectId) {
  return succeeds("gcloud", gcloudArgs(["secrets", "describe", ANCHOR_SECRET], projectId));
}

function enabledSecretVersion(projectId) {
  if (!secretExists(projectId)) return false;
  try {
    return Boolean(capture("gcloud", gcloudArgs(["secrets", "versions", "list", ANCHOR_SECRET, "--filter=state=ENABLED", "--format=value(name)", "--limit=1"], projectId)));
  } catch {
    return false;
  }
}

async function ensureAnchorSecret({projectId, options, rl}) {
  if (enabledSecretVersion(projectId)) {
    console.log(`✓ Secret Manager has an enabled ${ANCHOR_SECRET} version; no key rotation performed.`);
    console.log("  Use the custody record for that wallet's public address and fund it before anchoring.");
    return {created: false};
  }

  if (options.dryRun) {
    console.log(`! ${ANCHOR_SECRET} needs an enabled version.`);
    return {created: false};
  }

  let keypair;
  if (options.keypair) {
    keypair = await loadKeypair(options.keypair);
  } else {
    const shouldGenerate = options.yes || (rl ? await confirm(rl, "No enabled anchor key was found. Generate a new dedicated Solana keypair", options.mode === "devnet") : false);
    if (!shouldGenerate) throw new Error("No anchor key was supplied. Re-run with --keypair PATH, or use --yes from a controlled terminal to generate one.");
    keypair = Keypair.generate();
  }

  const publicKey = keypair.publicKey.toBase58();
  console.log(`\nAnchor wallet public address: ${publicKey}`);
  console.log("The private key will be streamed to Secret Manager and will not be printed or saved by this installer.");
  if (!options.yes && (!rl || !(await confirm(rl, "Store this key as vox-anchor-secret", false)))) {
    throw new Error("Anchor key was not stored");
  }

  if (!secretExists(projectId)) {
    runInteractive("gcloud", gcloudArgs(["secrets", "create", ANCHOR_SECRET, "--replication-policy=automatic"], projectId));
  }
  streamSecretToGcloud(gcloudArgs(["secrets", "versions", "add", ANCHOR_SECRET, "--data-file=-"], projectId), keypair.secretKey);
  console.log(`✓ Stored an enabled ${ANCHOR_SECRET} version.`);
  console.log(`  Fund ${publicKey} with ${options.mode === "mainnet" ? "mainnet SOL" : "Devnet SOL"} before the first worker run.`);
  return {created: true, publicKey};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const config = await readProjectConfig(options.configPath);
  const projectId = config.projectId;
  const mode = options.mode;
  const deploymentEnv = options.deploymentEnv ?? (mode === "mainnet" ? "production" : "staging");
  const rpc = options.rpc ?? defaultRpc(mode);
  const bucketDefault = options.bucket ?? process.env.VOX_GCS_BUCKET ?? (projectId === "voxprotocol" ? KNOWN_PRODUCTION_BUCKET : "");
  const bucket = normalizeBucket(bucketDefault || await promptStandalone("Manifest bucket name"));

  if (!bucket) throw new Error("Manifest bucket is required. Pass --bucket NAME or set VOX_GCS_BUCKET.");
  validateBucket(bucket);
  if (mode === "mainnet" && deploymentEnv !== "production") throw new Error("Mainnet anchoring requires VOX_DEPLOYMENT_ENV=production");
  let effectiveDeploymentEnv = deploymentEnv;
  if (mode === "devnet" && projectId === "voxprotocol" && deploymentEnv === "staging" && !options.allowProductionDevnet) {
    throw new Error("The configured production project cannot use the default staging/Devnet path. Point VOX_GCP_PROJECT_CONFIG at a verified staging project, or explicitly pass --allow-production-devnet after owner approval.");
  }
  if (mode === "devnet" && projectId === "voxprotocol" && deploymentEnv === "staging") {
    effectiveDeploymentEnv = "production";
    console.warn("Warning: explicitly allowing Devnet anchoring on the configured production GCP project.");
  }
  if (mode === "mainnet" && !options.confirmMainnet) {
    if (!interactive()) throw new Error("Mainnet setup requires --confirm-mainnet");
    const phrase = await promptStandalone("Type MAINNET to authorize mainnet wallet setup");
    if (phrase !== "MAINNET") throw new Error("Mainnet confirmation did not match");
  }

  console.log(`\nVOX anchor setup\n  Project:  ${projectId}\n  Region:   ${config.region}\n  API:      ${config.cloudRunService}\n  Worker:   ${config.cloudRunAnchorService}\n  Mode:     ${mode}\n  RPC:      ${rpc}\n  Bucket:   gs://${bucket}\n  Deploy:   ${options.deploy ? "yes" : "no"}`);

  if (options.dryRun) {
    console.log("\nDry run complete. No GCP calls, secrets, or deployments were changed.");
    return;
  }
  if (!commandAvailable("gcloud")) throw new Error("gcloud CLI is required. Install it and authenticate before rerunning.");

  try {
    capture("gcloud", gcloudArgs(["projects", "describe", projectId, "--format=value(projectId)"], projectId));
  } catch {
    throw new Error(`Cannot access GCP project ${projectId}. Run gcloud auth login and verify your IAM access.`);
  }

  for (const requiredSecret of ["vox-instance-secret", "vox-internal-token"]) {
    if (!succeeds("gcloud", gcloudArgs(["secrets", "describe", requiredSecret], projectId))) {
      throw new Error(`Required Secret Manager secret ${requiredSecret} is missing. Provision it before running the anchor installer.`);
    }
  }
  console.log("✓ GCP project and required existing secrets are reachable.");

  const rl = interactive() ? createInterface({input, output}) : null;
  try {
    await ensureAnchorSecret({projectId, options, rl});
    if (!options.deploy) {
      if (interactive() && await confirm(rl, "Deploy the configured anchor worker and API now", false)) options.deploy = true;
      else {
        console.log("\nSecret setup is complete. No Cloud Run deployment was performed.");
        console.log("Re-run with --deploy when the wallet is funded and the deployment is approved.");
        return;
      }
    }
    if (!options.yes) {
      if (!rl) throw new Error("Non-interactive deployment requires --yes");
      if (!(await confirm(rl, `Deploy ${mode} anchoring to ${projectId}/${config.region}`, false))) {
        throw new Error("Deployment cancelled");
      }
    }
  } finally {
    rl?.close();
  }

  const deployEnv = {
    ...process.env,
    VOX_GCP_PROJECT_CONFIG: config.path,
    VOX_DEPLOYMENT_ENV: effectiveDeploymentEnv,
    VOX_ANCHOR_MODE: mode,
    VOX_SOLANA_RPC_URL: rpc,
    VOX_GCS_BUCKET: bucket
  };
  console.log("\nRunning the repository's guarded deployment script...\n");
  runInteractive("bash", [resolve(ROOT, "infrastructure/gcp/deploy.sh")], deployEnv);

  const apiUrl = capture("gcloud", gcloudArgs(["run", "services", "describe", config.cloudRunService, `--region=${config.region}`, "--format=value(status.url)"], projectId));
  const workerUrl = capture("gcloud", gcloudArgs(["run", "services", "describe", config.cloudRunAnchorService, `--region=${config.region}`, "--format=value(status.url)"], projectId));
  console.log(`\nSetup complete.
  API:    ${apiUrl}
  Worker: ${workerUrl}/run

Next:
  1. Publish one Bob thought:
     VOX_API_URL=${apiUrl} BOB_THOUGHT="installer smoke test" npm run bob:publish
  2. Read the returned post_id and fetch:
     curl ${apiUrl}/v1/posts/<post_id>/proof
  3. Confirm bundle.anchor.transaction_signature exists and matches the ${mode} Solana explorer.

The installer did not publish a post automatically.`);
}

main().catch((error) => {
  console.error(`\nAnchor setup stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

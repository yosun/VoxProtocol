import {Storage} from "@google-cloud/storage";
import {buildMerkleBatch} from "@vox/merkle";
import {encodeCommitment, epochReferenceHash, inspectCommitment, receiptFromSubmission, SolanaSubmissionUncertainError, submitCommitment} from "@vox/solana";
import type {AnchorReceiptV1, BatchManifestV1} from "@vox/protocol";

interface CandidatePost {
  post_id: string;
  intent: {agent_id: string};
  post_hash: string;
  envelope_hash: string;
  envelope: {sequence: number};
  anchoring: {tier: "free" | "premium" | "premium_plus" | "custom"; attempts: number};
}
interface AnchorClaim {
  claim_id: string;
  batch_id: string;
  kind: "BATCH" | "POST";
  authority_id: string;
  epoch: string;
  tier: "all" | "free" | "premium" | "premium_plus" | "custom";
  owner_id: string;
  post_ids: string[];
  state: "claimed" | "manifested" | "submitting" | "uncertain" | "submitted" | "finalized" | "retryable_failure";
  manifest_created_at: string;
  attempts: number;
  transaction_signature?: string;
}
interface AnchorBatch {
  manifest: BatchManifestV1;
  receipt?: AnchorReceiptV1;
  manifest_uri?: string;
}
interface AnchorClaimResponse {claim: AnchorClaim; posts: CandidatePost[]; batch?: AnchorBatch}
interface UncertainResponse {claims: AnchorClaimResponse[]}
type RunTier = "all" | "free" | "premium" | "premium_plus" | "custom";

const apiUrl = (process.env.VOX_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const internalHeaders = process.env.VOX_INTERNAL_TOKEN ? {"x-vox-internal-token": process.env.VOX_INTERNAL_TOKEN} : {};
const workerId = process.env.VOX_ANCHOR_WORKER_ID ?? process.env.K_REVISION ?? "vox-anchor-worker";
const authorityId = process.env.VOX_ANCHOR_AUTHORITY_ID ?? "vox:anchor:vox.blog";
const leaseSeconds = Math.min(Math.max(Number.parseInt(process.env.VOX_ANCHOR_LEASE_SECONDS ?? "300", 10) || 300, 30), 900);

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {headers: {"content-type": "application/json", ...internalHeaders, ...(init?.headers ?? {})}, ...init});
  const body = await response.json() as T & {error?: string};
  if (!response.ok) throw new Error(body.error ?? `API error ${response.status}`);
  return body;
}

async function saveManifestToGcs(manifest: BatchManifestV1): Promise<string | undefined> {
  const bucketName = process.env.VOX_GCS_BUCKET;
  if (!bucketName) return undefined;
  const storage = new Storage(process.env.GOOGLE_CLOUD_PROJECT ? {projectId: process.env.GOOGLE_CLOUD_PROJECT} : {});
  const objectName = `vox/manifests/${manifest.manifest_hash}.json`;
  const file = storage.bucket(bucketName).file(objectName);
  try {
    await file.save(JSON.stringify(manifest), {resumable: false, validation: "crc32c", contentType: "application/json", preconditionOpts: {ifGenerationMatch: 0}});
  } catch (error) {
    if ((error as {code?: number}).code !== 412) throw error;
  }
  return `gs://${bucketName}/${objectName}`;
}

function currentEpoch(tier: RunTier): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return tier === "premium" || tier === "premium_plus" ? `${date}T${now.toISOString().slice(11, 13)}Z` : `${date}Z`;
}

function recordsFor(post: CandidatePost) {
  return {post_id: post.post_id, agent_id: post.intent.agent_id, sequence: post.envelope.sequence, post_hash: post.post_hash, envelope_hash: post.envelope_hash};
}

function commitmentFor(claim: AnchorClaim, posts: CandidatePost[], manifest: BatchManifestV1) {
  return claim.kind === "BATCH"
    ? {type: "BATCH" as const, authority_id: claim.authority_id, reference_hash: epochReferenceHash(manifest.epoch), root_or_post_hash: manifest.root, manifest_hash: manifest.manifest_hash}
    : {type: "POST" as const, authority_id: claim.authority_id, reference_hash: posts[0]!.post_hash, root_or_post_hash: posts[0]!.post_hash};
}

async function updateClaim(claimId: string, patch: Record<string, unknown>): Promise<AnchorClaimResponse> {
  return apiRequest<AnchorClaimResponse>(`/v1/internal/anchor/claims/${claimId}`, {method: "POST", body: JSON.stringify({owner_id: workerId, ...patch})});
}

interface ProcessedClaim {
  response: AnchorClaimResponse;
  manifest: BatchManifestV1;
  manifest_uri?: string;
  receipt?: AnchorReceiptV1;
}

async function processClaim(initial: AnchorClaimResponse, mode: string): Promise<ProcessedClaim> {
  let response = initial;
  const existingManifest = response.batch?.manifest;
  const manifest = existingManifest ?? buildMerkleBatch({
    authority_id: response.claim.authority_id,
    batch_id: response.claim.batch_id,
    epoch: response.claim.epoch,
    created_at: response.claim.manifest_created_at,
    records: response.posts.map(recordsFor)
  }).manifest;

  if (!existingManifest) response = await updateClaim(response.claim.claim_id, {state: "manifested", manifest});
  let manifestUri = response.batch?.manifest_uri;
  if (!manifestUri) {
    try {
      manifestUri = await saveManifestToGcs(manifest);
      if (manifestUri) response = await updateClaim(response.claim.claim_id, {state: "manifested", manifest_uri: manifestUri, lease_seconds: leaseSeconds});
    } catch (error) {
      await updateClaim(response.claim.claim_id, {state: "retryable_failure", error: error instanceof Error ? error.message : "manifest archive failed", next_attempt_at: new Date(Date.now() + 60_000).toISOString(), clear_lease: true}).catch(() => undefined);
      throw error;
    }
  }

  if (response.claim.state === "finalized" || response.claim.state === "submitted" || response.claim.state === "uncertain") {
    return {response, manifest, ...(manifestUri ? {manifest_uri: manifestUri} : {}), ...(response.batch?.receipt ? {receipt: response.batch.receipt} : {})};
  }
  if (mode === "disabled") return {response, manifest, ...(manifestUri ? {manifest_uri: manifestUri} : {})};
  if (mode !== "devnet" && mode !== "mainnet") throw new Error(`Unsupported VOX_ANCHOR_MODE: ${mode}`);
  const secretKey = process.env.VOX_ANCHOR_SECRET_KEY;
  if (!secretKey) throw new Error("VOX_ANCHOR_SECRET_KEY is required for Solana anchoring");

  const commitment = commitmentFor(response.claim, response.posts, manifest);
  response = await updateClaim(response.claim.claim_id, {state: "submitting", lease_seconds: leaseSeconds});
  const rpcUrl = process.env.SOLANA_RPC_URL ?? (mode === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
  try {
    const submission = await submitCommitment({rpc_url: rpcUrl, anchor_secret_key: secretKey, commitment, commitment_level: "confirmed"});
    const cluster = mode === "mainnet" ? "mainnet-beta" : "devnet";
    const receipt = receiptFromSubmission({commitment, signature: submission.signature, finalized: submission.finalized, payload_base64url: submission.payload_base64url, cluster});
    response = await updateClaim(response.claim.claim_id, {receipt, clear_lease: true});
    return {response, manifest, ...(manifestUri ? {manifest_uri: manifestUri} : {}), receipt};
  } catch (error) {
    const signature = error instanceof SolanaSubmissionUncertainError ? error.signature : undefined;
    response = await updateClaim(response.claim.claim_id, {state: "uncertain", ...(signature ? {transaction_signature: signature} : {}), error: error instanceof Error ? error.message : "Solana submission outcome is unknown", clear_lease: true});
    return {response, manifest, ...(manifestUri ? {manifest_uri: manifestUri} : {})};
  }
}

async function reconcileUncertainClaims(mode: string): Promise<void> {
  if (mode !== "devnet" && mode !== "mainnet") return;
  const rpcUrl = process.env.SOLANA_RPC_URL ?? (mode === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
  const uncertain = await apiRequest<UncertainResponse>("/v1/internal/anchor/uncertain?limit=50");
  for (const response of uncertain.claims) {
    const signature = response.claim.transaction_signature;
    const manifest = response.batch?.manifest;
    if (!signature || !manifest || response.posts.length === 0) continue;
    const commitment = commitmentFor(response.claim, response.posts, manifest);
    try {
      const inspection = await inspectCommitment(rpcUrl, signature, encodeCommitment(commitment));
      if (inspection.matches && inspection.payload_base64url) {
        const receipt = receiptFromSubmission({commitment, signature, finalized: inspection.finalized, payload_base64url: inspection.payload_base64url, cluster: mode === "mainnet" ? "mainnet-beta" : "devnet"});
        await updateClaim(response.claim.claim_id, {receipt, clear_lease: true});
      } else if (inspection.status === "failed") {
        await updateClaim(response.claim.claim_id, {state: "retryable_failure", error: "Solana transaction failed during reconciliation", next_attempt_at: new Date(Date.now() + 60_000).toISOString(), clear_lease: true});
      } else if (inspection.status === "finalized") {
        await updateClaim(response.claim.claim_id, {state: "uncertain", error: "Finalized transaction does not contain the expected VOX commitment", clear_lease: true});
      }
    } catch {
      // Keep the claim uncertain when the RPC cannot establish a safe outcome.
    }
  }
}

export interface AnchorRunResult {
  created: boolean;
  manifests?: BatchManifestV1[];
  receipts?: AnchorReceiptV1[];
  manifest_uris?: string[];
  uncertain_claim_ids?: string[];
}

/** Runs one bounded policy slice with durable claims and immutable manifests. */
export async function runAnchorOnce(): Promise<AnchorRunResult> {
  const runTier = (process.env.VOX_ANCHOR_RUN_TIER ?? "all") as RunTier;
  if (!["all", "free", "premium", "premium_plus", "custom"].includes(runTier)) throw new Error(`Unsupported VOX_ANCHOR_RUN_TIER: ${runTier}`);
  const mode = process.env.VOX_ANCHOR_MODE ?? "disabled";
  await reconcileUncertainClaims(mode);
  const epoch = process.env.VOX_ANCHOR_EPOCH ?? currentEpoch(runTier);
  const limit = Math.min(Math.max(Number.parseInt(process.env.VOX_ANCHOR_BATCH_SIZE ?? "200", 10) || 200, 1), 200);
  const manifests: BatchManifestV1[] = [];
  const receipts: AnchorReceiptV1[] = [];
  const manifestUris: string[] = [];
  const uncertainClaimIds: string[] = [];
  const archive = await apiRequest<AnchorClaimResponse>("/v1/internal/anchor/claims", {method: "POST", body: JSON.stringify({owner_id: workerId, authority_id: authorityId, epoch, tier: runTier, kind: "BATCH", limit, lease_seconds: leaseSeconds})});
  if (!archive.claim) return {created: false};
  const processedArchive = await processClaim(archive, mode);
  manifests.push(processedArchive.manifest);
  if (processedArchive.receipt) receipts.push(processedArchive.receipt);
  if (processedArchive.manifest_uri) manifestUris.push(processedArchive.manifest_uri);
  if (processedArchive.response.claim.state === "uncertain") uncertainClaimIds.push(processedArchive.response.claim.claim_id);

  if (runTier === "all" || runTier === "premium_plus") {
    const premiumPlusCount = processedArchive.response.posts.filter((post) => post.anchoring.tier === "premium_plus").length;
    for (let index = 0; index < premiumPlusCount; index += 1) {
      const individual = await apiRequest<AnchorClaimResponse>("/v1/internal/anchor/claims", {method: "POST", body: JSON.stringify({owner_id: workerId, authority_id: authorityId, epoch, tier: "premium_plus", kind: "POST", limit: 1, lease_seconds: leaseSeconds})});
      if (!individual.claim) break;
      const processedIndividual = await processClaim(individual, mode);
      manifests.push(processedIndividual.manifest);
      if (processedIndividual.receipt) receipts.push(processedIndividual.receipt);
      if (processedIndividual.manifest_uri) manifestUris.push(processedIndividual.manifest_uri);
      if (processedIndividual.response.claim.state === "uncertain") uncertainClaimIds.push(processedIndividual.response.claim.claim_id);
    }
  }
  return {created: true, manifests, receipts, ...(manifestUris.length ? {manifest_uris: manifestUris} : {}), ...(uncertainClaimIds.length ? {uncertain_claim_ids: uncertainClaimIds} : {})};
}

if (process.argv[1]?.endsWith("index.js")) {
  try { console.log(JSON.stringify(await runAnchorOnce(), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}

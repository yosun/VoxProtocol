import {
  base64UrlToBytes,
  bytesToHex,
  journalEnvelopeHashHex,
  journalSigningPayload,
  postHash,
  postIdFromIntent,
  postSigningPayload,
  verifyBytes,
  type AgentRegistrationV1,
  type BatchManifestV1,
  type JournalEnvelopeV1,
  type SignedPostV1
} from "@vox/protocol";
import {isPublisherKeyAuthorizedAt, verifyAgentRegistration} from "@vox/identity";
import {leafHashForRecord, verifyManifest, verifyMerkleProof, type MerkleProofV1} from "@vox/merkle";
import {commitmentMatches, decodeCommitment, encodeCommitment, epochReferenceHash, transactionMemoPayload} from "@vox/solana";

export interface ProofBundle {
  post: {post_id: string; signed: SignedPostV1; post_hash: string; envelope: JournalEnvelopeV1; envelope_hash: string};
  agent: AgentRegistrationV1;
  manifest?: BatchManifestV1;
  merkle_proof?: MerkleProofV1;
  anchor?: {payload_base64url: string; transaction_signature: string; finalized: boolean; authority_id: string; type: "BATCH" | "POST"; manifest_hash: string};
}

export interface VerificationResult {
  valid: boolean;
  recordValid: boolean;
  authorshipVerified: boolean;
  recordIntegrityVerified: boolean;
  journalVerified: boolean;
  merkleInclusionVerified: boolean;
  chainCommitmentVerified: boolean;
  chainFinalized: boolean;
  errors: string[];
}

export function verifyProofBundle(bundle: ProofBundle): VerificationResult {
  const errors: string[] = [];
  let authorshipVerified = false;
  let recordIntegrityVerified = false;
  let journalVerified = false;
  let merkleInclusionVerified = false;
  let chainCommitmentVerified = false;
  let chainFinalized = false;
  try {
    const intent = bundle.post.signed.intent;
    authorshipVerified = verifyAgentRegistration(bundle.agent) &&
      bundle.agent.agent_id === intent.agent_id &&
      isPublisherKeyAuthorizedAt(bundle.agent, intent.author_key, intent.created_at) &&
      verifyBytes(postSigningPayload(intent), bundle.post.signed.signature, intent.author_key);
    if (!authorshipVerified) errors.push("author signature or publisher-key authorization is invalid");

    recordIntegrityVerified = postIdFromIntent(intent) === bundle.post.post_id && bundle.post.post_hash === bytesToHex(postHash(intent));
    if (!recordIntegrityVerified) errors.push("canonical post identity or hash does not match");

    const unsignedEnvelope: Omit<JournalEnvelopeV1, "instance_public_key" | "instance_signature"> = {
      protocol: bundle.post.envelope.protocol,
      envelope_version: bundle.post.envelope.envelope_version,
      post_id: bundle.post.envelope.post_id,
      agent_id: bundle.post.envelope.agent_id,
      publisher_instance_id: bundle.post.envelope.publisher_instance_id,
      accepted_at: bundle.post.envelope.accepted_at,
      sequence: bundle.post.envelope.sequence,
      previous_event_hash: bundle.post.envelope.previous_event_hash,
      post_hash: bundle.post.envelope.post_hash
    };
    const expectedEnvelopeHash = journalEnvelopeHashHex(unsignedEnvelope);
    journalVerified = expectedEnvelopeHash === bundle.post.envelope_hash &&
      bundle.post.envelope.post_id === bundle.post.post_id &&
      bundle.post.envelope.post_hash === bundle.post.post_hash &&
      verifyBytes(journalSigningPayload(unsignedEnvelope), bundle.post.envelope.instance_signature, bundle.post.envelope.instance_public_key);
    if (!journalVerified) errors.push("journal envelope integrity or instance signature is invalid");

    const leaf = bundle.manifest?.leaves.find((candidate) => candidate.post_id === bundle.post.post_id);
    if (bundle.manifest && bundle.merkle_proof && leaf) {
      const expectedLeaf = leafHashForRecord({post_id: bundle.post.post_id, agent_id: bundle.post.envelope.agent_id, sequence: bundle.post.envelope.sequence, post_hash: bundle.post.post_hash, envelope_hash: bundle.post.envelope_hash});
      merkleInclusionVerified = verifyManifest(bundle.manifest) && leaf.leaf_hash === expectedLeaf && bundle.merkle_proof.leaf_hash === leaf.leaf_hash && bundle.merkle_proof.leaf_index === leaf.leaf_index && verifyMerkleProof(bundle.merkle_proof) && bundle.merkle_proof.root === bundle.manifest.root;
    }
    if (!merkleInclusionVerified) errors.push("Merkle manifest or inclusion proof is invalid");

    if (bundle.anchor) {
      const payload = base64UrlToBytes(bundle.anchor.payload_base64url);
      const decoded = decodeCommitment(payload);
      const referenceHash = bundle.anchor.type === "BATCH" && bundle.manifest
        ? bytesToHex((awaitableDomainHash("vox.epoch.v1", bundle.manifest.epoch)))
        : bundle.post.post_hash;
      chainCommitmentVerified = !!decoded && commitmentMatches(payload, {
        type: bundle.anchor.type,
        authority_id: bundle.anchor.authority_id,
        reference_hash: referenceHash,
        root_or_post_hash: bundle.anchor.type === "BATCH" && bundle.manifest ? bundle.manifest.root : bundle.post.post_hash,
        manifest_hash: bundle.anchor.manifest_hash
      });
      chainFinalized = chainCommitmentVerified && bundle.anchor.finalized;
    }
    if (!chainCommitmentVerified) errors.push("Solana commitment payload is missing or does not match evidence");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "verification failed");
  }
  const recordValid = authorshipVerified && recordIntegrityVerified && journalVerified && merkleInclusionVerified;
  return {valid: recordValid && chainCommitmentVerified && chainFinalized, recordValid, authorshipVerified, recordIntegrityVerified, journalVerified, merkleInclusionVerified, chainCommitmentVerified, chainFinalized, errors};
}

function awaitableDomainHash(domain: string, value: string): Uint8Array {
  // Importing these primitives from @vox/protocol keeps the exact same domain
  // separator in the CLI, API and browser-compatible verification package.
  return domainHashForVerifier(domain, utf8(value));
}

import {domainHash as domainHashForVerifier, utf8} from "@vox/protocol";

export async function verifyProofBundleWithChain(bundle: ProofBundle, rpcUrl: string): Promise<VerificationResult> {
  const base = verifyProofBundle(bundle);
  if (!bundle.anchor) return base;
  const errors = base.errors.filter((error) => !error.startsWith("Solana commitment"));
  let chainCommitmentVerified = false;
  let chainFinalized = false;
  try {
    const commitment = bundle.anchor.type === "BATCH" && bundle.manifest
      ? {type: "BATCH" as const, authority_id: bundle.anchor.authority_id, reference_hash: epochReferenceHash(bundle.manifest.epoch), root_or_post_hash: bundle.manifest.root, manifest_hash: bundle.anchor.manifest_hash}
      : {type: "POST" as const, authority_id: bundle.anchor.authority_id, reference_hash: bundle.post.post_hash, root_or_post_hash: bundle.post.post_hash, manifest_hash: bundle.anchor.manifest_hash};
    const expectedPayload = encodeCommitment(commitment);
    const actualPayload = await transactionMemoPayload(rpcUrl, bundle.anchor.transaction_signature);
    chainCommitmentVerified = !!actualPayload && actualPayload.length === expectedPayload.length && actualPayload.every((byte, index) => byte === expectedPayload[index]);
    chainFinalized = chainCommitmentVerified;
  } catch (error) {
    errors.push(error instanceof Error ? `Solana RPC verification failed: ${error.message}` : "Solana RPC verification failed");
  }
  if (!chainCommitmentVerified) errors.push("finalized Solana transaction does not contain the expected VOX payload");
  return {
    ...base,
    chainCommitmentVerified,
    chainFinalized,
    valid: base.authorshipVerified && base.recordIntegrityVerified && base.journalVerified && base.merkleInclusionVerified && chainCommitmentVerified && chainFinalized,
    errors
  };
}

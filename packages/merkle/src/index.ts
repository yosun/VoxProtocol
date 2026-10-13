import {
  BatchManifestV1Schema,
  bytesToHex,
  canonicalBytes,
  domainHash,
  hexToBytes,
  recordDigest,
  utf8,
  type BatchManifestV1,
  type ManifestLeaf
} from "@vox/protocol";

export interface MerkleRecord {
  post_id: string;
  agent_id: string;
  sequence: number;
  post_hash: string;
  envelope_hash: string;
}

export interface MerkleProofV1 {
  tree_version: "vox-merkle-v1";
  leaf_hash: string;
  leaf_index: number;
  tree_size: number;
  siblings: Array<{hash: string; position: "left" | "right"}>;
  root: string;
}

export interface BuiltMerkleBatch {
  manifest: BatchManifestV1;
  proofs: Map<string, MerkleProofV1>;
}

function leafHash(record: MerkleRecord): string {
  const digest = recordDigest(hexToBytes(record.post_hash), hexToBytes(record.envelope_hash));
  return bytesToHex(domainHash("vox.merkle.leaf.v1", digest));
}

function nodeHash(left: string, right: string): string {
  return bytesToHex(domainHash("vox.merkle.node.v1", hexToBytes(left), hexToBytes(right)));
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8(left);
  const rightBytes = utf8(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index]! !== rightBytes[index]!) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function compareRecords(left: MerkleRecord, right: MerkleRecord): number {
  return compareUtf8(left.agent_id, right.agent_id) || left.sequence - right.sequence || compareUtf8(left.post_id, right.post_id);
}

function compareLeaves(left: ManifestLeaf, right: ManifestLeaf): number {
  return compareRecords(left, right);
}

export function emptyMerkleRoot(): string {
  return bytesToHex(domainHash("vox.merkle.empty.v1"));
}

function buildLevels(leaves: string[]): string[][] {
  if (leaves.length === 0) return [[emptyMerkleRoot()]];
  const levels: string[][] = [[...leaves]];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) next.push(nodeHash(current[index]!, current[index + 1] ?? current[index]!));
    levels.push(next);
  }
  return levels;
}

export function merkleRootFromLeafHashes(leaves: string[]): string {
  return buildLevels(leaves).at(-1)![0]!;
}

function proofFromLevels(levels: string[][], leafIndex: number): MerkleProofV1 {
  const leaves = levels[0]!;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) throw new Error("Leaf index is outside tree");
  const siblings: MerkleProofV1["siblings"] = [];
  let currentIndex = leafIndex;
  for (const level of levels.slice(0, -1)) {
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    siblings.push({hash: level[siblingIndex] ?? level[currentIndex]!, position: siblingIndex < currentIndex ? "left" : "right"});
    currentIndex = Math.floor(currentIndex / 2);
  }
  return {tree_version: "vox-merkle-v1", leaf_hash: leaves[leafIndex]!, leaf_index: leafIndex, tree_size: leaves.length, siblings, root: levels.at(-1)![0]!};
}

function expectedProofHeight(treeSize: number): number {
  let height = 0;
  for (let size = treeSize; size > 1; size = Math.ceil(size / 2)) height += 1;
  return height;
}

export function verifyMerkleProof(proof: MerkleProofV1): boolean {
  try {
    if (proof.tree_version !== "vox-merkle-v1" || !Number.isInteger(proof.tree_size) || proof.tree_size < 1 || !Number.isInteger(proof.leaf_index) || proof.leaf_index < 0 || proof.leaf_index >= proof.tree_size) return false;
    if (!/^[0-9a-f]{64}$/.test(proof.leaf_hash) || !/^[0-9a-f]{64}$/.test(proof.root) || proof.siblings.length !== expectedProofHeight(proof.tree_size)) return false;
    let current = proof.leaf_hash;
    for (const sibling of proof.siblings) {
      if (!/^[0-9a-f]{64}$/.test(sibling.hash) || (sibling.position !== "left" && sibling.position !== "right")) return false;
      current = sibling.position === "left" ? nodeHash(sibling.hash, current) : nodeHash(current, sibling.hash);
    }
    return current === proof.root;
  } catch {
    return false;
  }
}

function sortRecords(records: MerkleRecord[]): MerkleRecord[] {
  return [...records].sort(compareRecords);
}

export function buildMerkleBatch(input: {
  authority_id: string;
  batch_id: string;
  epoch: string;
  created_at: string;
  records: MerkleRecord[];
}): BuiltMerkleBatch {
  const records = sortRecords(input.records);
  const leaves = records.map((record, leaf_index): ManifestLeaf => ({
    post_id: record.post_id,
    agent_id: record.agent_id,
    sequence: record.sequence,
    post_hash: record.post_hash,
    envelope_hash: record.envelope_hash,
    leaf_hash: leafHash(record),
    leaf_index
  }));
  const leafHashes = leaves.map((leaf) => leaf.leaf_hash);
  const levels = buildLevels(leafHashes);
  const root = levels.at(-1)![0]!;
  const unsignedManifest = {
    protocol: "vox/1" as const,
    manifest_version: 1 as const,
    tree_version: "vox-merkle-v1" as const,
    authority_id: input.authority_id,
    batch_id: input.batch_id,
    epoch: input.epoch,
    ordering: "agent_id,sequence,post_id" as const,
    record_count: leaves.length,
    first_sequence: leaves.length ? Math.min(...leaves.map((leaf) => leaf.sequence)) : null,
    last_sequence: leaves.length ? Math.max(...leaves.map((leaf) => leaf.sequence)) : null,
    root,
    created_at: input.created_at,
    leaves
  };
  const manifestHash = bytesToHex(domainHash("vox.manifest.v1", canonicalBytes(unsignedManifest)));
  const manifest = BatchManifestV1Schema.parse({...unsignedManifest, manifest_hash: manifestHash});
  const proofs = new Map<string, MerkleProofV1>();
  for (const leaf of leaves) proofs.set(leaf.post_id, proofFromLevels(levels, leaf.leaf_index));
  return {manifest, proofs};
}

export function verifyManifest(manifest: BatchManifestV1): boolean {
  try {
    const parsed = BatchManifestV1Schema.parse(manifest);
    const unsigned = {...parsed};
    delete (unsigned as {manifest_hash?: string}).manifest_hash;
    const expectedManifestHash = bytesToHex(domainHash("vox.manifest.v1", canonicalBytes(unsigned)));
    if (expectedManifestHash !== parsed.manifest_hash || parsed.record_count !== parsed.leaves.length) return false;
    if (parsed.leaves.some((leaf, index) => leaf.leaf_index !== index)) return false;
    const ordered = [...parsed.leaves].sort((left, right) => left.leaf_index - right.leaf_index);
    const seenPostIds = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const leaf = ordered[index]!;
      if (seenPostIds.has(leaf.post_id) || (index > 0 && compareLeaves(ordered[index - 1]!, leaf) >= 0)) return false;
      seenPostIds.add(leaf.post_id);
      if (leaf.leaf_hash !== leafHash({post_id: leaf.post_id, agent_id: leaf.agent_id, sequence: leaf.sequence, post_hash: leaf.post_hash, envelope_hash: leaf.envelope_hash})) return false;
    }
    const firstSequence = ordered.length ? Math.min(...ordered.map((leaf) => leaf.sequence)) : null;
    const lastSequence = ordered.length ? Math.max(...ordered.map((leaf) => leaf.sequence)) : null;
    if (parsed.first_sequence !== firstSequence || parsed.last_sequence !== lastSequence) return false;
    return merkleRootFromLeafHashes(ordered.map((leaf) => leaf.leaf_hash)) === parsed.root;
  } catch {
    return false;
  }
}

export function proofForManifest(manifest: BatchManifestV1, postId: string): MerkleProofV1 | undefined {
  if (!verifyManifest(manifest)) return undefined;
  const ordered = [...manifest.leaves].sort((left, right) => left.leaf_index - right.leaf_index);
  const leaf = ordered.find((candidate) => candidate.post_id === postId);
  if (!leaf) return undefined;
  return proofFromLeaves(ordered.map((candidate) => candidate.leaf_hash), leaf.leaf_index);
}

function proofFromLeaves(leaves: string[], leafIndex: number): MerkleProofV1 {
  return proofFromLevels(buildLevels(leaves), leafIndex);
}

export function leafHashForRecord(record: MerkleRecord): string {
  return leafHash(record);
}

import {describe, expect, it} from "vitest";
import {buildMerkleBatch, leafHashForRecord, verifyManifest, verifyMerkleProof} from "@vox/merkle";

const records = [
  {post_id: "vox:post:" + "22".repeat(32), agent_id: "vox:agent:" + "A".repeat(43), sequence: 2, post_hash: "22".repeat(32), envelope_hash: "b2".repeat(32)},
  {post_id: "vox:post:" + "11".repeat(32), agent_id: "vox:agent:" + "A".repeat(43), sequence: 1, post_hash: "11".repeat(32), envelope_hash: "b1".repeat(32)},
  {post_id: "vox:post:" + "33".repeat(32), agent_id: "vox:agent:" + "B".repeat(43), sequence: 1, post_hash: "33".repeat(32), envelope_hash: "b3".repeat(32)}
];

describe("deterministic Merkle commitments", () => {
  it("sorts records, duplicates odd nodes, and verifies every proof", () => {
    const first = buildMerkleBatch({authority_id: "vox:anchor:test", batch_id: "batch", epoch: "2026-10-09Z", created_at: "2026-10-09T12:00:00.000Z", records});
    const second = buildMerkleBatch({authority_id: "vox:anchor:test", batch_id: "batch", epoch: "2026-10-09Z", created_at: "2026-10-09T12:00:00.000Z", records: [...records].reverse()});
    expect(first.manifest.root).toBe(second.manifest.root);
    expect(first.manifest.manifest_hash).toBe(second.manifest.manifest_hash);
    expect(verifyManifest(first.manifest)).toBe(true);
    for (const record of records) {
      const proof = first.proofs.get(record.post_id)!;
      expect(verifyMerkleProof(proof)).toBe(true);
      expect(proof.root).toBe(first.manifest.root);
      expect(first.manifest.leaves.find((leaf) => leaf.post_id === record.post_id)?.leaf_hash).toBe(leafHashForRecord(record));
    }
  });

  it("rejects corrupted proof and manifest evidence", () => {
    const batch = buildMerkleBatch({authority_id: "vox:anchor:test", batch_id: "single", epoch: "2026-10-09Z", created_at: "2026-10-09T12:00:00.000Z", records: [records[0]!]});
    const proof = batch.proofs.get(records[0]!.post_id)!;
    expect(verifyMerkleProof({...proof, root: "ff".repeat(32)})).toBe(false);
    expect(verifyMerkleProof({...proof, leaf_index: -1})).toBe(false);
    expect(verifyMerkleProof({...proof, siblings: [{hash: "00".repeat(32), position: "right"}]})).toBe(false);
    expect(verifyManifest({...batch.manifest, root: "ff".repeat(32)})).toBe(false);
  });
});

import {describe, expect, it} from "vitest";
import {bytesToBase64Url, bytesToHex} from "@vox/protocol";
import {getBase58Decoder} from "@solana/kit";
import {commitmentMatches, createMemoTransaction, decodeCommitment, encodeCommitment, epochReferenceHash, isSolanaTransactionSignature, MEMO_PROGRAM_ID} from "@vox/solana";

describe("Solana transaction signature representation", () => {
  it("accepts exactly 64 decoded bytes, including leading zero bytes", () => {
    // Fabricated representation fixtures; these are not signatures of transactions.
    for (const leadingZeroes of [0, 1, 10, 63, 64]) {
      const bytes = new Uint8Array(64).fill(1);
      bytes.fill(0, 0, leadingZeroes);
      expect(isSolanaTransactionSignature(getBase58Decoder().decode(bytes))).toBe(true);
    }
    expect(isSolanaTransactionSignature("1".repeat(64))).toBe(true);
  });

  it.each([undefined, null, 123, "", "a".repeat(64), "z".repeat(88), "1".repeat(63), "1".repeat(65), "0" + "1".repeat(64), "1".repeat(64) + "I", " " + "1".repeat(64), "1".repeat(64) + "\n"])("rejects malformed or wrong-size signature %j", (value) => {
    expect(isSolanaTransactionSignature(value)).toBe(false);
  });
});

describe("Solana commitment encoding", () => {
  const input = {type: "BATCH" as const, authority_id: "vox:anchor:test", reference_hash: epochReferenceHash("2026-10-09Z"), root_or_post_hash: "ab".repeat(32), manifest_hash: "cd".repeat(32)};
  it("round trips the compact versioned VOX payload", () => {
    const payload = encodeCommitment(input);
    expect(payload).toHaveLength(133);
    expect(decodeCommitment(payload)).toEqual({version: 1, type: "BATCH", authority_hash: bytesToHex(payload.slice(5, 37)), reference_hash: input.reference_hash, root_or_post_hash: input.root_or_post_hash, manifest_hash: input.manifest_hash});
    expect(commitmentMatches(payload, input)).toBe(true);
    expect(commitmentMatches(payload, {...input, root_or_post_hash: "ef".repeat(32)})).toBe(false);
    expect(bytesToBase64Url(payload)).toMatch(/^Vk9YAQ/);
  });

  it("creates a memo instruction without submitting a transaction", () => {
    const transaction = createMemoTransaction(encodeCommitment({...input, type: "POST", reference_hash: "12".repeat(32), root_or_post_hash: "34".repeat(32), manifest_hash: undefined}));
    expect(transaction.instructions[0]?.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
  });
});

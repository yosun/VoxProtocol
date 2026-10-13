import {describe, expect, it} from "vitest";
import {canonicalize} from "@vox/protocol";
import {bytesToHex, generateKeyPair, parseSecretKey, postHashHex, postIdFromIntent, sha256, signPost, utf8, verifyPostSignature, type VoxPostIntentV1} from "@vox/protocol";
import {createAgent} from "@vox/identity";

const vectorAgent = createAgent({display_name: "Vector", handle: "vector@example.test", description: "vector", issued_at: "2026-10-09T12:00:00.000Z"}, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
const vectorPublisher = Object.keys(vectorAgent.key_material.publisherSecretKeys)[0]!;
const vectorIntent: VoxPostIntentV1 = {protocol: "vox/1", agent_id: vectorAgent.registration.agent_id, author_key: vectorPublisher, client_post_id: "vector-1", created_at: "2026-10-09T12:01:00.000Z", kind: "thought", content: {text: "Hello, Vox."}};

 describe("canonical protocol", () => {
  it("serializes object keys deterministically and rejects unsupported values", () => {
    expect(canonicalize({b: 1, a: "x", nested: {z: true, a: null}})).toBe('{"a":"x","b":1,"nested":{"a":null,"z":true}}');
    expect(() => canonicalize({value: 1.5})).toThrow();
    expect(() => canonicalize({value: undefined})).toThrow();
  });

  it("matches the published SHA-256 and post test vectors", () => {
    expect(bytesToHex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalize(vectorIntent)).toBe('{"agent_id":"vox:agent:iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w","author_key":"gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q","client_post_id":"vector-1","content":{"text":"Hello, Vox."},"created_at":"2026-10-09T12:01:00.000Z","kind":"thought","protocol":"vox/1"}');
    expect(postHashHex(vectorIntent)).toBe("5b3e320e31793dab927a18497e6d66c7cf440ceec3fe92453943372a3d2b5b49");
    expect(postIdFromIntent(vectorIntent)).toBe("vox:post:5b3e320e31793dab927a18497e6d66c7cf440ceec3fe92453943372a3d2b5b49");
  });

  it("signs and verifies the immutable intent but rejects mutation", () => {
    const signature = signPost(vectorIntent, parseSecretKey(vectorAgent.key_material.publisherSecretKeys[vectorPublisher]!));
    expect(verifyPostSignature(vectorIntent, signature)).toBe(true);
    expect(verifyPostSignature({...vectorIntent, content: {text: "altered"}}, signature)).toBe(false);
  });

  it("generates independent Ed25519 key pairs", () => {
    const first = generateKeyPair(new Uint8Array(32).fill(2));
    const second = generateKeyPair(new Uint8Array(32).fill(3));
    expect(bytesToHex(first.publicKey)).not.toBe(bytesToHex(second.publicKey));
    expect(first.secretKey).toHaveLength(64);
  });
});

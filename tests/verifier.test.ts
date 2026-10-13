import {describe, expect, it} from "vitest";
import {buildApp, MemoryStore} from "@vox/api";
import {createAgent} from "@vox/identity";
import {createThoughtIntent, signIntent, verifyProofBundle} from "@vox/client";
import {generateKeyPair} from "@vox/protocol";

describe("independent proof verifier", () => {
  it("accepts authorship/journal/Merkle evidence and rejects altered archived content", async () => {
    const app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(21)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Verifier", handle: "verifier@test.invalid", description: "test", issued_at: now}, new Uint8Array(32).fill(22));
    await app.inject({method: "POST", url: "/v1/agents", payload: agent.registration});
    const key = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const post = await app.inject({method: "POST", url: "/v1/posts", payload: signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: key, client_post_id: "verify-1", text: "proof me", created_at: now}), agent.key_material.publisherSecretKeys[key]!)});
    const stored = post.json() as {post_id: string};
    await app.inject({method: "POST", url: "/v1/internal/anchor/run", payload: {epoch: "2026-10-09Z"}});
    const response = await app.inject({method: "GET", url: `/v1/posts/${stored.post_id}/proof`});
    const bundle = response.json().bundle;
    const result = verifyProofBundle(bundle);
    expect(result.authorshipVerified).toBe(true);
    expect(result.journalVerified).toBe(true);
    expect(result.merkleInclusionVerified).toBe(true);
    expect(result.valid).toBe(false);
    expect(verifyProofBundle({...bundle, post: {...bundle.post, post_hash: "ff".repeat(32)}}).recordIntegrityVerified).toBe(false);
    await app.close();
  });
});

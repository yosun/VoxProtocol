import {afterEach, describe, expect, it} from "vitest";
import {buildApp, MemoryStore} from "@vox/api";
import {createAgent, appendKeyAuthorization} from "@vox/identity";
import {createThoughtIntent, signIntent} from "@vox/client";
import {buildMerkleBatch} from "@vox/merkle";
import {bytesToBase64Url, generateKeyPair, parseSecretKey, signRegistration} from "@vox/protocol";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

async function jsonRequest(path: string, options: {method?: string; body?: unknown} = {}) {
  const response = await app!.inject({method: options.method ?? "GET", url: path, ...(options.body === undefined ? {} : {payload: options.body})});
  return {statusCode: response.statusCode, body: response.json() as any};
}

describe("publishing vertical slice", () => {
  it("registers, publishes idempotently under concurrency, batches and returns independently verifiable proof", async () => {
    const instance = generateKeyPair(new Uint8Array(32).fill(9));
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: new Uint8Array(32).fill(9), instanceId: "vox.test"});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Test Bob", handle: "bob@test.invalid", description: "integration", issued_at: now}, new Uint8Array(32).fill(10));
    const registered = await jsonRequest("/v1/agents", {method: "POST", body: agent.registration});
    expect(registered.statusCode).toBe(201);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "concurrent-1", text: "A durable thought.", created_at: now}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const results = await Promise.all(Array.from({length: 8}, () => jsonRequest("/v1/posts", {method: "POST", body: signed})));
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(1);
    expect(results.every((result) => [200, 201].includes(result.statusCode))).toBe(true);
    const post = results[0]!.body;
    expect(post.envelope.sequence).toBe(1);
    expect(post.publication_status).toBe("published");
    expect(post.anchoring.status).toBe("unanchored");

    const batch = await jsonRequest("/v1/internal/anchor/run", {method: "POST", body: {epoch: "2026-10-09Z"}});
    expect(batch.statusCode).toBe(201);
    const proof = await jsonRequest(`/v1/posts/${post.post_id}/proof`);
    expect(proof.statusCode).toBe(200);
    expect(proof.body.verification.authorshipVerified).toBe(true);
    expect(proof.body.verification.recordIntegrityVerified).toBe(true);
    expect(proof.body.verification.journalVerified).toBe(true);
    expect(proof.body.verification.merkleInclusionVerified).toBe(true);
    expect(proof.body.verification.recordValid).toBe(true);
    expect(proof.body.verification.chainFinalized).toBe(false);

    const feed = await jsonRequest("/v1/feed");
    expect(feed.body.items).toHaveLength(1);
    const profile = await jsonRequest(`/v1/agents/${agent.registration.agent_id}`);
    expect(profile.body.registration.display_name).toBe("Test Bob");
    const search = await jsonRequest("/v1/search?q=durable");
    expect(search.body.posts).toHaveLength(1);
    const reaction = await jsonRequest(`/v1/posts/${post.post_id}/reactions`, {method: "POST", body: {reaction: "like", actor_id: "test.viewer"}});
    expect(reaction.body.count).toBe(1);
    const duplicateReaction = await jsonRequest(`/v1/posts/${post.post_id}/reactions`, {method: "POST", body: {reaction: "like", actor_id: "test.viewer"}});
    expect(duplicateReaction.body.count).toBe(1);
  });

  it("rejects tampered signatures, malformed schema, and revoked keys", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(11)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Secure", handle: "secure@test.invalid", description: "integration", issued_at: now}, new Uint8Array(32).fill(12));
    expect((await jsonRequest("/v1/agents", {method: "POST", body: agent.registration})).statusCode).toBe(201);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "bad-1", text: "valid", created_at: now}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const tampered = {...signed, signature: "A".repeat(signed.signature.length)};
    expect((await jsonRequest("/v1/posts", {method: "POST", body: tampered})).statusCode).toBe(401);
    expect((await jsonRequest("/v1/posts", {method: "POST", body: {intent: signed.intent}})).statusCode).toBe(400);
    expect((await jsonRequest("/v1/feed?cursor=not-base64")).statusCode).toBe(400);
    expect((await jsonRequest("/v1/internal/anchor/status", {method: "POST", body: {post_ids: ["not-a-post"], patch: {}}})).statusCode).toBe(400);
    const revoked = {...agent.registration, publisher_keys: [{...agent.registration.publisher_keys[0]!, action: "revoke" as const, issued_at: new Date(Date.now() + 1000).toISOString()}]};
    // The root signature would not match an edited record; this confirms the API does not accept unsigned key state.
    expect((await jsonRequest(`/v1/agents/${agent.registration.agent_id}/keys`, {method: "POST", body: revoked})).statusCode).toBe(401);
  });

  it("preserves historical authorization while appending and routing key updates", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(13)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "History", handle: "history@test.invalid", description: "append-only", issued_at: now}, new Uint8Array(32).fill(14));
    expect((await jsonRequest("/v1/agents", {method: "POST", body: agent.registration})).statusCode).toBe(201);
    const oldPublisher = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const oldPost = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: oldPublisher, client_post_id: "before-rotation", text: "Before rotation.", created_at: now}), agent.key_material.publisherSecretKeys[oldPublisher]!);
    const published = await jsonRequest("/v1/posts", {method: "POST", body: oldPost});
    expect(published.statusCode).toBe(201);

    const identitySecret = parseSecretKey(agent.key_material.identitySecretKey);
    const nextPublisher = generateKeyPair(new Uint8Array(32).fill(15));
    const rotationAt = new Date(Date.now() + 1000).toISOString();
    const rotated = appendKeyAuthorization(agent.registration, identitySecret, "authorize", nextPublisher.publicKey, "rotation", rotationAt);
    const updated = await jsonRequest(`/v1/agents/${agent.registration.agent_id}/keys`, {method: "POST", body: rotated});
    expect(updated.statusCode).toBe(200);
    expect(updated.body.registration.publisher_keys).toHaveLength(2);

    const oldProof = await jsonRequest(`/v1/posts/${published.body.post_id}/proof`);
    expect(oldProof.body.verification.authorshipVerified).toBe(true);

    const nextPublisherKey = bytesToBase64Url(nextPublisher.publicKey);
    const nextPost = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: nextPublisherKey, client_post_id: "after-rotation", text: "After rotation.", created_at: new Date(Date.now() + 2000).toISOString()}), bytesToBase64Url(nextPublisher.secretKey));
    expect((await jsonRequest("/v1/posts", {method: "POST", body: nextPost})).statusCode).toBe(201);

    const {root_signature: _rootSignature, publisher_keys: _publisherKeys, ...rotatedMetadata} = rotated;
    const truncatedUnsigned = {...rotatedMetadata, publisher_keys: [rotated.publisher_keys[1]!]};
    const truncated = {...truncatedUnsigned, root_signature: signRegistration(truncatedUnsigned, identitySecret)};
    const conflict = await jsonRequest(`/v1/agents/${agent.registration.agent_id}/keys`, {method: "POST", body: truncated});
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe("key_history_conflict");

    const revoked = appendKeyAuthorization(rotated, identitySecret, "revoke", nextPublisher.publicKey, "retired", new Date(Date.now() + 3000).toISOString());
    const revokeResponse = await jsonRequest(`/v1/agents/${agent.registration.agent_id}/keys/${nextPublisherKey}/revoke`, {method: "POST", body: revoked});
    expect(revokeResponse.statusCode).toBe(200);
    const revokedPost = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: nextPublisherKey, client_post_id: "after-revocation", text: "Should be rejected.", created_at: new Date(Date.now() + 4000).toISOString()}), bytesToBase64Url(nextPublisher.secretKey));
    expect((await jsonRequest("/v1/posts", {method: "POST", body: revokedPost})).statusCode).toBe(403);
  });

  it("claims anchor work transactionally and reconciles an uncertain submission", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(16)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Anchor", handle: "anchor@test.invalid", description: "claims", issued_at: now}, new Uint8Array(32).fill(17));
    expect((await jsonRequest("/v1/agents", {method: "POST", body: agent.registration})).statusCode).toBe(201);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "anchor-claim", text: "Anchor this.", created_at: now}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const published = await jsonRequest("/v1/posts", {method: "POST", body: signed});
    expect(published.statusCode).toBe(201);

    const claimResponse = await jsonRequest("/v1/internal/anchor/claims", {method: "POST", body: {owner_id: "worker-a", authority_id: "vox:anchor:vox.blog", epoch: "2026-10-09Z", tier: "free", kind: "BATCH", limit: 10, lease_seconds: 60}});
    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.body.claim.state).toBe("claimed");
    expect(claimResponse.body.posts).toHaveLength(1);
    expect(claimResponse.body.posts[0].anchoring.status).toBe("claimed");
    const duplicateClaim = await jsonRequest("/v1/internal/anchor/claims", {method: "POST", body: {owner_id: "worker-a", authority_id: "vox:anchor:vox.blog", epoch: "2026-10-09Z", tier: "free", kind: "BATCH", limit: 10, lease_seconds: 60}});
    expect(duplicateClaim.body.claim.claim_id).toBe(claimResponse.body.claim.claim_id);
    const competingClaim = await jsonRequest("/v1/internal/anchor/claims", {method: "POST", body: {owner_id: "worker-b", authority_id: "vox:anchor:vox.blog", epoch: "2026-10-09Z", tier: "free", kind: "BATCH", limit: 10, lease_seconds: 60}});
    expect(competingClaim.body.claimed).toBe(false);

    const claimPost = claimResponse.body.posts[0];
    const built = buildMerkleBatch({
      authority_id: claimResponse.body.claim.authority_id,
      batch_id: claimResponse.body.claim.batch_id,
      epoch: claimResponse.body.claim.epoch,
      created_at: claimResponse.body.claim.manifest_created_at,
      records: [{post_id: claimPost.post_id, agent_id: claimPost.intent.agent_id, sequence: claimPost.envelope.sequence, post_hash: claimPost.post_hash, envelope_hash: claimPost.envelope_hash}]
    });
    const manifested = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "worker-a", state: "manifested", manifest: built.manifest}});
    expect(manifested.body.claim.state).toBe("manifested");
    expect(manifested.body.posts[0].anchoring.manifest_hash).toBe(built.manifest.manifest_hash);
    const tamperedManifest = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "worker-a", state: "manifested", manifest: {...built.manifest, created_at: new Date(Date.now() + 1).toISOString()}}});
    expect(tamperedManifest.statusCode).toBe(409);

    const submitting = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "worker-a", state: "submitting", lease_seconds: 60}});
    expect(submitting.statusCode, submitting.body.error).toBe(200);
    expect(submitting.body.claim.attempts).toBe(1);
    const uncertain = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "worker-a", state: "uncertain", transaction_signature: "unknown-signature", error: "confirmation timed out"}});
    expect(uncertain.statusCode, uncertain.body.error).toBe(200);
    expect(uncertain.body.claim.state).toBe("uncertain");
    expect((await jsonRequest("/v1/internal/anchor/uncertain")).body.claims).toHaveLength(1);

    const receipt = {protocol: "vox/1", commitment_type: "BATCH", authority_id: claimResponse.body.claim.authority_id, reference: "a".repeat(64), root_or_post_hash: built.manifest.root, manifest_hash: built.manifest.manifest_hash, payload_base64url: "A", transaction_signature: "unknown-signature", finalized: false};
    const submitted = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "reconciler", receipt}});
    expect(submitted.statusCode, submitted.body.error).toBe(200);
    expect(submitted.body.claim.owner_id).toBe("reconciler");
    expect(submitted.body.claim.state).toBe("submitted");
    expect((await jsonRequest("/v1/internal/anchor/uncertain")).body.claims[0].claim.state).toBe("submitted");
    const finalized = await jsonRequest(`/v1/internal/anchor/claims/${claimResponse.body.claim.claim_id}`, {method: "POST", body: {owner_id: "reconciler", receipt: {...receipt, finalized: true}}});
    expect(finalized.statusCode, finalized.body.error).toBe(200);
    expect(finalized.body.claim.state).toBe("finalized");
    expect(finalized.body.posts[0].anchoring.status).toBe("finalized");
  });

  it("persists quotes and reserves payment references across app restarts", async () => {
    const store = new MemoryStore();
    app = await buildApp({store, instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(18)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Economy", handle: "economy@test.invalid", description: "durable payment", issued_at: now}, new Uint8Array(32).fill(19));
    expect((await jsonRequest("/v1/agents", {method: "POST", body: agent.registration})).statusCode).toBe(201);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "realize-1", text: "A source for realization.", created_at: now}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const published = await jsonRequest("/v1/posts", {method: "POST", body: signed});
    expect(published.statusCode).toBe(201);
    const quote = await jsonRequest(`/v1/posts/${published.body.post_id}/realize/quote`, {method: "POST", body: {requester_id: "viewer-1", duration_seconds: 12, style: "cinematic"}});
    expect(quote.statusCode).toBe(200);
    const realizationRequest = {quote_id: quote.body.quote_id, post_id: published.body.post_id, requester_id: "viewer-1", payment_reference: "mock-payment-1"};
    const created = await jsonRequest("/v1/realizations", {method: "POST", body: realizationRequest});
    expect(created.statusCode).toBe(201);
    expect(created.body.payment_mode).toBe("mock");
    expect(created.body.provider_id).toBe("vox.mock-media.v1");
    expect(created.body.media_url).toContain("example.invalid");
    expect(created.body.payment_status).toBe("captured");
    const retry = await jsonRequest("/v1/realizations", {method: "POST", body: realizationRequest});
    expect(retry.statusCode).toBe(200);
    expect(retry.body.realization_id).toBe(created.body.realization_id);
    const snapshot = await store.snapshot();
    expect(snapshot.quotes).toHaveLength(1);
    expect(snapshot.payments).toHaveLength(1);
    expect(snapshot.payments![0]!.purpose).toBe("realization");

    await app.close();
    app = await buildApp({store, instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(20)).secretKey});
    const afterRestart = await jsonRequest("/v1/realizations", {method: "POST", body: realizationRequest});
    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.body.realization_id).toBe(created.body.realization_id);
  });
});

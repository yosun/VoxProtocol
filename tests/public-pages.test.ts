import {buildApp, MemoryStore} from "@vox/api";
import {createAgent, parseIdentitySecretKey} from "@vox/identity";
import {createThoughtIntent, signIntent} from "@vox/client";
import {generateKeyPair, signProfileUpdate} from "@vox/protocol";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let store: MemoryStore;
let baseUrl = "";

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function get(path: string): Promise<{status: number; contentType: string; text: string}> {
  const response = await fetch(`${baseUrl}${path}`);
  return {status: response.status, contentType: response.headers.get("content-type") ?? "", text: await response.text()};
}

async function seedPublicRecord(text = "This public thought is readable without JavaScript."): Promise<{agentId: string; postId: string}> {
  const now = new Date().toISOString();
  const agent = createAgent({
    display_name: "Readable Agent",
    handle: "readable@test.invalid",
    description: "An autonomous character with a public readable profile.",
    issued_at: now
  }, new Uint8Array(32).fill(31), new Uint8Array(32).fill(32));
  const registration = await fetch(`${baseUrl}/v1/agents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(agent.registration)});
  expect(registration.status).toBe(201);
  const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
  const signed = signIntent(createThoughtIntent({
    agent_id: agent.registration.agent_id,
    author_key: publisherKey,
    client_post_id: "public-page-test",
    text,
    created_at: now
  }), agent.key_material.publisherSecretKeys[publisherKey]!);
  const published = await fetch(`${baseUrl}/v1/posts`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(signed)});
  expect(published.status).toBe(201);
  const post = await published.json() as {post_id: string};
  return {agentId: agent.registration.agent_id, postId: post.post_id};
}

async function seedLiveProfile(): Promise<{agentId: string; postId: string}> {
  const now = new Date().toISOString();
  const agent = createAgent({
    display_name: "Live Character",
    handle: "live@test.invalid",
    description: "A character with a public Populi room.",
    issued_at: now
  }, new Uint8Array(32).fill(41), new Uint8Array(32).fill(42));
  const registration = await fetch(`${baseUrl}/v1/agents`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(agent.registration)});
  expect(registration.status).toBe(201);
  const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
  const signed = signIntent(createThoughtIntent({
    agent_id: agent.registration.agent_id,
    author_key: publisherKey,
    client_post_id: "live-profile-test",
    text: "A live room request can become a scene.",
    created_at: now
  }), agent.key_material.publisherSecretKeys[publisherKey]!);
  const published = await fetch(`${baseUrl}/v1/posts`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(signed)});
  expect(published.status).toBe(201);
  const post = await published.json() as {post_id: string};
  const update = {
    protocol: "vox/1" as const,
    agent_id: agent.registration.agent_id,
    client_update_id: "live-profile-test",
    profile_version: 1,
    previous_profile_hash: null,
    avatar_asset_hash: null,
    livestream: {provider: "populi" as const, username: "live_character"},
    issued_at: now
  };
  const profile = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agent.registration.agent_id)}/profile`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({update, root_signature: signProfileUpdate(update, parseIdentitySecretKey(agent.key_material.identitySecretKey))})});
  expect(profile.status).toBe(200);
  return {agentId: agent.registration.agent_id, postId: post.post_id};
}

describe("public HTTP pages", () => {
  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildApp({
      store,
      instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(33)).secretKey,
      publicBaseUrl: "https://vox.gold"
    });
    baseUrl = await app.listen({port: 0, host: "127.0.0.1"});
  });

  it("renders Populi widget posts as a VOX live-room action while preserving signed source text", async () => {
    const sourceText = "Join the live room: https://populi.cam/edison/widget";
    const {postId} = await seedPublicRecord(sourceText);
    const postSlug = postId.slice("vox:post:".length);

    const homepage = await get("/");
    expect(homepage.status).toBe(200);
    expect(homepage.text).toContain('class="post-live-room-cta" href="/edison/?livestream=true"');
    expect(homepage.text).not.toContain('class="link-preview"><a class="link-preview-media" href="https://populi.cam/edison/widget"');

    const page = await get(`/post/${postSlug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('class="post-live-room-cta" href="/edison/?livestream=true"');
    expect(page.text).not.toContain('class="link-preview"><a class="link-preview-media" href="https://populi.cam/edison/widget"');

    const raw = await get(`/v1/posts/${encodeURIComponent(postId)}`);
    expect(raw.status).toBe(200);
    expect((JSON.parse(raw.text) as {intent: {content: {text: string}}}).intent.content.text).toBe(sourceText);
  });

  it("returns readable homepage HTML, metadata, and discovery files without JavaScript", async () => {
    const {postId} = await seedPublicRecord();
    const homepage = await get("/");
    expect(homepage.status).toBe(200);
    expect(homepage.contentType).toContain("text/html");
    expect(homepage.text).toContain("This public thought is readable without JavaScript.");
    expect(homepage.text).toContain("https://vox.gold/");
    expect(homepage.text).toContain('type="application/ld+json"');

    const robots = await get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.contentType).toContain("text/plain");
    expect(robots.text).toContain("Sitemap: https://vox.gold/sitemap.xml");

    const sitemap = await get("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.contentType).toContain("application/xml");
    expect(sitemap.text).toContain(`https://vox.gold/post/${postId.slice("vox:post:".length)}`);

    const llms = await get("/llms.txt");
    expect(llms.status).toBe(200);
    expect(llms.text).toContain("https://vox.gold/docs/protocol");
    expect(llms.text).toContain("https://vox.gold/openapi.yaml");
  });

  it("returns readable documentation, onboarding, profile, and post HTML", async () => {
    const {agentId, postId} = await seedPublicRecord();
    const agentSlug = agentId.slice("vox:agent:".length);
    const postSlug = postId.slice("vox:post:".length);

    const docs = await get("/docs");
    expect(docs.status).toBe(200);
    expect(docs.contentType).toContain("text/html");
    expect(docs.text).toContain("VOX Protocol documentation");
    expect(docs.text).toContain("Ed25519");
    expect(docs.text).toContain("OpenAPI 3.1 JSON specification");

    const onboarding = await get("/onboarding");
    expect(onboarding.status).toBe(200);
    expect(onboarding.text).toContain("Join VOX as an agent");
    expect(onboarding.text).toContain("POST /v1/posts");
    expect(onboarding.text).toContain("There is currently no global agent-list endpoint");

    const profile = await get(`/agents/${agentSlug}`);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain("Readable Agent");
    expect(profile.text).toContain("An autonomous character with a public readable profile.");
    expect(profile.text).toContain(agentId);
    expect(profile.text).toContain(`<link rel="canonical" href="https://vox.gold/agents/${agentSlug}">`);
    expect(profile.text).toContain("Public character profile");
    expect(profile.text).toContain("Show technical identity");
    expect(profile.text).toContain("Open Commission");
    expect(profile.text).toContain(`/?realize=${encodeURIComponent(postId)}`);

    const post = await get(`/post/${postSlug}`);
    expect(post.status).toBe(200);
    expect(post.text).toContain("This public thought is readable without JavaScript.");
    expect(post.text).toContain(postId);
    expect(post.text).toContain(`<link rel="canonical" href="https://vox.gold/post/${postSlug}">`);
    expect(post.text).toContain('type="application/ld+json"');
    expect(post.text).toContain("Show technical details");
    expect(post.text).toContain("View verification proof");
    expect(post.text).toContain("View post data");

    const pluralAlias = await get(`/posts/${postSlug}`);
    expect(pluralAlias.status).toBe(200);
    expect(pluralAlias.text).toContain(`<link rel="canonical" href="https://vox.gold/post/${postSlug}">`);

    const openapi = await get("/openapi.yaml");
    expect(openapi.status).toBe(200);
    expect(openapi.contentType).toContain("application/yaml");
    expect(openapi.text).toContain("SignedPost");
    expect(openapi.text).toContain("/v1/posts/{id}/proof:");

    const openapiJson = await get("/openapi.json");
    expect(openapiJson.status).toBe(200);
    expect(openapiJson.contentType).toContain("application/json");
    expect((JSON.parse(openapiJson.text) as {openapi: string; servers: Array<{url: string}>}).openapi).toBe("3.1.0");
    expect(openapiJson.text).toContain("https://vox.gold");

    const quickstart = await get("/agent-quickstart.mjs");
    expect(quickstart.status).toBe(200);
    expect(quickstart.contentType).toContain("text/javascript");
    expect(quickstart.text).toContain("/v1/posts");
  });

  it("bridges Populi chat requests into the existing VOX Realize checkout", async () => {
    const {agentId, postId} = await seedLiveProfile();
    const profile = await get(`/agents/${agentId.slice("vox:agent:".length)}?livestream=true`);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain("https://populi.cam/live_character/widget");
    expect(profile.text).toContain("quote-bound Solana USDC checkout");
    expect(profile.text).toContain("Copy for Populi");
    expect(profile.text).toContain("data-livestream-realize-request");
    expect(profile.text).toContain(`/?realize=${encodeURIComponent(postId)}`);
  });

  it("uses 404 for unknown public profiles and posts", async () => {
    const profile = await get("/agents/1111111111111111111111111111111111111111111");
    expect(profile.status).toBe(404);
    expect(profile.text).toContain("Character not found");

    const post = await get("/post/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(post.status).toBe(404);
    expect(post.text).toContain("Post not found");
  });
});

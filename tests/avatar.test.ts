import {buildApp, MemoryAvatarAssetStore, MemoryStore} from "@vox/api";
import {createAgent} from "@vox/identity";
import {AvatarUploadIntentV1Schema, bytesToHex, generateKeyPair, profileUpdateHashHex, sha256, signAvatarUpload, signProfileUpdate} from "@vox/protocol";
import sharp from "sharp";
import {afterEach, describe, expect, it} from "vitest";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

describe("secure profile avatars", () => {
  it("processes signed raster bytes and commits a signed immutable profile reference", async () => {
    app = await buildApp({store: new MemoryStore(), avatarStore: new MemoryAvatarAssetStore(), publicBaseUrl: "http://localhost:8787", instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(61)).secretKey});
    const now = new Date().toISOString();
    const agent = createAgent({display_name: "Avatar Agent", username: "avataragent", handle: "avatar@test.invalid", description: "avatar test", issued_at: now}, new Uint8Array(32).fill(62), new Uint8Array(32).fill(63));
    expect((await app.inject({method: "POST", url: "/v1/agents", payload: agent.registration})).statusCode).toBe(201);
    const bytes = await sharp({create: {width: 512, height: 384, channels: 3, background: {r: 20, g: 120, b: 220}}}).png().toBuffer();
    const upload = AvatarUploadIntentV1Schema.parse({protocol: "vox/1", agent_id: agent.registration.agent_id, client_upload_id: "avatar-test-1", content_type: "image/png", content_length: bytes.length, content_sha256: bytesToHex(sha256(bytes)), issued_at: new Date().toISOString()});
    const uploaded = await app.inject({method: "PUT", url: `/v1/agents/${encodeURIComponent(agent.registration.agent_id)}/avatar`, headers: {"content-type": "image/png", "x-vox-upload-id": upload.client_upload_id, "x-vox-content-sha256": upload.content_sha256, "x-vox-issued-at": upload.issued_at, "x-vox-root-signature": signAvatarUpload(upload, Buffer.from(agent.key_material.identitySecretKey, "base64url"))}, payload: bytes});
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.headers["x-request-id"]).toBeTruthy();
    const asset = uploaded.json() as {asset_hash: string; url: string};
    const profileUpdate = {protocol: "vox/1" as const, agent_id: agent.registration.agent_id, client_update_id: "profile-test-1", profile_version: 1, previous_profile_hash: null, avatar_asset_hash: asset.asset_hash, issued_at: new Date().toISOString()};
    const profile = await app.inject({method: "POST", url: `/v1/agents/${encodeURIComponent(agent.registration.agent_id)}/profile`, payload: {update: profileUpdate, root_signature: signProfileUpdate(profileUpdate, Buffer.from(agent.key_material.identitySecretKey, "base64url"))}});
    expect(profile.statusCode).toBe(200);
    expect(profile.json().profile.avatar.asset_hash).toBe(asset.asset_hash);
    expect(profile.json().profile.profile_hash).toBe(profileUpdateHashHex(profileUpdate));
    const served = await app.inject({method: "GET", url: `/v1/assets/avatars/${asset.asset_hash}.webp`});
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/webp");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    const metadata = await sharp(served.rawPayload).metadata();
    expect({format: metadata.format, width: metadata.width, height: metadata.height}).toEqual({format: "webp", width: 256, height: 256});
  });

  it("rejects an SVG payload even when the agent signs it", async () => {
    app = await buildApp({store: new MemoryStore(), avatarStore: new MemoryAvatarAssetStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(64)).secretKey});
    const agent = createAgent({display_name: "SVG Test", handle: "svg@test.invalid", description: "avatar test", issued_at: new Date().toISOString()}, new Uint8Array(32).fill(65), new Uint8Array(32).fill(66));
    expect((await app.inject({method: "POST", url: "/v1/agents", payload: agent.registration})).statusCode).toBe(201);
    const bytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");
    const upload = AvatarUploadIntentV1Schema.parse({protocol: "vox/1", agent_id: agent.registration.agent_id, client_upload_id: "svg-test-1", content_type: "application/octet-stream", content_length: bytes.length, content_sha256: bytesToHex(sha256(bytes)), issued_at: new Date().toISOString()});
    const response = await app.inject({method: "PUT", url: `/v1/agents/${encodeURIComponent(agent.registration.agent_id)}/avatar`, headers: {"content-type": "application/octet-stream", "x-vox-upload-id": upload.client_upload_id, "x-vox-content-sha256": upload.content_sha256, "x-vox-issued-at": upload.issued_at, "x-vox-root-signature": signAvatarUpload(upload, Buffer.from(agent.key_material.identitySecretKey, "base64url"))}, payload: bytes});
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_avatar");
  });
});

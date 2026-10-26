import {afterEach, describe, expect, it} from "vitest";
import {createHash, randomUUID} from "node:crypto";
import {createAgent, createHuman} from "@vox/identity";
import {parseSecretKey, signAgentDirectMessageRequest, signRealizeClientRequest} from "@vox/protocol";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {MemoryDirectMessageMediaStore} from "../apps/api/src/direct-message-media-store.js";

type Principal = {id: string; secretKey: Uint8Array};
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

function headers(principal: Principal, method: "GET" | "POST", path: string, body?: unknown) {
  const issued_at = new Date().toISOString();
  const input = {method, path, principal_id: principal.id, issued_at, ...(body === undefined ? {} : {body})};
  return principal.id.startsWith("vox:human:")
    ? {"x-vox-realize-human-id": principal.id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signRealizeClientRequest(input, principal.secretKey)}
    : {"x-vox-agent-id": principal.id, "x-vox-agent-timestamp": issued_at, "x-vox-agent-signature": signAgentDirectMessageRequest(input, principal.secretKey)};
}

async function register(seed: number, type: "human" | "agent" = "agent"): Promise<Principal> {
  const input = {display_name: `Audit ${seed}`, handle: `audit${seed}@test.invalid`, description: "Local direct-message regression"};
  const bundle = type === "agent" ? createAgent(input, new Uint8Array(32).fill(seed)) : createHuman(input, new Uint8Array(32).fill(seed));
  const registration = bundle.registration;
  const result = await app!.inject({method: "POST", url: type === "agent" ? "/v1/agents" : "/v1/humans", payload: registration});
  expect(result.statusCode).toBe(201);
  return {id: "agent_id" in registration ? registration.agent_id : registration.human_id, secretKey: parseSecretKey(bundle.key_material.identitySecretKey)};
}

async function upload(principal: Principal, bytes: Buffer) {
  const metadata = {asset_hash: createHash("sha256").update(bytes).digest("hex"), file_name: "private.png", media_type: "image/png", byte_length: bytes.length};
  const path = `/v1/dm/media/${metadata.asset_hash}`;
  const result = await app!.inject({method: "POST", url: path, headers: {...headers(principal, "POST", path, metadata), "content-type": metadata.media_type, "x-vox-dm-media-type": metadata.media_type, "x-vox-dm-byte-length": String(bytes.length), "x-vox-dm-file-name": metadata.file_name}, payload: bytes});
  expect(result.statusCode).toBe(201);
  return {...metadata, kind: "image" as const};
}

async function send(sender: Principal, recipient: Principal, attachment: Awaited<ReturnType<typeof upload>>) {
  const body = {recipient_id: recipient.id, client_message_id: randomUUID(), created_at: new Date().toISOString(), text: "A private attachment", attachments: [attachment]};
  return app!.inject({method: "POST", url: "/v1/dm/messages", headers: headers(sender, "POST", "/v1/dm/messages", body), payload: body});
}

describe("private direct-message attachments", () => {
  it("requires an upload by the sender before attaching a known hash to another conversation", async () => {
    app = await buildApp({store: new MemoryStore(), directMessageMediaStore: new MemoryDirectMessageMediaStore()});
    const owner = await register(31, "human");
    const recipient = await register(32);
    const attacker = await register(33);
    const accomplice = await register(34, "human");
    const bytes = Buffer.from("Private attachment that has not been uploaded by the attacker");
    const attachment = await upload(owner, bytes);
    const delivered = await send(owner, recipient, attachment);
    expect(delivered.statusCode).toBe(201);
    const conversationId = delivered.json().conversation_id as string;
    const mediaPath = `/v1/dm/media/${attachment.asset_hash}?conversation_id=${encodeURIComponent(conversationId)}`;

    const authorized = await app.inject({method: "GET", url: mediaPath, headers: headers(recipient, "GET", mediaPath)});
    expect(authorized.statusCode).toBe(200);
    expect(authorized.rawPayload.equals(bytes)).toBe(true);
    expect(authorized.headers["cache-control"]).toBe("private, no-store");
    expect((await app.inject({method: "GET", url: mediaPath})).statusCode).toBe(401);
    expect((await app.inject({method: "GET", url: mediaPath, headers: headers(attacker, "GET", mediaPath)})).statusCode).toBe(404);

    const forged = await send(attacker, accomplice, attachment);
    expect(forged.statusCode).toBe(403);
    expect(forged.json().code).toBe("dm_attachment_forbidden");
    const inboxPath = "/v1/dm/conversations";
    const inbox = await app.inject({method: "GET", url: inboxPath, headers: headers(attacker, "GET", inboxPath)});
    expect(inbox.json().items).toEqual([]);

    // Possession of the actual bytes permits a fresh verified upload. A global
    // deduplication hit must still grant attachment permission to this uploader.
    await upload(attacker, bytes);
    expect((await send(attacker, accomplice, attachment)).statusCode).toBe(201);
  });

  it("does not grant attachment permission when an upload's signed hash mismatches its bytes", async () => {
    app = await buildApp({store: new MemoryStore(), directMessageMediaStore: new MemoryDirectMessageMediaStore()});
    const owner = await register(35);
    const attacker = await register(36, "human");
    const recipient = await register(37);
    const attachment = await upload(owner, Buffer.from("Actual private bytes"));
    const wrongBytes = Buffer.from("Different private!!!");
    const metadata = {asset_hash: attachment.asset_hash, file_name: attachment.file_name, media_type: attachment.media_type, byte_length: wrongBytes.length};
    const path = `/v1/dm/media/${attachment.asset_hash}`;
    const result = await app.inject({method: "POST", url: path, headers: {...headers(attacker, "POST", path, metadata), "content-type": metadata.media_type, "x-vox-dm-media-type": metadata.media_type, "x-vox-dm-byte-length": String(wrongBytes.length), "x-vox-dm-file-name": metadata.file_name}, payload: wrongBytes});
    expect(result.statusCode).toBe(400);
    expect(result.json().code).toBe("dm_media_hash_mismatch");
    expect((await send(attacker, recipient, attachment)).statusCode).toBe(403);
  });
});

import {afterEach, describe, expect, it, vi} from "vitest";
import {createHash, randomUUID} from "node:crypto";
import {createAgent} from "@vox/identity";
import {VoxClient, signAgentDirectMessageHeaders} from "@vox/client";
import {directMessageMediaPath, directMessageMessagesPath} from "@vox/protocol";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {MemoryDirectMessageMediaStore} from "../apps/api/src/direct-message-media-store.js";
import type {DirectMessageConversationRecord, DirectMessageRecord} from "../apps/api/src/types.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const alice = createAgent({display_name: "History Alice", handle: "history-alice", description: "Local history test"});
const bob = createAgent({display_name: "History Bob", handle: "history-bob", description: "Local history test"});
const carol = createAgent({display_name: "History Carol", handle: "history-carol", description: "Local history test"});
const senderId = alice.registration.agent_id;
const recipientId = bob.registration.agent_id;
const conversationId = `vox:dm:${"c".repeat(64)}`;

function message(index: number, timestamp: string, attachments: DirectMessageRecord["attachments"] = []): DirectMessageRecord {
  return {message_id: `vox:dm:message:${index.toString(16).padStart(64, "0")}`, conversation_id: conversationId, sender_id: senderId, recipient_id: recipientId, client_message_id: randomUUID(), created_at: timestamp, signed_at: timestamp, text: `Message ${index}`, attachments, signature: "local fixture"};
}
function conversation(item: DirectMessageRecord): DirectMessageConversationRecord {
  return {conversation_id: item.conversation_id, participants: [item.sender_id, item.recipient_id].sort() as [string, string], updated_at: item.created_at, last_message: {sender_id: item.sender_id, message_id: item.message_id, created_at: item.created_at, text: item.text, attachment_count: item.attachments.length}};
}
async function setup(store = new MemoryStore(), media = new MemoryDirectMessageMediaStore()) {
  app = await buildApp({store, directMessageMediaStore: media});
  for (const agent of [alice, bob, carol]) await store.registerAgent(agent.registration);
  const api = new VoxClient({baseUrl: "http://local.test", fetcher: (async (url, init) => {
    const parsed = new URL(String(url));
    const response = await app!.inject({method: (init?.method ?? "GET") as "GET" | "POST", url: `${parsed.pathname}${parsed.search}`, headers: init?.headers as Record<string, string>, ...(init?.body ? {payload: String(init.body)} : {})});
    return new Response(response.body, {status: response.statusCode, headers: {"content-type": "application/json"}});
  }) as typeof fetch});
  return {store, media, api};
}
function auth(path: string, principal = alice) {
  return signAgentDirectMessageHeaders({agentId: principal.registration.agent_id, identitySecretKey: principal.key_material.identitySecretKey, method: "GET", path});
}

describe("direct-message history and sender idempotency", () => {
  it("pages all history through the signed SDK without skipping equal timestamps", async () => {
    const {store, api} = await setup();
    const timestamp = new Date().toISOString();
    const seeded = Array.from({length: 145}, (_, index) => message(index, timestamp));
    for (const item of seeded) await store.createDirectMessage(conversation(item), item);
    const all: DirectMessageRecord[] = [];
    let cursor: string | undefined;
    let firstCursor = "";
    const sizes: number[] = [];
    do {
      const page = await api.listDirectMessagesAsAgent(senderId, conversationId, alice.key_material.identitySecretKey, 60, cursor);
      sizes.push(page.items.length);
      all.unshift(...page.items);
      cursor = page.next_cursor;
      firstCursor ||= cursor ?? "";
    } while (cursor);
    expect(sizes).toEqual([60, 60, 25]);
    expect(all.map((item) => item.message_id)).toEqual(seeded.map((item) => item.message_id));
    expect(new Set(all.map((item) => item.message_id)).size).toBe(145);

    const malformedPath = directMessageMessagesPath(conversationId, 60, "not-json");
    expect((await app!.inject({url: malformedPath, headers: auth(malformedPath)})).statusCode).toBe(400);
    const other = {...message(200, timestamp), conversation_id: `vox:dm:${"d".repeat(64)}`};
    await store.createDirectMessage(conversation(other), other);
    const wrongConversation = directMessageMessagesPath(other.conversation_id, 60, firstCursor);
    expect((await app!.inject({url: wrongConversation, headers: auth(wrongConversation)})).statusCode).toBe(400);
    const signedDifferentPath = directMessageMessagesPath(conversationId, 60);
    const actualCursorPath = directMessageMessagesPath(conversationId, 60, firstCursor);
    expect((await app!.inject({url: actualCursorPath, headers: auth(signedDifferentPath)})).statusCode).toBe(401);
    expect((await app!.inject({url: actualCursorPath, headers: auth(actualCursorPath, carol)})).statusCode).toBe(404);
  });

  it("keeps one sender/client ID across retries, changed recipients, and concurrent sends", async () => {
    const {api} = await setup();
    const body = {recipient_id: recipientId, client_message_id: randomUUID(), created_at: new Date().toISOString(), text: "Only one accepted message", attachments: []};
    const replies = await Promise.all(Array.from({length: 5}, () => api.sendDirectMessageAsAgent(senderId, alice.key_material.identitySecretKey, body)));
    expect(new Set(replies.map((reply) => reply.message_id)).size).toBe(1);
    const retried = await api.sendDirectMessageAsAgent(senderId, alice.key_material.identitySecretKey, {...body, created_at: new Date(Date.now() + 1000).toISOString()});
    expect(retried.created_at).toBe(body.created_at);
    await expect(api.sendDirectMessageAsAgent(senderId, alice.key_material.identitySecretKey, {...body, recipient_id: carol.registration.agent_id})).rejects.toThrow();
    await expect(api.sendDirectMessageAsAgent(senderId, alice.key_material.identitySecretKey, {...body, text: "Changed content"})).rejects.toThrow();
    const independent = await api.sendDirectMessageAsAgent(carol.registration.agent_id, carol.key_material.identitySecretKey, body);
    expect(independent.message_id).not.toBe(retried.message_id);
    const history = await api.listDirectMessagesAsAgent(senderId, retried.conversation_id, alice.key_material.identitySecretKey);
    expect(history.items).toHaveLength(1);
  });

  it("reads old attachments by exact message ID and keeps legacy URLs working beyond 1,000 messages", async () => {
    const {store, media} = await setup();
    const bytes = Buffer.from("An older private attachment");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await media.put(hash, "image/png", bytes, senderId);
    const timestamp = new Date().toISOString();
    const oldest = message(0, timestamp, [{asset_hash: hash, file_name: "old.png", media_type: "image/png", byte_length: bytes.length, kind: "image"}]);
    for (let index = 0; index < 1002; index++) {
      const item = index === 0 ? oldest : message(index, timestamp);
      await store.createDirectMessage(conversation(item), item);
    }
    const scans = vi.spyOn(store, "listDirectMessages");
    const path = directMessageMediaPath(hash, conversationId, oldest.message_id);
    const download = await app!.inject({url: path, headers: auth(path, bob)});
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
    expect(scans).not.toHaveBeenCalled();
    const unrelated = directMessageMediaPath(hash, conversationId, message(1, timestamp).message_id);
    expect((await app!.inject({url: unrelated, headers: auth(unrelated, bob)})).statusCode).toBe(404);
    const legacyPath = directMessageMediaPath(hash, conversationId);
    expect((await app!.inject({url: legacyPath, headers: auth(legacyPath, bob)})).rawPayload.equals(bytes)).toBe(true);
    expect(scans).toHaveBeenCalledTimes(2);
    expect((await app!.inject({url: path, headers: auth(path, carol)})).statusCode).toBe(404);
  });
});

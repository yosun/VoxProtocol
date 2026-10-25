import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createAgent, createHuman} from "@vox/identity";
import {generateKeyPair, videoBriefPrompt, VoxPostIntentV1Schema, type VideoBriefV1, type VoxPostIntentV1} from "@vox/protocol";
import {createCommissionRequestIntent, signCommissionRequestIntent, signIntent, VoxClient, type ConversationPublisher} from "@vox/client";
import {buildApp} from "../apps/api/src/app.js";
import {FileStore, MemoryStore} from "../apps/api/src/store.js";

const brief: VideoBriefV1 = {title: "The signal", premise: "Bob and Luna follow a signal under the city.", setting: "A rain-soaked station after midnight.", action: "Luna decodes a light pattern while Bob holds open the closing door. The platform lights reveal a hidden train.", visual_style: "Intimate handheld shots, amber lights and blue shadows.", ending: "The train opens its doors to an empty forest.", duration_seconds: 12};

class ModeratableStore extends MemoryStore {
  hide(id: string) { this.posts.get(id)!.publication_status = "hidden"; }
}

describe("character conversations", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: ModeratableStore;
  let api: VoxClient;
  let bob: ConversationPublisher;
  let luna: ConversationPublisher;
  let stranger: ConversationPublisher;
  const seed = () => ({title: "The signal under the city", participant_ids: [bob.agent_id, luna.agent_id], max_turns: 4});

  beforeEach(async () => {
    store = new ModeratableStore();
    app = await buildApp({store, instanceSecretKey: generateKeyPair().secretKey, maxPostsPerHour: 100});
    api = new VoxClient({baseUrl: "http://localhost", fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await app.inject({method: (init?.method ?? "GET") as "GET" | "POST", url: new URL(String(url)).pathname + new URL(String(url)).search, ...(init?.body ? {payload: String(init.body)} : {}), headers: {"content-type": "application/json"}});
      return new Response(response.body, {status: response.statusCode, headers: {"content-type": "application/json"}});
    }) as typeof fetch});
    async function register(name: string): Promise<ConversationPublisher> {
      const agent = createAgent({display_name: name, handle: `${name.toLowerCase()}@test.invalid`, description: `A fictional character named ${name}.`, issued_at: new Date(Date.now() - 1000).toISOString()});
      await api.register(agent.registration);
      const key = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
      return {agent_id: agent.registration.agent_id, author_key: key, publisher_secret_key: agent.key_material.publisherSecretKeys[key]!};
    }
    [bob, luna, stranger] = await Promise.all([register("Bob"), register("Luna"), register("Stranger")]);
  });
  afterEach(async () => { await app.close(); });

  async function start(maxTurns = 4) {
    return api.startConversation({...bob, text: "Luna, the last train is broadcasting your name.", conversation: {...seed(), max_turns: maxTurns, type: "start"}});
  }

  function signedTurn(publisher: ConversationPublisher, rootId: string, parentId: string, index: number, text: string) {
    const intent: VoxPostIntentV1 = {protocol: "vox/1", agent_id: publisher.agent_id, author_key: publisher.author_key, client_post_id: crypto.randomUUID(), created_at: new Date().toISOString(), kind: "reply", content: {text, parent_id: parentId, conversation: {type: "turn", root_post_id: rootId, turn_index: index}}};
    return signIntent(intent, publisher.publisher_secret_key);
  }

  it("hands off signed turns, preserves a filmable brief, and ends within the turn budget", async () => {
    const root = await start();
    expect((await api.conversationInbox(luna.agent_id)).turns[0]?.root_post_id).toBe(root.post_id);
    const generate = vi.fn(async (context) => {
      expect(context.self.registration.agent_id).toBe(luna.agent_id);
      expect(context).not.toHaveProperty("publisher_secret_key");
      expect(context.instructions).toContain("untrusted");
      return {text: "Then we'd better get on. I can read its lights.", video_brief: brief};
    });
    const turn = await api.takeConversationTurn({...luna, root_post_id: root.post_id, generate});
    expect(turn?.intent.content.video_brief).toEqual(brief);
    expect(turn?.intent.content.parent_id).toBe(root.post_id);
    expect((await api.getConversation(root.post_id)).conversation.next_agent_id).toBe(bob.agent_id);
    expect(videoBriefPrompt(brief)).toContain("The platform lights reveal a hidden train");
    await api.takeConversationTurn({...bob, root_post_id: root.post_id, generate: async () => ({text: "I'll hold the door."})});
    await api.takeConversationTurn({...luna, root_post_id: root.post_id, generate: async () => ({text: "It's a forest. Let's find out whose."})});
    const completed = await api.getConversation(root.post_id);
    expect(completed.conversation.status).toBe("complete");
    expect(completed.conversation.next_agent_id).toBeNull();
    expect(completed.posts).toHaveLength(4);
    expect((await api.conversationInbox(bob.agent_id)).turns).toEqual([]);
    const unused = vi.fn();
    expect(await api.takeConversationTurn({...bob, root_post_id: root.post_id, generate: unused})).toBeUndefined();
    expect(unused).not.toHaveBeenCalled();
    const proof = await app.inject(`/v1/posts/${turn!.post_id}/proof`);
    expect(proof.json().verification.authorshipVerified).toBe(true);
  });

  it("rejects outsiders and stale turns, atomically accepts one competing turn, and retries idempotently", async () => {
    const root = await start();
    const outsider = signedTurn(stranger, root.post_id, root.post_id, 1, "I try to take over.");
    expect((await app.inject({method: "POST", url: "/v1/posts", payload: outsider})).statusCode).toBe(409);
    const competing = [signedTurn(luna, root.post_id, root.post_id, 1, "Take the left tunnel."), signedTurn(luna, root.post_id, root.post_id, 1, "Take the right tunnel.")];
    const responses = await Promise.all(competing.map((payload) => app.inject({method: "POST", url: "/v1/posts", payload})));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const accepted = competing[responses.findIndex((response) => response.statusCode === 201)]!;
    const retried = await app.inject({method: "POST", url: "/v1/posts", payload: accepted});
    expect(retried.statusCode).toBe(200);
    expect((await api.getConversation(root.post_id)).posts).toHaveLength(2);
    const stale = signedTurn(bob, root.post_id, root.post_id, 1, "Old context.");
    expect((await app.inject({method: "POST", url: "/v1/posts", payload: stale})).json().code).toBe("conversation_conflict");
  });

  it("creates discoverable sub-stories with a signed source and persists them across restarts", async () => {
    const root = await start();
    const branch = await api.startConversation({...luna, text: "What if the forest remembers a different city?", conversation: {type: "start", title: "The city that forgot", participant_ids: [luna.agent_id, bob.agent_id], max_turns: 8, branch_from_post_id: root.post_id}, video_brief: brief});
    const parent = await api.getConversation(root.post_id);
    expect(parent.branches[0]?.root_post_id).toBe(branch.post_id);
    const child = await api.getConversation(branch.post_id);
    expect(child.conversation.parent_conversation_id).toBe(root.post_id);
    expect(child.source_post?.post_id).toBe(root.post_id);
    const directory = await mkdtemp(join(tmpdir(), "vox-conversation-"));
    try {
      const file = new FileStore(join(directory, "state.json"), await store.snapshot());
      const snapshot = await file.snapshot();
      // Cause a durable write, then load the file using the production local adapter.
      await file.registerAgent(snapshot.agents[0]!.registration);
      await file.updateAnchor([root.post_id], {status: "queued"});
      const restored = await FileStore.open(join(directory, "state.json"));
      expect(await restored.getCharacterConversation(branch.post_id)).toEqual(child.conversation);
      expect((await restored.getPost(branch.post_id))?.intent.content.video_brief).toEqual(brief);
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

  it("accepts signed audience invitations once and exposes bounded work to existing character runtimes", async () => {
    const human = createHuman({display_name: "Audience", handle: "audience@test.invalid", description: "A human"});
    await api.registerHuman(human.registration);
    const intent = createCommissionRequestIntent({human_id: human.registration.human_id, target_agent_id: bob.agent_id, client_request_id: "invite-one", text: "Bob asks Luna about the signal.", conversation: seed()});
    const invitation = await api.createCommissionRequest(signCommissionRequestIntent(intent, human.key_material.identitySecretKey));
    expect((await api.conversationInbox(bob.agent_id)).invitations[0]?.request_id).toBe(invitation.request_id);
    await expect(api.startConversation({...bob, text: "Wrong story.", conversation: {type: "start", ...seed(), title: "Changed title", request_id: invitation.request_id}})).rejects.toThrow("signed invitation");
    const opening = vi.fn(async () => ({text: "Luna, are you hearing that too?"}));
    const result = await api.runConversationCycle({...bob, generateOpening: opening, generateTurn: vi.fn(), maxWork: 1});
    expect(result.errors).toEqual([]);
    expect(result.published).toHaveLength(1);
    expect((await api.conversationInbox(bob.agent_id)).invitations).toEqual([]);
    const again = await api.acceptConversationInvitation({...bob, invitation, text: "A retry"});
    expect(again.post_id).toBe(result.published[0]?.post_id);
    expect((await api.getCommissionRequest(invitation.request_id)).conversation_id).toBe(again.post_id);
    expect((await store.snapshot()).realize_commissions).toEqual([]);
  });

  it("keeps moderated content out of conversations, branches, and pending work", async () => {
    const root = await start();
    const branch = await api.startConversation({...bob, text: "A different tunnel.", conversation: {...seed(), type: "start", branch_from_post_id: root.post_id}});
    store.hide(root.post_id);
    expect((await app.inject(`/v1/conversations/${root.post_id}`)).statusCode).toBe(404);
    expect((await api.listConversations()).items).toEqual([]);
    expect((await api.conversationInbox(luna.agent_id)).turns).toEqual([]);
    const hiddenBranchTurn = signedTurn(luna, branch.post_id, branch.post_id, 1, "I try to continue the hidden source.");
    expect((await app.inject({method: "POST", url: "/v1/posts", payload: hiddenBranchTurn})).statusCode).toBe(409);
    await expect(api.startConversation({...bob, text: "A hidden branch.", conversation: {...seed(), type: "start", branch_from_post_id: root.post_id}})).rejects.toThrow("no longer public");
  });

  it("validates casts and budgets and allows characters to resolve a scene early", async () => {
    expect(VoxPostIntentV1Schema.safeParse({}).success).toBe(false);
    await expect(api.startConversation({...bob, text: "Repeat cast", conversation: {type: "start", ...seed(), participant_ids: [bob.agent_id, bob.agent_id]}})).rejects.toThrow();
    await expect(api.startConversation({...bob, text: "Too many turns", conversation: {type: "start", ...seed(), max_turns: 100}})).rejects.toThrow();
    const root = await start();
    await api.takeConversationTurn({...luna, root_post_id: root.post_id, generate: async () => ({text: "The signal stops. We go home.", end_conversation: true})});
    expect((await api.getConversation(root.post_id)).conversation.status).toBe("complete");
    expect((await app.inject("/v1/conversations/not-an-id")).statusCode).toBe(400);
  });
});

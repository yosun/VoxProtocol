import type {FastifyInstance} from "fastify";
import {canonicalBytes, conversationRootId, type CharacterConversationRecord, type VoxPostIntentV1} from "@vox/protocol";
import {HttpError} from "./errors.js";
import type {CommissionRequestRecord, PublishInput, StoredPost, VoxStore} from "./types.js";

export class ConversationConflict extends Error {}

/** Called inside each store's publication transaction, before any writes. */
export function advanceConversation(input: PublishInput, current: CharacterConversationRecord | undefined, history: StoredPost[], branchSource?: StoredPost, invitation?: CommissionRequestRecord): CharacterConversationRecord | undefined {
  const metadata = input.signed.intent.content.conversation;
  if (!metadata) return undefined;
  const fail = (message: string): never => { throw new ConversationConflict(message); };
  const sourceId = metadata.type === "start" ? metadata.branch_from_post_id : current?.branch_from_post_id;
  if (sourceId && branchSource?.publication_status !== "published") fail("sub-story source is no longer public");
  if (metadata.type === "start") {
    if (metadata.request_id && (!invitation || !invitation.conversation_pending || invitation.conversation_id)) fail("conversation invitation has already been answered or is unavailable");
    return {
      root_post_id: input.post_id, title: metadata.title, participant_ids: metadata.participant_ids,
      max_turns: metadata.max_turns, post_ids: [input.post_id], next_agent_id: metadata.participant_ids[1]!,
      status: "active", created_at: input.accepted_at, updated_at: input.accepted_at,
      ...(metadata.branch_from_post_id ? {branch_from_post_id: metadata.branch_from_post_id} : {}),
      ...(branchSource && conversationRootId(branchSource) ? {parent_conversation_id: conversationRootId(branchSource)!} : {}),
      ...(metadata.request_id ? {request_id: metadata.request_id} : {})
    };
  }
  if (!current) return fail("conversation not found");
  if (history.length !== current.post_ids.length || history.some((post) => post.publication_status !== "published")) fail("conversation history is no longer public");
  if (current.status !== "active") fail("conversation is complete; start a sub-story to continue");
  if (current.next_agent_id !== input.signed.intent.agent_id) fail("it is another character's turn");
  if (metadata.turn_index !== current.post_ids.length || input.signed.intent.content.parent_id !== current.post_ids.at(-1)) fail("conversation advanced; reload before replying");
  const postIds = [...current.post_ids, input.post_id];
  const complete = postIds.length >= current.max_turns || metadata.end_conversation === true;
  return {...current, post_ids: postIds, status: complete ? "complete" : "active", next_agent_id: complete ? null : current.participant_ids[postIds.length % current.participant_ids.length]!, updated_at: input.accepted_at};
}

export async function validateConversationPost(store: VoxStore, intent: VoxPostIntentV1): Promise<void> {
  const metadata = intent.content.conversation;
  if (metadata?.type !== "start") return;
  const cast = await Promise.all(metadata.participant_ids.map((id) => store.getAgent(id)));
  if (cast.some((agent) => !agent)) throw new HttpError(404, "character_not_found", "every conversation participant must be registered");
  if (metadata.request_id) {
    const invitation = await store.getCommissionRequest(metadata.request_id);
    const expected = invitation?.intent.content.conversation;
    const actual = {title: metadata.title, participant_ids: metadata.participant_ids, max_turns: metadata.max_turns};
    if (!invitation || invitation.intent.target_agent_id !== intent.agent_id || !expected || Buffer.compare(Buffer.from(canonicalBytes(expected)), Buffer.from(canonicalBytes(actual))) !== 0 || invitation.intent.content.source_post_id !== metadata.branch_from_post_id) {
      throw new HttpError(409, "invitation_mismatch", "conversation must match the audience's signed invitation");
    }
  }
}

export async function publicConversation(store: VoxStore, conversation: CharacterConversationRecord): Promise<StoredPost[] | undefined> {
  const posts = await Promise.all(conversation.post_ids.map((id) => store.getPost(id)));
  if (posts.some((post) => !post || post.publication_status !== "published")) return undefined;
  if (conversation.branch_from_post_id) {
    const source = await store.getPost(conversation.branch_from_post_id);
    if (source?.publication_status !== "published") return undefined;
  }
  return posts as StoredPost[];
}

export function registerConversationRoutes(app: FastifyInstance, store: VoxStore): void {
  app.get("/v1/conversations", async (request) => {
    const query = request.query as {limit?: string; agent_id?: string};
    if (query.agent_id && !/^vox:agent:[A-Za-z0-9_-]{43}$/.test(query.agent_id)) throw new HttpError(400, "invalid_agent_id", "invalid character ID");
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 100);
    const candidates = await store.listCharacterConversations(limit, query.agent_id ? {agent_id: query.agent_id} : undefined);
    const visible = await Promise.all(candidates.map(async (item) => await publicConversation(store, item) ? item : undefined));
    return {items: visible.filter((item) => !!item)};
  });
  app.get("/v1/conversations/:id", async (request) => {
    const id = (request.params as {id: string}).id;
    if (!/^vox:post:[0-9a-f]{64}$/.test(id)) throw new HttpError(400, "invalid_conversation_id", "invalid conversation ID");
    const conversation = await store.getCharacterConversation(id);
    const posts = conversation && await publicConversation(store, conversation);
    if (!conversation || !posts) throw new HttpError(404, "conversation_not_found", "conversation is not publicly available");
    const [participants, branches, source] = await Promise.all([
      Promise.all(conversation.participant_ids.map((agentId) => store.getAgent(agentId))),
      store.listCharacterConversations(50, {parent_conversation_id: id}),
      conversation.branch_from_post_id ? store.getPost(conversation.branch_from_post_id) : undefined
    ]);
    const visibleBranches = await Promise.all(branches.map(async (branch) => await publicConversation(store, branch) ? branch : undefined));
    return {conversation, posts, participants: participants.filter((agent) => !!agent), branches: visibleBranches.filter((branch) => !!branch), ...(source?.publication_status === "published" ? {source_post: source} : {})};
  });
  app.get("/v1/agents/:id/conversation-inbox", async (request) => {
    const agentId = (request.params as {id: string}).id;
    if (!/^vox:agent:[A-Za-z0-9_-]{43}$/.test(agentId)) throw new HttpError(400, "invalid_agent_id", "invalid character ID");
    if (!await store.getAgent(agentId)) throw new HttpError(404, "agent_not_found", "character not found");
    const [candidates, invitations] = await Promise.all([
      store.listCharacterConversations(50, {next_agent_id: agentId}), store.listConversationInvitations(agentId, 30)
    ]);
    const turns = await Promise.all(candidates.map(async (conversation) => await publicConversation(store, conversation) ? conversation : undefined));
    const visibleInvitations = await Promise.all(invitations.map(async (invitation) => {
      const sourceId = invitation.intent.content.source_post_id;
      return !sourceId || (await store.getPost(sourceId))?.publication_status === "published" ? invitation : undefined;
    }));
    return {turns: turns.filter((turn) => !!turn), invitations: visibleInvitations.filter((item) => !!item)};
  });
}

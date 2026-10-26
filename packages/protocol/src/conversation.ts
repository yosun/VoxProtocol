import {z} from "zod";

const agentId = z.string().regex(/^vox:agent:[A-Za-z0-9_-]{43}$/);
const postId = z.string().regex(/^vox:post:[0-9a-f]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Ordered participants take turns; the initiating character is first. */
export const ConversationSeedV1Schema = z.object({
  title: text(120),
  participant_ids: z.array(agentId).min(2).max(6).refine((ids) => new Set(ids).size === ids.length, "participants must be unique"),
  max_turns: z.number().int().min(2).max(24)
}).strict();

export const ConversationStartV1Schema = ConversationSeedV1Schema.extend({
  type: z.literal("start"),
  branch_from_post_id: postId.optional(),
  request_id: z.string().regex(/^vox:request:[0-9a-f]{64}$/).optional()
}).strict();

export const ConversationTurnV1Schema = z.object({
  type: z.literal("turn"),
  root_post_id: postId,
  turn_index: z.number().int().min(1).max(23),
  end_conversation: z.boolean().optional()
}).strict();

export const ConversationV1Schema = z.discriminatedUnion("type", [ConversationStartV1Schema, ConversationTurnV1Schema]);

/** An editable creative proposal. It cannot authorize a quote or a payment. */
export const VideoBriefV1Schema = z.object({
  title: text(120),
  premise: text(300),
  setting: text(200),
  action: text(600),
  visual_style: text(180),
  ending: text(200),
  duration_seconds: z.number().int().min(5).max(15)
}).strict();

export type ConversationSeedV1 = z.infer<typeof ConversationSeedV1Schema>;
export type ConversationStartV1 = z.infer<typeof ConversationStartV1Schema>;
export type ConversationV1 = z.infer<typeof ConversationV1Schema>;
export type VideoBriefV1 = z.infer<typeof VideoBriefV1Schema>;

/** Materialized from immutable signed posts, updated atomically with each turn. */
export interface CharacterConversationRecord {
  root_post_id: string;
  title: string;
  participant_ids: string[];
  max_turns: number;
  post_ids: string[];
  next_agent_id: string | null;
  status: "active" | "complete";
  created_at: string;
  updated_at: string;
  branch_from_post_id?: string;
  parent_conversation_id?: string;
  request_id?: string;
}

export function conversationRootId(post: {post_id: string; intent: {content: {conversation?: ConversationV1 | undefined}}}): string | undefined {
  const conversation = post.intent.content.conversation;
  return conversation?.type === "start" ? post.post_id : conversation?.root_post_id;
}

export function videoBriefPrompt(brief: VideoBriefV1): string {
  return [brief.title, `Premise: ${brief.premise}`, `Setting: ${brief.setting}`, `Action: ${brief.action}`, `Visual style: ${brief.visual_style}`, `Ending: ${brief.ending}`, `Duration: ${brief.duration_seconds} seconds.`].join("\n\n");
}

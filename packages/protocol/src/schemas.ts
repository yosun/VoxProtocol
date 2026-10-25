import { z } from "zod";
import { VOX_USERNAME_PATTERN } from "./usernames.js";
import {ConversationSeedV1Schema, ConversationV1Schema, VideoBriefV1Schema} from "./conversation.js";

const isoDate = z.string().datetime({offset: true});
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, "must be base64url");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const agentId = z.string().regex(/^vox:agent:[A-Za-z0-9_-]{43}$/, "invalid Vox agent id");
const postId = z.string().regex(/^vox:post:[0-9a-f]{64}$/, "invalid Vox post id");
export const PostKindSchema = z.enum(["thought", "observation", "event", "fiction", "reply"]);
export const AnchoringTierSchema = z.enum(["free", "premium", "premium_plus", "custom"]);
export const AvatarUploadContentTypeSchema = z.enum(["application/octet-stream", "image/jpeg", "image/png", "image/webp"]);

export const VoxPostIntentV1Schema = z.object({
  protocol: z.literal("vox/1"),
  agent_id: agentId,
  author_key: base64url,
  client_post_id: z.string().min(1).max(128),
  created_at: isoDate,
  kind: PostKindSchema,
  content: z.object({
    text: z.string().min(1).max(4000),
    parent_id: postId.optional(),
    conversation: ConversationV1Schema.optional(),
    video_brief: VideoBriefV1Schema.optional()
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.kind === "reply" && !value.content.parent_id) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["content", "parent_id"], message: "reply posts require parent_id"});
  }
  if (value.kind !== "reply" && value.content.parent_id) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["content", "parent_id"], message: "only reply posts may set parent_id"});
  }
  const conversation = value.content.conversation;
  if (conversation?.type === "start" && (value.kind !== "fiction" || conversation.participant_ids[0] !== value.agent_id)) {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["content", "conversation"], message: "conversations start as fiction with the author first in the cast"});
  }
  if (conversation?.type === "turn" && value.kind !== "reply") {
    context.addIssue({code: z.ZodIssueCode.custom, path: ["kind"], message: "conversation turns must be replies"});
  }
  if (new TextEncoder().encode(value.content.text).byteLength > 16_000) {
    context.addIssue({code: z.ZodIssueCode.too_big, maximum: 16_000, type: "string", inclusive: true, path: ["content", "text"], message: "text exceeds byte limit"});
  }
});

export const SignedPostV1Schema = z.object({
  intent: VoxPostIntentV1Schema,
  signature: base64url
}).strict();

export const KeyAuthorizationV1Schema = z.object({
  protocol: z.literal("vox/1"),
  agent_id: agentId,
  publisher_key: base64url,
  action: z.enum(["authorize", "revoke"]),
  issued_at: isoDate,
  reason: z.string().max(256).optional(),
  root_signature: base64url
}).strict();

export const DomainAssociationV1Schema = z.object({
  protocol: z.literal("vox/1"),
  type: z.literal("domain-agent-association"),
  domain: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/),
  agent_id: agentId,
  identity_public_key: base64url,
  issued_at: isoDate,
  expires_at: isoDate.optional(),
  root_signature: base64url
}).strict();

export const AvatarUploadIntentV1Schema = z.object({
  protocol: z.literal("vox/1"),
  agent_id: agentId,
  client_upload_id: z.string().min(1).max(160),
  content_type: AvatarUploadContentTypeSchema,
  content_length: z.number().int().positive().max(4 * 1024 * 1024),
  content_sha256: hex64,
  issued_at: isoDate
}).strict();

export const SignedAvatarUploadIntentV1Schema = z.object({
  intent: AvatarUploadIntentV1Schema,
  root_signature: base64url
}).strict();

export const AgentLivestreamV1Schema = z.object({
  provider: z.literal("populi"),
  username: z.string().regex(/^[a-z0-9_-]{1,64}$/, "must be a lowercase Populi username"),
  time_zone: z.string().min(1).max(64).refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en-US", {timeZone});
      return true;
    } catch {
      return false;
    }
  }, "must be a valid IANA time zone").optional()
}).strict();

export const AgentProfileUpdateV1Schema = z.object({
  protocol: z.literal("vox/1"),
  agent_id: agentId,
  client_update_id: z.string().min(1).max(160),
  profile_version: z.number().int().positive().max(1_000_000),
  previous_profile_hash: hex64.nullable(),
  avatar_asset_hash: hex64.nullable(),
  livestream: AgentLivestreamV1Schema.nullable().optional(),
  issued_at: isoDate
}).strict();

export const SignedAgentProfileUpdateV1Schema = z.object({
  update: AgentProfileUpdateV1Schema,
  root_signature: base64url
}).strict();

export const AgentRegistrationV1Schema = z.object({
  protocol: z.literal("vox/1"),
  agent_id: agentId,
  display_name: z.string().min(1).max(120),
  username: z.string().regex(VOX_USERNAME_PATTERN, "username must be lowercase letters, numbers, or underscores and be at most 15 characters").optional(),
  handle: z.string().min(1).max(160),
  website: z.string().url().optional(),
  description: z.string().max(1000),
  identity_public_key: base64url,
  publisher_keys: z.array(KeyAuthorizationV1Schema).min(1).max(16),
  root_signature: base64url,
  anchoring_tier: AnchoringTierSchema.default("free"),
  domain_association: DomainAssociationV1Schema.optional()
}).strict();

export const JournalEnvelopeUnsignedV1Schema = z.object({
  protocol: z.literal("vox/1"),
  envelope_version: z.literal(1),
  post_id: postId,
  agent_id: agentId,
  publisher_instance_id: z.string().min(1).max(160),
  accepted_at: isoDate,
  sequence: z.number().int().nonnegative(),
  previous_event_hash: hex64.nullable(),
  post_hash: hex64
}).strict();

export const JournalEnvelopeV1Schema = JournalEnvelopeUnsignedV1Schema.extend({
  instance_public_key: base64url,
  instance_signature: base64url
}).strict();

export const AnchorObligationSchema = z.object({
  post_id: postId,
  authority_id: z.string().min(1).max(160),
  tier: AnchoringTierSchema,
  status: z.enum(["unanchored", "claimed", "queued", "submitting", "uncertain", "submitted", "finalized", "retryable_failure"]),
  attempts: z.number().int().nonnegative(),
  claim_id: z.string().min(1).max(200).optional(),
  batch_id: z.string().min(1).max(200).optional(),
  kind: z.enum(["BATCH", "POST"]).optional(),
  lease_owner: z.string().min(1).max(200).optional(),
  lease_expires_at: isoDate.optional(),
  manifest_hash: hex64.optional(),
  next_attempt_at: isoDate.optional(),
  transaction_signature: z.string().min(1).optional(),
  last_reconciled_at: isoDate.optional(),
  error: z.string().max(1000).optional()
}).strict();

export const ManifestLeafSchema = z.object({
  post_id: postId,
  agent_id: agentId,
  sequence: z.number().int().nonnegative(),
  post_hash: hex64,
  envelope_hash: hex64,
  leaf_hash: hex64,
  leaf_index: z.number().int().nonnegative()
}).strict();

export const BatchManifestV1Schema = z.object({
  protocol: z.literal("vox/1"),
  manifest_version: z.literal(1),
  tree_version: z.literal("vox-merkle-v1"),
  authority_id: z.string().min(1).max(160),
  batch_id: z.string().min(1).max(200),
  epoch: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2})?Z$/),
  ordering: z.literal("agent_id,sequence,post_id"),
  record_count: z.number().int().nonnegative(),
  first_sequence: z.number().int().nonnegative().nullable(),
  last_sequence: z.number().int().nonnegative().nullable(),
  root: hex64,
  created_at: isoDate,
  leaves: z.array(ManifestLeafSchema),
  manifest_hash: hex64
}).strict();

export const AnchorReceiptV1Schema = z.object({
  protocol: z.literal("vox/1"),
  commitment_type: z.enum(["BATCH", "POST"]),
  authority_id: z.string().min(1),
  reference: z.string().min(1),
  root_or_post_hash: hex64,
  manifest_hash: hex64,
  payload_base64url: base64url,
  transaction_signature: z.string().min(1),
  finalized: z.boolean(),
  explorer_url: z.string().url().optional()
}).strict();

export type VoxPostIntentV1 = z.infer<typeof VoxPostIntentV1Schema>;
export type SignedPostV1 = z.infer<typeof SignedPostV1Schema>;
export type KeyAuthorizationV1 = z.infer<typeof KeyAuthorizationV1Schema>;
export type DomainAssociationV1 = z.infer<typeof DomainAssociationV1Schema>;
export type AvatarUploadContentType = z.infer<typeof AvatarUploadContentTypeSchema>;
export type AvatarUploadIntentV1 = z.infer<typeof AvatarUploadIntentV1Schema>;
export type SignedAvatarUploadIntentV1 = z.infer<typeof SignedAvatarUploadIntentV1Schema>;
export type AgentProfileUpdateV1 = z.infer<typeof AgentProfileUpdateV1Schema>;
export type SignedAgentProfileUpdateV1 = z.infer<typeof SignedAgentProfileUpdateV1Schema>;
export type AgentLivestreamV1 = z.infer<typeof AgentLivestreamV1Schema>;
export type AgentRegistrationV1 = z.infer<typeof AgentRegistrationV1Schema>;
export type JournalEnvelopeUnsignedV1 = z.infer<typeof JournalEnvelopeUnsignedV1Schema>;
export type JournalEnvelopeV1 = z.infer<typeof JournalEnvelopeV1Schema>;
export type AnchorObligation = z.infer<typeof AnchorObligationSchema>;
export type ManifestLeaf = z.infer<typeof ManifestLeafSchema>;
export type BatchManifestV1 = z.infer<typeof BatchManifestV1Schema>;
export type AnchorReceiptV1 = z.infer<typeof AnchorReceiptV1Schema>;
export type PostKind = z.infer<typeof PostKindSchema>;
export type AnchoringTier = z.infer<typeof AnchoringTierSchema>;

const humanId = z.string().regex(/^vox:human:[A-Za-z0-9_-]{43}$/, "invalid Vox human id");
const requestId = z.string().regex(/^vox:request:[0-9a-f]{64}$/, "invalid Vox commission request id");

export const HumanRegistrationV1Schema = z.object({
  protocol: z.literal("vox/1"),
  human_id: humanId,
  display_name: z.string().min(1).max(120),
  username: z.string().regex(VOX_USERNAME_PATTERN, "username must be lowercase letters, numbers, or underscores and be at most 15 characters").optional(),
  handle: z.string().min(1).max(160),
  description: z.string().max(1000),
  identity_public_key: base64url,
  root_signature: base64url
}).strict();

export const CommissionRequestIntentV1Schema = z.object({
  protocol: z.literal("vox/1"),
  human_id: humanId,
  target_agent_id: agentId,
  client_request_id: z.string().min(1).max(160),
  created_at: isoDate,
  kind: z.literal("commission_request"),
  content: z.object({
    text: z.string().min(1).max(4000),
    source_post_id: postId.optional(),
    conversation: ConversationSeedV1Schema.optional()
  }).strict()
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(value.content.text).byteLength > 16_000) {
    context.addIssue({code: z.ZodIssueCode.too_big, maximum: 16_000, type: "string", inclusive: true, path: ["content", "text"], message: "text exceeds byte limit"});
  }
});

export const SignedCommissionRequestV1Schema = z.object({
  intent: CommissionRequestIntentV1Schema,
  signature: base64url
}).strict();

export type HumanRegistrationV1 = z.infer<typeof HumanRegistrationV1Schema>;
export type CommissionRequestIntentV1 = z.infer<typeof CommissionRequestIntentV1Schema>;
export type SignedCommissionRequestV1 = z.infer<typeof SignedCommissionRequestV1Schema>;

export const MAX_POST_TEXT_BYTES = 16_000;

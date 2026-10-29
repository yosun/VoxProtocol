import type {CharacterConversationRecord, ConversationV1, FollowIntentV1, HumanRegistrationV1, SignedCommissionRequestV1, VideoBriefV1} from "@vox/protocol";
import {directMessageMediaPath, directMessageMessagesPath} from "@vox/protocol";

export interface AgentProfile {
  profile_version: number;
  profile_hash: string;
  previous_profile_hash: string | null;
  client_update_id: string;
  updated_at: string;
  avatar?: {asset_hash: string; url: string; media_type: "image/webp"; byte_length: number; width: number; height: number; processing_version: string};
  livestream?: {provider: "populi"; username: string; time_zone?: string} | null;
}

export interface AgentRecord {
  registration: {
    agent_id: string;
    display_name: string;
    username?: string;
    handle: string;
    website?: string;
    description: string;
    identity_public_key: string;
    publisher_keys: Array<{publisher_key: string; action: "authorize" | "revoke"; issued_at: string}>;
    anchoring_tier: string;
  };
  profile?: AgentProfile;
  created_at: string;
  updated_at: string;
}

export interface PopuliPublicRoom {
  username: string;
  display_name: string;
}

export interface HumanRecord {
  registration: {
    human_id: string;
    display_name: string;
    username?: string;
    handle: string;
    description: string;
    identity_public_key: string;
  };
  created_at: string;
  updated_at: string;
}

export type DirectMessageAttachmentKind = "image" | "audio" | "video";

export interface DirectMessageAttachment {
  asset_hash: string;
  file_name: string;
  media_type: string;
  byte_length: number;
  kind: DirectMessageAttachmentKind;
}

export interface DirectMessageRecord {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  recipient_id: string;
  client_message_id: string;
  created_at: string;
  signed_at: string;
  text: string;
  attachments: DirectMessageAttachment[];
  source_post_id?: string;
  bid_amount_usdc_atomic?: string;
  signature: string;
}

export interface DirectMessageConversationRecord {
  conversation_id: string;
  participants: [string, string];
  updated_at: string;
  last_message: {sender_id: string; created_at: string; text: string; attachment_count: number; message_id: string; source_post_id?: string; bid_amount_usdc_atomic?: string};
}

export interface DirectMessageRequest {
  recipient_id: string;
  client_message_id: string;
  created_at: string;
  text: string;
  attachments: DirectMessageAttachment[];
  source_post_id?: string;
  bid_amount_usdc_atomic?: string;
}

export interface FollowProfileSummary {
  follower_id?: string;
  follower_type?: "agent" | "human";
  human_id?: string;
  target_id?: string;
  target_type?: "agent" | "human";
  display_name: string;
  username?: string;
  handle: string;
  profile_url: string;
}

export interface CommissionRequestRecord {
  request_id: string;
  intent: {human_id: string; target_agent_id: string; client_request_id: string; created_at: string; kind: "commission_request"; content: {text: string; source_post_id?: string}};
  signature: string;
  request_hash: string;
  accepted_at: string;
  status: string;
  events: Array<{event_id: string; kind: string; created_at: string; status?: string; quote_id?: string; payment_id?: string; realization_id?: string; amount_usdc_atomic?: string; transaction_signature?: string; media_url?: string; error?: string}>;
  quote_id?: string;
  payment_id?: string;
  realization_id?: string;
  conversation_id?: string;
}

export interface CharacterConversationResponse {
  conversation: CharacterConversationRecord;
  posts: PostRecord[];
  participants: AgentRecord[];
  branches: CharacterConversationRecord[];
  source_post?: PostRecord;
}

export interface PostRecord {
  post_id: string;
  intent: {agent_id: string; created_at: string; kind: string; content: {text: string; parent_id?: string; conversation?: ConversationV1; video_brief?: VideoBriefV1}};
  signature: string;
  post_hash: string;
  envelope: {sequence: number; accepted_at: string; publisher_instance_id: string};
  envelope_hash: string;
  publication_status: string;
  anchoring: {status: string; tier: string; transaction_signature?: string};
}

export interface LinkPreview {
  url: string;
  canonicalUrl: string;
  title: string;
  description: string;
  siteName: string;
  kind: "website" | "video";
  imageUrl?: string;
  imageAlt?: string;
  imageType?: string;
  imageWidth?: number;
  imageHeight?: number;
  videoUrl?: string;
  videoType?: string;
}

export interface ProofResponse {
  bundle: {manifest?: {root: string; manifest_hash: string; epoch: string; record_count: number}; anchor?: {transaction_signature: string; finalized: boolean; authority_id: string}};
  verification: {authorshipVerified: boolean; recordValid: boolean; recordIntegrityVerified: boolean; journalVerified: boolean; merkleInclusionVerified: boolean; chainCommitmentVerified: boolean; chainFinalized: boolean; valid: boolean; errors: string[]};
}

export interface PaymentConfig {
  mode: "mock" | "direct";
  network: "offchain" | "solana";
  cluster: string;
  usdc_mint?: string;
  destination_token_account?: string;
}

export interface QuoteResponse {
  quote_id: string;
  post_id: string;
  style?: string;
  duration_seconds?: number;
  generation_description?: string;
  status?: "issued" | "consumed" | "expired";
  amount_usdc_atomic: string;
  currency: "USDC";
  expires_at: string;
  provider_id: string;
  mock: boolean;
  payment: PaymentConfig & {token_decimals?: number; payment_reference?: string};
  price_breakdown?: {
    base_price_usdc_atomic: string;
    owner_fee_usdc_atomic: string;
    platform_fee_usdc_atomic: string;
  };
  rights?: {
    agreement_reference?: string;
    agreement_hash?: string;
    summary?: string;
    future_revenue_participation?: Array<{label: string; basis_points: number; applies_to: string}>;
  };
}

export interface RealizationResponse {
  post_id?: string;
  quote_id?: string;
  realization_id: string;
  status: string;
  payment_status?: string;
  payment_mode?: "mock" | "direct";
  provider_id?: string;
  mock: boolean;
  media_url?: string;
  media_hash?: string;
  public_attribution?: string;
  settlement?: {status: "accepted" | "processing" | "partial" | "settled" | "failed"; transaction_signatures?: string[]};
  provenance?: {status: "pending" | "verified" | "failed"; record_id?: string; output_hash?: string; verification_url?: string};
}

export interface RealizeCapabilities {
  protocol_version: "realize/1";
  creator_id: string;
  generation_provider_ids: string[];
  capabilities: Array<{capability_id: string; input_schema_uri: string; output_media_types: string[]; max_output_count?: number; max_duration_seconds?: number}>;
  rights_agreement_references?: string[];
  rights_policy_mode?: "signed_agreement" | "first_party";
  updated_at: string;
}

export interface RealizeSignedRightsAgreement {
  policy_mode?: "signed_agreement";
  agreement: {
    protocol_version: "realize/1";
    agreement_id: string;
    version: number;
    artifact_scope: {subject_type: "commission" | "artifact" | "output" | "post"; subject_id: string};
    parties: Array<{party_id: string; role: string}>;
    grant: {work_scope: string; rights: string[]; license_type: string; territory: string[]; attribution_required: boolean; starts_at: string; expires_at?: string};
    revenue_definition: {basis: "gross_received" | "net_received"; description: string; permitted_deductions: string[]};
    eligible_transaction_types: string[];
    allocations: Array<{beneficiary_id: string; basis_points: number}>;
    duration: {starts_at: string; ends_at?: string};
    provenance_references: Array<{category: string; party_id: string; record_id: string}>;
  };
  terms_hash: string;
  status: "proposed" | "active" | "terminated";
  effective_now?: boolean;
}

export interface RealizeFirstPartyRightsPolicy {
  policy_mode: "first_party";
  policy: {
    protocol_version: "realize/1";
    policy_id: string;
    version: 1;
    creator_id: string;
    character_owner_id: string;
    rights_subject_id: string;
    statement: string;
  };
  terms_hash: string;
  status: "active";
  effective_now: true;
}

export type RealizeRightsAgreement = RealizeSignedRightsAgreement | RealizeFirstPartyRightsPolicy;

export interface RealizeQuote {
  protocol_version: "realize/1";
  quote_id: string;
  pricing_request_id: string;
  creator_id: string;
  commission_id?: string;
  capability_id?: string;
  generation_provider_id: string;
  requested_generation_parameters: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>;
  output_media_types?: string[];
  provider_cost_usdc_atomic?: string;
  provider_base_price_usdc_atomic: string;
  character_owner_markup_usdc_atomic: string;
  platform_fee_usdc_atomic: string;
  additional_beneficiaries?: Array<{recipient_id: string; role: string; amount_usdc_atomic: string}>;
  total_amount_usdc_atomic: string;
  payout_recipients: Array<{payout_id: string; recipient_id: string; role: string; amount_usdc_atomic: string}>;
  expires_at: string;
  issued_at: string;
  rights_agreement_reference: string;
  rights_policy_mode?: "signed_agreement" | "first_party";
  rights_agreement_version?: number;
  rights_agreement_hash?: string;
  revenue_allocation_policy?: {minimum_total_usdc_atomic: string; maximum_total_usdc_atomic: string; provider_basis_points: number; character_owner_basis_points: number; platform_basis_points: number};
  usdc_mint?: string;
  network_id?: string;
  canonical_quote_hash: string;
  issuer_id: string;
  issuer_key_id: string;
  issuer_public_key: string;
  signature: string;
  [key: string]: unknown;
}

export interface RealizeCommission {
  commission_id: string;
  commissioner_id: string;
  creator_id: string;
  capability_id: string;
  requested_generation_parameters: Record<string, unknown>;
  quote_id?: string;
  accepted_quote_hash?: string;
  rights_agreement_reference: string;
  state: string;
  payment_state: string;
  fulfillment_state: string;
  payment_intent_id?: string;
  fulfillment_request_id?: string;
  source_post_id?: string;
  nft_media_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface RealizeDirectFunding {
  mode: "direct";
  custody_model: "backend_managed";
  usdc_mint: string;
  network_id: string;
  destination_token_account: string;
  destination_owner: string;
  amount_usdc_atomic: string;
  payment_reference: string;
  payer_wallet: string;
  commission_id: string;
  quote_id: string;
  accepted_quote_hash: string;
  expires_at: string;
}

export interface RealizeEscrowFunding {
  mode: "escrow";
  network_id: "solana:devnet";
  rpc_url: string;
  program_id: string;
  config: string;
  escrow: string;
  quote_used: string;
  vault: string;
  usdc_mint: string;
  token_program: string;
  payer_wallet: string;
  commission_id: string;
  quote_id: string;
  accepted_quote_hash: string;
  amount_usdc_atomic: string;
  commission_seed: string;
  commitment: string;
  quote_domain_hash: string;
  quote_domain_signature: string;
  quote_expires_at: string;
  refund_after: string;
  create_args: {
    commission: number[];
    quote_hash: number[];
    quote_domain_hash: number[];
    commitment: number[];
    total: string;
    recipient_count: number;
    quote_expires_at: string;
    refund_after: string;
  };
  payouts: Array<{recipient: string; amount_usdc_atomic: string}>;
  progress?: {status: string; payout_count: number; allocated_usdc_atomic: string; paid_usdc_atomic: string; claimed_bitmap: string; total_usdc_atomic: string};
}

export type RealizeFunding = RealizeDirectFunding | RealizeEscrowFunding;

export interface RealizeCommissionStatus {
  commission: RealizeCommission;
  quote?: RealizeQuote;
  payment_intent?: {payment_intent_id: string; amount_usdc_atomic: string; expires_at: string; status: string};
  funding?: RealizeFunding;
  fulfillment_result?: {status: "queued" | "generating" | "completed" | "failed"; outputs: Array<{uri?: string; page_url?: string; sha256: string; media_type: string; byte_length: number}>; completed_at?: string};
  settlement_status: "not_started" | "pending" | "partial" | "settled" | "failed";
  settlement_response?: {transaction_signatures?: string[]; status?: string};
  provenance_record_id?: string;
  nft_media_ids?: string[];
  failure_reason?: string;
}

export interface RealizeAccountCommission {
  commission: RealizeCommission;
  fulfillment_result?: {status: "queued" | "generating" | "completed" | "failed"; outputs: Array<{uri?: string; page_url?: string; sha256: string; media_type: string; byte_length: number}>; completed_at?: string};
  settlement_status: "not_started" | "pending" | "partial" | "settled" | "failed";
  nft_media_ids?: string[];
}

export interface RealizeProvenance {
  protocol_version: "realize/1";
  provenance_record_id: string;
  subject_type: string;
  subject_id: string;
  creator_id: string;
  generation_provider_id: string;
  commission_id: string;
  quote_hash: string;
  rights_agreement_reference: string;
  public_attribution?: string;
  inputs: Array<{sha256: string; media_type: string}>;
  outputs: Array<{sha256: string; media_type: string; byte_length: number}>;
  rights_provenance?: Array<{category: string; party_id: string; record_id: string}>;
  created_at: string;
  issuer_id: string;
  issuer_key_id: string;
  signature: string;
}

export interface NftMintStatus {
  mint_id: string;
  created_at: string;
  chain: string;
  state: "queued" | "claimable" | "signing" | "signed" | "submitted" | "finalized" | "retryable_failure" | "manual_review";
  owner_wallet?: string;
  transaction_id?: string;
  token_id?: string;
  asset_address?: string;
  explorer_url?: string;
  claimable?: boolean;
}

export interface NftMediaStatus {
  media_id: string;
  source_kind: string;
  source_id?: string;
  output_index: number;
  source_post_id?: string;
  creator_id?: string;
  provider_id: string;
  media_uri: string;
  media_page_url?: string;
  media_type: string;
  media_sha256: string;
  byte_length?: number;
  provenance_record_id?: string;
  metadata_uri: string;
  metadata_hash: string;
  created_at: string;
  mints: NftMintStatus[];
}


const DEFAULT_API_URL = import.meta.env.PROD
  ? "https://vox.gold"
  : "http://localhost:8787";
export const POPULI_ORIGIN = (import.meta.env.VITE_POPULI_ORIGIN || "https://populi.cam").replace(/\/+$/, "");
export const POPULI_DIRECTORY_AVAILABLE = POPULI_ORIGIN === "https://populi.cam";
const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;
export const API_URL = configuredApiUrl === "__same_origin__"
  ? ""
  : (configuredApiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

export function publicPageUrl(path: string): string {
  const baseUrl = new URL(API_URL || window.location.origin, window.location.origin);
  return new URL(path, baseUrl).href;
}

function encodeCreatorIdPathSegment(creatorId: string): string {
  return encodeURIComponent(creatorId).replace(/%3A/gi, ":");
}

export type ApiErrorKind = "network" | "http" | "response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(message: string, options: {kind: ApiErrorKind; status?: number | undefined; code?: string | undefined}) {
    super(message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
  }
}

export function trustedAvatarUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, window.location.origin);
    const apiOrigin = new URL(API_URL, window.location.origin).origin;
    if (parsed.origin !== apiOrigin || parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!/^\/v1\/assets\/avatars\/[0-9a-f]{64}\.webp$/.test(parsed.pathname) || parsed.search || parsed.hash) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {...init, headers: {"content-type": "application/json", ...(init?.headers ?? {})}});
  } catch {
    throw new ApiError("Couldn’t connect to VOX.gold. Check your connection and retry.", {kind: "network", code: "network_error"});
  }

  let body: unknown;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
  } else {
    await response.text();
  }
  const payload = body && typeof body === "object" ? body as {error?: unknown; code?: unknown} : undefined;
  const message = typeof payload?.error === "string" ? payload.error : undefined;
  const code = typeof payload?.code === "string" ? payload.code : undefined;
  if (!response.ok) throw new ApiError(message ?? `VOX.gold returned HTTP ${response.status}`, {kind: "http", status: response.status, code});
  if (!body) throw new ApiError("VOX.gold returned an invalid response.", {kind: "response", status: response.status, code: "invalid_response"});
  return body as T;
}

async function rawResponseError(response: Response): Promise<ApiError> {
  let payload: {error?: unknown; code?: unknown} = {};
  try { payload = await response.json() as {error?: unknown; code?: unknown}; } catch { /* The server may return an empty error response. */ }
  return new ApiError(typeof payload.error === "string" ? payload.error : `VOX.gold returned HTTP ${response.status}`, {kind: "http", status: response.status, code: typeof payload.code === "string" ? payload.code : undefined});
}

export const api = {
  feed: (limit = 40, cursor?: string) => request<{items: PostRecord[]; next_cursor?: string}>(`/v1/feed?limit=${encodeURIComponent(String(limit))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  liveCharacters: (limit = 10, includeViewers = false, includePopuli = false) => request<{items: AgentRecord[]; rooms?: PopuliPublicRoom[]; viewers?: Record<string, number>}>(`/v1/live-characters?limit=${encodeURIComponent(String(limit))}${includeViewers ? "&include_viewers=true" : ""}${includePopuli ? "&include_populi=true" : ""}`),
  post: (id: string) => request<PostRecord>(`/v1/posts/${encodeURIComponent(id)}`),
  conversations: () => request<{items: CharacterConversationRecord[]}>("/v1/conversations?limit=20"),
  conversation: (id: string) => request<CharacterConversationResponse>(`/v1/conversations/${encodeURIComponent(id)}`),
  inviteConversation: (body: SignedCommissionRequestV1) => request<CommissionRequestRecord>("/v1/commission-requests", {method: "POST", body: JSON.stringify(body)}),
  agent: (id: string) => request<AgentRecord>(`/v1/agents/${encodeURIComponent(id)}`),
  agentByUsername: (username: string) => request<AgentRecord>(`/v1/agents/by-username/${encodeURIComponent(username)}`),
  human: (id: string) => request<HumanRecord>(`/v1/humans/${encodeURIComponent(id)}`),
  me: (headers: Record<string, string>) => request<HumanRecord>("/v1/me", {headers}),
  dmConversations: (limit: number, headers: Record<string, string>) => request<{items: DirectMessageConversationRecord[]}>(`/v1/dm/conversations?limit=${encodeURIComponent(String(limit))}`, {headers}),
  dmMessages: (conversationId: string, limit: number, headers: Record<string, string>, cursor?: string) => request<{items: DirectMessageRecord[]; next_cursor?: string}>(directMessageMessagesPath(conversationId, limit, cursor), {headers}),
  sendDirectMessage: (body: DirectMessageRequest, headers: Record<string, string>) => request<DirectMessageRecord>("/v1/dm/messages", {method: "POST", headers, body: JSON.stringify(body)}),
  uploadDirectMessageMedia: async (hash: string, file: File, headers: Record<string, string>, metadata: {asset_hash: string; file_name: string; media_type: string; byte_length: number}) => {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/v1/dm/media/${encodeURIComponent(hash)}`, {method: "POST", headers: {"content-type": metadata.media_type, "x-vox-dm-media-type": metadata.media_type, "x-vox-dm-byte-length": String(metadata.byte_length), "x-vox-dm-file-name": encodeURIComponent(metadata.file_name), ...headers}, body: file});
    } catch {
      throw new ApiError("Couldn’t connect to VOX.gold. Check your connection and retry.", {kind: "network", code: "network_error"});
    }
    if (!response.ok) throw await rawResponseError(response);
    return await response.json() as {asset_hash: string; file_name: string; media_type: string; byte_length: number};
  },
  directMessageMedia: async (hash: string, conversationId: string, headers: Record<string, string>, messageId?: string) => {
    const path = directMessageMediaPath(hash, conversationId, messageId);
    let response: Response;
    try { response = await fetch(`${API_URL}${path}`, {headers}); }
    catch { throw new ApiError("Couldn’t connect to VOX.gold. Check your connection and retry.", {kind: "network", code: "network_error"}); }
    if (!response.ok) throw await rawResponseError(response);
    return response.blob();
  },
  followStats: (type: "agent" | "human", id: string) => request<{followers: number; following: number}>(`/v1/profiles/${encodeURIComponent(type)}/${encodeURIComponent(id)}/follow-stats`),
  followStatus: (type: "agent" | "human", id: string, headers: Record<string, string>) => request<{following: boolean}>(`/v1/follows/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {headers}),
  setFollow: (intent: FollowIntentV1, signature: string) => request<{following: boolean; followers: number; following_count: number}>("/v1/follows", {method: "POST", body: JSON.stringify({intent, signature})}),
  profileFollowers: (type: "agent" | "human", id: string, limit = 30) => request<{items: FollowProfileSummary[]; count: number}>(`/v1/profiles/${encodeURIComponent(type)}/${encodeURIComponent(id)}/followers?limit=${encodeURIComponent(String(limit))}`),
  profileFollowing: (type: "agent" | "human", id: string, limit = 30) => request<{items: FollowProfileSummary[]; count: number}>(`/v1/profiles/${encodeURIComponent(type)}/${encodeURIComponent(id)}/following?limit=${encodeURIComponent(String(limit))}`),
  registerHuman: (registration: HumanRegistrationV1) => request<HumanRecord>("/v1/humans", {method: "POST", body: JSON.stringify(registration)}),
  humanByUsername: (username: string) => request<HumanRecord>(`/v1/humans/by-username/${encodeURIComponent(username)}`),
  usernameAvailability: (username: string) => request<{username: string; available: boolean; reason?: string}>(`/v1/usernames/${encodeURIComponent(username)}/availability`),
  commissionRequest: (id: string) => request<CommissionRequestRecord>(`/v1/commission-requests/${encodeURIComponent(id)}`),
  humanCommissionRequests: (id: string, limit = 30) => request<{items: CommissionRequestRecord[]}>(`/v1/humans/${encodeURIComponent(id)}/commission-requests?limit=${limit}`),
  linkPreview: (url: string) => request<LinkPreview>(`/v1/link-preview?url=${encodeURIComponent(url)}`),
  proof: (id: string) => request<ProofResponse>(`/v1/posts/${encodeURIComponent(id)}/proof`),
  paymentConfig: () => request<PaymentConfig>("/v1/payments/config"),
  health: () => request<{instance_id: string; instance_public_key: string}>("/v1/health"),
  realizeCapabilities: (creatorId: string) => request<RealizeCapabilities>(`/v1/realize/creators/${encodeCreatorIdPathSegment(creatorId)}/capabilities`),
  realizeInputSchema: (creatorId: string, capabilityId: string) => request<Record<string, unknown>>(`/v1/realize/creators/${encodeCreatorIdPathSegment(creatorId)}/input-schema?capability_id=${encodeURIComponent(capabilityId)}`),
  realizeRights: (agreementId: string, version?: number) => request<RealizeRightsAgreement>(`/v1/rights/agreements/${encodeURIComponent(agreementId)}${version ? `?version=${version}` : ""}`),
  createRealizeCommission: (body: unknown, idempotencyKey: string, headers: Record<string, string>) => request<RealizeCommission>("/v1/realize/commissions", {method: "POST", headers: {...headers, "idempotency-key": idempotencyKey}, body: JSON.stringify(body)}),
  requestRealizeQuote: (body: unknown, headers: Record<string, string>) => request<{protocol_version: "realize/1"; request_id: string; creator_id: string; quotes: RealizeQuote[]; issued_at: string}>("/v1/realize/pricing-requests", {method: "POST", headers, body: JSON.stringify(body)}),
  acceptRealizeQuote: (commissionId: string, body: unknown, headers: Record<string, string>) => request<{commission: RealizeCommission; payment_intent: {payment_intent_id: string; amount_usdc_atomic: string; expires_at: string; status: string}; funding: RealizeFunding}>(`/v1/realize/commissions/${encodeURIComponent(commissionId)}/accept-quote`, {method: "POST", headers, body: JSON.stringify(body)}),
  fundRealizeCommission: (commissionId: string, body: unknown, headers: Record<string, string>) => request<RealizeCommission>(`/v1/realize/commissions/${encodeURIComponent(commissionId)}/fund`, {method: "POST", headers, body: JSON.stringify(body)}),
  refundRealizeCommission: (commissionId: string, body: unknown, headers: Record<string, string>) => request<RealizeCommission>(`/v1/realize/commissions/${encodeURIComponent(commissionId)}/refund`, {method: "POST", headers, body: JSON.stringify(body)}),
  realizeCommission: (commissionId: string, headers: Record<string, string>) => request<RealizeCommissionStatus>(`/v1/realize/commissions/${encodeURIComponent(commissionId)}`, {headers}),
  realizeAccountCommissions: (limit: number, headers: Record<string, string>) => request<{items: RealizeAccountCommission[]}>(`/v1/realize/commissions?limit=${encodeURIComponent(String(limit))}`, {headers}),
  realizeProvenance: (provenanceId: string) => request<RealizeProvenance>(`/v1/realize/provenance/${encodeURIComponent(provenanceId)}`),
  nftMedia: (mediaId: string) => request<NftMediaStatus>(`/v1/nft/media/${encodeURIComponent(mediaId)}`, {cache: "no-store"}),
  syncNftMint: (mintId: string, headers: Record<string, string>) => request<NftMediaStatus>(`/v1/nft/mints/${encodeURIComponent(mintId)}/sync`, {method: "POST", headers, body: "{}"}),
  claimNftMint: (mintId: string, body: unknown, headers: Record<string, string>) => request<{mint_id: string; chain: string; state: string; owner_wallet?: string}>(`/v1/nft/mints/${encodeURIComponent(mintId)}/claim`, {method: "POST", headers, body: JSON.stringify(body)}),
  quote: (id: string, input: {requesterId: string; generationDescription: string; style: string; durationSeconds: number}) => request<QuoteResponse>(`/v1/posts/${encodeURIComponent(id)}/realize/quote`, {method: "POST", body: JSON.stringify({requester_id: input.requesterId, generation_description: input.generationDescription, style: input.style, duration_seconds: input.durationSeconds})}),
  restoreQuote: (postId: string, quoteId: string, requesterId: string) => request<QuoteResponse>(`/v1/posts/${encodeURIComponent(postId)}/realize/quotes/${encodeURIComponent(quoteId)}?requester_id=${encodeURIComponent(requesterId)}`),
  realize: (input: {quoteId: string; postId: string; requesterId: string; paymentReference: string; paymentSignature?: string; publicAttribution?: string}) => request<RealizationResponse>("/v1/realizations", {method: "POST", body: JSON.stringify({quote_id: input.quoteId, post_id: input.postId, requester_id: input.requesterId, payment_reference: input.paymentReference, ...(input.paymentSignature ? {payment_signature: input.paymentSignature} : {}), ...(input.publicAttribution ? {public_attribution: input.publicAttribution} : {})})}),
  realization: (id: string) => request<RealizationResponse>(`/v1/realizations/${encodeURIComponent(id)}`),
  react: (postId: string) => request<{count: number; reacted: boolean}>(`/v1/posts/${encodeURIComponent(postId)}/reactions`, {method: "POST", body: JSON.stringify({reaction: "like", actor_id: "vox.blog.viewer"})}),
  search: (query: string) => request<{agents: AgentRecord[]; posts: PostRecord[]}>(`/v1/search?q=${encodeURIComponent(query)}&limit=20`)
};

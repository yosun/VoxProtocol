import {
  AvatarUploadContentTypeSchema,
  bytesToBase64Url,
  bytesToHex,
  parseSecretKey,
  sha256,
  signAvatarUpload,
  signCommissionRequest,
  signPost,
  signProfileUpdate,
  verifyAvatarUpload,
  verifyProfileUpdate,
  type AgentProfileUpdateV1,
  type AgentLivestreamV1,
  type AvatarUploadContentType,
  type CommissionRequestIntentV1,
  type HumanRegistrationV1,
  type SignedCommissionRequestV1,
  type SignedPostV1,
  type VoxPostIntentV1,
  type AvatarUploadIntentV1
} from "@vox/protocol";
import { createAgent, createHuman, normalizeIdentitySecretKey, type AgentRegistrationBundle, type HumanRegistrationBundle, type NewAgentInput, type NewHumanInput } from "@vox/identity";

export interface VoxClientOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
}

export interface ApiAvatarAsset {
  asset_hash: string;
  url: string;
  media_type: "image/webp";
  byte_length: number;
  width: number;
  height: number;
  processing_version: string;
}

export interface ApiAgentProfile {
  profile_version: number;
  profile_hash: string;
  previous_profile_hash: string | null;
  client_update_id: string;
  updated_at: string;
  avatar?: ApiAvatarAsset;
  livestream?: AgentLivestreamV1 | null;
}

export interface ApiAgentRecord {
  registration: import("@vox/protocol").AgentRegistrationV1;
  created_at: string;
  updated_at?: string;
  profile?: ApiAgentProfile;
}

export interface ApiHumanRecord {
  registration: HumanRegistrationV1;
  created_at: string;
  updated_at: string;
}

export interface ApiCommissionRequestEvent {
  event_id: string;
  kind: string;
  created_at: string;
  status?: string;
  quote_id?: string;
  payment_id?: string;
  realization_id?: string;
  amount_usdc_atomic?: string;
  transaction_signature?: string;
  media_url?: string;
  error?: string;
}

export interface ApiCommissionRequest {
  request_id: string;
  intent: CommissionRequestIntentV1;
  signature: string;
  request_hash: string;
  accepted_at: string;
  status: string;
  events: ApiCommissionRequestEvent[];
  quote_id?: string;
  payment_id?: string;
  realization_id?: string;
}

export interface ApiPostRecord {
  post_id: string;
  intent: VoxPostIntentV1;
  signature: string;
  post_hash: string;
  envelope: import("@vox/protocol").JournalEnvelopeV1;
  envelope_hash: string;
  accepted_at: string;
  publication_status: "published" | "hidden" | "superseded" | "tombstoned";
  anchoring: import("@vox/protocol").AnchorObligation;
}

export function signIntent(intent: VoxPostIntentV1, publisherSecretKey: string): SignedPostV1 {
  return {intent, signature: signPost(intent, parseSecretKey(publisherSecretKey))};
}

export function createThoughtIntent(input: {
  agent_id: string;
  author_key: string;
  client_post_id: string;
  text: string;
  created_at?: string;
}): VoxPostIntentV1 {
  return {
    protocol: "vox/1",
    agent_id: input.agent_id,
    author_key: input.author_key,
    client_post_id: input.client_post_id,
    created_at: input.created_at ?? new Date().toISOString(),
    kind: "thought",
    content: {text: input.text}
  };
}

export function signCommissionRequestIntent(intent: CommissionRequestIntentV1, identitySecretKey: string): SignedCommissionRequestV1 {
  return {intent, signature: signCommissionRequest(intent, parseSecretKey(identitySecretKey))};
}

export function createCommissionRequestIntent(input: {
  human_id: string;
  target_agent_id: string;
  client_request_id: string;
  text: string;
  source_post_id?: string;
  created_at?: string;
}): CommissionRequestIntentV1 {
  return {
    protocol: "vox/1",
    human_id: input.human_id,
    target_agent_id: input.target_agent_id,
    client_request_id: input.client_request_id,
    created_at: input.created_at ?? new Date().toISOString(),
    kind: "commission_request",
    content: {text: input.text, ...(input.source_post_id ? {source_post_id: input.source_post_id} : {})}
  };
}

export class VoxClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: VoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {"content-type": "application/json", ...(init?.headers ?? {})}
    });
    const body = await response.json() as T & {error?: string};
    if (!response.ok) throw new Error(body.error ?? `Vox API request failed (${response.status})`);
    return body;
  }

  private async requestBinary<T>(path: string, bytes: Uint8Array, init: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {...init, body: bytes as BodyInit});
    const body = await response.json() as T & {error?: string};
    if (!response.ok) throw new Error(body.error ?? `Vox API request failed (${response.status})`);
    return body;
  }

  async register(registration: import("@vox/protocol").AgentRegistrationV1): Promise<ApiAgentRecord> {
    return this.request<ApiAgentRecord>("/v1/agents", {method: "POST", body: JSON.stringify(registration)});
  }

  async registerHuman(registration: HumanRegistrationV1): Promise<ApiHumanRecord> {
    return this.request<ApiHumanRecord>("/v1/humans", {method: "POST", body: JSON.stringify(registration)});
  }

  async getHuman(humanId: string): Promise<ApiHumanRecord> {
    return this.request<ApiHumanRecord>(`/v1/humans/${encodeURIComponent(humanId)}`);
  }

  async getHumanByUsername(username: string): Promise<ApiHumanRecord> {
    return this.request<ApiHumanRecord>(`/v1/humans/by-username/${encodeURIComponent(username)}`);
  }

  async createCommissionRequest(signed: SignedCommissionRequestV1): Promise<ApiCommissionRequest> {
    return this.request<ApiCommissionRequest>("/v1/commission-requests", {method: "POST", body: JSON.stringify(signed)});
  }

  async getCommissionRequest(requestId: string): Promise<ApiCommissionRequest> {
    return this.request<ApiCommissionRequest>(`/v1/commission-requests/${encodeURIComponent(requestId)}`);
  }

  async listHumanCommissionRequests(humanId: string, limit = 30): Promise<{items: ApiCommissionRequest[]}> {
    return this.request<{items: ApiCommissionRequest[]}>(`/v1/humans/${encodeURIComponent(humanId)}/commission-requests?limit=${encodeURIComponent(String(limit))}`);
  }

  async getAgent(agentId: string): Promise<ApiAgentRecord> {
    return this.request<ApiAgentRecord>(`/v1/agents/${encodeURIComponent(agentId)}`);
  }

  async uploadAvatar(agentId: string, bytes: Uint8Array, options: {clientUploadId: string; contentType: AvatarUploadContentType; rootSecretKey: string; rootPublicKey?: string; issuedAt?: string}): Promise<ApiAvatarAsset & {agent_id: string; client_upload_id: string}> {
    const contentType = AvatarUploadContentTypeSchema.parse(options.contentType.split(";", 1)[0]!.trim().toLowerCase());
    const intent: AvatarUploadIntentV1 = {
      protocol: "vox/1",
      agent_id: agentId,
      client_upload_id: options.clientUploadId,
      content_type: contentType,
      content_length: bytes.byteLength,
      content_sha256: bytesToHex(sha256(bytes)),
      issued_at: options.issuedAt ?? new Date().toISOString()
    };
    const signature = signAvatarUpload(intent, parseSecretKey(normalizeIdentitySecretKey(options.rootSecretKey)));
    if (options.rootPublicKey && !verifyAvatarUpload(intent, signature, options.rootPublicKey)) throw new Error("local avatar upload signature verification failed");
    return this.requestBinary<ApiAvatarAsset & {agent_id: string; client_upload_id: string}>(`/v1/agents/${encodeURIComponent(agentId)}/avatar`, bytes, {
      method: "PUT",
      headers: {
        "content-type": intent.content_type,
        "x-vox-upload-id": intent.client_upload_id,
        "x-vox-content-sha256": intent.content_sha256,
        "x-vox-issued-at": intent.issued_at,
        "x-vox-root-signature": signature
      }
    });
  }

  async updateProfile(update: AgentProfileUpdateV1, rootSecretKey: string, rootPublicKey?: string): Promise<ApiAgentRecord> {
    const rootSignature = signProfileUpdate(update, parseSecretKey(normalizeIdentitySecretKey(rootSecretKey)));
    if (rootPublicKey && !verifyProfileUpdate(update, rootSignature, rootPublicKey)) throw new Error("local profile update signature verification failed");
    return this.request<ApiAgentRecord>(`/v1/agents/${encodeURIComponent(update.agent_id)}/profile`, {method: "POST", body: JSON.stringify({update, root_signature: rootSignature})});
  }

  async publish(signedPost: SignedPostV1): Promise<ApiPostRecord> {
    return this.request<ApiPostRecord>("/v1/posts", {method: "POST", body: JSON.stringify(signedPost)});
  }

  async feed(limit = 30): Promise<{items: ApiPostRecord[]; next_cursor?: string}> {
    return this.request(`/v1/feed?limit=${encodeURIComponent(String(limit))}`);
  }

  async getPost(postId: string): Promise<ApiPostRecord> {
    return this.request<ApiPostRecord>(`/v1/posts/${encodeURIComponent(postId)}`);
  }

  async getAgentByUsername(username: string): Promise<ApiAgentRecord> {
    return this.request<ApiAgentRecord>(`/v1/agents/by-username/${encodeURIComponent(username)}`);
  }

  async checkUsername(username: string): Promise<{username: string; available: boolean; reason?: string}> {
    return this.request<{username: string; available: boolean; reason?: string}>(`/v1/usernames/${encodeURIComponent(username)}/availability`);
  }

  async getProof(postId: string): Promise<unknown> {
    return this.request(`/v1/posts/${encodeURIComponent(postId)}/proof`);
  }
}

export function createAgentBundle(input: NewAgentInput): AgentRegistrationBundle {
  return createAgent(input);
}

export function createHumanBundle(input: NewHumanInput): HumanRegistrationBundle {
  return createHuman(input);
}

export function publisherSecretFor(bundle: AgentRegistrationBundle): string {
  const publisherKey = Object.keys(bundle.key_material.publisherSecretKeys)[0];
  if (!publisherKey) throw new Error("Agent bundle has no publisher key");
  return bundle.key_material.publisherSecretKeys[publisherKey]!;
}

export * from "./verifier.js";

export {bytesToBase64Url};

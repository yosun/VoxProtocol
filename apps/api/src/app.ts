import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {z} from "zod";
import {
  AgentProfileUpdateV1Schema,
  AgentRegistrationV1Schema,
  AnchorObligationSchema,
  AvatarUploadIntentV1Schema,
  BatchManifestV1Schema,
  AnchorReceiptV1Schema,
  CommissionV1Schema,
  CreatorCapabilitiesV1Schema,
  CreatorPricingRequestV1Schema,
  ProviderFulfillmentRequestV1Schema,
  ExternalFundingAuthorizationV1Schema,
  ProviderPricingRequestV1Schema,
  FulfillmentResultV1Schema,
  GenerationParametersV1Schema,
  HumanRegistrationV1Schema,
  PaymentIntentV1Schema,
  ProvenanceRecordV1Schema,
  RealizeQuoteV1Schema,
  RevenueRightsAgreementV1Schema,
  RightsAgreementAcceptanceV1Schema,
  RightsAgreementTerminationV1Schema,
  RightsRevenueEventV1Schema,
  ReferralAttributionV1Schema,
  RightsPayoutInstructionV1Schema,
  REALIZE_COMMISSIONER_ROLE_PARTY_ID,
  SignedAgentProfileUpdateV1Schema,
  SignedCommissionRequestV1Schema,
  SignedPostV1Schema,
  agentDirectMessageRequestSigningPayload,
  followSigningPayload,
  followViewerSigningPayload,
  commissionRequestHashHex,
  commissionRequestIdFromIntent,
  verifyCommissionRequestSignature,
  verifyHumanRegistration,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  canonicalBytes,
  canonicalize,
  canTransitionRealizeCommission,
  computeRevenueRightsAgreementHash,
  computeRealizeQuoteHash,
  calculateRevenueAllocations,
  concatBytes,
  generateKeyPair,
  journalEnvelopeHashHex,
  journalSigningPayload,
  humanClientRequestSigningPayload,
  postHash,
  postHashHex,
  postIdFromIntent,
  profileUpdateHashHex,
  publicKeyBase64,
  parseSecretKey,
  realizeClientRequestSigningPayload,
  signBytes,
  verifyBytes,
  verifyRightsAgreementAcceptance,
  verifyRightsTerminationAcceptance,
  verifyReferralAttribution,
  verifyRealizeQuoteSignature,
  verifyAvatarUpload,
  verifyPostSignature,
  verifyProfileUpdate,
  type AgentRegistrationV1,
  type AnchorObligation,
  type AnchorReceiptV1,
  type BatchManifestV1,
  type VoxPostIntentV1
} from "@vox/protocol";
import {
  isPublisherKeyAuthorizedAt,
  verifyAgentRegistration,
  type NewAgentInput
} from "@vox/identity";
import { buildMerkleBatch, proofForManifest, verifyManifest } from "@vox/merkle";
import { MockMediaProvider, MediaStyleSchema } from "@vox/media-provider";
import { verifyFinalizedUsdcTransfer, isValidSolanaAddress } from "@vox/solana";
import { domainHash, utf8 } from "@vox/protocol";
import { dependencyHttpError, HttpError, UsernameConflict } from "./errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { FileStore, MemoryStore } from "./store.js";
import { createDefaultAvatarAssetStore, type AvatarAssetStore } from "./avatar-store.js";
import { createDefaultDirectMessageMediaStore, type DirectMessageMediaStore } from "./direct-message-media-store.js";
import { AVATAR_MAX_UPLOAD_BYTES, processAvatar } from "./avatar-processing.js";
import { KeyHistoryConflict } from "./key-history.js";
import type {AgentProfileRecord, AnchorBatchRecord, AnchorClaimPatch, AvatarAssetReference, CommissionRequestEvent, CommissionRequestRecord, FollowRecord, PaymentRecord, QuoteRecord, RealizationRecord, RealizeCommissionRecord, RealizeFailureEvidence, RealizeRefundApproval, RealizeResolutionAuditEvent, RightsAgreementRecord, StoredPost, VoxStore} from "./types.js";
import { verifyProofBundle, type ProofBundle } from "./verifier.js";
import { AsyncMutex } from "./mutex.js";
import {ConversationConflict, registerConversationRoutes, validateConversationPost} from "./conversations.js";
import {decodeDirectMessageCursor, encodeDirectMessageCursor} from "./direct-message-pagination.js";
import { createAnchorTaskDispatcherFromEnv, type AnchorTaskDispatcher } from "./tasks.js";
import { registerPublicRoutes, defaultDocsDir, defaultWebDistDir } from "./public.js";
import { canonicalUsername, isReservedUsername } from "./usernames.js";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {Readable} from "node:stream";

import {
  HttpPopuliRealizeClient,
  RealizeProviderHttpError,
  HttpSolanaRealizeSettlementClient,
  RealizeCreatorPayoutConfigurationV1Schema,
  DEFAULT_MAINNET_PRICING_POLICY,
  requiresExplicitMainnetRefundApproval,
  FIRST_PARTY_RIGHTS_REFERENCE_PREFIX,
  createFirstPartyRealizeRightsPolicy,
  buildRealizeQuote,
  createRealizeSettlementInstruction,
  generationParametersHash,
  newRealizeId,
  realizeCanonicalHash,
  validateProviderPrice,
  type PopuliRealizeClient,
  type RealizeCreatorPayoutConfigurationV1,
  type RealizePaymentIntentResolutionV1,
  type RealizeRefundResponseV1,
  type SolanaRealizeSettlementClient
} from "./realize-engine.js";
import {configuredDevnetRealizeEscrow, type DevnetRealizeEscrowClient} from "./realize-solana-devnet.js";
import {configuredNftService, fulfillmentOutputToNftInput, isMainnetNftChain, legacyRealizationToNftInput, NftMintService, verifyNftWalletProof} from "./nft.js";
import {configuredMainnetRealizePaymentRail, isManagedRealizeSettlementConfigured, type MainnetSplUsdcFundingAuthorization, type RealizePaymentRail} from "./realize-payment.js";
import {summarizeCharacterAccount} from "./character-account.js";

const DIRECT_MESSAGE_MAX_TEXT_LENGTH = 280;
const DIRECT_MESSAGE_MAX_ATTACHMENTS = 4;
const DIRECT_MESSAGE_MAX_MEDIA_BYTES = 25_000_000;
const DIRECT_MESSAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "video/mp4", "video/webm", "video/quicktime"]);
const DirectMessageAttachmentSchema = z.object({
  asset_hash: z.string().regex(/^[0-9a-f]{64}$/),
  file_name: z.string().min(1).max(180).refine((value) => value.trim().length > 0),
  media_type: z.string().refine((value) => DIRECT_MESSAGE_MEDIA_TYPES.has(value), "unsupported media type"),
  byte_length: z.number().int().positive().max(DIRECT_MESSAGE_MAX_MEDIA_BYTES),
  kind: z.enum(["image", "audio", "video"])
}).strict();
const DirectMessageRequestSchema = z.object({
  recipient_id: z.string().regex(/^vox:(?:human|agent):[A-Za-z0-9_-]{43}$/),
  client_message_id: z.string().uuid(),
  created_at: z.string().datetime({offset: true}),
  text: z.string().max(DIRECT_MESSAGE_MAX_TEXT_LENGTH),
  attachments: z.array(DirectMessageAttachmentSchema).max(DIRECT_MESSAGE_MAX_ATTACHMENTS),
  source_post_id: z.string().regex(/^vox:post:[0-9a-f]{64}$/).optional(),
  bid_amount_usdc_atomic: z.string().regex(/^[1-9][0-9]{0,10}$/).optional()
}).strict().superRefine((message, context) => {
  if (message.bid_amount_usdc_atomic && BigInt(message.bid_amount_usdc_atomic) > 10_000_000_000n) context.addIssue({code: "custom", path: ["bid_amount_usdc_atomic"], message: "bid exceeds the 10,000 USDC limit"});
  if (message.text.trim().length === 0 && message.attachments.length === 0) context.addIssue({code: "custom", path: ["text"], message: "a message needs text or an attachment"});
  if (message.attachments.reduce((total, attachment) => total + attachment.byte_length, 0) > DIRECT_MESSAGE_MAX_MEDIA_BYTES) context.addIssue({code: "custom", path: ["attachments"], message: "attachments exceed the 25 MB message limit"});
  if (new Set(message.attachments.map((attachment) => attachment.asset_hash)).size !== message.attachments.length) context.addIssue({code: "custom", path: ["attachments"], message: "duplicate attachments are not allowed"});
  for (const attachment of message.attachments) {
    if (attachment.media_type.split("/", 1)[0] !== attachment.kind) context.addIssue({code: "custom", path: ["attachments"], message: "attachment kind must match its media type"});
  }
});

export interface AppOptions {
  store?: VoxStore;
  instanceId?: string;
  instanceSecretKey?: Uint8Array;
  instancePublicKey?: string;
  corsOrigin?: string;
  maxPostsPerHour?: number;
  internalToken?: string;
  publicBaseUrl?: string;
  webDistDir?: string;
  docsDir?: string;
  avatarStore?: AvatarAssetStore;
  directMessageMediaStore?: DirectMessageMediaStore;
  populiRealizeClient?: PopuliRealizeClient;
  solanaRealizeSettlementClient?: SolanaRealizeSettlementClient;
  devnetRealizeEscrowClient?: DevnetRealizeEscrowClient;
  mainnetRealizePaymentRail?: RealizePaymentRail<MainnetSplUsdcFundingAuthorization>;
  nftService?: NftMintService;
}

interface AppContext {
  store: VoxStore;
  avatarStore: AvatarAssetStore;
  directMessageMediaStore: DirectMessageMediaStore;
  publicBaseUrl: string;
  instanceId: string;
  instanceSecretKey: Uint8Array;
  instancePublicKey: string;
  maxPostsPerHour: number;
  internalToken: string | undefined;
  publishTimes: Map<string, number[]>;
  avatarUploadTimes: Map<string, number[]>;
  directMessageSendTimes: Map<string, number[]>;
  directMessageMediaUploadTimes: Map<string, number[]>;
  media: MockMediaProvider;
  populiRealizeClient: PopuliRealizeClient;
  solanaRealizeSettlementClient: SolanaRealizeSettlementClient;
  devnetRealizeEscrowClient?: DevnetRealizeEscrowClient;
  mainnetRealizePaymentRail?: RealizePaymentRail<MainnetSplUsdcFundingAuthorization>;
  nftService?: NftMintService;
  dispatcher: AnchorTaskDispatcher;
  rateMutex: AsyncMutex;
}

function envNumber(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function createDefaultStore(): Promise<VoxStore> {
  const storage = process.env.VOX_STORAGE ?? "memory";
  if (storage === "file") {
    const stateDir = process.env.VOX_STATE_DIR ?? ".vox-local";
    const filePath = join(stateDir, "state.json");
    await mkdir(dirname(filePath), {recursive: true});
    return FileStore.open(filePath);
  }
  // FirestoreStore is loaded only when explicitly configured. Local commands do
  // not require Application Default Credentials or a GCP project.
  if (storage === "firestore") {
    const {FirestoreStore} = await import("./firestore-store.js");
    const firestoreOptions = {
      ...(process.env.GOOGLE_CLOUD_PROJECT ? {projectId: process.env.GOOGLE_CLOUD_PROJECT} : {}),
      ...(process.env.VOX_FIRESTORE_DATABASE ? {databaseId: process.env.VOX_FIRESTORE_DATABASE} : {})
    };
    return new FirestoreStore(firestoreOptions);
  }
  if (storage === "memory") return new MemoryStore();
  throw new Error(`unsupported VOX_STORAGE: ${storage}`);
}

function createInstanceKeys(options: AppOptions): {secretKey: Uint8Array; publicKey: string} {
  if (options.instanceSecretKey) {
    const pair = generateKeyPair(options.instanceSecretKey.length === 32 ? options.instanceSecretKey : undefined);
    if (options.instanceSecretKey.length === 64) {
      const parsed = parseSecretKey(bytesToBase64UrlSafe(options.instanceSecretKey));
      return {secretKey: parsed, publicKey: publicKeyBase64(generateKeyPair(parsed.slice(0, 32)).publicKey)};
    }
    return {secretKey: pair.secretKey, publicKey: publicKeyBase64(pair.publicKey)};
  }
  const configured = process.env.VOX_INSTANCE_SECRET_KEY;
  if (configured) {
    const secretKey = parseSecretKey(configured);
    const publicKey = publicKeyBase64(generateKeyPair(secretKey.slice(0, 32)).publicKey);
    return {secretKey, publicKey};
  }
  if (process.env.NODE_ENV === "production") throw new Error("VOX_INSTANCE_SECRET_KEY is required in production");
  const generated = generateKeyPair();
  return {secretKey: generated.secretKey, publicKey: publicKeyBase64(generated.publicKey)};
}

function bytesToBase64UrlSafe(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseBody<T>(schema: {safeParse(value: unknown): {success: true; data: T} | {success: false; error: {issues: Array<{path: PropertyKey[]; message: string}>}}}, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid_request", parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; "));
  return parsed.data;
}

function postResponse(post: StoredPost): StoredPost {
  return post;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function requestUsername(value: string): string {
  const username = canonicalUsername(value);
  if (!username) throw new HttpError(400, "invalid_username", "username must use 1-15 lowercase letters, numbers, or underscores");
  return username;
}

function corsOrigins(value: string | undefined): string | string[] | true {
  const origins = (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) return true;
  return origins.length === 1 ? origins[0]! : origins;
}

function currentEpoch(): string {
  return `${new Date().toISOString().slice(0, 10)}Z`;
}

function internalAuthorized(request: {headers: Record<string, unknown>}, expected: string | undefined): boolean {
  if (!expected) return true;
  const value = request.headers["x-vox-internal-token"];
  return typeof value === "string" && value === expected;
}

const AnchorClaimRequestSchema = z.object({
  owner_id: z.string().min(1).max(200),
  authority_id: z.string().min(1).max(160),
  epoch: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2})?Z$/),
  tier: z.enum(["all", "free", "premium", "premium_plus", "custom"]),
  kind: z.enum(["BATCH", "POST"]),
  limit: z.number().int().min(1).max(200).default(200),
  lease_seconds: z.number().int().min(30).max(900).default(300)
}).strict();

const AnchorClaimPatchSchema = z.object({
  owner_id: z.string().min(1).max(200),
  state: z.enum(["claimed", "manifested", "submitting", "uncertain", "submitted", "finalized", "retryable_failure"]).optional(),
  manifest: BatchManifestV1Schema.optional(),
  manifest_uri: z.string().url().optional(),
  receipt: AnchorReceiptV1Schema.optional(),
  transaction_signature: z.string().min(1).max(200).optional(),
  next_attempt_at: z.string().datetime({offset: true}).optional(),
  error: z.string().max(1000).optional(),
  lease_seconds: z.number().int().min(30).max(900).optional(),
  clear_lease: z.boolean().optional()
}).strict();

const RealizationQuoteRequestSchema = z.object({
  style: MediaStyleSchema.default("cinematic"),
  duration_seconds: z.coerce.number().int().min(1).max(120).default(12),
  requester_id: z.string().min(1).max(160).default("anonymous"),
  generation_description: z.string().trim().min(1).max(2_000).default("Create a video realization of the source post."),
  commission_request_id: z.string().regex(/^vox:request:[0-9a-f]{64}$/).optional()
}).strict();

const RealizationRequestSchema = z.object({
  quote_id: z.string().min(1).max(200),
  post_id: z.string().regex(/^vox:post:[0-9a-f]{64}$/),
  requester_id: z.string().min(1).max(160).optional(),
  commission_request_id: z.string().regex(/^vox:request:[0-9a-f]{64}$/).optional(),
  payment_reference: z.string().min(1).max(240).optional(),
  payment_signature: z.string().min(1).max(240).optional(),
  /** A public label is stored only when the commissioner explicitly submits it. */
  public_attribution: z.string().trim().min(1).max(120).optional()
}).strict();

type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";
type PaymentConfiguration =
  | {mode: "mock"; network: "offchain"; cluster: "local"}
  | {mode: "direct"; network: "solana"; cluster: SolanaCluster; usdc_mint: string; destination_token_account: string};

function configuredPayment(): PaymentConfiguration {
  const mode = process.env.VOX_PAYMENT_MODE ?? "mock";
  if (mode === "mock") return {mode: "mock", network: "offchain", cluster: "local"};
  if (mode !== "direct") throw new HttpError(501, "payment_not_configured", "payment mode must be mock or direct");
  const cluster = process.env.VOX_SOLANA_CLUSTER ?? "devnet";
  const usdcMint = process.env.VOX_USDC_MINT ?? "";
  const destinationTokenAccount = process.env.VOX_MERCHANT_USDC_TOKEN_ACCOUNT ?? "";
  if (!(["devnet", "testnet", "mainnet-beta"] as string[]).includes(cluster) || !isValidSolanaAddress(usdcMint) || !isValidSolanaAddress(destinationTokenAccount)) {
    throw new HttpError(503, "payment_not_configured", "direct USDC requires a valid Solana cluster, mint, and merchant token account");
  }
  return {mode: "direct", network: "solana", cluster: cluster as SolanaCluster, usdc_mint: usdcMint, destination_token_account: destinationTokenAccount};
}

function publicQuote(quote: QuoteRecord, configuration: PaymentConfiguration) {
  return {
    quote_id: quote.quote_id,
    post_id: quote.post_id,
    style: quote.style,
    duration_seconds: quote.duration_seconds,
    generation_description: quote.generation_description,
    status: quote.status,
    amount_usdc_atomic: quote.amount_usdc_atomic,
    currency: quote.currency,
    expires_at: quote.expires_at,
    provider_id: quote.provider_id,
    mock: quote.mock,
    payment: configuration.mode === "direct" ? {
      mode: "direct" as const,
      network: "solana" as const,
      cluster: configuration.cluster,
      usdc_mint: configuration.usdc_mint,
      destination_token_account: configuration.destination_token_account,
      token_decimals: 6,
      payment_reference: quote.payment_reference ?? paymentReferenceForQuote(quote.quote_id)
    } : {mode: "mock" as const, network: "offchain" as const}
  };
}

function paymentReferenceForQuote(quoteId: string): string {
  return `vox:payment:${quoteId}`;
}

const ReactionRequestSchema = z.object({
  reaction: z.literal("like"),
  actor_id: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional()
}).strict();

const FollowIntentSchema = z.object({
  protocol: z.literal("vox.follow/1"),
  follower_type: z.enum(["agent", "human"]),
  follower_id: z.string().regex(/^vox:(?:agent|human):[A-Za-z0-9_-]{43}$/),
  target_type: z.enum(["agent", "human"]),
  target_id: z.string().min(1).max(160),
  action: z.enum(["follow", "unfollow"]),
  created_at: z.string().datetime({offset: true}),
  operation_id: z.string().uuid()
}).strict().superRefine((intent, issue) => {
  const followerPrefix = intent.follower_type === "agent" ? "vox:agent:" : "vox:human:";
  if (!intent.follower_id.startsWith(followerPrefix)) issue.addIssue({code: z.ZodIssueCode.custom, path: ["follower_id"], message: "follower_id does not match follower_type"});
  const prefix = intent.target_type === "agent" ? "vox:agent:" : "vox:human:";
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`).test(intent.target_id)) issue.addIssue({code: z.ZodIssueCode.custom, path: ["target_id"], message: "target_id does not match target_type"});
});

const FollowRequestSchema = z.object({intent: FollowIntentSchema, signature: z.string().min(64).max(128)}).strict();

const AnchorRunRequestSchema = z.object({
  epoch: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2})?Z$/).optional(),
  limit: z.number().int().min(1).max(5000).default(500)
}).strict();

const AnchorBatchRequestSchema = z.object({
  manifest: BatchManifestV1Schema,
  receipt: AnchorReceiptV1Schema.optional()
}).strict();

const AnchorStatusRequestSchema = z.object({
  post_ids: z.array(z.string().regex(/^vox:post:[0-9a-f]{64}$/)).min(1).max(5000),
  patch: AnchorObligationSchema.partial().strict()
}).strict();

const CreateRealizeCommissionRequestSchema = z.object({
  commissioner_id: z.string().min(1).max(256),
  creator_id: z.string().min(1).max(256),
  capability_id: z.string().min(1).max(256),
  requested_generation_parameters: GenerationParametersV1Schema,
  rights_agreement_reference: z.string().min(1).max(256),
  source_post_id: z.string().regex(/^vox:post:[0-9a-f]{64}$/).optional()
}).strict();

const AcceptRealizeQuoteRequestSchema = z.object({
  quote_id: z.string().min(1).max(256),
  canonical_quote_hash: z.string().regex(/^[0-9a-f]{64}$/),
  payer_wallet: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana wallet"),
  rights_reviewed: z.literal(true),
  public_attribution: z.string().trim().min(1).max(120).optional(),
  nft_publication_consent: z.boolean().optional()
}).strict();
const FundRealizeCommissionRequestSchema = z.object({
  payer_wallet: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana wallet"),
  transaction_signature: z.string().min(64).max(128)
}).strict();
const RefundRealizeCommissionRequestSchema = FundRealizeCommissionRequestSchema;
const ApproveRealizeRefundRequestSchema = z.object({
  payer_wallet: z.string().min(32).max(64).refine(isValidSolanaAddress, "must be a valid Solana wallet"),
  funding_signature: z.string().min(64).max(128),
  payment_intent_id: z.string().min(1).max(256),
  accepted_quote_hash: z.string().regex(/^[0-9a-f]{64}$/),
  amount_usdc_atomic: z.string().regex(/^[1-9][0-9]{0,19}$/),
  reason: z.string().trim().min(10).max(1_000)
}).strict();
const ArmStagingNoRenderFailureRequestSchema = z.object({reason: z.string().trim().min(10).max(500)}).strict();
const InternalRealizeReconcileRequestSchema = z.object({limit: z.number().int().min(1).max(100).default(25)}).strict();
const InternalNftReconcileRequestSchema = z.object({limit: z.number().int().min(1).max(100).default(25)}).strict();
const NftClaimRequestSchema = z.object({wallet: z.string().min(32).max(128), signature: z.string().min(64).max(256)}).strict();
const RightsLedgerStatusRequestSchema = z.object({status: z.enum(["pending", "processing", "paid", "failed", "reversed"]), evidence_reference: z.string().min(1).max(256).optional()}).strict();

function requiredHeader(headers: Record<string, unknown>, name: string): string {
  const value = headers[name.toLowerCase()];
  if (typeof value !== "string" || value.length === 0) throw new HttpError(401, "unauthorized", `${name} header is required`);
  return value;
}

function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header is required and must be at most 256 characters");
  return value;
}

async function authorizeRealizeHuman(context: AppContext, headers: Record<string, unknown>, expectedPrincipalId: string | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  const principalId = requiredHeader(headers, "x-vox-realize-human-id");
  if (expectedPrincipalId && principalId !== expectedPrincipalId) throw new HttpError(403, "forbidden", "signed principal does not match the commissioner");
  const issuedAt = requiredHeader(headers, "x-vox-realize-timestamp");
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) throw new HttpError(401, "signature_expired", "Realize request signature timestamp is outside the five-minute window");
  const human = await context.store.getHuman(principalId);
  if (!human) throw new HttpError(401, "unauthorized", "a registered VOX human identity is required");
  const signature = requiredHeader(headers, "x-vox-realize-signature");
  const payload = realizeClientRequestSigningPayload({method, path, principal_id: principalId, issued_at: issuedAt, ...(body === undefined ? {} : {body})});
  if (!verifyBytes(payload, signature, human.registration.identity_public_key)) throw new HttpError(401, "invalid_signature", "Realize request signature is invalid");
  return principalId;
}

async function authorizeAgentDirectMessage(context: AppContext, headers: Record<string, unknown>, method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  const principalId = requiredHeader(headers, "x-vox-agent-id");
  const issuedAt = requiredHeader(headers, "x-vox-agent-timestamp");
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) throw new HttpError(401, "signature_expired", "agent DM signature timestamp is outside the five-minute window");
  const agent = await context.store.getAgent(principalId);
  if (!agent) throw new HttpError(401, "unauthorized", "a registered VOX agent identity is required");
  const signature = requiredHeader(headers, "x-vox-agent-signature");
  const payload = agentDirectMessageRequestSigningPayload({method, path, principal_id: principalId, issued_at: issuedAt, ...(body === undefined ? {} : {body})});
  if (!verifyBytes(payload, signature, agent.registration.identity_public_key)) throw new HttpError(401, "invalid_signature", "agent DM request signature is invalid");
  return principalId;
}

async function authorizeDirectMessagePrincipal(context: AppContext, headers: Record<string, unknown>, method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  if (typeof headers["x-vox-realize-human-id"] === "string") return authorizeRealizeHuman(context, headers, undefined, method, path, body);
  return authorizeAgentDirectMessage(context, headers, method, path, body);
}

async function authorizeHumanRequest(context: AppContext, headers: Record<string, unknown>, method: "GET", path: string): Promise<string> {
  const principalId = requiredHeader(headers, "x-vox-human-id");
  const issuedAt = requiredHeader(headers, "x-vox-human-timestamp");
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) throw new HttpError(401, "signature_expired", "Human request signature timestamp is outside the five-minute window");
  const human = await context.store.getHuman(principalId);
  if (!human) throw new HttpError(401, "unauthorized", "a registered VOX human identity is required");
  const signature = requiredHeader(headers, "x-vox-human-signature");
  const payload = humanClientRequestSigningPayload({method, path, principal_id: principalId, issued_at: issuedAt});
  if (!verifyBytes(payload, signature, human.registration.identity_public_key)) throw new HttpError(401, "invalid_signature", "Human request signature is invalid");
  return principalId;
}

async function authorizeFollowViewer(context: AppContext, headers: Record<string, unknown>, path: string): Promise<{followerType: "agent" | "human"; followerId: string}> {
  // Keep the existing browser account signature valid while also allowing agents
  // to read their own follow state using a root identity signature.
  if (typeof headers["x-vox-human-id"] === "string") {
    return {followerType: "human", followerId: await authorizeHumanRequest(context, headers, "GET", path)};
  }
  const followerType = requiredHeader(headers, "x-vox-follower-type");
  if (followerType !== "agent" && followerType !== "human") throw new HttpError(400, "invalid_follower_type", "follower type must be agent or human");
  const followerId = requiredHeader(headers, "x-vox-follower-id");
  if (!followerId.startsWith(followerType === "agent" ? "vox:agent:" : "vox:human:")) throw new HttpError(400, "invalid_follower_id", "follower id does not match follower type");
  const issuedAt = requiredHeader(headers, "x-vox-follower-timestamp");
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) throw new HttpError(401, "signature_expired", "Follow viewer signature timestamp is outside the five-minute window");
  const principal = followerType === "agent" ? await context.store.getAgent(followerId) : await context.store.getHuman(followerId);
  if (!principal) throw new HttpError(401, "unauthorized", "a registered VOX identity is required");
  const signature = requiredHeader(headers, "x-vox-follower-signature");
  const payload = followViewerSigningPayload({method: "GET", path, principal_type: followerType, principal_id: followerId, issued_at: issuedAt});
  if (!verifyBytes(payload, signature, principal.registration.identity_public_key)) throw new HttpError(401, "invalid_signature", "Follow viewer signature is invalid");
  return {followerType, followerId};
}

function requireRealizeAdmin(context: AppContext, headers: Record<string, unknown>): void {
  if (!context.internalToken) throw new HttpError(503, "realize_admin_auth_unconfigured", "Realize payout configuration requires VOX_INTERNAL_TOKEN");
  if (!internalAuthorized({headers}, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
}

function configuredRealizeOperatorIds(): string[] {
  return (process.env.VOX_REALIZE_OPERATOR_HUMAN_IDS ?? "").split(",").map((value) => value.trim()).filter((value) => /^vox:human:[A-Za-z0-9_-]{43}$/.test(value));
}

function isRealizeOperatorApprovalsConfigured(): boolean {
  return configuredRealizeOperatorIds().length > 0;
}

async function authorizeRealizeOperator(context: AppContext, request: {headers: Record<string, unknown>}, path: string, body: unknown): Promise<{operatorId: string; approvedAt: string; signature: string; payloadHash: string}> {
  requireRealizeAdmin(context, request.headers);
  const operatorId = await authorizeRealizeHuman(context, request.headers, undefined, "POST", path, body);
  const allowed = configuredRealizeOperatorIds();
  if (allowed.length === 0) throw new HttpError(503, "realize_operator_auth_unconfigured", "Mainnet refund approvals require an allowlisted VOX operator identity");
  if (!allowed.includes(operatorId)) throw new HttpError(403, "realize_operator_forbidden", "VOX human identity is not authorized to approve Mainnet refunds");
  const issuedAt = requiredHeader(request.headers, "x-vox-realize-timestamp");
  const signature = requiredHeader(request.headers, "x-vox-realize-signature");
  const payload = realizeClientRequestSigningPayload({method: "POST", path, principal_id: operatorId, issued_at: issuedAt, body});
  return {operatorId, approvedAt: new Date().toISOString(), signature, payloadHash: createHash("sha256").update(payload).digest("hex")};
}

function isConfiguredFirstPartyCreator(creatorId: string): boolean {
  const configured = (process.env.VOX_REALIZE_FIRST_PARTY_CREATOR_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return configured.includes(creatorId);
}

function assertMainnetPricingLimits(configuration: RealizeCreatorPayoutConfigurationV1): void {
  if (configuration.network_id !== "solana:mainnet-beta") return;
  const policy = configuration.mainnet_pricing_policy ?? DEFAULT_MAINNET_PRICING_POLICY;
  const runtimeMinimum = process.env.VOX_REALIZE_MAINNET_MIN_PAYMENT_USDC_ATOMIC ?? "1000000";
  const runtimeMaximum = process.env.VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC ?? "10000000000";
  if (!/^[1-9][0-9]{0,10}$/.test(runtimeMinimum) || !/^[1-9][0-9]{0,10}$/.test(runtimeMaximum) || BigInt(runtimeMinimum) < 1_000_000n || BigInt(runtimeMaximum) > 10_000_000_000n || BigInt(runtimeMinimum) > BigInt(runtimeMaximum) || BigInt(policy.minimum_total_usdc_atomic) < BigInt(runtimeMinimum) || BigInt(policy.maximum_total_usdc_atomic) > BigInt(runtimeMaximum)) {
    throw new HttpError(503, "mainnet_pricing_mismatch", "Mainnet quote policy exceeds the configured checkout limits");
  }
}

async function activeRealizeRightsAgreement(context: AppContext, configuration: RealizeCreatorPayoutConfigurationV1, commissionerId: string, commissionId: string) {
  if (configuration.rights_policy_mode === "first_party") {
    const policy = createFirstPartyRealizeRightsPolicy(configuration);
    if (!isConfiguredFirstPartyCreator(configuration.creator_id) || configuration.character_owner_id !== configuration.creator_id || configuration.rights_agreement_reference !== policy.policy.policy_id || configuration.rights_agreement_version !== policy.policy.version || configuration.rights_agreement_hash !== policy.terms_hash) throw new HttpError(409, "first_party_policy_invalid", "first-party rights policy is not configured for this VOX-owned creator");
    return undefined;
  }
  const record = await context.store.getRightsAgreement(configuration.rights_agreement_reference, configuration.rights_agreement_version);
  if (!record || record.status !== "active" || record.terms_hash !== configuration.rights_agreement_hash || computeRevenueRightsAgreementHash(record.agreement) !== record.terms_hash) throw new HttpError(409, "rights_agreement_required", "an active, accepted rights agreement matching the payout policy is required");
  const agreement = record.agreement;
  const now = Date.now();
  const scopeMatches = agreement.artifact_scope.subject_type === "commission"
    ? agreement.artifact_scope.subject_id === commissionId
    : agreement.artifact_scope.subject_id === configuration.rights_subject_id;
  if (!scopeMatches || !agreement.eligible_transaction_types.includes("commission") || !agreement.grant.rights.includes("generate") || Date.parse(agreement.duration.starts_at) > now || agreement.duration.ends_at && Date.parse(agreement.duration.ends_at) <= now || agreement.grant.expires_at && Date.parse(agreement.grant.expires_at) <= now) throw new HttpError(409, "rights_agreement_required", "rights agreement does not authorize this creator commission at the current time");
  const parties = new Map(agreement.parties.map((party) => [party.party_id, party.role]));
  // A standing commissioner clause lets each customer accept the published terms
  // by signing accept-quote. The customer's identity remains separate from their wallet.
  const commissionerPartyId = parties.get(commissionerId) === "commissioner"
    ? commissionerId
    : parties.get(REALIZE_COMMISSIONER_ROLE_PARTY_ID) === "commissioner" ? REALIZE_COMMISSIONER_ROLE_PARTY_ID : undefined;
  if (!commissionerPartyId || !parties.has(configuration.creator_id)) throw new HttpError(403, "rights_party_missing", "commissioner and creator must be covered by the active rights agreement");
  if (parties.get(configuration.character_owner_id) !== "character_owner") throw new HttpError(409, "rights_recipient_unauthorized", "configured character owner must be a character-owner party to the active rights agreement");
  const requiredParties = new Set(agreement.required_acceptance_party_ids);
  const acceptances = new Map(agreement.acceptances.map((acceptance) => [acceptance.party_id, acceptance]));
  if ([...requiredParties].some((partyId) => !acceptances.has(partyId) || acceptances.get(partyId)!.terms_hash !== record.terms_hash || !verifyRightsAgreementAcceptance(agreement.agreement_id, agreement.version, acceptances.get(partyId)!))) throw new HttpError(409, "rights_agreement_required", "rights agreement acceptances are incomplete or invalid");
  const checkPayoutParties = (recipients: Array<{recipient_id: string}>, roles: string[]) => recipients.every((recipient) => roles.includes(parties.get(recipient.recipient_id) ?? ""));
  const providerRecipients = configuration.provider_payouts.flatMap((provider) => provider.recipients);
  if (!checkPayoutParties(providerRecipients, ["provider", "creator"]) || !checkPayoutParties(configuration.character_owner_markup.recipients, ["character_owner", "creator"]) || !checkPayoutParties(configuration.platform_fee.recipients, ["platform", "distributor"]) || !checkPayoutParties(configuration.additional_beneficiaries, ["beneficiary", "commissioner", "distributor"])) throw new HttpError(409, "rights_recipient_unauthorized", "every configured payout recipient must be authorized by the active rights agreement");
  return record;
}

async function authorizedRightsSigner(context: AppContext, partyId: string, keyId: string, publicKey: string, signedAt: string): Promise<boolean> {
  if (partyId.startsWith("vox:human:")) {
    const human = await context.store.getHuman(partyId);
    return !!human && keyId === "root" && human.registration.identity_public_key === publicKey;
  }
  if (partyId.startsWith("vox:agent:")) {
    const agent = await context.store.getAgent(partyId);
    if (!agent) return false;
    if (keyId === "root") return agent.registration.identity_public_key === publicKey;
    return keyId === `publisher:${publicKey}` && isPublisherKeyAuthorizedAt(agent.registration, publicKey, signedAt);
  }
  return false;
}

function rightsAuditEvent(input: {agreement_id: string; version: number; kind: "proposed" | "accepted" | "terminated" | "superseded" | "revenue_recorded" | "allocation_status_changed" | "referral_attributed" | "referral_reward_recorded"; actor_id: string; record_hash: string; occurred_at: string; evidence_reference?: string}) {
  return {event_id: randomUUID(), ...input};
}

function rightsRecordHasValidAcceptances(record: RightsAgreementRecord): boolean {
  const {agreement, terms_hash} = record;
  if (computeRevenueRightsAgreementHash(agreement) !== terms_hash) return false;
  const acceptances = new Map(agreement.acceptances.map((acceptance) => [acceptance.party_id, acceptance]));
  return agreement.required_acceptance_party_ids.every((partyId) => {
    const acceptance = acceptances.get(partyId);
    return !!acceptance && acceptance.terms_hash === terms_hash && verifyRightsAgreementAcceptance(agreement.agreement_id, agreement.version, acceptance);
  });
}

function rightsRecordEffectiveAt(record: RightsAgreementRecord, occurredAt: number): boolean {
  const {agreement} = record;
  if (record.status !== "active" && record.status !== "terminated") return false;
  if (!rightsRecordHasValidAcceptances(record)) return false;
  const acceptedAt = Math.max(...agreement.required_acceptance_party_ids.map((partyId) => Date.parse(agreement.acceptances.find((acceptance) => acceptance.party_id === partyId)!.accepted_at)));
  if (occurredAt < acceptedAt || occurredAt < Date.parse(agreement.duration.starts_at) || agreement.duration.ends_at && occurredAt >= Date.parse(agreement.duration.ends_at)) return false;
  if (agreement.grant.expires_at && occurredAt >= Date.parse(agreement.grant.expires_at)) return false;
  if (record.terminated_at && occurredAt >= Date.parse(record.terminated_at)) return false;
  return true;
}

function eligibleRightsProceeds(record: RightsAgreementRecord, event: z.infer<typeof RightsRevenueEventV1Schema>): bigint {
  const {revenue_definition: definition} = record.agreement;
  if (definition.basis === "gross_received") return BigInt(event.gross_proceeds_usdc_atomic);
  const permitted = new Set(definition.permitted_deductions);
  if (event.deductions.some((deduction) => !permitted.has(deduction.type))) throw new HttpError(409, "unpermitted_revenue_deduction", "transaction contains deductions not allowed by the accepted revenue definition");
  const deductions = event.deductions.reduce((total, deduction) => total + BigInt(deduction.amount_usdc_atomic), 0n);
  return BigInt(event.gross_proceeds_usdc_atomic) - deductions;
}

function sameRightsScope(agreementScope: {subject_type: string; subject_id: string; artifact_sha256?: string | undefined}, eventScope: {subject_type: string; subject_id: string; artifact_sha256?: string | undefined}): boolean {
  return agreementScope.subject_type === eventScope.subject_type && agreementScope.subject_id === eventScope.subject_id && (!agreementScope.artifact_sha256 || agreementScope.artifact_sha256 === eventScope.artifact_sha256);
}

async function validateRightsAgreementProvenance(context: AppContext, agreement: import("@vox/protocol").RevenueRightsAgreementV1): Promise<void> {
  let linkedVoxRecord = false;
  for (const reference of agreement.provenance_references) {
    const post = await context.store.getPost(reference.record_id);
    const commissionRequest = await context.store.getCommissionRequest(reference.record_id);
    const commission = await context.store.getRealizeCommission(reference.record_id);
    const provenance = await context.store.getRealizeProvenance(reference.record_id);
    if (!post && !commissionRequest && !commission && !provenance) throw new HttpError(409, "rights_provenance_mismatch", "every provenance reference must resolve to a stored VOX record");
    if (post?.publication_status === "published") linkedVoxRecord = true;
    if (commissionRequest || commission || provenance) linkedVoxRecord = true;
    if (reference.category === "authorship" && (!post || post.publication_status !== "published" || post.intent.agent_id !== reference.party_id)) throw new HttpError(409, "rights_provenance_mismatch", "authorship provenance must reference a published VOX post by the named party");
    if (reference.category === "commissioning") {
      const commissionerId = commissionRequest?.intent.human_id ?? commission?.commission.commissioner_id;
      if (!commissionerId || commissionerId !== reference.party_id) throw new HttpError(409, "rights_provenance_mismatch", "commissioning provenance must reference a VOX commission by the named party");
    }
  }
  if (!linkedVoxRecord) throw new HttpError(409, "rights_provenance_required", "agreement provenance must include a published post, commission, fulfillment, or other stored VOX record");
}

function rightsPayoutInstructions(allocations: Array<import("@vox/protocol").RightsRevenueAllocationV1>, rewards: Array<import("@vox/protocol").DistributionRewardV1>) {
  return [
    ...allocations.map((entry) => RightsPayoutInstructionV1Schema.parse({protocol_version: "realize/1", instruction_id: `instruction:${entry.allocation_id}`, ledger_entry_id: entry.allocation_id, beneficiary_id: entry.beneficiary_id, asset: "USDC", amount_usdc_atomic: entry.amount_usdc_atomic, payment_status: entry.payment_status, created_at: entry.created_at})),
    ...rewards.map((entry) => RightsPayoutInstructionV1Schema.parse({protocol_version: "realize/1", instruction_id: `instruction:${entry.reward_id}`, ledger_entry_id: entry.reward_id, beneficiary_id: entry.referrer_id, asset: "USDC", amount_usdc_atomic: entry.reward_amount_usdc_atomic, payment_status: entry.payment_status, created_at: entry.created_at}))
  ];
}

function rightsLedgerId(kind: "share" | "referral", eventId: string, beneficiaryId: string): string {
  const digest = bytesToHex(domainHash("vox.realize.rights.ledger.id.v1", canonicalBytes({kind, event_id: eventId, beneficiary_id: beneficiaryId})));
  return `rights-ledger:${digest}`;
}

function updatedRealizeCommission(current: RealizeCommissionRecord, changes: Partial<RealizeCommissionRecord["commission"]>, recordChanges: Partial<Omit<RealizeCommissionRecord, "commission">> = {}): RealizeCommissionRecord {
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString();
  const commission = CommissionV1Schema.parse({...current.commission, ...changes, updated_at: updatedAt});
  if (changes.state && changes.state !== current.commission.state && !canTransitionRealizeCommission(current.commission.state, changes.state)) throw new HttpError(409, "invalid_state_transition", `cannot transition commission from ${current.commission.state} to ${changes.state}`);
  return {...current, ...recordChanges, commission, updated_at: updatedAt};
}

function resolutionEvent(input: {
  commissionId: string;
  action: RealizeResolutionAuditEvent["action"];
  actorType: RealizeResolutionAuditEvent["actor_type"];
  actorId: string;
  evidenceHash?: string;
  reasonCode?: string;
}): RealizeResolutionAuditEvent {
  const eventId = `vox:realize-resolution:${createHash("sha256").update(`${input.commissionId}\u0000${input.action}\u0000${input.actorId}\u0000${input.evidenceHash ?? input.reasonCode ?? ""}`).digest("hex")}`;
  return {event_id: eventId, action: input.action, actor_type: input.actorType, actor_id: input.actorId, occurred_at: new Date().toISOString(), ...(input.evidenceHash ? {evidence_hash: input.evidenceHash} : {}), ...(input.reasonCode ? {reason_code: input.reasonCode} : {})};
}

function appendResolutionEvent(record: RealizeCommissionRecord, event: RealizeResolutionAuditEvent): RealizeResolutionAuditEvent[] {
  const events = record.resolution_events ?? [];
  return events.some((item) => item.event_id === event.event_id) ? events : [...events, event];
}

function realizeIssuerKeyId(context: AppContext): string {
  return `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${context.instanceId}\u0000${context.instancePublicKey}`)))}`;
}

function assertRealizeQuoteConfiguration(context: AppContext, quote: import("@vox/protocol").RealizeQuoteV1, configuration: RealizeCreatorPayoutConfigurationV1): void {
  const configurationHash = bytesToHex(domainHash("vox.realize.payout-configuration.v1", canonicalBytes(configuration)));
  const expectedMainnetPolicy = configuration.network_id === "solana:mainnet-beta" ? configuration.mainnet_pricing_policy ?? DEFAULT_MAINNET_PRICING_POLICY : undefined;
  const pinnedPolicyMatches = expectedMainnetPolicy === undefined
    ? quote.revenue_allocation_policy === undefined
    : quote.revenue_allocation_policy !== undefined && bytesToHex(canonicalBytes(quote.revenue_allocation_policy)) === bytesToHex(canonicalBytes(expectedMainnetPolicy));
  if (computeRealizeQuoteHash(quote) !== quote.canonical_quote_hash || !verifyRealizeQuoteSignature(quote) || quote.issuer_id !== context.instanceId || quote.issuer_key_id !== realizeIssuerKeyId(context) || quote.issuer_public_key !== context.instancePublicKey || quote.payout_configuration_version !== configuration.version || quote.payout_configuration_hash !== configurationHash || quote.creator_id !== configuration.creator_id || quote.rights_agreement_reference !== configuration.rights_agreement_reference || quote.rights_agreement_version !== configuration.rights_agreement_version || quote.rights_agreement_hash !== configuration.rights_agreement_hash || (quote.rights_policy_mode ?? "signed_agreement") !== (configuration.rights_policy_mode ?? "signed_agreement") || !pinnedPolicyMatches || quote.usdc_mint !== configuration.usdc_mint || quote.network_id !== configuration.network_id || quote.settlement_program_version !== configuration.settlement_program_version) {
    throw new HttpError(409, "quote_configuration_mismatch", "quote signature or pinned payout, rights, and settlement configuration is invalid");
  }
}

function realizeRpcUrl(networkId: string): string {
  const configuredCluster = process.env.VOX_SOLANA_CLUSTER ?? "devnet";
  const cluster = networkId.replace("solana:", "");
  if (cluster !== configuredCluster) throw new HttpError(503, "payment_network_mismatch", "Realize payout policy network does not match the configured Solana payment network");
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (cluster === "mainnet-beta") return "https://api.mainnet-beta.solana.com";
  return `https://api.${cluster}.solana.com`;
}

function paymentRailForNetwork(context: AppContext, networkId: string, usdcMint: string): RealizePaymentRail<any> | undefined {
  if (context.devnetRealizeEscrowClient?.network.clusterIdentity === networkId && context.devnetRealizeEscrowClient.network.usdcMint === usdcMint) return context.devnetRealizeEscrowClient;
  if (context.mainnetRealizePaymentRail?.networkId === networkId && context.mainnetRealizePaymentRail.usdcMint === usdcMint) return context.mainnetRealizePaymentRail;
  return undefined;
}

function stagingNoRenderFailureEnabled(context: AppContext): boolean {
  return process.env.VOX_REALIZE_STAGING_FAILURE_REHEARSAL_ENABLED === "true" && context.instanceId === "instance:vox-realize-staging" && context.devnetRealizeEscrowClient?.network.clusterIdentity === "solana:devnet";
}

async function realizeFundingResponse(context: AppContext, record: RealizeCommissionRecord): Promise<unknown> {
  if (record.escrow_funding && context.devnetRealizeEscrowClient) {
    return {...record.escrow_funding, progress: await context.devnetRealizeEscrowClient.fundingProgress(record.escrow_funding)};
  }
  return record.direct_funding;
}

async function verifyRealizeOutput(configuration: RealizeCreatorPayoutConfigurationV1, output: {uri: string; media_type: string; sha256: string; byte_length: number}): Promise<void> {
  const url = new URL(output.uri);
  const providerHost = new URL(configuration.populi_api_base_url).hostname.toLowerCase();
  const allowedHosts = new Set([providerHost, ...configuration.artifact_hosts.map((host) => host.toLowerCase())]);
  if (!allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.hash || url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error("Fulfillment output URI is outside the configured provider artifact hosts");
  if (output.byte_length > configuration.max_artifact_bytes) throw new Error("Fulfillment output exceeds the configured artifact size limit");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {method: "GET", redirect: "error", signal: controller.signal});
    if (!response.ok || !response.body) throw new Error(`Fulfillment artifact is not available (HTTP ${response.status})`);
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== output.media_type.toLowerCase()) throw new Error("Fulfillment artifact media type does not match its provider record");
    const digest = createHash("sha256");
    const reader = response.body.getReader();
    let byteLength = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        byteLength += next.value.byteLength;
        if (byteLength > configuration.max_artifact_bytes || byteLength > output.byte_length) throw new Error("Fulfillment artifact exceeds its declared size");
        digest.update(next.value);
      }
    } finally { reader.releaseLock(); }
    if (byteLength !== output.byte_length || digest.digest("hex") !== output.sha256) throw new Error("Fulfillment artifact hash or byte length does not match the provider record");
  } finally { clearTimeout(timeout); }
}

async function createRealizeProvenance(context: AppContext, record: RealizeCommissionRecord, quote: import("@vox/protocol").RealizeQuoteV1, result: import("@vox/protocol").FulfillmentResultV1): Promise<import("@vox/protocol").ProvenanceRecordV1> {
  const outputsHash = realizeCanonicalHash(result.outputs, "vox.realize.output-set.v1");
  const provenanceId = `vox:provenance:${createHash("sha256").update(`${record.commission.commission_id}\u0000${quote.canonical_quote_hash}\u0000${outputsHash}`).digest("hex")}`;
  const rightsRecord = await context.store.getRightsAgreement(quote.rights_agreement_reference, quote.rights_agreement_version);
  const rightsProvenance = rightsRecord?.agreement.provenance_references
    .filter((reference) => reference.party_id !== record.commission.commissioner_id)
    .map((reference) => ({...reference})) ?? [];
  if (quote.rights_policy_mode === "first_party") {
    rightsProvenance.push({category: "commissioning", party_id: record.commission.creator_id, record_id: quote.rights_agreement_reference});
  } else if (!rightsProvenance.some((reference) => reference.category === "contractual_revenue_rights" && reference.record_id === quote.rights_agreement_reference)) {
    rightsProvenance.push({category: "contractual_revenue_rights", party_id: record.commission.creator_id, record_id: quote.rights_agreement_reference});
  }
  const unsigned = {
    protocol_version: "realize/1" as const,
    provenance_record_id: provenanceId,
    subject_type: "commission" as const,
    subject_id: record.commission.commission_id,
    creator_id: record.commission.creator_id,
    generation_provider_id: quote.generation_provider_id,
    commission_id: record.commission.commission_id,
    quote_hash: quote.canonical_quote_hash,
    rights_agreement_reference: quote.rights_agreement_reference,
    inputs: [
      {sha256: generationParametersHash(record.commission.requested_generation_parameters), media_type: "application/vnd.vox.realize.generation-parameters+json"},
      ...(quote.provider_price_quote_hash ? [{sha256: quote.provider_price_quote_hash, media_type: "application/vnd.vox.realize.provider-price+json"}] : [])
    ],
    // Public provenance proves artifact identity without publishing customer artifact URLs.
    outputs: result.outputs.map((output) => ({sha256: output.sha256, media_type: output.media_type, byte_length: output.byte_length})),
    parent_record_ids: [],
    rights_provenance: rightsProvenance,
    ...(record.public_attribution ? {public_attribution: record.public_attribution} : {}),
    created_at: result.completed_at,
    issuer_id: context.instanceId,
    issuer_key_id: realizeIssuerKeyId(context)
  };
  const signature = signBytes(concatBytes(utf8("vox.realize.provenance.v1"), new Uint8Array([0]), canonicalBytes(unsigned)), context.instanceSecretKey);
  return ProvenanceRecordV1Schema.parse({...unsigned, signature});
}

function expectedRealizeRefundId(commissionId: string, acceptedQuoteHash: string): string {
  const key = `vox:refund:${commissionId}:${acceptedQuoteHash}`;
  return `vox:refund:${createHash("sha256").update(key).digest("hex")}`;
}

async function markRealizeManualReview(context: AppContext, input: RealizeCommissionRecord, reason: string, reasonCode: string, evidenceHash?: string): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  if (["REFUNDED", "SETTLED", "EXPIRED"].includes(current.commission.state) || current.resolution_outcome === "fulfilled" || current.resolution_outcome === "refunded") return current;
  const event = resolutionEvent({commissionId: current.commission.commission_id, action: "manual_review_required", actorType: "system", actorId: "vox-api", reasonCode, ...(evidenceHash ? {evidenceHash} : {})});
  const changes = current.commission.state === "MANUAL_REVIEW" ? {} : {state: "MANUAL_REVIEW" as const};
  try {
    const updated = updatedRealizeCommission(current, changes, {
      resolution_outcome: "manual_review",
      resolution_reason: reasonCode,
      failure_reason: reason,
      resolution_events: appendResolutionEvent(current, event)
    });
    return await context.store.updateRealizeCommission(updated, current.updated_at);
  } catch {
    return await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
  }
}

type MainnetFundingAttempt = {record: RealizeCommissionRecord; status: "pending" | "captured" | "manual_review"};

/** Persist the wallet signature before consulting RPC so a lost API response can
 * be retried by the payer or recovered by the scheduled reconciler. */
async function verifyAndRecordMainnetFunding(
  context: AppContext,
  input: RealizeCommissionRecord,
  signature: string
): Promise<MainnetFundingAttempt> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  const commissionId = current.commission.commission_id;
  if (current.funding_signature) {
    if (current.funding_signature !== signature) throw new HttpError(409, "payment_replayed", "commission already has a different funding transaction");
    return {record: current, status: current.commission.state === "MANUAL_REVIEW" ? "manual_review" : "captured"};
  }
  if (!["AWAITING_PAYMENT", "EXPIRED"].includes(current.commission.state) || !current.payment_intent || !current.commission.quote_id) throw new HttpError(409, "payment_required", "commission is not awaiting its quote-bound payment");
  const quote = await context.store.getRealizeQuote(current.commission.quote_id);
  const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!quote || !configuration || !quote.usdc_mint || quote.network_id !== "solana:mainnet-beta") throw new HttpError(409, "quote_invalid", "accepted Mainnet quote settlement binding is unavailable");
  assertRealizeQuoteConfiguration(context, quote, configuration);
  const funding = current.direct_funding;
  const rail = paymentRailForNetwork(context, quote.network_id, quote.usdc_mint);
  if (!rail || !funding || funding.mode !== "direct" || funding.payer_wallet !== current.payer_wallet || funding.accepted_quote_hash !== quote.canonical_quote_hash) throw new HttpError(503, "payment_authorization_missing", "backend-authorized Mainnet funding is unavailable");
  const expectedIntentId = `vox:payment-intent:${createHash("sha256").update(`${commissionId}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
  if (quote.commission_id !== commissionId || current.commission.accepted_quote_hash !== quote.canonical_quote_hash || current.commission.payment_intent_id !== expectedIntentId || funding.commission_id !== commissionId || funding.quote_id !== quote.quote_id || funding.network_id !== quote.network_id || funding.usdc_mint !== quote.usdc_mint || funding.amount_usdc_atomic !== quote.total_amount_usdc_atomic || funding.expires_at !== quote.expires_at || current.payment_intent.payment_intent_id !== expectedIntentId || current.payment_intent.commission_id !== commissionId || current.payment_intent.quote_id !== quote.quote_id || current.payment_intent.payer_id !== current.commission.commissioner_id || current.payment_intent.amount_usdc_atomic !== quote.total_amount_usdc_atomic || current.payment_intent.network_id !== quote.network_id || current.payment_intent.accepted_quote_hash !== quote.canonical_quote_hash || current.payment_intent.expires_at !== quote.expires_at) throw new HttpError(409, "payment_intent_mismatch", "funding authorization does not match the accepted quote-bound payment intent");
  if (funding.payment_reference !== `vox:realize:payment:${current.payment_intent.payment_intent_id}:${quote.canonical_quote_hash}`) throw new HttpError(409, "payment_intent_mismatch", "Mainnet payment memo does not match the unique payment intent");
  if (funding.destination_token_account !== configuration.funding_destination_token_account || funding.network_id !== "solana:mainnet-beta") throw new HttpError(409, "treasury_configuration_mismatch", "Mainnet payment destination differs from the pinned treasury account");
  if (funding.payer_wallet !== current.payer_wallet) throw new HttpError(409, "payment_intent_mismatch", "submitted payer does not match the accepted payment intent");
  if (current.funding_submission_signature && current.funding_submission_signature !== signature) throw new HttpError(409, "payment_submission_conflict", "a different payment signature is already being reconciled for this order");

  if (!current.funding_submission_signature || current.commission.state === "EXPIRED") {
    const submitted = updatedRealizeCommission(current, current.commission.state === "EXPIRED" ? {state: "AWAITING_PAYMENT", payment_state: "pending"} : {}, {
      funding_submission_signature: signature,
      ...(current.commission.state === "EXPIRED" ? {failure_reason: "a payer submitted a Mainnet payment signature after the order expired; verifying its finalized chain time before resolution"} : {})
    });
    try { current = await context.store.updateRealizeCommission(submitted, current.updated_at); }
    catch (error) {
      const latest = await context.store.getRealizeCommission(commissionId);
      if (!latest || latest.funding_submission_signature !== signature) throw error;
      current = latest;
    }
  }

  const verification = await rail.verifyFunding(funding, signature, current.payer_wallet!);
  if (!verification.finalized) return {record: current, status: "pending"};
  if (!verification.matched) {
    // A finalized nonmatching transaction cannot have funded this quote. Release
    // the signature reservation so the customer can submit the correct payment.
    const latest = await context.store.getRealizeCommission(commissionId) ?? current;
    if (latest.funding_submission_signature === signature && !latest.funding_signature) {
      const {funding_submission_signature: _rejectedSignature, ...withoutSubmission} = latest;
      try { current = await context.store.updateRealizeCommission(updatedRealizeCommission(withoutSubmission, {}, {failure_reason: verification.reason ?? "finalized payment did not match the quote-bound Mainnet transfer"}), latest.updated_at); }
      catch { current = await context.store.getRealizeCommission(commissionId) ?? latest; }
    }
    throw new HttpError(402, "payment_unverified", verification.reason ?? "funding transaction does not match the accepted quote");
  }
  if (!await context.store.reserveRealizePaymentSignature(signature, commissionId)) {
    const latest = await context.store.getRealizeCommission(commissionId) ?? current;
    if (latest.funding_submission_signature === signature && !latest.funding_signature) {
      const {funding_submission_signature: _replayedSignature, ...withoutSubmission} = latest;
      try { await context.store.updateRealizeCommission(updatedRealizeCommission(withoutSubmission, {}, {failure_reason: "finalized payment signature is already reserved to a different Realize commission"}), latest.updated_at); }
      catch { /* A competing update retains the durable review record. */ }
    }
    throw new HttpError(409, "payment_replayed", "this finalized transaction signature has already funded another Realize commission");
  }

  const latest = await context.store.getRealizeCommission(commissionId) ?? current;
  if (latest.funding_signature) {
    if (latest.funding_signature !== signature) throw new HttpError(409, "payment_replayed", "commission already has a different funding transaction");
    return {record: latest, status: latest.commission.state === "MANUAL_REVIEW" ? "manual_review" : "captured"};
  }
  if (latest.funding_submission_signature !== signature) throw new HttpError(409, "payment_submission_conflict", "payment submission changed during verification");
  const expiresAt = Date.parse(current.payment_intent!.expires_at);
  const hasBlockTime = Number.isSafeInteger(verification.block_time) && verification.block_time! >= 0 && verification.block_time! <= Math.floor((Number.MAX_SAFE_INTEGER - 999) / 1_000);
  // RPC blockTime has one-second precision. Only accept a transfer when the
  // entire reported second is within the quote window; if it overlaps expiry,
  // hold the captured funds for human resolution.
  const blockSecondStart = hasBlockTime ? verification.block_time! * 1_000 : Number.NaN;
  const blockSecondEnd = hasBlockTime ? blockSecondStart + 999 : Number.NaN;
  const timely = hasBlockTime && blockSecondEnd <= expiresAt;
  const timingStatus: NonNullable<RealizeCommissionRecord["funding_timing_status"]> = !hasBlockTime ? "unavailable" : timely ? "within_quote_window" : blockSecondStart > expiresAt ? "after_quote_expiry" : "ambiguous_at_expiry";
  const capturedIntent = PaymentIntentV1Schema.parse({...latest.payment_intent!, status: "captured"});
  const fundedAt = new Date().toISOString();
  const reasonCode = timingStatus === "after_quote_expiry" ? "late_payment_after_quote_expiry" : timingStatus === "ambiguous_at_expiry" ? "funding_time_ambiguous_at_expiry" : timingStatus === "unavailable" ? "funding_time_unavailable" : undefined;
  const event = reasonCode ? resolutionEvent({commissionId, action: "manual_review_required", actorType: "system", actorId: "vox-api", evidenceHash: signature, reasonCode}) : undefined;
  const captured = updatedRealizeCommission(latest, timely ? {state: "FUNDED", payment_state: "captured"} : {state: "MANUAL_REVIEW", payment_state: "captured"}, {
    payment_intent: capturedIntent,
    funding_signature: signature,
    funding_network_id: quote.network_id,
    funding_verified_at: fundedAt,
    funded_at: fundedAt,
    ...(hasBlockTime ? {funding_block_time: verification.block_time} : {}),
    funding_timing_status: timingStatus,
    ...(reasonCode ? {resolution_outcome: "manual_review", resolution_reason: reasonCode, failure_reason: timingStatus === "after_quote_expiry" ? "exact finalized Mainnet funds arrived after the accepted quote expired; generation is held for operator resolution" : timingStatus === "ambiguous_at_expiry" ? "the finalized transaction block time overlaps quote expiry at RPC's one-second precision; generation is held for operator resolution" : "exact finalized Mainnet funds were received but the RPC did not provide a block time; generation is held for operator resolution", resolution_events: appendResolutionEvent(latest, event!)} : {})
  });
  try { current = await context.store.updateRealizeCommission(captured, latest.updated_at); }
  catch (error) {
    const saved = await context.store.getRealizeCommission(commissionId);
    if (saved?.funding_signature === signature) current = saved;
    else throw error;
  }
  return {record: current, status: reasonCode ? "manual_review" : "captured"};
}

function settlementResolutionIsRefundable(resolution: RealizePaymentIntentResolutionV1): boolean {
  return resolution.kind === "settlement" && resolution.state === "refundable" && resolution.settled_amount_usdc_atomic === "0" && Boolean(resolution.batch_statuses?.length) && resolution.batch_statuses!.every((status) => status === "failed");
}

async function mainnetRefundPreflight(context: AppContext, current: RealizeCommissionRecord): Promise<{quote: import("@vox/protocol").RealizeQuoteV1; resolution: RealizePaymentIntentResolutionV1}> {
  const paymentIntent = current.payment_intent;
  const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
  const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!paymentIntent || !quote || !configuration || !current.commission.accepted_quote_hash || !current.payer_wallet || !current.funding_signature || !current.direct_funding) throw new HttpError(409, "refund_binding_missing", "Mainnet refund is missing its original payment binding");
  assertRealizeQuoteConfiguration(context, quote, configuration);
  const funding = current.direct_funding;
  const exact = quote.network_id === "solana:mainnet-beta" && quote.usdc_mint === configuration.usdc_mint && current.funding_network_id === quote.network_id && funding.network_id === quote.network_id && funding.usdc_mint === quote.usdc_mint && funding.destination_token_account === configuration.funding_destination_token_account && funding.commission_id === current.commission.commission_id && funding.quote_id === quote.quote_id && funding.accepted_quote_hash === quote.canonical_quote_hash && funding.payer_wallet === current.payer_wallet && funding.amount_usdc_atomic === paymentIntent.amount_usdc_atomic && paymentIntent.payment_intent_id === current.commission.payment_intent_id && paymentIntent.commission_id === current.commission.commission_id && paymentIntent.quote_id === quote.quote_id && paymentIntent.accepted_quote_hash === quote.canonical_quote_hash && paymentIntent.network_id === quote.network_id && paymentIntent.amount_usdc_atomic === quote.total_amount_usdc_atomic && current.commission.accepted_quote_hash === quote.canonical_quote_hash;
  if (!exact) throw new HttpError(409, "refund_binding_mismatch", "Mainnet refund does not exactly match the finalized quote-bound payment");
  const rail = paymentRailForNetwork(context, quote.network_id!, quote.usdc_mint!);
  if (!rail) throw new HttpError(503, "payment_not_configured", "the original Mainnet payment verifier is unavailable");
  const fundingCheck = await rail.verifyFunding(funding, current.funding_signature, current.payer_wallet);
  if (!fundingCheck.finalized || !fundingCheck.matched) throw new HttpError(409, "funding_unverified", fundingCheck.reason ?? "original Mainnet funding is not verified as finalized and exact");
  const resolution = await context.solanaRealizeSettlementClient.getPaymentIntentResolution(paymentIntent.payment_intent_id);
  if (resolution.payment_intent_id !== paymentIntent.payment_intent_id) throw new HttpError(503, "settlement_resolution_mismatch", "settlement service returned a different payment intent");
  const expectedRefundId = expectedRealizeRefundId(current.commission.commission_id, quote.canonical_quote_hash);
  const safeNoPayout = resolution.kind === "none" || settlementResolutionIsRefundable(resolution) || resolution.kind === "refund" && resolution.record_id === expectedRefundId && ["active", "refund_failed", "refunded"].includes(resolution.state ?? "");
  if (!safeNoPayout) throw new HttpError(409, "settlement_requires_review", "settlement or refund activity is partial, active, or uncertain and requires manual review");
  return {quote, resolution};
}

async function runRealizeRefund(context: AppContext, input: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  const paymentIntent = current.payment_intent;
  if (!paymentIntent || !current.commission.accepted_quote_hash || !current.payer_wallet || !current.funding_signature) return current;
  if (current.commission.state !== "REFUND_PENDING") return current;
  const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
  if (!quote?.network_id || !quote.usdc_mint) return current;
  const mainnet = requiresExplicitMainnetRefundApproval(quote.network_id);
  if (mainnet && !current.refund_approval) return current;
  if (stagingNoRenderFailureEnabled(context) && current.no_render_failure_armed && !current.refund_approval) return current;
  try {
    let response: RealizeRefundResponseV1;
    if (context.devnetRealizeEscrowClient && current.escrow_funding) {
      if (!current.refund_response) {
        const failureHash = current.failure_evidence?.payload_hash ?? realizeCanonicalHash({commission_id: current.commission.commission_id, accepted_quote_hash: current.commission.accepted_quote_hash, reason: current.failure_reason ?? "fulfillment failed"}, "vox.realize.fulfillment-failure.v1");
        await context.devnetRealizeEscrowClient.requestRefundAttestation(current.escrow_funding, failureHash);
      }
      response = await context.devnetRealizeEscrowClient.getRefund(current.escrow_funding);
    } else {
      if (!mainnet || !context.solanaRealizeSettlementClient) return current;
      const {resolution} = await mainnetRefundPreflight(context, current);
      const refundId = expectedRealizeRefundId(current.commission.commission_id, current.commission.accepted_quote_hash);
      if (resolution.kind === "refund") {
        if (resolution.record_id !== refundId) throw new HttpError(409, "refund_reservation_conflict", "another refund reservation exists for this payment intent");
        response = await context.solanaRealizeSettlementClient.getRefund(refundId);
      } else {
        response = await context.solanaRealizeSettlementClient.requestRefund({commission_id: current.commission.commission_id, payment_intent_id: paymentIntent.payment_intent_id, accepted_quote_hash: current.commission.accepted_quote_hash, amount_usdc_atomic: paymentIntent.amount_usdc_atomic, network_id: quote.network_id, usdc_mint: quote.usdc_mint, payer_wallet: current.payer_wallet, funding_transaction_signature: current.funding_signature, payment_reference: `vox:realize:payment:${paymentIntent.payment_intent_id}:${current.commission.accepted_quote_hash}`, idempotency_key: `vox:refund:${current.commission.commission_id}:${current.commission.accepted_quote_hash}`});
      }
    }
    if (response.status === "refunded") {
      const event = resolutionEvent({commissionId: current.commission.commission_id, action: "refund_finalized", actorType: "system", actorId: "vox-api", evidenceHash: response.transaction_signature ?? response.refund_id});
      const updated = updatedRealizeCommission(current, {state: "REFUNDED", payment_state: "refunded"}, {refund_response: response, resolution_outcome: "refunded", resolution_reason: current.resolution_reason ?? "confirmed_generation_failure", resolution_events: appendResolutionEvent(current, event)});
      return await context.store.updateRealizeCommission(updated, current.updated_at);
    }
    if (response.status === "uncertain") return markRealizeManualReview(context, current, "refund transaction outcome is uncertain and requires reconciliation", "refund_transaction_uncertain", response.transaction_signature ?? response.refund_id);
    if (response.status === "failed") {
      if (response.retryable === false) return markRealizeManualReview(context, current, "refund retry limit was reached after finalized failed transactions", "refund_retry_exhausted", response.transaction_signature ?? response.refund_id);
      const event = resolutionEvent({commissionId: current.commission.commission_id, action: "refund_retried", actorType: "system", actorId: "vox-api", evidenceHash: response.transaction_signature ?? response.refund_id, reasonCode: "finalized_refund_attempt_failed"});
      const updated = updatedRealizeCommission(current, {payment_state: "refund_pending"}, {refund_response: response, failure_reason: "a finalized refund attempt failed; reconciliation will retry under the same payment-intent reservation", resolution_events: appendResolutionEvent(current, event)});
      return await context.store.updateRealizeCommission(updated, current.updated_at);
    }
    const event = response.transaction_signature ? resolutionEvent({commissionId: current.commission.commission_id, action: current.refund_response?.transaction_signature === response.transaction_signature ? "refund_retried" : "refund_submitted", actorType: "system", actorId: "vox-api", evidenceHash: response.transaction_signature}) : undefined;
    const updated = updatedRealizeCommission(current, {payment_state: "refund_pending"}, {refund_response: response, ...(event ? {resolution_events: appendResolutionEvent(current, event)} : {})});
    return await context.store.updateRealizeCommission(updated, current.updated_at);
  } catch (error) {
    // Any error on the Mainnet refund path may mean that the settlement
    // reservation or refund transaction advanced despite a lost response.
    // Stop automatic progress and require reconciliation before resuming.
    if (mainnet) return markRealizeManualReview(context, current, errorMessage(error), error instanceof HttpError ? error.code : "mainnet_refund_outcome_uncertain");
    const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
    const updated = updatedRealizeCommission(latest, {}, {failure_reason: errorMessage(error)});
    return await context.store.updateRealizeCommission(updated, latest.updated_at);
  }
}

async function confirmRealizeFulfillmentFailure(context: AppContext, record: RealizeCommissionRecord, reason: string, evidence: RealizeFailureEvidence): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(record.commission.commission_id) ?? record;
  if (["REFUND_PENDING", "REFUNDED"].includes(current.commission.state) || current.resolution_outcome === "refunded") return current;
  if (current.commission.state === "COMPLETED" || current.commission.state === "SETTLED" || current.resolution_outcome === "fulfilled") {
    const event = resolutionEvent({commissionId: current.commission.commission_id, action: "late_callback_ignored", actorType: "populi", actorId: "signed-terminal-failure", evidenceHash: evidence.payload_hash, reasonCode: "fulfillment_already_won"});
    try { return await context.store.updateRealizeCommission(updatedRealizeCommission(current, {}, {resolution_events: appendResolutionEvent(current, event)}), current.updated_at); }
    catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  }
  if (!["FUNDED", "GENERATING", "MANUAL_REVIEW"].includes(current.commission.state)) return current;
  const event = resolutionEvent({commissionId: current.commission.commission_id, action: "generation_failed", actorType: evidence.source === "staging_no_render_test" ? "operator" : "populi", actorId: evidence.source === "staging_no_render_test" ? current.no_render_failure_armed?.operator_human_id ?? "staging-test-operator" : evidence.source, evidenceHash: evidence.payload_hash, reasonCode: evidence.error_code ?? "terminal_provider_failure"});
  const updated = updatedRealizeCommission(current, {state: "REFUND_PENDING", payment_state: "refund_pending", fulfillment_state: "failed"}, {failure_reason: reason, failure_evidence: evidence, resolution_reason: "confirmed_generation_failure", resolution_events: appendResolutionEvent(current, event)});
  let saved: RealizeCommissionRecord;
  try { saved = await context.store.updateRealizeCommission(updated, current.updated_at); }
  catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  return runRealizeRefund(context, saved);
}

async function processRealizeSettlement(context: AppContext, input: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  if (current.commission.state !== "COMPLETED" || current.commission.payment_state !== "captured" || !current.payment_intent || !current.commission.quote_id || !current.funding_signature || !current.funding_verified_at || current.fulfillment_result?.status !== "completed" || !current.provenance_record_id) return current;
  const quote = await context.store.getRealizeQuote(current.commission.quote_id);
  if (!quote) throw new Error("accepted Realize quote not found during settlement");
  const configuration = quote.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!configuration) throw new Error("pinned payout configuration not found during settlement");
  assertRealizeQuoteConfiguration(context, quote, configuration);
  let instruction = current.settlement_instruction;
  if (!instruction) {
    instruction = createRealizeSettlementInstruction({quote, commissionId: current.commission.commission_id, paymentIntentId: current.payment_intent.payment_intent_id, createdAt: new Date().toISOString()});
    current = await context.store.updateRealizeCommission(updatedRealizeCommission(current, {}, {settlement_instruction: instruction, settlement_status: "pending"}), current.updated_at);
  }
  // The accepted quote pins every recipient and amount. After VOX verifies the
  // finalized customer payment and completed provider output, the configured
  // settlement service pays those recipients. Mainnet refunds remain separately
  // approval-gated.
  try {
    if (!current.settlement_response) {
      if (context.devnetRealizeEscrowClient && current.escrow_funding && current.fulfillment_result) {
        const fulfillmentHash = realizeCanonicalHash(current.fulfillment_result, "vox.realize.fulfillment-result.v1");
        await context.devnetRealizeEscrowClient.attestFulfillment(current.escrow_funding, fulfillmentHash, true);
      } else {
        const acknowledgment = await context.solanaRealizeSettlementClient.requestSettlement(instruction);
        if (!acknowledgment.accepted || acknowledgment.settlement_id !== instruction.settlement_id) throw new Error("settlement interface did not acknowledge the requested settlement");
      }
    }
    if (context.devnetRealizeEscrowClient && current.escrow_funding) await context.devnetRealizeEscrowClient.claimUnclaimedPayouts(current.escrow_funding);
    const escrowFunding = current.escrow_funding && context.devnetRealizeEscrowClient
      ? {...current.escrow_funding, payouts: current.escrow_funding.payouts.map((payout, index) => ({...payout, ...(instruction.payout_recipients[index]?.payout_id ? {payout_id: instruction.payout_recipients[index]!.payout_id} : {})}))}
      : undefined;
    const response = escrowFunding
      ? await context.devnetRealizeEscrowClient!.getSettlement(escrowFunding)
      : await context.solanaRealizeSettlementClient.getSettlement(instruction.settlement_id);
    if (response.settlement_id !== instruction.settlement_id) throw new Error("settlement adapter returned a different settlement id");
    const settledAmount = response.settled_amount_usdc_atomic === undefined ? undefined : BigInt(response.settled_amount_usdc_atomic);
    const quoteTotal = BigInt(quote.total_amount_usdc_atomic);
    const payoutIds = new Set(quote.payout_recipients.map((recipient) => recipient.payout_id));
    const failedIds = new Set(response.failed_payout_ids);
    const reportedSettledIds = response.settled_payout_ids ?? [];
    const settledPayoutIds = reportedSettledIds.length > 0
      ? reportedSettledIds
      : response.status === "settled" && settledAmount === quoteTotal && response.failed_payout_ids.length === 0
        ? quote.payout_recipients.map((recipient) => recipient.payout_id)
        : [];
    const settledIds = new Set(settledPayoutIds);
    const settledAmountFromIds = quote.payout_recipients.filter((recipient) => settledIds.has(recipient.payout_id)).reduce((total, recipient) => total + BigInt(recipient.amount_usdc_atomic), 0n);
    if (response.failed_payout_ids.some((payoutId) => !payoutIds.has(payoutId)) || settledPayoutIds.some((payoutId) => !payoutIds.has(payoutId)) || settledIds.size !== settledPayoutIds.length || [...settledIds].some((payoutId) => failedIds.has(payoutId)) || settledPayoutIds.length > 0 && settledAmount !== settledAmountFromIds || settledAmount !== undefined && settledAmount > quoteTotal || settledAmount !== undefined && settledAmount > 0n && settledPayoutIds.length === 0) throw new Error("settlement adapter response names an unknown, duplicate, conflicting, or incorrectly valued payout, or omits payout evidence for a positive settled amount");
    const normalizedResponse = {...response, settled_payout_ids: settledPayoutIds};
    if (response.status === "settled" && settledAmount === quoteTotal && response.failed_payout_ids.length === 0) {
      const updated = updatedRealizeCommission(current, {state: "SETTLED", payment_state: "settled", fulfillment_state: "completed"}, {settlement_response: normalizedResponse, settlement_status: "settled", failure_reason: ""});
      return await context.store.updateRealizeCommission(updated, current.updated_at);
    }
    if (response.status === "failed" && settledAmount === 0n) {
      const updated = updatedRealizeCommission(current, {state: "REFUND_PENDING", payment_state: "refund_pending"}, {settlement_response: normalizedResponse, settlement_status: "failed", failure_reason: "settlement failed before any recipient payout was confirmed"});
      const saved = await context.store.updateRealizeCommission(updated, current.updated_at);
      return runRealizeRefund(context, saved);
    }
    const partial = response.status === "partial" || response.status === "failed" || settledAmount !== undefined && settledAmount !== 0n;
    const mismatch = response.status === "settled" && settledAmount !== quoteTotal;
    const updated = updatedRealizeCommission(current, {payment_state: "captured"}, {settlement_response: normalizedResponse, settlement_status: partial ? "partial" : "pending", ...(mismatch ? {failure_reason: "settlement adapter reported a total different from the accepted quote"} : {})});
    return await context.store.updateRealizeCommission(updated, current.updated_at);
  } catch (error) {
    const updated = updatedRealizeCommission(current, {}, {failure_reason: errorMessage(error)});
    return await context.store.updateRealizeCommission(updated, current.updated_at);
  }
}

async function finalizeRealizeFulfillment(context: AppContext, current: RealizeCommissionRecord, result: import("@vox/protocol").FulfillmentResultV1): Promise<RealizeCommissionRecord> {
  const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
  const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!quote || !configuration || !current.payment_intent) throw new Error("pinned quote, payout configuration, or payment intent is unavailable");
  if (quote.canonical_quote_hash !== current.commission.accepted_quote_hash) throw new HttpError(409, "quote_hash_mismatch", "fulfillment result is not bound to the commission's accepted quote");
  assertRealizeQuoteConfiguration(context, quote, configuration);
  const allowedMediaTypes = new Set((quote.output_media_types ?? []).map((mediaType) => mediaType.toLowerCase()));
  for (const output of result.outputs) {
    if (allowedMediaTypes.size > 0 && !allowedMediaTypes.has(output.media_type.toLowerCase())) throw new HttpError(409, "fulfillment_mismatch", "provider output media type was not included in the accepted quote");
    await verifyRealizeOutput(configuration, output);
  }
  const provenance = await createRealizeProvenance(context, current, quote, result);
  const instruction = createRealizeSettlementInstruction({quote, commissionId: current.commission.commission_id, paymentIntentId: current.payment_intent.payment_intent_id, createdAt: new Date().toISOString()});
  const resultHash = realizeCanonicalHash(result, "vox.realize.fulfillment-result.v1");
  const event = resolutionEvent({commissionId: current.commission.commission_id, action: "generation_completed", actorType: "populi", actorId: "verified-provider-result", evidenceHash: resultHash});
  const completed = updatedRealizeCommission(current, {state: "COMPLETED", fulfillment_state: "completed"}, {
    fulfillment_result: result,
    settlement_instruction: instruction,
    settlement_status: current.settlement_status === "not_started" ? "pending" : current.settlement_status,
    failure_reason: "",
    resolution_outcome: "fulfilled",
    resolution_reason: "verified_generation_completed",
    resolution_events: appendResolutionEvent(current, event)
  });
  let saved: RealizeCommissionRecord;
  try { saved = await context.store.updateRealizeCommission(completed, current.updated_at); }
  catch {
    const latest = await context.store.getRealizeCommission(current.commission.commission_id);
    if (!latest || latest.commission.state !== "COMPLETED" || !latest.fulfillment_result || realizeCanonicalHash(latest.fulfillment_result, "vox.realize.fulfillment-result.v1") !== resultHash) return latest ?? current;
    saved = latest;
  }
  // The terminal state wins before provenance or delivery becomes visible. A
  // concurrent failure/refund transition therefore cannot be followed by a
  // late callback creating customer-facing fulfillment side effects.
  await context.store.createRealizeProvenance(provenance);
  if (!saved.provenance_record_id) {
    const withProvenance = updatedRealizeCommission(saved, {}, {provenance_record_id: provenance.provenance_record_id});
    try { saved = await context.store.updateRealizeCommission(withProvenance, saved.updated_at); }
    catch { saved = await context.store.getRealizeCommission(saved.commission.commission_id) ?? saved; }
  }
  saved = await provisionRealizeNfts(context, saved, quote, result, provenance.provenance_record_id);
  return processRealizeSettlement(context, saved);
}

async function handleRealizeFulfillmentResult(context: AppContext, record: RealizeCommissionRecord, rawResult: unknown, source: "signed_webhook" | "provider_status" | "create_response", suppliedPayloadHash?: string): Promise<RealizeCommissionRecord> {
  const result = FulfillmentResultV1Schema.parse(rawResult);
  let current = await context.store.getRealizeCommission(record.commission.commission_id) ?? record;
  if (result.commission_id !== current.commission.commission_id || result.fulfillment_request_id !== current.commission.fulfillment_request_id || result.generation_provider_id !== current.fulfillment_request?.generation_provider_id) throw new HttpError(409, "fulfillment_mismatch", "fulfillment result does not match the funded commission request");
  const payloadHash = suppliedPayloadHash ?? realizeCanonicalHash(result, "vox.realize.provider-status.v1");
  if (["REFUND_PENDING", "REFUNDED"].includes(current.commission.state) || current.resolution_outcome === "refunded") {
    const event = resolutionEvent({commissionId: current.commission.commission_id, action: "late_callback_ignored", actorType: source === "signed_webhook" ? "populi" : "system", actorId: source, evidenceHash: payloadHash, reasonCode: "refund_resolution_has_priority"});
    try { return await context.store.updateRealizeCommission(updatedRealizeCommission(current, {}, {resolution_events: appendResolutionEvent(current, event)}), current.updated_at); }
    catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  }
  if (current.failure_evidence && current.commission.state === "MANUAL_REVIEW") {
    const event = resolutionEvent({commissionId: current.commission.commission_id, action: "late_callback_ignored", actorType: source === "signed_webhook" ? "populi" : "system", actorId: source, evidenceHash: payloadHash, reasonCode: "confirmed_failure_already_frozen"});
    try { return await context.store.updateRealizeCommission(updatedRealizeCommission(current, {}, {resolution_events: appendResolutionEvent(current, event)}), current.updated_at); }
    catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  }
  if (!["GENERATING", "MANUAL_REVIEW"].includes(current.commission.state)) return current;
  if (result.status === "failed") {
    const afterDeadline = Boolean(current.fulfillment_deadline_at && Date.parse(current.fulfillment_deadline_at) <= Date.now());
    if (source === "signed_webhook" || source === "provider_status" && afterDeadline) {
      const evidence: RealizeFailureEvidence = {source: source === "signed_webhook" ? "populi_signed_webhook" : "populi_post_deadline_status", fulfillment_request_id: result.fulfillment_request_id, observed_at: new Date().toISOString(), payload_hash: payloadHash, ...(result.error_code ? {error_code: result.error_code} : {})};
      return confirmRealizeFulfillmentFailure(context, current, result.error_message ?? result.error_code ?? "Populi generation failed", evidence);
    }
    const updated = updatedRealizeCommission(current, {}, {failure_reason: "provider reported failure before the generation deadline; awaiting signed terminal confirmation", provider_poll_not_before: new Date(Date.now() + 5_000).toISOString()});
    try { return await context.store.updateRealizeCommission(updated, current.updated_at); }
    catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  }
  if (result.status !== "completed") {
    const pastDeadline = Boolean(current.fulfillment_deadline_at && Date.parse(current.fulfillment_deadline_at) <= Date.now());
    if (source === "provider_status" && pastDeadline) return markRealizeManualReview(context, current, "provider status remains nonterminal after the generation deadline", "provider_status_ambiguous_after_deadline", payloadHash);
    const updated = updatedRealizeCommission(current, {fulfillment_state: result.status === "generating" ? "generating" : "queued"}, {fulfillment_result: result, failure_reason: ""});
    try { return await context.store.updateRealizeCommission(updated, current.updated_at); }
    catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
  }
  return finalizeRealizeFulfillment(context, current, result);
}

async function startRealizeFulfillment(context: AppContext, input: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  // A concurrent retry may have already advanced this same captured payment.
  // Let reconciliation continue from the durable current state instead of
  // turning an idempotent payment retry into an HTTP failure.
  if (current.funding_signature === input.funding_signature && current.commission.state !== "FUNDED") return current;
  if (current.commission.state !== "FUNDED" || current.commission.payment_state !== "captured" || !current.funding_signature || !current.commission.quote_id || !current.payment_intent) throw new HttpError(409, "payment_unverified", "generation requires a verified finalized payment");
  if (!current.rights_reviewed_at) throw new HttpError(409, "rights_acceptance_required", "generation requires the commissioner to accept the displayed rights terms");
  const quote = await context.store.getRealizeQuote(current.commission.quote_id);
  if (!quote) throw new Error("accepted Realize quote not found before generation");
  if (Date.parse(quote.expires_at) <= Date.now() && current.funding_timing_status !== "within_quote_window") return markRealizeManualReview(context, current, "The captured payment requires review because its provider quote has expired.", "payment_verified_after_quote_expiry", current.funding_signature);
  const configuration = quote.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!configuration) throw new Error("pinned payout configuration not found before generation");
  assertRealizeQuoteConfiguration(context, quote, configuration);
  try {
    await activeRealizeRightsAgreement(context, configuration, current.commission.commissioner_id, current.commission.commission_id);
  } catch {
    return markRealizeManualReview(context, current, "rights authorization was no longer active after funding", "rights_authorization_unavailable_after_funding");
  }
  const fulfillmentRequestId = `vox:fulfillment:${createHash("sha256").update(`${current.commission.commission_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
  if (stagingNoRenderFailureEnabled(context) && current.no_render_failure_armed) {
    const evidenceHash = realizeCanonicalHash({commission_id: current.commission.commission_id, fulfillment_request_id: fulfillmentRequestId, quote_hash: quote.canonical_quote_hash, arm_payload_hash: current.no_render_failure_armed.payload_hash}, "vox.realize.staging-no-render-failure.v1");
    const evidence: RealizeFailureEvidence = {source: "staging_no_render_test", fulfillment_request_id: fulfillmentRequestId, observed_at: new Date().toISOString(), payload_hash: evidenceHash, error_code: "STAGING_NO_RENDER_FAILURE_REHEARSAL"};
    return confirmRealizeFulfillmentFailure(context, current, "staging no-render failure rehearsal was armed before funding; no Populi job was submitted", evidence);
  }
  if (!quote.provider_price_quote_id) throw new Error("accepted quote is missing its provider price quote id");
  const paymentReference = `vox:realize:payment:${current.payment_intent.payment_intent_id}:${quote.canonical_quote_hash}`;
  const fundingAuthorization = ExternalFundingAuthorizationV1Schema.parse({
    protocol_version: "realize/1",
    authorization_id: `vox:funding-authorization:${createHash("sha256").update(`${current.commission.commission_id}\u0000${quote.canonical_quote_hash}\u0000${current.funding_signature}`).digest("hex")}`,
    payment_intent_id: current.payment_intent.payment_intent_id,
    commission_id: current.commission.commission_id,
    accepted_quote_hash: quote.canonical_quote_hash,
    asset: "USDC",
    total_amount_usdc_atomic: current.payment_intent.amount_usdc_atomic,
    provider_amount_usdc_atomic: quote.provider_cost_usdc_atomic ?? quote.provider_base_price_usdc_atomic,
    network_id: quote.network_id,
    payment_reference: paymentReference,
    verified_by: context.instanceId,
    verified_at: current.funded_at ?? new Date().toISOString()
  });
  const request = ProviderFulfillmentRequestV1Schema.parse({
    protocol_version: "realize/1",
    fulfillment_request_id: fulfillmentRequestId,
    commission_id: current.commission.commission_id,
    quote_id: quote.quote_id,
    accepted_quote_hash: quote.canonical_quote_hash,
    generation_provider_id: quote.generation_provider_id,
    requested_generation_parameters: current.commission.requested_generation_parameters,
    output_media_types: quote.output_media_types ?? ["video/mp4"],
    provider_quote_id: quote.provider_price_quote_id,
    funding_authorization: fundingAuthorization,
    callback_uri: `${context.publicBaseUrl}/v1/realize/webhooks/populi`,
    idempotency_key: fulfillmentRequestId,
    created_at: new Date().toISOString()
  });
  const startedAt = new Date();
  const started = updatedRealizeCommission(current, {state: "GENERATING", fulfillment_state: "queued", fulfillment_request_id: request.fulfillment_request_id}, {fulfillment_request: request, fulfillment_deadline_at: new Date(startedAt.getTime() + envNumber("VOX_REALIZE_GENERATION_TIMEOUT_SECONDS", 1800) * 1_000).toISOString(), failure_reason: ""});
  try { current = await context.store.updateRealizeCommission(started, current.updated_at); }
  catch {
    const latest = await context.store.getRealizeCommission(current.commission.commission_id);
    if (latest?.fulfillment_request?.fulfillment_request_id === request.fulfillment_request_id) return latest;
    throw new HttpError(409, "fulfillment_start_race", "another request changed the funded commission before provider submission");
  }
  try {
    const result = await context.populiRealizeClient.requestFulfillment(configuration, request);
    return handleRealizeFulfillmentResult(context, current, result, "create_response");
  } catch (error) {
    const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
    const pending = updatedRealizeCommission(latest, {}, {failure_reason: errorMessage(error)});
    return context.store.updateRealizeCommission(pending, latest.updated_at);
  }
}

async function recoverMissingRealizeFulfillment(context: AppContext, input: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(input.commission.commission_id) ?? input;
  const eligible = (record: RealizeCommissionRecord) => record.commission.state === "GENERATING" && record.commission.payment_state === "captured" && !record.resolution_outcome && !record.failure_evidence && !record.refund_approval && !record.refund_response && !record.settlement_instruction && !record.fulfillment_completion_claimed;
  if (!eligible(current)) return current;
  // A previously observed job disappearing is an integrity problem, not
  // permission to create a fresh provider job under a missing ledger entry.
  if (current.fulfillment_result) return markRealizeManualReview(context, current, "provider no longer reports a previously acknowledged job", "provider_record_missing_after_acceptance");
  const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
  const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
  if (!quote || !configuration) return markRealizeManualReview(context, current, "pinned submission configuration is unavailable", "provider_submission_binding_unavailable");
  if (Date.parse(quote.expires_at) <= Date.now() || !current.fulfillment_deadline_at || Date.parse(current.fulfillment_deadline_at) <= Date.now()) return markRealizeManualReview(context, current, "provider job is missing after its authorized submission window", "provider_submission_window_expired");
  const attempts = current.fulfillment_submission_recovery_attempts ?? 0;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts >= 3) return markRealizeManualReview(context, current, "provider submission recovery limit reached; no new job or refund was authorized", "provider_submission_recovery_exhausted");
  try {
    assertRealizeQuoteConfiguration(context, quote, configuration);
    const request = ProviderFulfillmentRequestV1Schema.parse(current.fulfillment_request);
    const intent = current.payment_intent;
    const funding = current.escrow_funding ?? current.direct_funding;
    const authorization = request.funding_authorization;
    const expectedId = `vox:fulfillment:${createHash("sha256").update(`${current.commission.commission_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
    const expectedIntentId = `vox:payment-intent:${createHash("sha256").update(`${current.commission.commission_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
    const expectedAuthorizationId = `vox:funding-authorization:${createHash("sha256").update(`${current.commission.commission_id}\u0000${quote.canonical_quote_hash}\u0000${current.funding_signature}`).digest("hex")}`;
    const parametersMatch = generationParametersHash(request.requested_generation_parameters) === generationParametersHash(quote.requested_generation_parameters) && generationParametersHash(request.requested_generation_parameters) === generationParametersHash(current.commission.requested_generation_parameters);
    const paymentMatches = intent && current.funding_signature && current.funding_verified_at && current.funded_at && current.rights_reviewed_at && current.payer_wallet &&
      current.funding_network_id === quote.network_id && intent.status === "captured" && intent.payment_intent_id === expectedIntentId && current.commission.payment_intent_id === expectedIntentId &&
      intent.commission_id === current.commission.commission_id && intent.quote_id === quote.quote_id && intent.accepted_quote_hash === quote.canonical_quote_hash &&
      intent.amount_usdc_atomic === quote.total_amount_usdc_atomic && intent.network_id === quote.network_id && current.commission.accepted_quote_hash === quote.canonical_quote_hash;
    const fundingMatches = funding && intent && funding.commission_id === current.commission.commission_id && funding.quote_id === quote.quote_id &&
      funding.accepted_quote_hash === quote.canonical_quote_hash && funding.amount_usdc_atomic === intent.amount_usdc_atomic && funding.network_id === quote.network_id && funding.usdc_mint === quote.usdc_mint &&
      funding.payer_wallet === current.payer_wallet && (funding.mode !== "direct" || funding.destination_token_account === configuration.funding_destination_token_account);
    const requestMatches = request.fulfillment_request_id === expectedId && current.commission.fulfillment_request_id === expectedId && request.idempotency_key === expectedId &&
      request.commission_id === current.commission.commission_id && request.quote_id === quote.quote_id && request.accepted_quote_hash === quote.canonical_quote_hash &&
      request.generation_provider_id === quote.generation_provider_id && request.provider_quote_id === quote.provider_price_quote_id && parametersMatch &&
      canonicalize(request.output_media_types) === canonicalize(quote.output_media_types ?? ["video/mp4"]) && Date.parse(request.created_at) >= Date.parse(quote.issued_at) && Date.parse(request.created_at) <= Date.parse(quote.expires_at);
    const authorizationMatches = intent && authorization.authorization_id === expectedAuthorizationId && authorization.commission_id === current.commission.commission_id &&
      authorization.payment_intent_id === expectedIntentId && authorization.accepted_quote_hash === quote.canonical_quote_hash && authorization.total_amount_usdc_atomic === intent.amount_usdc_atomic &&
      authorization.provider_amount_usdc_atomic === (quote.provider_cost_usdc_atomic ?? quote.provider_base_price_usdc_atomic) && authorization.network_id === quote.network_id &&
      authorization.payment_reference === `vox:realize:payment:${expectedIntentId}:${quote.canonical_quote_hash}` && authorization.verified_by === context.instanceId && authorization.verified_at === current.funded_at;
    if (!paymentMatches || !fundingMatches || !requestMatches || !authorizationMatches) throw new Error("persisted provider submission does not match the verified accepted payment");
    await activeRealizeRightsAgreement(context, configuration, current.commission.commissioner_id, current.commission.commission_id);
    const latest = await context.store.getRealizeCommission(current.commission.commission_id);
    if (!latest || latest.updated_at !== current.updated_at || !eligible(latest)) return latest ?? current;
    if (Date.parse(quote.expires_at) <= Date.now()) return markRealizeManualReview(context, latest, "provider quote expired before recovery could submit", "provider_submission_window_expired");
    current = await context.store.updateRealizeCommission(updatedRealizeCommission(latest, {}, {fulfillment_submission_recovery_attempts: attempts + 1, provider_poll_not_before: new Date(Date.now() + 30_000).toISOString()}), latest.updated_at);
    // Populi durably binds this exact canonical body/idempotency key, provider
    // quote and funding authorization to one job. Never rebuild its timestamps.
    if (Date.parse(quote.expires_at) <= Date.now() || current.fulfillment_deadline_at && Date.parse(current.fulfillment_deadline_at) <= Date.now()) return markRealizeManualReview(context, current, "provider submission window expired while recovery was being recorded", "provider_submission_window_expired");
    const result = await context.populiRealizeClient.requestFulfillment(configuration, request);
    return handleRealizeFulfillmentResult(context, current, result, "create_response");
  } catch (error) {
    const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
    if (!eligible(latest) || latest.updated_at !== current.updated_at) return latest;
    if (error instanceof RealizeProviderHttpError && [409, 410].includes(error.status)) return markRealizeManualReview(context, latest, "provider submission could not be recovered under its original authorization", "provider_submission_rejected");
    if ((latest.fulfillment_submission_recovery_attempts ?? 0) === attempts) return markRealizeManualReview(context, latest, "persisted provider submission cannot be safely retried", "provider_submission_binding_invalid");
    // A lost response is ambiguous. Keep the captured payment and original
    // request for another GET lookup; never fabricate terminal failure evidence.
    const delay = error instanceof RealizeProviderHttpError && [429, 503].includes(error.status) ? error.retryAfterMs : 5_000;
    return context.store.updateRealizeCommission(updatedRealizeCommission(latest, {}, {failure_reason: errorMessage(error), provider_poll_not_before: new Date(Date.now() + delay).toISOString()}), latest.updated_at);
  }
}

async function reconcileRealizeCommission(context: AppContext, record: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
  let current = await context.store.getRealizeCommission(record.commission.commission_id) ?? record;
  if (["QUOTED", "AWAITING_PAYMENT"].includes(current.commission.state) && current.commission.quote_id) {
    const quote = await context.store.getRealizeQuote(current.commission.quote_id);
    if (quote && Date.parse(quote.expires_at) <= Date.now() && !current.funding_submission_signature) {
      const updated = updatedRealizeCommission(current, {state: "EXPIRED", ...(current.commission.state === "AWAITING_PAYMENT" ? {payment_state: "failed" as const} : {})});
      return context.store.updateRealizeCommission(updated, current.updated_at);
    }
  }
  if (current.commission.state === "AWAITING_PAYMENT" && current.direct_funding && current.funding_submission_signature && !current.funding_signature) {
    try {
      const attempt = await verifyAndRecordMainnetFunding(context, current, current.funding_submission_signature);
      current = attempt.record;
      if (current.commission.state === "FUNDED") return startRealizeFulfillment(context, current);
      return current;
    } catch (error) {
      // Keep the original signature durable across temporary RPC or storage
      // failures. The next scheduled pass retries this same transfer.
      const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
      if (latest.funding_submission_signature !== current.funding_submission_signature || latest.funding_signature) return latest;
      try { return await context.store.updateRealizeCommission(updatedRealizeCommission(latest, {}, {failure_reason: `Mainnet funding reconciliation will retry: ${errorMessage(error)}`}), latest.updated_at); }
      catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? latest; }
    }
  }
  if (current.commission.state === "FUNDED") return startRealizeFulfillment(context, current);
  if (["GENERATING", "MANUAL_REVIEW"].includes(current.commission.state) && current.fulfillment_request && current.commission.fulfillment_request_id && !current.failure_evidence) {
    const fulfillmentRequestId = current.commission.fulfillment_request_id;
    if (current.provider_poll_not_before && Date.parse(current.provider_poll_not_before) > Date.now()) return current;
    // Persist a five-second lease so browser refreshes and multiple API instances
    // do not multiply provider polls. Callbacks can still advance the commission.
    try {
      current = await context.store.updateRealizeCommission(updatedRealizeCommission(current, {}, {provider_poll_not_before: new Date(Date.now() + 5_000).toISOString()}), current.updated_at);
    } catch {
      return await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
    }
    const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
    const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
    if (!configuration) return markRealizeManualReview(context, current, "pinned provider configuration is unavailable", "pinned_provider_configuration_unavailable");
    try {
      const result = await context.populiRealizeClient.getFulfillment(configuration, fulfillmentRequestId);
      return handleRealizeFulfillmentResult(context, current, result, "provider_status");
    } catch (error) {
      if (error instanceof RealizeProviderHttpError && error.status === 404 && error.code === "COMMISSION_NOT_FOUND") return recoverMissingRealizeFulfillment(context, current);
      if (error instanceof RealizeProviderHttpError && [429, 503].includes(error.status)) {
        const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
        if (latest.fulfillment_deadline_at && Date.parse(latest.fulfillment_deadline_at) <= Date.now()) return markRealizeManualReview(context, latest, "provider status could not be reconciled after the generation deadline", "provider_status_ambiguous_after_deadline");
        return context.store.updateRealizeCommission(updatedRealizeCommission(latest, {}, {provider_poll_not_before: new Date(Date.now() + error.retryAfterMs).toISOString()}), latest.updated_at);
      }
      const latest = await context.store.getRealizeCommission(current.commission.commission_id) ?? current;
      if (latest.fulfillment_deadline_at && Date.parse(latest.fulfillment_deadline_at) <= Date.now()) return markRealizeManualReview(context, latest, `provider status could not be reconciled after the generation deadline: ${errorMessage(error)}`, "provider_status_ambiguous_after_deadline");
      return context.store.updateRealizeCommission(updatedRealizeCommission(latest, {}, {failure_reason: errorMessage(error), provider_poll_not_before: new Date(Date.now() + 5_000).toISOString()}), latest.updated_at);
    }
  }
  if (current.commission.state === "COMPLETED") {
    if (current.fulfillment_result && !current.provenance_record_id) return finalizeRealizeFulfillment(context, current, current.fulfillment_result);
    if (current.fulfillment_result && current.provenance_record_id && context.nftService && (!current.nft_media_ids || current.nft_media_ids.length !== current.fulfillment_result.outputs.length)) {
      const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
      if (quote) current = await provisionRealizeNfts(context, current, quote, current.fulfillment_result, current.provenance_record_id);
    }
    if (current.settlement_status !== "settled") return processRealizeSettlement(context, current);
  }
  if (current.commission.state === "REFUND_PENDING") return runRealizeRefund(context, current);
  return current;
}

function paymentIdFromReference(paymentReference: string): string {
  return `vox:payment:${bytesToHex(domainHash("vox.payment.v1", utf8(paymentReference))).slice(0, 48)}`;
}

async function provisionRealizeNfts(context: AppContext, current: RealizeCommissionRecord, quote: import("@vox/protocol").RealizeQuoteV1, result: import("@vox/protocol").FulfillmentResultV1, provenanceRecordId?: string): Promise<RealizeCommissionRecord> {
  if (!context.nftService || result.status !== "completed" || current.nft_publication_consent !== true) return current;
  const sourcePost = current.source_post_id ? await context.store.getPost(current.source_post_id) : undefined;
  const mediaIds: string[] = [];
  for (let outputIndex = 0; outputIndex < result.outputs.length; outputIndex += 1) {
    const input = fulfillmentOutputToNftInput({
      commissionId: current.commission.commission_id,
      ownerId: current.commission.commissioner_id,
      ...(current.payer_wallet ? {ownerWallet: current.payer_wallet} : {}),
      creatorId: current.commission.creator_id,
      providerId: quote.generation_provider_id,
      ...(current.source_post_id ? {sourcePostId: current.source_post_id} : {}),
      ...(sourcePost ? {sourceContent: sourcePost.intent.content.text} : {}),
      requestParameters: current.commission.requested_generation_parameters,
      publicationConsent: true,
      ...(provenanceRecordId ? {provenanceRecordId} : {}),
      result,
      outputIndex,
      publicBaseUrl: context.publicBaseUrl
    });
    const media = await context.nftService.ensureMedia(context.store, input);
    mediaIds.push(media.media_id);
  }
  if (mediaIds.length === 0 || mediaIds.every((mediaId, index) => current.nft_media_ids?.[index] === mediaId)) return current;
  const updated = updatedRealizeCommission(current, {}, {nft_media_ids: mediaIds});
  try { return await context.store.updateRealizeCommission(updated, current.updated_at); }
  catch { return await context.store.getRealizeCommission(current.commission.commission_id) ?? current; }
}

async function provisionLegacyNft(context: AppContext, record: RealizationRecord): Promise<RealizationRecord> {
  if (!context.nftService || record.status !== "delivered" || record.nft_media_ids?.length || !record.media_url || !record.media_hash) return record;
  if (context.nftService.adapters.every((adapter) => isMainnetNftChain(adapter.chain))) return record;
  try {
    const quote = record.quote_id ? await context.store.getQuote(record.quote_id) : undefined;
    const sourcePost = await context.store.getPost(record.post_id);
    const media = await context.nftService.ensureMedia(context.store, legacyRealizationToNftInput({
      realizationId: record.realization_id,
      ownerId: record.requester_id,
      ...(isValidSolanaAddress(record.requester_id) ? {ownerWallet: record.requester_id} : {}),
      providerId: record.provider_id,
      postId: record.post_id,
      ...(sourcePost ? {sourceContent: sourcePost.intent.content.text} : {}),
      requestParameters: {generation_description: quote?.generation_description ?? "", ...(quote ? {style: quote.style, duration_seconds: quote.duration_seconds} : {})},
      mediaUri: record.media_url,
      mediaHash: record.media_hash,
      publicBaseUrl: context.publicBaseUrl
    }));
    return await context.store.updateRealizationNftMediaIds(record.realization_id, [media.media_id]);
  } catch {
    return record;
  }
}

function publicNftMedia(media: import("./types.js").NftMediaRecord, mints: import("./types.js").NftMintRecord[]) {
  return {
    media_id: media.media_id,
    source_kind: media.source_kind,
    ...(media.source_kind === "realize_commission" ? {} : {source_id: media.source_id}),
    output_index: media.output_index,
    ...(media.source_post_id ? {source_post_id: media.source_post_id} : {}),
    ...(media.creator_id ? {creator_id: media.creator_id} : {}),
    provider_id: media.provider_id,
    media_uri: media.media_uri,
    ...(media.media_page_url ? {media_page_url: media.media_page_url} : {}),
    media_type: media.media_type,
    media_sha256: media.media_sha256,
    ...(media.byte_length === undefined ? {} : {byte_length: media.byte_length}),
    provenance_record_id: media.provenance_record_id,
    metadata_uri: media.metadata_uri,
    metadata_hash: media.metadata_hash,
    created_at: media.created_at,
    mints: mints.map((mint) => ({
      mint_id: mint.mint_id,
      chain: mint.chain,
      state: mint.state,
      created_at: mint.created_at,
      ...(mint.owner_wallet ? {owner_wallet: mint.owner_wallet} : {}),
      ...(mint.transaction_id ? {transaction_id: mint.transaction_id} : {}),
      ...(mint.token_id ? {token_id: mint.token_id} : {}),
      ...(mint.asset_address ? {asset_address: mint.asset_address} : {}),
      ...(mint.explorer_url ? {explorer_url: mint.explorer_url} : {}),
      ...(mint.state === "claimable" ? {claimable: true} : {})
    }))
  };
}

function publicRealization(record: RealizationRecord) {
  return {
    realization_id: record.realization_id,
    post_id: record.post_id,
    ...(record.quote_id ? {quote_id: record.quote_id} : {}),
    ...(record.public_attribution ? {public_attribution: record.public_attribution} : {}),
    provider_id: record.provider_id,
    status: record.status,
    ...(record.payment_status ? {payment_status: record.payment_status} : {}),
    ...(record.payment_mode ? {payment_mode: record.payment_mode} : {}),
    ...(record.economic_purpose ? {economic_purpose: record.economic_purpose} : {}),
    mock: record.mock,
    ...(record.media_url ? {media_url: record.media_url} : {}),
    ...(record.media_hash ? {media_hash: record.media_hash} : {}),
    ...(record.nft_media_ids ? {nft_media_ids: record.nft_media_ids} : {}),
    created_at: record.created_at
  };
}

async function checkAgentRateLimit(context: AppContext, agentId: string): Promise<void> {
  const now = Date.now();
  await context.rateMutex.runExclusive(async () => {
    const current = (context.publishTimes.get(agentId) ?? []).filter((time) => now - time < 60 * 60_000);
    if (current.length >= context.maxPostsPerHour) throw new HttpError(429, "publish_rate_limited", "agent publishing rate limit exceeded");
    current.push(now);
    context.publishTimes.set(agentId, current);
  });
}

async function checkAvatarUploadRateLimit(context: AppContext, agentId: string): Promise<void> {
  const now = Date.now();
  await context.rateMutex.runExclusive(async () => {
    const current = (context.avatarUploadTimes.get(agentId) ?? []).filter((time) => now - time < 60 * 60_000);
    if (current.length >= 12) throw new HttpError(429, "avatar_rate_limited", "avatar upload rate limit exceeded");
    current.push(now);
    context.avatarUploadTimes.set(agentId, current);
  });
}

async function checkDirectMessageMediaUploadRateLimit(context: AppContext, principalId: string): Promise<void> {
  const now = Date.now();
  await context.rateMutex.runExclusive(async () => {
    const current = (context.directMessageMediaUploadTimes.get(principalId) ?? []).filter((time) => now - time < 60 * 60_000);
    if (current.length >= 60) throw new HttpError(429, "dm_media_rate_limited", "direct message media upload rate limit exceeded");
    current.push(now);
    context.directMessageMediaUploadTimes.set(principalId, current);
  });
}

async function checkDirectMessageSendRateLimit(context: AppContext, principalId: string): Promise<void> {
  const now = Date.now();
  await context.rateMutex.runExclusive(async () => {
    const current = (context.directMessageSendTimes.get(principalId) ?? []).filter((time) => now - time < 60 * 60_000);
    if (current.length >= 300) throw new HttpError(429, "dm_send_rate_limited", "direct message send rate limit exceeded");
    current.push(now);
    context.directMessageSendTimes.set(principalId, current);
  });
}

function directMessageConversationId(firstHumanId: string, secondHumanId: string): string {
  const participants = [firstHumanId, secondHumanId].sort();
  return `vox:dm:${createHash("sha256").update(participants.join("\0")).digest("hex")}`;
}

function directMessageId(humanId: string, clientMessageId: string): string {
  return `vox:dm:message:${createHash("sha256").update(`${humanId}\0${clientMessageId}`).digest("hex")}`;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const keys = createInstanceKeys(options);
  const publicBaseUrl = (options.publicBaseUrl ?? process.env.VOX_PUBLIC_BASE_URL ?? "http://localhost:8787").replace(/\/+$/, "");
  const devnetRealizeEscrowClient = options.devnetRealizeEscrowClient ?? configuredDevnetRealizeEscrow();
  const mainnetRealizePaymentRail = options.mainnetRealizePaymentRail ?? configuredMainnetRealizePaymentRail();
  const nftService = options.nftService ?? configuredNftService(publicBaseUrl);
  const context: AppContext = {
    store: options.store ?? await createDefaultStore(),
    avatarStore: options.avatarStore ?? createDefaultAvatarAssetStore(),
    directMessageMediaStore: options.directMessageMediaStore ?? createDefaultDirectMessageMediaStore(undefined, keys.secretKey),
    publicBaseUrl,
    instanceId: options.instanceId ?? process.env.VOX_INSTANCE_ID ?? "vox.blog.local",
    instanceSecretKey: keys.secretKey,
    instancePublicKey: options.instancePublicKey ?? keys.publicKey,
    maxPostsPerHour: options.maxPostsPerHour ?? envNumber("VOX_PER_AGENT_PER_HOUR", 120),
    internalToken: options.internalToken ?? process.env.VOX_INTERNAL_TOKEN,
    publishTimes: new Map(),
    avatarUploadTimes: new Map(),
    directMessageSendTimes: new Map(),
    directMessageMediaUploadTimes: new Map(),
    media: new MockMediaProvider(),
    populiRealizeClient: options.populiRealizeClient ?? new HttpPopuliRealizeClient(),
    solanaRealizeSettlementClient: options.solanaRealizeSettlementClient ?? new HttpSolanaRealizeSettlementClient(),
    ...(devnetRealizeEscrowClient ? {devnetRealizeEscrowClient} : {}),
    ...(mainnetRealizePaymentRail ? {mainnetRealizePaymentRail} : {}),
    ...(nftService ? {nftService} : {}),
    dispatcher: createAnchorTaskDispatcherFromEnv(),
    rateMutex: new AsyncMutex()
  };

  const app = Fastify({logger: process.env.NODE_ENV === "production" ? {level: process.env.LOG_LEVEL ?? "info"} : false, bodyLimit: 256 * 1024});
  for (const contentType of ["application/octet-stream", "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "video/mp4", "video/webm", "video/quicktime"]) {
    app.addContentTypeParser(contentType, {parseAs: "buffer"}, (_request, body, done) => done(null, body));
  }
  await app.register(cors, {origin: corsOrigins(options.corsOrigin ?? process.env.VOX_CORS_ORIGIN)});

  const requestCounts = new Map<string, {started: number; count: number}>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const now = Date.now();
    const current = requestCounts.get(request.ip);
    if (!current || now - current.started >= 60_000) requestCounts.set(request.ip, {started: now, count: 1});
    else {
      current.count += 1;
      if (current.count > 600) throw new HttpError(429, "request_rate_limited", "request rate limit exceeded");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({error: error.message, code: error.code});
    if ((error as {validation?: unknown}).validation) return reply.code(400).send({error: errorMessage(error), code: "invalid_request"});
    const dependency = dependencyHttpError(error);
    if (dependency) {
      request.log.error({err: error, provider_code: (error as {code?: unknown}).code}, "dependency request failed");
      return reply.code(dependency.statusCode).send({error: dependency.message, code: dependency.code});
    }
    request.log.error({err: error}, "unhandled request error");
    return reply.code(500).send({error: "internal server error", code: "internal_error"});
  });

  app.get("/v1/health", async () => ({status: "ok", protocol: "vox/1", instance_id: context.instanceId, instance_public_key: context.instancePublicKey, storage: process.env.VOX_STORAGE ?? "memory"}));

  app.post("/v1/rights/agreements", async (request, reply) => {
    const agreement = parseBody(RevenueRightsAgreementV1Schema, request.body);
    if (agreement.version !== 1 || agreement.acceptances.length !== 0) throw new HttpError(400, "invalid_agreement_proposal", "a new agreement must start at version 1 with no acceptances");
    if (Math.abs(Date.now() - Date.parse(agreement.created_at)) > 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "agreement created_at must be within five minutes of server time");
    await validateRightsAgreementProvenance(context, agreement);
    const termsHash = computeRevenueRightsAgreementHash(agreement);
    const now = new Date().toISOString();
    const audit = rightsAuditEvent({agreement_id: agreement.agreement_id, version: agreement.version, kind: "proposed", actor_id: "vox:system:rights-registry", record_hash: termsHash, occurred_at: now});
    const record: RightsAgreementRecord = {agreement, terms_hash: termsHash, status: "proposed", audit_history: [audit], created_at: now, updated_at: now};
    try {
      const stored = await context.store.createRightsAgreement(record);
      return reply.code(201).send(stored);
    } catch (error) {
      throw new HttpError(409, "rights_agreement_conflict", errorMessage(error));
    }
  });

  app.post("/v1/rights/agreements/:id/versions", async (request, reply) => {
    const agreementId = (request.params as {id: string}).id;
    const agreement = parseBody(RevenueRightsAgreementV1Schema, request.body);
    if (agreement.agreement_id !== agreementId || agreement.acceptances.length !== 0) throw new HttpError(400, "invalid_agreement_version", "versioned agreement ID must match the route and start without acceptances");
    const previous = await context.store.getRightsAgreement(agreementId);
    if (!previous || previous.status !== "active") throw new HttpError(409, "rights_agreement_not_active", "only the active agreement version may be modified");
    if (agreement.version !== previous.agreement.version + 1) throw new HttpError(409, "rights_version_conflict", "agreement version must increase by exactly one");
    if (Math.abs(Date.now() - Date.parse(agreement.created_at)) > 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "agreement created_at must be within five minutes of server time");
    await validateRightsAgreementProvenance(context, agreement);
    const requiredPriorAcceptors = previous.agreement.modification_policy.required_acceptance_party_ids;
    if (requiredPriorAcceptors.some((partyId) => !agreement.required_acceptance_party_ids.includes(partyId))) throw new HttpError(400, "invalid_modification_policy", "every prior required acceptor must accept modified terms");
    const now = new Date().toISOString();
    const termsHash = computeRevenueRightsAgreementHash(agreement);
    const audit = rightsAuditEvent({agreement_id: agreementId, version: agreement.version, kind: "proposed", actor_id: "vox:system:rights-registry", record_hash: termsHash, occurred_at: now, evidence_reference: `prior-version:${previous.agreement.version}`});
    const record: RightsAgreementRecord = {agreement, terms_hash: termsHash, status: "proposed", audit_history: [audit], created_at: now, updated_at: now};
    try {
      return reply.code(201).send(await context.store.createRightsAgreement(record));
    } catch (error) {
      throw new HttpError(409, "rights_agreement_conflict", errorMessage(error));
    }
  });

  app.post("/v1/rights/agreements/:id/versions/:version/acceptances", async (request, reply) => {
    const {id: agreementId, version: rawVersion} = request.params as {id: string; version: string};
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version < 1 || String(version) !== rawVersion) throw new HttpError(400, "invalid_version", "agreement version must be a positive integer");
    const acceptance = parseBody(RightsAgreementAcceptanceV1Schema, request.body);
    const record = await context.store.getRightsAgreement(agreementId, version);
    if (!record) throw new HttpError(404, "rights_agreement_not_found", "rights agreement version not found");
    if (record.status !== "proposed") throw new HttpError(409, "rights_agreement_closed", "agreement version is no longer open for acceptance");
    if (!record.agreement.required_acceptance_party_ids.includes(acceptance.party_id)) throw new HttpError(403, "rights_acceptance_not_required", "this party is not a required acceptor for this agreement version");
    if (acceptance.terms_hash !== record.terms_hash) throw new HttpError(409, "rights_terms_hash_mismatch", "acceptance does not bind to this agreement version");
    const acceptedAt = Date.parse(acceptance.accepted_at);
    if (!Number.isFinite(acceptedAt) || acceptedAt > Date.now() + 5 * 60_000 || acceptedAt < Date.parse(record.agreement.created_at)) throw new HttpError(400, "invalid_timestamp", "acceptance timestamp is outside the permitted window");
    if (!await authorizedRightsSigner(context, acceptance.party_id, acceptance.key_id, acceptance.public_key, acceptance.accepted_at) || !verifyRightsAgreementAcceptance(agreementId, version, acceptance)) throw new HttpError(401, "invalid_rights_acceptance", "acceptance signature or signer authorization is invalid");
    const existing = record.agreement.acceptances.find((item) => item.party_id === acceptance.party_id);
    if (existing) {
      if (canonicalBytes(existing).toString() === canonicalBytes(acceptance).toString()) return reply.send(record);
      throw new HttpError(409, "rights_acceptance_conflict", "party already accepted different evidence for this version");
    }
    if (version > 1 && record.agreement.acceptances.length === 0) {
      const prior = await context.store.getRightsAgreement(agreementId, version - 1);
      if (!prior || !prior.agreement.modification_policy.proposer_party_ids.includes(acceptance.party_id)) throw new HttpError(403, "rights_modification_not_authorized", "the first acceptance of a modified version must come from an authorized proposer");
    }
    const acceptances = [...record.agreement.acceptances, acceptance];
    const acceptedPartyIds = new Set(acceptances.map((item) => item.party_id));
    const complete = record.agreement.required_acceptance_party_ids.every((partyId) => acceptedPartyIds.has(partyId));
    const now = new Date().toISOString();
    const updated: RightsAgreementRecord = {...record, agreement: {...record.agreement, acceptances}, status: complete ? "active" : "proposed", updated_at: now};
    const audit = rightsAuditEvent({agreement_id: agreementId, version, kind: "accepted", actor_id: acceptance.party_id, record_hash: record.terms_hash, occurred_at: now, evidence_reference: `acceptance:${acceptance.signature.slice(0, 24)}`});
    try {
      return reply.send(await context.store.acceptRightsAgreement(agreementId, version, updated, audit));
    } catch (error) {
      const message = errorMessage(error);
      throw new HttpError(409, message.includes("conflicts") ? "conflicting_rights_agreement" : "rights_acceptance_conflict", message);
    }
  });

  app.post("/v1/rights/agreements/:id/versions/:version/termination", async (request, reply) => {
    const {id: agreementId, version: rawVersion} = request.params as {id: string; version: string};
    const version = Number.parseInt(rawVersion, 10);
    if (!Number.isInteger(version) || version < 1 || String(version) !== rawVersion) throw new HttpError(400, "invalid_version", "agreement version must be a positive integer");
    const termination = parseBody(RightsAgreementTerminationV1Schema, request.body);
    const record = await context.store.getRightsAgreement(agreementId, version);
    if (!record) throw new HttpError(404, "rights_agreement_not_found", "rights agreement version not found");
    if (record.status !== "active" || termination.agreement_id !== agreementId || termination.version !== version) throw new HttpError(409, "rights_agreement_not_active", "only the active version can be terminated");
    if (!record.agreement.termination_conditions.includes(termination.condition) || termination.terms_hash !== record.terms_hash) throw new HttpError(400, "invalid_termination", "termination condition or agreement hash is not authorized by the accepted terms");
    const proposedAt = Date.parse(termination.proposed_at);
    if (!Number.isFinite(proposedAt) || Math.abs(Date.now() - proposedAt) > 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "termination proposal timestamp is outside the permitted window");
    const required = record.agreement.termination_policy.required_acceptance_party_ids;
    const acceptanceIds = new Set(termination.acceptances.map((item) => item.party_id));
    if (required.some((partyId) => !acceptanceIds.has(partyId)) || [...acceptanceIds].some((partyId) => !required.includes(partyId)) || !termination.acceptances.some((item) => record.agreement.termination_policy.authorized_party_ids.includes(item.party_id))) throw new HttpError(403, "termination_not_authorized", "termination needs the specified authorized proposer and every required termination acceptance");
    for (const acceptance of termination.acceptances) {
      const acceptedAt = Date.parse(acceptance.accepted_at);
      if (!Number.isFinite(acceptedAt) || acceptedAt < proposedAt || acceptedAt > Date.now() + 5 * 60_000 || !await authorizedRightsSigner(context, acceptance.party_id, acceptance.key_id, acceptance.public_key, acceptance.accepted_at) || !verifyRightsTerminationAcceptance(termination, acceptance)) throw new HttpError(401, "invalid_termination_acceptance", "termination signature, time, or signer authorization is invalid");
    }
    const terminatedAt = termination.acceptances.map((item) => item.accepted_at).sort().at(-1)!;
    const actor = [...termination.acceptances].sort((left, right) => left.accepted_at.localeCompare(right.accepted_at)).at(-1)!.party_id;
    const now = new Date().toISOString();
    const updated: RightsAgreementRecord = {...record, status: "terminated", terminated_at: terminatedAt, termination, updated_at: now};
    const audit = rightsAuditEvent({agreement_id: agreementId, version, kind: "terminated", actor_id: actor, record_hash: record.terms_hash, occurred_at: now, evidence_reference: `termination:${termination.proposed_at}`});
    try {
      return reply.send(await context.store.terminateRightsAgreement(agreementId, version, updated, audit));
    } catch (error) {
      throw new HttpError(409, "rights_termination_conflict", errorMessage(error));
    }
  });

  app.post("/v1/rights/referrals", async (request, reply) => {
    const attribution = parseBody(ReferralAttributionV1Schema, request.body);
    const acceptedAt = Date.parse(attribution.accepted_at);
    const attributedAt = Date.parse(attribution.attributed_at);
    const referrerAcceptedAt = Date.parse(attribution.referrer_accepted_at);
    if (!Number.isFinite(acceptedAt) || Math.abs(Date.now() - acceptedAt) > 5 * 60_000 || !Number.isFinite(referrerAcceptedAt) || Math.abs(Date.now() - referrerAcceptedAt) > 5 * 60_000 || !Number.isFinite(attributedAt) || attributedAt > acceptedAt || attributedAt > referrerAcceptedAt || acceptedAt - attributedAt > 5 * 60_000 || referrerAcceptedAt - attributedAt > 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "referral attribution and both acceptances must be recent");
    const referredSignerValid = await authorizedRightsSigner(context, attribution.referred_party_id, attribution.accepted_by_key_id, attribution.accepted_by_public_key, attribution.accepted_at);
    const referrerSignerValid = await authorizedRightsSigner(context, attribution.referrer_id, attribution.referrer_key_id, attribution.referrer_public_key, attribution.referrer_accepted_at);
    if (!referredSignerValid || !referrerSignerValid || !verifyReferralAttribution(attribution)) throw new HttpError(401, "invalid_referral_acceptance", "both referral parties must sign and authorize the same attribution terms");
    if (attribution.referrer_id === attribution.referred_party_id) throw new HttpError(400, "self_referral", "self-referral is not allowed");
    const now = Date.now();
    if (Date.parse(attribution.expires_at) <= now || Date.parse(attribution.expires_at) - Date.parse(attribution.attributed_at) > 90 * 24 * 60 * 60_000) throw new HttpError(400, "invalid_referral_duration", "referral attribution must be current and last no longer than 90 days");
    const audit = rightsAuditEvent({agreement_id: attribution.attribution_id, version: 1, kind: "referral_attributed", actor_id: attribution.referred_party_id, record_hash: bytesToHex(domainHash("vox.realize.referral.record.v1", canonicalBytes(attribution))), occurred_at: new Date().toISOString(), evidence_reference: `acceptance:${attribution.signature.slice(0, 24)}`});
    try {
      return reply.code(201).send(await context.store.createReferralAttribution(attribution, audit));
    } catch (error) {
      throw new HttpError(409, "referral_attribution_conflict", errorMessage(error));
    }
  });

  app.post("/v1/internal/rights/revenue-events", async (request, reply) => {
    if (!context.internalToken) throw new HttpError(503, "rights_event_auth_unconfigured", "rights revenue event ingestion requires VOX_INTERNAL_TOKEN");
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const event = parseBody(RightsRevenueEventV1Schema, request.body);
    const existing = (await context.store.listRightsRevenueEvents()).find((item) => item.event_id === event.event_id);
    if (existing) {
      try {
        const result = await context.store.recordRightsRevenueEvent({event, allocations: [], rewards: [], audit_events: []});
        return reply.code(200).send({...result, payout_instructions: rightsPayoutInstructions(result.allocations, result.rewards)});
      } catch (error) {
        throw new HttpError(409, "duplicate_revenue_event", errorMessage(error));
      }
    }
    const now = Date.now();
    if (Date.parse(event.occurred_at) > now + 5 * 60_000 || Date.parse(event.verification.verified_at) > now + 5 * 60_000 || Date.parse(event.recorded_at) > now + 5 * 60_000 || Date.parse(event.recorded_at) < now - 5 * 60_000 || Date.parse(event.verification.verified_at) < Date.parse(event.occurred_at) - 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "revenue event, verification, and recording timestamps are inconsistent or outside the permitted window");
    const allAgreements = await context.store.listRightsAgreements();
    const applicable = allAgreements.filter((record) => sameRightsScope(record.agreement.artifact_scope, event.artifact_scope) && record.agreement.eligible_transaction_types.includes(event.transaction_type) && rightsRecordEffectiveAt(record, Date.parse(event.occurred_at)));
    if (applicable.length === 0) throw new HttpError(409, "rights_agreement_required", "no accepted rights agreement applies to this artifact and transaction");
    if (applicable.length > 1) throw new HttpError(409, "conflicting_rights_agreements", "multiple accepted agreements cover this artifact and transaction");
    const agreementRecord = applicable[0]!;
    const eligibleProceeds = eligibleRightsProceeds(agreementRecord, event);
    const nowIso = new Date().toISOString();
    const allocationRows = calculateRevenueAllocations(eligibleProceeds.toString(), agreementRecord.agreement.allocations)
      .filter((item) => BigInt(item.amount_usdc_atomic) > 0n)
      .map((item) => ({protocol_version: "realize/1" as const, allocation_id: rightsLedgerId("share", event.event_id, item.beneficiary_id), event_id: event.event_id, agreement_id: agreementRecord.agreement.agreement_id, agreement_version: agreementRecord.agreement.version, beneficiary_id: item.beneficiary_id, basis_points: item.basis_points, eligible_proceeds_usdc_atomic: eligibleProceeds.toString(), amount_usdc_atomic: item.amount_usdc_atomic, asset: "USDC" as const, payment_status: "pending" as const, created_at: nowIso, updated_at: nowIso}));
    const purchaseTypes = new Set(["commission", "artifact_sale", "license", "secondary_sale"]);
    const attribution = purchaseTypes.has(event.transaction_type) && event.eligible_commission_usdc_atomic && BigInt(event.eligible_commission_usdc_atomic) > 0n
      ? (await context.store.listReferralAttributions()).find((item) => item.referred_party_id === event.buyer_id && Date.parse(item.attributed_at) <= Date.parse(event.occurred_at) && Date.parse(item.accepted_at) <= Date.parse(event.occurred_at) && Date.parse(item.referrer_accepted_at) <= Date.parse(event.occurred_at) && Date.parse(item.expires_at) > Date.parse(event.occurred_at) && item.referrer_id !== event.seller_id && verifyReferralAttribution(item))
      : undefined;
    let rewards = [] as Array<import("@vox/protocol").DistributionRewardV1>;
    if (attribution && event.eligible_commission_usdc_atomic) {
      const [reward] = calculateRevenueAllocations(event.eligible_commission_usdc_atomic, [{beneficiary_id: attribution.referrer_id, basis_points: attribution.reward_basis_points}]);
      if (reward && BigInt(reward.amount_usdc_atomic) > 0n) rewards = [{protocol_version: "realize/1", reward_id: rightsLedgerId("referral", event.event_id, attribution.referrer_id), attribution_id: attribution.attribution_id, referrer_id: attribution.referrer_id, referred_transaction_id: event.source_transaction_id, event_id: event.event_id, eligible_commission_usdc_atomic: event.eligible_commission_usdc_atomic, reward_basis_points: attribution.reward_basis_points, reward_amount_usdc_atomic: reward.amount_usdc_atomic, asset: "USDC", payment_status: "pending", created_at: nowIso, updated_at: nowIso}];
    }
    const auditEvents = [rightsAuditEvent({agreement_id: agreementRecord.agreement.agreement_id, version: agreementRecord.agreement.version, kind: "revenue_recorded", actor_id: event.verification.verifier_id, record_hash: event.verification.evidence_sha256, occurred_at: nowIso, evidence_reference: event.source_transaction_id})];
    if (attribution && rewards.length) auditEvents.push(rightsAuditEvent({agreement_id: attribution.attribution_id, version: 1, kind: "referral_reward_recorded", actor_id: event.verification.verifier_id, record_hash: event.verification.evidence_sha256, occurred_at: nowIso, evidence_reference: event.source_transaction_id}));
    try {
      const result = await context.store.recordRightsRevenueEvent({event, allocations: allocationRows, rewards, audit_events: auditEvents});
      return reply.code(result.created ? 201 : 200).send({...result, payout_instructions: rightsPayoutInstructions(result.allocations, result.rewards)});
    } catch (error) {
      throw new HttpError(409, "duplicate_revenue_event", errorMessage(error));
    }
  });

  app.get("/v1/rights/lookup", async (request, reply) => {
    const query = request.query as {subject_type?: string; subject_id?: string};
    const parsed = z.object({subject_type: z.enum(["commission", "artifact", "output", "post"]), subject_id: z.string().min(1).max(256)}).safeParse(query);
    if (!parsed.success) throw new HttpError(400, "invalid_rights_lookup", "subject_type and subject_id are required");
    const records = (await context.store.listRightsAgreements()).filter((record) => record.agreement.artifact_scope.subject_type === parsed.data.subject_type && record.agreement.artifact_scope.subject_id === parsed.data.subject_id);
    return reply.send({subject_type: parsed.data.subject_type, subject_id: parsed.data.subject_id, agreements: records.map((record) => ({...record, effective_now: rightsRecordEffectiveAt(record, Date.now())}))});
  });

  app.get("/v1/rights/agreements/:id/audit", async (request, reply) => {
    const agreementId = (request.params as {id: string}).id;
    return reply.send({agreement_id: agreementId, events: await context.store.listRightsAudit(agreementId)});
  });

  app.get("/v1/rights/agreements/:id", async (request, reply) => {
    const {id} = request.params as {id: string};
    const query = request.query as {version?: string};
    const version = query.version === undefined ? undefined : Number.parseInt(query.version, 10);
    if (query.version !== undefined && (!Number.isInteger(version) || String(version) !== query.version || version! < 1)) throw new HttpError(400, "invalid_version", "version must be a positive integer");
    const record = await context.store.getRightsAgreement(id, version);
    if (!record && id.startsWith(FIRST_PARTY_RIGHTS_REFERENCE_PREFIX)) {
      const creatorId = id.slice(FIRST_PARTY_RIGHTS_REFERENCE_PREFIX.length);
      const configuration = await context.store.getRealizePayoutConfiguration(creatorId);
      if (!configuration || configuration.rights_policy_mode !== "first_party" || !isConfiguredFirstPartyCreator(creatorId) || configuration.rights_agreement_reference !== id || (version !== undefined && version !== 1)) throw new HttpError(404, "rights_policy_not_found", "first-party rights policy was not found");
      const policy = createFirstPartyRealizeRightsPolicy(configuration);
      if (policy.policy.policy_id !== id || configuration.rights_agreement_hash !== policy.terms_hash) throw new HttpError(409, "first_party_policy_invalid", "first-party rights policy does not match its pinned creator configuration");
      return reply.send({policy_mode: "first_party", policy: policy.policy, terms_hash: policy.terms_hash, status: "active", effective_now: true});
    }
    if (!record) throw new HttpError(404, "rights_agreement_not_found", "rights agreement not found");
    return reply.send({...record, effective_now: rightsRecordEffectiveAt(record, Date.now())});
  });

  app.get("/v1/rights/beneficiaries/:id/ledger", async (request, reply) => {
    const beneficiaryId = (request.params as {id: string}).id;
    const [allocations, rewards] = await Promise.all([context.store.listRightsRevenueAllocations(), context.store.listDistributionRewards()]);
    const beneficiaryAllocations = allocations.filter((entry) => entry.beneficiary_id === beneficiaryId);
    const beneficiaryRewards = rewards.filter((entry) => entry.referrer_id === beneficiaryId);
    return reply.send({beneficiary_id: beneficiaryId, allocations: beneficiaryAllocations, distribution_rewards: beneficiaryRewards, payout_instructions: rightsPayoutInstructions(beneficiaryAllocations, beneficiaryRewards)});
  });

  app.get("/v1/rights/revenue-events/:id", async (request, reply) => {
    const eventId = (request.params as {id: string}).id;
    const event = (await context.store.listRightsRevenueEvents()).find((item) => item.event_id === eventId);
    if (!event) throw new HttpError(404, "rights_revenue_event_not_found", "rights revenue event not found");
    const [allocations, rewards] = await Promise.all([context.store.listRightsRevenueAllocations(), context.store.listDistributionRewards()]);
    const eventAllocations = allocations.filter((entry) => entry.event_id === eventId);
    const eventRewards = rewards.filter((entry) => entry.event_id === eventId);
    return reply.send({event, allocations: eventAllocations, rewards: eventRewards, payout_instructions: rightsPayoutInstructions(eventAllocations, eventRewards)});
  });

  app.post("/v1/internal/rights/ledger/:id/status", async (request, reply) => {
    if (!context.internalToken) throw new HttpError(503, "rights_ledger_auth_unconfigured", "rights ledger status changes require VOX_INTERNAL_TOKEN");
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const entryId = (request.params as {id: string}).id;
    const body = parseBody(RightsLedgerStatusRequestSchema, request.body);
    const [allocations, rewards] = await Promise.all([context.store.listRightsRevenueAllocations(), context.store.listDistributionRewards()]);
    const entry = allocations.find((item) => item.allocation_id === entryId) ?? rewards.find((item) => item.reward_id === entryId);
    if (!entry) throw new HttpError(404, "rights_ledger_entry_not_found", "rights ledger entry not found");
    const agreementId = "agreement_id" in entry ? entry.agreement_id : entry.attribution_id;
    const version = "agreement_version" in entry ? entry.agreement_version : 1;
    const audit = rightsAuditEvent({agreement_id: agreementId, version, kind: "allocation_status_changed", actor_id: "vox:system:rights-ledger", record_hash: bytesToHex(domainHash("vox.realize.rights.ledger.entry.v1", canonicalBytes({...entry, payment_status: body.status}))), occurred_at: new Date().toISOString(), ...(body.evidence_reference ? {evidence_reference: body.evidence_reference} : {})});
    try {
      return reply.send(await context.store.updateRightsLedgerStatus(entryId, body.status, audit.occurred_at, audit));
    } catch (error) {
      throw new HttpError(409, "rights_ledger_status_conflict", errorMessage(error));
    }
  });

  app.post("/v1/agents", async (request, reply) => {
    const registration = parseBody(AgentRegistrationV1Schema, request.body);
    if (registration.username && isReservedUsername(registration.username)) throw new HttpError(400, "reserved_username", "that username is reserved for a VOX route");
    if (!verifyAgentRegistration(registration)) throw new HttpError(401, "invalid_identity_proof", "agent registration signature or key authorization is invalid");
    try {
      const record = await context.store.registerAgent(registration);
      return reply.code(201).send(record);
    } catch (error) {
      if (error instanceof UsernameConflict) throw new HttpError(409, "username_taken", error.message);
      throw error;
    }
  });

  app.post("/v1/humans", async (request, reply) => {
    const registration = parseBody(HumanRegistrationV1Schema, request.body);
    if (registration.username && isReservedUsername(registration.username)) throw new HttpError(400, "reserved_username", "that username is reserved for a VOX route");
    if (!verifyHumanRegistration(registration)) throw new HttpError(401, "invalid_identity_proof", "human registration signature or key authorization is invalid");
    try {
      const record = await context.store.registerHuman(registration);
      return reply.code(201).send(record);
    } catch (error) {
      if (error instanceof UsernameConflict) throw new HttpError(409, "username_taken", error.message);
      throw error;
    }
  });

  app.get("/v1/me", async (request, reply) => {
    const humanId = await authorizeHumanRequest(context, request.headers as Record<string, unknown>, "GET", "/v1/me");
    const record = await context.store.getHuman(humanId);
    if (!record) throw new HttpError(401, "unauthorized", "a registered VOX human identity is required");
    return reply.send(record);
  });

  app.get("/v1/dm/conversations", async (request, reply) => {
    const query = z.object({limit: z.coerce.number().int().min(1).max(100).default(40)}).strict().safeParse(request.query);
    if (!query.success) throw new HttpError(400, "invalid_request", "limit must be between 1 and 100");
    const path = request.raw.url ?? "/v1/dm/conversations";
    const principalId = await authorizeDirectMessagePrincipal(context, request.headers as Record<string, unknown>, "GET", path);
    return reply.send({items: await context.store.listDirectMessageConversations(principalId, query.data.limit)});
  });

  app.get("/v1/dm/conversations/:id/messages", async (request, reply) => {
    const query = z.object({limit: z.coerce.number().int().min(1).max(100).default(60), cursor: z.string().min(1).max(512).optional()}).strict().safeParse(request.query);
    if (!query.success) throw new HttpError(400, "invalid_request", "limit must be between 1 and 100 and cursor must be a bounded string");
    const {id} = request.params as {id: string};
    const path = request.raw.url ?? `/v1/dm/conversations/${encodeURIComponent(id)}/messages`;
    const principalId = await authorizeDirectMessagePrincipal(context, request.headers as Record<string, unknown>, "GET", path);
    const conversation = await context.store.getDirectMessageConversation(id);
    if (!conversation || !conversation.participants.includes(principalId)) throw new HttpError(404, "conversation_not_found", "conversation not found");
    const before = decodeDirectMessageCursor(query.data.cursor, id);
    const candidates = await context.store.listDirectMessages(id, query.data.limit + 1, before);
    const items = candidates.slice(-query.data.limit);
    const oldest = items[0];
    return reply.send({items, ...(candidates.length > query.data.limit && oldest ? {next_cursor: encodeDirectMessageCursor(id, oldest)} : {})});
  });

  app.post("/v1/dm/messages", async (request, reply) => {
    const body = parseBody(DirectMessageRequestSchema, request.body);
    const path = request.raw.url ?? "/v1/dm/messages";
    const senderId = await authorizeDirectMessagePrincipal(context, request.headers as Record<string, unknown>, "POST", path, body);
    if (senderId === body.recipient_id) throw new HttpError(400, "invalid_recipient", "you cannot message your own account");
    const getPrincipal = (id: string) => id.startsWith("vox:agent:") ? context.store.getAgent(id) : context.store.getHuman(id);
    const [sender, recipient] = await Promise.all([getPrincipal(senderId), getPrincipal(body.recipient_id)]);
    if (!sender || !recipient) throw new HttpError(404, "participant_not_found", "both message participants must have a registered VOX account or character");
    const createdAt = Date.parse(body.created_at);
    if (!Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > 5 * 60_000) throw new HttpError(400, "invalid_timestamp", "message timestamp must be within five minutes of server time");
    const verifiedAttachments = await Promise.all(body.attachments.map(async (attachment) => {
      if (!await context.directMessageMediaStore.canAttach(attachment.asset_hash, senderId)) throw new HttpError(403, "dm_attachment_forbidden", "upload an attachment from this account before sharing it");
      const stored = await context.directMessageMediaStore.get(attachment.asset_hash);
      if (!stored || stored.bytes.byteLength !== attachment.byte_length || stored.mediaType !== attachment.media_type || createHash("sha256").update(stored.bytes).digest("hex") !== attachment.asset_hash) {
        throw new HttpError(400, "dm_attachment_unavailable", "an attachment is missing or does not match its signed metadata");
      }
      return attachment;
    }));
    if (body.source_post_id) {
      const sourcePost = await context.store.getPost(body.source_post_id);
      if (!sourcePost || sourcePost.publication_status !== "published") throw new HttpError(404, "source_post_not_found", "the inspiration post is not publicly available");
    }
    await checkDirectMessageSendRateLimit(context, senderId);
    const conversationId = directMessageConversationId(senderId, body.recipient_id);
    const participants = [senderId, body.recipient_id].sort() as [string, string];
    const messageId = directMessageId(senderId, body.client_message_id);
    const agentSender = senderId.startsWith("vox:agent:");
    const signature = requiredHeader(request.headers as Record<string, unknown>, agentSender ? "x-vox-agent-signature" : "x-vox-realize-signature");
    const signedAt = requiredHeader(request.headers as Record<string, unknown>, agentSender ? "x-vox-agent-timestamp" : "x-vox-realize-timestamp");
    const message = {
      message_id: messageId,
      conversation_id: conversationId,
      sender_id: senderId,
      recipient_id: body.recipient_id,
      client_message_id: body.client_message_id,
      created_at: body.created_at,
      signed_at: signedAt,
      text: body.text,
      attachments: verifiedAttachments,
      ...(body.source_post_id ? {source_post_id: body.source_post_id} : {}),
      ...(body.bid_amount_usdc_atomic ? {bid_amount_usdc_atomic: body.bid_amount_usdc_atomic} : {}),
      signature
    };
    const conversation = {
      conversation_id: conversationId,
      participants,
      updated_at: body.created_at,
      last_message: {sender_id: senderId, created_at: body.created_at, text: body.text.slice(0, 160), attachment_count: verifiedAttachments.length, message_id: messageId, ...(body.source_post_id ? {source_post_id: body.source_post_id} : {}), ...(body.bid_amount_usdc_atomic ? {bid_amount_usdc_atomic: body.bid_amount_usdc_atomic} : {})}
    };
    try {
      const result = await context.store.createDirectMessage(conversation, message);
      return reply.code(result.created ? 201 : 200).send(result.message);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, "dm_message_conflict", errorMessage(error));
    }
  });

  app.post("/v1/dm/media/:hash", {bodyLimit: DIRECT_MESSAGE_MAX_MEDIA_BYTES}, async (request, reply) => {
    const {hash} = request.params as {hash: string};
    if (!/^[0-9a-f]{64}$/.test(hash) || !Buffer.isBuffer(request.body)) throw new HttpError(400, "invalid_dm_media", "valid raw media bytes are required");
    const bytes = request.body;
    const headers = request.headers as Record<string, unknown>;
    const mediaType = requiredHeader(headers, "x-vox-dm-media-type").toLowerCase();
    const byteLength = Number(requiredHeader(headers, "x-vox-dm-byte-length"));
    let fileName: string;
    try { fileName = decodeURIComponent(requiredHeader(headers, "x-vox-dm-file-name")); }
    catch { throw new HttpError(400, "invalid_dm_media", "file name encoding is invalid"); }
    const contentType = requiredHeader(headers, "content-type").split(";", 1)[0]!.trim().toLowerCase();
    if (!DIRECT_MESSAGE_MEDIA_TYPES.has(mediaType) || contentType !== mediaType || !Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength || byteLength > DIRECT_MESSAGE_MAX_MEDIA_BYTES || fileName.length > 180) throw new HttpError(400, "invalid_dm_media", "media metadata is invalid or exceeds 25 MB");
    const mediaMetadata = {asset_hash: hash, file_name: fileName, media_type: mediaType, byte_length: byteLength};
    const path = request.raw.url ?? `/v1/dm/media/${hash}`;
    const principalId = await authorizeDirectMessagePrincipal(context, headers, "POST", path, mediaMetadata);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new HttpError(400, "dm_media_hash_mismatch", "media bytes do not match their signed hash");
    await checkDirectMessageMediaUploadRateLimit(context, principalId);
    await context.directMessageMediaStore.put(hash, mediaType, bytes, principalId);
    return reply.code(201).send({asset_hash: hash, file_name: fileName, media_type: mediaType, byte_length: byteLength});
  });

  app.get("/v1/dm/media/:hash", async (request, reply) => {
    const {hash} = request.params as {hash: string};
    const query = z.object({conversation_id: z.string().min(1).max(128), message_id: z.string().regex(/^vox:dm:message:[0-9a-f]{64}$/).optional()}).strict().safeParse(request.query);
    if (!/^[0-9a-f]{64}$/.test(hash) || !query.success) throw new HttpError(400, "invalid_dm_media", "a media hash and conversation id are required");
    const path = request.raw.url ?? `/v1/dm/media/${hash}?conversation_id=${encodeURIComponent(query.data.conversation_id)}`;
    const principalId = await authorizeDirectMessagePrincipal(context, request.headers as Record<string, unknown>, "GET", path);
    const conversation = await context.store.getDirectMessageConversation(query.data.conversation_id);
    if (!conversation || !conversation.participants.includes(principalId)) throw new HttpError(404, "dm_media_not_found", "media not found");
    let sharedInConversation = false;
    if (query.data.message_id) {
      const message = await context.store.getDirectMessage(conversation.conversation_id, query.data.message_id);
      sharedInConversation = message?.attachments.some((attachment) => attachment.asset_hash === hash) ?? false;
    } else {
      // Retain older clients' URLs without limiting reads to the latest 1,000
      // messages. Current clients provide message_id for a single record read.
      let before: {created_at: string; message_id: string} | undefined;
      while (!sharedInConversation) {
        const page = await context.store.listDirectMessages(conversation.conversation_id, 1000, before);
        sharedInConversation = page.some((message) => message.attachments.some((attachment) => attachment.asset_hash === hash));
        if (page.length < 1000 || sharedInConversation) break;
        before = page[0];
      }
    }
    if (!sharedInConversation) throw new HttpError(404, "dm_media_not_found", "media not found");
    const media = await context.directMessageMediaStore.get(hash);
    if (!media) throw new HttpError(404, "dm_media_not_found", "media not found");
    return reply.type(media.mediaType).header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").send(media.bytes);
  });

  app.get("/v1/profiles/:type/:id/follow-stats", async (request, reply) => {
    const {type, id} = request.params as {type: string; id: string};
    if (type !== "agent" && type !== "human") throw new HttpError(400, "invalid_profile_type", "profile type must be agent or human");
    const profile = type === "agent" ? await context.store.getAgent(id) : await context.store.getHuman(id);
    if (!profile) throw new HttpError(404, "not_found", "profile not found");
    return reply.send(await context.store.getFollowCounts(type, id));
  });

  app.get("/v1/profiles/:type/:id/followers", async (request, reply) => {
    const {type, id} = request.params as {type: string; id: string};
    if (type !== "agent" && type !== "human") throw new HttpError(400, "invalid_profile_type", "profile type must be agent or human");
    const profile = type === "agent" ? await context.store.getAgent(id) : await context.store.getHuman(id);
    if (!profile) throw new HttpError(404, "not_found", "profile not found");
    const query = request.query as {limit?: string};
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "30", 10) || 30, 1), 100);
    const edges = await context.store.listFollowers(type, id, limit);
    const followers = await Promise.all(edges.map(async (edge) => ({edge, profile: edge.follower_type === "agent" ? await context.store.getAgent(edge.follower_id) : await context.store.getHuman(edge.follower_id)})));
    const items = followers.flatMap(({edge, profile}) => {
      if (!profile) return [];
      const registration = profile.registration;
      const id = edge.follower_id;
      const type = edge.follower_type;
      const fallbackPath = type === "agent" ? `/agents/${encodeURIComponent(id.replace(/^vox:agent:/, ""))}` : `/humans/${encodeURIComponent(id)}`;
      return [{follower_type: type, follower_id: id, ...(type === "human" ? {human_id: id} : {}), display_name: registration.display_name, username: registration.username, handle: registration.username ? `@${registration.username}` : registration.handle, profile_url: registration.username ? `/${encodeURIComponent(registration.username)}` : fallbackPath}];
    });
    return reply.send({items, count: (await context.store.getFollowCounts(type, id)).followers});
  });

  app.get("/v1/profiles/:type/:id/following", async (request, reply) => {
    const {type, id} = request.params as {type: string; id: string};
    if (type !== "agent" && type !== "human") throw new HttpError(400, "invalid_profile_type", "profile type must be agent or human");
    const profile = type === "agent" ? await context.store.getAgent(id) : await context.store.getHuman(id);
    if (!profile) throw new HttpError(404, "not_found", `${type} profile not found`);
    const query = request.query as {limit?: string};
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "30", 10) || 30, 1), 100);
    const edges = await context.store.listFollowing(type, id, limit);
    const items = await Promise.all(edges.map(async (edge) => {
      if (edge.target_type === "human") {
        const target = await context.store.getHuman(edge.target_id);
        return target ? {target_type: edge.target_type, target_id: edge.target_id, display_name: target.registration.display_name, username: target.registration.username, handle: target.registration.username ? `@${target.registration.username}` : target.registration.handle, profile_url: target.registration.username ? `/${encodeURIComponent(target.registration.username)}` : `/humans/${encodeURIComponent(edge.target_id)}`} : undefined;
      }
      const target = await context.store.getAgent(edge.target_id);
      return target ? {target_type: edge.target_type, target_id: edge.target_id, display_name: target.registration.display_name, username: target.registration.username, handle: target.registration.username ? `@${target.registration.username}` : target.registration.handle, profile_url: target.registration.username ? `/${encodeURIComponent(target.registration.username)}` : `/agents/${encodeURIComponent(edge.target_id.replace(/^vox:agent:/, ""))}`} : undefined;
    }));
    return reply.send({items: items.filter((item): item is NonNullable<typeof item> => !!item), count: (await context.store.getFollowCounts(type, id)).following});
  });

  app.get("/v1/follows/:type/:id", async (request, reply) => {
    const {type, id} = request.params as {type: string; id: string};
    if (type !== "agent" && type !== "human") throw new HttpError(400, "invalid_profile_type", "profile type must be agent or human");
    const path = `/v1/follows/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
    const {followerType, followerId} = await authorizeFollowViewer(context, request.headers as Record<string, unknown>, path);
    const target = type === "agent" ? await context.store.getAgent(id) : await context.store.getHuman(id);
    if (!target) throw new HttpError(404, "not_found", "follow target not found");
    const follow = await context.store.getFollow(followerType, followerId, type, id);
    return reply.send({following: follow?.active ?? false});
  });

  app.post("/v1/follows", async (request, reply) => {
    const {intent, signature} = parseBody(FollowRequestSchema, request.body);
    const issuedAt = Date.parse(intent.created_at);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 5 * 60_000) throw new HttpError(401, "signature_expired", "Follow signature timestamp is outside the five-minute window");
    const follower = intent.follower_type === "agent" ? await context.store.getAgent(intent.follower_id) : await context.store.getHuman(intent.follower_id);
    if (!follower || !verifyBytes(followSigningPayload(intent), signature, follower.registration.identity_public_key)) throw new HttpError(401, "invalid_signature", "Follow signature is invalid");
    const target = intent.target_type === "agent" ? await context.store.getAgent(intent.target_id) : await context.store.getHuman(intent.target_id);
    if (!target) throw new HttpError(404, "not_found", "follow target not found");
    if (intent.follower_id === intent.target_id) throw new HttpError(400, "cannot_follow_self", "You cannot follow your own profile");
    const now = intent.created_at;
    const follow: FollowRecord = {
      follower_type: intent.follower_type,
      follower_id: intent.follower_id,
      target_type: intent.target_type,
      target_id: intent.target_id,
      active: intent.action === "follow",
      operation_id: intent.operation_id,
      created_at: now,
      updated_at: now
    };
    try {
      const saved = await context.store.setFollow(follow);
      const counts = await context.store.getFollowCounts(intent.target_type, intent.target_id);
      return reply.send({following: saved.active, followers: counts.followers, following_count: counts.following});
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("stale")) throw new HttpError(409, "stale_follow_operation", message);
      throw new HttpError(409, "follow_update_conflict", message);
    }
  });

  app.put("/v1/agents/:id/avatar", {bodyLimit: AVATAR_MAX_UPLOAD_BYTES}, async (request, reply) => {
    const agentId = (request.params as {id: string}).id;
    if (!Buffer.isBuffer(request.body)) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, reason: "raw_body_required"}, "avatar upload rejected before processing");
      throw new HttpError(415, "unsupported_media", "avatar upload must contain raw image bytes");
    }
    const body = request.body;
    const header = (name: string): string => {
      const value = request.headers[name];
      if (typeof value !== "string" || value.length === 0) {
        request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, reason: "missing_header", header: name}, "avatar upload header missing");
        throw new HttpError(400, "invalid_avatar_request", `${name} header is required`);
      }
      return value;
    };
    const contentType = header("content-type").split(";", 1)[0]!.trim().toLowerCase();
    let intent: z.infer<typeof AvatarUploadIntentV1Schema>;
    try {
      intent = parseBody(AvatarUploadIntentV1Schema, {
        protocol: "vox/1",
        agent_id: agentId,
        client_upload_id: header("x-vox-upload-id"),
        content_type: contentType,
        content_length: body.length,
        content_sha256: header("x-vox-content-sha256"),
        issued_at: header("x-vox-issued-at")
      });
    } catch (error) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, reason: "invalid_signed_metadata", content_type: contentType, content_length: body.length}, "avatar upload metadata rejected");
      throw error;
    }
    const agent = await context.store.getAgent(agentId);
    if (!agent) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, reason: "agent_not_found"}, "avatar upload agent not found");
      throw new HttpError(404, "agent_not_found", "agent must be registered before uploading an avatar");
    }
    const issuedAt = Date.parse(intent.issued_at);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60_000) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, reason: "timestamp_out_of_window", issued_at: intent.issued_at}, "avatar upload timestamp rejected");
      throw new HttpError(400, "invalid_timestamp", "avatar upload timestamp is outside the allowed window");
    }
    const rootSignature = header("x-vox-root-signature");
    if (!verifyAvatarUpload(intent, rootSignature, agent.registration.identity_public_key)) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, reason: "invalid_root_signature", content_type: intent.content_type, content_length: intent.content_length, content_sha256: intent.content_sha256, issued_at: intent.issued_at}, "avatar upload signature rejected");
      throw new HttpError(401, "invalid_identity_proof", "avatar upload signature is invalid");
    }
    await checkAvatarUploadRateLimit(context, agentId);
    const actualHash = createHash("sha256").update(body).digest("hex");
    if (actualHash !== intent.content_sha256) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, reason: "content_hash_mismatch", expected_sha256: intent.content_sha256, actual_sha256: actualHash, content_length: body.length}, "avatar upload content hash mismatch");
      throw new HttpError(400, "avatar_hash_mismatch", "avatar bytes do not match the signed content hash");
    }
    let processed;
    try {
      processed = await processAvatar(body, intent.content_type);
    } catch (error) {
      request.log.warn({event: "avatar_upload_rejected", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, reason: "image_processing_rejected", content_type: intent.content_type, content_length: body.length, error_message: error instanceof Error ? error.message : "unknown processing error"}, "avatar image rejected by processor");
      throw new HttpError(400, "invalid_avatar", error instanceof Error ? error.message : "avatar image could not be processed");
    }
    await context.avatarStore.put(processed.asset_hash, processed.bytes);
    request.log.info({event: "avatar_upload_processed", request_id: request.id, agent_id: agentId, client_upload_id: intent.client_upload_id, input_content_type: intent.content_type, input_byte_length: body.length, asset_hash: processed.asset_hash, output_byte_length: processed.byte_length, width: processed.width, height: processed.height, processing_version: processed.processing_version}, "avatar upload processed");
    return reply.code(201).send({agent_id: agentId, client_upload_id: intent.client_upload_id, asset_hash: processed.asset_hash, media_type: processed.media_type, byte_length: processed.byte_length, width: processed.width, height: processed.height, processing_version: processed.processing_version, url: `${context.publicBaseUrl}/v1/assets/avatars/${processed.asset_hash}.webp`});
  });

  app.post("/v1/agents/:id/profile", async (request, reply) => {
    const agentId = (request.params as {id: string}).id;
    const signed = parseBody(SignedAgentProfileUpdateV1Schema, request.body);
    if (signed.update.agent_id !== agentId) throw new HttpError(400, "agent_mismatch", "profile update agent_id does not match route");
    const agent = await context.store.getAgent(agentId);
    if (!agent) {
      request.log.warn({event: "profile_update_rejected", request_id: request.id, agent_id: agentId, reason: "agent_not_found"}, "profile update agent not found");
      throw new HttpError(404, "agent_not_found", "agent must be registered before updating its profile");
    }
    const issuedAt = Date.parse(signed.update.issued_at);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60_000) {
      request.log.warn({event: "profile_update_rejected", request_id: request.id, agent_id: agentId, client_update_id: signed.update.client_update_id, profile_version: signed.update.profile_version, reason: "timestamp_out_of_window", issued_at: signed.update.issued_at}, "profile update timestamp rejected");
      throw new HttpError(400, "invalid_timestamp", "profile update timestamp is outside the allowed window");
    }
    if (!verifyProfileUpdate(signed.update, signed.root_signature, agent.registration.identity_public_key)) {
      request.log.warn({event: "profile_update_rejected", request_id: request.id, agent_id: agentId, client_update_id: signed.update.client_update_id, profile_version: signed.update.profile_version, previous_profile_hash: signed.update.previous_profile_hash, avatar_asset_hash: signed.update.avatar_asset_hash, reason: "invalid_root_signature", issued_at: signed.update.issued_at}, "profile update signature rejected");
      throw new HttpError(401, "invalid_identity_proof", "profile update signature is invalid");
    }
    let avatar: AvatarAssetReference | undefined;
    if (signed.update.avatar_asset_hash) {
      const bytes = await context.avatarStore.get(signed.update.avatar_asset_hash);
      if (!bytes) {
        request.log.warn({event: "profile_update_rejected", request_id: request.id, agent_id: agentId, client_update_id: signed.update.client_update_id, profile_version: signed.update.profile_version, avatar_asset_hash: signed.update.avatar_asset_hash, reason: "avatar_asset_not_found"}, "profile update referenced unknown avatar asset");
        throw new HttpError(404, "avatar_asset_not_found", "the processed avatar asset does not exist");
      }
      avatar = {asset_hash: signed.update.avatar_asset_hash, url: `${context.publicBaseUrl}/v1/assets/avatars/${signed.update.avatar_asset_hash}.webp`, media_type: "image/webp", byte_length: bytes.length, width: 256, height: 256, processing_version: "vox-avatar-v1"};
    }
    const profileHash = profileUpdateHashHex(signed.update);
    const profile: AgentProfileRecord = {
      profile_version: signed.update.profile_version,
      profile_hash: profileHash,
      previous_profile_hash: signed.update.previous_profile_hash,
      client_update_id: signed.update.client_update_id,
      updated_at: new Date().toISOString(),
      ...(avatar ? {avatar} : {}),
      ...(signed.update.livestream !== undefined
        ? {livestream: signed.update.livestream}
        : agent.profile?.livestream !== undefined
          ? {livestream: agent.profile.livestream}
          : {})
    };
    try {
      const record = await context.store.updateAgentProfile(agentId, signed.update, profileHash, profile);
      request.log.info({event: "profile_update_committed", request_id: request.id, agent_id: agentId, client_update_id: signed.update.client_update_id, profile_version: signed.update.profile_version, profile_hash: profileHash, avatar_asset_hash: signed.update.avatar_asset_hash}, "profile update committed");
      return reply.send(record);
    } catch (error) {
      if (error instanceof Error && error.message.includes("profile version conflict")) {
        request.log.warn({event: "profile_update_rejected", request_id: request.id, agent_id: agentId, client_update_id: signed.update.client_update_id, profile_version: signed.update.profile_version, previous_profile_hash: signed.update.previous_profile_hash, reason: "profile_version_conflict"}, "profile update version conflict");
        throw new HttpError(409, "profile_conflict", error.message);
      }
      throw error;
    }
  });

  app.get("/v1/usernames/:username/availability", async (request, reply) => {
    const username = requestUsername((request.params as {username: string}).username);
    if (isReservedUsername(username)) return reply.send({username, available: false, reason: "reserved"});
    const agent = await context.store.getAgentByUsername(username);
    const human = agent ? undefined : await context.store.getHumanByUsername(username);
    const owner = agent ? {principal_type: "agent", principal_id: agent.registration.agent_id} : human ? {principal_type: "human", principal_id: human.registration.human_id} : undefined;
    return reply.send({username, available: !owner, ...(owner ? {reason: "taken", ...owner} : {})});
  });

  app.get("/v1/agents/by-username/:username", async (request, reply) => {
    const username = requestUsername((request.params as {username: string}).username);
    const record = await context.store.getAgentByUsername(username);
    if (!record) throw new HttpError(404, "not_found", "agent username not found");
    return reply.send(record);
  });

  app.get("/v1/live-characters", async (request, reply) => {
    const query = request.query as {limit?: string};
    const parsedLimit = Number.parseInt(query.limit ?? "10", 10) || 10;
    const items = await context.store.listPopuliLivestreamAgents(parsedLimit);
    return reply.send({items});
  });

  app.get("/v1/humans/by-username/:username", async (request, reply) => {
    const username = requestUsername((request.params as {username: string}).username);
    const record = await context.store.getHumanByUsername(username);
    if (!record) throw new HttpError(404, "not_found", "human profile not found");
    return reply.send(record);
  });

  app.get("/v1/humans/:id", async (request, reply) => {
    const record = await context.store.getHuman((request.params as {id: string}).id);
    if (!record) throw new HttpError(404, "not_found", "human profile not found");
    return reply.send(record);
  });

  app.get("/v1/agents/:id", async (request, reply) => {
    const agentId = (request.params as {id: string}).id;
    const record = await context.store.getAgent(agentId);
    if (!record) throw new HttpError(404, "not_found", "agent not found");
    return reply.send(record);
  });

  app.get("/v1/agents/:id/keys", async (request, reply) => {
    const agentId = (request.params as {id: string}).id;
    const record = await context.store.getAgent(agentId);
    if (!record) throw new HttpError(404, "not_found", "agent not found");
    return reply.send({agent_id: agentId, keys: record.registration.publisher_keys});
  });

  app.get("/v1/agents/:id/domain", async (request, reply) => {
    const agentId = (request.params as {id: string}).id;
    const record = await context.store.getAgent(agentId);
    if (!record?.registration.domain_association) throw new HttpError(404, "not_found", "verified domain association not found");
    return reply.send(record.registration.domain_association);
  });

  async function updateAgentKeys(request: {params: unknown; body: unknown}, reply: {send: (value: unknown) => unknown}) {
    const params = request.params as {id: string; key?: string};
    const agentId = params.id;
    const registration = parseBody(AgentRegistrationV1Schema, request.body);
    if (registration.agent_id !== agentId) throw new HttpError(400, "agent_mismatch", "registration agent_id does not match route");
    const current = await context.store.getAgent(agentId);
    if (!current || current.registration.identity_public_key !== registration.identity_public_key) throw new HttpError(404, "not_found", "agent not found");
    if (!verifyAgentRegistration(registration)) throw new HttpError(401, "invalid_identity_proof", "registration root signature is invalid");
    try {
      return reply.send(await context.store.addKeyAuthorization(agentId, registration, params.key ? {publisher_key: params.key, action: "revoke"} : undefined));
    } catch (error) {
      if (error instanceof KeyHistoryConflict) throw new HttpError(409, "key_history_conflict", error.message);
      throw error;
    }
  }
  app.post("/v1/agents/:id/keys", updateAgentKeys);
  app.post("/v1/agents/:id/keys/:key/revoke", updateAgentKeys);

  app.post("/v1/posts", async (request, reply) => {
    const signed = parseBody(SignedPostV1Schema, request.body);
    const agent = await context.store.getAgent(signed.intent.agent_id);
    if (!agent) throw new HttpError(404, "agent_not_found", "agent must be registered before publishing");
    if (!verifyPostSignature(signed.intent, signed.signature)) throw new HttpError(401, "invalid_signature", "post signature is invalid");
    if (!isPublisherKeyAuthorizedAt(agent.registration, signed.intent.author_key, signed.intent.created_at)) throw new HttpError(403, "unauthorized_publisher_key", "publisher key was not authorized at post creation time");
    const createdAt = Date.parse(signed.intent.created_at);
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 10 * 60_000) throw new HttpError(400, "invalid_timestamp", "created_at is too far in the future");
    const postHashBytes = postHash(signed.intent);
    const postHashValue = bytesToHex(postHashBytes);
    const postId = postIdFromIntent(signed.intent);
    const existing = await context.store.getPost(postId);
    if (!existing) await validateConversationPost(context.store, signed.intent);
    if (!existing && signed.intent.kind === "reply") {
      const parent = await context.store.getPost(signed.intent.content.parent_id!);
      if (!parent || parent.publication_status !== "published") throw new HttpError(404, "reply_target_not_found", "reply target post is not publicly available");
    }
    if (!existing) await checkAgentRateLimit(context, signed.intent.agent_id);
    try {
      const result = await context.store.publish({signed, post_hash: postHashValue, post_id: postId, accepted_at: new Date().toISOString(), instance_id: context.instanceId, instance_public_key: context.instancePublicKey, instance_secret_key: context.instanceSecretKey});
      if (result.created) {
        void context.dispatcher.enqueue({post_id: result.post.post_id, tier: result.post.anchoring.tier})
          .then(() => context.store.updateAnchor([result.post.post_id], {status: "queued"}))
          .catch(() => undefined);
      }
      return reply.code(result.created ? 201 : 200).send(postResponse(result.post));
    } catch (error) {
      const dependency = dependencyHttpError(error);
      if (dependency) throw dependency;
      const message = errorMessage(error);
      if (error instanceof ConversationConflict) throw new HttpError(409, "conversation_conflict", message);
      if (message.includes("client_post_id")) throw new HttpError(409, "duplicate_client_post_id", message);
      throw new HttpError(409, "publish_conflict", message);
    }
  });

  registerConversationRoutes(app, context.store);

  app.get("/v1/posts/:id", async (request, reply) => {
    const post = await context.store.getPost((request.params as {id: string}).id);
    if (!post || post.publication_status !== "published") throw new HttpError(404, "not_found", "post not found");
    return reply.send(postResponse(post));
  });

  app.get("/v1/agents/:id/posts", async (request, reply) => {
    const query = request.query as {limit?: string; cursor?: string};
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "30", 10) || 30, 1), 100);
    const cursor = decodeCursor(query.cursor);
    if (query.cursor && !cursor) throw new HttpError(400, "invalid_cursor", "cursor is malformed");
    return reply.send(await context.store.listAgentPosts((request.params as {id: string}).id, limit, cursor ? `${cursor.accepted_at}|${cursor.post_id}` : undefined));
  });

  app.get("/v1/feed", async (request, reply) => {
    const query = request.query as {limit?: string; cursor?: string};
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "30", 10) || 30, 1), 100);
    const cursor = decodeCursor(query.cursor);
    if (query.cursor && !cursor) throw new HttpError(400, "invalid_cursor", "cursor is malformed");
    const page = await context.store.feed(limit, cursor ? `${cursor.accepted_at}|${cursor.post_id}` : undefined);
    return reply.send({...page, ...(page.next_cursor ? {next_cursor: encodeCursor({accepted_at: page.next_cursor.split("|")[0]!, post_id: page.next_cursor.split("|")[1]!})} : {})});
  });

  app.get("/v1/search", async (request, reply) => {
    const query = request.query as {q?: string; limit?: string};
    const q = typeof query.q === "string" ? query.q.trim() : "";
    if (!q || q.length > 120) throw new HttpError(400, "invalid_query", "q must be between 1 and 120 characters");
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "20", 10) || 20, 1), 50);
    return reply.send(await context.store.search(q, limit));
  });

  app.get("/v1/payments/config", async (_request, reply) => {
    const configuration = configuredPayment();
    return reply.send(configuration);
  });

  app.post("/v1/commission-requests", async (request, reply) => {
    const signed = parseBody(SignedCommissionRequestV1Schema, request.body);
    const human = await context.store.getHuman(signed.intent.human_id);
    if (!human) throw new HttpError(404, "human_not_found", "human must be registered before creating a commission request");
    if (!verifyCommissionRequestSignature(signed.intent, signed.signature) || human.registration.identity_public_key !== signed.intent.human_id.slice("vox:human:".length)) {
      throw new HttpError(401, "invalid_signature", "commission request signature is invalid");
    }
    const createdAt = Date.parse(signed.intent.created_at);
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 10 * 60_000) throw new HttpError(400, "invalid_timestamp", "created_at is too far in the future");
    const target = await context.store.getAgent(signed.intent.target_agent_id);
    if (!target) throw new HttpError(404, "agent_not_found", "target agent not found");
    const conversationSeed = signed.intent.content.conversation;
    if (conversationSeed) {
      if (conversationSeed.participant_ids[0] !== signed.intent.target_agent_id) throw new HttpError(400, "invalid_cast", "the invited character must be first in the cast");
      const cast = await Promise.all(conversationSeed.participant_ids.map((id) => context.store.getAgent(id)));
      if (cast.some((agent) => !agent)) throw new HttpError(404, "character_not_found", "every conversation participant must be registered");
    }
    if (signed.intent.content.source_post_id) {
      const sourcePost = await context.store.getPost(signed.intent.content.source_post_id);
      if (!sourcePost || sourcePost.publication_status !== "published") throw new HttpError(404, "source_post_not_found", "source post not found");
      if (!conversationSeed && sourcePost.intent.agent_id !== signed.intent.target_agent_id) throw new HttpError(409, "source_post_mismatch", "source post does not belong to the target agent");
    }
    const requestHash = commissionRequestHashHex(signed.intent);
    const requestId = commissionRequestIdFromIntent(signed.intent);
    const acceptedAt = new Date().toISOString();
    const record: CommissionRequestRecord = {
      request_id: requestId,
      intent: signed.intent,
      signature: signed.signature,
      request_hash: requestHash,
      accepted_at: acceptedAt,
      status: "requested",
      ...(conversationSeed ? {conversation_pending: true} : {}),
      events: [{event_id: `${requestId}:requested`, kind: "requested", status: "requested", created_at: acceptedAt}]
    };
    try {
      const result = await context.store.createCommissionRequest(record);
      return reply.code(result.created ? 201 : 200).send(result.request);
    } catch (error) {
      const dependency = dependencyHttpError(error);
      if (dependency) throw dependency;
      const message = errorMessage(error);
      if (message.includes("client_request_id")) throw new HttpError(409, "duplicate_client_request_id", message);
      throw new HttpError(409, "request_conflict", message);
    }
  });

  app.get("/v1/commission-requests/:id", async (request, reply) => {
    const record = await context.store.getCommissionRequest((request.params as {id: string}).id);
    if (!record) throw new HttpError(404, "not_found", "commission request not found");
    return reply.send(record);
  });

  app.get("/v1/humans/:id/commission-requests", async (request, reply) => {
    const humanId = (request.params as {id: string}).id;
    const human = await context.store.getHuman(humanId);
    if (!human) throw new HttpError(404, "not_found", "human profile not found");
    const rawLimit = Number.parseInt((request.query as {limit?: string}).limit ?? "30", 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 1), 100);
    return reply.send({items: await context.store.listHumanCommissionRequests(humanId, limit)});
  });

  app.post("/v1/posts/:id/reactions", async (request, reply) => {
    const postId = (request.params as {id: string}).id;
    const post = await context.store.getPost(postId);
    if (!post || post.publication_status !== "published") throw new HttpError(404, "not_found", "post not found");
    const body = parseBody(ReactionRequestSchema, request.body);
    const headerActor = request.headers["x-vox-viewer-id"];
    const actorId = body.actor_id ?? (typeof headerActor === "string" ? headerActor : "anonymous");
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(actorId)) throw new HttpError(400, "invalid_actor", "actor_id has invalid characters");
    return reply.send(await context.store.react(postId, actorId, "like"));
  });

  app.get("/v1/posts/:id/proof", async (request, reply) => {
    const post = await context.store.getPost((request.params as {id: string}).id);
    if (!post || post.publication_status !== "published") throw new HttpError(404, "not_found", "post not found");
    const agent = await context.store.getAgent(post.intent.agent_id);
    if (!agent) throw new HttpError(500, "corrupt_state", "post author record is missing");
    const batch = await context.store.getBatchForPost(post.post_id);
    const bundle: ProofBundle = {
      post: {post_id: post.post_id, signed: {intent: post.intent, signature: post.signature}, post_hash: post.post_hash, envelope: post.envelope, envelope_hash: post.envelope_hash},
      agent: agent.registration
    };
    if (batch) {
      const merkleProof = proofForManifest(batch.manifest, post.post_id);
      bundle.manifest = batch.manifest;
      if (merkleProof) bundle.merkle_proof = merkleProof;
      if (batch.receipt) bundle.anchor = {payload_base64url: batch.receipt.payload_base64url, transaction_signature: batch.receipt.transaction_signature, finalized: batch.receipt.finalized, authority_id: batch.receipt.authority_id, type: batch.receipt.commitment_type, manifest_hash: batch.receipt.manifest_hash};
    }
    return reply.send({bundle, verification: verifyProofBundle(bundle), anchoring: post.anchoring});
  });

  app.get("/v1/anchors/:epoch", async (request, reply) => {
    return reply.send({epoch: (request.params as {epoch: string}).epoch, batches: await context.store.listBatches((request.params as {epoch: string}).epoch)});
  });

  app.post("/v1/internal/anchor/claims", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const input = parseBody(AnchorClaimRequestSchema, request.body);
    const claim = await context.store.claimAnchorCandidates(input);
    return reply.send(claim ?? {claimed: false});
  });

  app.get("/v1/internal/anchor/claims/:id", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const claim = await context.store.getAnchorClaim((request.params as {id: string}).id);
    if (!claim) throw new HttpError(404, "not_found", "anchor claim not found");
    return reply.send(claim);
  });

  app.post("/v1/internal/anchor/claims/:id", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const patch = parseBody(AnchorClaimPatchSchema, request.body);
    try {
      const {owner_id, ...rawClaimPatch} = patch;
      const claimPatch = Object.fromEntries(Object.entries(rawClaimPatch).filter(([, value]) => value !== undefined)) as AnchorClaimPatch;
      return reply.send(await context.store.updateAnchorClaim((request.params as {id: string}).id, owner_id, claimPatch));
    } catch (error) {
      const dependency = dependencyHttpError(error);
      if (dependency) throw dependency;
      throw new HttpError(409, "anchor_claim_conflict", errorMessage(error));
    }
  });

  app.get("/v1/internal/anchor/uncertain", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const rawLimit = Number.parseInt((request.query as {limit?: string}).limit ?? "50", 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
    return reply.send({claims: await context.store.listUncertainAnchorClaims(limit)});
  });

  app.get("/v1/internal/anchor/candidates", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const limit = Math.min(Math.max(Number.parseInt((request.query as {limit?: string}).limit ?? "500", 10) || 500, 1), 5000);
    return reply.send({posts: await context.store.listAnchorCandidates(limit), authority_id: "vox:anchor:vox.blog"});
  });

  app.post("/v1/internal/anchor/run", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const body = parseBody(AnchorRunRequestSchema, request.body ?? {});
    const candidates = await context.store.listAnchorCandidates(body.limit);
    if (candidates.length === 0) return reply.send({created: false, reason: "no_candidates"});
    const epoch = body.epoch ?? currentEpoch();
    const records = candidates.map((post) => ({post_id: post.post_id, agent_id: post.intent.agent_id, sequence: post.envelope.sequence, post_hash: post.post_hash, envelope_hash: post.envelope_hash}));
    const batch = buildMerkleBatch({authority_id: "vox:anchor:vox.blog", batch_id: `vox.blog:${epoch}:${records[0]!.post_id}:${records.at(-1)!.post_id}`, epoch, created_at: new Date().toISOString(), records});
    await context.store.saveBatch({manifest: batch.manifest});
    return reply.code(201).send({created: true, manifest: batch.manifest});
  });

  app.post("/v1/internal/anchor/batches", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const body = parseBody(AnchorBatchRequestSchema, request.body);
    const manifest = body.manifest;
    if (!verifyManifest(manifest)) throw new HttpError(400, "invalid_manifest", "manifest hash or Merkle root is invalid");
    const receipt = body.receipt;
    const record: AnchorBatchRecord = receipt ? {manifest, receipt} : {manifest};
    await context.store.saveBatch(record);
    return reply.code(201).send(record);
  });

  app.post("/v1/internal/anchor/status", async (request, reply) => {
    if (!internalAuthorized(request, context.internalToken)) throw new HttpError(401, "unauthorized", "internal token required");
    const body = parseBody(AnchorStatusRequestSchema, request.body);
    const parsedPatch = body.patch;
    const patch = Object.fromEntries(Object.entries(parsedPatch).filter(([, value]) => value !== undefined)) as Partial<AnchorObligation>;
    await context.store.updateAnchor(body.post_ids, patch);
    return reply.send({updated: body.post_ids.length});
  });

  app.post("/v1/internal/realize/creators/:creatorId/payout-configurations", async (request, reply) => {
    requireRealizeAdmin(context, request.headers as Record<string, unknown>);
    const body = parseBody(RealizeCreatorPayoutConfigurationV1Schema, request.body);
    const creatorId = (request.params as {creatorId: string}).creatorId;
    if (body.creator_id !== creatorId) throw new HttpError(400, "creator_mismatch", "payout configuration creator_id must match the route");
    if (!await context.store.getAgent(creatorId)) throw new HttpError(404, "creator_not_found", "creator must be registered with VOX");
    if (body.rights_policy_mode === "first_party") {
      const policy = createFirstPartyRealizeRightsPolicy(body);
      if (!isConfiguredFirstPartyCreator(creatorId) || body.character_owner_id !== creatorId || body.rights_agreement_reference !== policy.policy.policy_id || body.rights_agreement_version !== policy.policy.version || body.rights_agreement_hash !== policy.terms_hash) throw new HttpError(409, "first_party_policy_invalid", "first-party policy must match the VOX-owned creator and published policy hash");
      if (body.network_id !== "solana:mainnet-beta") throw new HttpError(400, "first_party_policy_network", "first-party no-signature policy is enabled only for the Mainnet Realize profile");
    } else {
      const rights = await context.store.getRightsAgreement(body.rights_agreement_reference, body.rights_agreement_version);
      if (!rights || rights.status !== "active" || rights.terms_hash !== body.rights_agreement_hash || computeRevenueRightsAgreementHash(rights.agreement) !== rights.terms_hash) throw new HttpError(409, "rights_agreement_required", "payout configuration must reference an active, accepted rights agreement and its exact terms hash");
      if (rights.agreement.artifact_scope.subject_type === "commission" || rights.agreement.artifact_scope.subject_id !== body.rights_subject_id || !rights.agreement.eligible_transaction_types.includes("commission") || !rights.agreement.grant.rights.includes("generate")) throw new HttpError(409, "rights_agreement_required", "rights agreement must authorize commission generation for the configured subject");
    }
    // Provision the character ledger during Realize onboarding so every enrolled
    // character has an account view before its first funded commission.
    await context.store.getRealizeCharacterAccount(creatorId, process.env.VOX_REALIZE_MAINNET_TREASURY_OWNER?.trim());
    const saved = await context.store.createRealizePayoutConfiguration(body);
    return reply.code(201).send(saved);
  });

  app.get("/v1/internal/realize/creators/:creatorId/account", async (request, reply) => {
    requireRealizeAdmin(context, request.headers as Record<string, unknown>);
    const creatorId = (request.params as {creatorId: string}).creatorId;
    if (!await context.store.getAgent(creatorId)) throw new HttpError(404, "creator_not_found", "creator not found");
    const account = await context.store.getRealizeCharacterAccount(creatorId, process.env.VOX_REALIZE_MAINNET_TREASURY_OWNER?.trim());
    const computed = summarizeCharacterAccount(creatorId, account.transactions);
    return reply.send({
      ...computed,
      balances: account.balances,
      reconciliation: {
        summary_matches_transactions: JSON.stringify(account.balances) === JSON.stringify(computed.balances),
        on_chain_treasury_balance_checked: false
      }
    });
  });

  app.get("/v1/realize/creators/:creatorId/capabilities", async (request, reply) => {
    const creatorId = (request.params as {creatorId: string}).creatorId;
    if (!await context.store.getAgent(creatorId)) throw new HttpError(404, "creator_not_found", "creator not found");
    const configuration = await context.store.getRealizePayoutConfiguration(creatorId);
    if (!configuration) throw new HttpError(404, "creator_not_found", "creator has no active Realize payout configuration");
    try {
      const capabilities = CreatorCapabilitiesV1Schema.parse(await context.populiRealizeClient.getCapabilities(configuration, creatorId));
      if (capabilities.creator_id !== creatorId) throw new Error("Populi capability response names a different creator");
      if ((configuration.rights_policy_mode ?? "signed_agreement") === "signed_agreement" && capabilities.rights_agreement_references && !capabilities.rights_agreement_references.includes(configuration.rights_agreement_reference)) throw new Error("Populi does not advertise the configured rights agreement");
      // VOX owns the exact rights version/hash through its payout policy. Populi
      // may omit this optional discovery field; checkout must still find VOX's terms.
      return reply.send({...capabilities, rights_agreement_references: [configuration.rights_agreement_reference], rights_policy_mode: configuration.rights_policy_mode ?? "signed_agreement"});
    } catch (error) {
      request.log.warn({event: "realize_capability_lookup_failed", creator_id: creatorId}, "Populi capability lookup failed");
      throw new HttpError(503, "provider_unavailable", "creator capabilities are temporarily unavailable");
    }
  });

  app.get("/v1/realize/creators/:creatorId/input-schema", async (request, reply) => {
    const creatorId = (request.params as {creatorId: string}).creatorId;
    const capabilityId = (request.query as {capability_id?: string}).capability_id;
    if (!capabilityId) throw new HttpError(400, "capability_id_required", "capability_id is required");
    const configuration = await context.store.getRealizePayoutConfiguration(creatorId);
    if (!configuration) throw new HttpError(404, "creator_not_configured", "creator has no active Realize payout configuration");
    try {
      const capabilities = CreatorCapabilitiesV1Schema.parse(await context.populiRealizeClient.getCapabilities(configuration, creatorId));
      if (capabilities.creator_id !== creatorId) throw new Error("Populi capability response names a different creator");
      const capability = capabilities.capabilities.find((item) => item.capability_id === capabilityId);
      if (!capability) throw new HttpError(404, "capability_not_found", "creator does not advertise this capability");
      return reply.send(await context.populiRealizeClient.getInputSchema(configuration, capability.input_schema_uri, creatorId));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "provider_unavailable", "creator generation options are temporarily unavailable");
    }
  });

  app.post("/v1/realize/commissions", async (request, reply) => {
    const body = parseBody(CreateRealizeCommissionRequestSchema, request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers as Record<string, unknown>);
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, body.commissioner_id, "POST", "/v1/realize/commissions", {request: body, idempotency_key: idempotencyKey});
    if (!await context.store.getAgent(body.creator_id)) throw new HttpError(404, "creator_not_found", "creator not found");
    if (body.source_post_id) {
      const sourcePost = await context.store.getPost(body.source_post_id);
      if (!sourcePost || sourcePost.publication_status !== "published" || sourcePost.intent.agent_id !== body.creator_id) throw new HttpError(409, "source_post_mismatch", "source post must be a published post by the commissioned creator");
    }
    const configuration = await context.store.getRealizePayoutConfiguration(body.creator_id);
    if (!configuration) throw new HttpError(409, "creator_not_configured", "creator has no active Realize payout configuration");
    if (body.rights_agreement_reference !== configuration.rights_agreement_reference) throw new HttpError(409, "rights_agreement_mismatch", "commission must use the creator's active rights agreement");
    const commissionId = `vox:commission:${createHash("sha256").update(`${body.commissioner_id}\u0000${idempotencyKey}`).digest("hex")}`;
    await activeRealizeRightsAgreement(context, configuration, body.commissioner_id, commissionId);
    const now = new Date().toISOString();
    const commission = CommissionV1Schema.parse({
      protocol_version: "realize/1",
      commission_id: commissionId,
      commissioner_id: body.commissioner_id,
      creator_id: body.creator_id,
      capability_id: body.capability_id,
      requested_generation_parameters: body.requested_generation_parameters,
      rights_agreement_reference: body.rights_agreement_reference,
      state: "DRAFT",
      payment_state: "not_started",
      fulfillment_state: "not_started",
      created_at: now,
      updated_at: now
    });
    const record: RealizeCommissionRecord = {commission, payout_configuration_version: configuration.version, ...(body.source_post_id ? {source_post_id: body.source_post_id} : {}), settlement_status: "not_started", created_at: now, updated_at: now};
    const existing = await context.store.getRealizeCommission(commissionId);
    if (existing) {
      const existingCommission = existing.commission;
      if (existingCommission.commissioner_id !== body.commissioner_id || existingCommission.creator_id !== body.creator_id || existingCommission.capability_id !== body.capability_id || existing.source_post_id !== body.source_post_id || existingCommission.rights_agreement_reference !== body.rights_agreement_reference || realizeCanonicalHash(existingCommission.requested_generation_parameters, "vox.realize.generation.parameters.v1") !== realizeCanonicalHash(body.requested_generation_parameters, "vox.realize.generation.parameters.v1")) throw new HttpError(409, "idempotency_conflict", "Idempotency-Key was already used with different commission terms");
      return reply.send(existingCommission);
    }
    try { return reply.code(201).send((await context.store.createRealizeCommission(record)).commission); }
    catch (error) { throw new HttpError(409, "commission_conflict", errorMessage(error)); }
  });

  app.post("/v1/realize/pricing-requests", async (request, reply) => {
    const body = parseBody(CreatorPricingRequestV1Schema, request.body);
    if (!body.commission_id) throw new HttpError(400, "commission_id_required", "pricing request must name its DRAFT commission");
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, body.requester_id, "POST", "/v1/realize/pricing-requests", body);
    if (Math.abs(Date.now() - Date.parse(body.requested_at)) > 5 * 60_000) throw new HttpError(400, "pricing_request_expired", "pricing request timestamp must be within five minutes");
    const requestHash = realizeCanonicalHash(body, "vox.realize.pricing.request.v1");
    const existingQuote = await context.store.getRealizeQuoteByPricingRequest(body.request_id);
    if (existingQuote) {
      if (existingQuote.pricing_request_hash !== requestHash || existingQuote.commission_id !== body.commission_id) throw new HttpError(409, "idempotency_conflict", "pricing request id was reused with different content");
      const existingCommission = await context.store.getRealizeCommission(body.commission_id);
      if (!existingCommission || existingCommission.commission.commissioner_id !== body.requester_id || existingCommission.commission.creator_id !== body.creator_id || existingCommission.commission.capability_id !== body.capability_id || realizeCanonicalHash(existingCommission.commission.requested_generation_parameters, "vox.realize.generation.parameters.v1") !== realizeCanonicalHash(body.requested_generation_parameters, "vox.realize.generation.parameters.v1")) throw new HttpError(409, "commission_mismatch", "pricing request does not match its commission");
      if (existingCommission.commission.state === "DRAFT") {
        try {
          const payoutConfigurationVersion = existingQuote.payout_configuration_version ?? existingCommission.payout_configuration_version;
          await context.store.updateRealizeCommission(updatedRealizeCommission(existingCommission, {state: "QUOTED", quote_id: existingQuote.quote_id}, payoutConfigurationVersion === undefined ? {} : {payout_configuration_version: payoutConfigurationVersion}), existingCommission.updated_at);
        } catch {
          const latest = await context.store.getRealizeCommission(body.commission_id);
          if (!latest || latest.commission.quote_id !== existingQuote.quote_id) throw new HttpError(409, "commission_conflict", "commission changed while restoring its issued quote");
        }
      } else if (existingCommission.commission.quote_id !== existingQuote.quote_id) {
        throw new HttpError(409, "commission_conflict", "commission is bound to a different quote");
      }
      return reply.send({protocol_version: "realize/1", request_id: body.request_id, creator_id: body.creator_id, quotes: [existingQuote], issued_at: existingQuote.issued_at});
    }
    const current = await context.store.getRealizeCommission(body.commission_id);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    if (current.commission.commissioner_id !== body.requester_id || current.commission.creator_id !== body.creator_id || current.commission.capability_id !== body.capability_id || realizeCanonicalHash(current.commission.requested_generation_parameters, "vox.realize.generation.parameters.v1") !== realizeCanonicalHash(body.requested_generation_parameters, "vox.realize.generation.parameters.v1")) throw new HttpError(409, "commission_mismatch", "pricing request does not match the commission terms");
    if (current.commission.rights_agreement_reference !== (body.rights_agreement_reference ?? current.commission.rights_agreement_reference)) throw new HttpError(409, "rights_agreement_mismatch", "pricing request rights reference does not match the commission");
    if (current.commission.state !== "DRAFT") throw new HttpError(409, "invalid_state_transition", "only a DRAFT commission can be priced");
    const configuration = await context.store.getRealizePayoutConfiguration(body.creator_id, current.payout_configuration_version);
    if (!configuration) throw new HttpError(409, "payout_configuration_unavailable", "commission's pinned payout configuration is unavailable");
    assertMainnetPricingLimits(configuration);
    if (body.rights_agreement_reference && body.rights_agreement_reference !== configuration.rights_agreement_reference) throw new HttpError(409, "rights_agreement_mismatch", "pricing request rights reference is not the active creator agreement");
    await activeRealizeRightsAgreement(context, configuration, body.requester_id, body.commission_id);
    let capabilities;
    try { capabilities = CreatorCapabilitiesV1Schema.parse(await context.populiRealizeClient.getCapabilities(configuration, body.creator_id)); }
    catch { throw new HttpError(503, "provider_unavailable", "creator capabilities are temporarily unavailable"); }
    if (capabilities.creator_id !== body.creator_id) throw new HttpError(503, "provider_invalid_response", "Populi returned capabilities for a different creator");
    const capability = capabilities.capabilities.find((item) => item.capability_id === body.capability_id);
    if (!capability) throw new HttpError(404, "capability_not_found", "creator does not advertise the requested capability");
    if ((configuration.rights_policy_mode ?? "signed_agreement") === "signed_agreement" && capabilities.rights_agreement_references && !capabilities.rights_agreement_references.includes(configuration.rights_agreement_reference)) throw new HttpError(409, "rights_agreement_mismatch", "Populi does not advertise the configured rights agreement");
    const providerId = body.generation_provider_id ?? capabilities.generation_provider_ids[0]!;
    if (!capabilities.generation_provider_ids.includes(providerId) || !configuration.provider_payouts.some((item) => item.provider_id === providerId)) throw new HttpError(404, "provider_not_found", "creator does not advertise a configured generation provider");
    const requestedAt = new Date().toISOString();
    const providerRequest = ProviderPricingRequestV1Schema.parse({
      protocol_version: "realize/1",
      request_id: body.request_id,
      creator_id: body.creator_id,
      capability_id: body.capability_id,
      generation_provider_id: providerId,
      requested_generation_parameters: body.requested_generation_parameters,
      requested_generation_parameters_hash: generationParametersHash(body.requested_generation_parameters),
      rights_agreement_reference: configuration.rights_agreement_reference,
      requested_at: requestedAt
    });
    let rawProviderPrice;
    try { rawProviderPrice = await context.populiRealizeClient.getCurrentPrice(configuration, providerRequest); }
    catch { throw new HttpError(503, "price_unavailable", "creator provider price is temporarily unavailable"); }
    let providerPrice;
    try { providerPrice = validateProviderPrice({providerQuote: rawProviderPrice, request: providerRequest, capabilities, now: requestedAt}); }
    catch { throw new HttpError(502, "provider_invalid_response", "Populi returned a stale or mismatched provider price"); }
    const issuedAt = new Date().toISOString();
    const quote = buildRealizeQuote({
      configuration,
      commissionId: body.commission_id,
      pricingRequestId: body.request_id,
      pricingRequestHash: requestHash,
      capabilityId: body.capability_id,
      generationProviderId: providerId,
      generationParameters: body.requested_generation_parameters,
      outputMediaTypes: capability.output_media_types,
      providerPrice,
      issuedAt,
      issuerId: context.instanceId,
      issuerKeyId: realizeIssuerKeyId(context),
      issuerPublicKey: context.instancePublicKey,
      issuerSecretKey: context.instanceSecretKey
    });
    let storedQuote;
    try { storedQuote = await context.store.createRealizeQuote(quote); }
    catch (error) { throw new HttpError(409, "pricing_request_conflict", errorMessage(error)); }
    const updated = updatedRealizeCommission(current, {state: "QUOTED", quote_id: storedQuote.quote_id}, {payout_configuration_version: configuration.version});
    try { await context.store.updateRealizeCommission(updated, current.updated_at); }
    catch { throw new HttpError(409, "commission_conflict", "commission changed while its price was being issued"); }
    return reply.send({protocol_version: "realize/1", request_id: body.request_id, creator_id: body.creator_id, quotes: [storedQuote], issued_at: issuedAt});
  });

  app.post("/v1/realize/commissions/:commissionId/accept-quote", async (request, reply) => {
    const body = parseBody(AcceptRealizeQuoteRequestSchema, request.body);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    const current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, current.commission.commissioner_id, "POST", `/v1/realize/commissions/${encodeURIComponent(commissionId)}/accept-quote`, body);
    const quote = await context.store.getRealizeQuote(body.quote_id);
    if (!quote || quote.commission_id !== commissionId || quote.creator_id !== current.commission.creator_id || quote.capability_id !== current.commission.capability_id || current.commission.quote_id !== quote.quote_id) throw new HttpError(409, "quote_mismatch", "quote does not match this commission");
    if (computeRealizeQuoteHash(quote) !== quote.canonical_quote_hash || !verifyRealizeQuoteSignature(quote) || quote.issuer_id !== context.instanceId || quote.issuer_public_key !== context.instancePublicKey || body.canonical_quote_hash !== quote.canonical_quote_hash) throw new HttpError(409, "quote_hash_mismatch", "accepted quote hash or issuer signature is invalid");
    if (Date.parse(quote.expires_at) <= Date.now()) throw new HttpError(409, "quote_expired", "quote has expired");
    if (realizeCanonicalHash(quote.requested_generation_parameters, "vox.realize.generation.parameters.v1") !== realizeCanonicalHash(current.commission.requested_generation_parameters, "vox.realize.generation.parameters.v1") || quote.rights_agreement_reference !== current.commission.rights_agreement_reference) throw new HttpError(409, "quote_mismatch", "quote generation parameters or rights agreement differ from the commission");
    const configuration = quote.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
    if (!configuration) throw new HttpError(409, "quote_configuration_mismatch", "pinned quote payout configuration is unavailable");
    assertRealizeQuoteConfiguration(context, quote, configuration);
    if (!quote.usdc_mint) throw new HttpError(409, "quote_configuration_mismatch", "quote is missing its settlement mint");
    await activeRealizeRightsAgreement(context, configuration, current.commission.commissioner_id, commissionId);
    const rail = paymentRailForNetwork(context, quote.network_id ?? "", quote.usdc_mint);
    if (!rail) throw new HttpError(503, "payment_not_configured", "no verified payment rail is enabled for this quote's network and USDC mint");
    if (quote.network_id === "solana:mainnet-beta" && !isManagedRealizeSettlementConfigured()) throw new HttpError(503, "settlement_not_configured", "Mainnet payments require the backend-managed settlement and refund adapter before checkout can accept funds");
    if (quote.network_id === "solana:mainnet-beta" && !isRealizeOperatorApprovalsConfigured()) throw new HttpError(503, "realize_operator_auth_unconfigured", "Mainnet checkout is paused until a VOX refund operator is configured");
    if (current.commission.state === "AWAITING_PAYMENT" && current.payment_intent && current.commission.accepted_quote_hash === quote.canonical_quote_hash) {
      if (current.payer_wallet !== body.payer_wallet) throw new HttpError(409, "quote_acceptance_conflict", "this quote was already accepted for another payer wallet");
      if ((current.public_attribution ?? "") !== (body.public_attribution ?? "")) throw new HttpError(409, "quote_acceptance_conflict", "this quote was already accepted with different public attribution consent");
      if ((current.nft_publication_consent === true) !== (body.nft_publication_consent === true)) throw new HttpError(409, "quote_acceptance_conflict", "this quote was already accepted with different NFT publication consent");
      const funding = await realizeFundingResponse(context, current);
      if (!funding) throw new HttpError(503, "payment_authorization_missing", "the backend payment authorization is unavailable; contact VOX support before funding");
      return reply.send({commission: current.commission, payment_intent: current.payment_intent, funding});
    }
    if (current.commission.state !== "QUOTED") throw new HttpError(409, "invalid_state_transition", "only a QUOTED commission can accept a quote");
    const paymentIntent = PaymentIntentV1Schema.parse({
      protocol_version: "realize/1",
      payment_intent_id: `vox:payment-intent:${createHash("sha256").update(`${commissionId}\u0000${quote.canonical_quote_hash}`).digest("hex")}`,
      commission_id: commissionId,
      quote_id: quote.quote_id,
      accepted_quote_hash: quote.canonical_quote_hash,
      payer_id: current.commission.commissioner_id,
      amount_usdc_atomic: quote.total_amount_usdc_atomic,
      asset: "USDC",
      network_id: quote.network_id,
      status: "created",
      idempotency_key: `vox:payment-intent:${commissionId}:${quote.canonical_quote_hash}`,
      expires_at: quote.expires_at,
      created_at: new Date().toISOString()
    });
    const reviewedAt = new Date().toISOString();
    const updated = updatedRealizeCommission(current, {state: "AWAITING_PAYMENT", payment_state: "pending", quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, payment_intent_id: paymentIntent.payment_intent_id}, {payment_intent: paymentIntent, payer_wallet: body.payer_wallet, rights_reviewed_at: reviewedAt, ...(body.public_attribution ? {public_attribution: body.public_attribution} : {}), ...(body.nft_publication_consent === true ? {nft_publication_consent: true, nft_publication_consent_at: reviewedAt} : {})});
    const fundingAuthorization = await rail.prepareFunding({quote, commission: updated.commission, payerWallet: body.payer_wallet, authorizedIssuerPublicKey: context.instancePublicKey});
    if (fundingAuthorization.mode === "direct" && fundingAuthorization.destination_token_account !== configuration.funding_destination_token_account) throw new HttpError(409, "treasury_configuration_mismatch", "Mainnet payment destination differs from the pinned server treasury configuration");
    const stored = await context.store.updateRealizeCommission({...updated, ...(fundingAuthorization.mode === "escrow" ? {escrow_funding: fundingAuthorization} : {direct_funding: fundingAuthorization})}, current.updated_at);
    return reply.code(201).send({commission: stored.commission, payment_intent: paymentIntent, funding: await realizeFundingResponse(context, stored)});
  });

  app.post("/v1/realize/commissions/:commissionId/fund", async (request, reply) => {
    const body = parseBody(FundRealizeCommissionRequestSchema, request.body);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    let current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, current.commission.commissioner_id, "POST", `/v1/realize/commissions/${encodeURIComponent(commissionId)}/fund`, body);
    if (current.funding_signature) {
      if (current.funding_signature !== body.transaction_signature || current.payer_wallet !== body.payer_wallet) throw new HttpError(409, "payment_replayed", "commission already has a different funding transaction");
      if (current.commission.state === "FUNDED") current = await startRealizeFulfillment(context, current);
      return reply.send(current.commission);
    }
    if (current.direct_funding) {
      if (body.payer_wallet !== current.payer_wallet) throw new HttpError(409, "payment_intent_mismatch", "payer wallet differs from the accepted funding authorization");
      const attempt = await verifyAndRecordMainnetFunding(context, current, body.transaction_signature);
      current = attempt.record;
      if (attempt.status === "pending") throw new HttpError(409, "payment_pending", "Mainnet payment signature is saved and will be checked again until its finalized status is known");
      if (current.commission.state === "FUNDED") current = await startRealizeFulfillment(context, current);
      return reply.code(202).send(current.commission);
    }
    if (current.commission.state !== "AWAITING_PAYMENT" || !current.payment_intent || !current.commission.quote_id) throw new HttpError(409, "payment_required", "commission is not awaiting its quote-bound payment");
    const quote = await context.store.getRealizeQuote(current.commission.quote_id);
    const configuration = quote?.payout_configuration_version ? await context.store.getRealizePayoutConfiguration(current.commission.creator_id, quote.payout_configuration_version) : undefined;
    if (!quote || !configuration || !quote.usdc_mint || !quote.network_id) throw new HttpError(409, "quote_invalid", "accepted quote settlement binding is unavailable");
    assertRealizeQuoteConfiguration(context, quote, configuration);
    // An expired quote does not prove that its transfer never reached the treasury.
    // Verify and durably capture the original payment before deciding its outcome.
    const funding = current.escrow_funding ?? current.direct_funding;
    const rail = paymentRailForNetwork(context, quote.network_id, quote.usdc_mint);
    if (!rail || !funding || funding.payer_wallet !== body.payer_wallet || funding.accepted_quote_hash !== quote.canonical_quote_hash || current.payer_wallet !== body.payer_wallet) throw new HttpError(503, "payment_authorization_missing", "backend-authorized payment funding is unavailable");
    if (funding.commission_id !== commissionId || funding.quote_id !== quote.quote_id || funding.network_id !== quote.network_id || funding.usdc_mint !== quote.usdc_mint || funding.amount_usdc_atomic !== quote.total_amount_usdc_atomic || current.payment_intent.payment_intent_id !== `vox:payment-intent:${createHash("sha256").update(`${commissionId}\u0000${quote.canonical_quote_hash}`).digest("hex")}` || current.payment_intent.amount_usdc_atomic !== quote.total_amount_usdc_atomic || current.payment_intent.network_id !== quote.network_id || current.payment_intent.accepted_quote_hash !== quote.canonical_quote_hash) throw new HttpError(409, "payment_intent_mismatch", "funding authorization does not match the accepted quote-bound payment intent");
    const verification = await rail.verifyFunding(funding, body.transaction_signature, body.payer_wallet);
    if (!verification.finalized) throw new HttpError(409, "payment_pending", verification.reason ?? "funding transaction is awaiting final confirmation");
    if (!verification.matched) throw new HttpError(402, "payment_unverified", verification.reason ?? "funding transaction does not match the accepted quote");
    if (!await context.store.reserveRealizePaymentSignature(body.transaction_signature, commissionId)) throw new HttpError(409, "payment_replayed", "this finalized transaction signature has already funded another Realize commission");
    const capturedIntent = PaymentIntentV1Schema.parse({...current.payment_intent, status: "captured"});
    const fundedAt = new Date().toISOString();
    const funded = updatedRealizeCommission(current, {state: "FUNDED", payment_state: "captured"}, {payment_intent: capturedIntent, payer_wallet: body.payer_wallet, funding_signature: body.transaction_signature, funding_network_id: quote.network_id, funding_verified_at: fundedAt, funded_at: fundedAt});
    let saved: RealizeCommissionRecord;
    try { saved = await context.store.updateRealizeCommission(funded, current.updated_at); }
    catch (error) {
      const latest = await context.store.getRealizeCommission(commissionId);
      if (latest?.funding_signature === body.transaction_signature) return reply.send(latest.commission);
      throw error;
    }
    if (Date.parse(quote.expires_at) <= Date.now()) {
      const review = await markRealizeManualReview(context, saved, "The original payment was verified after quote expiry. Review the captured funds before any generation or refund.", "payment_verified_after_quote_expiry", body.transaction_signature);
      return reply.code(202).send(review.commission);
    }
    const generating = await startRealizeFulfillment(context, saved);
    return reply.code(202).send(generating.commission);
  });

  app.post("/v1/realize/commissions/:commissionId/refund", async (request, reply) => {
    const body = parseBody(RefundRealizeCommissionRequestSchema, request.body);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    let current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, current.commission.commissioner_id, "POST", `/v1/realize/commissions/${encodeURIComponent(commissionId)}/refund`, body);
    const escrowClient = context.devnetRealizeEscrowClient;
    const funding = current.escrow_funding;
    if (current.commission.state === "REFUNDED" && current.payer_wallet === body.payer_wallet && current.refund_response?.transaction_signature === body.transaction_signature) return reply.send(current.commission);
    if (!escrowClient || !funding || current.commission.state !== "REFUND_PENDING" || current.payer_wallet !== body.payer_wallet) throw new HttpError(409, "refund_unavailable", "this commission has no authorized Devnet escrow refund to claim");
    const verification = await escrowClient.verifyRefund(funding, body.transaction_signature, body.payer_wallet);
    if (!verification.finalized) throw new HttpError(409, "refund_pending", verification.reason ?? "refund transaction is awaiting final confirmation");
    if (!verification.matched) throw new HttpError(402, "refund_unverified", verification.reason ?? "refund transaction does not match this escrow");
    const response = await escrowClient.getRefund(funding);
    if (response.status !== "refunded") throw new HttpError(409, "refund_pending", "Devnet has not finalized the exact escrow refund");
    const event = resolutionEvent({commissionId, action: "refund_finalized", actorType: "system", actorId: "devnet-refund-verifier", evidenceHash: body.transaction_signature});
    current = await context.store.updateRealizeCommission(updatedRealizeCommission(current, {state: "REFUNDED", payment_state: "refunded"}, {refund_response: {...response, transaction_signature: body.transaction_signature}, resolution_outcome: "refunded", resolution_reason: "finalized_devnet_refund", resolution_events: appendResolutionEvent(current, event)}), current.updated_at);
    return reply.code(202).send(current.commission);
  });

  app.get("/v1/realize/commissions", async (request, reply) => {
    const requestedLimit = Number.parseInt((request.query as {limit?: string}).limit ?? "30", 10);
    const limit = Math.min(Math.max(requestedLimit || 30, 1), 50);
    const path = `/v1/realize/commissions?limit=${limit}`;
    const humanId = await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, undefined, "GET", path);
    const records = await context.store.listRealizeCommissionsForHuman(humanId, limit);
    return reply.send({items: records.map((record) => ({
      commission: record.commission,
      ...(record.fulfillment_result ? {fulfillment_result: record.fulfillment_result} : {}),
      ...(record.nft_media_ids ? {nft_media_ids: record.nft_media_ids} : {}),
      settlement_status: record.settlement_status
    }))});
  });

  app.get("/v1/realize/commissions/:commissionId", async (request, reply) => {
    const commissionId = (request.params as {commissionId: string}).commissionId;
    let current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, current.commission.commissioner_id, "GET", `/v1/realize/commissions/${encodeURIComponent(commissionId)}`);
    if (["FUNDED", "GENERATING"].includes(current.commission.state) || current.commission.state === "AWAITING_PAYMENT" && current.direct_funding && current.funding_submission_signature && !current.funding_signature) current = await reconcileRealizeCommission(context, current);
    if (current.commission.state === "AWAITING_PAYMENT" && current.escrow_funding && !current.funding_signature && context.devnetRealizeEscrowClient) {
      const recoveredSignature = await context.devnetRealizeEscrowClient.findFundingSignature(current.escrow_funding).catch(() => undefined);
      if (recoveredSignature) {
        const recovered = await context.devnetRealizeEscrowClient.verifyFunding(current.escrow_funding, recoveredSignature, current.payer_wallet ?? "");
        if (recovered.finalized && recovered.matched && await context.store.reserveRealizePaymentSignature(recoveredSignature, commissionId)) {
          const intent = current.payment_intent && PaymentIntentV1Schema.parse({...current.payment_intent, status: "captured"});
          if (intent) {
            const fundedAt = new Date().toISOString();
            const funded = updatedRealizeCommission(current, {state: "FUNDED", payment_state: "captured"}, {payment_intent: intent, funding_signature: recoveredSignature, funding_network_id: current.escrow_funding.network_id, funding_verified_at: fundedAt, funded_at: fundedAt});
            current = await context.store.updateRealizeCommission(funded, current.updated_at);
            current = await startRealizeFulfillment(context, current);
          }
        }
      }
    }
    if ((current.commission.state === "REFUND_PENDING" || current.commission.state === "FAILED" && current.commission.payment_state === "refund_pending") && (current.escrow_funding && context.devnetRealizeEscrowClient || current.direct_funding)) {
      current = await runRealizeRefund(context, current);
    }
    if (current.commission.state === "COMPLETED") {
      current = await reconcileRealizeCommission(context, current);
    }
    const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
    const funding = await realizeFundingResponse(context, current);
    return reply.send({commission: current.commission, ...(quote ? {quote} : {}), ...(current.payment_intent ? {payment_intent: current.payment_intent} : {}), ...(funding ? {funding} : {}), ...(current.fulfillment_result ? {fulfillment_result: current.fulfillment_result} : {}), settlement_status: current.settlement_status, ...(current.settlement_response ? {settlement_response: current.settlement_response} : {}), ...(current.provenance_record_id ? {provenance_record_id: current.provenance_record_id} : {}), ...(current.nft_media_ids ? {nft_media_ids: current.nft_media_ids} : {}), ...(current.resolution_outcome ? {resolution_outcome: current.resolution_outcome} : {}), ...(current.resolution_reason ? {resolution_reason: current.resolution_reason} : {}), ...(current.failure_evidence ? {failure_evidence: current.failure_evidence} : {}), ...(current.resolution_events?.length ? {resolution_events: current.resolution_events} : {}), ...(current.refund_response ? {refund_response: current.refund_response} : {}), ...(current.failure_reason ? {failure_reason: current.failure_reason} : {})});
  });

  app.get("/v1/nft/media/:mediaId", async (request, reply) => {
    if (!context.nftService) throw new HttpError(404, "nft_not_enabled", "NFT minting is not enabled");
    const media = await context.store.getNftMedia((request.params as {mediaId: string}).mediaId);
    if (!media) throw new HttpError(404, "not_found", "VOX media record not found");
    if (media.source_kind === "realize_commission" && media.publication_consent !== true) throw new HttpError(404, "not_found", "VOX media record not found");
    return reply.header("cache-control", "no-store").send(publicNftMedia(media, await context.store.listNftMintsForMedia(media.media_id)));
  });

  app.get("/v1/nft/metadata/:mediaId", async (request, reply) => {
    if (!context.nftService) throw new HttpError(404, "nft_not_enabled", "NFT minting is not enabled");
    const media = await context.store.getNftMedia((request.params as {mediaId: string}).mediaId);
    if (!media) throw new HttpError(404, "not_found", "VOX media record not found");
    if (media.source_kind === "realize_commission" && media.publication_consent !== true) throw new HttpError(404, "not_found", "VOX media record not found");
    if (createHash("sha256").update(canonicalBytes(media.metadata)).digest("hex") !== media.metadata_hash) throw new HttpError(409, "metadata_integrity_failure", "VOX NFT metadata hash does not match its canonical record");
    return reply.type("application/json; charset=utf-8").header("cache-control", "public, max-age=31536000, immutable").send(media.metadata);
  });

  app.post("/v1/nft/mints/:mintId/claim", async (request, reply) => {
    if (!context.nftService) throw new HttpError(404, "nft_not_enabled", "NFT minting is not enabled");
    const mintId = (request.params as {mintId: string}).mintId;
    const mint = await context.store.getNftMint(mintId);
    if (!mint) throw new HttpError(404, "not_found", "NFT entitlement not found");
    const body = parseBody(NftClaimRequestSchema, request.body);
    const path = `/v1/nft/mints/${encodeURIComponent(mintId)}/claim`;
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, mint.owner_id, "POST", path, body);
    if (!verifyNftWalletProof(mint, body.wallet, body.signature)) throw new HttpError(401, "invalid_wallet_proof", `wallet signature does not prove control of the ${mint.chain} destination`);
    if (mint.owner_wallet && mint.owner_wallet.toLowerCase() !== body.wallet.toLowerCase()) throw new HttpError(409, "wallet_binding_conflict", "this entitlement is already bound to another wallet");
    if (mint.state === "finalized") return reply.send({mint_id: mint.mint_id, chain: mint.chain, state: mint.state, transaction_id: mint.transaction_id, explorer_url: mint.explorer_url});
    if (mint.state !== "claimable") return reply.code(202).send({mint_id: mint.mint_id, chain: mint.chain, state: mint.state, owner_wallet: mint.owner_wallet});
    const {lease_owner: _leaseOwner, lease_expires_at: _leaseExpires, last_error: _lastError, next_attempt_at: _nextAttempt, ...withoutTransient} = mint;
    const updated = {...withoutTransient, owner_wallet: body.wallet, state: "queued" as const, updated_at: new Date().toISOString()};
    let saved;
    try { saved = await context.store.updateNftMint(updated, mint.updated_at); }
    catch {
      saved = await context.store.getNftMint(mintId) ?? mint;
      if (saved.owner_wallet?.toLowerCase() !== body.wallet.toLowerCase()) throw new HttpError(409, "wallet_binding_conflict", "this entitlement was concurrently bound to another wallet");
    }
    if (mint.chain.startsWith("monad:")) {
      await context.nftService.processMint(context.store, mintId, `nft-claim:${request.id}`);
      saved = await context.store.getNftMint(mintId) ?? saved;
    }
    return reply.code(saved.state === "queued" ? 202 : 200).send({mint_id: saved.mint_id, chain: saved.chain, state: saved.state, ...(saved.owner_wallet ? {owner_wallet: saved.owner_wallet} : {})});
  });

  app.post("/v1/nft/mints/:mintId/sync", async (request, reply) => {
    if (!context.nftService) throw new HttpError(404, "nft_not_enabled", "NFT minting is not enabled");
    const mintId = (request.params as {mintId: string}).mintId;
    const mint = await context.store.getNftMint(mintId);
    if (!mint) throw new HttpError(404, "not_found", "NFT entitlement not found");
    const body = parseBody(z.object({}).strict(), request.body);
    await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, mint.owner_id, "POST", `/v1/nft/mints/${encodeURIComponent(mintId)}/sync`, body);
    await context.nftService.processMint(context.store, mintId, `nft-sync:${request.id}`);
    const media = await context.store.getNftMedia(mint.media_id);
    if (!media) throw new HttpError(404, "not_found", "VOX media record not found");
    return reply.send(publicNftMedia(media, await context.store.listNftMintsForMedia(media.media_id)));
  });

  app.get("/v1/realize/provenance/:provenanceId", async (request, reply) => {
    const record = await context.store.getRealizeProvenance((request.params as {provenanceId: string}).provenanceId);
    if (!record) throw new HttpError(404, "not_found", "Realize provenance record not found");
    return reply.send(record);
  });

  app.post("/v1/realize/webhooks/populi", {
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > 256 * 1024) throw new HttpError(413, "resource_limit_exceeded", "Populi callback exceeds the request size limit");
        chunks.push(buffer);
      }
      const rawBody = Buffer.concat(chunks);
      (request as typeof request & {realizeRawBody?: Buffer}).realizeRawBody = rawBody;
      return Readable.from([rawBody]);
    }
  }, async (request, reply) => {
    const secret = process.env.VOX_REALIZE_POPULI_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(503, "webhook_unconfigured", "Populi callback authentication is not configured");
    const deliveryId = requiredHeader(request.headers as Record<string, unknown>, "x-realize-webhook-id");
    const timestamp = requiredHeader(request.headers as Record<string, unknown>, "x-realize-webhook-timestamp");
    const timestampSeconds = Number.parseInt(timestamp, 10);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1_000 - timestampSeconds) > 300) throw new HttpError(401, "webhook_signature_invalid", "Populi callback timestamp is outside the five-minute window");
    const rawBody = (request as typeof request & {realizeRawBody?: Buffer}).realizeRawBody;
    if (!rawBody) throw new HttpError(400, "invalid_request", "raw callback body is unavailable");
    const signature = requiredHeader(request.headers as Record<string, unknown>, "x-realize-webhook-signature");
    const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`);
    const provided = Buffer.from(signature);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new HttpError(401, "webhook_signature_invalid", "Populi callback signature is invalid");
    const result = parseBody(FulfillmentResultV1Schema, request.body);
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const prior = await context.store.getRealizeWebhookDelivery(deliveryId);
    if (prior && prior.payload_hash !== payloadHash) throw new HttpError(409, "webhook_replayed", "callback delivery id was reused with different content");
    if (prior?.status === "processed") return reply.send({accepted: true, duplicate: true});
    if (!prior) {
      const reservation = await context.store.createRealizeWebhookDelivery({delivery_id: deliveryId, payload_hash: payloadHash, received_at: new Date().toISOString(), status: "received"});
      if (reservation.conflict) throw new HttpError(409, "webhook_replayed", "callback delivery id was concurrently reused with different content");
      if (reservation.delivery.status === "processed") return reply.send({accepted: true, duplicate: true});
    }
    const current = await context.store.getRealizeCommission(result.commission_id);
    if (!current) throw new HttpError(404, "commission_not_found", "callback commission not found");
    await handleRealizeFulfillmentResult(context, current, result, "signed_webhook", payloadHash);
    await context.store.markRealizeWebhookDeliveryProcessed(deliveryId, payloadHash);
    return reply.send({accepted: true});
  });

  app.post("/v1/internal/realize/reconcile", async (request, reply) => {
    requireRealizeAdmin(context, request.headers as Record<string, unknown>);
    const body = parseBody(InternalRealizeReconcileRequestSchema, request.body ?? {});
    const pending = await context.store.listRealizeCommissions(body.limit);
    const outcomes: Array<{commission_id: string; state: string; error?: string}> = [];
    for (const record of pending) {
      try {
        // Rotate the oldest-first queue even when review/approval is pending or
        // an adapter fails, so one blocked commission cannot starve later work.
        const attempted = await context.store.updateRealizeCommission(updatedRealizeCommission(record, {}), record.updated_at);
        const updated = await reconcileRealizeCommission(context, attempted);
        outcomes.push({commission_id: record.commission.commission_id, state: updated.commission.state});
      } catch (error) {
        outcomes.push({commission_id: record.commission.commission_id, state: record.commission.state, error: errorMessage(error)});
      }
    }
    const nft = context.nftService ? await context.nftService.processPending(context.store, body.limit, `realize-reconcile:${request.id}`) : [];
    return reply.send({processed: outcomes.length, commissions: outcomes, nfts: nft});
  });

  app.post("/v1/internal/realize/commissions/:commissionId/settlement", async (request, reply) => {
    requireRealizeAdmin(context, request.headers as Record<string, unknown>);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    const current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    if (current.commission.state === "SETTLED" && current.settlement_status === "settled") {
      return reply.send({commission_id: commissionId, commission_state: current.commission.state, settlement_status: current.settlement_status, ...(current.settlement_response ? {settlement_response: current.settlement_response} : {})});
    }
    if (current.commission.state !== "COMPLETED" || current.commission.payment_state !== "captured" || !current.funding_signature || !current.funding_verified_at || current.fulfillment_result?.status !== "completed" || !current.provenance_record_id) {
      throw new HttpError(409, "realize_settlement_not_ready", "settlement requires a finalized verified payment and a verified completed fulfillment");
    }
    const updated = await processRealizeSettlement(context, current);
    return reply.send({
      commission_id: commissionId,
      commission_state: updated.commission.state,
      payment_state: updated.commission.payment_state,
      settlement_status: updated.settlement_status,
      ...(updated.settlement_response ? {settlement_response: updated.settlement_response} : {}),
      ...(updated.failure_reason ? {failure_reason: updated.failure_reason} : {})
    });
  });

  app.post("/v1/internal/realize/commissions/:commissionId/arm-no-render-failure", async (request, reply) => {
    const body = parseBody(ArmStagingNoRenderFailureRequestSchema, request.body);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    const path = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/arm-no-render-failure`;
    const operator = await authorizeRealizeOperator(context, request as {headers: Record<string, unknown>}, path, body);
    if (!stagingNoRenderFailureEnabled(context)) throw new HttpError(404, "not_found", "staging no-render failure rehearsal is disabled");
    const current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
    if (current.no_render_failure_armed?.operator_human_id === operator.operatorId && current.no_render_failure_armed.reason === body.reason && current.commission.state === "AWAITING_PAYMENT" && !current.funding_signature && !current.fulfillment_request) return reply.send({commission: current.commission, no_render_failure_armed: true, provider_job_submitted: false, duplicate: true});
    if (current.commission.state !== "AWAITING_PAYMENT" || !current.payment_intent || current.funding_signature || current.fulfillment_request || current.no_render_failure_armed || quote?.network_id !== "solana:devnet") throw new HttpError(409, "no_render_arm_unavailable", "arm only an unfunded Devnet commission before any provider request exists");
    const arm = {operator_human_id: operator.operatorId, armed_at: operator.approvedAt, reason: body.reason, payload_hash: operator.payloadHash};
    const event = resolutionEvent({commissionId, action: "no_render_failure_armed", actorType: "operator", actorId: operator.operatorId, evidenceHash: operator.payloadHash, reasonCode: "staging_no_render_rehearsal"});
    const updated = updatedRealizeCommission(current, {}, {no_render_failure_armed: arm, resolution_events: appendResolutionEvent(current, event)});
    const saved = await context.store.updateRealizeCommission(updated, current.updated_at);
    return reply.send({commission: saved.commission, no_render_failure_armed: true, provider_job_submitted: false});
  });

  app.get("/v1/internal/realize/commissions/:commissionId/refund-preview", async (request, reply) => {
    requireRealizeAdmin(context, request.headers as Record<string, unknown>);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    const path = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/refund-preview`;
    const operatorId = await authorizeRealizeHuman(context, request.headers as Record<string, unknown>, undefined, "GET", path);
    const allowed = configuredRealizeOperatorIds();
    if (allowed.length === 0) throw new HttpError(503, "realize_operator_auth_unconfigured", "Mainnet refund approvals require an allowlisted VOX operator identity");
    if (!allowed.includes(operatorId)) throw new HttpError(403, "realize_operator_forbidden", "VOX human identity is not authorized to approve Mainnet refunds");
    const current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
    if (!quote || quote.network_id !== "solana:mainnet-beta") throw new HttpError(409, "refund_approval_unavailable", "preview is available only for quote-bound Mainnet commissions");
    if (!current.payment_intent || current.payment_intent.status !== "captured" || !current.commission.accepted_quote_hash || !current.payer_wallet || !current.funding_signature || !current.direct_funding || !["captured", "refund_pending"].includes(current.commission.payment_state)) throw new HttpError(409, "refund_binding_missing", "Mainnet refund is missing its original captured payment binding");
    if (!["REFUND_PENDING", "MANUAL_REVIEW"].includes(current.commission.state) || current.resolution_outcome === "fulfilled" || current.resolution_outcome === "refunded") throw new HttpError(409, "refund_unavailable", "commission has no unresolved refundable failure");
    return reply.send({
      commission: {commission_id: commissionId, state: current.commission.state, payment_state: current.commission.payment_state, fulfillment_state: current.commission.fulfillment_state, resolution_outcome: current.resolution_outcome, resolution_reason: current.resolution_reason, funding_timing_status: current.funding_timing_status},
      quote: {quote_id: quote.quote_id, network_id: quote.network_id, usdc_mint: quote.usdc_mint, canonical_quote_hash: quote.canonical_quote_hash, total_amount_usdc_atomic: quote.total_amount_usdc_atomic},
      payment: {payment_intent_id: current.payment_intent.payment_intent_id, payer_wallet: current.payer_wallet, funding_signature: current.funding_signature, amount_usdc_atomic: current.payment_intent.amount_usdc_atomic},
      ...(current.failure_evidence ? {failure_evidence: current.failure_evidence} : {}),
      settlement_status: current.settlement_status,
      ...(current.settlement_response ? {settlement: {status: current.settlement_response.status, settled_amount_usdc_atomic: current.settlement_response.settled_amount_usdc_atomic, held_amount_usdc_atomic: current.settlement_response.held_amount_usdc_atomic, transaction_signatures: current.settlement_response.transaction_signatures}} : {}),
      refund_approval_exists: Boolean(current.refund_approval)
    });
  });

  app.post("/v1/internal/realize/commissions/:commissionId/refund-approval", async (request, reply) => {
    const body = parseBody(ApproveRealizeRefundRequestSchema, request.body);
    const commissionId = (request.params as {commissionId: string}).commissionId;
    const path = `/v1/internal/realize/commissions/${encodeURIComponent(commissionId)}/refund-approval`;
    const operator = await authorizeRealizeOperator(context, request as {headers: Record<string, unknown>}, path, body);
    let current = await context.store.getRealizeCommission(commissionId);
    if (!current) throw new HttpError(404, "commission_not_found", "commission not found");
    const quote = current.commission.quote_id ? await context.store.getRealizeQuote(current.commission.quote_id) : undefined;
    const mainnet = Boolean(quote && requiresExplicitMainnetRefundApproval(quote.network_id ?? ""));
    const stagingTest = Boolean(quote && !mainnet && stagingNoRenderFailureEnabled(context) && current.no_render_failure_armed && current.failure_evidence?.source === "staging_no_render_test");
    if (!quote || !mainnet && !stagingTest) throw new HttpError(409, "refund_approval_unavailable", "approval is available only for quote-bound Mainnet refunds or the isolated staging no-render rehearsal");
    if (!["REFUND_PENDING", "MANUAL_REVIEW"].includes(current.commission.state)) throw new HttpError(409, "refund_unavailable", "commission has no confirmed refundable failure");
    if (current.resolution_outcome === "fulfilled" || current.resolution_outcome === "refunded") throw new HttpError(409, "resolution_final", "commission already has a final resolution");
    const settlementFailureConfirmed = current.settlement_status === "failed" && current.settlement_response?.status === "failed" && current.settlement_response.settled_amount_usdc_atomic === "0";
    const noProviderRequest = !current.fulfillment_request && !current.commission.fulfillment_request_id && !current.fulfillment_result;
    const unsafeTimingReasons = ["late_payment_after_quote_expiry", "funding_time_ambiguous_at_expiry", "funding_time_unavailable", "payment_verified_after_quote_expiry"];
    const unsafeFundingTimingConfirmed = current.funding_signature && noProviderRequest && current.resolution_events?.some((event) => event.action === "manual_review_required" && unsafeTimingReasons.includes(event.reason_code ?? ""));
    if (!current.failure_evidence && !settlementFailureConfirmed && !unsafeFundingTimingConfirmed) throw new HttpError(409, "failure_unconfirmed", "a signed provider failure, unsafe finalized payment timing with no provider request, or reconciled settlement failure is required before refund approval");
    const expected = {
      payer_wallet: current.payer_wallet,
      funding_signature: current.funding_signature,
      payment_intent_id: current.payment_intent?.payment_intent_id,
      accepted_quote_hash: current.commission.accepted_quote_hash,
      amount_usdc_atomic: current.payment_intent?.amount_usdc_atomic
    };
    if (body.payer_wallet !== expected.payer_wallet || body.funding_signature !== expected.funding_signature || body.payment_intent_id !== expected.payment_intent_id || body.accepted_quote_hash !== expected.accepted_quote_hash || body.amount_usdc_atomic !== expected.amount_usdc_atomic) throw new HttpError(409, "refund_approval_binding_mismatch", "approval must match the exact finalized payer, payment intent, accepted quote, and USDC amount");
    try {
      if (mainnet) await mainnetRefundPreflight(context, current);
      else {
        const escrowClient = context.devnetRealizeEscrowClient;
        const funding = current.escrow_funding;
        if (!escrowClient || !funding || funding.network_id !== "solana:devnet" || funding.usdc_mint !== quote.usdc_mint || funding.amount_usdc_atomic !== body.amount_usdc_atomic || funding.payer_wallet !== body.payer_wallet || funding.accepted_quote_hash !== body.accepted_quote_hash) throw new HttpError(409, "refund_binding_mismatch", "staging refund does not match the exact Devnet payment");
        const check = await escrowClient.verifyFunding(funding, body.funding_signature, body.payer_wallet);
        if (!check.finalized || !check.matched) throw new HttpError(409, "funding_unverified", check.reason ?? "staging funding is not finalized and exact");
        const progress = await escrowClient.fundingProgress(funding);
        if (BigInt(progress.paid_usdc_atomic) !== 0n || !["Funded", "Refundable"].includes(progress.status)) throw new HttpError(409, "settlement_requires_review", "staging escrow has payout activity or an uncertain state");
      }
    } catch (error) {
      current = await markRealizeManualReview(context, current, errorMessage(error), error instanceof HttpError ? error.code : "refund_preflight_failed");
      throw error;
    }
    const existingApproval = current.refund_approval;
    if (existingApproval) {
      const same = existingApproval.operator_human_id === operator.operatorId && existingApproval.payer_wallet === body.payer_wallet && existingApproval.funding_signature === body.funding_signature && existingApproval.payment_intent_id === body.payment_intent_id && existingApproval.accepted_quote_hash === body.accepted_quote_hash && existingApproval.amount_usdc_atomic === body.amount_usdc_atomic && existingApproval.reason === body.reason;
      if (!same) throw new HttpError(409, "refund_approval_immutable", "a different exact refund approval is already recorded");
    }
    const approval: RealizeRefundApproval = existingApproval ?? {
      operator_human_id: operator.operatorId,
      approved_at: operator.approvedAt,
      approval_payload_hash: operator.payloadHash,
      approval_signature: operator.signature,
      payer_wallet: body.payer_wallet,
      funding_signature: body.funding_signature,
      payment_intent_id: body.payment_intent_id,
      accepted_quote_hash: body.accepted_quote_hash,
      amount_usdc_atomic: body.amount_usdc_atomic,
      reason: body.reason
    };
    const event = resolutionEvent({commissionId, action: "refund_approved", actorType: "operator", actorId: operator.operatorId, evidenceHash: approval.approval_payload_hash, reasonCode: "exact_mainnet_refund_approved"});
    const updated = updatedRealizeCommission(current, {state: "REFUND_PENDING", payment_state: "refund_pending"}, {
      refund_approval: approval,
      resolution_reason: mainnet ? "operator_approved_mainnet_refund" : "operator_approved_staging_refund_rehearsal",
      ...(!existingApproval ? {resolution_events: appendResolutionEvent(current, event)} : {})
    });
    try { current = await context.store.updateRealizeCommission(updated, current.updated_at); }
    catch { current = await context.store.getRealizeCommission(commissionId) ?? current; }
    if (current.refund_approval?.approval_payload_hash !== approval.approval_payload_hash || current.commission.state !== "REFUND_PENDING") throw new HttpError(409, "refund_approval_race", "commission changed while the refund approval was being recorded");
    current = await runRealizeRefund(context, current);
    return reply.send({commission: current.commission, resolution_outcome: current.resolution_outcome, resolution_reason: current.resolution_reason, ...(current.refund_response ? {refund_response: current.refund_response} : {}), resolution_events: current.resolution_events ?? []});
  });

  app.post("/v1/posts/:id/realize/quote", async (request, reply) => {
    const postId = (request.params as {id: string}).id;
    const post = await context.store.getPost(postId);
    if (!post || post.publication_status !== "published") throw new HttpError(404, "not_found", "eligible post not found");
    const body = parseBody(RealizationQuoteRequestSchema, request.body ?? {});
    const commissionRequest = body.commission_request_id ? await context.store.getCommissionRequest(body.commission_request_id) : undefined;
    if (body.commission_request_id && !commissionRequest) throw new HttpError(404, "commission_request_not_found", "commission request not found");
    if (commissionRequest) {
      if (commissionRequest.intent.target_agent_id !== post.intent.agent_id) throw new HttpError(409, "commission_target_mismatch", "commission request target does not match the post author");
      if (commissionRequest.intent.human_id !== body.requester_id) throw new HttpError(409, "requester_mismatch", "requester identity does not match the commission request");
    }
    const configuration = configuredPayment();
    if (configuration.mode === "direct" && !isValidSolanaAddress(body.requester_id)) throw new HttpError(400, "customer_identity_required", "direct payments require a Solana wallet address as requester_id");
    const providerQuote = await context.media.quote({post_id: postId, style: body.style, duration_seconds: body.duration_seconds, requester_id: body.requester_id});
    const createdAt = new Date().toISOString();
    // The public quote id is unique to this issued commission brief. The provider's
    // own id stays private and is used only when the server requests generation.
    const publicQuoteId = `vox:quote:${randomUUID()}`;
    const quoteRecord: QuoteRecord = {
      ...providerQuote,
      quote_id: publicQuoteId,
      provider_quote_id: providerQuote.quote_id,
      requester_id: body.requester_id,
      generation_description: body.generation_description,
      ...(body.commission_request_id ? {commission_request_id: body.commission_request_id} : {}),
      ...(configuration.mode === "direct" ? {payment_reference: paymentReferenceForQuote(publicQuoteId)} : {}),
      style: body.style,
      duration_seconds: body.duration_seconds,
      status: "issued",
      created_at: createdAt
    };
    const stored = await context.store.createQuote(quoteRecord);
    if (commissionRequest) {
      await context.store.appendCommissionRequestEvent(commissionRequest.request_id, {event_id: `${commissionRequest.request_id}:quote:${stored.quote_id}`, kind: "quote_issued", status: "quoted", quote_id: stored.quote_id, created_at: createdAt, amount_usdc_atomic: stored.amount_usdc_atomic});
    }
    return reply.send(publicQuote(stored, configuration));
  });

  app.get("/v1/posts/:id/realize/quotes/:quoteId", async (request, reply) => {
    const params = request.params as {id: string; quoteId: string};
    const query = request.query as {requester_id?: string};
    const requesterId = query.requester_id;
    if (!requesterId || requesterId.length > 160) throw new HttpError(400, "requester_required", "the original requester identity is required to restore this quote");
    const quote = await context.store.getQuote(params.quoteId);
    if (!quote || quote.post_id !== params.id || quote.requester_id !== requesterId) throw new HttpError(404, "quote_not_found", "quote not found for this requester");
    return reply.send(publicQuote(quote, configuredPayment()));
  });

  app.post("/v1/realizations", async (request, reply) => {
    const body = parseBody(RealizationRequestSchema, request.body);
    const submittedPaymentReference = body.payment_reference ?? body.payment_signature ?? "";
    if (!submittedPaymentReference) throw new HttpError(400, "payment_reference_required", "a unique payment reference is required");
    const existingRealization = await context.store.findRealizationByPaymentReference(submittedPaymentReference);
    if (existingRealization) {
      if (existingRealization.post_id !== body.post_id) throw new HttpError(409, "payment_replayed", "payment reference was already used for another post");
      return reply.code(200).send(publicRealization(existingRealization));
    }
    const existingPayment = await context.store.getPayment(submittedPaymentReference);
    if (existingPayment) {
      if (existingPayment.post_id !== body.post_id) throw new HttpError(409, "payment_replayed", "payment reference was already used for another economic record");
      if (existingPayment.realization_id) {
        const realization = await context.store.getRealization(existingPayment.realization_id);
        if (realization) return reply.code(200).send(publicRealization(realization));
      }
      throw new HttpError(409, existingPayment.status === "refundable" ? "payment_refundable" : "payment_in_progress", "payment reference is already reserved and requires reconciliation");
    }

    const quote = await context.store.getQuote(body.quote_id);
    if (!quote || quote.post_id !== body.post_id || Date.parse(quote.expires_at) <= Date.now()) throw new HttpError(409, "quote_invalid", "quote is missing, mismatched or expired");
    if (body.commission_request_id && quote.commission_request_id && body.commission_request_id !== quote.commission_request_id) throw new HttpError(409, "commission_request_mismatch", "commission request does not match the quote");
    const commissionRequestId = body.commission_request_id ?? quote.commission_request_id;
    const commissionRequest = commissionRequestId ? await context.store.getCommissionRequest(commissionRequestId) : undefined;
    if (commissionRequestId && !commissionRequest) throw new HttpError(404, "commission_request_not_found", "commission request not found");
    const requesterId = body.requester_id ?? quote.requester_id;
    if (requesterId !== quote.requester_id) throw new HttpError(409, "requester_mismatch", "requester identity does not match the quote");
    if (commissionRequest && (commissionRequest.intent.human_id !== requesterId || commissionRequest.intent.target_agent_id !== (await context.store.getPost(body.post_id))?.intent.agent_id)) throw new HttpError(409, "commission_request_mismatch", "requester or target does not match the commission request");
    const configuration = configuredPayment();
    const paymentMode = configuration.mode;
    const paymentReference = paymentMode === "direct" ? quote.payment_reference ?? paymentReferenceForQuote(quote.quote_id) : submittedPaymentReference;
    if (paymentMode === "direct") {
      if (body.payment_reference !== paymentReference) throw new HttpError(400, "payment_reference_mismatch", "payment reference does not match the issued quote");
      if (!isValidSolanaAddress(requesterId)) throw new HttpError(400, "customer_identity_required", "direct payments require a Solana wallet address as requester_id");
      if (!body.payment_signature) throw new HttpError(402, "payment_signature_required", "direct payments require a finalized Solana transaction signature");
      if (body.payment_signature === paymentReference) throw new HttpError(400, "payment_signature_invalid", "payment signature must be the submitted Solana transaction signature");
    }

    let paymentEvidence: {transaction_signature: string; usdc_mint: string; destination_token_account: string; source_token_account?: string} | undefined;
    if (paymentMode === "direct") {
      const verification = await verifyFinalizedUsdcTransfer({
        rpc_url: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
        transaction_signature: body.payment_signature!,
        usdc_mint: configuration.usdc_mint,
        destination_token_account: configuration.destination_token_account,
        amount_atomic: quote.amount_usdc_atomic,
        payer_address: requesterId,
        payment_reference: paymentReference
      });
      if (!verification.finalized || !verification.matched) throw new HttpError(402, "payment_unverified", "USDC transfer is not finalized or does not match the exact quote, payer, and payment reference");
      paymentEvidence = {transaction_signature: body.payment_signature!, usdc_mint: verification.usdc_mint, destination_token_account: verification.destination_token_account, ...(verification.source_token_account ? {source_token_account: verification.source_token_account} : {})};
    }

    const now = new Date().toISOString();
    const payment: PaymentRecord = {
      payment_id: paymentIdFromReference(paymentReference),
      payment_reference: paymentReference,
      purpose: "realization",
      status: "reserved",
      asset: "USDC",
      network: paymentMode === "direct" ? "solana" : "offchain",
      amount_usdc_atomic: quote.amount_usdc_atomic,
      payer_id: requesterId,
      quote_id: quote.quote_id,
      post_id: quote.post_id,
      ...(commissionRequestId ? {commission_request_id: commissionRequestId} : {}),
      payment_mode: paymentMode,
      ...(paymentEvidence ?? {}),
      created_at: now,
      updated_at: now
    };
    let reservation;
    try {
      reservation = await context.store.reservePayment(payment);
    } catch (error) {
      const dependency = dependencyHttpError(error);
      if (dependency) throw dependency;
      throw new HttpError(409, "payment_replayed", errorMessage(error));
    }
    if (!reservation.created) {
      if (reservation.payment.realization_id) {
        const realization = await context.store.getRealization(reservation.payment.realization_id);
        if (realization) return reply.code(200).send(publicRealization(realization));
      }
      throw new HttpError(409, "payment_in_progress", "payment reference is already reserved and requires reconciliation");
    }
    if (commissionRequest && commissionRequestId) {
      await context.store.appendCommissionRequestEvent(commissionRequestId, {event_id: `${commissionRequestId}:payment:${payment.payment_id}:reserved`, kind: "payment_reserved", status: "payment_reserved", payment_id: payment.payment_id, quote_id: quote.quote_id, created_at: now, amount_usdc_atomic: payment.amount_usdc_atomic, ...(payment.transaction_signature ? {transaction_signature: payment.transaction_signature} : {})});
    }

    try {
      const job = await context.media.requestGeneration({quote_id: quote.provider_quote_id ?? quote.quote_id, post_id: quote.post_id, payment_reference: paymentReference, requester_id: requesterId, ...(quote.generation_description ? {generation_description: quote.generation_description} : {})});
      const realization: RealizationRecord = {
        realization_id: job.job_id,
        post_id: job.post_id,
        quote_id: quote.quote_id,
        payment_id: payment.payment_id,
        ...(commissionRequestId ? {commission_request_id: commissionRequestId} : {}),
        requester_id: requesterId,
        ...(body.public_attribution ? {public_attribution: body.public_attribution} : {}),
        provider_id: job.provider_id,
        status: job.status === "delivered" ? "delivered" : job.status === "failed" ? "failed" : job.status === "refundable" ? "refundable" : "queued",
        payment_status: "reserved",
        payment_reference: paymentReference,
        payment_mode: paymentMode,
        economic_purpose: "realization",
        mock: true,
        ...(job.media_url ? {media_url: job.media_url} : {}),
        ...(job.media_hash ? {media_hash: job.media_hash} : {}),
        created_at: new Date().toISOString()
      };
      let storedRealization = await context.store.createRealizationWithPayment({payment, realization});
      storedRealization = await provisionLegacyNft(context, storedRealization);
      if (commissionRequest && commissionRequestId) {
        const eventKind: CommissionRequestEvent["kind"] = job.status === "delivered" ? "realization_delivered" : job.status === "failed" ? "realization_failed" : job.status === "processing" ? "realization_processing" : "realization_queued";
        const requestStatus: CommissionRequestRecord["status"] = job.status === "delivered" ? "delivered" : job.status === "failed" ? "failed" : job.status === "refundable" ? "refundable" : job.status === "processing" ? "processing" : "queued";
        await context.store.appendCommissionRequestEvent(commissionRequestId, {event_id: `${commissionRequestId}:realization:${storedRealization.realization_id}`, kind: eventKind, status: requestStatus, payment_id: payment.payment_id, quote_id: quote.quote_id, realization_id: storedRealization.realization_id, created_at: storedRealization.created_at, ...(storedRealization.media_url ? {media_url: storedRealization.media_url} : {})});
      }
      return reply.code(201).send(publicRealization(storedRealization));
    } catch (error) {
      const failedPayment = await context.store.markPaymentFailed(paymentReference, paymentMode === "direct" ? "refundable" : "failed", errorMessage(error)).catch(() => undefined);
      if (commissionRequest && commissionRequestId && failedPayment) {
        await context.store.appendCommissionRequestEvent(commissionRequestId, {event_id: `${commissionRequestId}:payment:${failedPayment.payment_id}:failed`, kind: "payment_failed", status: paymentMode === "direct" ? "refundable" : "failed", payment_id: failedPayment.payment_id, quote_id: quote.quote_id, created_at: failedPayment.updated_at, ...(failedPayment.error ? {error: failedPayment.error} : {})});
      }
      throw error;
    }
  });

  app.get("/v1/realizations/:id", async (request, reply) => {
    let record = await context.store.getRealization((request.params as {id: string}).id);
    if (!record) throw new HttpError(404, "not_found", "realization not found");
    record = await provisionLegacyNft(context, record);
    return reply.send(publicRealization(record));
  });

  app.get("/v1/assets/avatars/:asset", async (request, reply) => {
    const asset = (request.params as {asset: string}).asset;
    if (!/^[0-9a-f]{64}\.webp$/.test(asset)) throw new HttpError(404, "not_found", "avatar asset not found");
    const assetHash = asset.slice(0, -".webp".length);
    const bytes = await context.avatarStore.get(assetHash);
    if (!bytes) throw new HttpError(404, "not_found", "avatar asset not found");
    return reply.type("image/webp").header("cache-control", "public, max-age=31536000, immutable").header("x-content-type-options", "nosniff").header("content-disposition", "inline").send(bytes);
  });

  registerPublicRoutes(app, {
    store: context.store,
    baseUrl: context.publicBaseUrl,
    webDistDir: options.webDistDir ?? process.env.VOX_WEB_DIST_DIR ?? defaultWebDistDir(),
    docsDir: options.docsDir ?? process.env.VOX_DOCS_DIR ?? defaultDocsDir()
  });

  return app;
}

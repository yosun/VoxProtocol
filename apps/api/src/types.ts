import type {
  AgentProfileUpdateV1,
  AgentLivestreamV1,
  AgentRegistrationV1,
  AnchorObligation,
  AnchorReceiptV1,
  BatchManifestV1,
  HumanRegistrationV1,
  JournalEnvelopeV1,
  CommissionV1,
  ProviderFulfillmentRequestV1,
  FulfillmentResultV1,
  PaymentIntentV1,
  ProvenanceRecordV1,
  RevenueRightsAgreementV1,
  RightsAgreementTerminationV1,
  RightsAuditEventV1,
  RightsRevenueAllocationV1,
  RightsRevenueEventV1,
  ReferralAttributionV1,
  DistributionRewardV1,
  RealizeQuoteV1,
  SettlementInstructionV1,
  SignedCommissionRequestV1,
  SignedPostV1
} from "@vox/protocol";
import type {KeyAuthorizationUpdateExpectation} from "./key-history.js";
import type {RealizeCreatorPayoutConfigurationV1, RealizeRefundResponseV1, RealizeSettlementResponseV1} from "./realize-engine.js";
import type {EscrowFundingAuthorization} from "./realize-solana-devnet.js";
import type {MainnetSplUsdcFundingAuthorization} from "./realize-payment.js";

export interface AvatarAssetReference {
  asset_hash: string;
  url: string;
  media_type: "image/webp";
  byte_length: number;
  width: 256;
  height: 256;
  processing_version: "vox-avatar-v1";
}

export interface AgentProfileRecord {
  profile_version: number;
  profile_hash: string;
  previous_profile_hash: string | null;
  client_update_id: string;
  updated_at: string;
  avatar?: AvatarAssetReference;
  livestream?: AgentLivestreamV1 | null;
}

export interface AgentRecord {
  registration: AgentRegistrationV1;
  created_at: string;
  updated_at: string;
  last_sequence: number;
  last_event_hash: string | null;
  profile?: AgentProfileRecord;
}

export interface HumanRecord {
  registration: HumanRegistrationV1;
  created_at: string;
  updated_at: string;
}

export type CommissionRequestStatus = "requested" | "quoted" | "payment_reserved" | "paid" | "queued" | "processing" | "delivered" | "failed" | "refundable";
export type CommissionRequestEventKind = "requested" | "quote_issued" | "payment_reserved" | "payment_captured" | "payment_failed" | "realization_queued" | "realization_processing" | "realization_delivered" | "realization_failed";

export interface CommissionRequestEvent {
  event_id: string;
  kind: CommissionRequestEventKind;
  created_at: string;
  status?: CommissionRequestStatus;
  quote_id?: string;
  payment_id?: string;
  realization_id?: string;
  amount_usdc_atomic?: string;
  transaction_signature?: string;
  media_url?: string;
  error?: string;
}

export interface CommissionRequestRecord {
  request_id: string;
  intent: SignedCommissionRequestV1["intent"];
  signature: string;
  request_hash: string;
  accepted_at: string;
  status: CommissionRequestStatus;
  events: CommissionRequestEvent[];
  quote_id?: string;
  payment_id?: string;
  realization_id?: string;
}

export interface CommissionRequestResult {
  request: CommissionRequestRecord;
  created: boolean;
}

export interface StoredPost {
  post_id: string;
  intent: SignedPostV1["intent"];
  signature: string;
  post_hash: string;
  envelope: JournalEnvelopeV1;
  envelope_hash: string;
  accepted_at: string;
  publication_status: "published" | "hidden" | "superseded" | "tombstoned";
  anchoring: AnchorObligation;
}

export interface AnchorBatchRecord {
  manifest: BatchManifestV1;
  claim_id?: string;
  kind?: AnchorClaimKind;
  state?: AnchorClaimState;
  manifest_uri?: string;
  receipt?: AnchorReceiptV1;
}

export type AnchorClaimKind = "BATCH" | "POST";
export type AnchorClaimTier = AgentRegistrationV1["anchoring_tier"] | "all";
export type AnchorClaimState = "claimed" | "manifested" | "submitting" | "uncertain" | "submitted" | "finalized" | "retryable_failure";

export interface AnchorClaimRecord {
  claim_id: string;
  batch_id: string;
  kind: AnchorClaimKind;
  authority_id: string;
  epoch: string;
  tier: AnchorClaimTier;
  owner_id: string;
  post_ids: string[];
  state: AnchorClaimState;
  manifest_created_at: string;
  lease_expires_at?: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  manifest_hash?: string;
  transaction_signature?: string;
  next_attempt_at?: string;
  error?: string;
}

export interface AnchorClaimInput {
  owner_id: string;
  authority_id: string;
  epoch: string;
  tier: AnchorClaimTier;
  kind: AnchorClaimKind;
  limit: number;
  lease_seconds: number;
}

export interface AnchorClaimPatch {
  state?: AnchorClaimState;
  manifest?: BatchManifestV1;
  manifest_uri?: string;
  receipt?: AnchorReceiptV1;
  transaction_signature?: string;
  next_attempt_at?: string;
  error?: string;
  lease_seconds?: number;
  clear_lease?: boolean;
}

export interface AnchorClaimResponse {
  claim: AnchorClaimRecord;
  posts: StoredPost[];
  batch?: AnchorBatchRecord;
}

export type EconomicPurpose = "realization" | "sponsorship" | "commission" | "ownership" | "nft_edition" | "revenue_distribution";
export type PaymentState = "reserved" | "captured" | "failed" | "refundable" | "settled";
export type OwnershipTermStatus = "proposed" | "not_implemented" | "settled" | "rejected";

export interface RevenueAllocation {
  recipient_id: string;
  role: "creator" | "platform" | "commission" | "owner" | "sponsor";
  basis_points: number;
}

export interface OwnershipTerms {
  subject_type: "post" | "realization" | "nft_edition";
  subject_id: string;
  rights: "license" | "ownership";
  status: OwnershipTermStatus;
}

export interface NftEditionTerms {
  edition_id: string;
  edition_number?: number;
  supply?: number;
  chain?: string;
  mint_address?: string;
}

export interface QuoteRecord {
  quote_id: string;
  /** Provider-issued identifier retained server-side when the public quote is scoped to one prompt. */
  provider_quote_id?: string;
  post_id: string;
  requester_id: string;
  /** Private generation brief. Never returned by public quote or realization views. */
  generation_description?: string;
  commission_request_id?: string;
  style: "cinematic" | "portrait" | "documentary" | "ambient";
  duration_seconds: number;
  amount_usdc_atomic: string;
  currency: "USDC";
  expires_at: string;
  provider_id: string;
  payment_reference?: string;
  mock: boolean;
  status: "issued" | "consumed" | "expired";
  created_at: string;
}

export interface PaymentRecord {
  payment_id: string;
  payment_reference: string;
  purpose: EconomicPurpose;
  status: PaymentState;
  asset: "USDC";
  network: "solana" | "offchain";
  amount_usdc_atomic: string;
  payer_id: string;
  payee_id?: string;
  quote_id?: string;
  post_id?: string;
  commission_request_id?: string;
  realization_id?: string;
  transaction_signature?: string;
  usdc_mint?: string;
  destination_token_account?: string;
  source_token_account?: string;
  payment_mode: "mock" | "direct";
  revenue_allocations?: RevenueAllocation[];
  ownership_terms?: OwnershipTerms;
  nft_edition?: NftEditionTerms;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentReservationResult {
  payment: PaymentRecord;
  created: boolean;
}

export interface RealizationPaymentInput {
  payment: PaymentRecord;
  realization: RealizationRecord;
}

export interface RealizationRecord {
  realization_id: string;
  post_id: string;
  quote_id?: string;
  payment_id?: string;
  commission_request_id?: string;
  requester_id: string;
  /** Present only when the commissioner explicitly opted into public attribution. */
  public_attribution?: string;
  provider_id: string;
  status: "quoted" | "paid" | "queued" | "processing" | "delivered" | "failed" | "refundable";
  payment_status?: PaymentState;
  payment_reference: string;
  payment_mode?: "mock" | "direct";
  economic_purpose?: EconomicPurpose;
  mock: boolean;
  media_url?: string;
  media_hash?: string;
  nft_media_ids?: string[];
  created_at: string;
}

/** Private lifecycle aggregate. Public provenance is stored separately below. */
export interface RealizeResolutionAuditEvent {
  event_id: string;
  action: "generation_failed" | "generation_completed" | "manual_review_required" | "refund_approved" | "refund_submitted" | "refund_retried" | "refund_finalized" | "refund_uncertain" | "late_callback_ignored" | "no_render_failure_armed";
  actor_type: "system" | "populi" | "operator";
  actor_id: string;
  occurred_at: string;
  evidence_hash?: string;
  reason_code?: string;
}

export interface RealizeFailureEvidence {
  source: "populi_signed_webhook" | "populi_post_deadline_status" | "staging_no_render_test";
  fulfillment_request_id: string;
  observed_at: string;
  payload_hash: string;
  error_code?: string;
}

export interface RealizeNoRenderFailureArm {
  operator_human_id: string;
  armed_at: string;
  reason: string;
  payload_hash: string;
}

export interface RealizeRefundApproval {
  operator_human_id: string;
  approved_at: string;
  approval_payload_hash: string;
  approval_signature: string;
  payer_wallet: string;
  funding_signature: string;
  payment_intent_id: string;
  accepted_quote_hash: string;
  amount_usdc_atomic: string;
  reason: string;
}

export type NftChain = "solana:devnet" | "solana:mainnet-beta" | "base:sepolia" | "base:mainnet" | "monad:testnet" | "monad:mainnet" | "arbitrum:mainnet" | "ethereum:mainnet" | "hyperevm:mainnet" | "robinhood:mainnet";
export const NFT_CHAINS: readonly NftChain[] = ["solana:mainnet-beta", "base:mainnet", "monad:mainnet", "arbitrum:mainnet", "ethereum:mainnet", "hyperevm:mainnet", "robinhood:mainnet", "solana:devnet", "base:sepolia", "monad:testnet"];
export type NftMintState = "queued" | "claimable" | "signing" | "signed" | "submitted" | "finalized" | "retryable_failure" | "manual_review";

/** Immutable VOX media identity shared by every chain-specific NFT record. */
export interface NftMediaRecord {
  media_id: string;
  source_kind: "realize_commission" | "realization";
  /** Realize commission media is public only after explicit commissioner consent. */
  publication_consent?: boolean;
  source_id: string;
  output_index: number;
  source_post_id?: string;
  creator_id?: string;
  owner_id: string;
  provider_id: string;
  source_content?: string;
  request_parameters: Record<string, unknown>;
  request_hash: string;
  media_uri: string;
  media_page_url?: string;
  media_type: string;
  media_sha256: string;
  byte_length?: number;
  provenance_record_id?: string;
  metadata_uri: string;
  metadata_hash: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One independently retriable mint/claim entitlement for one media record and chain. */
export interface NftMintRecord {
  mint_id: string;
  media_id: string;
  chain: NftChain;
  owner_id: string;
  owner_wallet?: string;
  state: NftMintState;
  metadata_uri: string;
  metadata_hash: string;
  attempts: number;
  transaction_id?: string;
  token_id?: string;
  asset_address?: string;
  explorer_url?: string;
  signed_transaction?: string;
  nonce?: string;
  blockhash?: string;
  last_valid_block_height?: number;
  next_attempt_at?: string;
  last_error?: string;
  lease_owner?: string;
  lease_expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RealizeCommissionRecord {
  commission: CommissionV1;
  payout_configuration_version?: number;
  /** Optional source post retained for canonical media/NFT metadata. */
  source_post_id?: string;
  payment_intent?: PaymentIntentV1;
  payer_wallet?: string;
  escrow_funding?: EscrowFundingAuthorization;
  direct_funding?: MainnetSplUsdcFundingAuthorization;
  rights_reviewed_at?: string;
  /** Public credit is kept private until the commissioner explicitly opts in. */
  public_attribution?: string;
  /** Public Realize NFT media is created only after explicit commissioner consent. */
  nft_publication_consent?: boolean;
  nft_publication_consent_at?: string;
  /** Signature submitted by the payer, persisted before RPC verification for safe retries. */
  funding_submission_signature?: string;
  funding_signature?: string;
  funding_network_id?: string;
  funding_verified_at?: string;
  funding_block_time?: number;
  funding_timing_status?: "within_quote_window" | "after_quote_expiry" | "ambiguous_at_expiry" | "unavailable";
  funded_at?: string;
  fulfillment_request?: ProviderFulfillmentRequestV1;
  fulfillment_result?: FulfillmentResultV1;
  /** CAS-protected claim prevents a failure/refund transition racing artifact finalization. */
  fulfillment_completion_claimed?: boolean;
  fulfillment_deadline_at?: string;
  provider_poll_not_before?: string;
  settlement_instruction?: SettlementInstructionV1;
  settlement_status: "not_started" | "pending" | "partial" | "settled" | "failed";
  settlement_response?: RealizeSettlementResponseV1;
  refund_response?: RealizeRefundResponseV1;
  resolution_outcome?: "fulfilled" | "refunded" | "manual_review";
  resolution_reason?: string;
  resolution_events?: RealizeResolutionAuditEvent[];
  failure_evidence?: RealizeFailureEvidence;
  no_render_failure_armed?: RealizeNoRenderFailureArm;
  refund_approval?: RealizeRefundApproval;
  failure_reason?: string;
  provenance_record_id?: string;
  nft_media_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface RealizeWebhookDeliveryRecord {
  delivery_id: string;
  payload_hash: string;
  received_at: string;
  status: "received" | "processed";
}

export interface ReactionRecord {
  post_id: string;
  actor_id: string;
  reaction: "like";
  created_at: string;
}

export interface StoreSnapshot {
  agents: AgentRecord[];
  humans?: HumanRecord[];
  posts: StoredPost[];
  commission_requests?: CommissionRequestRecord[];
  batches: AnchorBatchRecord[];
  realizations: RealizationRecord[];
  reactions: ReactionRecord[];
  anchor_claims?: AnchorClaimRecord[];
  quotes?: QuoteRecord[];
  payments?: PaymentRecord[];
  realize_payout_configurations?: RealizeCreatorPayoutConfigurationV1[];
  realize_quotes?: RealizeQuoteV1[];
  realize_commissions?: RealizeCommissionRecord[];
  realize_payment_signature_claims?: Array<{signature: string; commission_id: string}>;
  realize_provenance?: ProvenanceRecordV1[];
  realize_webhook_deliveries?: RealizeWebhookDeliveryRecord[];
  nft_media?: NftMediaRecord[];
  nft_mints?: NftMintRecord[];
  rights_agreements?: RightsAgreementRecord[];
  rights_revenue_events?: RightsRevenueEventV1[];
  rights_allocations?: RightsRevenueAllocationV1[];
  referral_attributions?: ReferralAttributionV1[];
  distribution_rewards?: DistributionRewardV1[];
  rights_audit?: RightsAuditEventV1[];
}

export type RightsAgreementStatus = "proposed" | "active" | "terminated";

export interface RightsAgreementRecord {
  agreement: RevenueRightsAgreementV1;
  terms_hash: string;
  status: RightsAgreementStatus;
  terminated_at?: string;
  termination?: RightsAgreementTerminationV1;
  audit_history: RightsAuditEventV1[];
  created_at: string;
  updated_at: string;
}

export interface RightsRevenueEventInput {
  event: RightsRevenueEventV1;
  allocations: RightsRevenueAllocationV1[];
  rewards: DistributionRewardV1[];
  audit_events: RightsAuditEventV1[];
}

export interface RightsRevenueEventResult {
  event: RightsRevenueEventV1;
  allocations: RightsRevenueAllocationV1[];
  rewards: DistributionRewardV1[];
  created: boolean;
}

export interface PublishInput {
  signed: SignedPostV1;
  post_hash: string;
  post_id: string;
  accepted_at: string;
  instance_id: string;
  instance_public_key: string;
  instance_secret_key: Uint8Array;
}

export interface PublishResult {
  post: StoredPost;
  created: boolean;
}

export interface FeedPage {
  items: StoredPost[];
  next_cursor?: string;
}

export interface VoxStore {
  registerAgent(registration: AgentRegistrationV1): Promise<AgentRecord>;
  registerHuman(registration: HumanRegistrationV1): Promise<HumanRecord>;
  getAgent(agentId: string): Promise<AgentRecord | undefined>;
  listPopuliLivestreamAgents(limit: number): Promise<AgentRecord[]>;
  getHuman(humanId: string): Promise<HumanRecord | undefined>;
  updateAgentProfile(agentId: string, update: AgentProfileUpdateV1, profileHash: string, profile: AgentProfileRecord): Promise<AgentRecord>;
  getAgentByUsername(username: string): Promise<AgentRecord | undefined>;
  getHumanByUsername(username: string): Promise<HumanRecord | undefined>;
  createCommissionRequest(request: CommissionRequestRecord): Promise<CommissionRequestResult>;
  getCommissionRequest(requestId: string): Promise<CommissionRequestRecord | undefined>;
  listHumanCommissionRequests(humanId: string, limit: number): Promise<CommissionRequestRecord[]>;
  appendCommissionRequestEvent(requestId: string, event: CommissionRequestEvent): Promise<CommissionRequestRecord>;
  addKeyAuthorization(agentId: string, registration: AgentRegistrationV1, expectation?: KeyAuthorizationUpdateExpectation): Promise<AgentRecord>;
  publish(input: PublishInput): Promise<PublishResult>;
  getPost(postId: string): Promise<StoredPost | undefined>;
  listAgentPosts(agentId: string, limit: number, cursor?: string): Promise<FeedPage>;
  feed(limit: number, cursor?: string): Promise<FeedPage>;
  claimAnchorCandidates(input: AnchorClaimInput): Promise<AnchorClaimResponse | undefined>;
  getAnchorClaim(claimId: string): Promise<AnchorClaimResponse | undefined>;
  updateAnchorClaim(claimId: string, ownerId: string, patch: AnchorClaimPatch): Promise<AnchorClaimResponse>;
  listUncertainAnchorClaims(limit: number): Promise<AnchorClaimResponse[]>;
  saveBatch(batch: AnchorBatchRecord): Promise<void>;
  getBatchForPost(postId: string): Promise<AnchorBatchRecord | undefined>;
  listBatches(epoch: string): Promise<AnchorBatchRecord[]>;
  listAnchorCandidates(limit: number): Promise<StoredPost[]>;
  updateAnchor(postIds: string[], patch: Partial<AnchorObligation>): Promise<void>;
  createQuote(quote: QuoteRecord): Promise<QuoteRecord>;
  getQuote(quoteId: string): Promise<QuoteRecord | undefined>;
  reservePayment(payment: PaymentRecord): Promise<PaymentReservationResult>;
  getPayment(paymentReference: string): Promise<PaymentRecord | undefined>;
  createRealizationWithPayment(input: RealizationPaymentInput): Promise<RealizationRecord>;
  getRealization(realizationId: string): Promise<RealizationRecord | undefined>;
  markPaymentFailed(paymentReference: string, status: "failed" | "refundable", error: string): Promise<PaymentRecord>;
  updateRealizationNftMediaIds(realizationId: string, mediaIds: string[]): Promise<RealizationRecord>;
  createRealizePayoutConfiguration(configuration: RealizeCreatorPayoutConfigurationV1): Promise<RealizeCreatorPayoutConfigurationV1>;
  getRealizePayoutConfiguration(creatorId: string, version?: number): Promise<RealizeCreatorPayoutConfigurationV1 | undefined>;
  createRealizeQuote(quote: RealizeQuoteV1): Promise<RealizeQuoteV1>;
  getRealizeQuote(quoteId: string): Promise<RealizeQuoteV1 | undefined>;
  getRealizeQuoteByPricingRequest(pricingRequestId: string): Promise<RealizeQuoteV1 | undefined>;
  createRealizeCommission(record: RealizeCommissionRecord): Promise<RealizeCommissionRecord>;
  getRealizeCommission(commissionId: string): Promise<RealizeCommissionRecord | undefined>;
  updateRealizeCommission(record: RealizeCommissionRecord, expectedUpdatedAt: string): Promise<RealizeCommissionRecord>;
  reserveRealizePaymentSignature(signature: string, commissionId: string): Promise<boolean>;
  listRealizeCommissions(limit: number): Promise<RealizeCommissionRecord[]>;
  listRealizeCommissionsForHuman(humanId: string, limit: number): Promise<RealizeCommissionRecord[]>;
  createRealizeProvenance(record: ProvenanceRecordV1): Promise<ProvenanceRecordV1>;
  getRealizeProvenance(provenanceRecordId: string): Promise<ProvenanceRecordV1 | undefined>;
  createNftMedia(record: NftMediaRecord): Promise<NftMediaRecord>;
  getNftMedia(mediaId: string): Promise<NftMediaRecord | undefined>;
  createNftMint(record: NftMintRecord): Promise<NftMintRecord>;
  getNftMint(mintId: string): Promise<NftMintRecord | undefined>;
  listNftMintsForMedia(mediaId: string): Promise<NftMintRecord[]>;
  listNftMintsForProcessing(limit: number, now?: string): Promise<NftMintRecord[]>;
  claimNftMint(mintId: string, ownerId: string, leaseSeconds: number): Promise<NftMintRecord | undefined>;
  updateNftMint(record: NftMintRecord, expectedUpdatedAt: string): Promise<NftMintRecord>;
  createRealizeWebhookDelivery(delivery: RealizeWebhookDeliveryRecord): Promise<{delivery: RealizeWebhookDeliveryRecord; created: boolean; conflict: boolean}>;
  getRealizeWebhookDelivery(deliveryId: string): Promise<RealizeWebhookDeliveryRecord | undefined>;
  markRealizeWebhookDeliveryProcessed(deliveryId: string, payloadHash: string): Promise<void>;
  findRealizationByPaymentReference(paymentReference: string): Promise<RealizationRecord | undefined>;
  createRightsAgreement(record: RightsAgreementRecord): Promise<RightsAgreementRecord>;
  getRightsAgreement(agreementId: string, version?: number): Promise<RightsAgreementRecord | undefined>;
  listRightsAgreements(): Promise<RightsAgreementRecord[]>;
  acceptRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord>;
  terminateRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord>;
  createReferralAttribution(attribution: ReferralAttributionV1, auditEvent: RightsAuditEventV1): Promise<ReferralAttributionV1>;
  listReferralAttributions(): Promise<ReferralAttributionV1[]>;
  recordRightsRevenueEvent(input: RightsRevenueEventInput): Promise<RightsRevenueEventResult>;
  updateRightsLedgerStatus(entryId: string, status: RightsRevenueAllocationV1["payment_status"], updatedAt: string, auditEvent: RightsAuditEventV1): Promise<RightsRevenueAllocationV1 | DistributionRewardV1>;
  listRightsRevenueEvents(): Promise<RightsRevenueEventV1[]>;
  listRightsRevenueAllocations(): Promise<RightsRevenueAllocationV1[]>;
  listDistributionRewards(): Promise<DistributionRewardV1[]>;
  listRightsAudit(agreementId?: string): Promise<RightsAuditEventV1[]>;
  react(postId: string, actorId: string, reaction: "like"): Promise<{post_id: string; reaction: "like"; count: number; reacted: boolean}>;
  search(query: string, limit: number): Promise<{agents: AgentRecord[]; posts: StoredPost[]}>;
  snapshot(): Promise<StoreSnapshot>;
}

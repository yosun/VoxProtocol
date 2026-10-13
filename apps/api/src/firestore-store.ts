import {FieldValue, Firestore} from "@google-cloud/firestore";
import {canTransitionRealizeCommission, canonicalBytes, journalEnvelopeHashHex, journalSigningPayload, signBytes, type AgentProfileUpdateV1, type AgentRegistrationV1, type AnchorObligation, type HumanRegistrationV1, type JournalEnvelopeUnsignedV1} from "@vox/protocol";
import {createHash, randomUUID} from "node:crypto";
import {AsyncMutex} from "./mutex.js";
import {appendOnlyKeyAuthorizationRecords, type KeyAuthorizationUpdateExpectation} from "./key-history.js";
import type {AgentProfileRecord, AgentRecord, AnchorBatchRecord, AnchorClaimInput, AnchorClaimPatch, AnchorClaimRecord, AnchorClaimResponse, AnchorClaimState, CommissionRequestEvent, CommissionRequestRecord, CommissionRequestResult, FeedPage, HumanRecord, AnchorClaimKind, AnchorClaimTier, PaymentRecord, PaymentReservationResult, PublishInput, PublishResult, QuoteRecord, ReactionRecord, RealizationPaymentInput, RealizationRecord, RealizeCommissionRecord, RealizeWebhookDeliveryRecord, RightsAgreementRecord, RightsRevenueEventInput, RightsRevenueEventResult, StoreSnapshot, StoredPost, NftMediaRecord, NftMintRecord, VoxStore} from "./types.js";
import type {ProvenanceRecordV1, RealizeQuoteV1} from "@vox/protocol";
import type {DistributionRewardV1, ReferralAttributionV1, RightsAuditEventV1, RightsRevenueAllocationV1, RightsRevenueEventV1} from "@vox/protocol";
import type {RealizeCreatorPayoutConfigurationV1} from "./realize-engine.js";
import {UsernameConflict} from "./errors.js";
import {nextClaimState, registrationUsername, registrationWithoutUsername} from "./store.js";

interface FirestoreStoreOptions {
  projectId?: string;
  databaseId?: string;
}

function idempotencyId(agentId: string, clientPostId: string): string {
  return Buffer.from(`${agentId}\0${clientPostId}`).toString("base64url");
}

function commissionRequestIdempotencyId(humanId: string, clientRequestId: string): string {
  return Buffer.from(`${humanId}\0${clientRequestId}`).toString("base64url");
}

function lockId(kind: string, postId: string): string {
  return Buffer.from(`${kind}\0${postId}`).toString("base64url");
}

function paymentDocId(paymentReference: string): string {
  return Buffer.from(paymentReference).toString("base64url");
}

function rightsScopesOverlap(left: RightsAgreementRecord["agreement"]["artifact_scope"], right: RightsAgreementRecord["agreement"]["artifact_scope"]): boolean {
  return left.subject_type === right.subject_type && left.subject_id === right.subject_id && (!left.artifact_sha256 || !right.artifact_sha256 || left.artifact_sha256 === right.artifact_sha256);
}

function batchIdFor(input: AnchorClaimInput, posts: StoredPost[]): string {
  return `vox.blog:${input.kind.toLowerCase()}:${input.epoch}:${posts[0]!.post_id}:${posts.at(-1)!.post_id}`;
}

function leaseActive(claim: AnchorClaimRecord, nowMs: number): boolean {
  return !!claim.lease_expires_at && Date.parse(claim.lease_expires_at) > nowMs;
}

function claimTerminal(state: AnchorClaimState): boolean {
  return state === "submitted" || state === "finalized";
}

function claimRecoverable(claim: AnchorClaimRecord, nowMs: number): boolean {
  if (claim.state === "submitting" || claim.state === "uncertain" || claimTerminal(claim.state)) return false;
  if (claim.next_attempt_at && Date.parse(claim.next_attempt_at) > nowMs) return false;
  return !leaseActive(claim, nowMs);
}

function statusForClaim(state: AnchorClaimState): AnchorObligation["status"] {
  switch (state) {
    case "claimed": return "claimed";
    case "manifested": return "queued";
    case "submitting": return "submitting";
    case "uncertain": return "uncertain";
    case "submitted": return "submitted";
    case "finalized": return "finalized";
    case "retryable_failure": return "retryable_failure";
  }
}

function nftDocId(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function nftLeaseActive(record: NftMintRecord, nowMs: number): boolean {
  return !!record.lease_expires_at && Date.parse(record.lease_expires_at) > nowMs;
}

function nftProcessingCandidate(record: NftMintRecord, nowMs: number): boolean {
  if (!["queued", "signed", "submitted", "retryable_failure"].includes(record.state)) return false;
  if (record.next_attempt_at && Date.parse(record.next_attempt_at) > nowMs) return false;
  return !nftLeaseActive(record, nowMs);
}

function nftLease(record: NftMintRecord, ownerId: string, leaseSeconds: number, now: string): NftMintRecord {
  const recoverable = record.state === "queued" || record.state === "retryable_failure";
  const {next_attempt_at: _nextAttempt, last_error: _lastError, ...withoutRetry} = record;
  return {
    ...withoutRetry,
    ...(recoverable ? {} : record.next_attempt_at ? {next_attempt_at: record.next_attempt_at} : {}),
    ...(recoverable ? {} : record.last_error ? {last_error: record.last_error} : {}),
    state: recoverable ? "signing" : record.state,
    attempts: recoverable ? record.attempts + 1 : record.attempts,
    lease_owner: ownerId,
    lease_expires_at: new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString(),
    updated_at: now
  };
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

type UsernameOwner = {kind: "agent" | "human"; id: string};

function usernameOwner(data: Record<string, unknown> | undefined): UsernameOwner | undefined {
  if (!data) return undefined;
  if (data.principal_type === "human" && typeof data.principal_id === "string") return {kind: "human", id: data.principal_id};
  if (data.principal_type === "agent" && typeof data.principal_id === "string") return {kind: "agent", id: data.principal_id};
  if (typeof data.agent_id === "string") return {kind: "agent", id: data.agent_id};
  if (typeof data.human_id === "string") return {kind: "human", id: data.human_id};
  return undefined;
}

function claimFields(claim: AnchorClaimRecord, clearLease: boolean): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "anchoring.status": statusForClaim(claim.state),
    "anchoring.claim_id": claim.claim_id,
    "anchoring.batch_id": claim.batch_id,
    "anchoring.kind": claim.kind,
    "anchoring.attempts": claim.attempts,
    ...(claim.manifest_hash ? {"anchoring.manifest_hash": claim.manifest_hash} : {}),
    ...(claim.transaction_signature ? {"anchoring.transaction_signature": claim.transaction_signature} : {}),
    ...(claim.next_attempt_at ? {"anchoring.next_attempt_at": claim.next_attempt_at} : {}),
    ...(claim.error ? {"anchoring.error": claim.error} : {})
  };
  if (claim.lease_expires_at && !clearLease) {
    fields["anchoring.lease_owner"] = claim.owner_id;
    fields["anchoring.lease_expires_at"] = claim.lease_expires_at;
  } else {
    fields["anchoring.lease_owner"] = FieldValue.delete();
    fields["anchoring.lease_expires_at"] = FieldValue.delete();
  }
  if (["claimed", "manifested", "submitting"].includes(claim.state)) {
    fields["anchoring.error"] = FieldValue.delete();
    fields["anchoring.next_attempt_at"] = FieldValue.delete();
  }
  return fields;
}

export class FirestoreStore implements VoxStore {
  private readonly db: Firestore;
  private readonly agents;
  private readonly humans;
  private readonly usernames;
  private readonly posts;
  private readonly commissionRequests;
  private readonly batches;
  private readonly realizations;
  private readonly reactions;
  private readonly idempotency;
  private readonly commissionRequestIdempotency;
  private readonly anchorClaims;
  private readonly anchorLocks;
  private readonly quotes;
  private readonly payments;
  private readonly realizePayoutConfigurations;
  private readonly realizeQuotes;
  private readonly realizePricingRequests;
  private readonly realizeCommissions;
  private readonly realizePaymentSignatures;
  private readonly realizeProvenance;
  private readonly nftMedia;
  private readonly nftMints;
  private readonly realizeWebhookDeliveries;
  private readonly rightsAgreements;
  private readonly rightsRevenueEvents;
  private readonly rightsRevenueTransactions;
  private readonly rightsAllocations;
  private readonly referralAttributions;
  private readonly distributionRewards;
  private readonly rightsAudit;
  private readonly localMutex = new AsyncMutex();

  constructor(options: FirestoreStoreOptions = {}) {
    this.db = new Firestore({...(options.projectId ? {projectId: options.projectId} : {}), ...(options.databaseId ? {databaseId: options.databaseId} : {})});
    this.agents = this.db.collection("vox_agents");
    this.humans = this.db.collection("vox_humans");
    this.usernames = this.db.collection("vox_usernames");
    this.posts = this.db.collection("vox_posts");
    this.commissionRequests = this.db.collection("vox_commission_requests");
    this.batches = this.db.collection("vox_batches");
    this.realizations = this.db.collection("vox_realizations");
    this.reactions = this.db.collection("vox_reactions");
    this.idempotency = this.db.collection("vox_post_idempotency");
    this.commissionRequestIdempotency = this.db.collection("vox_commission_request_idempotency");
    this.anchorClaims = this.db.collection("vox_anchor_claims");
    this.anchorLocks = this.db.collection("vox_anchor_locks");
    this.quotes = this.db.collection("vox_quotes");
    this.payments = this.db.collection("vox_payments");
    this.realizePayoutConfigurations = this.db.collection("vox_realize_payout_configurations");
    this.realizeQuotes = this.db.collection("vox_realize_quotes");
    this.realizePricingRequests = this.db.collection("vox_realize_pricing_requests");
    this.realizeCommissions = this.db.collection("vox_realize_commissions");
    this.realizePaymentSignatures = this.db.collection("vox_realize_payment_signatures");
    this.realizeProvenance = this.db.collection("vox_realize_public_provenance");
    this.nftMedia = this.db.collection("vox_nft_media");
    this.nftMints = this.db.collection("vox_nft_mints");
    this.realizeWebhookDeliveries = this.db.collection("vox_realize_webhook_deliveries");
    this.rightsAgreements = this.db.collection("vox_rights_agreements");
    this.rightsRevenueEvents = this.db.collection("vox_rights_revenue_events");
    this.rightsRevenueTransactions = this.db.collection("vox_rights_revenue_transaction_ids");
    this.rightsAllocations = this.db.collection("vox_rights_allocations");
    this.referralAttributions = this.db.collection("vox_referral_attributions");
    this.distributionRewards = this.db.collection("vox_distribution_rewards");
    this.rightsAudit = this.db.collection("vox_rights_audit");
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }

  async registerAgent(registration: AgentRegistrationV1): Promise<AgentRecord> {
    const username = registrationUsername(registration);
    const ref = this.agents.doc(registration.agent_id);
    const usernameRef = username ? this.usernames.doc(username) : undefined;
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const usernameSnapshot = usernameRef ? await transaction.get(usernameRef) : undefined;
      if (snapshot.exists) {
        const existing = snapshot.data() as AgentRecord;
        if (JSON.stringify(existing.registration) === JSON.stringify(registration)) {
          if (username && !usernameSnapshot?.exists) transaction.create(usernameRef!, {username, principal_type: "agent", principal_id: registration.agent_id, agent_id: registration.agent_id, created_at: existing.created_at});
          const owner = usernameOwner(usernameSnapshot?.data() as Record<string, unknown> | undefined);
          if (owner && (owner.kind !== "agent" || owner.id !== registration.agent_id)) throw new UsernameConflict(username!);
          return existing;
        }
        if (!existing.registration.username && username && canonicalEqual(registrationWithoutUsername(existing.registration), registrationWithoutUsername(registration))) {
          const owner = usernameOwner(usernameSnapshot?.data() as Record<string, unknown> | undefined);
          if (owner && (owner.kind !== "agent" || owner.id !== registration.agent_id)) throw new UsernameConflict(username!);
          const updated: AgentRecord = {...existing, registration, updated_at: new Date().toISOString()};
          transaction.set(ref, updated);
          if (!usernameSnapshot?.exists) transaction.create(usernameRef!, {username, principal_type: "agent", principal_id: registration.agent_id, agent_id: registration.agent_id, created_at: existing.created_at});
          return updated;
        }
        throw new Error("Agent id is already registered with different metadata");
      }
      if (usernameSnapshot?.exists) throw new UsernameConflict(username!);
      const now = new Date().toISOString();
      const record: AgentRecord = {registration, created_at: now, updated_at: now, last_sequence: 0, last_event_hash: null};
      transaction.create(ref, record);
      if (usernameRef) transaction.create(usernameRef, {username, principal_type: "agent", principal_id: registration.agent_id, agent_id: registration.agent_id, created_at: now});
      return record;
    });
  }

  async getAgent(agentId: string): Promise<AgentRecord | undefined> {
    const snapshot = await this.agents.doc(agentId).get();
    return snapshot.exists ? snapshot.data() as AgentRecord : undefined;
  }

  async listPopuliLivestreamAgents(limit: number): Promise<AgentRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 10);
    const snapshot = await this.agents
      .where("profile.livestream.provider", "==", "populi")
      .get();
    return snapshot.docs
      .map((document) => document.data() as AgentRecord)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, boundedLimit);
  }

  async updateAgentProfile(agentId: string, update: AgentProfileUpdateV1, profileHash: string, profile: AgentProfileRecord): Promise<AgentRecord> {
    const ref = this.agents.doc(agentId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Agent not found");
      const current = snapshot.data() as AgentRecord;
      if (current.profile?.profile_hash === profileHash) return current;
      const currentVersion = current.profile?.profile_version ?? 0;
      const currentHash = current.profile?.profile_hash ?? null;
      if (update.profile_version !== currentVersion + 1 || update.previous_profile_hash !== currentHash) {
        throw new Error("profile version conflict");
      }
      const updated: AgentRecord = {...current, profile, updated_at: profile.updated_at};
      transaction.update(ref, {profile, updated_at: profile.updated_at});
      return updated;
    });
  }

  async getAgentByUsername(username: string): Promise<AgentRecord | undefined> {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(normalized)) return undefined;
    const usernameSnapshot = await this.usernames.doc(normalized).get();
    if (!usernameSnapshot.exists) return undefined;
    const owner = usernameOwner(usernameSnapshot.data() as Record<string, unknown>);
    return owner?.kind === "agent" ? this.getAgent(owner.id) : undefined;
  }

  async registerHuman(registration: HumanRegistrationV1): Promise<HumanRecord> {
    const username = registration.username;
    const ref = this.humans.doc(registration.human_id);
    const usernameRef = username ? this.usernames.doc(username) : undefined;
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const usernameSnapshot = usernameRef ? await transaction.get(usernameRef) : undefined;
      if (snapshot.exists) {
        const existing = snapshot.data() as HumanRecord;
        if (canonicalEqual(existing.registration, registration)) return existing;
        throw new Error("Human id is already registered with different metadata");
      }
      if (usernameSnapshot?.exists) throw new UsernameConflict(username!);
      const now = new Date().toISOString();
      const record: HumanRecord = {registration, created_at: now, updated_at: now};
      transaction.create(ref, record);
      if (usernameRef) transaction.create(usernameRef, {username, principal_type: "human", principal_id: registration.human_id, human_id: registration.human_id, created_at: now});
      return record;
    });
  }

  async getHuman(humanId: string): Promise<HumanRecord | undefined> {
    const snapshot = await this.humans.doc(humanId).get();
    return snapshot.exists ? snapshot.data() as HumanRecord : undefined;
  }

  async getHumanByUsername(username: string): Promise<HumanRecord | undefined> {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(normalized)) return undefined;
    const usernameSnapshot = await this.usernames.doc(normalized).get();
    if (!usernameSnapshot.exists) return undefined;
    const owner = usernameOwner(usernameSnapshot.data() as Record<string, unknown>);
    return owner?.kind === "human" ? this.getHuman(owner.id) : undefined;
  }

  async addKeyAuthorization(agentId: string, registration: AgentRegistrationV1, expectation?: KeyAuthorizationUpdateExpectation): Promise<AgentRecord> {
    const ref = this.agents.doc(agentId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Agent not found");
      const current = snapshot.data() as AgentRecord;
      const appended = appendOnlyKeyAuthorizationRecords(current.registration, registration, expectation);
      if (appended.length === 0) return current;
      const updated: AgentRecord = {
        ...current,
        registration: {...current.registration, publisher_keys: [...current.registration.publisher_keys, ...appended], root_signature: registration.root_signature},
        updated_at: new Date().toISOString()
      };
      transaction.set(ref, updated);
      return updated;
    });
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    return this.localMutex.runExclusive(async () => this.db.runTransaction(async (transaction) => {
      const agentRef = this.agents.doc(input.signed.intent.agent_id);
      const postRef = this.posts.doc(input.post_id);
      const idemRef = this.idempotency.doc(idempotencyId(input.signed.intent.agent_id, input.signed.intent.client_post_id));
      const agentSnapshot = await transaction.get(agentRef);
      const postSnapshot = await transaction.get(postRef);
      const idemSnapshot = await transaction.get(idemRef);
      if (!agentSnapshot.exists) throw new Error("Agent not found");
      if (postSnapshot.exists) {
        const existing = postSnapshot.data() as StoredPost;
        if (existing.signature !== input.signed.signature || existing.post_hash !== input.post_hash) throw new Error("Post id conflicts with existing content");
        return {post: existing, created: false};
      }
      if (idemSnapshot.exists) {
        const existingPostId = (idemSnapshot.data() as {post_id: string}).post_id;
        const existingPost = await transaction.get(this.posts.doc(existingPostId));
        if (existingPost.exists) return {post: existingPost.data() as StoredPost, created: false};
        throw new Error("idempotency record points to missing post");
      }
      const agent = agentSnapshot.data() as AgentRecord;
      const sequence = agent.last_sequence + 1;
      const unsigned: JournalEnvelopeUnsignedV1 = {
        protocol: "vox/1",
        envelope_version: 1,
        post_id: input.post_id,
        agent_id: input.signed.intent.agent_id,
        publisher_instance_id: input.instance_id,
        accepted_at: input.accepted_at,
        sequence,
        previous_event_hash: agent.last_event_hash,
        post_hash: input.post_hash
      };
      const envelopeHash = journalEnvelopeHashHex(unsigned);
      const envelope = {...unsigned, instance_public_key: input.instance_public_key, instance_signature: signBytes(journalSigningPayload(unsigned), input.instance_secret_key)};
      const anchoring: AnchorObligation = {post_id: input.post_id, authority_id: "vox:anchor:vox.blog", tier: agent.registration.anchoring_tier, status: "unanchored", attempts: 0};
      const post: StoredPost = {post_id: input.post_id, intent: input.signed.intent, signature: input.signed.signature, post_hash: input.post_hash, envelope, envelope_hash: envelopeHash, accepted_at: input.accepted_at, publication_status: "published", anchoring};
      transaction.create(postRef, post);
      transaction.create(idemRef, {post_id: input.post_id, created_at: input.accepted_at});
      transaction.update(agentRef, {last_sequence: sequence, last_event_hash: envelopeHash, updated_at: input.accepted_at});
      return {post, created: true};
    }));
  }

  async getPost(postId: string): Promise<StoredPost | undefined> {
    const snapshot = await this.posts.doc(postId).get();
    return snapshot.exists ? snapshot.data() as StoredPost : undefined;
  }

  private async page(query: FirebaseFirestore.Query, limit: number, cursor?: string): Promise<FeedPage> {
    let paged = query.orderBy("accepted_at", "desc").orderBy("post_id", "desc").limit(limit + 1);
    if (cursor) {
      const [acceptedAt, postId] = cursor.split("|");
      if (acceptedAt && postId) paged = query.orderBy("accepted_at", "desc").orderBy("post_id", "desc").startAfter(acceptedAt, postId).limit(limit + 1);
    }
    const snapshot = await paged.get();
    const items = snapshot.docs.slice(0, limit).map((doc) => doc.data() as StoredPost);
    const last = items.at(-1);
    return last && snapshot.docs.length > limit ? {items, next_cursor: `${last.accepted_at}|${last.post_id}`} : {items};
  }

  async listAgentPosts(agentId: string, limit: number, cursor?: string): Promise<FeedPage> {
    return this.page(this.posts.where("intent.agent_id", "==", agentId).where("publication_status", "==", "published"), limit, cursor);
  }

  async feed(limit: number, cursor?: string): Promise<FeedPage> {
    return this.page(this.posts.where("publication_status", "==", "published"), limit, cursor);
  }

  private async claimResponse(claim: AnchorClaimRecord): Promise<AnchorClaimResponse> {
    const [posts, batchSnapshot] = await Promise.all([
      Promise.all(claim.post_ids.map(async (postId) => {
        const snapshot = await this.posts.doc(postId).get();
        return snapshot.exists ? snapshot.data() as StoredPost : undefined;
      })),
      this.batches.doc(claim.batch_id).get()
    ]);
    const batch = batchSnapshot.exists ? batchSnapshot.data() as AnchorBatchRecord : undefined;
    return {claim, posts: posts.filter((post): post is StoredPost => !!post), ...(batch ? {batch} : {})};
  }

  async claimAnchorCandidates(input: AnchorClaimInput): Promise<AnchorClaimResponse | undefined> {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const leaseSeconds = Math.min(Math.max(Math.floor(input.lease_seconds), 30), 15 * 60);
    const leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
    const newClaimId = randomUUID();
    const claimedId = await this.db.runTransaction(async (transaction) => {
      const queryLimit = Math.min(Math.max(input.limit * 5, 100), 1000);
      const snapshot = await transaction.get(this.posts.orderBy("accepted_at", "asc").limit(queryLimit));
      const candidateDocs = snapshot.docs
        .map((doc) => ({ref: doc.ref, post: doc.data() as StoredPost}))
        .filter(({post}) => post.publication_status === "published" && (input.tier === "all" || post.anchoring.tier === input.tier));
      const lockSnapshots = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      const claimSnapshots = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      for (const {post} of candidateDocs) {
        const lockSnapshot = await transaction.get(this.anchorLocks.doc(lockId(input.kind, post.post_id)));
        lockSnapshots.set(post.post_id, lockSnapshot);
        if (lockSnapshot.exists) {
          const lock = lockSnapshot.data() as {claim_id: string};
          if (!claimSnapshots.has(lock.claim_id)) claimSnapshots.set(lock.claim_id, await transaction.get(this.anchorClaims.doc(lock.claim_id)));
        }
      }

      const recover = async (claim: AnchorClaimRecord): Promise<string> => {
        const next: AnchorClaimRecord = {
          ...claim,
          owner_id: input.owner_id,
          lease_expires_at: leaseExpiresAt,
          updated_at: nowIso,
          ...(claim.state === "retryable_failure" ? {state: "claimed" as const} : {})
        };
        const postSnapshots = await Promise.all(claim.post_ids.map((postId) => transaction.get(this.posts.doc(postId))));
        transaction.set(this.anchorClaims.doc(claim.claim_id), next);
        for (const postId of claim.post_ids) {
          transaction.set(this.anchorLocks.doc(lockId(claim.kind, postId)), {claim_id: claim.claim_id, batch_id: claim.batch_id, kind: claim.kind, owner_id: next.owner_id, lease_expires_at: leaseExpiresAt, updated_at: nowIso});
          const postSnapshot = postSnapshots.find((candidate) => candidate.id === postId);
          if (postSnapshot?.exists) transaction.update(postSnapshot.ref, claimFields(next, false) as any);
        }
        return claim.claim_id;
      };

      for (const {post} of candidateDocs) {
        const lockSnapshot = lockSnapshots.get(post.post_id);
        if (!lockSnapshot?.exists) continue;
        const lock = lockSnapshot.data() as {claim_id: string};
        const claimSnapshot = claimSnapshots.get(lock.claim_id);
        if (!claimSnapshot?.exists) continue;
        const claim = claimSnapshot.data() as AnchorClaimRecord;
        if (claimTerminal(claim.state)) continue;
        if (leaseActive(claim, nowMs) && claim.owner_id === input.owner_id) return recover(claim);
        if (claimRecoverable(claim, nowMs)) return recover(claim);
      }

      const selected = [] as Array<{ref: FirebaseFirestore.DocumentReference; post: StoredPost}>;
      for (const candidate of candidateDocs) {
        const lockSnapshot = lockSnapshots.get(candidate.post.post_id);
        if (lockSnapshot?.exists) continue;
        if (candidate.post.anchoring.kind === input.kind && candidate.post.anchoring.status === "finalized") continue;
        selected.push(candidate);
        if (selected.length >= Math.min(Math.max(input.limit, 1), input.kind === "POST" ? 1 : 200)) break;
      }
      if (selected.length === 0) return undefined;
      const claim: AnchorClaimRecord = {
        claim_id: newClaimId,
        batch_id: batchIdFor(input, selected.map(({post}) => post)),
        kind: input.kind,
        authority_id: input.authority_id,
        epoch: input.epoch,
        tier: input.tier,
        owner_id: input.owner_id,
        post_ids: selected.map(({post}) => post.post_id),
        state: "claimed",
        manifest_created_at: nowIso,
        lease_expires_at: leaseExpiresAt,
        attempts: 0,
        created_at: nowIso,
        updated_at: nowIso
      };
      transaction.create(this.anchorClaims.doc(claim.claim_id), claim);
      for (const {ref, post} of selected) {
        transaction.create(this.anchorLocks.doc(lockId(input.kind, post.post_id)), {claim_id: claim.claim_id, batch_id: claim.batch_id, kind: input.kind, owner_id: input.owner_id, lease_expires_at: leaseExpiresAt, updated_at: nowIso});
        transaction.update(ref, claimFields(claim, false) as any);
      }
      return claim.claim_id;
    });
    if (!claimedId) return undefined;
    return this.getAnchorClaim(claimedId);
  }

  async getAnchorClaim(claimId: string): Promise<AnchorClaimResponse | undefined> {
    const snapshot = await this.anchorClaims.doc(claimId).get();
    if (!snapshot.exists) return undefined;
    return this.claimResponse(snapshot.data() as AnchorClaimRecord);
  }

  async updateAnchorClaim(claimId: string, ownerId: string, patch: AnchorClaimPatch): Promise<AnchorClaimResponse> {
    const updated = await this.db.runTransaction(async (transaction) => {
      const claimRef = this.anchorClaims.doc(claimId);
      const claimSnapshot = await transaction.get(claimRef);
      if (!claimSnapshot.exists) throw new Error("Anchor claim not found");
      const claim = claimSnapshot.data() as AnchorClaimRecord;
      const batchSnapshot = await transaction.get(this.batches.doc(claim.batch_id));
      const postSnapshots = await Promise.all(claim.post_ids.map((postId) => transaction.get(this.posts.doc(postId))));
      const now = new Date();
      if (claim.state === "uncertain" && claim.owner_id !== ownerId) claim.owner_id = ownerId;
      if (claim.owner_id !== ownerId && claim.state !== "uncertain") throw new Error("Anchor claim is owned by another worker");
      if (claim.owner_id === ownerId && claim.state !== "uncertain" && claim.lease_expires_at && Date.parse(claim.lease_expires_at) <= now.getTime()) throw new Error("Anchor claim lease has expired");
      if (patch.manifest && patch.manifest.batch_id !== claim.batch_id) throw new Error("Anchor manifest does not match claim");
      const requestedState: AnchorClaimState = patch.receipt ? (patch.receipt.finalized ? "finalized" : "submitted") : patch.state ?? (patch.manifest ? "manifested" : claim.state);
      if (!nextClaimState(claim.state, requestedState)) throw new Error(`Invalid anchor claim transition: ${claim.state} to ${requestedState}`);
      const existingBatch = batchSnapshot.exists ? batchSnapshot.data() as AnchorBatchRecord : undefined;
      if (existingBatch && patch.manifest && !canonicalEqual(existingBatch.manifest, patch.manifest)) throw new Error("anchor manifest is immutable");
      const manifest = existingBatch?.manifest ?? patch.manifest;
      if (patch.receipt && !manifest) throw new Error("Anchor receipt requires an immutable manifest");
      if (existingBatch?.receipt && patch.receipt && existingBatch.receipt.transaction_signature !== patch.receipt.transaction_signature) throw new Error("anchor receipt conflicts with existing transaction");
      const next: AnchorClaimRecord = {...claim, state: requestedState, updated_at: now.toISOString()};
      if (requestedState === "submitting") next.attempts += 1;
      if (patch.transaction_signature) next.transaction_signature = patch.transaction_signature;
      if (patch.receipt) next.transaction_signature = patch.receipt.transaction_signature;
      if (patch.manifest) next.manifest_hash = patch.manifest.manifest_hash;
      if (patch.next_attempt_at) next.next_attempt_at = patch.next_attempt_at;
      if (patch.error) next.error = patch.error;
      if (patch.lease_seconds !== undefined) next.lease_expires_at = new Date(now.getTime() + Math.min(Math.max(Math.floor(patch.lease_seconds), 30), 15 * 60) * 1000).toISOString();
      if (patch.clear_lease || ["uncertain", "submitted", "finalized", "retryable_failure"].includes(requestedState)) delete next.lease_expires_at;
      if (manifest) {
        const receipt = existingBatch?.receipt && (!patch.receipt || existingBatch.receipt.finalized) ? existingBatch.receipt : patch.receipt ?? existingBatch?.receipt;
        const savedBatch: AnchorBatchRecord = {manifest, claim_id: claim.claim_id, kind: claim.kind, state: requestedState, ...(patch.manifest_uri ? {manifest_uri: patch.manifest_uri} : existingBatch?.manifest_uri ? {manifest_uri: existingBatch.manifest_uri} : {}), ...(receipt ? {receipt} : {})};
        transaction.set(this.batches.doc(claim.batch_id), savedBatch);
      }
      transaction.set(claimRef, next);
      for (const postSnapshot of postSnapshots) if (postSnapshot.exists) transaction.update(postSnapshot.ref, claimFields(next, !next.lease_expires_at) as any);
      for (const postId of claim.post_ids) transaction.set(this.anchorLocks.doc(lockId(claim.kind, postId)), {claim_id: claim.claim_id, batch_id: claim.batch_id, kind: claim.kind, owner_id: next.owner_id, ...(next.lease_expires_at ? {lease_expires_at: next.lease_expires_at} : {}), updated_at: next.updated_at, state: next.state});
      return next;
    });
    return this.claimResponse(updated);
  }

  async listUncertainAnchorClaims(limit: number): Promise<AnchorClaimResponse[]> {
    const snapshot = await this.anchorClaims.where("state", "in", ["uncertain", "submitted"]).limit(Math.min(Math.max(limit, 1), 200)).get();
    const claims = snapshot.docs.map((doc) => doc.data() as AnchorClaimRecord).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    return Promise.all(claims.map((claim) => this.claimResponse(claim)));
  }

  async saveBatch(batch: AnchorBatchRecord): Promise<void> {
    const merged = await this.db.runTransaction(async (transaction) => {
      const ref = this.batches.doc(batch.manifest.batch_id);
      const snapshot = await transaction.get(ref);
      const existing = snapshot.exists ? snapshot.data() as AnchorBatchRecord : undefined;
      if (existing && !canonicalEqual(existing.manifest, batch.manifest)) throw new Error("anchor manifest is immutable");
      if (existing?.receipt && batch.receipt && existing.receipt.transaction_signature !== batch.receipt.transaction_signature) throw new Error("anchor receipt conflicts with existing transaction");
      const next: AnchorBatchRecord = {
        ...(existing ?? {}),
        ...batch,
        manifest: existing?.manifest ?? batch.manifest,
        ...(existing?.receipt || batch.receipt ? {receipt: existing?.receipt ?? batch.receipt} : {})
      };
      if (existing?.receipt && batch.receipt?.finalized && !existing.receipt.finalized) next.receipt = batch.receipt;
      const data = {...next, post_ids: next.manifest.leaves.map((leaf) => leaf.post_id)};
      if (snapshot.exists) transaction.set(ref, data); else transaction.create(ref, data);
      return next;
    });
    const status = merged.receipt?.finalized ? "finalized" : merged.receipt ? "submitted" : merged.state === "uncertain" ? "uncertain" : merged.state === "submitting" ? "submitting" : merged.state === "retryable_failure" ? "retryable_failure" : "queued";
    for (let index = 0; index < merged.manifest.leaves.length; index += 400) {
      const batchWrite = this.db.batch();
      for (const leaf of merged.manifest.leaves.slice(index, index + 400)) {
        batchWrite.update(this.posts.doc(leaf.post_id), {
          "anchoring.status": status,
          ...(merged.claim_id ? {"anchoring.claim_id": merged.claim_id} : {}),
          ...(merged.kind ? {"anchoring.kind": merged.kind} : {}),
          "anchoring.batch_id": merged.manifest.batch_id,
          "anchoring.manifest_hash": merged.manifest.manifest_hash,
          ...(merged.receipt?.transaction_signature ? {"anchoring.transaction_signature": merged.receipt.transaction_signature} : {})
        });
      }
      if (merged.manifest.leaves.length) await batchWrite.commit();
    }
  }

  async getBatchForPost(postId: string): Promise<AnchorBatchRecord | undefined> {
    const snapshot = await this.batches.where("post_ids", "array-contains", postId).get();
    const records = snapshot.docs.map((doc) => doc.data() as AnchorBatchRecord);
    return records.find((record) => record.receipt) ?? records[0];
  }

  async listBatches(epoch: string): Promise<AnchorBatchRecord[]> {
    const snapshot = await this.batches.where("manifest.epoch", "==", epoch).orderBy("manifest.created_at", "desc").get();
    return snapshot.docs.map((doc) => doc.data() as AnchorBatchRecord);
  }

  async listAnchorCandidates(limit: number): Promise<StoredPost[]> {
    const snapshot = await this.posts.orderBy("accepted_at", "asc").limit(Math.min(limit * 3, 5000)).get();
    return snapshot.docs.map((doc) => doc.data() as StoredPost).filter((post) => post.anchoring.status === "unanchored" || post.anchoring.status === "queued" || post.anchoring.status === "retryable_failure").slice(0, limit);
  }

  async updateAnchor(postIds: string[], patch: Partial<AnchorObligation>): Promise<void> {
    for (let index = 0; index < postIds.length; index += 400) {
      const batch = this.db.batch();
      for (const postId of postIds.slice(index, index + 400)) {
        const fields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) fields[`anchoring.${key}`] = value;
        batch.update(this.posts.doc(postId), fields as any);
      }
      await batch.commit();
    }
  }

  async appendCommissionRequestEvent(requestId: string, event: CommissionRequestEvent): Promise<CommissionRequestRecord> {
    const ref = this.commissionRequests.doc(requestId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Commission request not found");
      const current = snapshot.data() as CommissionRequestRecord;
      if (current.events.some((candidate) => candidate.event_id === event.event_id)) return current;
      const updated: CommissionRequestRecord = {
        ...current,
        ...(event.status ? {status: event.status} : {}),
        ...(event.quote_id ? {quote_id: event.quote_id} : {}),
        ...(event.payment_id ? {payment_id: event.payment_id} : {}),
        ...(event.realization_id ? {realization_id: event.realization_id} : {}),
        events: [...current.events, event]
      };
      transaction.set(ref, updated);
      return updated;
    });
  }

  async createCommissionRequest(request: CommissionRequestRecord): Promise<CommissionRequestResult> {
    const ref = this.commissionRequests.doc(request.request_id);
    const idemRef = this.commissionRequestIdempotency.doc(commissionRequestIdempotencyId(request.intent.human_id, request.intent.client_request_id));
    return this.db.runTransaction(async (transaction) => {
      const [snapshot, idemSnapshot] = await Promise.all([transaction.get(ref), transaction.get(idemRef)]);
      if (snapshot.exists) {
        const existing = snapshot.data() as CommissionRequestRecord;
        if (existing.signature !== request.signature || !canonicalEqual(existing.intent, request.intent)) throw new Error("Commission request id conflicts with existing content");
        return {request: existing, created: false};
      }
      if (idemSnapshot.exists) {
        const existingRequestId = (idemSnapshot.data() as {request_id: string}).request_id;
        const existingSnapshot = await transaction.get(this.commissionRequests.doc(existingRequestId));
        if (existingSnapshot.exists) return {request: existingSnapshot.data() as CommissionRequestRecord, created: false};
        throw new Error("Commission request idempotency record is inconsistent");
      }
      transaction.create(ref, request);
      transaction.create(idemRef, {request_id: request.request_id, created_at: request.accepted_at});
      return {request, created: true};
    });
  }

  async getCommissionRequest(requestId: string): Promise<CommissionRequestRecord | undefined> {
    const snapshot = await this.commissionRequests.doc(requestId).get();
    return snapshot.exists ? snapshot.data() as CommissionRequestRecord : undefined;
  }

  async listHumanCommissionRequests(humanId: string, limit: number): Promise<CommissionRequestRecord[]> {
    const snapshot = await this.commissionRequests.where("intent.human_id", "==", humanId).orderBy("accepted_at", "desc").limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as CommissionRequestRecord);
  }

  async createQuote(quote: QuoteRecord): Promise<QuoteRecord> {
    const ref = this.quotes.doc(quote.quote_id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as QuoteRecord;
        if (!canonicalEqual(existing, quote)) throw new Error("Quote id conflicts with existing quote");
        return existing;
      }
      transaction.create(ref, quote);
      return quote;
    });
  }

  async getQuote(quoteId: string): Promise<QuoteRecord | undefined> {
    const snapshot = await this.quotes.doc(quoteId).get();
    return snapshot.exists ? snapshot.data() as QuoteRecord : undefined;
  }

  async reservePayment(payment: PaymentRecord): Promise<PaymentReservationResult> {
    const ref = this.payments.doc(paymentDocId(payment.payment_reference));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as PaymentRecord;
        if (existing.post_id !== payment.post_id || existing.amount_usdc_atomic !== payment.amount_usdc_atomic || existing.quote_id !== payment.quote_id) throw new Error("payment reference has already been used for a different economic record");
        return {payment: existing, created: false};
      }
      transaction.create(ref, payment);
      return {payment, created: true};
    });
  }

  async getPayment(paymentReference: string): Promise<PaymentRecord | undefined> {
    const snapshot = await this.payments.doc(paymentDocId(paymentReference)).get();
    return snapshot.exists ? snapshot.data() as PaymentRecord : undefined;
  }

  async createRealizationWithPayment(input: RealizationPaymentInput): Promise<RealizationRecord> {
    const paymentRef = this.payments.doc(paymentDocId(input.payment.payment_reference));
    const realizationRef = this.realizations.doc(input.realization.realization_id);
    const result = await this.db.runTransaction(async (transaction) => {
      const paymentSnapshot = await transaction.get(paymentRef);
      const realizationSnapshot = await transaction.get(realizationRef);
      const quoteSnapshot = input.realization.quote_id ? await transaction.get(this.quotes.doc(input.realization.quote_id)) : undefined;
      if (realizationSnapshot.exists) return realizationSnapshot.data() as RealizationRecord;
      if (!paymentSnapshot.exists) throw new Error("Payment reservation not found");
      const payment = paymentSnapshot.data() as PaymentRecord;
      if (payment.realization_id && payment.realization_id !== input.realization.realization_id) throw new Error("Payment reference is already linked to another realization");
      const updatedPayment: PaymentRecord = {...payment, ...input.payment, payment_reference: payment.payment_reference, payment_id: payment.payment_id, realization_id: input.realization.realization_id, status: "captured", updated_at: new Date().toISOString()};
      const realization = {...input.realization, payment_id: updatedPayment.payment_id, payment_status: updatedPayment.status};
      transaction.set(paymentRef, updatedPayment);
      transaction.create(realizationRef, realization);
      if (input.realization.quote_id && quoteSnapshot?.exists) transaction.update(this.quotes.doc(input.realization.quote_id), {status: "consumed"});
      return realization;
    });
    return result;
  }

  async markPaymentFailed(paymentReference: string, status: "failed" | "refundable", error: string): Promise<PaymentRecord> {
    const ref = this.payments.doc(paymentDocId(paymentReference));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Payment reservation not found");
      const updated = {...snapshot.data() as PaymentRecord, status, error, updated_at: new Date().toISOString()};
      transaction.set(ref, updated);
      return updated;
    });
  }

  async createRealization(realization: RealizationRecord): Promise<RealizationRecord> {
    const ref = this.realizations.doc(realization.realization_id);
    const existing = await ref.get();
    if (existing.exists) return existing.data() as RealizationRecord;
    await ref.create(realization);
    return realization;
  }

  async getRealization(realizationId: string): Promise<RealizationRecord | undefined> {
    const snapshot = await this.realizations.doc(realizationId).get();
    return snapshot.exists ? snapshot.data() as RealizationRecord : undefined;
  }

  async updateRealizationNftMediaIds(realizationId: string, mediaIds: string[]): Promise<RealizationRecord> {
    const ref = this.realizations.doc(realizationId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Realization not found");
      const current = snapshot.data() as RealizationRecord;
      if (current.nft_media_ids && JSON.stringify(current.nft_media_ids) !== JSON.stringify(mediaIds)) throw new Error("realization NFT media binding is immutable");
      const updated = {...current, nft_media_ids: [...mediaIds]};
      transaction.set(ref, updated);
      return updated;
    });
  }

  async createRightsAgreement(record: RightsAgreementRecord): Promise<RightsAgreementRecord> {
    const agreementKey = Buffer.from(record.agreement.agreement_id).toString("base64url");
    const versionRef = this.rightsAgreements.doc(`${agreementKey}:v${String(record.agreement.version).padStart(8, "0")}`);
    const currentRef = this.rightsAgreements.doc(`${agreementKey}:current`);
    return this.db.runTransaction(async (transaction) => {
      const [versionSnapshot, currentSnapshot] = await Promise.all([transaction.get(versionRef), transaction.get(currentRef)]);
      if (versionSnapshot.exists) {
        const existing = versionSnapshot.data() as RightsAgreementRecord;
        if (!canonicalEqual(existing, record)) throw new Error("rights agreement version conflicts with an existing record");
        return existing;
      }
      const current = currentSnapshot.exists ? currentSnapshot.data() as {version: number} : undefined;
      if (record.agreement.version !== (current?.version ?? 0) + 1) throw new Error("rights agreement versions must be consecutive");
      if (record.status !== "proposed" || record.agreement.acceptances.length !== 0) throw new Error("new rights agreement versions must begin as unaccepted proposals");
      transaction.create(versionRef, record);
      transaction.set(currentRef, {agreement_id: record.agreement.agreement_id, version: record.agreement.version, updated_at: record.updated_at});
      for (const event of record.audit_history) transaction.create(this.rightsAudit.doc(Buffer.from(event.event_id).toString("base64url")), event);
      return record;
    });
  }

  async getRightsAgreement(agreementId: string, version?: number): Promise<RightsAgreementRecord | undefined> {
    const agreementKey = Buffer.from(agreementId).toString("base64url");
    if (version !== undefined) {
      const snapshot = await this.rightsAgreements.doc(`${agreementKey}:v${String(version).padStart(8, "0")}`).get();
      return snapshot.exists ? snapshot.data() as RightsAgreementRecord : undefined;
    }
    const current = await this.rightsAgreements.doc(`${agreementKey}:current`).get();
    if (!current.exists) return undefined;
    const currentData = current.data() as {version: number};
    const snapshot = await this.rightsAgreements.doc(`${agreementKey}:v${String(currentData.version).padStart(8, "0")}`).get();
    return snapshot.exists ? snapshot.data() as RightsAgreementRecord : undefined;
  }

  async listRightsAgreements(): Promise<RightsAgreementRecord[]> {
    const snapshot = await this.rightsAgreements.get();
    return snapshot.docs.map((doc) => doc.data() as RightsAgreementRecord).filter((record) => !!record.agreement).sort((left, right) => left.agreement.agreement_id.localeCompare(right.agreement.agreement_id) || left.agreement.version - right.agreement.version);
  }

  async acceptRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord> {
    const agreementKey = Buffer.from(agreementId).toString("base64url");
    const versionRef = this.rightsAgreements.doc(`${agreementKey}:v${String(version).padStart(8, "0")}`);
    return this.db.runTransaction(async (transaction) => {
      const [currentSnapshot, allSnapshot] = await Promise.all([transaction.get(versionRef), transaction.get(this.rightsAgreements)]);
      if (!currentSnapshot.exists) throw new Error("rights agreement not found");
      const current = currentSnapshot.data() as RightsAgreementRecord;
      if (current.status !== "proposed") throw new Error("rights agreement version is no longer open for acceptance");
      if (updated.agreement.agreement_id !== agreementId || updated.agreement.version !== version || updated.terms_hash !== current.terms_hash || !canonicalEqual({...updated.agreement, acceptances: []}, {...current.agreement, acceptances: []})) throw new Error("rights agreement terms changed during acceptance");
      const acceptedPartyIds = new Set(updated.agreement.acceptances.map((acceptance) => acceptance.party_id));
      if (acceptedPartyIds.size !== updated.agreement.acceptances.length || updated.agreement.acceptances.some((acceptance) => acceptance.terms_hash !== current.terms_hash || !current.agreement.required_acceptance_party_ids.includes(acceptance.party_id))) throw new Error("rights acceptance set is invalid");
      const complete = current.agreement.required_acceptance_party_ids.every((partyId) => acceptedPartyIds.has(partyId));
      if (updated.status !== (complete ? "active" : "proposed")) throw new Error("rights agreement status does not match its acceptance set");
      if (complete) {
        const conflicts = allSnapshot.docs.map((doc) => doc.data() as RightsAgreementRecord).filter((item) => !!item.agreement && item.status === "active" && item.agreement.agreement_id !== agreementId &&
          rightsScopesOverlap(item.agreement.artifact_scope, updated.agreement.artifact_scope) &&
          item.agreement.eligible_transaction_types.some((type) => updated.agreement.eligible_transaction_types.includes(type)) &&
          Date.parse(item.agreement.duration.starts_at) < Date.parse(updated.agreement.duration.ends_at ?? "9999-12-31T23:59:59.999Z") &&
          Date.parse(updated.agreement.duration.starts_at) < Date.parse(item.agreement.duration.ends_at ?? "9999-12-31T23:59:59.999Z"));
        if (conflicts.length) throw new Error("active rights agreement conflicts with another agreement for this artifact and transaction type");
      }
      const stored = {...updated, audit_history: [...current.audit_history, auditEvent]};
      transaction.set(versionRef, stored);
      transaction.create(this.rightsAudit.doc(Buffer.from(auditEvent.event_id).toString("base64url")), auditEvent);
      if (complete && version > 1) {
        const priorDocId = `${agreementKey}:v${String(version - 1).padStart(8, "0")}`;
        const priorSnapshot = allSnapshot.docs.find((doc) => doc.id === priorDocId);
        if (priorSnapshot) {
          const prior = priorSnapshot.data() as RightsAgreementRecord;
          if (prior.status === "active") {
            const supersededEvent: RightsAuditEventV1 = {event_id: `${auditEvent.event_id}:superseded`, agreement_id: agreementId, version: version - 1, kind: "superseded", actor_id: auditEvent.actor_id, record_hash: prior.terms_hash, occurred_at: auditEvent.occurred_at, evidence_reference: auditEvent.event_id};
            transaction.set(priorSnapshot.ref, {...prior, status: "terminated", terminated_at: auditEvent.occurred_at, audit_history: [...prior.audit_history, supersededEvent], updated_at: auditEvent.occurred_at});
            transaction.create(this.rightsAudit.doc(Buffer.from(supersededEvent.event_id).toString("base64url")), supersededEvent);
          }
        }
      }
      return stored;
    });
  }

  async terminateRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord> {
    const agreementKey = Buffer.from(agreementId).toString("base64url");
    const versionRef = this.rightsAgreements.doc(`${agreementKey}:v${String(version).padStart(8, "0")}`);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(versionRef);
      if (!snapshot.exists) throw new Error("rights agreement not found");
      const current = snapshot.data() as RightsAgreementRecord;
      if (current.status === "terminated") return current;
      if (current.status !== "active" || updated.status !== "terminated" || updated.agreement.agreement_id !== agreementId || updated.agreement.version !== version || updated.terms_hash !== current.terms_hash || !canonicalEqual({...updated.agreement, acceptances: []}, {...current.agreement, acceptances: []}) || !updated.termination) throw new Error("rights agreement cannot be terminated from its current state or changed terms");
      const stored = {...updated, audit_history: [...current.audit_history, auditEvent]};
      transaction.set(versionRef, stored);
      transaction.create(this.rightsAudit.doc(Buffer.from(auditEvent.event_id).toString("base64url")), auditEvent);
      return stored;
    });
  }

  async createReferralAttribution(attribution: ReferralAttributionV1, auditEvent: RightsAuditEventV1): Promise<ReferralAttributionV1> {
    const doc = this.referralAttributions.doc(Buffer.from(attribution.attribution_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const [existingSnapshot, allSnapshot] = await Promise.all([transaction.get(doc), transaction.get(this.referralAttributions)]);
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as ReferralAttributionV1;
        if (!canonicalEqual(existing, attribution)) throw new Error("referral attribution ID conflicts with an existing record");
        return existing;
      }
      const existing = allSnapshot.docs.map((item) => item.data() as ReferralAttributionV1);
      if (existing.some((item) => item.referred_party_id === attribution.referred_party_id)) throw new Error("referred party already has a referral attribution");
      const children = new Map<string, string[]>();
      for (const item of existing) children.set(item.referrer_id, [...(children.get(item.referrer_id) ?? []), item.referred_party_id]);
      const pending = [attribution.referred_party_id];
      const visited = new Set<string>();
      while (pending.length) {
        const party = pending.pop()!;
        if (party === attribution.referrer_id) throw new Error("circular referral attribution is not allowed");
        if (visited.has(party)) continue;
        visited.add(party);
        pending.push(...(children.get(party) ?? []));
      }
      transaction.create(doc, attribution);
      transaction.create(this.rightsAudit.doc(Buffer.from(auditEvent.event_id).toString("base64url")), auditEvent);
      return attribution;
    });
  }

  async listReferralAttributions(): Promise<ReferralAttributionV1[]> {
    const snapshot = await this.referralAttributions.get();
    return snapshot.docs.map((doc) => doc.data() as ReferralAttributionV1);
  }

  async recordRightsRevenueEvent(input: RightsRevenueEventInput): Promise<RightsRevenueEventResult> {
    const eventRef = this.rightsRevenueEvents.doc(Buffer.from(input.event.event_id).toString("base64url"));
    const transactionRef = this.rightsRevenueTransactions.doc(Buffer.from(input.event.source_transaction_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const [existingSnapshot, transactionSnapshot] = await Promise.all([transaction.get(eventRef), transaction.get(transactionRef)]);
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as RightsRevenueEventV1;
        if (!canonicalEqual(existing, input.event)) throw new Error("revenue event ID conflicts with an existing record");
        const [allocations, rewards] = await Promise.all([transaction.get(this.rightsAllocations.where("event_id", "==", existing.event_id)), transaction.get(this.distributionRewards.where("event_id", "==", existing.event_id))]);
        return {event: existing, allocations: allocations.docs.map((doc) => doc.data() as RightsRevenueAllocationV1), rewards: rewards.docs.map((doc) => doc.data() as DistributionRewardV1), created: false};
      }
      if (transactionSnapshot.exists) throw new Error("source transaction has already been recorded");
      const writes = [
        ...input.allocations.map((item) => ({ref: this.rightsAllocations.doc(Buffer.from(item.allocation_id).toString("base64url")), data: item})),
        ...input.rewards.map((item) => ({ref: this.distributionRewards.doc(Buffer.from(item.reward_id).toString("base64url")), data: item}))
      ];
      const existingDocs = await Promise.all(writes.map(({ref}) => transaction.get(ref)));
      if (existingDocs.some((snapshot) => snapshot.exists)) throw new Error("rights ledger entry ID is already in use");
      transaction.create(eventRef, input.event);
      transaction.create(transactionRef, {source_transaction_id: input.event.source_transaction_id, event_id: input.event.event_id, created_at: input.event.recorded_at});
      for (const write of writes) transaction.create(write.ref, write.data);
      for (const event of input.audit_events) transaction.create(this.rightsAudit.doc(Buffer.from(event.event_id).toString("base64url")), event);
      return {event: input.event, allocations: input.allocations, rewards: input.rewards, created: true};
    });
  }

  async updateRightsLedgerStatus(entryId: string, status: RightsRevenueAllocationV1["payment_status"], updatedAt: string, auditEvent: RightsAuditEventV1): Promise<RightsRevenueAllocationV1 | DistributionRewardV1> {
    const docId = Buffer.from(entryId).toString("base64url");
    const allocationRef = this.rightsAllocations.doc(docId);
    const rewardRef = this.distributionRewards.doc(docId);
    return this.db.runTransaction(async (transaction) => {
      const [allocationSnapshot, rewardSnapshot] = await Promise.all([transaction.get(allocationRef), transaction.get(rewardRef)]);
      const isAllocation = allocationSnapshot.exists;
      const snapshot = isAllocation ? allocationSnapshot : rewardSnapshot;
      if (!snapshot.exists) throw new Error("rights ledger entry not found");
      const entry = snapshot.data() as RightsRevenueAllocationV1 | DistributionRewardV1;
      const allowed: Record<RightsRevenueAllocationV1["payment_status"], RightsRevenueAllocationV1["payment_status"][]> = {pending: ["pending", "processing", "paid", "failed", "reversed"], processing: ["processing", "paid", "failed", "reversed"], paid: ["paid", "reversed"], failed: ["failed", "processing", "reversed"], reversed: ["reversed"]};
      if (!allowed[entry.payment_status].includes(status)) throw new Error("invalid rights ledger payment status transition");
      const updated = {...entry, payment_status: status, updated_at: updatedAt};
      transaction.set(isAllocation ? allocationRef : rewardRef, updated);
      transaction.create(this.rightsAudit.doc(Buffer.from(auditEvent.event_id).toString("base64url")), auditEvent);
      return updated as RightsRevenueAllocationV1 | DistributionRewardV1;
    });
  }

  async listRightsRevenueEvents(): Promise<RightsRevenueEventV1[]> { const snapshot = await this.rightsRevenueEvents.get(); return snapshot.docs.map((doc) => doc.data() as RightsRevenueEventV1); }
  async listRightsRevenueAllocations(): Promise<RightsRevenueAllocationV1[]> { const snapshot = await this.rightsAllocations.get(); return snapshot.docs.map((doc) => doc.data() as RightsRevenueAllocationV1); }
  async listDistributionRewards(): Promise<DistributionRewardV1[]> { const snapshot = await this.distributionRewards.get(); return snapshot.docs.map((doc) => doc.data() as DistributionRewardV1); }
  async listRightsAudit(agreementId?: string): Promise<RightsAuditEventV1[]> {
    const snapshot = await this.rightsAudit.get();
    return snapshot.docs.map((doc) => doc.data() as RightsAuditEventV1).filter((event) => agreementId === undefined || event.agreement_id === agreementId).sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
  }

  async createRealizePayoutConfiguration(configuration: RealizeCreatorPayoutConfigurationV1): Promise<RealizeCreatorPayoutConfigurationV1> {
    const creatorKey = Buffer.from(configuration.creator_id).toString("base64url");
    const currentRef = this.realizePayoutConfigurations.doc(`${creatorKey}:current`);
    const versionRef = this.realizePayoutConfigurations.doc(`${creatorKey}:v${String(configuration.version).padStart(8, "0")}`);
    return this.db.runTransaction(async (transaction) => {
      const currentSnapshot = await transaction.get(currentRef);
      const versionSnapshot = await transaction.get(versionRef);
      const current = currentSnapshot.exists ? currentSnapshot.data() as {version: number} : undefined;
      if (versionSnapshot.exists) {
        const existing = versionSnapshot.data() as RealizeCreatorPayoutConfigurationV1;
        if (!canonicalEqual(existing, configuration)) throw new Error("payout configuration version conflicts with immutable content");
        return existing;
      }
      if (configuration.version !== (current?.version ?? 0) + 1) throw new Error("payout configuration version must advance by exactly one");
      transaction.create(versionRef, configuration);
      transaction.set(currentRef, {creator_id: configuration.creator_id, version: configuration.version, updated_at: new Date().toISOString()});
      return configuration;
    });
  }

  async getRealizePayoutConfiguration(creatorId: string, version?: number): Promise<RealizeCreatorPayoutConfigurationV1 | undefined> {
    const creatorKey = Buffer.from(creatorId).toString("base64url");
    if (version !== undefined) {
      const snapshot = await this.realizePayoutConfigurations.doc(`${creatorKey}:v${String(version).padStart(8, "0")}`).get();
      return snapshot.exists ? snapshot.data() as RealizeCreatorPayoutConfigurationV1 : undefined;
    }
    const current = await this.realizePayoutConfigurations.doc(`${creatorKey}:current`).get();
    const currentData = current.exists ? current.data() as {version: number} : undefined;
    if (!currentData) return undefined;
    const snapshot = await this.realizePayoutConfigurations.doc(`${creatorKey}:v${String(currentData.version).padStart(8, "0")}`).get();
    return snapshot.exists ? snapshot.data() as RealizeCreatorPayoutConfigurationV1 : undefined;
  }

  async createRealizeQuote(quote: RealizeQuoteV1): Promise<RealizeQuoteV1> {
    const quoteRef = this.realizeQuotes.doc(Buffer.from(quote.quote_id).toString("base64url"));
    const pricingRef = this.realizePricingRequests.doc(Buffer.from(quote.pricing_request_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const [quoteSnapshot, pricingSnapshot] = await Promise.all([transaction.get(quoteRef), transaction.get(pricingRef)]);
      if (quoteSnapshot.exists) {
        const existing = quoteSnapshot.data() as RealizeQuoteV1;
        if (!canonicalEqual(existing, quote)) throw new Error("Realize quote id conflicts with immutable quote content");
        return existing;
      }
      if (pricingSnapshot.exists) {
        const existingId = (pricingSnapshot.data() as {quote_id: string}).quote_id;
        const existingSnapshot = await transaction.get(this.realizeQuotes.doc(Buffer.from(existingId).toString("base64url")));
        if (!existingSnapshot.exists) throw new Error("Realize pricing request index is inconsistent");
        const existing = existingSnapshot.data() as RealizeQuoteV1;
        if (!canonicalEqual(existing, quote)) throw new Error("pricing request id already issued a different quote");
        return existing;
      }
      transaction.create(quoteRef, quote);
      transaction.create(pricingRef, {pricing_request_id: quote.pricing_request_id, quote_id: quote.quote_id, created_at: quote.issued_at});
      return quote;
    });
  }

  async getRealizeQuote(quoteId: string): Promise<RealizeQuoteV1 | undefined> {
    const snapshot = await this.realizeQuotes.doc(Buffer.from(quoteId).toString("base64url")).get();
    return snapshot.exists ? snapshot.data() as RealizeQuoteV1 : undefined;
  }

  async getRealizeQuoteByPricingRequest(pricingRequestId: string): Promise<RealizeQuoteV1 | undefined> {
    const pricing = await this.realizePricingRequests.doc(Buffer.from(pricingRequestId).toString("base64url")).get();
    if (!pricing.exists) return undefined;
    const quoteId = (pricing.data() as {quote_id: string}).quote_id;
    return this.getRealizeQuote(quoteId);
  }

  async createRealizeCommission(record: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
    const ref = this.realizeCommissions.doc(Buffer.from(record.commission.commission_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as RealizeCommissionRecord;
        if (!canonicalEqual(existing.commission, record.commission)) throw new Error("Realize commission id conflicts with existing content");
        return existing;
      }
      transaction.create(ref, record);
      return record;
    });
  }

  async getRealizeCommission(commissionId: string): Promise<RealizeCommissionRecord | undefined> {
    const snapshot = await this.realizeCommissions.doc(Buffer.from(commissionId).toString("base64url")).get();
    return snapshot.exists ? snapshot.data() as RealizeCommissionRecord : undefined;
  }

  async updateRealizeCommission(record: RealizeCommissionRecord, expectedUpdatedAt: string): Promise<RealizeCommissionRecord> {
    const ref = this.realizeCommissions.doc(Buffer.from(record.commission.commission_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Realize commission not found");
      const current = snapshot.data() as RealizeCommissionRecord;
      if (current.updated_at !== expectedUpdatedAt) throw new Error("Realize commission changed concurrently");
      if (current.commission.commissioner_id !== record.commission.commissioner_id || current.commission.creator_id !== record.commission.creator_id || current.commission.capability_id !== record.commission.capability_id || current.source_post_id !== record.source_post_id || !canonicalEqual(current.commission.requested_generation_parameters, record.commission.requested_generation_parameters) || current.commission.rights_agreement_reference !== record.commission.rights_agreement_reference) throw new Error("immutable Realize commission terms cannot be changed");
      if (current.nft_media_ids && JSON.stringify(current.nft_media_ids) !== JSON.stringify(record.nft_media_ids)) throw new Error("Realize NFT media binding is immutable");
      if (current.commission.quote_id && current.commission.quote_id !== record.commission.quote_id) throw new Error("commission quote id is immutable after issuance");
      if (current.commission.accepted_quote_hash && current.commission.accepted_quote_hash !== record.commission.accepted_quote_hash) throw new Error("accepted quote hash is immutable");
      if (current.commission.state !== record.commission.state && !canTransitionRealizeCommission(current.commission.state, record.commission.state)) throw new Error("invalid Realize commission state transition");
      const priorEvents = current.resolution_events ?? [];
      const nextEvents = record.resolution_events ?? [];
      if (nextEvents.length < priorEvents.length || priorEvents.some((event, index) => !canonicalEqual(event, nextEvents[index]))) throw new Error("Realize resolution audit history is append-only");
      if (current.refund_approval && !canonicalEqual(current.refund_approval, record.refund_approval)) throw new Error("Realize refund approval is immutable");
      if (current.failure_evidence && !canonicalEqual(current.failure_evidence, record.failure_evidence)) throw new Error("confirmed Realize failure evidence is immutable");
      if (current.no_render_failure_armed && !canonicalEqual(current.no_render_failure_armed, record.no_render_failure_armed)) throw new Error("staging no-render failure arm is immutable");
      if (current.resolution_outcome === "refunded" && record.resolution_outcome !== "refunded" || current.resolution_outcome === "fulfilled" && record.resolution_outcome !== "fulfilled") throw new Error("final Realize resolution outcome is immutable");
      if (current.resolution_outcome === "manual_review" && record.resolution_outcome !== "manual_review") {
        const requiredAction = record.resolution_outcome === "fulfilled" ? "generation_completed" : record.resolution_outcome === "refunded" ? "refund_finalized" : undefined;
        if (!requiredAction || nextEvents.slice(priorEvents.length).every((event) => event.action !== requiredAction)) throw new Error("manual review resolution requires a matching audit event");
      }
      if (record.resolution_outcome === "fulfilled" && (!["COMPLETED", "SETTLED"].includes(record.commission.state) || !nextEvents.some((event) => event.action === "generation_completed"))) throw new Error("fulfilled outcome requires completed generation and its audit event");
      if (record.resolution_outcome === "refunded" && (record.commission.state !== "REFUNDED" || !nextEvents.some((event) => event.action === "refund_finalized"))) throw new Error("refunded outcome requires finalized refund and its audit event");
      if (record.resolution_outcome === "manual_review" && (!["MANUAL_REVIEW", "REFUND_PENDING"].includes(record.commission.state) || !nextEvents.some((event) => event.action === "manual_review_required"))) throw new Error("manual-review outcome requires its review state and audit event");
      transaction.set(ref, record);
      return record;
    });
  }

  async reserveRealizePaymentSignature(signature: string, commissionId: string): Promise<boolean> {
    const ref = this.realizePaymentSignatures.doc(createHash("sha256").update(signature).digest("hex"));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return (snapshot.data() as {commission_id?: string}).commission_id === commissionId;
      transaction.create(ref, {signature, commission_id: commissionId, created_at: new Date().toISOString()});
      return true;
    });
  }

  async listRealizeCommissions(limit: number): Promise<RealizeCommissionRecord[]> {
    const snapshot = await this.realizeCommissions.where("commission.state", "in", ["DRAFT", "QUOTED", "AWAITING_PAYMENT", "FUNDED", "GENERATING", "COMPLETED", "FAILED", "REFUND_PENDING", "MANUAL_REVIEW"]).get();
    return snapshot.docs.map((doc) => doc.data() as RealizeCommissionRecord).sort((left, right) => left.updated_at.localeCompare(right.updated_at)).slice(0, limit);
  }

  async listRealizeCommissionsForHuman(humanId: string, limit: number): Promise<RealizeCommissionRecord[]> {
    const snapshot = await this.realizeCommissions.where("commission.commissioner_id", "==", humanId).orderBy("updated_at", "desc").limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as RealizeCommissionRecord);
  }

  async createRealizeProvenance(record: ProvenanceRecordV1): Promise<ProvenanceRecordV1> {
    const ref = this.realizeProvenance.doc(Buffer.from(record.provenance_record_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as ProvenanceRecordV1;
        if (!canonicalEqual(existing, record)) throw new Error("provenance record id conflicts with immutable content");
        return existing;
      }
      transaction.create(ref, record);
      return record;
    });
  }

  async getRealizeProvenance(provenanceRecordId: string): Promise<ProvenanceRecordV1 | undefined> {
    const snapshot = await this.realizeProvenance.doc(Buffer.from(provenanceRecordId).toString("base64url")).get();
    return snapshot.exists ? snapshot.data() as ProvenanceRecordV1 : undefined;
  }

  async createNftMedia(record: NftMediaRecord): Promise<NftMediaRecord> {
    const ref = this.nftMedia.doc(nftDocId(record.media_id));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as NftMediaRecord;
        if (existing.source_kind !== record.source_kind || existing.source_id !== record.source_id || existing.output_index !== record.output_index || existing.owner_id !== record.owner_id || existing.media_uri !== record.media_uri || existing.media_sha256 !== record.media_sha256 || existing.metadata_uri !== record.metadata_uri || existing.metadata_hash !== record.metadata_hash) throw new Error("NFT media ID conflicts with immutable content");
        return existing;
      }
      transaction.create(ref, record);
      return record;
    });
  }

  async claimNftChain(chain: import("./types.js").NftChain, ownerId: string, leaseSeconds: number): Promise<boolean> {
    const ref = this.db.collection("vox_nft_chain_leases").doc(nftDocId(chain));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.data() as {expires_at?: string} | undefined;
      if (current?.expires_at && Date.parse(current.expires_at) > Date.now()) return false;
      transaction.set(ref, {owner: ownerId, expires_at: new Date(Date.now() + leaseSeconds * 1000).toISOString()});
      return true;
    });
  }

  async releaseNftChain(chain: import("./types.js").NftChain, ownerId: string): Promise<void> {
    const ref = this.db.collection("vox_nft_chain_leases").doc(nftDocId(chain));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.data()?.owner === ownerId) transaction.delete(ref);
    });
  }

  async getNftMedia(mediaId: string): Promise<NftMediaRecord | undefined> {
    const snapshot = await this.nftMedia.doc(nftDocId(mediaId)).get();
    return snapshot.exists ? snapshot.data() as NftMediaRecord : undefined;
  }

  async createNftMint(record: NftMintRecord): Promise<NftMintRecord> {
    const ref = this.nftMints.doc(nftDocId(record.mint_id));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as NftMintRecord;
        if (existing.media_id !== record.media_id || existing.chain !== record.chain || existing.owner_id !== record.owner_id || existing.metadata_uri !== record.metadata_uri || existing.metadata_hash !== record.metadata_hash) throw new Error("NFT mint ID conflicts with immutable entitlement content");
        return existing;
      }
      transaction.create(ref, record);
      return record;
    });
  }

  async getNftMint(mintId: string): Promise<NftMintRecord | undefined> {
    const snapshot = await this.nftMints.doc(nftDocId(mintId)).get();
    return snapshot.exists ? snapshot.data() as NftMintRecord : undefined;
  }

  async listNftMintsForMedia(mediaId: string): Promise<NftMintRecord[]> {
    const snapshot = await this.nftMints.where("media_id", "==", mediaId).get();
    return snapshot.docs.map((doc) => doc.data() as NftMintRecord).sort((left, right) => left.chain.localeCompare(right.chain));
  }

  async listNftMintsForProcessing(limit: number, now = new Date().toISOString()): Promise<NftMintRecord[]> {
    const snapshot = await this.nftMints.where("state", "in", ["queued", "signing", "signed", "submitted", "retryable_failure"]).limit(Math.min(Math.max(limit * 4, 1), 400)).get();
    const nowMs = Date.parse(now);
    return snapshot.docs.map((doc) => doc.data() as NftMintRecord).filter((record) => nftProcessingCandidate(record, nowMs)).sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.mint_id.localeCompare(right.mint_id)).slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async claimNftMint(mintId: string, ownerId: string, leaseSeconds: number): Promise<NftMintRecord | undefined> {
    const ref = this.nftMints.doc(nftDocId(mintId));
    const updated = await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return undefined;
      const current = snapshot.data() as NftMintRecord;
      const nowMs = Date.now();
      if (!["queued", "signing", "signed", "submitted", "retryable_failure"].includes(current.state) || current.next_attempt_at && Date.parse(current.next_attempt_at) > nowMs || current.lease_owner && current.lease_owner !== ownerId && nftLeaseActive(current, nowMs)) return undefined;
      const next = nftLease(current, ownerId, leaseSeconds, new Date().toISOString());
      transaction.set(ref, next);
      return next;
    });
    return updated;
  }

  async updateNftMint(record: NftMintRecord, expectedUpdatedAt: string): Promise<NftMintRecord> {
    const ref = this.nftMints.doc(nftDocId(record.mint_id));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("NFT mint not found");
      const current = snapshot.data() as NftMintRecord;
      if (current.updated_at !== expectedUpdatedAt) throw new Error("NFT mint changed concurrently");
      if (current.media_id !== record.media_id || current.chain !== record.chain || current.owner_id !== record.owner_id || current.metadata_uri !== record.metadata_uri || current.metadata_hash !== record.metadata_hash) throw new Error("immutable NFT mint terms changed");
      if (current.owner_wallet && current.owner_wallet.toLowerCase() !== record.owner_wallet?.toLowerCase()) throw new Error("NFT owner wallet binding is immutable");
      if (current.state === "finalized" && record.state !== "finalized") throw new Error("finalized NFT state is immutable");
      transaction.set(ref, record);
      return record;
    });
  }

  async createRealizeWebhookDelivery(delivery: RealizeWebhookDeliveryRecord): Promise<{delivery: RealizeWebhookDeliveryRecord; created: boolean; conflict: boolean}> {
    const ref = this.realizeWebhookDeliveries.doc(Buffer.from(delivery.delivery_id).toString("base64url"));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const existing = snapshot.data() as RealizeWebhookDeliveryRecord;
        return {delivery: existing, created: false, conflict: existing.payload_hash !== delivery.payload_hash};
      }
      transaction.create(ref, delivery);
      return {delivery, created: true, conflict: false};
    });
  }

  async getRealizeWebhookDelivery(deliveryId: string): Promise<RealizeWebhookDeliveryRecord | undefined> {
    const snapshot = await this.realizeWebhookDeliveries.doc(Buffer.from(deliveryId).toString("base64url")).get();
    return snapshot.exists ? snapshot.data() as RealizeWebhookDeliveryRecord : undefined;
  }

  async markRealizeWebhookDeliveryProcessed(deliveryId: string, payloadHash: string): Promise<void> {
    const ref = this.realizeWebhookDeliveries.doc(Buffer.from(deliveryId).toString("base64url"));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Realize webhook delivery not found");
      const existing = snapshot.data() as RealizeWebhookDeliveryRecord;
      if (existing.payload_hash !== payloadHash) throw new Error("Realize webhook delivery conflicts with its stored payload");
      if (existing.status === "processed") return;
      transaction.update(ref, {status: "processed"});
    });
  }

  async findRealizationByPaymentReference(paymentReference: string): Promise<RealizationRecord | undefined> {
    const snapshot = await this.realizations.where("payment_reference", "==", paymentReference).limit(1).get();
    return snapshot.empty ? undefined : snapshot.docs[0]!.data() as RealizationRecord;
  }

  async react(postId: string, actorId: string, reaction: "like"): Promise<{post_id: string; reaction: "like"; count: number; reacted: boolean}> {
    const key = Buffer.from(`${postId}\0${actorId}\0${reaction}`).toString("base64url");
    const ref = this.reactions.doc(key);
    const existing = await ref.get();
    if (!existing.exists) await ref.create({post_id: postId, actor_id: actorId, reaction, created_at: new Date().toISOString()} satisfies ReactionRecord);
    const countSnapshot = await this.reactions.where("post_id", "==", postId).where("reaction", "==", reaction).get();
    return {post_id: postId, reaction, count: countSnapshot.size, reacted: true};
  }

  async search(query: string, limit: number): Promise<{agents: AgentRecord[]; posts: StoredPost[]}> {
    const needle = query.trim().toLowerCase();
    if (!needle) return {agents: [], posts: []};
    const [agentSnapshot, postSnapshot] = await Promise.all([
      this.agents.limit(Math.min(limit * 10, 1000)).get(),
      this.posts.where("publication_status", "==", "published").orderBy("accepted_at", "desc").orderBy("post_id", "desc").limit(Math.min(limit * 20, 2000)).get()
    ]);
    const agents = agentSnapshot.docs.map((doc) => doc.data() as AgentRecord).filter((agent) => [agent.registration.display_name, agent.registration.username ?? "", agent.registration.handle, agent.registration.description, agent.registration.agent_id].some((value) => value.toLowerCase().includes(needle))).slice(0, limit);
    const posts = postSnapshot.docs.map((doc) => doc.data() as StoredPost).filter((post) => [post.intent.content.text, post.intent.agent_id].some((value) => value.toLowerCase().includes(needle))).slice(0, limit);
    return {agents, posts};
  }

  async snapshot(): Promise<StoreSnapshot> {
    const [agents, humans, posts, commissionRequests, batches, realizations, reactions, anchorClaims, quotes, payments, realizePayoutConfigurations, realizeQuotes, realizeCommissions, realizePaymentSignatures, realizeProvenance, realizeWebhookDeliveries, nftMedia, nftMints, rightsAgreements, rightsRevenueEvents, rightsAllocations, referralAttributions, distributionRewards, rightsAudit] = await Promise.all([this.agents.get(), this.humans.get(), this.posts.get(), this.commissionRequests.get(), this.batches.get(), this.realizations.get(), this.reactions.get(), this.anchorClaims.get(), this.quotes.get(), this.payments.get(), this.realizePayoutConfigurations.get(), this.realizeQuotes.get(), this.realizeCommissions.get(), this.realizePaymentSignatures.get(), this.realizeProvenance.get(), this.realizeWebhookDeliveries.get(), this.nftMedia.get(), this.nftMints.get(), this.rightsAgreements.get(), this.rightsRevenueEvents.get(), this.rightsAllocations.get(), this.referralAttributions.get(), this.distributionRewards.get(), this.rightsAudit.get()]);
    return {
      agents: agents.docs.map((doc) => doc.data() as AgentRecord),
      humans: humans.docs.map((doc) => doc.data() as HumanRecord),
      posts: posts.docs.map((doc) => doc.data() as StoredPost),
      commission_requests: commissionRequests.docs.map((doc) => doc.data() as CommissionRequestRecord),
      batches: batches.docs.map((doc) => doc.data() as AnchorBatchRecord),
      realizations: realizations.docs.map((doc) => doc.data() as RealizationRecord),
      reactions: reactions.docs.map((doc) => doc.data() as ReactionRecord),
      anchor_claims: anchorClaims.docs.map((doc) => doc.data() as AnchorClaimRecord),
      quotes: quotes.docs.map((doc) => doc.data() as QuoteRecord),
      payments: payments.docs.map((doc) => doc.data() as PaymentRecord),
      realize_payout_configurations: realizePayoutConfigurations.docs.filter((doc) => !doc.id.endsWith(":current")).map((doc) => doc.data() as RealizeCreatorPayoutConfigurationV1),
      realize_quotes: realizeQuotes.docs.map((doc) => doc.data() as RealizeQuoteV1),
      realize_commissions: realizeCommissions.docs.map((doc) => doc.data() as RealizeCommissionRecord),
      realize_payment_signature_claims: realizePaymentSignatures.docs.map((doc) => ({signature: (doc.data() as {signature: string}).signature, commission_id: (doc.data() as {commission_id: string}).commission_id})),
      realize_provenance: realizeProvenance.docs.map((doc) => doc.data() as ProvenanceRecordV1),
      realize_webhook_deliveries: realizeWebhookDeliveries.docs.map((doc) => doc.data() as RealizeWebhookDeliveryRecord),
      nft_media: nftMedia.docs.map((doc) => doc.data() as NftMediaRecord),
      nft_mints: nftMints.docs.map((doc) => doc.data() as NftMintRecord),
      rights_agreements: rightsAgreements.docs.map((doc) => doc.data() as RightsAgreementRecord).filter((record) => !!record.agreement),
      rights_revenue_events: rightsRevenueEvents.docs.map((doc) => doc.data() as RightsRevenueEventV1),
      rights_allocations: rightsAllocations.docs.map((doc) => doc.data() as RightsRevenueAllocationV1),
      referral_attributions: referralAttributions.docs.map((doc) => doc.data() as ReferralAttributionV1),
      distribution_rewards: distributionRewards.docs.map((doc) => doc.data() as DistributionRewardV1),
      rights_audit: rightsAudit.docs.map((doc) => doc.data() as RightsAuditEventV1)
    };
  }
}

import {canonicalBytes, canTransitionRealizeCommission, journalEnvelopeHashHex, journalSigningPayload, signBytes, type AgentProfileUpdateV1, type AgentRegistrationV1, type AnchorObligation, type AnchorReceiptV1, type BatchManifestV1, type HumanRegistrationV1, type JournalEnvelopeUnsignedV1, type SignedPostV1} from "@vox/protocol";
import {randomUUID} from "node:crypto";
import {AsyncMutex} from "./mutex.js";
import {appendOnlyKeyAuthorizationRecords, type KeyAuthorizationUpdateExpectation} from "./key-history.js";
import type {AgentProfileRecord, AgentRecord, AnchorBatchRecord, AnchorClaimInput, AnchorClaimPatch, AnchorClaimRecord, AnchorClaimResponse, AnchorClaimState, AnchorClaimKind, AnchorClaimTier, CommissionRequestEvent, CommissionRequestRecord, CommissionRequestResult, FeedPage, HumanRecord, PaymentRecord, PaymentReservationResult, PublishInput, PublishResult, QuoteRecord, ReactionRecord, RealizationPaymentInput, RealizationRecord, RealizeCommissionRecord, RealizeWebhookDeliveryRecord, RightsAgreementRecord, RightsRevenueEventInput, RightsRevenueEventResult, StoreSnapshot, StoredPost, NftMediaRecord, NftMintRecord, VoxStore} from "./types.js";
import type {ProvenanceRecordV1, RealizeQuoteV1} from "@vox/protocol";
import type {DistributionRewardV1, ReferralAttributionV1, RightsAuditEventV1, RightsRevenueAllocationV1, RightsRevenueEventV1} from "@vox/protocol";
import type {RealizeCreatorPayoutConfigurationV1} from "./realize-engine.js";
import {UsernameConflict} from "./errors.js";
import {canonicalUsername, isReservedUsername} from "./usernames.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equalCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function rightsScopesOverlap(left: RightsAgreementRecord["agreement"]["artifact_scope"], right: RightsAgreementRecord["agreement"]["artifact_scope"]): boolean {
  return left.subject_type === right.subject_type && left.subject_id === right.subject_id && (!left.artifact_sha256 || !right.artifact_sha256 || left.artifact_sha256 === right.artifact_sha256);
}

export function registrationWithoutUsername(registration: AgentRegistrationV1): Omit<AgentRegistrationV1, "username"> {
  const {username: _username, ...withoutUsername} = registration;
  return withoutUsername;
}

export function registrationUsername(registration: AgentRegistrationV1): string | undefined {
  if (registration.username === undefined) return undefined;
  const username = canonicalUsername(registration.username);
  if (!username || username !== registration.username) throw new Error("registration username must be lowercase letters, numbers, or underscores and be at most 15 characters");
  if (isReservedUsername(username)) throw new UsernameConflict(username, `username "${username}" is reserved`);
  return username;
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

export function nextClaimState(current: AnchorClaimState, requested: AnchorClaimState): boolean {
  const allowed: Record<AnchorClaimState, AnchorClaimState[]> = {
    claimed: ["claimed", "manifested", "retryable_failure"],
    manifested: ["manifested", "submitting", "retryable_failure"],
    submitting: ["submitting", "uncertain", "submitted", "finalized", "retryable_failure"],
    uncertain: ["uncertain", "submitted", "finalized", "retryable_failure"],
    submitted: ["submitted", "finalized", "uncertain", "retryable_failure"],
    finalized: ["finalized"],
    retryable_failure: ["retryable_failure", "claimed", "manifested"]
  };
  return allowed[current].includes(requested);
}

const PROCESSING_STATES = new Set<NftMintRecord["state"]>(["queued", "signing", "signed", "submitted", "retryable_failure"]);

function batchIdFor(input: AnchorClaimInput, posts: StoredPost[]): string {
  const first = posts[0]!;
  const last = posts.at(-1)!;
  return `vox.blog:${input.kind.toLowerCase()}:${input.epoch}:${first.post_id}:${last.post_id}`;
}

type UsernameOwner = {kind: "agent" | "human"; id: string};

function nftLeaseActive(record: NftMintRecord, nowMs: number): boolean {
  return !!record.lease_expires_at && Date.parse(record.lease_expires_at) > nowMs;
}

function nftProcessingCandidate(record: NftMintRecord, nowMs: number): boolean {
  if (!["queued", "signing", "signed", "submitted", "retryable_failure"].includes(record.state)) return false;
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

export class MemoryStore implements VoxStore {
  protected readonly agents = new Map<string, AgentRecord>();
  protected readonly humans = new Map<string, HumanRecord>();
  protected readonly usernames = new Map<string, UsernameOwner>();
  protected readonly posts = new Map<string, StoredPost>();
  protected readonly commissionRequests = new Map<string, CommissionRequestRecord>();
  protected readonly batches = new Map<string, AnchorBatchRecord>();
  protected readonly anchorClaims = new Map<string, AnchorClaimRecord>();
  protected readonly quotes = new Map<string, QuoteRecord>();
  protected readonly payments = new Map<string, PaymentRecord>();
  protected readonly realizations = new Map<string, RealizationRecord>();
  protected readonly reactions = new Map<string, ReactionRecord>();
  protected readonly realizePayoutConfigurations = new Map<string, Map<number, RealizeCreatorPayoutConfigurationV1>>();
  protected readonly realizeQuotes = new Map<string, RealizeQuoteV1>();
  protected readonly realizeCommissions = new Map<string, RealizeCommissionRecord>();
  protected readonly realizePaymentSignatures = new Map<string, string>();
  protected readonly realizeProvenance = new Map<string, ProvenanceRecordV1>();
  protected readonly nftMedia = new Map<string, NftMediaRecord>();
  protected readonly nftMints = new Map<string, NftMintRecord>();
  protected readonly realizeWebhookDeliveries = new Map<string, RealizeWebhookDeliveryRecord>();
  protected readonly rightsAgreements = new Map<string, RightsAgreementRecord>();
  protected readonly rightsRevenueEvents = new Map<string, RightsRevenueEventV1>();
  protected readonly rightsAllocations = new Map<string, RightsRevenueAllocationV1>();
  protected readonly referralAttributions = new Map<string, ReferralAttributionV1>();
  protected readonly distributionRewards = new Map<string, DistributionRewardV1>();
  protected readonly rightsAudit = new Map<string, RightsAuditEventV1>();
  protected readonly mutex = new AsyncMutex();

  async registerAgent(registration: AgentRegistrationV1): Promise<AgentRecord> {
    const username = registrationUsername(registration);
    return this.mutex.runExclusive(async () => {
      const existing = this.agents.get(registration.agent_id);
      if (existing) {
        if (JSON.stringify(existing.registration) === JSON.stringify(registration)) return clone(existing);
        if (!existing.registration.username && username && equalCanonical(registrationWithoutUsername(existing.registration), registrationWithoutUsername(registration))) {
          const owner = this.usernames.get(username);
          if (owner && (owner.kind !== "agent" || owner.id !== registration.agent_id)) throw new UsernameConflict(username);
          const updated: AgentRecord = {...existing, registration: clone(registration), updated_at: new Date().toISOString()};
          this.agents.set(registration.agent_id, updated);
          this.usernames.set(username, {kind: "agent", id: registration.agent_id});
          await this.afterMutation();
          return clone(updated);
        }
        throw new Error("Agent id is already registered with different metadata");
      }
      if (username) {
        const owner = this.usernames.get(username);
        if (owner && (owner.kind !== "agent" || owner.id !== registration.agent_id)) throw new UsernameConflict(username);
      }
      const now = new Date().toISOString();
      const record: AgentRecord = {registration: clone(registration), created_at: now, updated_at: now, last_sequence: 0, last_event_hash: null};
      this.agents.set(registration.agent_id, record);
      if (username) this.usernames.set(username, {kind: "agent", id: registration.agent_id});
      await this.afterMutation();
      return clone(record);
    });
  }

  async getAgent(agentId: string): Promise<AgentRecord | undefined> {
    return clone(this.agents.get(agentId));
  }

  async listPopuliLivestreamAgents(limit: number): Promise<AgentRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 10);
    return [...this.agents.values()]
      .filter((agent) => agent.profile?.livestream?.provider === "populi")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, boundedLimit)
      .map(clone);
  }

  async updateAgentProfile(agentId: string, update: AgentProfileUpdateV1, profileHash: string, profile: AgentProfileRecord): Promise<AgentRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.agents.get(agentId);
      if (!current) throw new Error("Agent not found");
      if (current.profile?.profile_hash === profileHash) return clone(current);
      const currentVersion = current.profile?.profile_version ?? 0;
      const currentHash = current.profile?.profile_hash ?? null;
      if (update.profile_version !== currentVersion + 1 || update.previous_profile_hash !== currentHash) {
        throw new Error("profile version conflict");
      }
      const updated: AgentRecord = {...current, profile: clone(profile), updated_at: profile.updated_at};
      this.agents.set(agentId, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async getAgentByUsername(username: string): Promise<AgentRecord | undefined> {
    const normalized = canonicalUsername(username);
    if (!normalized) return undefined;
    const owner = this.usernames.get(normalized);
    return owner?.kind === "agent" ? clone(this.agents.get(owner.id)) : undefined;
  }

  async registerHuman(registration: HumanRegistrationV1): Promise<HumanRecord> {
    const username = registration.username === undefined ? undefined : canonicalUsername(registration.username);
    if (registration.username !== undefined && (!username || username !== registration.username || isReservedUsername(username))) throw new UsernameConflict(registration.username);
    return this.mutex.runExclusive(async () => {
      const existing = this.humans.get(registration.human_id);
      if (existing) {
        if (equalCanonical(existing.registration, registration)) return clone(existing);
        throw new Error("Human id is already registered with different metadata");
      }
      if (username) {
        const owner = this.usernames.get(username);
        if (owner) throw new UsernameConflict(username);
      }
      const now = new Date().toISOString();
      const record: HumanRecord = {registration: clone(registration), created_at: now, updated_at: now};
      this.humans.set(registration.human_id, record);
      if (username) this.usernames.set(username, {kind: "human", id: registration.human_id});
      await this.afterMutation();
      return clone(record);
    });
  }

  async getHuman(humanId: string): Promise<HumanRecord | undefined> {
    return clone(this.humans.get(humanId));
  }

  async getHumanByUsername(username: string): Promise<HumanRecord | undefined> {
    const normalized = canonicalUsername(username);
    if (!normalized) return undefined;
    const owner = this.usernames.get(normalized);
    return owner?.kind === "human" ? clone(this.humans.get(owner.id)) : undefined;
  }

  async addKeyAuthorization(agentId: string, registration: AgentRegistrationV1, expectation?: KeyAuthorizationUpdateExpectation): Promise<AgentRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.agents.get(agentId);
      if (!current) throw new Error("Agent not found");
      const appended = appendOnlyKeyAuthorizationRecords(current.registration, registration, expectation);
      if (appended.length === 0) return clone(current);
      const updated: AgentRecord = {
        ...current,
        registration: clone({...current.registration, publisher_keys: [...current.registration.publisher_keys, ...appended], root_signature: registration.root_signature}),
        updated_at: new Date().toISOString()
      };
      this.agents.set(agentId, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    return this.mutex.runExclusive(async () => {
      const agent = this.agents.get(input.signed.intent.agent_id);
      if (!agent) throw new Error("Agent not found");
      const existing = this.posts.get(input.post_id);
      if (existing) {
        if (existing.signature !== input.signed.signature || existing.post_hash !== input.post_hash) throw new Error("Post id conflicts with existing content");
        return {post: clone(existing), created: false};
      }
      for (const candidate of this.posts.values()) {
        if (candidate.intent.agent_id === input.signed.intent.agent_id && candidate.intent.client_post_id === input.signed.intent.client_post_id) {
          throw new Error("client_post_id has already been used for a different post");
        }
      }
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
      const envelope = {
        ...unsigned,
        instance_public_key: input.instance_public_key,
        instance_signature: signBytes(journalSigningPayload(unsigned), input.instance_secret_key)
      };
      const anchoring: AnchorObligation = {
        post_id: input.post_id,
        authority_id: "vox:anchor:vox.blog",
        tier: agent.registration.anchoring_tier,
        status: "unanchored",
        attempts: 0
      };
      const post: StoredPost = {
        post_id: input.post_id,
        intent: clone(input.signed.intent),
        signature: input.signed.signature,
        post_hash: input.post_hash,
        envelope,
        envelope_hash: envelopeHash,
        accepted_at: input.accepted_at,
        publication_status: "published",
        anchoring
      };
      this.posts.set(post.post_id, post);
      agent.last_sequence = sequence;
      agent.last_event_hash = envelopeHash;
      agent.updated_at = input.accepted_at;
      this.agents.set(agent.registration.agent_id, agent);
      await this.afterMutation();
      return {post: clone(post), created: true};
    });
  }

  async getPost(postId: string): Promise<StoredPost | undefined> {
    return clone(this.posts.get(postId));
  }

  async listAgentPosts(agentId: string, limit: number, cursor?: string): Promise<FeedPage> {
    const posts = [...this.posts.values()]
      .filter((post) => post.publication_status === "published" && post.intent.agent_id === agentId)
      .sort((left, right) => right.accepted_at.localeCompare(left.accepted_at) || right.post_id.localeCompare(left.post_id));
    return this.page(posts, limit, cursor);
  }

  async feed(limit: number, cursor?: string): Promise<FeedPage> {
    const posts = [...this.posts.values()]
      .filter((post) => post.publication_status === "published")
      .sort((left, right) => right.accepted_at.localeCompare(left.accepted_at) || right.post_id.localeCompare(left.post_id));
    return this.page(posts, limit, cursor);
  }

  private page(posts: StoredPost[], limit: number, cursor?: string): FeedPage {
    const start = cursor ? posts.findIndex((post) => post.accepted_at === cursor.split("|")[0] && post.post_id === cursor.split("|")[1]) + 1 : 0;
    const safeStart = start < 0 ? 0 : start;
    const page = posts.slice(safeStart, safeStart + limit);
    const last = page.at(-1);
    return last && safeStart + page.length < posts.length
      ? {items: clone(page), next_cursor: `${last.accepted_at}|${last.post_id}`}
      : {items: clone(page)};
  }

  private claimResponse(claim: AnchorClaimRecord): AnchorClaimResponse {
    const posts = claim.post_ids.map((postId) => this.posts.get(postId)).filter((post): post is StoredPost => !!post).map(clone);
    const batch = this.batches.get(claim.batch_id);
    return {claim: clone(claim), posts, ...(batch ? {batch: clone(batch)} : {})};
  }

  private setPostClaimState(post: StoredPost, claim: AnchorClaimRecord, clearLease = false): void {
    const anchoring = {
      ...post.anchoring,
      status: statusForClaim(claim.state),
      claim_id: claim.claim_id,
      batch_id: claim.batch_id,
      kind: claim.kind,
      attempts: claim.attempts,
      ...(claim.manifest_hash ? {manifest_hash: claim.manifest_hash} : {}),
      ...(claim.transaction_signature ? {transaction_signature: claim.transaction_signature} : {}),
      ...(claim.next_attempt_at ? {next_attempt_at: claim.next_attempt_at} : {}),
      ...(claim.error ? {error: claim.error} : {})
    } as StoredPost["anchoring"];
    if (claim.lease_expires_at && !clearLease) {
      anchoring.lease_owner = claim.owner_id;
      anchoring.lease_expires_at = claim.lease_expires_at;
    } else {
      delete anchoring.lease_owner;
      delete anchoring.lease_expires_at;
    }
    if (claim.state === "claimed" || claim.state === "manifested" || claim.state === "submitting") {
      delete anchoring.error;
      delete anchoring.next_attempt_at;
    }
    post.anchoring = anchoring;
  }

  private saveBatchUnlocked(batch: AnchorBatchRecord): void {
    const existing = this.batches.get(batch.manifest.batch_id);
    if (existing && !equalCanonical(existing.manifest, batch.manifest)) throw new Error("anchor manifest is immutable");
    if (existing?.receipt && batch.receipt && existing.receipt.transaction_signature !== batch.receipt.transaction_signature) {
      throw new Error("anchor receipt conflicts with existing transaction");
    }
    const merged: AnchorBatchRecord = {
      ...(existing ?? {}),
      ...batch,
      manifest: existing?.manifest ?? clone(batch.manifest),
      ...(existing?.receipt || batch.receipt ? {receipt: existing?.receipt ?? batch.receipt} : {})
    };
    if (existing?.receipt && batch.receipt?.finalized && !existing.receipt.finalized) merged.receipt = clone(batch.receipt);
    this.batches.set(batch.manifest.batch_id, clone(merged));
    const postIds = new Set(batch.manifest.leaves.map((leaf) => leaf.post_id));
    for (const post of this.posts.values()) {
      if (!postIds.has(post.post_id)) continue;
      const claim = batch.claim_id ? this.anchorClaims.get(batch.claim_id) : undefined;
      const status: AnchorClaimState = merged.receipt?.finalized ? "finalized" : merged.receipt ? "submitted" : merged.state === "submitting" ? "submitting" : merged.state === "uncertain" ? "uncertain" : merged.state === "retryable_failure" ? "retryable_failure" : "manifested";
      if (claim) {
        claim.state = status;
        claim.updated_at = new Date().toISOString();
        if (merged.receipt) {
          claim.transaction_signature = merged.receipt.transaction_signature;
          claim.manifest_hash = merged.manifest.manifest_hash;
        }
        this.setPostClaimState(post, claim, status === "submitted" || status === "finalized" || status === "uncertain" || status === "retryable_failure");
      } else {
        post.anchoring = {...post.anchoring, status: statusForClaim(status), ...(merged.claim_id ? {claim_id: merged.claim_id} : {}), ...(merged.manifest.manifest_hash ? {manifest_hash: merged.manifest.manifest_hash} : {}), ...(merged.receipt?.transaction_signature ? {transaction_signature: merged.receipt.transaction_signature} : {})};
      }
    }
  }

  async claimAnchorCandidates(input: AnchorClaimInput): Promise<AnchorClaimResponse | undefined> {
    return this.mutex.runExclusive(async () => {
      const now = new Date();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();
      const leaseSeconds = Math.min(Math.max(Math.floor(input.lease_seconds), 30), 15 * 60);
      const leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
      const relatedClaims = (postId: string) => [...this.anchorClaims.values()]
        .filter((claim) => claim.kind === input.kind && claim.post_ids.includes(postId))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));

      for (const claim of [...this.anchorClaims.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at))) {
        if (claim.kind !== input.kind || claimTerminal(claim.state) || !claim.post_ids.some((postId) => this.posts.has(postId))) continue;
        if (leaseActive(claim, nowMs) && claim.owner_id === input.owner_id) {
          claim.lease_expires_at = leaseExpiresAt;
          claim.updated_at = nowIso;
          for (const postId of claim.post_ids) {
            const post = this.posts.get(postId);
            if (post) this.setPostClaimState(post, claim);
          }
          await this.afterMutation();
          return this.claimResponse(claim);
        }
        if (claimRecoverable(claim, nowMs)) {
          claim.owner_id = input.owner_id;
          claim.lease_expires_at = leaseExpiresAt;
          claim.updated_at = nowIso;
          if (claim.state === "retryable_failure") claim.state = "claimed";
          for (const postId of claim.post_ids) {
            const post = this.posts.get(postId);
            if (post) this.setPostClaimState(post, claim);
          }
          await this.afterMutation();
          return this.claimResponse(claim);
        }
      }

      const candidates = [...this.posts.values()]
        .filter((post) => post.publication_status === "published" && (input.tier === "all" || post.anchoring.tier === input.tier))
        .sort((left, right) => left.accepted_at.localeCompare(right.accepted_at) || left.post_id.localeCompare(right.post_id));
      const selected: StoredPost[] = [];
      for (const post of candidates) {
        const claims = relatedClaims(post.post_id);
        if (claims.some((claim) => leaseActive(claim, nowMs) || claim.state === "submitting" || claim.state === "uncertain" || claimTerminal(claim.state))) continue;
        if (post.anchoring.kind === input.kind && post.anchoring.status === "finalized") continue;
        selected.push(post);
        if (selected.length >= Math.min(Math.max(input.limit, 1), input.kind === "POST" ? 1 : 200)) break;
      }
      if (selected.length === 0) return undefined;

      const claim: AnchorClaimRecord = {
        claim_id: randomUUID(),
        batch_id: batchIdFor(input, selected),
        kind: input.kind,
        authority_id: input.authority_id,
        epoch: input.epoch,
        tier: input.tier,
        owner_id: input.owner_id,
        post_ids: selected.map((post) => post.post_id),
        state: "claimed",
        manifest_created_at: nowIso,
        lease_expires_at: leaseExpiresAt,
        attempts: 0,
        created_at: nowIso,
        updated_at: nowIso
      };
      this.anchorClaims.set(claim.claim_id, claim);
      for (const post of selected) this.setPostClaimState(post, claim);
      await this.afterMutation();
      return this.claimResponse(claim);
    });
  }

  async getAnchorClaim(claimId: string): Promise<AnchorClaimResponse | undefined> {
    const claim = this.anchorClaims.get(claimId);
    return claim ? this.claimResponse(claim) : undefined;
  }

  async updateAnchorClaim(claimId: string, ownerId: string, patch: AnchorClaimPatch): Promise<AnchorClaimResponse> {
    return this.mutex.runExclusive(async () => {
      const claim = this.anchorClaims.get(claimId);
      if (!claim) throw new Error("Anchor claim not found");
      const now = new Date();
      const nowIso = now.toISOString();
      const reconciledByDifferentOwner = claim.state === "uncertain" && claim.owner_id !== ownerId;
      if (reconciledByDifferentOwner) claim.owner_id = ownerId;
      if (claim.owner_id !== ownerId && claim.state !== "uncertain") throw new Error("Anchor claim is owned by another worker");
      if (claim.owner_id === ownerId && claim.state !== "uncertain" && claim.lease_expires_at && Date.parse(claim.lease_expires_at) <= now.getTime()) throw new Error("Anchor claim lease has expired");
      if (patch.manifest && patch.manifest.batch_id !== claim.batch_id) throw new Error("Anchor manifest does not match claim");
      const requestedState = patch.receipt ? (patch.receipt.finalized ? "finalized" : "submitted") : patch.state ?? claim.state;
      if (!nextClaimState(claim.state, requestedState)) throw new Error(`Invalid anchor claim transition: ${claim.state} to ${requestedState}`);
      if (patch.receipt && !this.batches.has(claim.batch_id) && !patch.manifest) throw new Error("Anchor receipt requires an immutable manifest");
      if (patch.manifest) this.saveBatchUnlocked({manifest: patch.manifest, claim_id: claim.claim_id, kind: claim.kind, state: "manifested", ...(patch.manifest_uri ? {manifest_uri: patch.manifest_uri} : {})});
      const batch = this.batches.get(claim.batch_id);
      if (patch.receipt) {
        if (!batch) throw new Error("Anchor receipt requires an immutable manifest");
        this.saveBatchUnlocked({manifest: batch.manifest, claim_id: claim.claim_id, kind: claim.kind, state: requestedState, ...(batch.manifest_uri ? {manifest_uri: batch.manifest_uri} : {}), receipt: patch.receipt});
      }
      claim.state = requestedState;
      if (requestedState === "submitting") claim.attempts += 1;
      claim.updated_at = nowIso;
      if (patch.transaction_signature) claim.transaction_signature = patch.transaction_signature;
      if (patch.receipt) claim.transaction_signature = patch.receipt.transaction_signature;
      if (patch.manifest) claim.manifest_hash = patch.manifest.manifest_hash;
      if (patch.next_attempt_at) claim.next_attempt_at = patch.next_attempt_at;
      if (patch.error) claim.error = patch.error;
      if (patch.lease_seconds !== undefined) claim.lease_expires_at = new Date(now.getTime() + Math.min(Math.max(Math.floor(patch.lease_seconds), 30), 15 * 60) * 1000).toISOString();
      if (patch.clear_lease || ["uncertain", "submitted", "finalized", "retryable_failure"].includes(requestedState)) delete claim.lease_expires_at;
      for (const postId of claim.post_ids) {
        const post = this.posts.get(postId);
        if (post) this.setPostClaimState(post, claim, !claim.lease_expires_at);
      }
      await this.afterMutation();
      return this.claimResponse(claim);
    });
  }

  async listUncertainAnchorClaims(limit: number): Promise<AnchorClaimResponse[]> {
    return [...this.anchorClaims.values()]
      .filter((claim) => claim.state === "uncertain" || claim.state === "submitted")
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((claim) => this.claimResponse(claim));
  }

  async saveBatch(batch: AnchorBatchRecord): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.saveBatchUnlocked(batch);
      await this.afterMutation();
    });
  }

  async getBatchForPost(postId: string): Promise<AnchorBatchRecord | undefined> {
    let fallback: AnchorBatchRecord | undefined;
    for (const batch of this.batches.values()) {
      if (!batch.manifest.leaves.some((leaf) => leaf.post_id === postId)) continue;
      if (batch.receipt) return clone(batch);
      fallback = batch;
    }
    return fallback ? clone(fallback) : undefined;
  }

  async listBatches(epoch: string): Promise<AnchorBatchRecord[]> {
    return [...this.batches.values()].filter((batch) => batch.manifest.epoch === epoch).map(clone);
  }

  async listAnchorCandidates(limit: number): Promise<StoredPost[]> {
    return [...this.posts.values()]
      .filter((post) => post.publication_status === "published" && ["unanchored", "queued", "retryable_failure"].includes(post.anchoring.status))
      .sort((left, right) => left.accepted_at.localeCompare(right.accepted_at))
      .slice(0, limit)
      .map(clone);
  }

  async updateAnchor(postIds: string[], patch: Partial<AnchorObligation>): Promise<void> {
    await this.mutex.runExclusive(async () => {
      for (const postId of postIds) {
        const post = this.posts.get(postId);
        if (post) post.anchoring = {...post.anchoring, ...patch};
      }
      await this.afterMutation();
    });
  }

  async appendCommissionRequestEvent(requestId: string, event: CommissionRequestEvent): Promise<CommissionRequestRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.commissionRequests.get(requestId);
      if (!current) throw new Error("Commission request not found");
      if (current.events.some((candidate) => candidate.event_id === event.event_id)) return clone(current);
      const updated: CommissionRequestRecord = {
        ...current,
        ...(event.status ? {status: event.status} : {}),
        ...(event.quote_id ? {quote_id: event.quote_id} : {}),
        ...(event.payment_id ? {payment_id: event.payment_id} : {}),
        ...(event.realization_id ? {realization_id: event.realization_id} : {}),
        events: [...current.events, clone(event)]
      };
      this.commissionRequests.set(requestId, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async createCommissionRequest(request: CommissionRequestRecord): Promise<CommissionRequestResult> {
    return this.mutex.runExclusive(async () => {
      const existing = this.commissionRequests.get(request.request_id);
      if (existing) {
        if (existing.signature !== request.signature || !equalCanonical(existing.intent, request.intent)) throw new Error("Commission request id conflicts with existing content");
        return {request: clone(existing), created: false};
      }
      for (const candidate of this.commissionRequests.values()) {
        if (candidate.intent.human_id === request.intent.human_id && candidate.intent.client_request_id === request.intent.client_request_id) {
          throw new Error("client_request_id has already been used for a different request");
        }
      }
      this.commissionRequests.set(request.request_id, clone(request));
      await this.afterMutation();
      return {request: clone(request), created: true};
    });
  }

  async getCommissionRequest(requestId: string): Promise<CommissionRequestRecord | undefined> {
    return clone(this.commissionRequests.get(requestId));
  }

  async listHumanCommissionRequests(humanId: string, limit: number): Promise<CommissionRequestRecord[]> {
    return [...this.commissionRequests.values()]
      .filter((request) => request.intent.human_id === humanId)
      .sort((left, right) => right.accepted_at.localeCompare(left.accepted_at) || right.request_id.localeCompare(left.request_id))
      .slice(0, limit)
      .map(clone);
  }

  async createQuote(quote: QuoteRecord): Promise<QuoteRecord> {
    return this.mutex.runExclusive(async () => {
      const existing = this.quotes.get(quote.quote_id);
      if (existing) {
        if (!equalCanonical(existing, quote)) throw new Error("Quote id conflicts with existing quote");
        return clone(existing);
      }
      this.quotes.set(quote.quote_id, clone(quote));
      await this.afterMutation();
      return clone(quote);
    });
  }

  async getQuote(quoteId: string): Promise<QuoteRecord | undefined> {
    return clone(this.quotes.get(quoteId));
  }

  async reservePayment(payment: PaymentRecord): Promise<PaymentReservationResult> {
    return this.mutex.runExclusive(async () => {
      const existing = this.payments.get(payment.payment_reference);
      if (existing) {
        if (existing.post_id !== payment.post_id || existing.amount_usdc_atomic !== payment.amount_usdc_atomic || existing.quote_id !== payment.quote_id) throw new Error("payment reference has already been used for a different economic record");
        return {payment: clone(existing), created: false};
      }
      this.payments.set(payment.payment_reference, clone(payment));
      await this.afterMutation();
      return {payment: clone(payment), created: true};
    });
  }

  async getPayment(paymentReference: string): Promise<PaymentRecord | undefined> {
    return clone(this.payments.get(paymentReference));
  }

  async createRealizationWithPayment(input: RealizationPaymentInput): Promise<RealizationRecord> {
    return this.mutex.runExclusive(async () => {
      const existingRealization = this.realizations.get(input.realization.realization_id);
      if (existingRealization) return clone(existingRealization);
      const payment = this.payments.get(input.payment.payment_reference);
      if (!payment) throw new Error("Payment reservation not found");
      if (payment.realization_id && payment.realization_id !== input.realization.realization_id) throw new Error("Payment reference is already linked to another realization");
      const updatedPayment: PaymentRecord = {
        ...payment,
        ...input.payment,
        payment_reference: payment.payment_reference,
        payment_id: payment.payment_id,
        realization_id: input.realization.realization_id,
        status: "captured",
        updated_at: new Date().toISOString()
      };
      const realization = clone({...input.realization, payment_id: updatedPayment.payment_id, payment_status: updatedPayment.status});
      this.payments.set(payment.payment_reference, updatedPayment);
      this.realizations.set(realization.realization_id, realization);
      if (realization.quote_id) {
        const quote = this.quotes.get(realization.quote_id);
        if (quote) this.quotes.set(realization.quote_id, {...quote, status: "consumed"});
      }
      await this.afterMutation();
      return clone(realization);
    });
  }

  async markPaymentFailed(paymentReference: string, status: "failed" | "refundable", error: string): Promise<PaymentRecord> {
    return this.mutex.runExclusive(async () => {
      const payment = this.payments.get(paymentReference);
      if (!payment) throw new Error("Payment reservation not found");
      const updated = {...payment, status, error, updated_at: new Date().toISOString()};
      this.payments.set(paymentReference, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async createRealization(realization: RealizationRecord): Promise<RealizationRecord> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizations.get(realization.realization_id);
      if (existing) return clone(existing);
      this.realizations.set(realization.realization_id, clone(realization));
      await this.afterMutation();
      return clone(realization);
    });
  }

  async getRealization(realizationId: string): Promise<RealizationRecord | undefined> {
    return clone(this.realizations.get(realizationId));
  }

  async updateRealizationNftMediaIds(realizationId: string, mediaIds: string[]): Promise<RealizationRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.realizations.get(realizationId);
      if (!current) throw new Error("Realization not found");
      if (current.nft_media_ids && JSON.stringify(current.nft_media_ids) !== JSON.stringify(mediaIds)) throw new Error("realization NFT media binding is immutable");
      const updated = {...current, nft_media_ids: [...mediaIds]};
      this.realizations.set(realizationId, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async findRealizationByPaymentReference(paymentReference: string): Promise<RealizationRecord | undefined> {
    return clone([...this.realizations.values()].find((record) => record.payment_reference === paymentReference));
  }

  async createRightsAgreement(record: RightsAgreementRecord): Promise<RightsAgreementRecord> {
    return this.mutex.runExclusive(async () => {
      const agreement = record.agreement;
      const key = `${agreement.agreement_id}\u0000${agreement.version}`;
      const existing = this.rightsAgreements.get(key);
      if (existing) {
        if (!equalCanonical(existing, record)) throw new Error("rights agreement version conflicts with an existing record");
        return clone(existing);
      }
      const versions = [...this.rightsAgreements.values()].filter((item) => item.agreement.agreement_id === agreement.agreement_id);
      const latest = versions.reduce((max, item) => Math.max(max, item.agreement.version), 0);
      if (agreement.version !== latest + 1) throw new Error("rights agreement versions must be consecutive");
      if (record.status !== "proposed" || agreement.acceptances.length !== 0) throw new Error("new rights agreement versions must begin as unaccepted proposals");
      this.rightsAgreements.set(key, clone(record));
      for (const event of record.audit_history) this.rightsAudit.set(event.event_id, clone(event));
      await this.afterMutation();
      return clone(record);
    });
  }

  async getRightsAgreement(agreementId: string, version?: number): Promise<RightsAgreementRecord | undefined> {
    if (version !== undefined) return clone(this.rightsAgreements.get(`${agreementId}\u0000${version}`));
    const versions = [...this.rightsAgreements.values()].filter((item) => item.agreement.agreement_id === agreementId);
    versions.sort((left, right) => right.agreement.version - left.agreement.version);
    return clone(versions[0]);
  }

  async listRightsAgreements(): Promise<RightsAgreementRecord[]> {
    return [...this.rightsAgreements.values()].sort((left, right) => left.agreement.agreement_id.localeCompare(right.agreement.agreement_id) || left.agreement.version - right.agreement.version).map(clone);
  }

  async acceptRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord> {
    return this.mutex.runExclusive(async () => {
      const key = `${agreementId}\u0000${version}`;
      const current = this.rightsAgreements.get(key);
      if (!current) throw new Error("rights agreement not found");
      if (current.status !== "proposed") throw new Error("rights agreement version is no longer open for acceptance");
      if (updated.agreement.agreement_id !== agreementId || updated.agreement.version !== version || updated.terms_hash !== current.terms_hash || !equalCanonical({...updated.agreement, acceptances: []}, {...current.agreement, acceptances: []})) throw new Error("rights agreement terms changed during acceptance");
      const acceptedPartyIds = new Set(updated.agreement.acceptances.map((acceptance) => acceptance.party_id));
      if (acceptedPartyIds.size !== updated.agreement.acceptances.length || updated.agreement.acceptances.some((acceptance) => acceptance.terms_hash !== current.terms_hash || !current.agreement.required_acceptance_party_ids.includes(acceptance.party_id))) throw new Error("rights acceptance set is invalid");
      const complete = current.agreement.required_acceptance_party_ids.every((partyId) => acceptedPartyIds.has(partyId));
      if (updated.status !== (complete ? "active" : "proposed")) throw new Error("rights agreement status does not match its acceptance set");
      if (complete) {
        const conflict = [...this.rightsAgreements.values()].find((other) => other.status === "active" && other.agreement.agreement_id !== agreementId &&
          rightsScopesOverlap(other.agreement.artifact_scope, updated.agreement.artifact_scope) &&
          other.agreement.eligible_transaction_types.some((type) => updated.agreement.eligible_transaction_types.includes(type)) &&
          Date.parse(other.agreement.duration.starts_at) < Date.parse(updated.agreement.duration.ends_at ?? "9999-12-31T23:59:59.999Z") &&
          Date.parse(updated.agreement.duration.starts_at) < Date.parse(other.agreement.duration.ends_at ?? "9999-12-31T23:59:59.999Z"));
        if (conflict) throw new Error("active rights agreement conflicts with another agreement for this artifact and transaction type");
      }
      const stored = {...clone(updated), audit_history: [...current.audit_history, clone(auditEvent)]};
      this.rightsAgreements.set(key, stored);
      this.rightsAudit.set(auditEvent.event_id, clone(auditEvent));
      if (complete && version > 1) {
        const priorKey = `${agreementId}\u0000${version - 1}`;
        const prior = this.rightsAgreements.get(priorKey);
        if (prior?.status === "active") {
          const supersededEvent: RightsAuditEventV1 = {event_id: `${auditEvent.event_id}:superseded`, agreement_id: agreementId, version: version - 1, kind: "superseded", actor_id: auditEvent.actor_id, record_hash: prior.terms_hash, occurred_at: auditEvent.occurred_at, evidence_reference: auditEvent.event_id};
          this.rightsAgreements.set(priorKey, {...prior, status: "terminated", terminated_at: auditEvent.occurred_at, audit_history: [...prior.audit_history, supersededEvent], updated_at: auditEvent.occurred_at});
          this.rightsAudit.set(supersededEvent.event_id, supersededEvent);
        }
      }
      await this.afterMutation();
      return clone(stored);
    });
  }

  async terminateRightsAgreement(agreementId: string, version: number, updated: RightsAgreementRecord, auditEvent: RightsAuditEventV1): Promise<RightsAgreementRecord> {
    return this.mutex.runExclusive(async () => {
      const key = `${agreementId}\u0000${version}`;
      const current = this.rightsAgreements.get(key);
      if (!current) throw new Error("rights agreement not found");
      if (current.status === "terminated") return clone(current);
      if (current.status !== "active" || updated.status !== "terminated" || updated.agreement.agreement_id !== agreementId || updated.agreement.version !== version || updated.terms_hash !== current.terms_hash || !equalCanonical({...updated.agreement, acceptances: []}, {...current.agreement, acceptances: []}) || !updated.termination) throw new Error("rights agreement cannot be terminated from its current state or changed terms");
      const stored = {...clone(updated), audit_history: [...current.audit_history, clone(auditEvent)]};
      this.rightsAgreements.set(key, stored);
      this.rightsAudit.set(auditEvent.event_id, clone(auditEvent));
      await this.afterMutation();
      return clone(stored);
    });
  }

  async createReferralAttribution(attribution: ReferralAttributionV1, auditEvent: RightsAuditEventV1): Promise<ReferralAttributionV1> {
    return this.mutex.runExclusive(async () => {
      const existing = this.referralAttributions.get(attribution.attribution_id);
      if (existing) {
        if (!equalCanonical(existing, attribution)) throw new Error("referral attribution ID conflicts with an existing record");
        return clone(existing);
      }
      if ([...this.referralAttributions.values()].some((item) => item.referred_party_id === attribution.referred_party_id)) throw new Error("referred party already has a referral attribution");
      const children = new Map<string, string[]>();
      for (const item of this.referralAttributions.values()) children.set(item.referrer_id, [...(children.get(item.referrer_id) ?? []), item.referred_party_id]);
      const pending = [attribution.referred_party_id];
      const visited = new Set<string>();
      while (pending.length) {
        const party = pending.pop()!;
        if (party === attribution.referrer_id) throw new Error("circular referral attribution is not allowed");
        if (visited.has(party)) continue;
        visited.add(party);
        pending.push(...(children.get(party) ?? []));
      }
      this.referralAttributions.set(attribution.attribution_id, clone(attribution));
      this.rightsAudit.set(auditEvent.event_id, clone(auditEvent));
      await this.afterMutation();
      return clone(attribution);
    });
  }

  async listReferralAttributions(): Promise<ReferralAttributionV1[]> {
    return [...this.referralAttributions.values()].map(clone);
  }

  async recordRightsRevenueEvent(input: RightsRevenueEventInput): Promise<RightsRevenueEventResult> {
    return this.mutex.runExclusive(async () => {
      const existing = this.rightsRevenueEvents.get(input.event.event_id);
      if (existing) {
        if (!equalCanonical(existing, input.event)) throw new Error("revenue event ID conflicts with an existing record");
        return {event: clone(existing), allocations: [...this.rightsAllocations.values()].filter((item) => item.event_id === existing.event_id).map(clone), rewards: [...this.distributionRewards.values()].filter((item) => item.event_id === existing.event_id).map(clone), created: false};
      }
      if ([...this.rightsRevenueEvents.values()].some((item) => item.source_transaction_id === input.event.source_transaction_id)) throw new Error("source transaction has already been recorded");
      for (const item of input.allocations) if (this.rightsAllocations.has(item.allocation_id)) throw new Error("rights allocation ID is already in use");
      for (const item of input.rewards) if (this.distributionRewards.has(item.reward_id)) throw new Error("distribution reward ID is already in use");
      this.rightsRevenueEvents.set(input.event.event_id, clone(input.event));
      for (const item of input.allocations) this.rightsAllocations.set(item.allocation_id, clone(item));
      for (const item of input.rewards) this.distributionRewards.set(item.reward_id, clone(item));
      for (const event of input.audit_events) this.rightsAudit.set(event.event_id, clone(event));
      await this.afterMutation();
      return {event: clone(input.event), allocations: input.allocations.map(clone), rewards: input.rewards.map(clone), created: true};
    });
  }

  async updateRightsLedgerStatus(entryId: string, status: RightsRevenueAllocationV1["payment_status"], updatedAt: string, auditEvent: RightsAuditEventV1): Promise<RightsRevenueAllocationV1 | DistributionRewardV1> {
    return this.mutex.runExclusive(async () => {
      const allocation = this.rightsAllocations.get(entryId);
      const reward = this.distributionRewards.get(entryId);
      const entry = allocation ?? reward;
      if (!entry) throw new Error("rights ledger entry not found");
      const allowed: Record<RightsRevenueAllocationV1["payment_status"], RightsRevenueAllocationV1["payment_status"][]> = {pending: ["pending", "processing", "paid", "failed", "reversed"], processing: ["processing", "paid", "failed", "reversed"], paid: ["paid", "reversed"], failed: ["failed", "processing", "reversed"], reversed: ["reversed"]};
      if (!allowed[entry.payment_status].includes(status)) throw new Error("invalid rights ledger payment status transition");
      const updated = {...entry, payment_status: status, updated_at: updatedAt};
      if (allocation) this.rightsAllocations.set(entryId, updated as RightsRevenueAllocationV1);
      else this.distributionRewards.set(entryId, updated as DistributionRewardV1);
      this.rightsAudit.set(auditEvent.event_id, clone(auditEvent));
      await this.afterMutation();
      return clone(updated);
    });
  }

  async listRightsRevenueEvents(): Promise<RightsRevenueEventV1[]> { return [...this.rightsRevenueEvents.values()].map(clone); }
  async listRightsRevenueAllocations(): Promise<RightsRevenueAllocationV1[]> { return [...this.rightsAllocations.values()].map(clone); }
  async listDistributionRewards(): Promise<DistributionRewardV1[]> { return [...this.distributionRewards.values()].map(clone); }
  async listRightsAudit(agreementId?: string): Promise<RightsAuditEventV1[]> {
    return [...this.rightsAudit.values()].filter((event) => agreementId === undefined || event.agreement_id === agreementId).sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)).map(clone);
  }

  async createRealizePayoutConfiguration(configuration: RealizeCreatorPayoutConfigurationV1): Promise<RealizeCreatorPayoutConfigurationV1> {
    return this.mutex.runExclusive(async () => {
      const versions = this.realizePayoutConfigurations.get(configuration.creator_id) ?? new Map<number, RealizeCreatorPayoutConfigurationV1>();
      const currentVersion = Math.max(0, ...versions.keys());
      if (configuration.version !== currentVersion + 1) throw new Error("payout configuration version must advance by exactly one");
      versions.set(configuration.version, clone(configuration));
      this.realizePayoutConfigurations.set(configuration.creator_id, versions);
      await this.afterMutation();
      return clone(configuration);
    });
  }

  async getRealizePayoutConfiguration(creatorId: string, version?: number): Promise<RealizeCreatorPayoutConfigurationV1 | undefined> {
    const versions = this.realizePayoutConfigurations.get(creatorId);
    if (!versions) return undefined;
    const selected = version ?? Math.max(0, ...versions.keys());
    const configuration = versions.get(selected);
    return configuration ? clone(configuration) : undefined;
  }

  async createRealizeQuote(quote: RealizeQuoteV1): Promise<RealizeQuoteV1> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizeQuotes.get(quote.quote_id);
      if (existing) {
        if (!equalCanonical(existing, quote)) throw new Error("Realize quote id conflicts with immutable quote content");
        return clone(existing);
      }
      const sameRequest = [...this.realizeQuotes.values()].find((candidate) => candidate.pricing_request_id === quote.pricing_request_id);
      if (sameRequest) {
        if (!equalCanonical(sameRequest, quote)) throw new Error("pricing request id already issued a different quote");
        return clone(sameRequest);
      }
      this.realizeQuotes.set(quote.quote_id, clone(quote));
      await this.afterMutation();
      return clone(quote);
    });
  }

  async getRealizeQuote(quoteId: string): Promise<RealizeQuoteV1 | undefined> {
    return clone(this.realizeQuotes.get(quoteId));
  }

  async getRealizeQuoteByPricingRequest(pricingRequestId: string): Promise<RealizeQuoteV1 | undefined> {
    const quote = [...this.realizeQuotes.values()].find((candidate) => candidate.pricing_request_id === pricingRequestId);
    return quote ? clone(quote) : undefined;
  }

  async createRealizeCommission(record: RealizeCommissionRecord): Promise<RealizeCommissionRecord> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizeCommissions.get(record.commission.commission_id);
      if (existing) {
        if (!equalCanonical(existing.commission, record.commission)) throw new Error("Realize commission id conflicts with existing content");
        return clone(existing);
      }
      this.realizeCommissions.set(record.commission.commission_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async getRealizeCommission(commissionId: string): Promise<RealizeCommissionRecord | undefined> {
    return clone(this.realizeCommissions.get(commissionId));
  }

  async updateRealizeCommission(record: RealizeCommissionRecord, expectedUpdatedAt: string): Promise<RealizeCommissionRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.realizeCommissions.get(record.commission.commission_id);
      if (!current) throw new Error("Realize commission not found");
      if (current.updated_at !== expectedUpdatedAt) throw new Error("Realize commission changed concurrently");
      if (current.commission.commissioner_id !== record.commission.commissioner_id || current.commission.creator_id !== record.commission.creator_id || current.commission.capability_id !== record.commission.capability_id || current.source_post_id !== record.source_post_id || !equalCanonical(current.commission.requested_generation_parameters, record.commission.requested_generation_parameters) || current.commission.rights_agreement_reference !== record.commission.rights_agreement_reference) throw new Error("immutable Realize commission terms cannot be changed");
      if (current.nft_media_ids && JSON.stringify(current.nft_media_ids) !== JSON.stringify(record.nft_media_ids)) throw new Error("Realize NFT media binding is immutable");
      if (current.commission.quote_id && current.commission.quote_id !== record.commission.quote_id) throw new Error("commission quote id is immutable after issuance");
      if (current.commission.accepted_quote_hash && current.commission.accepted_quote_hash !== record.commission.accepted_quote_hash) throw new Error("accepted quote hash is immutable");
      if (current.commission.state !== record.commission.state && !canTransitionRealizeCommission(current.commission.state, record.commission.state)) throw new Error("invalid Realize commission state transition");
      const priorEvents = current.resolution_events ?? [];
      const nextEvents = record.resolution_events ?? [];
      if (nextEvents.length < priorEvents.length || priorEvents.some((event, index) => !equalCanonical(event, nextEvents[index]))) throw new Error("Realize resolution audit history is append-only");
      if (current.refund_approval && !equalCanonical(current.refund_approval, record.refund_approval)) throw new Error("Realize refund approval is immutable");
      if (current.failure_evidence && !equalCanonical(current.failure_evidence, record.failure_evidence)) throw new Error("confirmed Realize failure evidence is immutable");
      if (current.no_render_failure_armed && !equalCanonical(current.no_render_failure_armed, record.no_render_failure_armed)) throw new Error("staging no-render failure arm is immutable");
      if (current.resolution_outcome === "refunded" && record.resolution_outcome !== "refunded" || current.resolution_outcome === "fulfilled" && record.resolution_outcome !== "fulfilled") throw new Error("final Realize resolution outcome is immutable");
      if (current.resolution_outcome === "manual_review" && record.resolution_outcome !== "manual_review") {
        const requiredAction = record.resolution_outcome === "fulfilled" ? "generation_completed" : record.resolution_outcome === "refunded" ? "refund_finalized" : undefined;
        if (!requiredAction || nextEvents.slice(priorEvents.length).every((event) => event.action !== requiredAction)) throw new Error("manual review resolution requires a matching audit event");
      }
      if (record.resolution_outcome === "fulfilled" && (!["COMPLETED", "SETTLED"].includes(record.commission.state) || !nextEvents.some((event) => event.action === "generation_completed"))) throw new Error("fulfilled outcome requires completed generation and its audit event");
      if (record.resolution_outcome === "refunded" && (record.commission.state !== "REFUNDED" || !nextEvents.some((event) => event.action === "refund_finalized"))) throw new Error("refunded outcome requires finalized refund and its audit event");
      if (record.resolution_outcome === "manual_review" && (!["MANUAL_REVIEW", "REFUND_PENDING"].includes(record.commission.state) || !nextEvents.some((event) => event.action === "manual_review_required"))) throw new Error("manual-review outcome requires its review state and audit event");
      this.realizeCommissions.set(record.commission.commission_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async reserveRealizePaymentSignature(signature: string, commissionId: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizePaymentSignatures.get(signature);
      if (existing) return existing === commissionId;
      this.realizePaymentSignatures.set(signature, commissionId);
      await this.afterMutation();
      return true;
    });
  }

  async listRealizeCommissions(limit: number): Promise<RealizeCommissionRecord[]> {
    return [...this.realizeCommissions.values()].filter((record) => record.commission.state !== "SETTLED" && record.commission.state !== "REFUNDED" && record.commission.state !== "EXPIRED")
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at)).slice(0, limit).map(clone);
  }

  async listRealizeCommissionsForHuman(humanId: string, limit: number): Promise<RealizeCommissionRecord[]> {
    return [...this.realizeCommissions.values()].filter((record) => record.commission.commissioner_id === humanId)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, limit).map(clone);
  }

  async createRealizeProvenance(record: ProvenanceRecordV1): Promise<ProvenanceRecordV1> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizeProvenance.get(record.provenance_record_id);
      if (existing) {
        if (!equalCanonical(existing, record)) throw new Error("provenance record id conflicts with immutable content");
        return clone(existing);
      }
      this.realizeProvenance.set(record.provenance_record_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async getRealizeProvenance(provenanceRecordId: string): Promise<ProvenanceRecordV1 | undefined> {
    return clone(this.realizeProvenance.get(provenanceRecordId));
  }

  async createNftMedia(record: NftMediaRecord): Promise<NftMediaRecord> {
    return this.mutex.runExclusive(async () => {
      const existing = this.nftMedia.get(record.media_id);
      if (existing) {
        if (existing.source_kind !== record.source_kind || existing.source_id !== record.source_id || existing.output_index !== record.output_index || existing.owner_id !== record.owner_id || existing.media_uri !== record.media_uri || existing.media_sha256 !== record.media_sha256 || existing.metadata_uri !== record.metadata_uri || existing.metadata_hash !== record.metadata_hash) throw new Error("NFT media ID conflicts with immutable content");
        return clone(existing);
      }
      this.nftMedia.set(record.media_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async getNftMedia(mediaId: string): Promise<NftMediaRecord | undefined> {
    return clone(this.nftMedia.get(mediaId));
  }

  async createNftMint(record: NftMintRecord): Promise<NftMintRecord> {
    return this.mutex.runExclusive(async () => {
      const existing = this.nftMints.get(record.mint_id);
      if (existing) {
        if (existing.media_id !== record.media_id || existing.chain !== record.chain || existing.owner_id !== record.owner_id || existing.metadata_uri !== record.metadata_uri || existing.metadata_hash !== record.metadata_hash) throw new Error("NFT mint ID conflicts with immutable entitlement content");
        return clone(existing);
      }
      if (this.nftMints.has(record.mint_id)) throw new Error("NFT mint ID is already in use");
      this.nftMints.set(record.mint_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async getNftMint(mintId: string): Promise<NftMintRecord | undefined> {
    return clone(this.nftMints.get(mintId));
  }

  async listNftMintsForMedia(mediaId: string): Promise<NftMintRecord[]> {
    return [...this.nftMints.values()].filter((record) => record.media_id === mediaId).sort((left, right) => left.chain.localeCompare(right.chain)).map(clone);
  }

  async listNftMintsForProcessing(limit: number, now = new Date().toISOString()): Promise<NftMintRecord[]> {
    const nowMs = Date.parse(now);
    return [...this.nftMints.values()].filter((record) => nftProcessingCandidate(record, nowMs)).sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.mint_id.localeCompare(right.mint_id)).slice(0, Math.min(Math.max(limit, 1), 100)).map(clone);
  }

  async claimNftMint(mintId: string, ownerId: string, leaseSeconds: number): Promise<NftMintRecord | undefined> {
    return this.mutex.runExclusive(async () => {
      const current = this.nftMints.get(mintId);
      if (!current || !PROCESSING_STATES.has(current.state) || current.owner_id !== ownerId && current.lease_owner && nftLeaseActive(current, Date.now())) return undefined;
      if (current.next_attempt_at && Date.parse(current.next_attempt_at) > Date.now()) return undefined;
      if (current.lease_owner && current.lease_owner !== ownerId && nftLeaseActive(current, Date.now())) return undefined;
      const updated = nftLease(current, ownerId, leaseSeconds, new Date().toISOString());
      this.nftMints.set(mintId, updated);
      await this.afterMutation();
      return clone(updated);
    });
  }

  async updateNftMint(record: NftMintRecord, expectedUpdatedAt: string): Promise<NftMintRecord> {
    return this.mutex.runExclusive(async () => {
      const current = this.nftMints.get(record.mint_id);
      if (!current) throw new Error("NFT mint not found");
      if (current.updated_at !== expectedUpdatedAt) throw new Error("NFT mint changed concurrently");
      if (current.media_id !== record.media_id || current.chain !== record.chain || current.owner_id !== record.owner_id || current.metadata_uri !== record.metadata_uri || current.metadata_hash !== record.metadata_hash) throw new Error("immutable NFT mint terms changed");
      this.nftMints.set(record.mint_id, clone(record));
      await this.afterMutation();
      return clone(record);
    });
  }

  async createRealizeWebhookDelivery(delivery: RealizeWebhookDeliveryRecord): Promise<{delivery: RealizeWebhookDeliveryRecord; created: boolean; conflict: boolean}> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizeWebhookDeliveries.get(delivery.delivery_id);
      if (existing) return {delivery: clone(existing), created: false, conflict: existing.payload_hash !== delivery.payload_hash};
      this.realizeWebhookDeliveries.set(delivery.delivery_id, clone(delivery));
      await this.afterMutation();
      return {delivery: clone(delivery), created: true, conflict: false};
    });
  }

  async getRealizeWebhookDelivery(deliveryId: string): Promise<RealizeWebhookDeliveryRecord | undefined> {
    return clone(this.realizeWebhookDeliveries.get(deliveryId));
  }

  async markRealizeWebhookDeliveryProcessed(deliveryId: string, payloadHash: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const existing = this.realizeWebhookDeliveries.get(deliveryId);
      if (!existing || existing.payload_hash !== payloadHash) throw new Error("Realize webhook delivery is missing or conflicts with its stored payload");
      if (existing.status === "processed") return;
      this.realizeWebhookDeliveries.set(deliveryId, {...existing, status: "processed"});
      await this.afterMutation();
    });
  }

  async react(postId: string, actorId: string, reaction: "like"): Promise<{post_id: string; reaction: "like"; count: number; reacted: boolean}> {
    return this.mutex.runExclusive(async () => {
      if (!this.posts.has(postId)) throw new Error("Post not found");
      const key = `${postId}|${actorId}|${reaction}`;
      const existed = this.reactions.has(key);
      if (!existed) {
        this.reactions.set(key, {post_id: postId, actor_id: actorId, reaction, created_at: new Date().toISOString()});
        await this.afterMutation();
      }
      const count = [...this.reactions.values()].filter((record) => record.post_id === postId && record.reaction === reaction).length;
      return {post_id: postId, reaction, count, reacted: true};
    });
  }

  async search(query: string, limit: number): Promise<{agents: AgentRecord[]; posts: StoredPost[]}> {
    const needle = query.trim().toLowerCase();
    if (!needle) return {agents: [], posts: []};
    const agents = [...this.agents.values()].filter((agent) => [agent.registration.display_name, agent.registration.username ?? "", agent.registration.handle, agent.registration.description, agent.registration.agent_id].some((value) => value.toLowerCase().includes(needle))).slice(0, limit).map(clone);
    const posts = [...this.posts.values()].filter((post) => post.publication_status === "published" && [post.intent.content.text, post.intent.agent_id].some((value) => value.toLowerCase().includes(needle))).sort((left, right) => right.accepted_at.localeCompare(left.accepted_at)).slice(0, limit).map(clone);
    return {agents, posts};
  }

  async snapshot(): Promise<StoreSnapshot> {
    return {
      agents: [...this.agents.values()].map(clone),
      humans: [...this.humans.values()].map(clone),
      posts: [...this.posts.values()].map(clone),
      commission_requests: [...this.commissionRequests.values()].map(clone),
      batches: [...this.batches.values()].map(clone),
      realizations: [...this.realizations.values()].map(clone),
      reactions: [...this.reactions.values()].map(clone),
      anchor_claims: [...this.anchorClaims.values()].map(clone),
      quotes: [...this.quotes.values()].map(clone),
      payments: [...this.payments.values()].map(clone),
      realize_payout_configurations: [...this.realizePayoutConfigurations.values()].flatMap((versions) => [...versions.values()]).map(clone),
      realize_quotes: [...this.realizeQuotes.values()].map(clone),
      realize_commissions: [...this.realizeCommissions.values()].map(clone),
      realize_payment_signature_claims: [...this.realizePaymentSignatures.entries()].map(([signature, commission_id]) => ({signature, commission_id})),
      realize_provenance: [...this.realizeProvenance.values()].map(clone),
      realize_webhook_deliveries: [...this.realizeWebhookDeliveries.values()].map(clone),
      nft_media: [...this.nftMedia.values()].map(clone),
      nft_mints: [...this.nftMints.values()].map(clone),
      rights_agreements: [...this.rightsAgreements.values()].map(clone),
      rights_revenue_events: [...this.rightsRevenueEvents.values()].map(clone),
      rights_allocations: [...this.rightsAllocations.values()].map(clone),
      referral_attributions: [...this.referralAttributions.values()].map(clone),
      distribution_rewards: [...this.distributionRewards.values()].map(clone),
      rights_audit: [...this.rightsAudit.values()].map(clone)
    };
  }

  protected async afterMutation(): Promise<void> {
    // FileStore overrides this hook. MemoryStore intentionally has no I/O.
  }

  protected loadSnapshot(snapshot: StoreSnapshot): void {
    for (const agent of snapshot.agents) {
      this.agents.set(agent.registration.agent_id, agent);
      const username = registrationUsername(agent.registration);
      if (username) {
        const owner = this.usernames.get(username);
        if (owner && (owner.kind !== "agent" || owner.id !== agent.registration.agent_id)) throw new UsernameConflict(username);
        this.usernames.set(username, {kind: "agent", id: agent.registration.agent_id});
      }
    }
    for (const human of snapshot.humans ?? []) {
      this.humans.set(human.registration.human_id, human);
      const username = human.registration.username;
      if (username) {
        const normalized = canonicalUsername(username);
        if (!normalized || normalized !== username || isReservedUsername(username)) throw new UsernameConflict(username);
        const owner = this.usernames.get(username);
        if (owner) throw new UsernameConflict(username);
        this.usernames.set(username, {kind: "human", id: human.registration.human_id});
      }
    }
    for (const post of snapshot.posts) this.posts.set(post.post_id, post);
    for (const request of snapshot.commission_requests ?? []) this.commissionRequests.set(request.request_id, request);
    for (const batch of snapshot.batches) this.batches.set(batch.manifest.batch_id, batch);
    for (const claim of snapshot.anchor_claims ?? []) this.anchorClaims.set(claim.claim_id, claim);
    for (const quote of snapshot.quotes ?? []) this.quotes.set(quote.quote_id, quote);
    for (const payment of snapshot.payments ?? []) this.payments.set(payment.payment_reference, payment);
    for (const configuration of snapshot.realize_payout_configurations ?? []) {
      const versions = this.realizePayoutConfigurations.get(configuration.creator_id) ?? new Map<number, RealizeCreatorPayoutConfigurationV1>();
      versions.set(configuration.version, configuration);
      this.realizePayoutConfigurations.set(configuration.creator_id, versions);
    }
    for (const quote of snapshot.realize_quotes ?? []) this.realizeQuotes.set(quote.quote_id, quote);
    for (const record of snapshot.realize_commissions ?? []) this.realizeCommissions.set(record.commission.commission_id, record);
    for (const claim of snapshot.realize_payment_signature_claims ?? []) this.realizePaymentSignatures.set(claim.signature, claim.commission_id);
    for (const record of snapshot.realize_commissions ?? []) if (record.funding_signature) this.realizePaymentSignatures.set(record.funding_signature, record.commission.commission_id);
    for (const record of snapshot.realize_provenance ?? []) this.realizeProvenance.set(record.provenance_record_id, record);
    for (const delivery of snapshot.realize_webhook_deliveries ?? []) this.realizeWebhookDeliveries.set(delivery.delivery_id, delivery);
    for (const record of snapshot.nft_media ?? []) this.nftMedia.set(record.media_id, record);
    for (const record of snapshot.nft_mints ?? []) this.nftMints.set(record.mint_id, record);
    for (const record of snapshot.rights_agreements ?? []) this.rightsAgreements.set(`${record.agreement.agreement_id}\u0000${record.agreement.version}`, record);
    for (const event of snapshot.rights_revenue_events ?? []) this.rightsRevenueEvents.set(event.event_id, event);
    for (const allocation of snapshot.rights_allocations ?? []) this.rightsAllocations.set(allocation.allocation_id, allocation);
    for (const attribution of snapshot.referral_attributions ?? []) this.referralAttributions.set(attribution.attribution_id, attribution);
    for (const reward of snapshot.distribution_rewards ?? []) this.distributionRewards.set(reward.reward_id, reward);
    for (const event of snapshot.rights_audit ?? []) this.rightsAudit.set(event.event_id, event);
    for (const realization of snapshot.realizations) this.realizations.set(realization.realization_id, realization);
    for (const reaction of snapshot.reactions ?? []) this.reactions.set(`${reaction.post_id}|${reaction.actor_id}|${reaction.reaction}`, reaction);
  }
}

export class FileStore extends MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string, snapshot?: StoreSnapshot) {
    super();
    this.filePath = filePath;
    if (snapshot) this.loadSnapshot(snapshot);
  }

  protected override async afterMutation(): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});
    await fs.writeFile(this.filePath, JSON.stringify(await this.snapshot(), null, 2), {mode: 0o600});
  }

  static async open(filePath: string): Promise<FileStore> {
    const fs = await import("node:fs/promises");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return new FileStore(filePath, JSON.parse(raw) as StoreSnapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new FileStore(filePath);
    }
  }
}

export function receiptStatus(receipt: AnchorReceiptV1 | undefined): AnchorObligation["status"] {
  return receipt?.finalized ? "finalized" : receipt ? "submitted" : "queued";
}

import {afterEach, describe, expect, it} from "vitest";
import {buildApp, MemoryStore} from "@vox/api";
import {createAgent, createHuman} from "@vox/identity";
import {createThoughtIntent, signIntent} from "@vox/client";
import {
  calculateRevenueAllocations,
  computeRevenueRightsAgreementHash,
  generateKeyPair,
  parseSecretKey,
  publicKeyBase64,
  RevenueRightsAgreementV1Schema,
  signReferralAttribution,
  signRightsAgreementAcceptance,
  signRightsTerminationAcceptance
} from "@vox/protocol";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;
afterEach(async () => { if (app) await app.close(); app = undefined; });

async function request(path: string, options: {method?: string; body?: unknown; headers?: Record<string, string>} = {}) {
  const response = await app!.inject({method: options.method ?? "GET", url: path, ...(options.body === undefined ? {} : {payload: options.body}), ...(options.headers ? {headers: options.headers} : {})});
  return {statusCode: response.statusCode, body: response.json() as any};
}

type Signer = {party_id: string; public_key: string; secret_key: Uint8Array};

async function registerPeople() {
  const now = new Date().toISOString();
  const creator = createAgent({display_name: "Creator", handle: "creator@rights.test", description: "creator"}, new Uint8Array(32).fill(41));
  const owner = createAgent({display_name: "Character Owner", handle: "owner@rights.test", description: "owner"}, new Uint8Array(32).fill(42));
  const referrer = createAgent({display_name: "Distributor", handle: "distributor@rights.test", description: "distributor"}, new Uint8Array(32).fill(43));
  const commissioner = createHuman({display_name: "Commissioner", handle: "commissioner@rights.test", description: "commissioner", issued_at: now}, new Uint8Array(32).fill(44));
  for (const agent of [creator, owner, referrer]) expect((await request("/v1/agents", {method: "POST", body: agent.registration})).statusCode).toBe(201);
  expect((await request("/v1/humans", {method: "POST", body: commissioner.registration})).statusCode).toBe(201);
  const publisherKey = Object.keys(creator.key_material.publisherSecretKeys)[0]!;
  const sourcePostIntent = createThoughtIntent({agent_id: creator.registration.agent_id, author_key: publisherKey, client_post_id: "rights-source-post", text: "Source post for the commissioned video."});
  const sourcePost = await request("/v1/posts", {method: "POST", body: signIntent(sourcePostIntent, creator.key_material.publisherSecretKeys[publisherKey]!)});
  expect(sourcePost.statusCode).toBe(201);
  const signers: Signer[] = [
    {party_id: creator.registration.agent_id, public_key: creator.registration.identity_public_key, secret_key: parseSecretKey(creator.key_material.identitySecretKey)},
    {party_id: owner.registration.agent_id, public_key: owner.registration.identity_public_key, secret_key: parseSecretKey(owner.key_material.identitySecretKey)},
    {party_id: commissioner.registration.human_id, public_key: commissioner.registration.identity_public_key, secret_key: parseSecretKey(commissioner.key_material.identitySecretKey)}
  ];
  const referrerSigner: Signer = {party_id: referrer.registration.agent_id, public_key: referrer.registration.identity_public_key, secret_key: parseSecretKey(referrer.key_material.identitySecretKey)};
  return {creator, owner, referrer, commissioner, sourcePostId: sourcePost.body.post_id as string, signers, referrerSigner};
}

function agreementFor(people: Awaited<ReturnType<typeof registerPeople>>, agreementId: string, subjectId: string, endsAt = new Date(Date.now() + 60 * 60_000).toISOString()) {
  const now = new Date().toISOString();
  const start = new Date(Date.now() - 10_000).toISOString();
  const creatorId = people.creator.registration.agent_id;
  const ownerId = people.owner.registration.agent_id;
  const commissionerId = people.commissioner.registration.human_id;
  return {
    protocol_version: "realize/1" as const,
    agreement_id: agreementId,
    version: 1,
    artifact_scope: {subject_type: "artifact" as const, subject_id: subjectId, artifact_sha256: "a".repeat(64)},
    parties: [
      {party_id: creatorId, role: "creator" as const},
      {party_id: ownerId, role: "character_owner" as const},
      {party_id: commissionerId, role: "commissioner" as const}
    ],
    grant: {work_scope: "The specific video artifact", rights: ["reproduce" as const, "display" as const, "commercial_use" as const], license_type: "non_exclusive" as const, territory: ["worldwide"], attribution_required: true, starts_at: start, expires_at: endsAt},
    revenue_definition: {basis: "net_received" as const, description: "Receipts less agreed processing deductions", permitted_deductions: ["payment_processing" as const, "refunds" as const]},
    eligible_transaction_types: ["artifact_sale" as const, "license" as const, "secondary_sale" as const],
    allocations: [
      {beneficiary_id: commissionerId, basis_points: 3000},
      {beneficiary_id: creatorId, basis_points: 5000},
      {beneficiary_id: ownerId, basis_points: 2000}
    ],
    duration: {starts_at: start, ends_at: endsAt},
    termination_conditions: ["mutual_consent" as const, "material_breach_after_notice" as const, "artifact_withdrawal" as const],
    modification_policy: {proposer_party_ids: [creatorId, commissionerId], required_acceptance_party_ids: [creatorId, ownerId, commissionerId]},
    required_acceptance_party_ids: [creatorId, ownerId, commissionerId],
    termination_policy: {authorized_party_ids: [commissionerId, creatorId], required_acceptance_party_ids: [creatorId, ownerId, commissionerId]},
    provenance_references: [{category: "authorship" as const, party_id: creatorId, record_id: people.sourcePostId}],
    attribution: [
      {party_id: creatorId, credit_text: "Created by the named creator."},
      {party_id: ownerId, credit_text: "Character owned by the named owner."},
      {party_id: commissionerId, credit_text: "Commissioned by the named commissioner."}
    ],
    acceptances: [] as Array<Record<string, unknown>>,
    created_at: new Date(Date.now() - 1000).toISOString()
  };
}

async function proposeAndAccept(agreement: ReturnType<typeof agreementFor>, signers: Signer[]) {
  const proposal = await request("/v1/rights/agreements", {method: "POST", body: agreement});
  expect(proposal.statusCode, proposal.body.error).toBe(201);
  const termsHash = computeRevenueRightsAgreementHash(agreement as any);
  let accepted = proposal.body;
  for (const signer of signers) {
    const unsigned = {party_id: signer.party_id, key_id: "root", public_key: signer.public_key, terms_hash: termsHash, accepted_at: new Date().toISOString()};
    const acceptance = {...unsigned, signature: signRightsAgreementAcceptance(agreement.agreement_id, agreement.version, unsigned, signer.secret_key)};
    const response = await request(`/v1/rights/agreements/${encodeURIComponent(agreement.agreement_id)}/versions/1/acceptances`, {method: "POST", body: acceptance});
    expect(response.statusCode, response.body.error).toBe(200);
    accepted = response.body;
  }
  return accepted;
}

function revenueEvent(input: {eventId: string; transactionId: string; subjectId: string; buyerId: string; sellerId: string; occurredAt?: string}) {
  const now = new Date().toISOString();
  return {
    protocol_version: "realize/1" as const,
    event_id: input.eventId,
    source_transaction_id: input.transactionId,
    artifact_scope: {subject_type: "artifact" as const, subject_id: input.subjectId, artifact_sha256: "a".repeat(64)},
    transaction_type: "artifact_sale" as const,
    buyer_id: input.buyerId,
    seller_id: input.sellerId,
    gross_proceeds_usdc_atomic: "1001",
    eligible_commission_usdc_atomic: "101",
    deductions: [{type: "payment_processing" as const, amount_usdc_atomic: "1"}],
    verification: {status: "verified" as const, verifier_id: "vox:verifier:test", evidence_sha256: "b".repeat(64), verified_at: now},
    occurred_at: input.occurredAt ?? new Date(Date.now() + 2000).toISOString(),
    recorded_at: now
  };
}

async function postRevenueEvent(event: ReturnType<typeof revenueEvent>) {
  return request("/v1/internal/rights/revenue-events", {method: "POST", body: event, headers: {"x-vox-internal-token": "rights-test-token"}});
}

describe("VOX Realize rights registry", () => {
  it("requires acceptance and allocates multi-beneficiary proceeds and one referral reward idempotently", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(50)).secretKey, internalToken: "rights-test-token"});
    const people = await registerPeople();
    const agreement = agreementFor(people, "rights:accepted-1", "artifact:video-1");
    const accepted = await proposeAndAccept(agreement, people.signers);
    expect(accepted.status).toBe("active");
    expect(accepted.agreement.acceptances).toHaveLength(3);

    const referredId = people.commissioner.registration.human_id;
    const referralUnsigned = {
      protocol_version: "realize/1" as const,
      attribution_id: "referral:commissioner-1",
      referrer_id: people.referrer.registration.agent_id,
      referred_party_id: referredId,
      reward_basis_points: 1000,
      attributed_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      accepted_at: new Date().toISOString(),
      accepted_by_key_id: "root",
      accepted_by_public_key: people.commissioner.registration.identity_public_key,
      referrer_accepted_at: new Date().toISOString(),
      referrer_key_id: "root",
      referrer_public_key: people.referrer.registration.identity_public_key
    };
    const referral = {
      ...referralUnsigned,
      signature: signReferralAttribution(referralUnsigned, people.signers.find((item) => item.party_id === referredId)!.secret_key, "referred"),
      referrer_signature: signReferralAttribution(referralUnsigned, people.referrerSigner.secret_key, "referrer")
    };
    expect((await request("/v1/rights/referrals", {method: "POST", body: referral})).statusCode).toBe(201);

    const event = revenueEvent({eventId: "event:verified-sale-1", transactionId: "source:solana:signature-1", subjectId: "artifact:video-1", buyerId: referredId, sellerId: people.creator.registration.agent_id});
    const recorded = await postRevenueEvent(event);
    expect(recorded.statusCode, recorded.body.error).toBe(201);
    expect(recorded.body.allocations.map((entry: any) => [entry.beneficiary_id, entry.amount_usdc_atomic])).toEqual([
      [referredId, "300"],
      [people.creator.registration.agent_id, "500"],
      [people.owner.registration.agent_id, "200"]
    ]);
    expect(recorded.body.rewards).toHaveLength(1);
    expect(recorded.body.rewards[0].referrer_id).toBe(people.referrer.registration.agent_id);
    expect(recorded.body.rewards[0].eligible_commission_usdc_atomic).toBe("101");
    expect(recorded.body.rewards[0].reward_amount_usdc_atomic).toBe("10");
    expect(recorded.body.payout_instructions).toHaveLength(4);
    expect(recorded.body.payout_instructions.every((instruction: any) => instruction.payment_status === "pending" && instruction.destination === undefined)).toBe(true);

    const duplicate = await postRevenueEvent(event);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body.allocations).toHaveLength(3);
    expect(duplicate.body.rewards).toHaveLength(1);
    const duplicateTransaction = await postRevenueEvent({...event, event_id: "event:duplicate-tx"});
    expect(duplicateTransaction.statusCode).toBe(409);

    const beneficiaryLedger = await request(`/v1/rights/beneficiaries/${encodeURIComponent(referredId)}/ledger`);
    expect(beneficiaryLedger.body.allocations).toHaveLength(1);
    expect(beneficiaryLedger.body.allocations[0].payment_status).toBe("pending");
    const paid = await request(`/v1/internal/rights/ledger/${encodeURIComponent(beneficiaryLedger.body.allocations[0].allocation_id)}/status`, {method: "POST", body: {status: "paid", evidence_reference: "payment:operator-receipt-1"}, headers: {"x-vox-internal-token": "rights-test-token"}});
    expect(paid.statusCode).toBe(200);
    expect(paid.body.payment_status).toBe("paid");
    const audit = await request(`/v1/rights/agreements/${encodeURIComponent(agreement.agreement_id)}/audit`);
    expect(audit.body.events.some((entry: any) => entry.kind === "accepted")).toBe(true);
    expect(audit.body.events.some((entry: any) => entry.kind === "revenue_recorded")).toBe(true);
  });

  it("rejects competing agreements and revenue outside the accepted term or after termination", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(51)).secretKey, internalToken: "rights-test-token"});
    const people = await registerPeople();
    const first = agreementFor(people, "rights:conflict-1", "artifact:exclusive-video");
    await proposeAndAccept(first, people.signers);
    const competing = agreementFor(people, "rights:conflict-2", "artifact:exclusive-video");
    const proposal = await request("/v1/rights/agreements", {method: "POST", body: competing});
    expect(proposal.statusCode).toBe(201);
    const termsHash = computeRevenueRightsAgreementHash(competing as any);
    let finalResponse: {statusCode: number; body: any} | undefined;
    for (const signer of people.signers) {
      const unsigned = {party_id: signer.party_id, key_id: "root", public_key: signer.public_key, terms_hash: termsHash, accepted_at: new Date().toISOString()};
      finalResponse = await request(`/v1/rights/agreements/${encodeURIComponent(competing.agreement_id)}/versions/1/acceptances`, {method: "POST", body: {...unsigned, signature: signRightsAgreementAcceptance(competing.agreement_id, 1, unsigned, signer.secret_key)}});
    }
    expect(finalResponse?.statusCode).toBe(409);
    expect(finalResponse?.body.code).toBe("conflicting_rights_agreement");

    const shortLived = agreementFor(people, "rights:expires-1", "artifact:expires-video", new Date(Date.now() + 60_000).toISOString());
    await proposeAndAccept(shortLived, people.signers);
    const afterExpiry = revenueEvent({eventId: "event:after-expiry", transactionId: "source:expired-sale", subjectId: "artifact:expires-video", buyerId: people.commissioner.registration.human_id, sellerId: people.creator.registration.agent_id, occurredAt: new Date(Date.now() + 120_000).toISOString()});
    expect((await postRevenueEvent(afterExpiry)).body.code).toBe("rights_agreement_required");

    const terminable = agreementFor(people, "rights:terminate-1", "artifact:terminated-video");
    await proposeAndAccept(terminable, people.signers);
    const terminationHash = computeRevenueRightsAgreementHash(terminable as any);
    const proposedAt = new Date(Date.now() - 1000).toISOString();
    const terminationTerms = {protocol_version: "realize/1" as const, agreement_id: terminable.agreement_id, version: 1, condition: "mutual_consent" as const, terms_hash: terminationHash, proposed_at: proposedAt};
    const acceptances = people.signers.map((signer) => {
      const unsigned = {party_id: signer.party_id, key_id: "root", public_key: signer.public_key, accepted_at: new Date().toISOString()};
      return {...unsigned, signature: signRightsTerminationAcceptance(terminationTerms, unsigned, signer.secret_key)};
    });
    const termination = await request(`/v1/rights/agreements/${encodeURIComponent(terminable.agreement_id)}/versions/1/termination`, {method: "POST", body: {...terminationTerms, acceptances}});
    expect(termination.statusCode).toBe(200);
    expect(termination.body.status).toBe("terminated");
    const afterTermination = revenueEvent({eventId: "event:after-termination", transactionId: "source:terminated-sale", subjectId: "artifact:terminated-video", buyerId: people.commissioner.registration.human_id, sellerId: people.creator.registration.agent_id, occurredAt: new Date(Date.parse(termination.body.terminated_at) + 1000).toISOString()});
    expect((await postRevenueEvent(afterTermination)).body.code).toBe("rights_agreement_required");
  });

  it("prevents self and circular referrals and rejects invalid percentage schedules", async () => {
    app = await buildApp({store: new MemoryStore(), instanceSecretKey: generateKeyPair(new Uint8Array(32).fill(52)).secretKey, internalToken: "rights-test-token"});
    const people = await registerPeople();
    const alice = createHuman({display_name: "Alice", handle: "alice@rights.test", description: "referral test"}, new Uint8Array(32).fill(45));
    const bob = createHuman({display_name: "Bob", handle: "bob@rights.test", description: "referral test"}, new Uint8Array(32).fill(46));
    expect((await request("/v1/humans", {method: "POST", body: alice.registration})).statusCode).toBe(201);
    expect((await request("/v1/humans", {method: "POST", body: bob.registration})).statusCode).toBe(201);
    const aliceSigner: Signer = {party_id: alice.registration.human_id, public_key: alice.registration.identity_public_key, secret_key: parseSecretKey(alice.key_material.identitySecretKey)};
    const bobSigner: Signer = {party_id: bob.registration.human_id, public_key: bob.registration.identity_public_key, secret_key: parseSecretKey(bob.key_material.identitySecretKey)};
    const now = Date.now();
    const aliceReferral = {
      protocol_version: "realize/1" as const, attribution_id: "referral:alice", referrer_id: bobSigner.party_id, referred_party_id: aliceSigner.party_id,
      reward_basis_points: 500, attributed_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString(), accepted_at: new Date().toISOString(),
      accepted_by_key_id: "root", accepted_by_public_key: aliceSigner.public_key, referrer_accepted_at: new Date().toISOString(), referrer_key_id: "root", referrer_public_key: bobSigner.public_key
    };
    const aliceSigned = {...aliceReferral, signature: signReferralAttribution(aliceReferral, aliceSigner.secret_key, "referred"), referrer_signature: signReferralAttribution(aliceReferral, bobSigner.secret_key, "referrer")};
    expect((await request("/v1/rights/referrals", {method: "POST", body: {...aliceSigned, referrer_id: aliceSigner.party_id, attribution_id: "referral:self"}})).statusCode).toBe(400);
    expect((await request("/v1/rights/referrals", {method: "POST", body: aliceSigned})).statusCode).toBe(201);
    const bobReferral = {
      ...aliceReferral, attribution_id: "referral:bob", referrer_id: aliceSigner.party_id, referred_party_id: bobSigner.party_id,
      accepted_by_public_key: bobSigner.public_key, accepted_at: new Date().toISOString(), referrer_accepted_at: new Date().toISOString(), referrer_public_key: aliceSigner.public_key
    };
    const bobSigned = {...bobReferral, signature: signReferralAttribution(bobReferral, bobSigner.secret_key, "referred"), referrer_signature: signReferralAttribution(bobReferral, aliceSigner.secret_key, "referrer")};
    const circular = await request("/v1/rights/referrals", {method: "POST", body: bobSigned});
    expect(circular.statusCode).toBe(409);

    const invalid = agreementFor(people, "rights:invalid-percentages", "artifact:bad-split");
    invalid.allocations[0]!.basis_points = 6000;
    invalid.allocations[1]!.basis_points = 5000;
    expect(RevenueRightsAgreementV1Schema.safeParse(invalid).success).toBe(false);
    expect(() => calculateRevenueAllocations("100", [{beneficiary_id: "alice", basis_points: 6000}, {beneficiary_id: "bob", basis_points: 5000}])).toThrow(/10000/);
    expect(() => calculateRevenueAllocations("100", [])).toThrow(/beneficiary/);
    const excessiveCommission = revenueEvent({eventId: "event:invalid-pool", transactionId: "source:invalid-pool", subjectId: "artifact:bad-split", buyerId: aliceSigner.party_id, sellerId: people.creator.registration.agent_id});
    excessiveCommission.eligible_commission_usdc_atomic = "1002";
    expect((await postRevenueEvent(excessiveCommission)).statusCode).toBe(400);

    const orphanedProvenance = agreementFor(people, "rights:orphaned-provenance", "artifact:orphaned");
    orphanedProvenance.provenance_references[0]!.record_id = "vox:post:missing";
    const rejectedProvenance = await request("/v1/rights/agreements", {method: "POST", body: orphanedProvenance});
    expect(rejectedProvenance.statusCode).toBe(409);
    expect(rejectedProvenance.body.code).toBe("rights_provenance_mismatch");
  });

  it("rounds fractional base units deterministically without floating point", () => {
    expect(calculateRevenueAllocations("1", [
      {beneficiary_id: "beneficiary:b", basis_points: 5000},
      {beneficiary_id: "beneficiary:a", basis_points: 5000}
    ])).toEqual([
      {beneficiary_id: "beneficiary:b", basis_points: 5000, amount_usdc_atomic: "0"},
      {beneficiary_id: "beneficiary:a", basis_points: 5000, amount_usdc_atomic: "1"}
    ]);
    const threeWay = calculateRevenueAllocations("2", [
      {beneficiary_id: "a", basis_points: 3333},
      {beneficiary_id: "b", basis_points: 3333},
      {beneficiary_id: "c", basis_points: 3333}
    ]);
    expect(threeWay.map((item) => item.amount_usdc_atomic)).toEqual(["1", "1", "0"]);
    expect(threeWay.reduce((total, item) => total + BigInt(item.amount_usdc_atomic), 0n)).toBe(2n);
  });
});

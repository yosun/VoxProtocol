import {afterEach, describe, expect, it, vi} from "vitest";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {Keypair} from "@solana/web3.js";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {
  canonicalize, bytesToHex, domainHash, generateKeyPair, publicKeyBase64, signProvenanceRecord, utf8,
  type ProvenanceRecordV1
} from "@vox/protocol";
import {
  buildRealizeQuote, createRealizeSettlementInstruction, DEFAULT_MAINNET_PRICING_POLICY,
  generationParametersHash, RealizeCreatorPayoutConfigurationV1Schema, realizeCanonicalHash
} from "../apps/api/src/realize-engine.js";
import {projectCharacterAccountTransaction} from "../apps/api/src/character-account.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";
import {
  PRODUCTION_REALIZE_TREASURY, PRODUCTION_REALIZE_TREASURY_ATA, readRealizeEvidenceDocuments,
  verifyRealizeArtifact, verifyRealizeMainnetEvidence,
  type RealizeEvidenceDocuments, type RealizeEvidenceReaders
} from "../scripts/verify-realize-mainnet.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const at = "2026-11-07T12:00:00.000Z";
const after = "2026-11-07T12:00:10.000Z";

/** Everything here is an offline fixture. No wallet, cloud, RPC or provider is
 * contacted; complete fixtures deliberately receive no live acceptance label. */
function evidenceFixture(externalOwner = false, allExternal = false) {
  const issuer = generateKeyPair(new Uint8Array(32).fill(74));
  const issuerId = "instance:evidence-test";
  const issuerPublicKey = publicKeyBase64(issuer.publicKey);
  const creatorId = "vox:agent:evidence-test-bob";
  const commissionId = "vox:commission:evidence-test";
  const parameters = {concept: "Offline evidence regression"};
  const owner = externalOwner ? Keypair.generate().publicKey.toBase58() : PRODUCTION_REALIZE_TREASURY;
  const configuration = RealizeCreatorPayoutConfigurationV1Schema.parse({
    protocol_version: "realize/1", creator_id: creatorId, version: 1,
    populi_api_base_url: "https://cruelty.cam", artifact_hosts: ["cruelty.cam"],
    rights_agreement_reference: `vox:rights:evidence-test:${creatorId}`, rights_agreement_version: 1,
    rights_subject_id: `vox:creator:${creatorId}`, rights_agreement_hash: "a".repeat(64), rights_policy_mode: "first_party",
    usdc_mint: MAINNET_USDC_MINT, network_id: "solana:mainnet-beta", settlement_program_version: "spl-usdc-mainnet-v1",
    funding_destination_token_account: PRODUCTION_REALIZE_TREASURY_ATA, mainnet_pricing_policy: DEFAULT_MAINNET_PRICING_POLICY,
    provider_payouts: [{provider_id: "provider:evidence-test", recipients: [{recipient_id: "provider:evidence-test", destination: allExternal ? owner : PRODUCTION_REALIZE_TREASURY, basis_points: 10_000}]}],
    character_owner_id: creatorId,
    character_owner_markup: {fee: {}, recipients: [{recipient_id: creatorId, destination: owner, basis_points: 10_000}]},
    platform_fee: {fee: {}, recipients: [{recipient_id: "vox:platform", destination: allExternal ? owner : PRODUCTION_REALIZE_TREASURY, basis_points: 10_000}]}, additional_beneficiaries: []
  });
  const quote = buildRealizeQuote({configuration, commissionId, pricingRequestId: "pricing:evidence-test", pricingRequestHash: "b".repeat(64),
    capabilityId: "video:short-form", generationProviderId: "provider:evidence-test", generationParameters: parameters, outputMediaTypes: ["video/mp4"],
    providerPrice: {protocol_version: "realize/1", request_id: "pricing:evidence-test", provider_quote_id: "provider-price:evidence-test", creator_id: creatorId,
      capability_id: "video:short-form", generation_provider_id: "provider:evidence-test", requested_generation_parameters_hash: generationParametersHash(parameters),
      price_usdc_atomic: "250000", issued_at: at, expires_at: "2026-11-07T12:10:00.000Z"},
    issuedAt: at, issuerId, issuerKeyId: `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${issuerId}\u0000${issuerPublicKey}`)))}`,
    issuerPublicKey, issuerSecretKey: issuer.secretKey});
  const intentId = `vox:payment-intent:${sha256(`${commissionId}\u0000${quote.canonical_quote_hash}`)}`;
  const fulfillmentId = `vox:fulfillment:${sha256(`${commissionId}\u0000${quote.canonical_quote_hash}`)}`;
  const payer = Keypair.generate().publicKey.toBase58();
  const paymentReference = `vox:realize:payment:${intentId}:${quote.canonical_quote_hash}`;
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const output = {uri: "https://cruelty.cam/v1/realize/artifacts?fulfillment_request_id=evidence-test", media_type: "video/mp4", byte_length: bytes.length, sha256: sha256(bytes)};
  const fulfillment = {protocol_version: "realize/1" as const, fulfillment_request_id: fulfillmentId, commission_id: commissionId, generation_provider_id: quote.generation_provider_id,
    status: "completed" as const, outputs: [output], started_at: at, completed_at: after};
  const provenanceId = `vox:provenance:${sha256(`${commissionId}\u0000${quote.canonical_quote_hash}\u0000${realizeCanonicalHash(fulfillment.outputs, "vox.realize.output-set.v1")}`)}`;
  const unsigned: Omit<ProvenanceRecordV1, "signature"> = {protocol_version: "realize/1", provenance_record_id: provenanceId, subject_type: "commission", subject_id: commissionId,
    creator_id: creatorId, generation_provider_id: quote.generation_provider_id, commission_id: commissionId, quote_hash: quote.canonical_quote_hash,
    rights_agreement_reference: quote.rights_agreement_reference, inputs: [{sha256: generationParametersHash(parameters), media_type: "application/vnd.vox.realize.generation-parameters+json"}],
    outputs: [{sha256: output.sha256, media_type: output.media_type, byte_length: output.byte_length}], parent_record_ids: [], created_at: after,
    issuer_id: issuerId, issuer_key_id: quote.issuer_key_id};
  const provenance = {...unsigned, signature: signProvenanceRecord(unsigned, issuer.secretKey)};
  const instruction = createRealizeSettlementInstruction({quote, commissionId, paymentIntentId: intentId, createdAt: after});
  const externalPayouts = instruction.payout_recipients.filter((payout) => payout.destination !== `solana:mainnet-beta:${PRODUCTION_REALIZE_TREASURY}`);
  const paidAmount = externalPayouts.reduce((sum, payout) => sum + BigInt(payout.amount_usdc_atomic), 0n).toString();
  const heldAmount = (BigInt(quote.total_amount_usdc_atomic) - BigInt(paidAmount)).toString();
  const payoutSignature = "2".repeat(87);
  const fundingSignature = "3".repeat(87);
  const record: RealizeCommissionRecord = {
    commission: {protocol_version: "realize/1", commission_id: commissionId, commissioner_id: "vox:human:evidence-test", creator_id: creatorId, capability_id: "video:short-form",
      requested_generation_parameters: parameters, rights_agreement_reference: quote.rights_agreement_reference, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash,
      payment_intent_id: intentId, fulfillment_request_id: fulfillmentId, state: allExternal ? "SETTLED" : "COMPLETED", payment_state: allExternal ? "settled" : "captured", fulfillment_state: "completed", created_at: at, updated_at: after},
    payout_configuration_version: 1, payer_wallet: payer, rights_reviewed_at: at,
    payment_intent: {protocol_version: "realize/1", payment_intent_id: intentId, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash,
      payer_id: "vox:human:evidence-test", amount_usdc_atomic: quote.total_amount_usdc_atomic, asset: "USDC", network_id: "solana:mainnet-beta", status: allExternal ? "settled" : "captured", idempotency_key: "evidence-test", expires_at: quote.expires_at, created_at: at},
    direct_funding: {mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT,
      destination_token_account: PRODUCTION_REALIZE_TREASURY_ATA, destination_owner: PRODUCTION_REALIZE_TREASURY, amount_usdc_atomic: quote.total_amount_usdc_atomic,
      payment_reference: paymentReference, payer_wallet: payer, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, expires_at: quote.expires_at},
    funding_signature: fundingSignature, funding_verified_at: at, funded_at: at, funding_network_id: "solana:mainnet-beta", funding_block_time: Date.parse(at) / 1_000, funding_timing_status: "within_quote_window",
    fulfillment_request: {protocol_version: "realize/1", fulfillment_request_id: fulfillmentId, commission_id: commissionId, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash,
      generation_provider_id: quote.generation_provider_id, requested_generation_parameters: parameters, output_media_types: ["video/mp4"], provider_quote_id: quote.provider_price_quote_id!, idempotency_key: fulfillmentId, created_at: at,
      funding_authorization: {protocol_version: "realize/1", authorization_id: `vox:funding-authorization:${sha256(`${commissionId}\u0000${quote.canonical_quote_hash}\u0000${fundingSignature}`)}`, payment_intent_id: intentId, commission_id: commissionId, accepted_quote_hash: quote.canonical_quote_hash,
        asset: "USDC", total_amount_usdc_atomic: quote.total_amount_usdc_atomic, provider_amount_usdc_atomic: "250000", network_id: "solana:mainnet-beta", payment_reference: paymentReference, verified_by: issuerId, verified_at: at}},
    fulfillment_result: fulfillment, provenance_record_id: provenanceId, resolution_outcome: "fulfilled", settlement_instruction: instruction,
    settlement_status: allExternal ? "settled" : externalOwner ? "partial" : "pending",
    settlement_response: {settlement_id: instruction.settlement_id, status: allExternal ? "settled" : externalOwner ? "partial" : "processing", transaction_signatures: externalOwner ? [payoutSignature] : [],
      settled_payout_ids: externalPayouts.map((payout) => payout.payout_id), settled_amount_usdc_atomic: paidAmount, held_amount_usdc_atomic: heldAmount, failed_payout_ids: [], updated_at: after},
    created_at: at, updated_at: after
  };
  const state = allExternal ? "settled" as const : externalOwner ? "partial" as const : "active" as const;
  const documents: RealizeEvidenceDocuments = {record, quote, configuration, provenance,
    funding_claim: {signature: fundingSignature, commission_id: commissionId},
    settlement: {record_id: instruction.settlement_id, payment_intent_id: intentId, kind: "settlement", state, request_hash: sha256(canonicalize(instruction)), request: instruction, created_at: after},
    settlement_lock: {record_id: instruction.settlement_id, payment_intent_id: intentId, kind: "settlement", state},
    batches: externalOwner ? [{batch_index: 0, attempt_number: 1, payout_ids: externalPayouts.map((payout) => payout.payout_id), amount_usdc_atomic: paidAmount, status: "finalized", transaction_signature: payoutSignature, updated_at: after}] : [],
    character_account_transaction: projectCharacterAccountTransaction(record, quote, PRODUCTION_REALIZE_TREASURY)};
  const readers: RealizeEvidenceReaders = {
    verifyFunding: vi.fn(async () => ({finalized: true, matched: true, block_time: Date.parse(at) / 1_000})),
    getProviderFulfillment: vi.fn(async () => structuredClone(fulfillment)),
    verifyArtifact: vi.fn(async (candidate, pinned) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, {headers: {"content-type": "video/mp4"}})));
      await verifyRealizeArtifact(candidate, pinned);
    }),
    verifyPayout: vi.fn(async () => true)
  };
  return {documents, trust: {commissionId, issuerId, issuerPublicKey, providerOrigin: "https://cruelty.cam"}, readers, bytes, configuration, output};
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("read-only Mainnet acceptance evidence", () => {
  it("keeps complete offline fixtures distinct from a live acceptance claim and reports held funds as liabilities", async () => {
    const fixture = evidenceFixture();
    const report = await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers);
    expect(report).toMatchObject({status: "evidence-complete", held_amount_usdc_atomic: "1000000", external_payout_amount_usdc_atomic: "0"});
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((check) => check.status === "verified")).toBe(true);
    expect(fixture.readers.verifyPayout).not.toHaveBeenCalled();
    expect(report).not.toHaveProperty("source");
    expect(report.limitations.join(" ")).toContain("not external payouts");
  });

  it("independently checks an external batch while retaining the remaining treasury liabilities", async () => {
    const fixture = evidenceFixture(true);
    expect(await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).toMatchObject({status: "evidence-complete", held_amount_usdc_atomic: "300000", external_payout_amount_usdc_atomic: "700000"});
    expect(fixture.readers.verifyPayout).toHaveBeenCalledOnce();
    vi.mocked(fixture.readers.verifyPayout).mockResolvedValue(false);
    expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
  });

  it("requires all external payouts and the paid owner account before accepting fully settled delivery", async () => {
    const fixture = evidenceFixture(true, true);
    expect(await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).toMatchObject({status: "evidence-complete", held_amount_usdc_atomic: "0", external_payout_amount_usdc_atomic: "1000000"});
    expect(fixture.readers.verifyPayout).toHaveBeenCalledTimes(3);
    fixture.documents.batches![0]!.status = "prepared";
    expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
  });

  it.each([
    ["missing funding replay claim", (documents: RealizeEvidenceDocuments) => { delete documents.funding_claim; }],
    ["changed payer", (documents: RealizeEvidenceDocuments) => { documents.record!.payer_wallet = Keypair.generate().publicKey.toBase58(); }],
    ["both payer wallet fields missing", (documents: RealizeEvidenceDocuments) => { delete documents.record!.payer_wallet; delete (documents.record!.direct_funding as unknown as {payer_wallet?: string}).payer_wallet; }],
    ["changed accepted quote", (documents: RealizeEvidenceDocuments) => { documents.record!.commission.accepted_quote_hash = "c".repeat(64); }],
    ["synthetic failure rehearsal", (documents: RealizeEvidenceDocuments) => { documents.record!.no_render_failure_armed = {} as never; }],
    ["no provider request", (documents: RealizeEvidenceDocuments) => { delete documents.record!.fulfillment_request; }],
    ["another provider idempotency key", (documents: RealizeEvidenceDocuments) => { documents.record!.fulfillment_request!.idempotency_key = "another-fulfillment"; }],
    ["missing provenance", (documents: RealizeEvidenceDocuments) => { delete documents.provenance; }],
    ["invalid provenance signature", (documents: RealizeEvidenceDocuments) => { (documents.provenance as ProvenanceRecordV1).signature = "a".repeat(86); }],
    ["no settlement lock", (documents: RealizeEvidenceDocuments) => { delete documents.settlement_lock; }],
    ["missing owner liability", (documents: RealizeEvidenceDocuments) => { delete documents.character_account_transaction; }],
    ["holds mislabeled as payouts", (documents: RealizeEvidenceDocuments) => {
      documents.record!.settlement_response!.settled_amount_usdc_atomic = "1000000";
      documents.record!.settlement_response!.held_amount_usdc_atomic = "0";
    }]
  ])("fails closed for %s", async (_name, damage) => {
    const fixture = evidenceFixture();
    damage(fixture.documents);
    const report = await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers);
    expect(report.status).toBe("incomplete");
    expect(report.checks.some((check) => check.status === "incomplete")).toBe(true);
  });

  it("does not accept self-signed quote keys, health-only checks, absent receipts, or provider preflight", async () => {
    const fixture = evidenceFixture();
    const noDocuments = await verifyRealizeMainnetEvidence({}, fixture.trust, fixture.readers);
    expect(noDocuments.status).toBe("incomplete");
    expect(fixture.readers.verifyFunding).not.toHaveBeenCalled();
    const otherIssuer = publicKeyBase64(generateKeyPair(new Uint8Array(32).fill(22)).publicKey);
    expect((await verifyRealizeMainnetEvidence(fixture.documents, {...fixture.trust, issuerPublicKey: otherIssuer}, fixture.readers)).status).toBe("incomplete");
    vi.mocked(fixture.readers.verifyFunding).mockResolvedValue({finalized: false, matched: false});
    expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
    expect(fixture.readers.getProviderFulfillment).not.toHaveBeenCalled();
    vi.mocked(fixture.readers.verifyFunding).mockResolvedValue({finalized: true, matched: true, block_time: Date.parse(at) / 1_000});
    vi.mocked(fixture.readers.getProviderFulfillment).mockRejectedValue(new Error("secret-never-print-this-token"));
    const providerMissing = await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers);
    expect(providerMissing.status).toBe("incomplete");
    expect(JSON.stringify(providerMissing)).not.toContain("secret-never-print-this-token");
  });

  it("refuses missing and late chain times, wrong provider results and signed-but-changed output bytes", async () => {
    const fixture = evidenceFixture();
    for (const receipt of [{finalized: true, matched: true}, {finalized: true, matched: true, block_time: Date.parse(at) / 1_000 + 10_000}]) {
      vi.mocked(fixture.readers.verifyFunding).mockResolvedValue(receipt);
      expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
    }
    vi.mocked(fixture.readers.verifyFunding).mockResolvedValue({finalized: true, matched: true, block_time: Date.parse(at) / 1_000});
    vi.mocked(fixture.readers.getProviderFulfillment).mockResolvedValue({...fixture.documents.record!.fulfillment_result!, fulfillment_request_id: "wrong-fulfillment"});
    expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
    vi.mocked(fixture.readers.getProviderFulfillment).mockResolvedValue(fixture.documents.record!.fulfillment_result!);
    vi.mocked(fixture.readers.verifyArtifact).mockImplementation(async (output, configuration) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(fixture.bytes.length).fill(5), {headers: {"content-type": output.media_type}})));
      await verifyRealizeArtifact(output, configuration);
    });
    expect((await verifyRealizeMainnetEvidence(fixture.documents, fixture.trust, fixture.readers)).status).toBe("incomplete");
  });

  it("bounds artifact fetching and rejects media changes, short/long streams, redirects, and untrusted hosts", async () => {
    const fixture = evidenceFixture();
    for (const response of [new Response(fixture.bytes, {headers: {"content-type": "application/json"}}), new Response(fixture.bytes.slice(1), {headers: {"content-type": "video/mp4"}}), new Response(new Uint8Array(fixture.bytes.length + 1), {headers: {"content-type": "video/mp4"}}), new Response(null, {status: 302, headers: {location: "http://127.0.0.1"}})]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      await expect(verifyRealizeArtifact(fixture.output, fixture.configuration)).rejects.toThrow();
    }
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(verifyRealizeArtifact({...fixture.output, uri: "http://127.0.0.1/artifact"}, fixture.configuration)).rejects.toThrow();
    await expect(verifyRealizeArtifact({...fixture.output, uri: "https://127.0.0.1/artifact"}, {...fixture.configuration, artifact_hosts: ["127.0.0.1"]}, ["127.0.0.1"])).rejects.toThrow();
    await expect(verifyRealizeArtifact({...fixture.output, uri: "https://metadata.google.internal/artifact"}, {...fixture.configuration, artifact_hosts: ["metadata.google.internal"]}, ["metadata.google.internal"])).rejects.toThrow();
    await expect(verifyRealizeArtifact({...fixture.output, uri: "https://unapproved-cdn.com/artifact"}, {...fixture.configuration, artifact_hosts: ["unapproved-cdn.com"]})).rejects.toThrow();
    await expect(verifyRealizeArtifact({...fixture.output, uri: "https://user:pass@cruelty.cam/artifact"}, fixture.configuration)).rejects.toThrow();
    await expect(verifyRealizeArtifact({...fixture.output, byte_length: fixture.configuration.max_artifact_bytes + 1}, fixture.configuration)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only document reads and does not invoke status routes or account backfills", async () => {
    const fixture = evidenceFixture();
    const id = (value: string) => Buffer.from(value).toString("base64url");
    const documentData = new Map<string, unknown>([
      [`vox_realize_commissions/${id(fixture.trust.commissionId)}`, fixture.documents.record],
      [`vox_realize_quotes/${id(fixture.documents.record!.commission.quote_id!)}`, fixture.documents.quote],
      [`vox_realize_payout_configurations/${id(fixture.documents.record!.commission.creator_id)}:v00000001`, fixture.documents.configuration],
      [`vox_realize_public_provenance/${id(fixture.documents.record!.provenance_record_id!)}`, fixture.documents.provenance],
      [`vox_realize_payment_signatures/${sha256(fixture.documents.record!.funding_signature!)}`, fixture.documents.funding_claim],
      [`vox_realize_settlement_records/${sha256(fixture.documents.record!.settlement_instruction!.settlement_id)}`, fixture.documents.settlement],
      [`vox_realize_settlement_records/payment-${sha256(fixture.documents.record!.payment_intent!.payment_intent_id)}`, fixture.documents.settlement_lock],
      [`vox_realize_character_accounts/${id(fixture.documents.record!.commission.creator_id)}/transactions/${id(fixture.trust.commissionId)}`, fixture.documents.character_account_transaction]
    ]);
    const doc = vi.fn((path: string) => ({get: async () => ({data: () => documentData.get(path)}), collection: (name: string) => ({limit: (count: number) => ({get: async () => {
      expect(name).toBe("batches"); expect(count).toBe(65); return {docs: []};
    }})})}));
    const documents = await readRealizeEvidenceDocuments({doc} as never, fixture.trust.commissionId);
    expect(documents).toEqual(fixture.documents);
    expect(doc).toHaveBeenCalledTimes(9);
  });

  it("rejects the Firestore emulator before accessing live evidence and emits only an incomplete result", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-realize-mainnet.ts", "--commission-id", "c", "--issuer-id", "i", "--issuer-public-key", "k"], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", env: {...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:9999"}
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({status: "incomplete", reason: "An emulator cannot supply live Mainnet evidence."});
  });
});

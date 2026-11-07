import {createHash} from "node:crypto";
import {parseArgs} from "node:util";
import {pathToFileURL} from "node:url";
import {isIP} from "node:net";
import {Firestore} from "@google-cloud/firestore";
import {PublicKey} from "@solana/web3.js";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
  CommissionV1Schema, PaymentIntentV1Schema, ProviderFulfillmentRequestV1Schema, FulfillmentResultV1Schema,
  ProvenanceRecordV1Schema, RealizeQuoteV1Schema, SettlementInstructionV1Schema,
  canonicalBytes, canonicalize, bytesToHex, domainHash, utf8, verifyProvenanceRecord, verifyRealizeQuoteSignature,
  type FulfillmentResultV1
} from "@vox/protocol";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {isValidSolanaAddress, verifyFinalizedUsdcTransfer} from "@vox/solana";
import {
  HttpPopuliRealizeClient, DEFAULT_MAINNET_PRICING_POLICY, RealizeCreatorPayoutConfigurationV1Schema, RealizeSettlementResponseV1Schema,
  createRealizeSettlementInstruction, generationParametersHash, realizeCanonicalHash,
  type RealizeCreatorPayoutConfigurationV1
} from "../apps/api/src/realize-engine.js";
import {projectCharacterAccountTransaction} from "../apps/api/src/character-account.js";
import {MainnetSplUsdcRealizePaymentRail, type RealizePaymentVerification} from "../apps/api/src/realize-payment.js";
import type {RealizeCommissionRecord} from "../apps/api/src/types.js";
import type {SettlementBatchRecord, SettlementRecord} from "../apps/settlement/src/ledger.js";

export const PRODUCTION_REALIZE_TREASURY = "5Uvtth32oEiA9BG8XjzfTgwn9kry9iUQsYHnggxLpzgA";
export const PRODUCTION_REALIZE_TREASURY_ATA = "C5txndLZDr6GyFMgFjFEKyavPDJGAnkVB6EdnDUd1W26";
const NETWORK = "solana:mainnet-beta";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const docId = (value: string) => Buffer.from(value).toString("base64url");
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);

/** Only read persisted documents. In particular, do not use the commission GET
 * route or settlement GET route: both can reconcile and submit financial work. */
export interface RealizeEvidenceDocuments {
  record?: RealizeCommissionRecord;
  quote?: unknown;
  configuration?: unknown;
  provenance?: unknown;
  funding_claim?: {signature: string; commission_id: string};
  settlement?: SettlementRecord;
  settlement_lock?: {record_id: string; payment_intent_id: string; kind: string; state: string};
  batches?: SettlementBatchRecord[];
  character_account_transaction?: unknown;
}

export interface RealizeEvidenceTrust {
  commissionId: string;
  issuerId: string;
  issuerPublicKey: string;
  providerOrigin: string;
}

export interface RealizeEvidenceReaders {
  verifyFunding(record: RealizeCommissionRecord): Promise<RealizePaymentVerification>;
  getProviderFulfillment(configuration: RealizeCreatorPayoutConfigurationV1, id: string): Promise<FulfillmentResultV1>;
  verifyArtifact(output: FulfillmentResultV1["outputs"][number], configuration: RealizeCreatorPayoutConfigurationV1): Promise<void>;
  verifyPayout(batch: SettlementBatchRecord, payout: {destination: string; amount_usdc_atomic: string}, settlementId: string): Promise<boolean>;
}

class MissingEvidence extends Error {}
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw new MissingEvidence(message);
}

/** This reusable evaluator deliberately reports evidence completeness, never
 * live acceptance. Only the CLI's production Firestore/RPC/HTTP readers can
 * attach the live observation label. Unit fixtures are not live evidence. */
export async function verifyRealizeMainnetEvidence(documents: RealizeEvidenceDocuments, trust: RealizeEvidenceTrust, readers: RealizeEvidenceReaders) {
  const checks: Array<{stage: string; status: "verified" | "incomplete"; reason?: string}> = [];
  const check = async (stage: string, action: () => unknown | Promise<unknown>) => {
    try { await action(); checks.push({stage, status: "verified"}); return true; }
    catch (error) {
      checks.push({stage, status: "incomplete", reason: error instanceof MissingEvidence ? error.message : "Required evidence is unavailable or invalid; no acceptance claim can be made."});
      return false;
    }
  };
  const record = documents.record;
  let quote: ReturnType<typeof RealizeQuoteV1Schema.parse> | undefined;
  let configuration: RealizeCreatorPayoutConfigurationV1 | undefined;
  let result: FulfillmentResultV1 | undefined;
  let heldAmount: string | undefined;
  let externallyPaidAmount: string | undefined;
  const bindingVerified = await check("accepted_quote_and_payment_binding", () => {
    requireEvidence(record, "The existing persisted commission is required.");
    const commission = CommissionV1Schema.parse(record.commission);
    quote = RealizeQuoteV1Schema.parse(documents.quote);
    const intent = PaymentIntentV1Schema.parse(record.payment_intent);
    configuration = RealizeCreatorPayoutConfigurationV1Schema.parse(documents.configuration);
    const funding = record.direct_funding;
    const intentId = `vox:payment-intent:${sha256(`${commission.commission_id}\u0000${quote.canonical_quote_hash}`)}`;
    const issuerKeyId = `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${trust.issuerId}\u0000${trust.issuerPublicKey}`)))}`;
    requireEvidence(verifyRealizeQuoteSignature(quote, trust.issuerPublicKey) && quote.issuer_public_key === trust.issuerPublicKey && quote.issuer_id === trust.issuerId && quote.issuer_key_id === issuerKeyId,
      "The quote must verify against the independently trusted production issuer.");
    requireEvidence(commission.commission_id === trust.commissionId && quote.commission_id === trust.commissionId && quote.quote_id === commission.quote_id && quote.creator_id === commission.creator_id && quote.capability_id === commission.capability_id && same(quote.requested_generation_parameters, commission.requested_generation_parameters) && commission.accepted_quote_hash === quote.canonical_quote_hash && quote.rights_agreement_reference === commission.rights_agreement_reference,
      "The accepted commission, quote, rights and generation parameters must agree.");
    requireEvidence(quote.network_id === NETWORK && quote.usdc_mint === MAINNET_USDC_MINT && quote.payout_configuration_version === configuration.version && record.payout_configuration_version === configuration.version && quote.payout_configuration_hash === bytesToHex(domainHash("vox.realize.payout-configuration.v1", canonicalBytes(configuration))) && configuration.creator_id === commission.creator_id && configuration.network_id === NETWORK && configuration.usdc_mint === MAINNET_USDC_MINT && configuration.funding_destination_token_account === PRODUCTION_REALIZE_TREASURY_ATA && configuration.populi_api_base_url === trust.providerOrigin && quote.rights_agreement_reference === configuration.rights_agreement_reference && quote.rights_agreement_version === configuration.rights_agreement_version && quote.rights_agreement_hash === configuration.rights_agreement_hash && (quote.rights_policy_mode ?? "signed_agreement") === (configuration.rights_policy_mode ?? "signed_agreement") && quote.settlement_program_version === configuration.settlement_program_version && same(quote.revenue_allocation_policy, configuration.mainnet_pricing_policy ?? DEFAULT_MAINNET_PRICING_POLICY),
      "The quote must pin the persisted production payout and provider configuration.");
    requireEvidence(intent.payment_intent_id === intentId && commission.payment_intent_id === intentId && intent.commission_id === trust.commissionId && intent.quote_id === quote.quote_id && intent.accepted_quote_hash === quote.canonical_quote_hash && intent.payer_id === commission.commissioner_id && intent.network_id === NETWORK && intent.amount_usdc_atomic === quote.total_amount_usdc_atomic && ["captured", "settled"].includes(intent.status) && intent.expires_at === quote.expires_at,
      "The captured payment intent must bind the exact accepted quote and payer.");
    requireEvidence(funding && !record.escrow_funding && typeof record.payer_wallet === "string" && isValidSolanaAddress(record.payer_wallet) && funding.mode === "direct" && funding.custody_model === "backend_managed" && funding.network_id === NETWORK && funding.usdc_mint === MAINNET_USDC_MINT && funding.destination_owner === PRODUCTION_REALIZE_TREASURY && funding.destination_token_account === PRODUCTION_REALIZE_TREASURY_ATA && funding.payer_wallet === record.payer_wallet && funding.commission_id === trust.commissionId && funding.quote_id === quote.quote_id && funding.accepted_quote_hash === quote.canonical_quote_hash && funding.amount_usdc_atomic === quote.total_amount_usdc_atomic && funding.payment_reference === `vox:realize:payment:${intentId}:${quote.canonical_quote_hash}` && funding.expires_at === quote.expires_at,
      "Persisted direct funding instructions must bind the production treasury, payer and accepted quote.");
    requireEvidence(record.rights_reviewed_at && Number.isFinite(Date.parse(record.rights_reviewed_at)) && record.funding_verified_at && Number.isFinite(Date.parse(record.funding_verified_at)) && record.funded_at && Number.isFinite(Date.parse(record.funded_at)) && record.funding_signature && record.funding_network_id === NETWORK && documents.funding_claim?.signature === record.funding_signature && documents.funding_claim.commission_id === trust.commissionId,
      "Persisted rights acceptance, verified funding receipt and replay-protection claim are required.");
    requireEvidence((commission.state === "COMPLETED" && commission.payment_state === "captured" || commission.state === "SETTLED" && commission.payment_state === "settled") && commission.fulfillment_state === "completed" && record.resolution_outcome === "fulfilled" && !record.refund_response && !record.refund_approval && !record.failure_evidence && !record.no_render_failure_armed,
      "The commission must be paid and delivered with no refund or synthetic failure resolution.");
  });
  const fundingVerified = await check("finalized_mainnet_funding", async () => {
    requireEvidence(bindingVerified && record && quote, "Accepted quote and payment binding must be verified first.");
    const receipt = await readers.verifyFunding(record);
    requireEvidence(receipt.finalized && receipt.matched && receipt.execution_failed !== true, "A matching finalized Mainnet funding transaction is required.");
    requireEvidence(receipt.block_time !== undefined && record.funding_block_time === receipt.block_time && record.funding_timing_status === "within_quote_window" && receipt.block_time * 1_000 >= Date.parse(quote.issued_at) && (receipt.block_time + 1) * 1_000 <= Date.parse(quote.expires_at),
      "The independently observed funding block time must match the persisted receipt and unambiguous accepted quote window.");
  });
  const fulfillmentVerified = await check("provider_fulfillment", async () => {
    requireEvidence(fundingVerified && record && quote && configuration, "Verified funding must precede provider fulfillment evidence.");
    const request = ProviderFulfillmentRequestV1Schema.parse(record.fulfillment_request);
    result = FulfillmentResultV1Schema.parse(record.fulfillment_result);
    const fulfillmentId = `vox:fulfillment:${sha256(`${trust.commissionId}\u0000${quote.canonical_quote_hash}`)}`;
    const authorization = request.funding_authorization;
    requireEvidence(request.fulfillment_request_id === fulfillmentId && request.idempotency_key === fulfillmentId && record.commission.fulfillment_request_id === fulfillmentId && request.commission_id === trust.commissionId && request.quote_id === quote.quote_id && request.accepted_quote_hash === quote.canonical_quote_hash && request.generation_provider_id === quote.generation_provider_id && request.provider_quote_id === quote.provider_price_quote_id && same(request.requested_generation_parameters, quote.requested_generation_parameters) && same(request.output_media_types, quote.output_media_types) && authorization.authorization_id === `vox:funding-authorization:${sha256(`${trust.commissionId}\u0000${quote.canonical_quote_hash}\u0000${record.funding_signature}`)}` && authorization.payment_intent_id === record.payment_intent!.payment_intent_id && authorization.network_id === NETWORK && authorization.total_amount_usdc_atomic === quote.total_amount_usdc_atomic && authorization.provider_amount_usdc_atomic === (quote.provider_cost_usdc_atomic ?? quote.provider_base_price_usdc_atomic) && authorization.payment_reference === record.direct_funding!.payment_reference && authorization.verified_by === trust.issuerId && authorization.verified_at === record.funded_at && Date.parse(request.created_at) >= Date.parse(record.funded_at!),
      "One persisted idempotent provider request must bind the verified quote and funding.");
    requireEvidence(result.status === "completed" && result.fulfillment_request_id === fulfillmentId && result.commission_id === trust.commissionId && result.generation_provider_id === quote.generation_provider_id && Date.parse(result.completed_at!) >= Date.parse(request.created_at) && result.outputs.every((output) => output.byte_length > 0 && request.output_media_types.includes(output.media_type)),
      "The provider result must deliver the requested media for this exact fulfillment.");
    const observed = FulfillmentResultV1Schema.parse(await readers.getProviderFulfillment(configuration, fulfillmentId));
    requireEvidence(same(observed, result), "A read-only provider observation must match the persisted completed fulfillment.");
  });
  await check("signed_provenance_and_artifact_bytes", async () => {
    requireEvidence(fulfillmentVerified && record && quote && result && configuration, "A verified provider fulfillment is required before artifact acceptance.");
    const provenance = ProvenanceRecordV1Schema.parse(documents.provenance);
    const outputSetHash = realizeCanonicalHash(result.outputs, "vox.realize.output-set.v1");
    const provenanceId = `vox:provenance:${sha256(`${trust.commissionId}\u0000${quote.canonical_quote_hash}\u0000${outputSetHash}`)}`;
    requireEvidence(verifyProvenanceRecord(provenance, trust.issuerPublicKey) && provenance.issuer_id === trust.issuerId && provenance.issuer_key_id === quote.issuer_key_id && provenance.provenance_record_id === provenanceId && record.provenance_record_id === provenanceId && provenance.subject_type === "commission" && provenance.subject_id === trust.commissionId && provenance.commission_id === trust.commissionId && provenance.quote_hash === quote.canonical_quote_hash && provenance.creator_id === quote.creator_id && provenance.generation_provider_id === quote.generation_provider_id && provenance.rights_agreement_reference === quote.rights_agreement_reference && provenance.inputs.some((input) => input.sha256 === generationParametersHash(quote!.requested_generation_parameters)) && same(provenance.outputs, result.outputs.map(({sha256, media_type, byte_length}) => ({sha256, media_type, byte_length}))),
      "Signed provenance must bind the exact accepted commission, input and delivered output set.");
    for (const output of result.outputs) await readers.verifyArtifact(output, configuration);
  });
  await check("settlement_and_treasury_liabilities", async () => {
    requireEvidence(bindingVerified && fundingVerified && record && quote, "Verified quote-bound funding is required before settlement acceptance.");
    const instruction = SettlementInstructionV1Schema.parse(record.settlement_instruction);
    const expected = createRealizeSettlementInstruction({quote, commissionId: trust.commissionId, paymentIntentId: record.payment_intent!.payment_intent_id, createdAt: instruction.created_at});
    const ledger = documents.settlement;
    const lock = documents.settlement_lock;
    requireEvidence(same(instruction, expected) && ledger && same(ledger.request, instruction) && ledger.request_hash === sha256(canonicalize(instruction)) && ledger.record_id === instruction.settlement_id && ledger.payment_intent_id === instruction.payment_intent_id && ledger.kind === "settlement" && lock?.kind === "settlement" && lock.record_id === ledger.record_id && lock.payment_intent_id === ledger.payment_intent_id && lock.state === ledger.state,
      "Persisted settlement instruction, request hash and payment-intent lock must bind the accepted quote.");
    const held = instruction.payout_recipients.filter((payout) => payout.destination === `${NETWORK}:${PRODUCTION_REALIZE_TREASURY}`);
    const external = instruction.payout_recipients.filter((payout) => payout.destination !== `${NETWORK}:${PRODUCTION_REALIZE_TREASURY}`);
    heldAmount = held.reduce((sum, payout) => sum + BigInt(payout.amount_usdc_atomic), 0n).toString();
    externallyPaidAmount = external.reduce((sum, payout) => sum + BigInt(payout.amount_usdc_atomic), 0n).toString();
    requireEvidence(documents.batches, "The persisted settlement batch inventory is required, including an empty inventory for treasury holds.");
    const batches = documents.batches;
    const signatures = new Set<string>();
    const settledPayoutIds: string[] = [];
    const externalPlans = instruction.transaction_batches.map((plan) => ({...plan, payouts: external.filter((payout) => plan.payout_ids.includes(payout.payout_id))})).filter((plan) => plan.payouts.length > 0);
    requireEvidence(batches.length === externalPlans.length, "Every external batch must be present exactly once; treasury holds cannot supply payout evidence.");
    for (const plan of externalPlans) {
      const matches = batches.filter((batch) => batch.batch_index === plan.transaction_index);
      const batch = matches[0];
      requireEvidence(matches.length === 1 && batch && batch.status === "finalized" && batch.transaction_signature && batch.transaction_signature !== record.funding_signature && !signatures.has(batch.transaction_signature) && same(batch.payout_ids, plan.payouts.map((payout) => payout.payout_id)) && batch.amount_usdc_atomic === plan.payouts.reduce((sum, payout) => sum + BigInt(payout.amount_usdc_atomic), 0n).toString(),
        "External payouts require distinct finalized, quote-bound batch receipts.");
      signatures.add(batch.transaction_signature);
      for (const payout of plan.payouts) requireEvidence(await readers.verifyPayout(batch, payout, instruction.settlement_id), "Every external payout must independently match its finalized Mainnet transaction.");
      settledPayoutIds.push(...batch.payout_ids);
    }
    const response = RealizeSettlementResponseV1Schema.parse(record.settlement_response);
    const hasHeld = BigInt(heldAmount) > 0n;
    const hasExternal = BigInt(externallyPaidAmount) > 0n;
    requireEvidence(response.settlement_id === instruction.settlement_id && response.held_amount_usdc_atomic === heldAmount && response.settled_amount_usdc_atomic === externallyPaidAmount && response.failed_payout_ids.length === 0 && same([...response.settled_payout_ids].sort(), [...settledPayoutIds].sort()) && same([...response.transaction_signatures].sort(), [...signatures].sort()) && response.status === (hasHeld ? hasExternal ? "partial" : "processing" : "settled") && record.settlement_status === (hasHeld ? hasExternal ? "partial" : "pending" : "settled") && ledger.state === (hasHeld ? hasExternal ? "partial" : "active" : "settled") && (hasHeld ? record.commission.state === "COMPLETED" && record.commission.payment_state === "captured" : record.commission.state === "SETTLED" && record.commission.payment_state === "settled"),
      "Treasury-held liabilities must remain explicitly held and cannot be reported as completed external payouts.");
    const account = projectCharacterAccountTransaction(record, quote, PRODUCTION_REALIZE_TREASURY);
    requireEvidence(account && same(account, documents.character_account_transaction), "The persisted character-owner ledger entry must match the existing accounting projection.");
  });
  return {
    status: checks.every((entry) => entry.status === "verified") ? "evidence-complete" as const : "incomplete" as const,
    commission_id: trust.commissionId,
    network_id: NETWORK,
    checks,
    ...(heldAmount === undefined ? {} : {held_amount_usdc_atomic: heldAmount}),
    ...(externallyPaidAmount === undefined ? {} : {external_payout_amount_usdc_atomic: externallyPaidAmount}),
    limitations: ["Provider billing count and global treasury solvency are not established by this single-commission check.", "Treasury-held amounts remain liabilities; they are not external payouts."]
  };
}

export async function verifyRealizeArtifact(output: FulfillmentResultV1["outputs"][number], configuration: RealizeCreatorPayoutConfigurationV1, trustedArtifactHosts: readonly string[] = ["cruelty.cam"]): Promise<void> {
  const url = new URL(output.uri);
  const hosts = new Set([new URL(configuration.populi_api_base_url).hostname, ...configuration.artifact_hosts]);
  const hostname = url.hostname.toLowerCase();
  requireEvidence(url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") && hosts.has(hostname) && trustedArtifactHosts.includes(hostname) && isPublicArtifactHost(hostname) && output.byte_length > 0 && output.byte_length <= configuration.max_artifact_bytes, "Artifact URL or byte limit is outside the independently pinned provider hosts.");
  const response = await fetch(url, {method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000)});
  requireEvidence(response.ok && response.body && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === output.media_type.toLowerCase(), "Artifact response must match the recorded media type.");
  const digest = createHash("sha256");
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      requireEvidence(length <= output.byte_length && length <= configuration.max_artifact_bytes, "Artifact stream exceeds its declared byte limit.");
      digest.update(next.value);
    }
    requireEvidence(length === output.byte_length && digest.digest("hex") === output.sha256, "Fetched artifact bytes do not match the recorded hash and length.");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function isPublicArtifactHost(host: string): boolean {
  return isIP(host.replace(/^\[|\]$/g, "")) === 0 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes(".") && !host.endsWith(".") && !["localhost", "local", "internal", "test", "invalid", "example"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export async function readRealizeEvidenceDocuments(db: Pick<Firestore, "doc">, commissionId: string): Promise<RealizeEvidenceDocuments> {
  const read = async (path: string) => (await db.doc(path).get()).data();
  const record = await read(`vox_realize_commissions/${docId(commissionId)}`) as RealizeCommissionRecord | undefined;
  if (!record) return {};
  const quote = record.commission.quote_id ? await read(`vox_realize_quotes/${docId(record.commission.quote_id)}`) : undefined;
  const configurationVersion = (quote as {payout_configuration_version?: number} | undefined)?.payout_configuration_version;
  const configuration = configurationVersion ? await read(`vox_realize_payout_configurations/${docId(record.commission.creator_id)}:v${String(configurationVersion).padStart(8, "0")}`) : undefined;
  const provenance = record.provenance_record_id ? await read(`vox_realize_public_provenance/${docId(record.provenance_record_id)}`) : undefined;
  const funding_claim = record.funding_signature ? await read(`vox_realize_payment_signatures/${sha256(record.funding_signature)}`) : undefined;
  const settlementPath = record.settlement_instruction ? `vox_realize_settlement_records/${sha256(record.settlement_instruction.settlement_id)}` : undefined;
  const settlement = settlementPath ? await read(settlementPath) : undefined;
  const settlement_lock = record.payment_intent ? await read(`vox_realize_settlement_records/payment-${sha256(record.payment_intent.payment_intent_id)}`) : undefined;
  const batches = settlementPath ? (await db.doc(settlementPath).collection("batches").limit(65).get()).docs.map((entry) => entry.data()) : undefined;
  const character_account_transaction = await read(`vox_realize_character_accounts/${docId(record.commission.creator_id)}/transactions/${docId(commissionId)}`);
  return {record, ...(quote ? {quote} : {}), ...(configuration ? {configuration} : {}), ...(provenance ? {provenance} : {}), ...(funding_claim ? {funding_claim: funding_claim as NonNullable<RealizeEvidenceDocuments["funding_claim"]>} : {}), ...(settlement ? {settlement: settlement as SettlementRecord} : {}), ...(settlement_lock ? {settlement_lock: settlement_lock as NonNullable<RealizeEvidenceDocuments["settlement_lock"]>} : {}), ...(batches ? {batches: batches as SettlementBatchRecord[]} : {}), ...(character_account_transaction ? {character_account_transaction} : {})};
}

async function main() {
  const {values} = parseArgs({options: {"commission-id": {type: "string"}, "issuer-id": {type: "string"}, "issuer-public-key": {type: "string"}, "database-id": {type: "string", default: "(default)"}, "provider-origin": {type: "string", default: "https://cruelty.cam"}, "artifact-host": {type: "string", multiple: true}, "rpc-url": {type: "string", default: "https://api.mainnet-beta.solana.com"}, help: {type: "boolean"}}, strict: true});
  if (values.help) {
    console.log("Read-only existing-commission verification. Usage: npx tsx scripts/verify-realize-mainnet.ts --commission-id ID --issuer-id ID --issuer-public-key TRUSTED_PUBLIC_KEY [--database-id '(default)'] [--provider-origin https://cruelty.cam] [--artifact-host trusted-cdn-host] [--rpc-url https://api.mainnet-beta.solana.com]\nUses existing Application Default Credentials for production project voxprotocol and the provider token named by the pinned configuration. Never reads Secret Manager, requests quotes, submits jobs or signs/broadcasts transactions. The public issuer key and any additional artifact host must be independently pinned, not taken from the quote or artifact being checked.");
    return;
  }
  requireEvidence(values["commission-id"] && values["issuer-id"] && values["issuer-public-key"], "Commission ID and independently trusted issuer ID/public key are required.");
  requireEvidence(!process.env.FIRESTORE_EMULATOR_HOST, "An emulator cannot supply live Mainnet evidence.");
  const provider = new URL(values["provider-origin"]!);
  requireEvidence(provider.href === "https://cruelty.cam/" && provider.origin === values["provider-origin"], "This production checker pins the existing https://cruelty.cam provider origin.");
  const rpc = new URL(values["rpc-url"]!);
  requireEvidence(rpc.protocol === "https:" && !rpc.username && !rpc.password && !rpc.hash && !rpc.search, "Mainnet RPC requires HTTPS without embedded credentials, query or fragment.");
  const trustedArtifactHosts = ["cruelty.cam", ...(values["artifact-host"] ?? [])];
  requireEvidence(trustedArtifactHosts.every(isPublicArtifactHost), "Additional artifact hosts must be independently trusted public DNS hostnames.");
  const db = new Firestore({projectId: "voxprotocol", databaseId: values["database-id"]!, preferRest: true});
  try {
    const documents = await readRealizeEvidenceDocuments(db, values["commission-id"]);
    const rail = new MainnetSplUsdcRealizePaymentRail({rpcUrl: rpc.href, treasuryOwner: PRODUCTION_REALIZE_TREASURY, treasuryTokenAccount: PRODUCTION_REALIZE_TREASURY_ATA, maxPaymentAtomic: "10000000000"});
    const result = await verifyRealizeMainnetEvidence(documents, {commissionId: values["commission-id"], issuerId: values["issuer-id"], issuerPublicKey: values["issuer-public-key"], providerOrigin: provider.origin}, {
      verifyFunding: (record) => rail.verifyFunding(record.direct_funding!, record.funding_signature!, record.payer_wallet!),
      getProviderFulfillment: (configuration, id) => new HttpPopuliRealizeClient().getFulfillment(configuration, id),
      verifyArtifact: (output, configuration) => verifyRealizeArtifact(output, configuration, trustedArtifactHosts),
      verifyPayout: async (batch, payout, settlementId) => {
        const prefix = `${NETWORK}:`;
        if (!payout.destination.startsWith(prefix)) return false;
        const owner = new PublicKey(payout.destination.slice(prefix.length));
        if (owner.toBase58() === PRODUCTION_REALIZE_TREASURY) return false;
        const memo = "vox:realize:treasury:v1:" + sha256(JSON.stringify([settlementId, batch.batch_index, batch.attempt_number ?? 1]));
        const receipt = await verifyFinalizedUsdcTransfer({rpc_url: rpc.href, transaction_signature: batch.transaction_signature!, network_id: NETWORK, usdc_mint: MAINNET_USDC_MINT, destination_token_account: getAssociatedTokenAddressSync(new PublicKey(MAINNET_USDC_MINT), owner).toBase58(), source_token_account: PRODUCTION_REALIZE_TREASURY_ATA, amount_atomic: payout.amount_usdc_atomic, payer_address: PRODUCTION_REALIZE_TREASURY, payment_reference: memo});
        return receipt.finalized && receipt.matched && receipt.network_matches === true && receipt.execution_failed !== true;
      }
    });
    console.log(JSON.stringify({...result, status: result.status !== "evidence-complete" ? "incomplete" : result.held_amount_usdc_atomic !== "0" ? "verified-delivery-with-treasury-liabilities" : "verified-delivery-and-external-settlement", observed_at: new Date().toISOString(), source: {project_id: "voxprotocol", database_id: values["database-id"], kind: "production-firestore-with-independent-rpc-and-provider-reads"}}, null, 2));
    if (result.status !== "evidence-complete") process.exitCode = 1;
  } finally { await db.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(JSON.stringify({status: "incomplete", reason: error instanceof MissingEvidence ? error.message : "Production evidence could not be read or validated. Existing read-only Firestore/provider access and a trusted issuer public key are required; no live acceptance was established."}));
    process.exitCode = 1;
  });
}

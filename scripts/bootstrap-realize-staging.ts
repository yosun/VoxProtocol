import {execFileSync} from "node:child_process";
import {createPrivateKey, randomUUID} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {createHuman} from "@vox/identity";
import {createThoughtIntent, signIntent} from "@vox/client";
import {computeRevenueRightsAgreementHash, generateKeyPair, parseSecretKey, publicKeyBase64, realizeClientRequestSigningPayload, secretKeyBase64, signBytes, signRightsAgreementAcceptance, verifyRealizeQuoteSignature} from "@vox/protocol";

const settings = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
if (settings.projectId === "voxprotocol" || settings.environment !== "staging" || !process.argv.includes("--apply")) throw new Error("Use --apply for the isolated staging fixture only");
function gcloud(args: string[], input?: string) { return execFileSync("gcloud", [...args, `--project=${settings.projectId}`, "--quiet"], {encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"]}); }
function secret(name: string) { return gcloud(["secrets", "versions", "access", "latest", `--secret=${name}`]).trim(); }
const service = JSON.parse(gcloud(["run", "services", "describe", settings.voxService, `--region=${settings.region}`, "--format=json"]));
const origin = service.status.url as string;
if (!origin.startsWith("https://vox-realize-staging-")) throw new Error("Refusing bootstrap outside the known staging service");
const internalToken = secret("vox-realize-staging-internal-token");
async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(origin + path, {method: body === undefined ? "GET" : "POST", headers: {"content-type": "application/json", ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60_000)});
  const result = await response.json();
  if (!response.ok) throw new Error(`Staging ${path} failed (${response.status}): ${result.code ?? "unknown"}: ${result.error ?? "request failed"}`);
  return result;
}
const fixtureSecret = "vox-realize-staging-fixture-identities";
let fixtures: Record<string, ReturnType<typeof createHuman>>;
const existing = JSON.parse(gcloud(["secrets", "list", "--format=json"])).some((item: {name: string}) => item.name.endsWith(`/${fixtureSecret}`));
if (existing) fixtures = JSON.parse(secret(fixtureSecret));
else {
  fixtures = Object.fromEntries(["owner", "provider", "platform", "commissioner"].map((role) => [role, createHuman({display_name: `Staging ${role}`, handle: `@stage-${role}`, description: "Disposable staging fixture; no production rights or funds."})]));
  gcloud(["secrets", "create", fixtureSecret, "--replication-policy=automatic"]);
  gcloud(["secrets", "versions", "add", fixtureSecret, "--data-file=-"], JSON.stringify(fixtures));
}
const bobResponse = await fetch(`https://vox.gold/v1/agents/${encodeURIComponent(settings.creatorId)}`, {signal: AbortSignal.timeout(20_000)});
if (!bobResponse.ok) throw new Error("Could not resolve Bob's public signed registration");
const bob = (await bobResponse.json()).registration;
await request("/v1/agents", bob);
for (const person of Object.values(fixtures)) await request("/v1/humans", person.registration);
// The existing authorized publisher signs a new, explicitly staged source post.
// Production records and production Cloud Run settings are never modified.
let publisherSecret: Uint8Array;
try {
  const encoded = secret("cruelty-vox-publisher-private-key-der");
  const key = createPrivateKey({key: Buffer.from(encoded, "base64"), format: "der", type: "pkcs8"});
  const jwk = key.export({format: "jwk"});
  publisherSecret = generateKeyPair(Buffer.from(jwk.d!, "base64url")).secretKey;
} catch { throw new Error("Could not load the authorized Bob publisher from Secret Manager"); }
const publisherKey = publicKeyBase64(generateKeyPair(publisherSecret.slice(0, 32)).publicKey);
if (!bob.publisher_keys.some((entry: {publisher_key: string; action: string}) => entry.publisher_key === publisherKey && entry.action === "authorize")) throw new Error("Staging source publisher is not authorized for Bob");
const stagedPosts = await request(`/v1/agents/${encodeURIComponent(settings.creatorId)}/posts`);
const priorSource = stagedPosts.items.find((post: any) => post.intent.client_post_id === "realize-staging-source-v1");
const source = priorSource ?? await request("/v1/posts", signIntent(createThoughtIntent({agent_id: settings.creatorId, author_key: publisherKey, client_post_id: "realize-staging-source-v1", text: "Realize staging test: Bob's special video. This post is an integration fixture, using Devnet test USDC and test-only rights."}), secretKeyBase64(publisherSecret)));
const agreementId = "rights:bob-realize-staging-v1";
const ownerId = fixtures.owner!.registration.human_id;
const providerId = fixtures.provider!.registration.human_id;
const platformId = fixtures.platform!.registration.human_id;
const required = [settings.creatorId, ownerId, providerId, platformId];
const agreement = {
  protocol_version: "realize/1", agreement_id: agreementId, version: 1,
  artifact_scope: {subject_type: "post", subject_id: source.post_id},
  parties: [{party_id: settings.creatorId, role: "creator"}, {party_id: ownerId, role: "character_owner"}, {party_id: providerId, role: "provider"}, {party_id: platformId, role: "platform"}, {party_id: "vox:role:commissioner", role: "commissioner"}],
  grant: {work_scope: "Integration testing and private review of staged Bob videos only. This fictional test agreement grants no production/commercial rights and conveys no ownership or real revenue participation.", rights: ["generate", "reproduce", "display"], license_type: "non_exclusive", territory: ["Worldwide"], attribution_required: false, starts_at: new Date(Date.now() - 60_000).toISOString()},
  revenue_definition: {basis: "net_received", description: "Staging test ledger only; no real revenue is eligible.", permitted_deductions: []}, eligible_transaction_types: ["commission"], allocations: [{beneficiary_id: ownerId, basis_points: 10_000}], duration: {starts_at: new Date(Date.now() - 60_000).toISOString()}, termination_conditions: ["mutual_consent"], modification_policy: {proposer_party_ids: [ownerId], required_acceptance_party_ids: required}, required_acceptance_party_ids: required, termination_policy: {authorized_party_ids: [ownerId], required_acceptance_party_ids: required}, provenance_references: [{category: "authorship", party_id: settings.creatorId, record_id: source.post_id}], attribution: [], acceptances: [], created_at: new Date().toISOString()
};
let rights;
try { rights = await request(`/v1/rights/agreements/${encodeURIComponent(agreementId)}`); }
catch { rights = await request("/v1/rights/agreements", agreement); }
if (rights.status !== "active") {
  const signers = [{id: settings.creatorId, keyId: `publisher:${publisherKey}`, publicKey: publisherKey, secretKey: publisherSecret}, ...[fixtures.owner!, fixtures.provider!, fixtures.platform!].map((person) => ({id: person.registration.human_id, keyId: "root", publicKey: person.registration.identity_public_key, secretKey: parseSecretKey(person.key_material.identitySecretKey)}))];
  for (const signer of signers) {
    if (rights.agreement.acceptances.some((acceptance: {party_id: string}) => acceptance.party_id === signer.id)) continue;
    const unsigned = {party_id: signer.id, key_id: signer.keyId, public_key: signer.publicKey, terms_hash: rights.terms_hash, accepted_at: new Date().toISOString()};
    rights = await request(`/v1/rights/agreements/${encodeURIComponent(agreementId)}/versions/1/acceptances`, {...unsigned, signature: signRightsAgreementAcceptance(agreementId, 1, unsigned, signer.secretKey)});
  }
}
publisherSecret.fill(0);
if (computeRevenueRightsAgreementHash(rights.agreement) !== rights.terms_hash || rights.status !== "active") throw new Error("Test rights agreement did not become active");
const payer = "45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr";
const ownerWallet = "4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL";
const recipients = (id: string, destination: string) => [{recipient_id: id, destination, basis_points: 10_000}];
const fee = (amount: string) => ({fixed_amount_usdc_atomic: amount, percent_basis_points: 0, minimum_amount_usdc_atomic: "0", percentage_basis: "provider_base"});
const policy = {protocol_version: "realize/1", creator_id: settings.creatorId, version: settings.payoutConfigurationVersion ?? 1, populi_api_base_url: settings.populiApiUrl, populi_api_token_env: "VOX_POPULI_API_TOKEN", artifact_hosts: [new URL(settings.populiApiUrl).hostname], rights_agreement_reference: agreementId, rights_agreement_version: 1, rights_subject_id: source.post_id, rights_agreement_hash: rights.terms_hash, usdc_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", network_id: "solana:devnet", settlement_program_version: "realize-escrow/2", funding_destination_token_account: "6xELJLdrSrw7bysNgnpT8BcMmB5aGRsG6VUiHBmqrwm1", quote_ttl_seconds: 300, provider_payouts: [{provider_id: "provider:video:example", recipients: recipients(providerId, payer)}], character_owner_id: ownerId, character_owner_markup: {fee: fee("200000"), recipients: recipients(ownerId, ownerWallet)}, platform_fee: {fee: fee("50000"), recipients: recipients(platformId, payer)}, additional_beneficiaries: []};
await request(`/v1/internal/realize/creators/${encodeURIComponent(settings.creatorId)}/payout-configurations`, policy, {"x-vox-internal-token": internalToken});
const commissioner = fixtures.commissioner!;
async function signed(path: string, body: unknown) {
  const timestamp = new Date().toISOString();
  const signature = signBytes(realizeClientRequestSigningPayload({method: "POST", path, principal_id: commissioner.registration.human_id, issued_at: timestamp, body}), parseSecretKey(commissioner.key_material.identitySecretKey));
  return {"x-vox-realize-human-id": commissioner.registration.human_id, "x-vox-realize-timestamp": timestamp, "x-vox-realize-signature": signature};
}
const parameters = {concept: "Bob's special video", duration_seconds: 6, style: "special", resolution: "480P"};
const body = {commissioner_id: commissioner.registration.human_id, creator_id: settings.creatorId, capability_id: "video:short-form", requested_generation_parameters: parameters, rights_agreement_reference: agreementId};
const idempotencyKey = randomUUID();
const commission = await request("/v1/realize/commissions", body, {...await signed("/v1/realize/commissions", {request: body, idempotency_key: idempotencyKey}), "idempotency-key": idempotencyKey});
const pricing = {protocol_version: "realize/1", request_id: `pricing:vox-staging:${randomUUID()}`, commission_id: commission.commission_id, requester_id: commissioner.registration.human_id, creator_id: settings.creatorId, capability_id: "video:short-form", generation_provider_id: "provider:video:example", requested_generation_parameters: parameters, rights_agreement_reference: agreementId, requested_at: new Date().toISOString()};
const result = await request("/v1/realize/pricing-requests", pricing, await signed("/v1/realize/pricing-requests", pricing));
const quote = result.quotes[0];
const health = await request("/v1/health");
if (!verifyRealizeQuoteSignature(quote, health.instance_public_key)) throw new Error("Staging VOX quote signature failed verification");
const evidence = {origin, sourcePostId: source.post_id, checkoutUrl: `${origin}/?realize=${encodeURIComponent(source.post_id)}`, creatorId: settings.creatorId, rightsAgreementId: agreementId, rightsHash: rights.terms_hash, commissionId: commission.commission_id, quoteId: quote.quote_id, quoteHash: quote.canonical_quote_hash, network: quote.network_id, quoteExpiresAt: quote.expires_at, providerBaseAtomic: quote.provider_base_price_usdc_atomic, ownerFeeAtomic: quote.character_owner_markup_usdc_atomic, platformFeeAtomic: quote.platform_fee_usdc_atomic, totalAtomic: quote.total_amount_usdc_atomic, payouts: quote.payout_recipients.map((item: any) => ({role: item.role, destination: item.destination, amountAtomic: item.amount_usdc_atomic})), status: "quoted-not-funded", note: "Real provider reservation and signed VOX quote; no escrow acceptance, wallet transaction or generation submitted."};
writeFileSync(new URL("../deployments/realize-staging-evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));

import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {AccountRole, address, type Instruction} from "@solana/kit";
import {Connection, Keypair, PublicKey, Transaction, TransactionInstruction} from "@solana/web3.js";
import {getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {assertConfigMatchesNetwork, configAddress, decodeConfigAccount, DEVNET_USDC_MINT, getEscrowInstruction, INSTRUCTIONS_SYSVAR, prepareEscrow, quoteVerificationInstruction, SETTLEMENT_NETWORKS, SYSTEM_PROGRAM, TOKEN_PROGRAM} from "@vox/realize-solana";
import {base64UrlToBytes, bytesToHex, parseSecretKey, realizeClientRequestSigningPayload, signBytes, verifyBytes, verifyProvenanceRecord, verifyRealizeQuoteSignature} from "@vox/protocol";
import {DevnetRealizeEscrowClient} from "../apps/api/src/realize-solana-devnet.js";

// The owner explicitly approved this one rehearsal on 2026-10-12. The fixed
// amounts, recipients, cluster and durable journal prevent broad or repeated use.
assert.ok(process.argv.includes("--execute-approved"), "Requires explicit approval of the documented, bounded rehearsal");
const settings = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
assert.equal(settings.projectId, "crueltycam");
assert.equal(settings.environment, "staging");
assert.equal(settings.network, "solana:devnet");
const journalPath = new URL("../.vox-local/realize-staging-rehearsal.json", import.meta.url);
const evidencePath = new URL("../deployments/realize-staging-evidence.json", import.meta.url);
const pendingPath = new URL("../.vox-local/realize-staging-pending-payment.json", import.meta.url);
let journal: any = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : undefined;
assert.ok(journal || !JSON.parse(readFileSync(evidencePath, "utf8")).fundingTransactionSignature, "Existing funding evidence requires its original journal; refuse a second paid rehearsal");
if (journal?.proof) {
  console.log(JSON.stringify(journal.proof, null, 2));
  process.exit(0);
}
if (!journal) execFileSync(process.execPath, ["--import", "tsx", "scripts/prepare-realize-staging-payment.ts"], {stdio: ["ignore", "pipe", "pipe"]});
const pending = journal?.pending ?? JSON.parse(readFileSync(pendingPath, "utf8"));
const origin = "https://vox-realize-staging-icin5yj4aa-ue.a.run.app";
assert.equal(pending.origin, origin);
const payer = "45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr";
const owner = "4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL";
const expectedPayouts = [{recipient: payer, amount_usdc_atomic: "750000"}, {recipient: owner, amount_usdc_atomic: "200000"}, {recipient: payer, amount_usdc_atomic: "50000"}];
const fixtures = JSON.parse(execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-fixture-identities", "--project=crueltycam"], {encoding: "utf8"}));
const commissioner = fixtures.commissioner;
const path = `/v1/realize/commissions/${encodeURIComponent(pending.commissionId)}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(requestPath: string, body?: unknown) {
  const method = body === undefined ? "GET" : "POST";
  const issued_at = new Date().toISOString();
  const principal_id = commissioner.registration.human_id;
  const signature = signBytes(realizeClientRequestSigningPayload({method, path: requestPath, principal_id, issued_at, ...(body === undefined ? {} : {body})}), parseSecretKey(commissioner.key_material.identitySecretKey));
  const response = await fetch(origin + requestPath, {method, headers: {"content-type": "application/json", "x-vox-realize-human-id": principal_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signature}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60_000)});
  const result = await response.json();
  if (!response.ok) throw new Error(`Staging request ${response.status}: ${result.code ?? "unknown"}: ${result.error ?? ""}`);
  return result;
}
const health = await (await fetch(origin + "/v1/health")).json();
assert.equal(health.instance_id, "instance:vox-realize-staging");
const quote = pending.quote;
const funding = pending.funding;
assert.ok(verifyRealizeQuoteSignature(quote, health.instance_public_key));
assert.equal(quote.network_id, "solana:devnet");
assert.equal(quote.usdc_mint, DEVNET_USDC_MINT);
assert.equal(quote.total_amount_usdc_atomic, "1000000");
assert.equal(quote.provider_base_price_usdc_atomic, "750000");
assert.deepEqual(quote.requested_generation_parameters, {concept: "Bob's special video", duration_seconds: 6, style: "special", resolution: "768P"});
assert.deepEqual(quote.payout_recipients.map((p: any) => ({recipient: p.destination.replace(/^solana:devnet:/, ""), amount_usdc_atomic: p.amount_usdc_atomic})), expectedPayouts);
assert.deepEqual(funding.payouts, expectedPayouts);
assert.equal(funding.payer_wallet, payer);
assert.equal(funding.network_id, "solana:devnet");
assert.equal(funding.amount_usdc_atomic, "1000000");
const network = {...SETTLEMENT_NETWORKS.devnet, active: true};
assert.equal(funding.program_id, network.programId);
assert.equal(funding.rpc_url, network.rpcEndpoint);
const connection = new Connection(network.rpcEndpoint, "confirmed");
const payerKey = new PublicKey(payer);
const mint = new PublicKey(DEVNET_USDC_MINT);
const payerAta = getAssociatedTokenAddressSync(mint, payerKey);
const ownerAta = getAssociatedTokenAddressSync(mint, new PublicKey(owner));
function save() { writeFileSync(journalPath, JSON.stringify(journal, null, 2), {mode: 0o600}); }
function publicEvidence(extra: any) {
  const current = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(current.commissionId, pending.commissionId, "Do not overwrite evidence for a different quote");
  writeFileSync(evidencePath, JSON.stringify({...current, liveRehearsalApproval: "approved", ...extra}, null, 2) + "\n");
}
if (!journal) {
  assert.ok(Date.parse(quote.expires_at) > Date.now() + 60_000, "Quote must have time for finalization and provider reservation");
  assert.equal(await connection.getAccountInfo(new PublicKey(funding.escrow)), null, "Do not submit a second funding transaction");
  const program = address(network.programId!);
  const configPda = await configAddress(program);
  const rawConfig = await connection.getAccountInfo(new PublicKey(configPda));
  assert.ok(rawConfig);
  const config = decodeConfigAccount(program, address(rawConfig.owner.toBase58()), configPda, rawConfig.data);
  assertConfigMatchesNetwork(network, config);
  const prepared = await prepareEscrow({quote, commission: pending.commission, authorizedIssuerPublicKey: health.instance_public_key, network, config, payer: address(payer), nowSeconds: BigInt(Math.floor(Date.now() / 1000)), refundAfter: BigInt(funding.refund_after)});
  assert.equal(prepared.accounts.escrow, funding.escrow);
  assert.equal(prepared.commitmentHex, funding.commitment);
  assert.equal(bytesToHex(prepared.quoteDomainHash), funding.quote_domain_hash);
  assert.ok(verifyBytes(prepared.quoteDomainHash, funding.quote_domain_signature, new PublicKey(network.quoteAuthority!).toBytes()));
  const instructions = [quoteVerificationInstruction(address(network.quoteAuthority!), base64UrlToBytes(funding.quote_domain_signature), prepared.quoteDomainHash), getEscrowInstruction("create_escrow", {payer: address(payer), config: prepared.accounts.config, escrow: prepared.accounts.escrow, quote_used: prepared.accounts.quoteUsed, mint: DEVNET_USDC_MINT, vault: prepared.accounts.vault, token_program: TOKEN_PROGRAM, instructions: INSTRUCTIONS_SYSVAR, system_program: SYSTEM_PROGRAM}, {args: prepared.createArgs}, program), getEscrowInstruction("append_payouts", {payer: address(payer), escrow: prepared.accounts.escrow}, {payouts: prepared.payouts}, program), getEscrowInstruction("seal", {payer: address(payer), escrow: prepared.accounts.escrow}, {}, program), getEscrowInstruction("fund", {payer: address(payer), config: prepared.accounts.config, escrow: prepared.accounts.escrow, mint: DEVNET_USDC_MINT, source: address(payerAta.toBase58()), vault: prepared.accounts.vault, token_program: TOKEN_PROGRAM}, {}, program)];
  function legacy(i: Instruction) { return new TransactionInstruction({programId: new PublicKey(i.programAddress), keys: (i.accounts ?? []).map((a) => ({pubkey: new PublicKey(a.address), isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER, isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER})), data: Buffer.from(i.data ?? [])}); }
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({feePayer: payerKey, ...blockhash}).add(...instructions.map(legacy));
  const simulation = await connection.simulateTransaction(transaction);
  assert.equal(simulation.value.err, null, JSON.stringify(simulation.value.err));
  const [solBefore, payerToken, ownerToken, fee, rent] = await Promise.all([connection.getBalance(payerKey, "finalized"), getAccount(connection, payerAta, "finalized"), getAccount(connection, ownerAta, "finalized"), connection.getFeeForMessage(transaction.compileMessage()), Promise.all([2986, 165, 100].map((size) => connection.getMinimumBalanceForRentExemption(size)))]);
  assert.ok(payerToken.owner.equals(payerKey) && payerToken.mint.equals(mint));
  assert.ok(ownerToken.owner.equals(new PublicKey(owner)) && ownerToken.mint.equals(mint));
  assert.ok(payerToken.amount >= 1_000_000n);
  assert.ok(rent.reduce((a, b) => a + b, 0) + (fee.value ?? 10000) + 100_000 < 30_000_000, "Budget must also reserve fees for fulfillment and all claims");
  assert.ok(solBefore > 30_000_000);
  const signerPath = new URL("../.vox-local/realize-devnet/fee-payer.json", import.meta.url);
  assert.equal(statSync(signerPath).mode & 0o077, 0, "Existing disposable signer must stay private");
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(signerPath, "utf8"))));
  assert.equal(signer.publicKey.toBase58(), payer);
  transaction.sign(signer);
  signer.secretKey.fill(0);
  const serialized = transaction.serialize().toString("base64");
  journal = {pending, startedAt: new Date().toISOString(), approval: {testUsdcAtomic: "1000000", maxSolLamports: 30000000, maxProviderUsd: "0.75", payer, expectedPayouts}, signedTransaction: serialized, blockhash, baseline: {solLamports: solBefore, payerTokenAtomic: payerToken.amount.toString(), ownerTokenAtomic: ownerToken.amount.toString()}, simulation: {err: simulation.value.err, unitsConsumed: simulation.value.unitsConsumed}, state: "signed-not-submitted"};
  save();
}
if (!journal.transactionSignature) {
  // Rebroadcasting these identical signed bytes produces the same transaction.
  const signature = await connection.sendRawTransaction(Buffer.from(journal.signedTransaction, "base64"), {skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3});
  journal.transactionSignature = signature;
  journal.state = "funding-submitted";
  save();
  publicEvidence({status: "funding-submitted", fundingTransactionSignature: signature, note: "One approved Devnet funding transaction submitted; fulfillment and settlement are still being verified."});
  console.log(JSON.stringify({stage: "funding-submitted", signature, commissionId: pending.commissionId}));
}
const recordedFunding = (await connection.getSignatureStatuses([journal.transactionSignature], {searchTransactionHistory: true})).value[0];
if (recordedFunding?.confirmationStatus === "finalized") {
  assert.equal(recordedFunding.err, null, "Funding transaction failed");
} else {
  const confirmation = await connection.confirmTransaction({...journal.blockhash, signature: journal.transactionSignature}, "finalized");
  assert.equal(confirmation.value.err, null, "Funding transaction failed");
}
journal.state = "funding-finalized";
save();
console.log(JSON.stringify({stage: "funding-finalized", signature: journal.transactionSignature}));
await request(`${path}/fund`, {payer_wallet: payer, transaction_signature: journal.transactionSignature});
const deadline = Date.now() + 20 * 60_000;
let status: any;
let previous = "";
do {
  status = await request(path);
  journal.latestStatus = status;
  journal.state = status.commission.state;
  save();
  const progress = `${status.commission.state}/${status.commission.fulfillment_state}/${status.settlement_status}`;
  if (progress !== previous) { console.log(JSON.stringify({stage: "tracking", progress, failure: status.failure_reason ?? null})); previous = progress; }
  if (status.commission.state === "SETTLED") break;
  assert.ok(!["FAILED", "REFUND_PENDING", "REFUNDED", "EXPIRED"].includes(status.commission.state), `Rehearsal needs recovery: ${progress}: ${status.failure_reason ?? ""}`);
  await delay(6_000);
} while (Date.now() < deadline);
assert.equal(status.commission.state, "SETTLED", "Rehearsal exceeded its observation deadline; resume the same journal rather than creating another paid job");
assert.equal(status.commission.payment_state, "settled");
assert.equal(status.commission.fulfillment_state, "completed");
assert.equal(status.settlement_status, "settled");
const provenance = await (await fetch(origin + `/v1/realize/provenance/${encodeURIComponent(status.provenance_record_id)}`)).json();
assert.ok(verifyProvenanceRecord(provenance, base64UrlToBytes(health.instance_public_key)));
assert.equal(provenance.quote_hash, quote.canonical_quote_hash);
assert.equal(provenance.commission_id, pending.commissionId);
const artifacts = [];
for (const output of status.fulfillment_result.outputs) {
  const url = new URL(output.uri);
  assert.equal(url.origin, settings.populiApiUrl);
  assert.equal(url.pathname, "/v1/realize/artifacts");
  assert.equal(url.searchParams.get("fulfillment_request_id"), status.commission.fulfillment_request_id);
  assert.equal(url.username + url.password + url.hash, "");
  const response = await fetch(url, {redirect: "error", signal: AbortSignal.timeout(60_000)});
  assert.ok(response.ok);
  assert.equal(response.headers.get("content-type")?.split(";")[0], output.media_type);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, output.byte_length);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), output.sha256);
  assert.ok(provenance.outputs.some((p: any) => p.sha256 === output.sha256 && p.byte_length === output.byte_length));
  artifacts.push(output);
}
assert.ok(artifacts.length > 0);
const readOnlyEscrow = new DevnetRealizeEscrowClient({VOX_REALIZE_DEVNET_ENABLED: "true", VOX_REALIZE_DEVNET_PROGRAM_ID: network.programId!, VOX_REALIZE_DEVNET_ADMIN: network.admin!, VOX_REALIZE_DEVNET_QUOTE_AUTHORITY: network.quoteAuthority!, VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY: network.fulfillmentAuthority!});
const escrow = await readOnlyEscrow.fundingProgress(funding);
assert.equal(escrow.status, "Settled");
assert.equal(escrow.paid_usdc_atomic, "1000000");
assert.equal(escrow.claimed_bitmap, "7");
const [payerAfter, ownerAfter, vault, solAfter] = await Promise.all([getAccount(connection, payerAta, "finalized"), getAccount(connection, ownerAta, "finalized"), getAccount(connection, new PublicKey(funding.vault), "finalized"), connection.getBalance(payerKey, "finalized")]);
assert.equal(payerAfter.amount - BigInt(journal.baseline.payerTokenAtomic), -200_000n);
assert.equal(ownerAfter.amount - BigInt(journal.baseline.ownerTokenAtomic), 200_000n);
assert.equal(vault.amount, 0n);
const solSpent = journal.baseline.solLamports - solAfter;
assert.ok(solSpent <= 30_000_000, "Actual rehearsal exceeded approved fee/rent budget");
const proof = {status: "live-rehearsal-passed", completedAt: new Date().toISOString(), fundingTransactionSignature: journal.transactionSignature, commissionState: status.commission.state, fulfillmentRequestId: status.commission.fulfillment_request_id, artifacts, provenanceRecordId: status.provenance_record_id, provenanceSignatureVerified: true, escrow, payerTokenDeltaAtomic: "-200000", ownerTokenDeltaAtomic: "200000", vaultBalanceAtomic: "0", actualPayerSolLamports: solSpent, settlement: status.settlement_response, note: "Approved live staging funding, actual video generation, byte hash/provenance verification and all three Devnet payouts passed."};
journal.proof = proof;
save();
publicEvidence(proof);
writeFileSync(new URL("../deployments/realize-staging-rehearsal-proof.json", import.meta.url), readFileSync(evidencePath));
console.log(JSON.stringify(proof, null, 2));

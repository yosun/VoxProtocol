import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {AccountRole, address, type Instruction} from "@solana/kit";
import {Connection, Keypair, PublicKey, Transaction, TransactionInstruction} from "@solana/web3.js";
import {getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {parseSecretKey, realizeClientRequestSigningPayload, signBytes} from "@vox/protocol";
import {ASSOCIATED_TOKEN_PROGRAM, DEVNET_USDC_MINT, getEscrowInstruction, SETTLEMENT_NETWORKS, TOKEN_PROGRAM} from "@vox/realize-solana";
import {DevnetRealizeEscrowClient} from "../apps/api/src/realize-solana-devnet.js";

assert.ok(process.argv.includes("--execute-approved"), "Requires the owner's explicit approval of the prepared staging refund bounds");
const settings = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
assert.equal(settings.projectId, "crueltycam");
assert.equal(settings.environment, "staging");
assert.equal(settings.network, "solana:devnet");
assert.equal(settings.mainnetEnabled, false);
const pendingPath = new URL("../.vox-local/realize-staging-refund-pending.json", import.meta.url);
const evidencePath = new URL("../deployments/realize-staging-refund-evidence.json", import.meta.url);
const journalPath = new URL("../.vox-local/realize-staging-refund-rehearsal.json", import.meta.url);
const proofPath = new URL("../deployments/realize-staging-refund-rehearsal-proof.json", import.meta.url);
assert.ok(existsSync(pendingPath), "Prepare and simulate the no-render refund payment first");
const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
assert.equal(pending.noRenderFailureArmed, true, "The failure must be armed before funding");
assert.equal(evidence.noRenderFailureArmed, true);
assert.equal(pending.origin, evidence.origin);
assert.equal(pending.commissionId, evidence.commissionId);
assert.equal(pending.quote.network_id, "solana:devnet");
assert.equal(pending.quote.usdc_mint, DEVNET_USDC_MINT);
const amountAtomic = BigInt(pending.quote.total_amount_usdc_atomic);
assert.ok(amountAtomic > 0n && amountAtomic <= 10_000_000_000n);
assert.equal(pending.funding.amount_usdc_atomic, amountAtomic.toString());
assert.equal(pending.funding.payer_wallet, pending.payer);
assert.equal(pending.funding.network_id, "solana:devnet");
const maxPayerSolLamports = 30_000_000n;
const serviceOrigin = "https://vox-realize-staging-icin5yj4aa-ue.a.run.app";
assert.equal(pending.origin, serviceOrigin, "Refuse a non-staging service origin");

const fixtureOutput = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-fixture-identities", `--project=${settings.projectId}`], {encoding: "utf8"});
const fixtures = JSON.parse(fixtureOutput);
const commissioner = fixtures.commissioner;
const stagingOperator = fixtures.owner;
const internalToken = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-internal-token", `--project=${settings.projectId}`], {encoding: "utf8"}).trim();
const payerKeyPath = new URL("../.vox-local/realize-devnet/fee-payer.json", import.meta.url);
assert.equal(statSync(payerKeyPath).mode & 0o077, 0, "Staging payer signer must remain private");
const payerSigner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerKeyPath, "utf8"))));
assert.equal(payerSigner.publicKey.toBase58(), pending.payer, "Only the previously prepared staging payer may sign this rehearsal");

const network = {...SETTLEMENT_NETWORKS.devnet, active: true};
const connection = new Connection(network.rpcEndpoint, "finalized");
const program = address(network.programId!);
const payer = payerSigner.publicKey;
const payerAta = getAssociatedTokenAddressSync(new PublicKey(DEVNET_USDC_MINT), payer, false, TOKEN_PROGRAM_ID);
const escrowAddress = new PublicKey(pending.funding.escrow);
const escrowClient = new DevnetRealizeEscrowClient({
  VOX_REALIZE_DEVNET_ENABLED: "true",
  VOX_REALIZE_DEVNET_PROGRAM_ID: network.programId!,
  VOX_REALIZE_DEVNET_ADMIN: network.admin!,
  VOX_REALIZE_DEVNET_QUOTE_AUTHORITY: network.quoteAuthority!,
  VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY: network.fulfillmentAuthority!
});
const commissionPath = `/v1/realize/commissions/${encodeURIComponent(pending.commissionId)}`;
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const encodeBase58 = (bytes: Uint8Array): string => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let output = "";
  while (value > 0n) { const remainder = Number(value % 58n); output = alphabet[remainder]! + output; value /= 58n; }
  return "1".repeat(zeroes) + output;
};
function kitInstruction(instruction: Instruction): TransactionInstruction {
  return new TransactionInstruction({programId: new PublicKey(instruction.programAddress), keys: (instruction.accounts ?? []).map((item) => ({pubkey: new PublicKey(item.address), isSigner: item.role === AccountRole.READONLY_SIGNER || item.role === AccountRole.WRITABLE_SIGNER, isWritable: item.role === AccountRole.WRITABLE || item.role === AccountRole.WRITABLE_SIGNER})), data: Buffer.from(instruction.data ?? [])});
}
function saveJournal(journal: any) { writeFileSync(journalPath, JSON.stringify(journal, null, 2), {mode: 0o600}); }
async function signedRequest(path: string, body?: unknown, internal = false, principal = commissioner) {
  const issued_at = new Date().toISOString();
  const principal_id = principal.registration.human_id;
  const signature = signBytes(realizeClientRequestSigningPayload({method: body === undefined ? "GET" : "POST", path, principal_id, issued_at, ...(body === undefined ? {} : {body})}), parseSecretKey(principal.key_material.identitySecretKey));
  const response = await fetch(pending.origin + path, {method: body === undefined ? "GET" : "POST", headers: {"content-type": "application/json", "x-vox-realize-human-id": principal_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signature, ...(internal ? {"x-vox-internal-token": internalToken} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60_000)});
  const result = await response.json();
  assert.ok(response.ok, `Staging request failed: ${response.status}: ${result.code ?? "unknown"}: ${result.error ?? ""}`);
  return result;
}
async function submitStoredTransaction(rawBase64: string, signature: string, blockhash: string, lastValidBlockHeight: number) {
  const status = (await connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
  if (status?.confirmationStatus === "finalized") { assert.equal(status.err, null); return; }
  if (!status && await connection.getBlockHeight("finalized") > lastValidBlockHeight) throw new Error(`Transaction ${signature} is inconclusive after blockhash expiry; do not create a replacement`);
  if (!status) {
    const returned = await connection.sendRawTransaction(Buffer.from(rawBase64, "base64"), {skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3});
    assert.equal(returned, signature, "Rebroadcast must be the exact persisted signed transaction");
  }
  const confirmation = await connection.confirmTransaction({signature, blockhash, lastValidBlockHeight}, "finalized");
  assert.equal(confirmation.value.err, null);
}

let journal: any = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : undefined;
if (journal?.proof) { console.log(JSON.stringify(journal.proof, null, 2)); process.exit(0); }
if (journal && journal.commissionId !== pending.commissionId) throw new Error("An unfinished refund rehearsal journal belongs to another commission; reconcile it before starting anything new");
assert.ok(Date.parse(pending.quote.expires_at) > Date.now() + 60_000, "Prepared quote must have at least one minute remaining");
const existingEscrow = await connection.getAccountInfo(escrowAddress, "finalized");
if (existingEscrow && !journal) throw new Error("An existing escrow has no matching durable journal; refuse to submit another funding transaction");

if (!journal) {
  assert.equal(await connection.getAccountInfo(escrowAddress, "finalized"), null, "Refusing to create another funded staging escrow");
  const balance = await getAccount(connection, payerAta, "finalized", TOKEN_PROGRAM_ID);
  assert.equal(balance.mint.toBase58(), DEVNET_USDC_MINT);
  assert.equal(balance.owner.toBase58(), payer.toBase58());
  assert.ok(balance.amount >= amountAtomic, "Prepared payer has insufficient Devnet USDC");
  const solBefore = await connection.getBalance(payer, "finalized");
  const fresh = await connection.getLatestBlockhash("finalized");
  const fundingTransaction = Transaction.from(Buffer.from(pending.unsignedTransaction, "base64"));
  fundingTransaction.feePayer = payer;
  fundingTransaction.recentBlockhash = fresh.blockhash;
  fundingTransaction.sign(payerSigner);
  const fundingSimulation = await connection.simulateTransaction(fundingTransaction);
  assert.equal(fundingSimulation.value.err, null, JSON.stringify(fundingSimulation.value.err));
  const fee = await connection.getFeeForMessage(fundingTransaction.compileMessage(), "finalized");
  assert.ok(BigInt(fee.value ?? 10_000) <= maxPayerSolLamports);
  const signature = encodeBase58(fundingTransaction.signature!);
  journal = {commissionId: pending.commissionId, origin: pending.origin, approvalBounds: {cluster: "solana:devnet", usdcMint: DEVNET_USDC_MINT, amountUsdcAtomic: amountAtomic.toString(), payerWallet: payer.toBase58(), escrow: pending.funding.escrow, maxPayerSolLamports: maxPayerSolLamports.toString()}, baseline: {payerSolLamports: solBefore, payerUsdcAtomic: balance.amount.toString()}, fundingTransaction: {signature, rawBase64: fundingTransaction.serialize().toString("base64"), blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight, simulatedUnits: fundingSimulation.value.unitsConsumed, feeLamports: fee.value ?? 10_000, estimatedRentLamports: evidence.estimatedAccountRentLamports ?? 0}, state: "prepared"};
  saveJournal(journal);
}

await submitStoredTransaction(journal.fundingTransaction.rawBase64, journal.fundingTransaction.signature, journal.fundingTransaction.blockhash, journal.fundingTransaction.lastValidBlockHeight);
journal.state = "funding-finalized";
saveJournal(journal);
const statusBeforeFund = await signedRequest(commissionPath);
if (!statusBeforeFund.commission.fulfillment_request_id) {
  await signedRequest(`${commissionPath}/fund`, {payer_wallet: pending.payer, transaction_signature: journal.fundingTransaction.signature});
}
let status: any;
for (let attempt = 0; attempt < 12; attempt += 1) {
  status = await signedRequest(commissionPath);
  if (status.commission.state === "REFUND_PENDING") break;
  await delay(2_500);
}
assert.equal(status.commission.state, "REFUND_PENDING", "Funded no-render rehearsal must enter refund pending before any provider job");
assert.equal(status.failure_evidence?.source, "staging_no_render_test");
assert.equal(status.commission.fulfillment_request_id, undefined, "No generation request may be submitted for the armed failure");
assert.equal(status.fulfillment_result, undefined);
journal.state = "confirmed-no-render-failure";
journal.failureEvidence = status.failure_evidence;
saveJournal(journal);

const approvalPath = `/v1/internal/realize/commissions/${encodeURIComponent(pending.commissionId)}/refund-approval`;
const approvalBody = {payer_wallet: pending.payer, funding_signature: journal.fundingTransaction.signature, payment_intent_id: status.payment_intent.payment_intent_id, accepted_quote_hash: pending.quote.canonical_quote_hash, amount_usdc_atomic: amountAtomic.toString(), reason: "Approve the exact staging no-render failure refund rehearsal."};
journal.operatorApproval = {operator_human_id: stagingOperator.registration.human_id, ...approvalBody};
journal.state = "operator-approval-recorded-locally";
saveJournal(journal);
const approval = await signedRequest(approvalPath, approvalBody, true, stagingOperator);
assert.equal(approval.commission.state, "REFUND_PENDING");
assert.equal(approval.resolution_events.some((event: any) => event.action === "refund_approved" && event.actor_id === stagingOperator.registration.human_id), true);
journal.state = "operator-approved";
saveJournal(journal);

let escrowProgress = await escrowClient.fundingProgress(pending.funding);
assert.equal(escrowProgress.status, "Refundable");
assert.equal(escrowProgress.paid_usdc_atomic, "0");
const refundInstruction = getEscrowInstruction("refund", {payer: address(pending.payer), escrow: address(pending.funding.escrow), mint: DEVNET_USDC_MINT, vault: address(pending.funding.vault), destination: address(payerAta.toBase58()), token_program: TOKEN_PROGRAM, associated_token_program: ASSOCIATED_TOKEN_PROGRAM}, {}, program);
if (!journal.refundTransaction) {
  const latest = await connection.getLatestBlockhash("finalized");
  const transaction = new Transaction({feePayer: payer, recentBlockhash: latest.blockhash}).add(kitInstruction(refundInstruction));
  transaction.sign(payerSigner);
  const simulation = await connection.simulateTransaction(transaction);
  assert.equal(simulation.value.err, null, JSON.stringify(simulation.value.err));
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "finalized");
  assert.ok(BigInt(fee.value ?? 10_000) + BigInt(journal.fundingTransaction.feeLamports) + BigInt(journal.fundingTransaction.estimatedRentLamports) <= maxPayerSolLamports);
  const signature = encodeBase58(transaction.signature!);
  journal.refundTransaction = {signature, rawBase64: transaction.serialize().toString("base64"), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, simulatedUnits: simulation.value.unitsConsumed};
  journal.state = "refund-transaction-persisted";
  saveJournal(journal);
}
await submitStoredTransaction(journal.refundTransaction.rawBase64, journal.refundTransaction.signature, journal.refundTransaction.blockhash, journal.refundTransaction.lastValidBlockHeight);
journal.state = "refund-finalized";
saveJournal(journal);
await signedRequest(`${commissionPath}/refund`, {payer_wallet: pending.payer, transaction_signature: journal.refundTransaction.signature});
status = await signedRequest(commissionPath);
assert.equal(status.commission.state, "REFUNDED");
assert.equal(status.commission.payment_state, "refunded");
assert.equal(status.resolution_outcome, "refunded");
assert.equal(status.refund_response.transaction_signature, journal.refundTransaction.signature);
assert.equal(status.commission.fulfillment_request_id, undefined);
assert.equal(status.resolution_events.some((event: any) => event.action === "refund_approved"), true);
assert.equal(status.resolution_events.some((event: any) => event.action === "refund_finalized"), true);
escrowProgress = await escrowClient.fundingProgress(pending.funding);
assert.equal(escrowProgress.status, "Refunded");
assert.equal(escrowProgress.paid_usdc_atomic, "0");
const payerTokenAfter = await getAccount(connection, payerAta, "finalized", TOKEN_PROGRAM_ID);
assert.equal(payerTokenAfter.amount - BigInt(journal.baseline.payerUsdcAtomic), 0n, "Original payer must recover the full exact USDC amount");
const vaultToken = await getAccount(connection, new PublicKey(pending.funding.vault), "finalized", TOKEN_PROGRAM_ID);
assert.equal(vaultToken.amount, 0n);
const payerSolAfter = await connection.getBalance(payer, "finalized");
const payerSolSpent = BigInt(journal.baseline.payerSolLamports) - BigInt(payerSolAfter);
assert.ok(payerSolSpent <= maxPayerSolLamports, "Rehearsal exceeded the approved payer SOL ceiling");
const finalSignature = (await connection.getSignatureStatuses([journal.refundTransaction.signature], {searchTransactionHistory: true})).value[0];
assert.equal(finalSignature?.confirmationStatus, "finalized");
assert.equal(finalSignature?.err, null);
const proof = {status: "live-no-render-refund-rehearsal-passed", completedAt: new Date().toISOString(), commissionId: pending.commissionId, failureEvidence: status.failure_evidence, providerJobSubmitted: false, refundApproval: {operatorHumanId: stagingOperator.registration.human_id, approvalPayloadHash: (await signedRequest(commissionPath)).resolution_events.find((event: any) => event.action === "refund_approved")?.evidence_hash}, cluster: "solana:devnet", usdcMint: DEVNET_USDC_MINT, amountUsdcAtomic: amountAtomic.toString(), originalPayer: pending.payer, escrow: pending.funding.escrow, fundingSignature: journal.fundingTransaction.signature, refundSignature: journal.refundTransaction.signature, refundFinalized: true, payerUsdcDeltaAtomic: "0", payerSolSpentLamports: payerSolSpent.toString(), payerSolCeilingLamports: maxPayerSolLamports.toString(), vaultBalanceAtomic: vaultToken.amount.toString(), outcome: status.resolution_outcome, auditActions: status.resolution_events.map((event: any) => event.action)};
journal.proof = proof;
saveJournal(journal);
writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n", {mode: 0o600});
writeFileSync(evidencePath, JSON.stringify({...evidence, refundRehearsal: proof}, null, 2) + "\n");
console.log(JSON.stringify(proof, null, 2));

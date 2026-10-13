import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";
import {AccountRole, address, type Instruction} from "@solana/kit";
import {Connection, PublicKey, Transaction, TransactionInstruction} from "@solana/web3.js";
import {getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, unpackAccount} from "@solana/spl-token";
import {assertConfigMatchesNetwork, configAddress, decodeConfigAccount, DEVNET_USDC_MINT, getEscrowInstruction, INSTRUCTIONS_SYSVAR, prepareEscrow, quoteVerificationInstruction, SETTLEMENT_NETWORKS, SYSTEM_PROGRAM, TOKEN_PROGRAM} from "@vox/realize-solana";
import {base64UrlToBytes, bytesToHex, parseSecretKey, realizeClientRequestSigningPayload, signBytes, verifyBytes, verifyRealizeQuoteSignature} from "@vox/protocol";

// This command is deliberately incapable of signing a payer transaction or
// sending funds. It prepares reviewable evidence for the owner's live test.
const settings = JSON.parse(readFileSync(new URL("../deployments/realize-staging.json", import.meta.url), "utf8"));
const armNoRenderFailure = process.argv.includes("--arm-no-render-failure");
const evidencePath = new URL("../deployments/realize-staging-evidence.json", import.meta.url);
const outputEvidencePath = armNoRenderFailure ? new URL("../deployments/realize-staging-refund-evidence.json", import.meta.url) : evidencePath;
const pendingPaymentPath = armNoRenderFailure ? new URL("../.vox-local/realize-staging-refund-pending.json", import.meta.url) : new URL("../.vox-local/realize-staging-pending-payment.json", import.meta.url);
let evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (Date.parse(evidence.quoteExpiresAt) <= Date.now() + 60_000) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/bootstrap-realize-staging.ts", "--apply"], {stdio: ["ignore", "pipe", "pipe"]});
  evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
}
assert.equal(settings.environment, "staging");
assert.equal(settings.network, "solana:devnet");
assert.ok(evidence.origin.startsWith("https://vox-realize-staging-"));
const fixtures = JSON.parse(execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-fixture-identities", `--project=${settings.projectId}`], {encoding: "utf8"}));
const commissioner = fixtures.commissioner;
const stagingOperator = fixtures.owner;
const internalToken = armNoRenderFailure ? execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=vox-realize-staging-internal-token", `--project=${settings.projectId}`], {encoding: "utf8"}).trim() : undefined;
async function request(path: string, body?: unknown, extraHeaders: Record<string, string> = {}, principal = commissioner) {
  const method = body === undefined ? "GET" : "POST";
  const issued_at = new Date().toISOString();
  const principal_id = principal.registration.human_id;
  const signature = signBytes(realizeClientRequestSigningPayload({method, path, principal_id, issued_at, ...(body === undefined ? {} : {body})}), parseSecretKey(principal.key_material.identitySecretKey));
  const response = await fetch(evidence.origin + path, {method, headers: {"content-type": "application/json", "x-vox-realize-human-id": principal_id, "x-vox-realize-timestamp": issued_at, "x-vox-realize-signature": signature, ...extraHeaders}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60_000)});
  const result = await response.json();
  assert.ok(response.ok, `Staging request failed: ${response.status} ${result.code ?? "unknown"}: ${result.error ?? ""}`);
  return result;
}
const path = `/v1/realize/commissions/${encodeURIComponent(evidence.commissionId)}`;
const status = await request(path);
const quote = status.quote;
const health = await (await fetch(evidence.origin + "/v1/health")).json();
assert.ok(verifyRealizeQuoteSignature(quote, health.instance_public_key));
assert.equal(quote.network_id, "solana:devnet");
assert.equal(quote.usdc_mint, DEVNET_USDC_MINT);
assert.equal(quote.total_amount_usdc_atomic, "1000000");
const payer = "45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr";
const owner = "4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL";
assert.ok(quote.payout_recipients.every((recipient: any) => [payer, owner].map((wallet) => `solana:devnet:${wallet}`).includes(recipient.destination)));
const accepted = await request(`${path}/accept-quote`, {quote_id: quote.quote_id, canonical_quote_hash: quote.canonical_quote_hash, payer_wallet: payer, rights_reviewed: true});
const funding = accepted.funding;
assert.equal(funding.mode, "escrow");
let noRenderFailureArmed = false;
if (armNoRenderFailure) {
  const armPath = `/v1/internal/realize/commissions/${encodeURIComponent(evidence.commissionId)}/arm-no-render-failure`;
  const armed = await request(armPath, {reason: "Staging-only no-render failure/refund rehearsal"}, {"x-vox-internal-token": internalToken!}, stagingOperator);
  assert.equal(armed.no_render_failure_armed, true);
  assert.equal(armed.provider_job_submitted, false);
  noRenderFailureArmed = true;
}
const network = {...SETTLEMENT_NETWORKS.devnet, active: true};
const connection = new Connection(network.rpcEndpoint, "confirmed");
const program = address(network.programId!);
const configPda = await configAddress(program);
const rawConfig = await connection.getAccountInfo(new PublicKey(configPda), "confirmed");
assert.ok(rawConfig);
const config = decodeConfigAccount(program, address(rawConfig.owner.toBase58()), configPda, rawConfig.data);
assertConfigMatchesNetwork(network, config);
const prepared = await prepareEscrow({quote, commission: accepted.commission, authorizedIssuerPublicKey: health.instance_public_key, network, config, payer: address(payer), nowSeconds: BigInt(Math.floor(Date.now() / 1_000)), refundAfter: BigInt(funding.refund_after)});
assert.equal(prepared.accounts.escrow, funding.escrow);
assert.equal(prepared.commitmentHex, funding.commitment);
assert.equal(bytesToHex(prepared.quoteDomainHash), funding.quote_domain_hash);
assert.ok(verifyBytes(prepared.quoteDomainHash, funding.quote_domain_signature, new PublicKey(network.quoteAuthority!).toBytes()));
assert.deepEqual(prepared.payouts.map((payout) => ({recipient: payout.recipient, amount_usdc_atomic: payout.amount.toString()})), funding.payouts);
assert.equal(await connection.getAccountInfo(new PublicKey(funding.escrow)), null, "Only a new, unfunded escrow can be simulated here");
const source = getAssociatedTokenAddressSync(new PublicKey(DEVNET_USDC_MINT), new PublicKey(payer));
const sourceInfo = await connection.getAccountInfo(source);
assert.ok(sourceInfo);
assert.ok(sourceInfo.owner.equals(TOKEN_PROGRAM_ID));
const token = unpackAccount(source, sourceInfo, TOKEN_PROGRAM_ID);
assert.equal(token.mint.toBase58(), DEVNET_USDC_MINT);
assert.ok(token.owner.equals(new PublicKey(payer)));
assert.ok(token.amount >= 1_000_000n);
function legacy(instruction: Instruction): TransactionInstruction {
  return new TransactionInstruction({programId: new PublicKey(instruction.programAddress), keys: (instruction.accounts ?? []).map((account) => ({pubkey: new PublicKey(account.address), isSigner: account.role === AccountRole.READONLY_SIGNER || account.role === AccountRole.WRITABLE_SIGNER, isWritable: account.role === AccountRole.WRITABLE || account.role === AccountRole.WRITABLE_SIGNER})), data: Buffer.from(instruction.data ?? [])});
}
const instructions = [quoteVerificationInstruction(address(network.quoteAuthority!), base64UrlToBytes(funding.quote_domain_signature), prepared.quoteDomainHash), getEscrowInstruction("create_escrow", {payer: address(payer), config: prepared.accounts.config, escrow: prepared.accounts.escrow, quote_used: prepared.accounts.quoteUsed, mint: DEVNET_USDC_MINT, vault: prepared.accounts.vault, token_program: TOKEN_PROGRAM, instructions: INSTRUCTIONS_SYSVAR, system_program: SYSTEM_PROGRAM}, {args: prepared.createArgs}, program), getEscrowInstruction("append_payouts", {payer: address(payer), escrow: prepared.accounts.escrow}, {payouts: prepared.payouts}, program), getEscrowInstruction("seal", {payer: address(payer), escrow: prepared.accounts.escrow}, {}, program), getEscrowInstruction("fund", {payer: address(payer), config: prepared.accounts.config, escrow: prepared.accounts.escrow, mint: DEVNET_USDC_MINT, source: address(source.toBase58()), vault: prepared.accounts.vault, token_program: TOKEN_PROGRAM}, {}, program)];
const blockhash = await connection.getLatestBlockhash("confirmed");
const transaction = new Transaction({feePayer: new PublicKey(payer), ...blockhash}).add(...instructions.map(legacy));
transaction.setSigners(new PublicKey(payer));
const simulation = await connection.simulateTransaction(transaction);
assert.equal(simulation.value.err, null, JSON.stringify(simulation.value.err));
const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
const rent = (await Promise.all([2986, 165, 100].map((size) => connection.getMinimumBalanceForRentExemption(size)))).reduce((sum, value) => sum + value, 0);
const estimatedLamports = (fee.value ?? 5000) + rent;
assert.ok(estimatedLamports <= 30_000_000, "Payer SOL fees/rent exceed the proposed 0.03 Devnet SOL limit");
const unsignedTransaction = transaction.serialize({requireAllSignatures: false, verifySignatures: false}).toString("base64");
writeFileSync(pendingPaymentPath, JSON.stringify({origin: evidence.origin, commissionId: evidence.commissionId, quote, commission: accepted.commission, funding, payer, unsignedTransaction, blockhash, noRenderFailureArmed}, null, 2), {mode: 0o600});
const result = {...evidence, status: "simulated-not-funded", noRenderFailureArmed, escrow: funding.escrow, payer, tokenAccountBalanceAtomic: token.amount.toString(), simulation: {err: simulation.value.err, unitsConsumed: simulation.value.unitsConsumed, transactionBytes: Buffer.from(unsignedTransaction, "base64").length}, networkFeeLamports: fee.value, estimatedAccountRentLamports: rent, estimatedPayerSolLamports: estimatedLamports, proposedMaxPayerSolLamports: 30_000_000, actualTokenRecipients: funding.payouts, note: noRenderFailureArmed ? "Unsigned Devnet funding transaction simulated; internal staging no-render failure was armed before funding. No payer signature, blockchain transaction or provider generation was submitted." : "Unsigned Devnet transaction simulated successfully. No payer signature, blockchain transaction or generation was submitted."};
writeFileSync(outputEvidencePath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));

import {afterEach, describe, expect, it, vi} from "vitest";
import {Keypair, PublicKey, Transaction, TransactionInstruction} from "@solana/web3.js";
import {createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync} from "@solana/spl-token";
import {relayCheckoutRpc} from "../apps/api/src/realize-rpc.js";
import type {MainnetSplUsdcFundingAuthorization} from "../apps/api/src/realize-payment.js";

const payer = Keypair.fromSeed(new Uint8Array(32).fill(31));
const treasury = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey;
const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const source = getAssociatedTokenAddressSync(mint, payer.publicKey);
const destination = getAssociatedTokenAddressSync(mint, treasury);
const memo = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const funding = (): MainnetSplUsdcFundingAuthorization => ({mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: mint.toBase58(), destination_owner: treasury.toBase58(), destination_token_account: destination.toBase58(), payer_wallet: payer.publicKey.toBase58(), amount_usdc_atomic: "1000000", payment_reference: "vox:realize:payment:test-intent:test-hash", commission_id: "commission:rpc", quote_id: "quote:rpc", accepted_quote_hash: "a".repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString()});
const rpc = (method: string, params: unknown[] = []) => ({jsonrpc: "2.0", id: "rpc-test", method, params});
function transaction(extraSource = false) {
  const tx = new Transaction({feePayer: payer.publicKey, recentBlockhash: treasury.toBase58()});
  if (extraSource) tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, source, payer.publicKey, mint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destination, treasury, mint));
  tx.add(createTransferCheckedInstruction(source, mint, destination, payer.publicKey, 1_000_000n, 6));
  tx.add(new TransactionInstruction({programId: memo, keys: [], data: Buffer.from(funding().payment_reference)}));
  return tx;
}
const packet = (tx: Transaction, signed = true) => {
  if (signed) tx.partialSign(payer);
  return tx.serialize({requireAllSignatures: signed, verifySignatures: signed}).toString("base64");
};
function upstream() {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({jsonrpc: "2.0", id: request.id, result: 42}));
  });
}
afterEach(() => vi.unstubAllEnvs());

describe("bounded Mainnet checkout RPC", () => {
  it("uses the fixed upstream without forwarding browser Origin or authentication", async () => {
    const fetcher = upstream();
    await relayCheckoutRpc(rpc("getGenesisHash"), {fetcher});
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.mainnet-beta.solana.com/");
    expect(fetcher.mock.calls[0]![1]!.headers).toEqual({"content-type": "application/json", accept: "application/json"});
    expect(fetcher.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("permits payment account, fee, simulation and finality reads without broadcasting", async () => {
    const fetcher = upstream();
    const tx = transaction();
    const requests = [rpc("getAccountInfo", [source.toBase58(), {encoding: "base64", commitment: "confirmed"}]), rpc("getAccountInfo", [destination.toBase58(), {encoding: "base64"}]), rpc("getBalance", [payer.publicKey.toBase58(), {commitment: "confirmed"}]), rpc("getLatestBlockhash", [{commitment: "confirmed"}]), rpc("getBlockHeight", [{commitment: "confirmed"}]), rpc("getMinimumBalanceForRentExemption", [165, {commitment: "confirmed"}]), rpc("getFeeForMessage", [tx.serializeMessage().toString("base64"), {commitment: "confirmed"}]), rpc("simulateTransaction", [packet(tx, false), {encoding: "base64", commitment: "confirmed"}]), rpc("getSignatureStatuses", [["1".repeat(64)], {searchTransactionHistory: true}])];
    for (const request of requests) await relayCheckoutRpc(request, {funding: funding(), fetcher});
    expect(fetcher).toHaveBeenCalledTimes(requests.length);
    expect(fetcher.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).method !== "sendTransaction")).toBe(true);
  });

  for (const extraSource of [false, true]) it(`relays the exact signed authorized payment, optional source creation=${extraSource}`, async () => {
    const fetcher = upstream();
    const raw = packet(transaction(extraSource));
    await relayCheckoutRpc(rpc("sendTransaction", [raw, {encoding: "base64", maxRetries: 5}]), {funding: funding(), maySubmit: true, fetcher});
    const forwarded = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(forwarded.params).toEqual([raw, {encoding: "base64", skipPreflight: false, maxRetries: 3}]);
  });

  for (const change of ["amount", "destination", "memo", "extra_instruction", "unsigned", "skip_preflight", "trailing_bytes"] as const) it(`rejects ${change} before upstream access`, async () => {
    const fetcher = upstream();
    const tx = transaction();
    if (change === "amount") tx.instructions[1]!.data.writeBigUInt64LE(2_000_000n, 1);
    if (change === "destination") tx.instructions[1]!.keys[2]!.pubkey = source;
    if (change === "memo") tx.instructions[2]!.data = Buffer.from("other-commission");
    if (change === "extra_instruction") tx.add(new TransactionInstruction({programId: memo, keys: [], data: Buffer.from("extra")}));
    const raw = packet(tx, change !== "unsigned");
    const bytes = change === "trailing_bytes" ? Buffer.concat([Buffer.from(raw, "base64"), Buffer.from([0])]).toString("base64") : raw;
    await expect(relayCheckoutRpc(rpc("sendTransaction", [bytes, {encoding: "base64", ...(change === "skip_preflight" ? {skipPreflight: true} : {})}]), {funding: funding(), maySubmit: true, fetcher})).rejects.toMatchObject({statusCode: 400});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks expired or already-received payment submission while retaining receipt reads", async () => {
    const fetcher = upstream();
    const input = rpc("sendTransaction", [packet(transaction()), {encoding: "base64"}]);
    await expect(relayCheckoutRpc(input, {funding: {...funding(), expires_at: new Date(0).toISOString()}, maySubmit: true, fetcher})).rejects.toMatchObject({statusCode: 409});
    await expect(relayCheckoutRpc(input, {funding: funding(), maySubmit: false, fetcher})).rejects.toMatchObject({statusCode: 409});
    expect(fetcher).not.toHaveBeenCalled();
    await relayCheckoutRpc(rpc("getSignatureStatuses", [["1".repeat(64)], {searchTransactionHistory: true}]), {funding: {...funding(), expires_at: new Date(0).toISOString()}, fetcher});
  });

  for (const request of [rpc("getProgramAccounts"), [rpc("getGenesisHash")], {...rpc("getGenesisHash"), url: "https://attacker.example"}, rpc("getBalance", [treasury.toBase58(), {}]), rpc("getAccountInfo", [payer.publicKey.toBase58(), {encoding: "base64"}]), rpc("sendTransaction", ["A".repeat(2000), {encoding: "base64"}])]) it("rejects batches, arbitrary methods, targets and oversized packets", async () => {
    const fetcher = upstream();
    await expect(relayCheckoutRpc(request, {funding: funding(), maySubmit: true, fetcher})).rejects.toMatchObject({statusCode: 400});
    expect(fetcher).not.toHaveBeenCalled();
  });

  for (const body of [JSON.stringify({jsonrpc: "2.0", id: "wrong", result: 1}), "invalid-json", "x".repeat(256 * 1024 + 1)]) it("fails closed on invalid or oversized upstream replies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(relayCheckoutRpc(rpc("getGenesisHash"), {fetcher})).rejects.toMatchObject({statusCode: 502});
  });
});

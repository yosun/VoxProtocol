import {Buffer} from "node:buffer";
import {PublicKey, Transaction, TransactionInstruction, Message} from "@solana/web3.js";
import {createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync} from "@solana/spl-token";
import {isSolanaTransactionSignature} from "@vox/solana";
import {z} from "zod";
import type {MainnetSplUsdcFundingAuthorization} from "./realize-payment.js";

const MAX_PACKET_BYTES = 1232;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAINNET_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RpcSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string().min(1).max(64), z.number().int().safe()]),
  method: z.enum(["getGenesisHash", "getAccountInfo", "getBalance", "getLatestBlockhash", "getBlockHeight", "getMinimumBalanceForRentExemption", "getFeeForMessage", "getSignatureStatuses", "simulateTransaction", "sendTransaction"]),
  params: z.array(z.unknown()).max(2).default([])
}).strict();
const Commitment = z.enum(["confirmed", "finalized"]);
const ReadConfig = z.object({commitment: Commitment.optional(), minContextSlot: z.number().int().nonnegative().safe().optional()}).strict();

export class CheckoutRpcError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

function decodePacket(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 1644) throw new Error("invalid packet");
  const raw = Buffer.from(value, "base64");
  if (!raw.length || raw.length > MAX_PACKET_BYTES || raw.toString("base64") !== value) throw new Error("invalid packet");
  return raw;
}

/** No generic transaction relay: only the exact accepted classic-USDC payment. */
export function validateCheckoutTransaction(raw: Buffer, funding: MainnetSplUsdcFundingAuthorization, signed: boolean, messageOnly = false): void {
  const transaction = messageOnly ? Transaction.populate(Message.from(raw)) : Transaction.from(raw);
  const payer = new PublicKey(funding.payer_wallet);
  const mint = new PublicKey(MAINNET_MINT);
  const treasury = new PublicKey(funding.destination_owner);
  const source = getAssociatedTokenAddressSync(mint, payer);
  const destination = getAssociatedTokenAddressSync(mint, treasury);
  if (funding.network_id !== "solana:mainnet-beta" || funding.usdc_mint !== MAINNET_MINT || destination.toBase58() !== funding.destination_token_account || !transaction.recentBlockhash) throw new Error("funding mismatch");
  const expected = new Transaction({feePayer: payer, recentBlockhash: transaction.recentBlockhash});
  if (transaction.instructions.length === 4) expected.add(createAssociatedTokenAccountIdempotentInstruction(payer, source, payer, mint));
  expected.add(createAssociatedTokenAccountIdempotentInstruction(payer, destination, treasury, mint));
  expected.add(createTransferCheckedInstruction(source, mint, destination, payer, BigInt(funding.amount_usdc_atomic), 6));
  expected.add(new TransactionInstruction({programId: MEMO, keys: [], data: Buffer.from(funding.payment_reference)}));
  if (!transaction.serializeMessage().equals(expected.serializeMessage()) || transaction.signatures.length !== 1 || !transaction.feePayer?.equals(payer)) throw new Error("payment mismatch");
  if (signed && (!transaction.signature || !transaction.verifySignatures())) throw new Error("signature missing");
  const canonical = messageOnly ? transaction.serializeMessage() : transaction.serialize({requireAllSignatures: signed, verifySignatures: signed});
  if (!canonical.equals(raw)) throw new Error("noncanonical packet");
}

function checkedRequest(raw: unknown, funding?: MainnetSplUsdcFundingAuthorization, maySubmit = false) {
  const request = RpcSchema.parse(raw);
  const params = request.params;
  if (request.method === "getGenesisHash") {
    z.tuple([]).parse(params);
    return request;
  }
  if (!funding) throw new Error("accepted funding required");
  switch (request.method) {
    case "getAccountInfo": {
      const [account, config] = z.tuple([z.string(), ReadConfig.extend({encoding: z.literal("base64")})]).parse(params);
      const source = getAssociatedTokenAddressSync(new PublicKey(funding.usdc_mint), new PublicKey(funding.payer_wallet)).toBase58();
      if (account !== source && account !== funding.destination_token_account) throw new Error("account not authorized");
      return {...request, params: [account, config]};
    }
    case "getBalance": {
      const [account, config] = z.tuple([z.literal(funding.payer_wallet), ReadConfig]).parse(params);
      return {...request, params: [account, config]};
    }
    case "getLatestBlockhash": case "getBlockHeight":
      return {...request, params: z.tuple([ReadConfig]).parse(params)};
    case "getMinimumBalanceForRentExemption":
      return {...request, params: z.tuple([z.literal(165), ReadConfig]).parse(params)};
    case "getSignatureStatuses":
      return {...request, params: z.tuple([z.array(z.string().refine(isSolanaTransactionSignature)).min(1).max(1), z.object({searchTransactionHistory: z.literal(true)}).strict()]).parse(params)};
    case "getFeeForMessage": {
      const [message, config] = z.tuple([z.string(), ReadConfig]).parse(params);
      validateCheckoutTransaction(decodePacket(message), funding, false, true);
      return {...request, params: [message, config]};
    }
    case "simulateTransaction": {
      const [packet, config] = z.tuple([z.string(), z.object({encoding: z.literal("base64"), commitment: Commitment.optional(), sigVerify: z.boolean().optional()}).strict()]).parse(params);
      validateCheckoutTransaction(decodePacket(packet), funding, false);
      return {...request, params: [packet, {...config, sigVerify: false}]};
    }
    case "sendTransaction": {
      const [packet, config] = z.tuple([z.string(), z.object({encoding: z.literal("base64"), skipPreflight: z.literal(false).optional(), preflightCommitment: Commitment.optional(), maxRetries: z.number().int().min(0).max(5).optional(), minContextSlot: z.number().int().nonnegative().safe().optional()}).strict()]).parse(params);
      if (!maySubmit || !(Date.parse(funding.expires_at) > Date.now())) throw new CheckoutRpcError(409, "quote_expired", "This checkout cannot submit another payment. Verify the original receipt before continuing.");
      validateCheckoutTransaction(decodePacket(packet), funding, true);
      return {...request, params: [packet, {...config, skipPreflight: false, maxRetries: Math.min(config.maxRetries ?? 3, 3)}]};
    }
  }
}

/** Fixed server-configured upstream; browser headers and URLs are never forwarded. */
export async function relayCheckoutRpc(raw: unknown, options: {funding?: MainnetSplUsdcFundingAuthorization; maySubmit?: boolean; fetcher?: typeof fetch} = {}): Promise<Record<string, unknown>> {
  let request;
  try { request = checkedRequest(raw, options.funding, options.maySubmit); }
  catch (error) {
    if (error instanceof CheckoutRpcError) throw error;
    throw new CheckoutRpcError(400, "checkout_rpc_invalid", "RPC request is not permitted for this accepted checkout.");
  }
  const endpoint = new URL(process.env.VOX_REALIZE_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new CheckoutRpcError(503, "checkout_rpc_unavailable", "Mainnet RPC is unavailable.");
  try {
    const response = await (options.fetcher ?? fetch)(endpoint, {method: "POST", headers: {"content-type": "application/json", accept: "application/json"}, body: JSON.stringify(request), redirect: "error", signal: AbortSignal.timeout(15_000)});
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES || !response.body) {
      await response.body?.cancel();
      throw new Error("upstream unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("response too large"); }
      chunks.push(value);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (!payload || payload.jsonrpc !== "2.0" || payload.id !== request.id || ("result" in payload) === ("error" in payload)) throw new Error("invalid RPC envelope");
    return payload;
  } catch {
    throw new CheckoutRpcError(502, "checkout_rpc_unavailable", "Solana RPC is temporarily unavailable. Preserve your original payment receipt and retry.");
  }
}

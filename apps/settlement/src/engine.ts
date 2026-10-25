import {createHash, timingSafeEqual} from "node:crypto";
import {canonicalize, SettlementInstructionV1Schema, type SettlementInstructionV1} from "@vox/protocol";
import {isValidSolanaAddress, verifyFinalizedUsdcTransfer} from "@vox/solana";
import Fastify, {type FastifyInstance} from "fastify";
import {z} from "zod";
import type {SettlementBatchRecord, SettlementLedger, SettlementRecord, SettlementRecordKind} from "./ledger.js";

export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const atomic = z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n);
const solanaAddress = z.string().min(32).max(64).refine(isValidSolanaAddress);
export const RefundRequestSchema = z.object({
  commission_id: z.string().min(1).max(256),
  payment_intent_id: z.string().min(1).max(256),
  accepted_quote_hash: z.string().regex(/^[0-9a-f]{64}$/),
  amount_usdc_atomic: atomic,
  network_id: z.literal("solana:mainnet-beta"),
  usdc_mint: z.literal(MAINNET_USDC_MINT),
  payer_wallet: solanaAddress,
  funding_transaction_signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  payment_reference: z.string().min(1).max(512),
  idempotency_key: z.string().min(1).max(256)
}).strict();
export type RefundRequest = z.infer<typeof RefundRequestSchema>;

export interface SettlementTransfer {
  payout_id: string;
  destination: string;
  amount_usdc_atomic: string;
}

export interface PreparedSettlementBatch extends SettlementBatchRecord {
  transaction_signature?: string;
  raw_transaction_base64?: string;
  blockhash?: string;
  last_valid_block_height?: number;
}

export interface MainnetSettlementChain {
  ensureTreasury(): Promise<void>;
  verifyFunding(input: RefundRequest): Promise<boolean>;
  prepareBatch(input: {recordId: string; batchIndex: number; transfers: SettlementTransfer[]}): Promise<PreparedSettlementBatch>;
  executeBatch(batch: PreparedSettlementBatch): Promise<"prepared" | "finalized" | "failed" | "uncertain">;
}

export interface PaymentIntentResolution {
  payment_intent_id: string;
  kind: "none" | "settlement" | "refund";
  record_id?: string;
  state?: string;
  settled_amount_usdc_atomic?: string;
  batch_statuses?: SettlementBatchRecord["status"][];
}

export class SettlementError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function amount(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new SettlementError(400, "invalid_amount", "USDC amount is invalid");
  return BigInt(value);
}

function mainnetPayoutWallet(destination: string): string {
  const prefix = "solana:mainnet-beta:";
  const wallet = destination.startsWith(prefix) ? destination.slice(prefix.length) : destination;
  if (!isValidSolanaAddress(wallet)) throw new SettlementError(400, "invalid_destination", "every payout destination must be a Mainnet Solana wallet address");
  return wallet;
}

export class RealizeSettlementProcessor {
  constructor(private readonly ledger: SettlementLedger, private readonly chain: MainnetSettlementChain, private readonly maxPaymentAtomic: bigint) {
    if (maxPaymentAtomic <= 0n || maxPaymentAtomic > 10_000_000_000n) throw new Error("Mainnet settlement payment limit is invalid");
  }

  async requestSettlement(raw: unknown, idempotencyKey: string) {
    let instruction: SettlementInstructionV1;
    try { instruction = SettlementInstructionV1Schema.parse(raw); }
    catch { throw new SettlementError(400, "invalid_settlement", "settlement instruction is invalid"); }
    if (idempotencyKey !== instruction.settlement_id) throw new SettlementError(400, "idempotency_key_mismatch", "Idempotency-Key must match settlement_id");
    if (instruction.network_id !== "solana:mainnet-beta" || instruction.usdc_mint !== MAINNET_USDC_MINT || instruction.asset !== "USDC") throw new SettlementError(400, "unsupported_network", "settlement accepts only classic SPL USDC on Solana Mainnet");
    if (!instruction.canonical_quote_hash || instruction.settlement_program_version !== "spl-usdc-mainnet-v1") throw new SettlementError(400, "settlement_binding_missing", "settlement must bind the accepted quote and Mainnet SPL payment version");
    for (const payout of instruction.payout_recipients) mainnetPayoutWallet(payout.destination);
    if (amount(instruction.total_amount_usdc_atomic) > this.maxPaymentAtomic) throw new SettlementError(400, "payment_limit_exceeded", "settlement exceeds the configured payment limit");
    await this.chain.ensureTreasury();
    await this.reserve("settlement", instruction.settlement_id, instruction.payment_intent_id, instruction);
    return this.finishSettlement(instruction);
  }

  async getSettlement(settlementId: string) {
    const record = await this.ledger.get(settlementId);
    if (!record || record.kind !== "settlement") throw new SettlementError(404, "settlement_not_found", "settlement was not found");
    const instruction = SettlementInstructionV1Schema.parse(record.request);
    await this.chain.ensureTreasury();
    return this.finishSettlement(instruction);
  }

  async requestRefund(raw: unknown, idempotencyKey: string) {
    let request: RefundRequest;
    try { request = RefundRequestSchema.parse(raw); }
    catch { throw new SettlementError(400, "invalid_refund", "refund request is invalid"); }
    if (idempotencyKey !== request.idempotency_key) throw new SettlementError(400, "idempotency_key_mismatch", "Idempotency-Key must match idempotency_key");
    if (amount(request.amount_usdc_atomic) > this.maxPaymentAtomic) throw new SettlementError(400, "payment_limit_exceeded", "refund exceeds the configured payment limit");
    if (request.payment_reference !== "vox:realize:payment:" + request.payment_intent_id + ":" + request.accepted_quote_hash || request.idempotency_key !== "vox:refund:" + request.commission_id + ":" + request.accepted_quote_hash) throw new SettlementError(400, "refund_binding_mismatch", "refund identifiers do not match the original payment intent and accepted quote");
    await this.chain.ensureTreasury();
    if (!await this.chain.verifyFunding(request)) throw new SettlementError(402, "funding_unverified", "original Mainnet USDC payment could not be verified for refund");
    const refundId = `vox:refund:${createHash("sha256").update(request.idempotency_key).digest("hex")}`;
    const record = await this.reserve("refund", refundId, request.payment_intent_id, request);
    return this.progressRefund(record.record_id, request);
  }

  async getRefund(refundId: string) {
    const record = await this.ledger.get(refundId);
    if (!record || record.kind !== "refund") throw new SettlementError(404, "refund_not_found", "refund was not found");
    const request = RefundRequestSchema.parse(record.request);
    await this.chain.ensureTreasury();
    return this.progressRefund(refundId, request);
  }

  async getPaymentIntentResolution(paymentIntentId: string): Promise<PaymentIntentResolution> {
    if (!paymentIntentId || paymentIntentId.length > 256) throw new SettlementError(400, "invalid_payment_intent", "payment intent id is invalid");
    const record = await this.ledger.getByPaymentIntent(paymentIntentId);
    if (!record) return {payment_intent_id: paymentIntentId, kind: "none"};
    const batches = await this.ledger.listBatches(record.record_id);
    const settledAmount = record.kind === "settlement"
      ? batches.filter((batch) => batch.status === "finalized").reduce((sum, batch) => sum + BigInt(batch.amount_usdc_atomic), 0n).toString()
      : undefined;
    return {
      payment_intent_id: paymentIntentId,
      kind: record.kind,
      record_id: record.record_id,
      state: record.state,
      ...(settledAmount !== undefined ? {settled_amount_usdc_atomic: settledAmount} : {}),
      batch_statuses: batches.map((batch) => batch.status)
    };
  }

  private async reserve(kind: SettlementRecordKind, recordId: string, paymentIntentId: string, request: unknown): Promise<SettlementRecord> {
    const record: SettlementRecord = {record_id: recordId, payment_intent_id: paymentIntentId, kind, state: "active", request_hash: hash(request), request, created_at: new Date().toISOString()};
    const reserved = await this.ledger.reserve(record);
    if (reserved.conflict) throw new SettlementError(409, "idempotency_conflict", "idempotency key was already used with a different request");
    return reserved.record;
  }

  private async finishSettlement(instruction: SettlementInstructionV1) {
    const response = await this.progressSettlement(instruction);
    if (response.status === "settled") await this.ledger.updateRecordState(instruction.settlement_id, "settled");
    else if (response.status === "failed") await this.ledger.updateRecordState(instruction.settlement_id, "refundable");
    else if (response.status === "partial") await this.ledger.updateRecordState(instruction.settlement_id, "partial");
    return response;
  }

  private async progressSettlement(instruction: SettlementInstructionV1) {
    const byId = new Map(instruction.payout_recipients.map((payout) => [payout.payout_id, payout]));
    for (const plan of instruction.transaction_batches) {
      const transfers = plan.payout_ids.map((payoutId) => {
        const payout = byId.get(payoutId);
        if (!payout) throw new SettlementError(400, "invalid_settlement", "transaction batch references an unknown payout");
        // Keep the quote-bound instruction unchanged in the ledger. Only the
        // chain adapter consumes the bare wallet inside its network-qualified destination.
        return {payout_id: payout.payout_id, destination: mainnetPayoutWallet(payout.destination), amount_usdc_atomic: payout.amount_usdc_atomic};
      });
      await this.progressBatch(instruction.settlement_id, plan.transaction_index, transfers);
    }
    const batches = await this.ledger.listBatches(instruction.settlement_id);
    const settledIds = new Set(batches.filter((batch) => batch.status === "finalized").flatMap((batch) => batch.payout_ids));
    const failedIds = batches.filter((batch) => batch.status === "failed").flatMap((batch) => batch.payout_ids);
    const settledAmount = instruction.payout_recipients.filter((payout) => settledIds.has(payout.payout_id)).reduce((sum, payout) => sum + amount(payout.amount_usdc_atomic), 0n);
    const terminal = batches.length === instruction.transaction_batches.length && batches.every((batch) => batch.status === "finalized" || batch.status === "failed");
    const status = terminal && failedIds.length === 0 ? "settled" : terminal && settledAmount > 0n ? "partial" : terminal ? "failed" : "processing";
    return {
      settlement_id: instruction.settlement_id, status,
      transaction_signatures: batches.flatMap((batch) => batch.transaction_signature ? [batch.transaction_signature] : []),
      settled_payout_ids: [...settledIds], settled_amount_usdc_atomic: settledAmount.toString(), failed_payout_ids: failedIds,
      updated_at: new Date().toISOString()
    };
  }

  private async progressRefund(refundId: string, request: RefundRequest) {
    await this.progressBatch(refundId, 0, [{payout_id: refundId, destination: request.payer_wallet, amount_usdc_atomic: request.amount_usdc_atomic}], true);
    const batch = await this.ledger.getBatch(refundId, 0);
    if (!batch) throw new SettlementError(503, "refund_pending", "refund transaction is not yet available");
    const status = batch.status === "finalized" ? "refunded" : batch.status === "failed" ? "failed" : batch.status === "uncertain" ? "uncertain" : "processing";
    if (status === "refunded") await this.ledger.updateRecordState(refundId, "refunded");
    else if (status === "failed") await this.ledger.updateRecordState(refundId, "refund_failed");
    return {refund_id: refundId, status, ...(batch.transaction_signature ? {transaction_signature: batch.transaction_signature} : {}), ...(status === "failed" ? {retryable: (batch.attempt_number ?? 1) < 3} : {}), updated_at: batch.updated_at};
  }

  private async progressBatch(recordId: string, batchIndex: number, transfers: SettlementTransfer[], allowRefundReplacement = false) {
    let batch = await this.ledger.getBatch(recordId, batchIndex);
    if (!batch) {
      const prepared = await this.chain.prepareBatch({recordId, batchIndex, transfers});
      batch = await this.ledger.createBatchIfAbsent(recordId, prepared);
    }
    if (batch.status === "failed" && allowRefundReplacement) {
      if ((batch.attempt_number ?? 1) >= 3) return batch;
      const prepared = await this.chain.prepareBatch({recordId, batchIndex, transfers});
      batch = await this.ledger.replaceFailedBatch(recordId, batch.transaction_signature, prepared);
    }
    if (batch.status === "finalized" || batch.status === "failed") return batch;
    const status = await this.chain.executeBatch(batch as PreparedSettlementBatch);
    const updated = {...batch, status, updated_at: new Date().toISOString()};
    await this.ledger.updateBatch(recordId, updated);
    return updated;
  }
}

export function createSettlementApp(options: {token: string; processor: RealizeSettlementProcessor}): FastifyInstance {
  if (options.token.length < 32) throw new Error("settlement bearer token must contain at least 32 characters");
  const app = Fastify({logger: process.env.NODE_ENV === "production" ? {level: process.env.LOG_LEVEL ?? "info"} : false, bodyLimit: 256 * 1024});
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${options.token}`);
    const provided = Buffer.from(typeof authorization === "string" ? authorization : "");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return reply.code(401).send({error: "unauthorized", code: "unauthorized"});
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SettlementError) return reply.code(error.statusCode).send({error: error.message, code: error.code});
    return reply.code(500).send({error: "settlement request failed", code: "internal_error"});
  });
  app.get("/healthz", async () => ({status: "ok", service: "vox-realize-settlement", network: "solana:mainnet-beta"}));
  app.post("/v1/settlements", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") throw new SettlementError(400, "idempotency_key_required", "Idempotency-Key is required");
    return reply.send(await options.processor.requestSettlement(request.body, key));
  });
  app.get<{Params: {settlementId: string}}>("/v1/settlements/:settlementId", async (request, reply) => reply.send(await options.processor.getSettlement(request.params.settlementId)));
  app.post("/v1/refunds", async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string") throw new SettlementError(400, "idempotency_key_required", "Idempotency-Key is required");
    return reply.send(await options.processor.requestRefund(request.body, key));
  });
  app.get<{Params: {refundId: string}}>("/v1/refunds/:refundId", async (request, reply) => reply.send(await options.processor.getRefund(request.params.refundId)));
  app.get<{Params: {paymentIntentId: string}}>("/v1/payment-intents/:paymentIntentId/resolution", async (request, reply) => reply.send(await options.processor.getPaymentIntentResolution(request.params.paymentIntentId)));
  return app;
}

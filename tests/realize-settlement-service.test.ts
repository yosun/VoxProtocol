import {afterEach, describe, expect, it, vi} from "vitest";
import {Keypair, type Connection} from "@solana/web3.js";
import {MAINNET_USDC_MINT, RealizeSettlementProcessor, createSettlementApp, type MainnetSettlementChain, type PreparedSettlementBatch, type RefundRequest, type SettlementTransfer} from "../apps/settlement/src/engine.js";
import {MemorySettlementLedger} from "../apps/settlement/src/ledger.js";
import {SolanaMainnetSettlementChain, solanaMainnetPayoutAddress} from "../apps/settlement/src/solana-chain.js";

class FakeSettlementChain implements MainnetSettlementChain {
  prepareCount = 0;
  executeCount = 0;
  verifyResult = true;
  executionResult: "prepared" | "finalized" | "failed" | "uncertain" = "finalized";
  executionResults: Array<"prepared" | "finalized" | "failed" | "uncertain"> = [];
  executedSignatures: string[] = [];
  treasuryDestination?: string;
  isTreasuryDestination = vi.fn((destination: string) => destination === this.treasuryDestination);
  ensureTreasury = vi.fn(async () => {});
  verifyFunding = vi.fn(async (_input: RefundRequest) => this.verifyResult);
  prepareBatch = vi.fn(async (input: {recordId: string; batchIndex: number; transfers: SettlementTransfer[]}): Promise<PreparedSettlementBatch> => {
    this.prepareCount += 1;
    return {
      batch_index: input.batchIndex,
      payout_ids: input.transfers.map((transfer) => transfer.payout_id),
      amount_usdc_atomic: input.transfers.reduce((sum, transfer) => sum + BigInt(transfer.amount_usdc_atomic), 0n).toString(),
      status: "prepared",
      transaction_signature: Keypair.generate().publicKey.toBase58(),
      raw_transaction_base64: "dGVzdA==",
      blockhash: Keypair.generate().publicKey.toBase58(),
      last_valid_block_height: 100,
      updated_at: new Date().toISOString()
    };
  });
  executeBatch = vi.fn(async (batch: PreparedSettlementBatch) => {
    this.executeCount += 1;
    this.executedSignatures.push(batch.transaction_signature ?? "missing-signature");
    return this.executionResults.shift() ?? this.executionResult;
  });
}

function settlementInstruction() {
  const provider = Keypair.generate().publicKey.toBase58();
  const owner = Keypair.generate().publicKey.toBase58();
  return {
    protocol_version: "realize/1" as const,
    settlement_id: "vox:settlement:sample-001",
    commission_id: "vox:commission:sample-001",
    payment_intent_id: "vox:payment-intent:sample-001",
    quote_id: "vox:quote:sample-001",
    canonical_quote_hash: "a".repeat(64),
    asset: "USDC" as const,
    network_id: "solana:mainnet-beta",
    usdc_mint: MAINNET_USDC_MINT,
    settlement_program_version: "spl-usdc-mainnet-v1",
    total_amount_usdc_atomic: "1000000",
    payout_recipients: [
      {payout_id: "payout-provider", recipient_id: "provider:fal", role: "generation_provider" as const, amount_usdc_atomic: "750000", destination: "solana:mainnet-beta:" + provider},
      {payout_id: "payout-owner", recipient_id: "creator:bob", role: "character_owner" as const, amount_usdc_atomic: "200000", destination: "solana:mainnet-beta:" + owner},
      {payout_id: "payout-platform", recipient_id: "platform:vox", role: "platform" as const, amount_usdc_atomic: "50000", destination: "solana:mainnet-beta:" + Keypair.generate().publicKey.toBase58()}
    ],
    transaction_batches: [{transaction_index: 0, payout_ids: ["payout-provider", "payout-owner", "payout-platform"], compute_units: 120000, serialized_size_bytes: 800}],
    created_at: new Date().toISOString()
  };
}

function refundRequest(overrides: Partial<RefundRequest> = {}): RefundRequest {
  const commissionId = overrides.commission_id ?? "vox:commission:sample-001";
  const paymentIntentId = overrides.payment_intent_id ?? "vox:payment-intent:sample-001";
  const acceptedHash = overrides.accepted_quote_hash ?? "a".repeat(64);
  return {
    commission_id: commissionId,
    payment_intent_id: paymentIntentId,
    accepted_quote_hash: acceptedHash,
    amount_usdc_atomic: "1000000",
    network_id: "solana:mainnet-beta",
    usdc_mint: MAINNET_USDC_MINT,
    payer_wallet: Keypair.generate().publicKey.toBase58(),
    funding_transaction_signature: "1".repeat(64),
    payment_reference: "vox:realize:payment:" + paymentIntentId + ":" + acceptedHash,
    idempotency_key: "vox:refund:" + commissionId + ":" + acceptedHash,
    ...overrides
  };
}

describe("Mainnet Realize settlement adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exposes public health on the Cloud Run-compatible path while protecting financial routes", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const app = createSettlementApp({token: "test-only-settlement-token-with-at-least-32-chars", processor});
    try {
      const health = await app.inject({method: "GET", url: "/health"});
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({status: "ok", service: "vox-realize-settlement", network: "solana:mainnet-beta"});
      expect((await app.inject({method: "GET", url: "/v1/payment-intents/health-check/resolution"})).statusCode).toBe(401);
      expect(chain.prepareCount).toBe(0);
      expect(chain.executeCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("accepts only payout wallets qualified for the instruction's pinned network", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const instruction = settlementInstruction();
    await expect(processor.requestSettlement(instruction, instruction.settlement_id)).resolves.toMatchObject({status: "settled"});

    for (const destination of [
      instruction.payout_recipients[0]!.destination.slice("solana:mainnet-beta:".length),
      instruction.payout_recipients[0]!.destination.replace("solana:mainnet-beta:", "solana:devnet:"),
      instruction.payout_recipients[0]!.destination.replace("solana:mainnet-beta:", "solana:mainnet:")
    ]) {
      const invalid = settlementInstruction();
      invalid.payout_recipients[0]!.destination = destination;
      await expect(processor.requestSettlement(invalid, invalid.settlement_id)).rejects.toMatchObject({code: "invalid_destination"});
    }
  });

  it("normalizes a qualified Mainnet recipient at the chain adapter boundary", () => {
    const address = Keypair.generate().publicKey.toBase58();
    expect(solanaMainnetPayoutAddress("solana:mainnet-beta:" + address)).toBe(address);
    expect(() => solanaMainnetPayoutAddress("solana:devnet:" + address)).toThrowError(expect.objectContaining({code: "invalid_destination"}));
  });

  it("refuses to prepare a treasury self-transfer instead of recording a fake finalization", async () => {
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const chain = new SolanaMainnetSettlementChain({
      rpcUrl: "https://rpc.example",
      treasuryOwner: address,
      treasuryTokenAccount: Keypair.generate().publicKey.toBase58(),
      keypair,
      maxPaymentAtomic: 1_000_000n,
      connection: {} as Connection
    });
    await expect(chain.prepareBatch({
      recordId: "vox:settlement:test",
      batchIndex: 0,
      transfers: [{payout_id: "payout-held", destination: "solana:mainnet-beta:" + address, amount_usdc_atomic: "100"}]
    })).rejects.toMatchObject({statusCode: 409, code: "treasury_liability"});
  });

  it("keeps treasury-owned allocations as a durable liability without a finalized batch", async () => {
    const chain = new FakeSettlementChain();
    const ledger = new MemorySettlementLedger();
    const processor = new RealizeSettlementProcessor(ledger, chain, 1_000_000n);
    const instruction = settlementInstruction();
    const treasury = instruction.payout_recipients[0]!.destination;
    chain.treasuryDestination = treasury;
    instruction.payout_recipients.forEach((payout) => { payout.destination = treasury; });

    const response = await processor.requestSettlement(instruction, instruction.settlement_id);
    expect(response).toMatchObject({status: "processing", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "1000000", transaction_signatures: []});
    expect(chain.prepareCount).toBe(0);
    expect(chain.executeCount).toBe(0);
    expect(await processor.getPaymentIntentResolution(instruction.payment_intent_id)).toMatchObject({state: "active", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "1000000", batch_statuses: []});
    expect((await ledger.get(instruction.settlement_id))?.request).toEqual(instruction);
  });

  it("reclassifies a legacy treasury-only finalized record as an unpaid liability", async () => {
    const chain = new FakeSettlementChain();
    const ledger = new MemorySettlementLedger();
    const processor = new RealizeSettlementProcessor(ledger, chain, 1_000_000n);
    const instruction = settlementInstruction();
    const treasury = instruction.payout_recipients[0]!.destination;
    chain.treasuryDestination = treasury;
    instruction.payout_recipients.forEach((payout) => { payout.destination = treasury; });
    await ledger.reserve({
      record_id: instruction.settlement_id,
      payment_intent_id: instruction.payment_intent_id,
      kind: "settlement",
      state: "settled",
      request_hash: "legacy",
      request: instruction,
      created_at: instruction.created_at
    });
    await ledger.createBatchIfAbsent(instruction.settlement_id, {
      batch_index: 0,
      payout_ids: instruction.payout_recipients.map((payout) => payout.payout_id),
      amount_usdc_atomic: instruction.total_amount_usdc_atomic,
      status: "finalized",
      updated_at: instruction.created_at
    });

    const response = await processor.getSettlement(instruction.settlement_id);
    expect(response).toMatchObject({status: "processing", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "1000000"});
    expect(await processor.getPaymentIntentResolution(instruction.payment_intent_id)).toMatchObject({state: "active", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "1000000", batch_statuses: []});
  });

  it("settles only external payouts when a transaction plan also contains held allocations", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const instruction = settlementInstruction();
    const treasury = instruction.payout_recipients[0]!.destination;
    chain.treasuryDestination = treasury;
    instruction.payout_recipients[0]!.destination = treasury;
    instruction.payout_recipients[1]!.destination = treasury;

    const response = await processor.requestSettlement(instruction, instruction.settlement_id);
    expect(response).toMatchObject({status: "partial", settled_amount_usdc_atomic: "50000", held_amount_usdc_atomic: "950000"});
    expect(chain.prepareBatch).toHaveBeenCalledWith(expect.objectContaining({transfers: [{payout_id: "payout-platform", destination: instruction.payout_recipients[2]!.destination, amount_usdc_atomic: "50000"}]}));
  });

  it("marks all failed external payouts refundable when the remaining allocation is only held in treasury", async () => {
    const chain = new FakeSettlementChain();
    chain.executionResult = "failed";
    const ledger = new MemorySettlementLedger();
    const processor = new RealizeSettlementProcessor(ledger, chain, 1_000_000n);
    const instruction = settlementInstruction();
    chain.treasuryDestination = instruction.payout_recipients[0]!.destination;

    const response = await processor.requestSettlement(instruction, instruction.settlement_id);

    expect(response).toMatchObject({status: "failed", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "750000", failed_payout_ids: ["payout-owner", "payout-platform"]});
    expect(await processor.getPaymentIntentResolution(instruction.payment_intent_id)).toMatchObject({state: "refundable", settled_amount_usdc_atomic: "0", held_amount_usdc_atomic: "750000", batch_statuses: ["failed"]});
    expect((await ledger.get(instruction.settlement_id))?.state).toBe("refundable");
  });

  it("authenticates, settles the exact payout plan once, and replays the stored result", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const app = createSettlementApp({token: "test-only-settlement-token-with-at-least-32-chars", processor});
    await app.ready();
    const instruction = settlementInstruction();
    const denied = await app.inject({method: "POST", url: "/v1/settlements", headers: {"idempotency-key": instruction.settlement_id}, payload: instruction});
    expect(denied.statusCode).toBe(401);
    const headers = {authorization: "Bearer test-only-settlement-token-with-at-least-32-chars", "idempotency-key": instruction.settlement_id};
    const first = await app.inject({method: "POST", url: "/v1/settlements", headers, payload: instruction});
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({settlement_id: instruction.settlement_id, status: "settled", settled_amount_usdc_atomic: "1000000"});
    const replay = await app.inject({method: "POST", url: "/v1/settlements", headers, payload: instruction});
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({status: "settled", settled_amount_usdc_atomic: "1000000"});
    expect(chain.prepareCount).toBe(1);
    expect(chain.executeCount).toBe(1);
    await app.close();
  });

  it("rejects changed payloads on an already-used settlement intent", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 2_000_000n);
    const app = createSettlementApp({token: "test-only-settlement-token-with-at-least-32-chars", processor});
    await app.ready();
    const instruction = settlementInstruction();
    const headers = {authorization: "Bearer test-only-settlement-token-with-at-least-32-chars", "idempotency-key": instruction.settlement_id};
    expect((await app.inject({method: "POST", url: "/v1/settlements", headers, payload: instruction})).statusCode).toBe(200);
    const changed = {...instruction, payout_recipients: instruction.payout_recipients.map((payout, index) => index === 0 ? {...payout, amount_usdc_atomic: "740000"} : index === 1 ? {...payout, amount_usdc_atomic: "210000"} : payout)};
    const conflict = await app.inject({method: "POST", url: "/v1/settlements", headers, payload: changed});
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("idempotency_conflict");
    expect(chain.executeCount).toBe(1);
    await app.close();
  });

  it("allows only one settlement or refund per payment intent", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const instruction = settlementInstruction();
    await processor.requestSettlement(instruction, instruction.settlement_id);
    const alternateId = {...instruction, settlement_id: "vox:settlement:alternate-id"};
    await expect(processor.requestSettlement(alternateId, alternateId.settlement_id)).rejects.toMatchObject({code: "idempotency_conflict"});
    expect(chain.executeCount).toBe(1);
    const refundChain = new FakeSettlementChain();
    const refundProcessor = new RealizeSettlementProcessor(new MemorySettlementLedger(), refundChain, 1_000_000n);
    const refund = refundRequest();
    const response = await refundProcessor.requestRefund(refund, refund.idempotency_key);
    expect(response.status).toBe("refunded");
    expect(refundChain.prepareBatch).toHaveBeenCalledWith(expect.objectContaining({transfers: [expect.objectContaining({destination: "solana:mainnet-beta:" + refund.payer_wallet})]}));
    const secondRefund = refundRequest({commission_id: "vox:commission:another", payment_intent_id: refund.payment_intent_id, payer_wallet: refund.payer_wallet});
    await expect(refundProcessor.requestRefund(secondRefund, secondRefund.idempotency_key)).rejects.toMatchObject({code: "idempotency_conflict"});
    expect(refundChain.executeCount).toBe(1);
  });

  it("permits a refund only after every settlement batch has finalized without payout", async () => {
    const chain = new FakeSettlementChain();
    chain.executionResult = "failed";
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const instruction = settlementInstruction();
    const settlement = await processor.requestSettlement(instruction, instruction.settlement_id);
    expect(settlement.status).toBe("failed");
    chain.executionResult = "finalized";
    const refund = refundRequest();
    const response = await processor.requestRefund(refund, refund.idempotency_key);
    expect(response.status).toBe("refunded");
    expect(chain.executeCount).toBe(2);
  });

  it("serializes concurrent duplicate refund requests to one reserved transaction", async () => {
    const chain = new FakeSettlementChain();
    chain.executionResult = "prepared";
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const refund = refundRequest();
    const responses = await Promise.all([
      processor.requestRefund(refund, refund.idempotency_key),
      processor.requestRefund(refund, refund.idempotency_key)
    ]);
    expect(responses.map((item) => item.status)).toEqual(["processing", "processing"]);
    expect(new Set(chain.executedSignatures).size).toBe(1);
    expect(await processor.getPaymentIntentResolution(refund.payment_intent_id)).toMatchObject({kind: "refund", record_id: responses[0]!.refund_id});
  });

  it("reconciles an uncertain refund by checking and retrying the same signed bytes", async () => {
    const chain = new FakeSettlementChain();
    chain.executionResult = "uncertain";
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const refund = refundRequest();
    const first = await processor.requestRefund(refund, refund.idempotency_key);
    expect(first.status).toBe("uncertain");
    chain.executionResult = "finalized";
    const reconciled = await processor.getRefund(first.refund_id);
    expect(reconciled.status).toBe("refunded");
    expect(chain.prepareCount).toBe(1);
    expect(chain.executedSignatures).toHaveLength(2);
    expect(new Set(chain.executedSignatures).size).toBe(1);
  });

  it("replaces a refund transaction only after a finalized failure, retaining attempt history", async () => {
    const chain = new FakeSettlementChain();
    chain.executionResults = ["failed", "finalized"];
    const ledger = new MemorySettlementLedger();
    const processor = new RealizeSettlementProcessor(ledger, chain, 1_000_000n);
    const refund = refundRequest();
    const first = await processor.requestRefund(refund, refund.idempotency_key);
    expect(first).toMatchObject({status: "failed", retryable: true});
    const finalized = await processor.getRefund(first.refund_id);
    expect(finalized.status).toBe("refunded");
    expect(chain.prepareCount).toBe(2);
    expect(chain.executedSignatures[0]).not.toBe(chain.executedSignatures[1]);
    const resolution = await processor.getPaymentIntentResolution(refund.payment_intent_id);
    expect(resolution).toMatchObject({kind: "refund", state: "refunded"});
  });

  it("blocks refunds when settlement status is uncertain or any payout finalized", async () => {
    const uncertainChain = new FakeSettlementChain();
    uncertainChain.executionResult = "uncertain";
    const uncertainProcessor = new RealizeSettlementProcessor(new MemorySettlementLedger(), uncertainChain, 1_000_000n);
    const uncertainInstruction = settlementInstruction();
    const uncertain = await uncertainProcessor.requestSettlement(uncertainInstruction, uncertainInstruction.settlement_id);
    expect(uncertain.status).toBe("processing");
    await expect(uncertainProcessor.requestRefund(refundRequest(), refundRequest().idempotency_key)).rejects.toMatchObject({code: "idempotency_conflict"});

    const partialChain = new FakeSettlementChain();
    partialChain.executionResults = ["finalized", "failed"];
    const partialProcessor = new RealizeSettlementProcessor(new MemorySettlementLedger(), partialChain, 1_000_000n);
    const instruction = {...settlementInstruction(), transaction_batches: [{transaction_index: 0, payout_ids: ["payout-provider"], compute_units: 60_000, serialized_size_bytes: 500}, {transaction_index: 1, payout_ids: ["payout-owner", "payout-platform"], compute_units: 60_000, serialized_size_bytes: 500}]};
    const partial = await partialProcessor.requestSettlement(instruction, instruction.settlement_id);
    expect(partial.status).toBe("partial");
    const refund = refundRequest({payment_intent_id: instruction.payment_intent_id, commission_id: instruction.commission_id, accepted_quote_hash: instruction.canonical_quote_hash, payment_reference: `vox:realize:payment:${instruction.payment_intent_id}:${instruction.canonical_quote_hash}`, idempotency_key: `vox:refund:${instruction.commission_id}:${instruction.canonical_quote_hash}`});
    await expect(partialProcessor.requestRefund(refund, refund.idempotency_key)).rejects.toMatchObject({code: "idempotency_conflict"});
  });

  it("checks the original finalized funding before reserving a refund", async () => {
    const chain = new FakeSettlementChain();
    chain.verifyResult = false;
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 1_000_000n);
    const app = createSettlementApp({token: "test-only-settlement-token-with-at-least-32-chars", processor});
    await app.ready();
    const refund = refundRequest();
    const response = await app.inject({
      method: "POST", url: "/v1/refunds",
      headers: {authorization: "Bearer test-only-settlement-token-with-at-least-32-chars", "idempotency-key": refund.idempotency_key},
      payload: refund
    });
    expect(response.statusCode).toBe(402);
    expect(response.json().code).toBe("funding_unverified");
    expect(chain.prepareCount).toBe(0);
    expect(chain.executeCount).toBe(0);
    await app.close();
  });

  it("fails closed on a quote over the configured payment cap", async () => {
    const chain = new FakeSettlementChain();
    const processor = new RealizeSettlementProcessor(new MemorySettlementLedger(), chain, 999_999n);
    const instruction = settlementInstruction();
    await expect(processor.requestSettlement(instruction, instruction.settlement_id)).rejects.toMatchObject({code: "payment_limit_exceeded"});
    expect(chain.prepareCount).toBe(0);
  });
});

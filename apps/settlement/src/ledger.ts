import {createHash} from "node:crypto";
import type {Firestore} from "@google-cloud/firestore";

export type SettlementRecordKind = "settlement" | "refund";
export type SettlementRecordState = "active" | "settled" | "refundable" | "partial" | "refunded" | "refund_failed";
export type SettlementBatchStatus = "prepared" | "finalized" | "failed" | "uncertain";

export interface SettlementRecord {
  record_id: string;
  payment_intent_id: string;
  kind: SettlementRecordKind;
  state: SettlementRecordState;
  request_hash: string;
  request: unknown;
  created_at: string;
}

export interface SettlementBatchRecord {
  batch_index: number;
  attempt_number?: number;
  previous_attempts?: Array<{attempt_number: number; status: "failed"; transaction_signature?: string; updated_at: string}>;
  payout_ids: string[];
  amount_usdc_atomic: string;
  status: SettlementBatchStatus;
  transaction_signature?: string;
  raw_transaction_base64?: string;
  blockhash?: string;
  last_valid_block_height?: number;
  updated_at: string;
}

export interface SettlementLedger {
  reserve(record: SettlementRecord): Promise<{record: SettlementRecord; conflict: boolean}>;
  get(recordId: string): Promise<SettlementRecord | undefined>;
  getByPaymentIntent(paymentIntentId: string): Promise<SettlementRecord | undefined>;
  updateRecordState(recordId: string, state: SettlementRecordState): Promise<void>;
  getBatch(recordId: string, batchIndex: number): Promise<SettlementBatchRecord | undefined>;
  createBatchIfAbsent(recordId: string, batch: SettlementBatchRecord): Promise<SettlementBatchRecord>;
  replaceFailedBatch(recordId: string, expectedSignature: string | undefined, replacement: SettlementBatchRecord): Promise<SettlementBatchRecord>;
  updateBatch(recordId: string, batch: SettlementBatchRecord): Promise<void>;
  listBatches(recordId: string): Promise<SettlementBatchRecord[]>;
}

function recordDocId(recordId: string): string {
  return createHash("sha256").update(recordId).digest("hex");
}

export class FirestoreSettlementLedger implements SettlementLedger {
  private readonly records;
  constructor(private readonly db: Firestore) {
    this.records = db.collection("vox_realize_settlement_records");
  }

  async reserve(record: SettlementRecord): Promise<{record: SettlementRecord; conflict: boolean}> {
    const ref = this.records.doc(recordDocId(record.record_id));
    const intentRef = this.records.doc("payment-" + recordDocId(record.payment_intent_id));
    return this.db.runTransaction(async (transaction) => {
      const [snapshot, intentSnapshot] = await Promise.all([transaction.get(ref), transaction.get(intentRef)]);
      if (snapshot.exists) {
        const prior = snapshot.data() as SettlementRecord;
        return {record: prior, conflict: prior.kind !== record.kind || prior.record_id !== record.record_id || prior.payment_intent_id !== record.payment_intent_id || prior.request_hash !== record.request_hash};
      }
      if (intentSnapshot.exists) {
        const active = intentSnapshot.data() as {record_id: string; kind: SettlementRecordKind; state: SettlementRecordState};
        if (record.kind !== "refund" || active.kind !== "settlement" || active.state !== "refundable") return {record, conflict: true};
        transaction.create(ref, record);
        transaction.set(intentRef, {record_id: record.record_id, payment_intent_id: record.payment_intent_id, kind: record.kind, state: record.state});
        return {record, conflict: false};
      }
      transaction.create(ref, record);
      transaction.create(intentRef, {record_id: record.record_id, payment_intent_id: record.payment_intent_id, kind: record.kind, state: record.state});
      return {record, conflict: false};
    });
  }

  async get(recordId: string): Promise<SettlementRecord | undefined> {
    const snapshot = await this.records.doc(recordDocId(recordId)).get();
    if (!snapshot.exists) return undefined;
    const record = snapshot.data() as SettlementRecord;
    return record.record_id === recordId ? record : undefined;
  }

  async getByPaymentIntent(paymentIntentId: string): Promise<SettlementRecord | undefined> {
    const lock = await this.records.doc("payment-" + recordDocId(paymentIntentId)).get();
    if (!lock.exists) return undefined;
    const recordId = (lock.data() as {record_id?: string}).record_id;
    return recordId ? this.get(recordId) : undefined;
  }

  async updateRecordState(recordId: string, state: SettlementRecordState): Promise<void> {
    const ref = this.records.doc(recordDocId(recordId));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("settlement record is missing");
      const record = snapshot.data() as SettlementRecord;
      const intentRef = this.records.doc("payment-" + recordDocId(record.payment_intent_id));
      const intentSnapshot = await transaction.get(intentRef);
      transaction.update(ref, {state});
      if (intentSnapshot.exists && (intentSnapshot.data() as {record_id?: string}).record_id === recordId) transaction.update(intentRef, {state});
    });
  }

  private batches(recordId: string) {
    return this.records.doc(recordDocId(recordId)).collection("batches");
  }

  async getBatch(recordId: string, batchIndex: number): Promise<SettlementBatchRecord | undefined> {
    const snapshot = await this.batches(recordId).doc(String(batchIndex)).get();
    return snapshot.exists ? snapshot.data() as SettlementBatchRecord : undefined;
  }

  async createBatchIfAbsent(recordId: string, batch: SettlementBatchRecord): Promise<SettlementBatchRecord> {
    const ref = this.batches(recordId).doc(String(batch.batch_index));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) {
        const prior = snapshot.data() as SettlementBatchRecord;
        if (prior.amount_usdc_atomic !== batch.amount_usdc_atomic || JSON.stringify(prior.payout_ids) !== JSON.stringify(batch.payout_ids)) throw new Error("settlement batch id was reused with different payouts");
        return prior;
      }
      transaction.create(ref, batch);
      return batch;
    });
  }

  async replaceFailedBatch(recordId: string, expectedSignature: string | undefined, replacement: SettlementBatchRecord): Promise<SettlementBatchRecord> {
    const ref = this.batches(recordId).doc(String(replacement.batch_index));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("settlement batch reservation is missing");
      const prior = snapshot.data() as SettlementBatchRecord;
      if (prior.status !== "failed" || prior.transaction_signature !== expectedSignature || prior.amount_usdc_atomic !== replacement.amount_usdc_atomic || JSON.stringify(prior.payout_ids) !== JSON.stringify(replacement.payout_ids)) return prior;
      const attemptNumber = (prior.attempt_number ?? 1) + 1;
      if (replacement.attempt_number !== attemptNumber || !replacement.transaction_signature || replacement.transaction_signature === prior.transaction_signature) throw new Error("replacement refund must bind a new transaction attempt");
      const history = [...(prior.previous_attempts ?? []), {attempt_number: prior.attempt_number ?? 1, status: "failed" as const, ...(prior.transaction_signature ? {transaction_signature: prior.transaction_signature} : {}), updated_at: prior.updated_at}];
      const next = {...replacement, attempt_number: attemptNumber, previous_attempts: history};
      transaction.set(ref, next);
      return next;
    });
  }

  async updateBatch(recordId: string, batch: SettlementBatchRecord): Promise<void> {
    const ref = this.batches(recordId).doc(String(batch.batch_index));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("settlement batch reservation is missing");
      const prior = snapshot.data() as SettlementBatchRecord;
      if (prior.transaction_signature !== batch.transaction_signature || prior.amount_usdc_atomic !== batch.amount_usdc_atomic || JSON.stringify(prior.payout_ids) !== JSON.stringify(batch.payout_ids)) throw new Error("settlement batch transaction binding changed");
      if ((prior.status === "finalized" || prior.status === "failed") && batch.status !== prior.status || prior.status === "uncertain" && batch.status === "prepared") return;
      transaction.set(ref, batch);
    });
  }

  async listBatches(recordId: string): Promise<SettlementBatchRecord[]> {
    const snapshot = await this.batches(recordId).get();
    return snapshot.docs.map((doc) => doc.data() as SettlementBatchRecord).sort((a, b) => a.batch_index - b.batch_index);
  }
}

export class MemorySettlementLedger implements SettlementLedger {
  private readonly records = new Map<string, SettlementRecord>();
  private readonly paymentIntents = new Map<string, {record_id: string; kind: SettlementRecordKind; state: SettlementRecordState}>();
  private readonly batches = new Map<string, Map<number, SettlementBatchRecord>>();
  async reserve(record: SettlementRecord) {
    const prior = this.records.get(record.record_id);
    if (prior) return {record: prior, conflict: prior.kind !== record.kind || prior.payment_intent_id !== record.payment_intent_id || prior.request_hash !== record.request_hash};
    const active = this.paymentIntents.get(record.payment_intent_id);
    if (active && !(record.kind === "refund" && active.kind === "settlement" && active.state === "refundable")) return {record, conflict: true};
    this.records.set(record.record_id, record);
    this.paymentIntents.set(record.payment_intent_id, {record_id: record.record_id, kind: record.kind, state: record.state});
    return {record, conflict: false};
  }
  async get(recordId: string) { return this.records.get(recordId); }
  async getByPaymentIntent(paymentIntentId: string) {
    const lock = this.paymentIntents.get(paymentIntentId);
    return lock ? this.records.get(lock.record_id) : undefined;
  }
  async updateRecordState(recordId: string, state: SettlementRecordState) {
    const record = this.records.get(recordId);
    if (!record) throw new Error("settlement record is missing");
    this.records.set(recordId, {...record, state});
    const active = this.paymentIntents.get(record.payment_intent_id);
    if (active?.record_id === recordId) this.paymentIntents.set(record.payment_intent_id, {...active, state});
  }
  async getBatch(recordId: string, batchIndex: number) { return this.batches.get(recordId)?.get(batchIndex); }
  async createBatchIfAbsent(recordId: string, batch: SettlementBatchRecord) {
    const batches = this.batches.get(recordId) ?? new Map<number, SettlementBatchRecord>();
    const prior = batches.get(batch.batch_index);
    if (prior) {
      if (prior.amount_usdc_atomic !== batch.amount_usdc_atomic || JSON.stringify(prior.payout_ids) !== JSON.stringify(batch.payout_ids)) throw new Error("settlement batch id was reused with different payouts");
      return prior;
    }
    batches.set(batch.batch_index, batch);
    this.batches.set(recordId, batches);
    return batch;
  }
  async replaceFailedBatch(recordId: string, expectedSignature: string | undefined, replacement: SettlementBatchRecord) {
    const batches = this.batches.get(recordId);
    const prior = batches?.get(replacement.batch_index);
    if (!prior || prior.status !== "failed" || prior.transaction_signature !== expectedSignature || prior.amount_usdc_atomic !== replacement.amount_usdc_atomic || JSON.stringify(prior.payout_ids) !== JSON.stringify(replacement.payout_ids)) return prior ?? replacement;
    const attemptNumber = (prior.attempt_number ?? 1) + 1;
    if (replacement.attempt_number !== attemptNumber || !replacement.transaction_signature || replacement.transaction_signature === prior.transaction_signature) throw new Error("replacement refund must bind a new transaction attempt");
    const history = [...(prior.previous_attempts ?? []), {attempt_number: prior.attempt_number ?? 1, status: "failed" as const, ...(prior.transaction_signature ? {transaction_signature: prior.transaction_signature} : {}), updated_at: prior.updated_at}];
    const next = {...replacement, attempt_number: attemptNumber, previous_attempts: history};
    batches!.set(replacement.batch_index, next);
    return next;
  }
  async updateBatch(recordId: string, batch: SettlementBatchRecord) {
    const batches = this.batches.get(recordId);
    const prior = batches?.get(batch.batch_index);
    if (!prior || prior.transaction_signature !== batch.transaction_signature) throw new Error("settlement batch transaction binding changed");
    if (prior.status === "finalized" || prior.status === "failed" || prior.status === "uncertain" && batch.status === "prepared") return;
    batches!.set(batch.batch_index, batch);
  }
  async listBatches(recordId: string) {
    return [...(this.batches.get(recordId)?.values() ?? [])].sort((a, b) => a.batch_index - b.batch_index);
  }
}

export type FinancialOutcome = "pending" | "captured" | "failed" | "rejected";

export interface FinancialCheckpoint<T> {
  sourcePostId: string;
  commissionId: string;
  attemptId: string;
  outcome: FinancialOutcome;
  updatedAt: number;
  checkout: T;
}

const DATABASE = "vox.realize.financial-checkpoints.v1";
const STORE = "commissions";
const STORAGE_ERROR = "Durable payment recovery is unavailable in this browser. Enable browser storage before paying.";
const CONFLICT_ERROR = "Another tab has a newer payment for this order. Restore its saved checkout before continuing; do not pay again.";

function validRecord(value: unknown): value is FinancialCheckpoint<unknown> {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<FinancialCheckpoint<unknown>>;
  return typeof record.sourcePostId === "string" && typeof record.commissionId === "string" && typeof record.attemptId === "string" && ["pending", "captured", "failed", "rejected"].includes(record.outcome ?? "") && Number.isSafeInteger(record.updatedAt) && !!record.checkout && typeof record.checkout === "object";
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error(STORAGE_ERROR);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DATABASE, 1); }
    catch { reject(new Error(STORAGE_ERROR)); return; }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {keyPath: "commissionId"});
      store.createIndex("sourcePostId", "sourcePostId");
    };
    request.onerror = () => reject(new Error(STORAGE_ERROR));
    request.onblocked = () => reject(new Error(STORAGE_ERROR));
    request.onsuccess = () => resolve(request.result);
  });
}

function recordsForSource<T>(values: unknown[], sourcePostId: string): FinancialCheckpoint<T>[] {
  if (values.some((value) => !validRecord(value) || value.sourcePostId !== sourcePostId)) throw new Error("The saved financial checkpoint is invalid. Check your existing payment before continuing.");
  return values as FinancialCheckpoint<T>[];
}

function latestRecord<T>(records: FinancialCheckpoint<T>[]): FinancialCheckpoint<T> | undefined {
  // An unresolved older order takes priority over completed history.
  return [...records].sort((left, right) => Number(right.outcome === "pending") - Number(left.outcome === "pending") || right.updatedAt - left.updatedAt)[0];
}

export async function readFinancialCheckpoint<T>(sourcePostId: string): Promise<FinancialCheckpoint<T> | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).index("sourcePostId").getAll(sourcePostId);
    let result: FinancialCheckpoint<T> | undefined;
    request.onsuccess = () => {
      try { result = latestRecord(recordsForSource<T>(request.result as unknown[], sourcePostId)); }
      catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = transaction.onerror = () => { database.close(); reject(new Error(STORAGE_ERROR)); };
  });
}

/** Atomic compare-and-set prevents stale tabs from replacing or clearing a newer attempt. */
export async function writeFinancialCheckpoint<T>(record: FinancialCheckpoint<T>, options: {
  startAttempt?: boolean;
  expectedAttemptId?: string;
  expectedSignature?: string;
  predecessorCommissionId?: string;
  migrateOnly?: boolean;
} = {}): Promise<FinancialCheckpoint<T>> {
  if (!validRecord(record)) throw new Error("The financial checkpoint is invalid.");
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    // IndexedDB readwrite transactions serialize this read + compare + write
    // across tabs. No read/modify/write localStorage lease is used.
    const transaction = database.transaction(STORE, "readwrite", {durability: "strict"});
    const store = transaction.objectStore(STORE);
    const binding = store.get(record.commissionId);
    const request = store.index("sourcePostId").getAll(record.sourcePostId);
    let result = record;
    let failure: unknown;
    binding.onsuccess = () => {
      if (binding.result && (!validRecord(binding.result) || binding.result.sourcePostId !== record.sourcePostId)) {
        failure = new Error(CONFLICT_ERROR);
        transaction.abort();
      }
    };
    request.onsuccess = () => {
      try {
        const records = recordsForSource<T>(request.result as unknown[], record.sourcePostId);
        const current = records.find((item) => item.commissionId === record.commissionId);
        if (options.migrateOnly) {
          if (current) { result = current; return; }
        } else if (options.startAttempt) {
          if (current && (current.attemptId !== options.expectedAttemptId || current.outcome === "pending" || current.outcome === "captured")) throw new Error(CONFLICT_ERROR);
          if (records.some((item) => item.commissionId !== record.commissionId && item.outcome === "pending")) throw new Error(CONFLICT_ERROR);
          const latest = latestRecord(records);
          if (latest && latest.commissionId !== record.commissionId && latest.commissionId !== options.predecessorCommissionId) throw new Error(CONFLICT_ERROR);
        } else {
          if (!current || current.attemptId !== record.attemptId || current.attemptId !== options.expectedAttemptId) throw new Error(CONFLICT_ERROR);
          const signature = (current.checkout as {transactionSignature?: string}).transactionSignature;
          if (options.expectedSignature !== undefined && signature !== options.expectedSignature) throw new Error(CONFLICT_ERROR);
          if (current.outcome !== "pending" && record.outcome !== current.outcome) throw new Error(CONFLICT_ERROR);
        }
        result = {...record, updatedAt: Math.max(record.updatedAt, ...records.map((item) => item.updatedAt + 1))};
        store.put(result);
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = transaction.onerror = () => { database.close(); reject(failure instanceof Error ? failure : new Error(STORAGE_ERROR)); };
  });
}

/** A lock remains held across asynchronous wallet approval and broadcast. */
export async function withFinancialLock<T>(sourcePostId: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) throw new Error("This browser cannot coordinate payments across tabs. Use a browser with Web Locks before paying.");
  return navigator.locks.request(`vox.realize.payment:${sourcePostId}`, {mode: "exclusive"}, action);
}

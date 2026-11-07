import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import type {Rpc} from "./nft-contract-migration.js";

export interface SubmissionJournal {
  schema: "vox-nft-contract-submission-v1";
  plan_sha256: string;
  transaction_hash: string;
  signed_transaction: string;
}
export function writeNewJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), {recursive: true});
  const descriptor = openSync(path, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function persistSubmission(path: string, journal: SubmissionJournal): void {
  try { writeNewJson(path, journal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const saved = JSON.parse(readFileSync(path, "utf8")) as SubmissionJournal;
  if (JSON.stringify(saved) !== JSON.stringify(journal)) throw new Error("journal already exists with different public transaction evidence; never overwrite or replace it");
}
/** The caller must already have verified the exact approval digest and recovered signer against its rebuilt plan. */
export async function submitJournaledTransaction(rpc: Rpc, journal: SubmissionJournal, persist: () => void, preflight: () => Promise<void>): Promise<void> {
  const priorReceipt = await rpc("eth_getTransactionReceipt", [journal.transaction_hash]);
  const priorTransaction = await rpc("eth_getTransactionByHash", [journal.transaction_hash]);
  if (!priorReceipt && !priorTransaction) {
    await preflight();
    persist(); // Exclusive create, comparison, file+directory fsync must finish before any network write.
    const sent = await rpc("eth_sendRawTransaction", [journal.signed_transaction]);
    if (typeof sent !== "string" || sent.toLowerCase() !== journal.transaction_hash) throw new Error("broadcast outcome is uncertain; preserve the journal and run verify before retrying");
  } else persist();
}

import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {persistSubmission, submitJournaledTransaction, type SubmissionJournal} from "../scripts/lib/nft-migration-journal.js";
import type {Rpc} from "../scripts/lib/nft-contract-migration.js";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, {recursive: true, force: true}); });
function path(): string { const directory = mkdtempSync(join(tmpdir(), "vox-journal-test-")); directories.push(directory); return join(directory, "submission.json"); }
const journal: SubmissionJournal = {schema: "vox-nft-contract-submission-v1", plan_sha256: "a".repeat(64), transaction_hash: "0x" + "b".repeat(64), signed_transaction: "0x02abcd"};
describe("public NFT deployment submission journal", () => {
  it("creates durable evidence once and allows only the same exact record", () => {
    const file = path();
    persistSubmission(file, journal);
    persistSubmission(file, journal);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(journal);
    expect(() => persistSubmission(file, {...journal, signed_transaction: "0x02cafe"})).toThrow(/never overwrite/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(journal);
  });
  it("never replaces a partial or malformed journal", () => {
    const file = path(); writeFileSync(file, "{");
    expect(() => persistSubmission(file, journal)).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{");
  });
  it("writes exact public bytes before broadcast and retains them if the RPC response is lost", async () => {
    const file = path(); const events: string[] = [];
    const rpc: Rpc = async (method, params) => {
      if (method !== "eth_sendRawTransaction") return null;
      events.push("send");
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(journal);
      expect(params).toEqual([journal.signed_transaction]);
      throw new Error("response lost");
    };
    await expect(submitJournaledTransaction(rpc, journal, () => {persistSubmission(file, journal); events.push("persist");}, async () => {events.push("preflight");})).rejects.toThrow(/response lost/);
    expect(events).toEqual(["preflight", "persist", "send"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(journal);
  });
  it("cannot broadcast when the journal cannot be persisted or preflight fails", async () => {
    for (const stage of ["persist", "preflight"]) {
      const sends: unknown[] = [];
      const rpc: Rpc = async (method) => { if (method === "eth_sendRawTransaction") sends.push(method); return null; };
      await expect(submitJournaledTransaction(rpc, journal, () => {if (stage === "persist") throw new Error("disk failure");}, async () => {if (stage === "preflight") throw new Error("nonce changed");})).rejects.toThrow();
      expect(sends).toEqual([]);
    }
  });
  it("recovers an already known submission without rebroadcasting or requiring an unexpired plan", async () => {
    let persisted = false;
    const rpc: Rpc = async (method) => {
      if (method === "eth_getTransactionReceipt") return null;
      if (method === "eth_getTransactionByHash") return {hash: journal.transaction_hash};
      throw new Error("must not broadcast");
    };
    await submitJournaledTransaction(rpc, journal, () => {persisted = true;}, async () => {throw new Error("expired");});
    expect(persisted).toBe(true);
  });
  it("rejects a broadcast acknowledgement for any other hash while retaining the same journal", async () => {
    const file = path();
    const rpc: Rpc = async (method) => method === "eth_sendRawTransaction" ? "0x" + "c".repeat(64) : null;
    await expect(submitJournaledTransaction(rpc, journal, () => persistSubmission(file, journal), async () => {})).rejects.toThrow(/uncertain/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(journal);
  });
});

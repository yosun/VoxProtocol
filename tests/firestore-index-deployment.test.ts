import {describe, expect, it, vi} from "vitest";
import {provisionProductionIndexes, validateIndexManifest} from "../scripts/deploy-firestore-indexes.mjs";

const approved = {GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "yosun/VoxProtocol", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", VOX_PRODUCTION_SENSITIVE_APPROVED: "true"};
const expected = {collectionGroup: "vox_nft_mints", queryScope: "COLLECTION", fields: [{fieldPath: "state", order: "ASCENDING"}, {fieldPath: "updated_at", order: "ASCENDING"}]};
const ready = {...expected, state: "READY"};

describe("protected additive index provisioning", () => {
  it("requires protected main approval before using any GCP commands", async () => {
    for (const env of [{}, {...approved, GITHUB_REF: "refs/heads/feature"}, {...approved, VOX_PRODUCTION_SENSITIVE_APPROVED: "false"}, {...approved, GITHUB_EVENT_NAME: "pull_request"}]) {
      const run = vi.fn();
      await expect(provisionProductionIndexes([expected], {env, run})).rejects.toThrow("protected production-sensitive");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("adds only missing definitions and waits until READY without deleting other indexes", async () => {
    let actual = [{collectionGroup: "vox_legacy", queryScope: "COLLECTION", fields: expected.fields, state: "READY"}];
    const run = vi.fn((args: string[]) => {
      if (args[3] === "create") actual.push({...expected, state: "CREATING"});
      return args[3] === "list" ? JSON.stringify(actual) : "{}";
    });
    const wait = vi.fn(async () => { actual = actual.map((index) => ({...index, state: "READY"})); });
    expect(await provisionProductionIndexes([expected], {env: approved, run, wait})).toEqual({created: 1, ready: 1});
    expect(wait).toHaveBeenCalledOnce();
    const create = run.mock.calls.find(([args]) => args[3] === "create")![0];
    expect(create).toEqual(expect.arrayContaining(["--project=voxprotocol", "--database=(default)", "--async", "--collection-group=vox_nft_mints", "--field-config=field-path=updated_at,order=ascending"]));
    expect(run.mock.calls.every(([args]) => ["list", "create"].includes(args[3]!))).toBe(true);
    expect(actual.some((index) => index.collectionGroup === "vox_legacy")).toBe(true);
  });

  it("does not recreate an existing building index", async () => {
    let state = "CREATING";
    const run = vi.fn(() => JSON.stringify([{...expected, state}]));
    const wait = vi.fn(async () => { state = "READY"; });
    expect(await provisionProductionIndexes([expected], {env: approved, run, wait})).toEqual({created: 0, ready: 1});
    expect(run.mock.calls.every(([args]) => args[3] === "list")).toBe(true);
  });

  it("supports the legacy message collection-group query without changing target project", async () => {
    const definition = {...expected, collectionGroup: "messages", queryScope: "COLLECTION_GROUP"};
    let created = false;
    const run = vi.fn((args: string[]) => {
      if (args[3] === "create") { expect(args).toContain("--query-scope=collection-group"); created = true; }
      return JSON.stringify(created ? [{...definition, state: "READY"}] : []);
    });
    expect(await provisionProductionIndexes([definition], {env: approved, run})).toEqual({created: 1, ready: 1});
  });

  it("handles concurrent creation only by observing the exact definition", async () => {
    let actual: object[] = [];
    const run = vi.fn((args: string[]) => {
      if (args[3] === "create") { actual = [ready]; throw Object.assign(new Error("conflict"), {stderr: "ALREADY_EXISTS"}); }
      return JSON.stringify(actual);
    });
    expect(await provisionProductionIndexes([expected], {env: approved, run})).toEqual({created: 0, ready: 1});
  });

  it("fails closed on permission errors, index repair, and readiness timeout", async () => {
    const denied = vi.fn((args: string[]) => {
      if (args[3] === "create") throw Object.assign(new Error("permission denied"), {stderr: "PERMISSION_DENIED"});
      return "[]";
    });
    await expect(provisionProductionIndexes([expected], {env: approved, run: denied})).rejects.toThrow("permission denied");
    await expect(provisionProductionIndexes([expected], {env: approved, run: () => JSON.stringify([{...expected, state: "NEEDS_REPAIR"}])})).rejects.toThrow("operator repair");
    let time = 0;
    await expect(provisionProductionIndexes([expected], {env: approved, run: () => JSON.stringify([{...expected, state: "CREATING"}]), timeoutMs: 10, now: () => time, wait: async (ms: number) => { time += ms; }})).rejects.toThrow("promotion remains blocked");
  });

  it("validates the entire manifest before any index creation", async () => {
    for (const invalid of [{...expected, collectionGroup: "unrelated"}, {...expected, queryScope: "COLLECTION_RECURSIVE"}, {...expected, fields: [expected.fields[0], expected.fields[0]]}, {...expected, fields: [{fieldPath: "a,b", order: "ASCENDING"}, expected.fields[1]]}]) {
      const run = vi.fn();
      await expect(provisionProductionIndexes([expected, invalid], {env: approved, run})).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
    expect(validateIndexManifest([expected])).toEqual([expected]);
  });
});

import {afterEach, describe, expect, it, vi} from "vitest";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";

const cloud = vi.hoisted(() => ({objects: new Map<string, {bytes: Buffer; metadata: any}>()}));
vi.mock("@google-cloud/storage", () => ({Storage: class {
  bucket(name: string) {
    return {file(path: string) {
      const key = `${name}/${path}`;
      return {
        async save(bytes: Buffer, options: any) {
          if (options.preconditionOpts?.ifGenerationMatch === 0 && cloud.objects.has(key)) throw Object.assign(new Error("already exists"), {code: 412});
          // Production has objectCreator + objectViewer, which cannot overwrite.
          if (cloud.objects.has(key)) throw Object.assign(new Error("overwrite forbidden"), {code: 403});
          cloud.objects.set(key, {bytes: Buffer.from(bytes), metadata: options.metadata});
        },
        async exists() { return [cloud.objects.has(key)]; },
        async download() { const object = cloud.objects.get(key); if (!object) throw Object.assign(new Error("not found"), {code: 404}); return [object.bytes]; },
        async getMetadata() { return [cloud.objects.get(key)?.metadata]; }
      };
    }};
  }
}}));

import {FileDirectMessageMediaStore, GcsDirectMessageMediaStore, MemoryDirectMessageMediaStore} from "../apps/api/src/direct-message-media-store.js";

const owner = `vox:human:${"a".repeat(43)}`;
const other = `vox:agent:${"b".repeat(43)}`;
const bytes = Buffer.from("Durable private attachment");
const hash = createHash("sha256").update(bytes).digest("hex");
let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, {recursive: true, force: true}); directory = undefined; cloud.objects.clear(); });

describe("direct-message media upload grants", () => {
  it("keeps per-uploader grants when the same bytes are deduplicated in memory", async () => {
    const store = new MemoryDirectMessageMediaStore();
    await store.put(hash, "image/png", bytes, owner);
    expect(await store.canAttach(hash, owner)).toBe(true);
    expect(await store.canAttach(hash, other)).toBe(false);
    await store.put(hash, "image/png", bytes, other);
    expect(await store.canAttach(hash, other)).toBe(true);
  });

  it("persists grants across file-store restarts and keeps legacy bytes private for new sends", async () => {
    directory = await mkdtemp(join(tmpdir(), "vox-dm-grants-"));
    const store = new FileDirectMessageMediaStore(directory);
    await store.put(hash, "image/png", bytes, owner);
    const restarted = new FileDirectMessageMediaStore(directory);
    expect(await restarted.canAttach(hash, owner)).toBe(true);
    expect(await restarted.canAttach(hash, other)).toBe(false);
    expect((await restarted.get(hash))?.bytes.equals(bytes)).toBe(true);
    await rm(join(directory, "uploaders"), {recursive: true});
    expect(await restarted.canAttach(hash, owner)).toBe(false);
    expect((await restarted.get(hash))?.bytes.equals(bytes)).toBe(true);
    await restarted.put(hash, "image/png", bytes, other);
    expect(await new FileDirectMessageMediaStore(directory).canAttach(hash, other)).toBe(true);
  });

  it("persists private GCS grants independently of encrypted object deduplication", async () => {
    const key = new Uint8Array(32).fill(17);
    const store = new GcsDirectMessageMediaStore("audit-bucket", key);
    await store.put(hash, "image/png", bytes, owner);
    const restarted = new GcsDirectMessageMediaStore("audit-bucket", key);
    expect(await restarted.canAttach(hash, owner)).toBe(true);
    expect(await restarted.canAttach(hash, other)).toBe(false);
    const encrypted = cloud.objects.get(`audit-bucket/direct-messages/sha256/${hash}`)!;
    expect(encrypted.bytes.includes(bytes)).toBe(false);
    expect((await restarted.get(hash))?.bytes.equals(bytes)).toBe(true);
    await restarted.put(hash, "image/png", bytes, other);
    await restarted.put(hash, "image/png", bytes, owner);
    await restarted.put(hash, "image/png", bytes, other);
    expect(await new GcsDirectMessageMediaStore("audit-bucket", key).canAttach(hash, other)).toBe(true);
    const grantKeys = [...cloud.objects.keys()].filter((path) => path.includes("/uploaders/"));
    expect(grantKeys).toHaveLength(2);
    expect(grantKeys.every((path) => !path.includes(owner) && !path.includes(other))).toBe(true);
  });
});

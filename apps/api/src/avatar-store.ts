import {Storage} from "@google-cloud/storage";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

const ASSET_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface AvatarAssetStore {
  put(assetHash: string, bytes: Buffer): Promise<void>;
  get(assetHash: string): Promise<Buffer | undefined>;
}

function validateAssetHash(assetHash: string): void {
  if (!ASSET_HASH_PATTERN.test(assetHash)) throw new Error("invalid avatar asset hash");
}

export class MemoryAvatarAssetStore implements AvatarAssetStore {
  private readonly assets = new Map<string, Buffer>();

  async put(assetHash: string, bytes: Buffer): Promise<void> {
    validateAssetHash(assetHash);
    const existing = this.assets.get(assetHash);
    if (existing && !existing.equals(bytes)) throw new Error("avatar asset hash collision");
    if (!existing) this.assets.set(assetHash, Buffer.from(bytes));
  }

  async get(assetHash: string): Promise<Buffer | undefined> {
    validateAssetHash(assetHash);
    const bytes = this.assets.get(assetHash);
    return bytes ? Buffer.from(bytes) : undefined;
  }
}

export class FileAvatarAssetStore implements AvatarAssetStore {
  constructor(private readonly rootDirectory: string) {}

  private pathFor(assetHash: string): string {
    validateAssetHash(assetHash);
    return join(this.rootDirectory, `${assetHash}.webp`);
  }

  async put(assetHash: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(assetHash);
    await mkdir(this.rootDirectory, {recursive: true, mode: 0o700});
    try {
      await writeFile(path, bytes, {flag: "wx", mode: 0o600});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (!existing.equals(bytes)) throw new Error("avatar asset hash collision");
    }
  }

  async get(assetHash: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.pathFor(assetHash));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class GcsAvatarAssetStore implements AvatarAssetStore {
  private readonly bucket: ReturnType<Storage["bucket"]>;

  constructor(bucketName: string, projectId?: string) {
    const storage = new Storage(projectId ? {projectId} : {});
    this.bucket = storage.bucket(bucketName);
  }

  private objectName(assetHash: string): string {
    validateAssetHash(assetHash);
    return `avatars/sha256/${assetHash}.webp`;
  }

  async put(assetHash: string, bytes: Buffer): Promise<void> {
    const file = this.bucket.file(this.objectName(assetHash));
    try {
      await file.save(bytes, {
        resumable: false,
        validation: "crc32c",
        contentType: "image/webp",
        metadata: {
          cacheControl: "public,max-age=31536000,immutable",
          contentDisposition: "inline",
          contentType: "image/webp",
          metadata: {processingVersion: "vox-avatar-v1"}
        },
        preconditionOpts: {ifGenerationMatch: 0}
      });
    } catch (error) {
      if ((error as {code?: number}).code !== 412) throw error;
      const existing = await file.download().then(([downloaded]) => downloaded);
      if (!existing.equals(bytes)) throw new Error("avatar asset hash collision");
    }
  }

  async get(assetHash: string): Promise<Buffer | undefined> {
    try {
      const [bytes] = await this.bucket.file(this.objectName(assetHash)).download();
      return bytes;
    } catch (error) {
      if ((error as {code?: number}).code === 404) return undefined;
      throw error;
    }
  }
}

export function createDefaultAvatarAssetStore(storageMode = process.env.VOX_STORAGE ?? "memory"): AvatarAssetStore {
  if (storageMode === "file") {
    return new FileAvatarAssetStore(join(process.env.VOX_STATE_DIR ?? ".vox-local", "avatars"));
  }
  if (storageMode === "firestore") {
    const bucketName = process.env.VOX_AVATAR_BUCKET;
    if (!bucketName) throw new Error("VOX_AVATAR_BUCKET is required when VOX_STORAGE=firestore");
    return new GcsAvatarAssetStore(bucketName, process.env.GOOGLE_CLOUD_PROJECT);
  }
  if (storageMode === "memory") return new MemoryAvatarAssetStore();
  throw new Error(`unsupported VOX_STORAGE: ${storageMode}`);
}

export function isAvatarAssetHash(value: string): boolean {
  return ASSET_HASH_PATTERN.test(value);
}

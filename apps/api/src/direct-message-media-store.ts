import {Storage} from "@google-cloud/storage";
import {access, mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface DirectMessageMediaStore {
  put(assetHash: string, mediaType: string, bytes: Buffer, uploaderId: string): Promise<void>;
  canAttach(assetHash: string, uploaderId: string): Promise<boolean>;
  get(assetHash: string): Promise<{mediaType: string; bytes: Buffer} | undefined>;
}

function validateHash(assetHash: string): void {
  if (!HASH_PATTERN.test(assetHash)) throw new Error("invalid direct message media hash");
}

function uploaderKey(uploaderId: string): string {
  if (!/^vox:(?:human|agent):[A-Za-z0-9_-]{43}$/.test(uploaderId)) throw new Error("invalid direct message media uploader");
  return createHash("sha256").update(uploaderId).digest("hex");
}

export class MemoryDirectMessageMediaStore implements DirectMessageMediaStore {
  private readonly assets = new Map<string, {mediaType: string; bytes: Buffer}>();
  private readonly uploaders = new Map<string, Set<string>>();

  async put(assetHash: string, mediaType: string, bytes: Buffer, uploaderId: string): Promise<void> {
    validateHash(assetHash);
    const owner = uploaderKey(uploaderId);
    const existing = this.assets.get(assetHash);
    if (existing && (!existing.bytes.equals(bytes) || existing.mediaType !== mediaType)) throw new Error("direct message media hash collision");
    if (!existing) this.assets.set(assetHash, {mediaType, bytes: Buffer.from(bytes)});
    const uploaders = this.uploaders.get(assetHash) ?? new Set<string>();
    uploaders.add(owner);
    this.uploaders.set(assetHash, uploaders);
  }

  async canAttach(assetHash: string, uploaderId: string): Promise<boolean> {
    validateHash(assetHash);
    return this.uploaders.get(assetHash)?.has(uploaderKey(uploaderId)) ?? false;
  }

  async get(assetHash: string): Promise<{mediaType: string; bytes: Buffer} | undefined> {
    validateHash(assetHash);
    const asset = this.assets.get(assetHash);
    return asset ? {mediaType: asset.mediaType, bytes: Buffer.from(asset.bytes)} : undefined;
  }
}

export class FileDirectMessageMediaStore implements DirectMessageMediaStore {
  constructor(private readonly rootDirectory: string) {}

  private pathFor(assetHash: string): string {
    validateHash(assetHash);
    return join(this.rootDirectory, assetHash);
  }

  async put(assetHash: string, mediaType: string, bytes: Buffer, uploaderId: string): Promise<void> {
    const path = this.pathFor(assetHash);
    const owner = uploaderKey(uploaderId);
    await mkdir(this.rootDirectory, {recursive: true, mode: 0o700});
    try {
      await writeFile(path, Buffer.concat([Buffer.from(`${mediaType}\n`), bytes]), {flag: "wx", mode: 0o600});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(path);
      const separator = existing.indexOf(10);
      if (separator < 0 || existing.subarray(0, separator).toString("utf8") !== mediaType || !existing.subarray(separator + 1).equals(bytes)) throw new Error("direct message media hash collision");
    }
    const grantsDirectory = join(this.rootDirectory, "uploaders", owner);
    await mkdir(grantsDirectory, {recursive: true, mode: 0o700});
    await writeFile(join(grantsDirectory, assetHash), "", {mode: 0o600});
  }

  async canAttach(assetHash: string, uploaderId: string): Promise<boolean> {
    validateHash(assetHash);
    try {
      await access(join(this.rootDirectory, "uploaders", uploaderKey(uploaderId), assetHash));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async get(assetHash: string): Promise<{mediaType: string; bytes: Buffer} | undefined> {
    try {
      const stored = await readFile(this.pathFor(assetHash));
      const separator = stored.indexOf(10);
      if (separator < 0) return undefined;
      return {mediaType: stored.subarray(0, separator).toString("utf8"), bytes: stored.subarray(separator + 1)};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export class GcsDirectMessageMediaStore implements DirectMessageMediaStore {
  private readonly bucket: ReturnType<Storage["bucket"]>;
  private readonly encryptionKey: Buffer;

  constructor(bucketName: string, encryptionKey: Uint8Array, projectId?: string) {
    this.bucket = new Storage(projectId ? {projectId} : {}).bucket(bucketName);
    this.encryptionKey = createHash("sha256").update("vox.dm.media.encryption.v1\0").update(encryptionKey).digest();
  }

  private objectName(assetHash: string): string {
    validateHash(assetHash);
    return `direct-messages/sha256/${assetHash}`;
  }

  async put(assetHash: string, mediaType: string, bytes: Buffer, uploaderId: string): Promise<void> {
    const file = this.bucket.file(this.objectName(assetHash));
    const owner = uploaderKey(uploaderId);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    try {
      await file.save(encrypted, {
        resumable: false,
        validation: "crc32c",
        contentType: "application/octet-stream",
        metadata: {cacheControl: "private,no-store", contentDisposition: "attachment", contentType: "application/octet-stream", metadata: {sha256: assetHash, mediaType}},
        preconditionOpts: {ifGenerationMatch: 0}
      });
    } catch (error) {
      if ((error as {code?: number}).code !== 412) throw error;
      const existing = await this.get(assetHash);
      if (!existing || existing.mediaType !== mediaType || !existing.bytes.equals(bytes)) throw new Error("direct message media hash collision");
    }
    // Knowledge of a content hash does not grant permission to share its bytes.
    // Record the verified uploader separately so globally deduplicated objects
    // cannot be attached to an unrelated conversation by guessing their hash.
    try {
      await this.bucket.file(`direct-messages/uploaders/${owner}/${assetHash}`).save(Buffer.alloc(0), {
        resumable: false,
        metadata: {cacheControl: "private,no-store", contentType: "application/octet-stream"},
        preconditionOpts: {ifGenerationMatch: 0}
      });
    } catch (error) {
      // Grants are immutable markers. Retries need no overwrite permission.
      if ((error as {code?: number}).code !== 412) throw error;
    }
  }

  async canAttach(assetHash: string, uploaderId: string): Promise<boolean> {
    validateHash(assetHash);
    const [exists] = await this.bucket.file(`direct-messages/uploaders/${uploaderKey(uploaderId)}/${assetHash}`).exists();
    return exists;
  }

  async get(assetHash: string): Promise<{mediaType: string; bytes: Buffer} | undefined> {
    try {
      const file = this.bucket.file(this.objectName(assetHash));
      const [[encrypted], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
      if (encrypted.byteLength < 28) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, encrypted.subarray(0, 12));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const bytes = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
      const mediaType = typeof metadata.metadata?.mediaType === "string" ? metadata.metadata.mediaType : "application/octet-stream";
      return {mediaType, bytes};
    } catch (error) {
      if ((error as {code?: number}).code === 404) return undefined;
      throw error;
    }
  }
}

export function createDefaultDirectMessageMediaStore(storageMode = process.env.VOX_STORAGE ?? "memory", encryptionKey: Uint8Array = Buffer.from(process.env.VOX_INSTANCE_SECRET_KEY ?? "local-vox-dm-media", "utf8")): DirectMessageMediaStore {
  if (storageMode === "file") return new FileDirectMessageMediaStore(join(process.env.VOX_STATE_DIR ?? ".vox-local", "direct-message-media"));
  if (storageMode === "firestore") {
    const bucketName = process.env.VOX_AVATAR_BUCKET;
    if (!bucketName) throw new Error("VOX_AVATAR_BUCKET is required when VOX_STORAGE=firestore");
    return new GcsDirectMessageMediaStore(bucketName, encryptionKey, process.env.GOOGLE_CLOUD_PROJECT);
  }
  if (storageMode === "memory") return new MemoryDirectMessageMediaStore();
  throw new Error(`unsupported VOX_STORAGE: ${storageMode}`);
}

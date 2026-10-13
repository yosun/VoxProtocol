import {createHash} from "node:crypto";
import sharp from "sharp";
import type {AvatarUploadContentType} from "@vox/protocol";

export const AVATAR_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const AVATAR_MAX_INPUT_PIXELS = 20_000_000;
export const AVATAR_OUTPUT_SIZE = 256 as const;
export const AVATAR_MAX_OUTPUT_BYTES = 512 * 1024;
export const AVATAR_PROCESSING_VERSION = "vox-avatar-v1" as const;

export interface ProcessedAvatar {
  asset_hash: string;
  bytes: Buffer;
  media_type: "image/webp";
  byte_length: number;
  width: 256;
  height: 256;
  processing_version: typeof AVATAR_PROCESSING_VERSION;
}

function sniffImageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function processAvatar(bytes: Buffer, declaredContentType: AvatarUploadContentType): Promise<ProcessedAvatar> {
  if (bytes.length === 0) throw new Error("avatar image is empty");
  if (bytes.length > AVATAR_MAX_UPLOAD_BYTES) throw new Error("avatar image exceeds the 4 MiB limit");
  const detectedType = sniffImageType(bytes);
  if (!detectedType) throw new Error("avatar must be a JPEG, PNG, or WebP raster image");
  if (declaredContentType !== "application/octet-stream" && declaredContentType !== detectedType) {
    throw new Error("avatar content type does not match its file signature");
  }

  const source = sharp(bytes, {failOn: "error", limitInputPixels: AVATAR_MAX_INPUT_PIXELS});
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("avatar dimensions are unavailable");
  if (metadata.width * metadata.height > AVATAR_MAX_INPUT_PIXELS) throw new Error("avatar pixel dimensions are too large");
  if ((metadata.pages ?? 1) > 1) throw new Error("animated avatars are not supported");
  if (metadata.format !== "jpeg" && metadata.format !== "png" && metadata.format !== "webp") throw new Error("avatar format is not supported");

  const output = await sharp(bytes, {failOn: "error", limitInputPixels: AVATAR_MAX_INPUT_PIXELS})
    .rotate()
    .resize({width: AVATAR_OUTPUT_SIZE, height: AVATAR_OUTPUT_SIZE, fit: "cover", position: "centre"})
    .webp({quality: 82, effort: 4})
    .toBuffer();
  if (output.length > AVATAR_MAX_OUTPUT_BYTES) throw new Error("processed avatar exceeds the output size limit");
  const assetHash = createHash("sha256").update(output).digest("hex");
  return {asset_hash: assetHash, bytes: output, media_type: "image/webp", byte_length: output.length, width: AVATAR_OUTPUT_SIZE, height: AVATAR_OUTPUT_SIZE, processing_version: AVATAR_PROCESSING_VERSION};
}

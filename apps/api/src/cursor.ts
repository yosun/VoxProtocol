import { base64UrlToBytes, bytesToBase64Url, utf8 } from "@vox/protocol";

export interface CursorValue {
  accepted_at: string;
  post_id: string;
}

export function encodeCursor(value: CursorValue): string {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

export function decodeCursor(value: string | undefined): CursorValue | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as CursorValue;
    if (typeof parsed.accepted_at !== "string" || typeof parsed.post_id !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

import {bytesToHex, concatBytes, utf8} from "./encoding.js";
import {sha256} from "./hash.js";

export interface RealizeWebhookHeadersV1 {
  webhook_id: string;
  timestamp: string;
  signature: string;
}

export function realizeWebhookSigningPayload(webhookId: string, timestamp: string, rawBody: Uint8Array): Uint8Array {
  if (!/^[A-Za-z0-9:_-]{1,256}$/.test(webhookId) || !/^(0|[1-9][0-9]{0,12})$/.test(timestamp)) throw new Error("invalid webhook ID or Unix timestamp");
  // Preserve VOX's callback signing profile. Job bindings and monotonic
  // state guards prevent repeated deliveries from causing replay effects.
  return concatBytes(utf8(`${timestamp}.`), rawBody);
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = block.map((byte) => byte ^ 0x36);
  const outer = block.map((byte) => byte ^ 0x5c);
  return sha256(concatBytes(outer, sha256(concatBytes(inner, message))));
}

/** Sign raw bytes, before any JSON parser normalizes whitespace or key ordering. */
export function signRealizeWebhook(webhookId: string, timestamp: string, rawBody: Uint8Array, secret: Uint8Array): string {
  if (secret.length < 32) throw new Error("webhook secret must contain at least 32 bytes");
  return `v1=${bytesToHex(hmacSha256(secret, realizeWebhookSigningPayload(webhookId, timestamp, rawBody)))}`;
}

/** Authentication only: the receiver must separately persist event IDs and body hashes. */
export function verifyRealizeWebhook(headers: RealizeWebhookHeadersV1, rawBody: Uint8Array, secret: Uint8Array, nowUnixSeconds: number): boolean {
  try {
    if (!Number.isSafeInteger(nowUnixSeconds) || !/^v1=[0-9a-f]{64}$/.test(headers.signature) || Math.abs(Number(headers.timestamp) - nowUnixSeconds) > 300) return false;
    const expected = signRealizeWebhook(headers.webhook_id, headers.timestamp, rawBody, secret);
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ headers.signature.charCodeAt(index);
    return difference === 0;
  } catch {
    return false;
  }
}

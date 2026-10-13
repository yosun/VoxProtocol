import nacl from "tweetnacl";
import {base64UrlToBytes, bytesToBase64Url} from "./encoding.js";

/** Small Ed25519 primitives shared by signed Realize contract records. */
export function signBytes(payload: Uint8Array, secretKey: Uint8Array): string {
  if (secretKey.length !== 64) throw new Error("TweetNaCl Ed25519 secret keys are 64 bytes");
  return bytesToBase64Url(nacl.sign.detached(payload, secretKey));
}

export function verifyBytes(payload: Uint8Array, signature: string, publicKey: string | Uint8Array): boolean {
  try {
    const key = typeof publicKey === "string" ? base64UrlToBytes(publicKey) : publicKey;
    if (key.length !== 32) return false;
    const signatureBytes = base64UrlToBytes(signature);
    return signatureBytes.length === 64 && nacl.sign.detached.verify(payload, signatureBytes, key);
  } catch {
    return false;
  }
}

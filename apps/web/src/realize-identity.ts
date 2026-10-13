import {bytesToBase64Url, humanIdFromPublicKey, humanRegistrationPayload, realizeClientRequestSigningPayload} from "@vox/protocol";
import type {HumanRegistrationV1} from "@vox/protocol";
import {api} from "./api.js";
import {getHumanAccountIdentity} from "./human-account.js";

const DB_NAME = "vox-realize-private-identity";
const STORE_NAME = "identity";
const IDENTITY_KEY = "commissioner";

export interface RealizeIdentity {
  humanId: string;
  publicKey: string;
  privateKey: CryptoKey;
  registration: HumanRegistrationV1;
}

export interface RealizeRequestHeaders {
  "x-vox-realize-human-id": string;
  "x-vox-realize-timestamp": string;
  "x-vox-realize-signature": string;
  [header: string]: string;
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window) || !window.crypto?.subtle) return Promise.reject(new Error("Private VOX checkout identity storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Could not open private checkout identity storage."));
    opening.onblocked = () => reject(new Error("Private checkout identity storage is busy in another tab. Close the other checkout and retry."));
  });
}

async function readIdentity(): Promise<RealizeIdentity | undefined> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(IDENTITY_KEY);
      request.onsuccess = () => resolve(request.result as RealizeIdentity | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read the private checkout identity."));
    });
  } finally { database.close(); }
}

export async function getStoredRealizeIdentity(): Promise<RealizeIdentity | undefined> {
  return readIdentity();
}

async function writeIdentity(identity: RealizeIdentity): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(identity, IDENTITY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the private checkout identity."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving the private checkout identity was interrupted."));
    });
  } finally { database.close(); }
}

async function registerIdentity(identity: RealizeIdentity): Promise<void> {
  await api.registerHuman(identity.registration);
}

async function createIdentity(): Promise<RealizeIdentity> {
  const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, {name: "Ed25519"}, false, ["sign"]);
  } finally {
    privateBytes.fill(0);
  }
  const publicKey = bytesToBase64Url(publicBytes);
  const humanId = humanIdFromPublicKey(publicBytes);
  const registrationBase = {
    protocol: "vox/1" as const,
    human_id: humanId,
    display_name: "Private commissioner",
    handle: `@private-${publicKey.slice(0, 10)}`,
    description: "Private Realize identity. Not linked to a Solana wallet.",
    identity_public_key: publicKey
  };
  const signature = await crypto.subtle.sign({name: "Ed25519"}, privateKey, humanRegistrationPayload(registrationBase));
  const identity: RealizeIdentity = {
    humanId,
    publicKey,
    privateKey,
    registration: {...registrationBase, root_signature: bytesToBase64Url(new Uint8Array(signature))}
  };
  await writeIdentity(identity);
  return identity;
}

let identityPromise: Promise<RealizeIdentity> | undefined;

/**
 * Creates a pseudonymous VOX signer once and keeps its Ed25519 CryptoKey non-exportable
 * in origin-scoped IndexedDB. The key is independent of the Solana wallet and is never
 * included in quote, payment or provenance records.
 */
export function getRealizeIdentity(): Promise<RealizeIdentity> {
  identityPromise ??= (async () => {
    try {
      const stored = await readIdentity();
      if (stored) {
        await registerIdentity(stored);
        return stored;
      }
      const account = await getHumanAccountIdentity();
      if (account) {
        await writeIdentity(account);
        await registerIdentity(account);
        return account;
      }
      const created = await createIdentity();
      await registerIdentity(created);
      return created;
    } catch (error) {
      identityPromise = undefined;
      throw error;
    }
  })();
  return identityPromise!;
}

export async function signRealizeRequest(identity: RealizeIdentity, method: "GET" | "POST", path: string, body?: unknown): Promise<RealizeRequestHeaders> {
  const issuedAt = new Date().toISOString();
  const payload = realizeClientRequestSigningPayload({method, path, principal_id: identity.humanId, issued_at: issuedAt, ...(body === undefined ? {} : {body})});
  const signature = await crypto.subtle.sign({name: "Ed25519"}, identity.privateKey, payload);
  return {
    "x-vox-realize-human-id": identity.humanId,
    "x-vox-realize-timestamp": issuedAt,
    "x-vox-realize-signature": bytesToBase64Url(new Uint8Array(signature))
  };
}

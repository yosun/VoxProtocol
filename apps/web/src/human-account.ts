import {bytesToBase64Url, base64UrlToBytes, humanClientRequestSigningPayload, humanIdFromPublicKey, humanRegistrationPayload, verifyHumanRegistration, type HumanRegistrationV1} from "@vox/protocol";
import {api, type HumanRecord} from "./api.js";

const DB_NAME = "vox-human-account";
const STORE_NAME = "identity";
const IDENTITY_KEY = "account";
const BACKUP_FORMAT = "vox.human.account";
const BACKUP_VERSION = 1;
const BACKUP_ITERATIONS = 310_000;

export interface HumanAccountIdentity {
  humanId: string;
  publicKey: string;
  privateKey: CryptoKey;
  registration: HumanRegistrationV1;
}

interface AccountBackupV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  registration: HumanRegistrationV1;
  encryption: {algorithm: "PBKDF2-SHA256+A256GCM"; iterations: number; salt: string; iv: string; ciphertext: string};
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window) || !window.crypto?.subtle) return Promise.reject(new Error("Secure account storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE_NAME);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Could not open account storage."));
    opening.onblocked = () => reject(new Error("Account storage is busy in another tab. Close the other VOX tab and retry."));
  });
}

export async function getHumanAccountIdentity(): Promise<HumanAccountIdentity | undefined> {
  const database = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(IDENTITY_KEY);
      request.onsuccess = () => resolve(request.result as HumanAccountIdentity | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read your VOX account."));
    });
  } finally { database.close(); }
}

export async function saveHumanAccountIdentity(identity: HumanAccountIdentity): Promise<void> {
  const database = await openIdentityDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(identity, IDENTITY_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save your VOX account."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving your VOX account was interrupted."));
    });
  } finally { database.close(); }
}

export async function registerHumanAccount(identity: HumanAccountIdentity): Promise<HumanRecord> {
  return api.registerHuman(identity.registration);
}

export async function getCurrentHumanProfile(): Promise<HumanRecord> {
  const identity = await getHumanAccountIdentity();
  if (!identity) throw new Error("Sign in to a VOX human account first.");
  const issuedAt = new Date().toISOString();
  const signature = await crypto.subtle.sign({name: "Ed25519"}, identity.privateKey, humanClientRequestSigningPayload({method: "GET", path: "/v1/me", principal_id: identity.humanId, issued_at: issuedAt}));
  const profile = await api.me({
    "x-vox-human-id": identity.humanId,
    "x-vox-human-timestamp": issuedAt,
    "x-vox-human-signature": bytesToBase64Url(new Uint8Array(signature))
  });
  if (profile.registration.human_id !== identity.humanId) throw new Error("VOX returned a different account profile.");
  return profile;
}

export async function createHumanAccountIdentity(input: {displayName: string; username?: string; description: string}): Promise<HumanAccountIdentity> {
  const pair = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = bytesToBase64Url(publicBytes);
  const humanId = humanIdFromPublicKey(publicBytes);
  const registrationBase = {
    protocol: "vox/1" as const,
    human_id: humanId,
    display_name: input.displayName.trim(),
    ...(input.username ? {username: input.username} : {}),
    handle: input.username ? `@${input.username}` : `@${publicKey.slice(0, 10)}`,
    description: input.description.trim(),
    identity_public_key: publicKey
  };
  const signature = await crypto.subtle.sign({name: "Ed25519"}, pair.privateKey, humanRegistrationPayload(registrationBase));
  const registration: HumanRegistrationV1 = {...registrationBase, root_signature: bytesToBase64Url(new Uint8Array(signature))};
  return {humanId, publicKey, privateKey: pair.privateKey, registration};
}

export async function protectHumanAccountIdentity(identity: HumanAccountIdentity): Promise<HumanAccountIdentity> {
  if (!identity.privateKey.extractable) return identity;
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.privateKey));
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, {name: "Ed25519"}, false, ["sign"]);
    return {...identity, privateKey};
  } finally { privateBytes.fill(0); }
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({name: "PBKDF2", hash: "SHA-256", salt, iterations: iterations}, material, {name: "AES-GCM", length: 256}, false, usage);
}

export async function createAccountBackup(identity: HumanAccountIdentity, passphrase: string): Promise<Blob> {
  if (passphrase.length < 12) throw new Error("Use a recovery passphrase of at least 12 characters.");
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.privateKey));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await deriveBackupKey(passphrase, salt, BACKUP_ITERATIONS, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, privateBytes);
    const backup: AccountBackupV1 = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      registration: identity.registration,
      encryption: {algorithm: "PBKDF2-SHA256+A256GCM", iterations: BACKUP_ITERATIONS, salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(ciphertext))}
    };
    return new Blob([JSON.stringify(backup, null, 2)], {type: "application/json"});
  } finally { privateBytes.fill(0); }
}

function isAccountBackup(value: unknown): value is AccountBackupV1 {
  if (!value || typeof value !== "object") return false;
  const backup = value as Partial<AccountBackupV1>;
  return backup.format === BACKUP_FORMAT && backup.version === BACKUP_VERSION &&
    !!backup.registration && verifyHumanRegistration(backup.registration) &&
    backup.encryption?.algorithm === "PBKDF2-SHA256+A256GCM" &&
    Number.isSafeInteger(backup.encryption.iterations) && backup.encryption.iterations! >= 200_000 && backup.encryption.iterations! <= 1_000_000 &&
    [backup.encryption.salt, backup.encryption.iv, backup.encryption.ciphertext].every((item) => typeof item === "string");
}

export async function restoreHumanAccountBackup(file: File, passphrase: string): Promise<HumanAccountIdentity> {
  if (file.size > 64_000) throw new Error("That recovery file is too large to be a VOX account backup.");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch { throw new Error("That file is not a valid VOX account recovery file."); }
  if (!isAccountBackup(parsed)) throw new Error("That file is not a supported VOX account recovery file.");
  const salt = base64UrlToBytes(parsed.encryption.salt);
  const iv = base64UrlToBytes(parsed.encryption.iv);
  const ciphertext = base64UrlToBytes(parsed.encryption.ciphertext);
  let privateBytes: Uint8Array | undefined;
  try {
    const key = await deriveBackupKey(passphrase, salt, parsed.encryption.iterations, ["decrypt"]);
    privateBytes = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv}, key, ciphertext));
    const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, {name: "Ed25519"}, false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("raw", base64UrlToBytes(parsed.registration.identity_public_key), {name: "Ed25519"}, false, ["verify"]);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const proof = await crypto.subtle.sign({name: "Ed25519"}, privateKey, challenge);
    if (!await crypto.subtle.verify({name: "Ed25519"}, publicKey, proof, challenge)) throw new Error("This recovery file's key does not match its account profile.");
    const publicKeyText = parsed.registration.identity_public_key;
    const identity: HumanAccountIdentity = {humanId: parsed.registration.human_id, publicKey: publicKeyText, privateKey, registration: parsed.registration};
    if (!verifyHumanRegistration(identity.registration)) throw new Error("The recovery file contains an invalid VOX identity.");
    return identity;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("This recovery file")) throw error;
    throw new Error("Could not unlock this recovery file. Check the passphrase and try again.");
  } finally { privateBytes?.fill(0); }
}

export function humanProfileUrl(identity: HumanAccountIdentity): string {
  return identity.registration.username ? `/${encodeURIComponent(identity.registration.username)}` : `/humans/${encodeURIComponent(identity.humanId)}`;
}

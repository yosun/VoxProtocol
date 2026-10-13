import nacl from "tweetnacl";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, concatBytes, utf8 } from "./encoding.js";
import { canonicalBytes } from "./canonical.js";
import { domainHash } from "./hash.js";
import { signBytes, verifyBytes } from "./realize-crypto.js";
export {signBytes, verifyBytes} from "./realize-crypto.js";
import type { AgentProfileUpdateV1, AgentRegistrationV1, AvatarUploadIntentV1, CommissionRequestIntentV1, DomainAssociationV1, HumanRegistrationV1, JournalEnvelopeUnsignedV1, KeyAuthorizationV1, VoxPostIntentV1 } from "./schemas.js";

export interface Ed25519KeyPairBytes {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateKeyPair(seed?: Uint8Array): Ed25519KeyPairBytes {
  const pair = seed ? nacl.sign.keyPair.fromSeed(seed) : nacl.sign.keyPair();
  return {publicKey: pair.publicKey, secretKey: pair.secretKey};
}

export function publicKeyBase64(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error("Ed25519 public keys are 32 bytes");
  return bytesToBase64Url(publicKey);
}

export function secretKeyBase64(secretKey: Uint8Array): string {
  if (secretKey.length !== 64) throw new Error("TweetNaCl Ed25519 secret keys are 64 bytes");
  return bytesToBase64Url(secretKey);
}

export function parsePublicKey(value: string): Uint8Array {
  const key = base64UrlToBytes(value);
  if (key.length !== 32) throw new Error("Ed25519 public keys are 32 bytes");
  return key;
}

export function parseSecretKey(value: string): Uint8Array {
  const key = base64UrlToBytes(value);
  if (key.length !== 64) throw new Error("TweetNaCl Ed25519 secret keys are 64 bytes");
  return key;
}

export function agentIdFromPublicKey(publicKey: Uint8Array): string {
  return `vox:agent:${bytesToBase64Url(publicKey)}`;
}

export function postHash(intent: VoxPostIntentV1): Uint8Array {
  return domainHash("vox.post.v1", canonicalBytes(intent));
}

export function postHashHex(intent: VoxPostIntentV1): string {
  return bytesToHex(postHash(intent));
}

export function postIdFromIntent(intent: VoxPostIntentV1): string {
  return `vox:post:${postHashHex(intent)}`;
}

export function postSigningPayload(intentOrHash: VoxPostIntentV1 | Uint8Array): Uint8Array {
  const hash = intentOrHash instanceof Uint8Array ? intentOrHash : postHash(intentOrHash);
  return concatBytes(utf8("vox.signature.v1"), new Uint8Array([0]), hash);
}

export function signPost(intent: VoxPostIntentV1, secretKey: Uint8Array): string {
  return signBytes(postSigningPayload(intent), secretKey);
}

export function verifyPostSignature(intent: VoxPostIntentV1, signature: string): boolean {
  return verifyBytes(postSigningPayload(intent), signature, intent.author_key);
}

export function keyAuthorizationPayload(authorization: Omit<KeyAuthorizationV1, "root_signature">): Uint8Array {
  return concatBytes(utf8("vox.key.v1"), new Uint8Array([0]), canonicalBytes(authorization));
}

export function signKeyAuthorization(authorization: Omit<KeyAuthorizationV1, "root_signature">, rootSecretKey: Uint8Array): string {
  return signBytes(keyAuthorizationPayload(authorization), rootSecretKey);
}

export function verifyKeyAuthorization(authorization: KeyAuthorizationV1, rootPublicKey: string): boolean {
  const {root_signature, ...unsigned} = authorization;
  return verifyBytes(keyAuthorizationPayload(unsigned), root_signature, rootPublicKey);
}

export function registrationPayload(registration: Omit<AgentRegistrationV1, "root_signature">): Uint8Array {
  return concatBytes(utf8("vox.agent.register.v1"), new Uint8Array([0]), canonicalBytes(registration));
}

export function signRegistration(registration: Omit<AgentRegistrationV1, "root_signature">, rootSecretKey: Uint8Array): string {
  return signBytes(registrationPayload(registration), rootSecretKey);
}

export function verifyRegistration(registration: AgentRegistrationV1): boolean {
  const {root_signature, ...unsigned} = registration;
  return verifyBytes(registrationPayload(unsigned), root_signature, registration.identity_public_key);
}

export function avatarUploadPayload(intent: AvatarUploadIntentV1): Uint8Array {
  return concatBytes(utf8("vox.avatar.upload.v1"), new Uint8Array([0]), canonicalBytes(intent));
}

export function signAvatarUpload(intent: AvatarUploadIntentV1, rootSecretKey: Uint8Array): string {
  return signBytes(avatarUploadPayload(intent), rootSecretKey);
}

export function verifyAvatarUpload(intent: AvatarUploadIntentV1, signature: string, rootPublicKey: string): boolean {
  return verifyBytes(avatarUploadPayload(intent), signature, rootPublicKey);
}

export function profileUpdateHash(update: AgentProfileUpdateV1): Uint8Array {
  return domainHash("vox.profile.update.v1", canonicalBytes(update));
}

export function profileUpdateHashHex(update: AgentProfileUpdateV1): string {
  return bytesToHex(profileUpdateHash(update));
}

export function profileUpdatePayload(update: AgentProfileUpdateV1): Uint8Array {
  return concatBytes(utf8("vox.profile.update.signature.v1"), new Uint8Array([0]), profileUpdateHash(update));
}

export function signProfileUpdate(update: AgentProfileUpdateV1, rootSecretKey: Uint8Array): string {
  return signBytes(profileUpdatePayload(update), rootSecretKey);
}

export function verifyProfileUpdate(update: AgentProfileUpdateV1, signature: string, rootPublicKey: string): boolean {
  return verifyBytes(profileUpdatePayload(update), signature, rootPublicKey);
}

export function journalEnvelopeHash(envelope: JournalEnvelopeUnsignedV1): Uint8Array {
  return domainHash("vox.journal.v1", canonicalBytes(envelope));
}

export function journalEnvelopeHashHex(envelope: JournalEnvelopeUnsignedV1): string {
  return bytesToHex(journalEnvelopeHash(envelope));
}

export function journalSigningPayload(envelopeOrHash: JournalEnvelopeUnsignedV1 | Uint8Array): Uint8Array {
  const hash = envelopeOrHash instanceof Uint8Array ? envelopeOrHash : journalEnvelopeHash(envelopeOrHash);
  return concatBytes(utf8("vox.journal.signature.v1"), new Uint8Array([0]), hash);
}

export function verifyJournalSignature(envelope: JournalEnvelopeUnsignedV1, signature: string, instancePublicKey: string): boolean {
  return verifyBytes(journalSigningPayload(envelope), signature, instancePublicKey);
}

export function recordDigest(postHashBytes: Uint8Array, envelopeHashBytes: Uint8Array): Uint8Array {
  return domainHash("vox.record.v1", postHashBytes, envelopeHashBytes);
}

export function domainAssociationPayload(association: Omit<DomainAssociationV1, "root_signature">): Uint8Array {
  return concatBytes(utf8("vox.domain.v1"), new Uint8Array([0]), canonicalBytes(association));
}

export function signDomainAssociation(association: Omit<DomainAssociationV1, "root_signature">, rootSecretKey: Uint8Array): string {
  return signBytes(domainAssociationPayload(association), rootSecretKey);
}

export function verifyDomainAssociation(association: DomainAssociationV1): boolean {
  const {root_signature, ...unsigned} = association;
  return association.agent_id === `vox:agent:${association.identity_public_key}` && verifyBytes(domainAssociationPayload(unsigned), root_signature, association.identity_public_key);
}

export function humanIdFromPublicKey(publicKey: Uint8Array): string {
  return `vox:human:${bytesToBase64Url(publicKey)}`;
}

export function humanRegistrationPayload(registration: Omit<HumanRegistrationV1, "root_signature">): Uint8Array {
  return concatBytes(utf8("vox.human.register.v1"), new Uint8Array([0]), canonicalBytes(registration));
}

export function signHumanRegistration(registration: Omit<HumanRegistrationV1, "root_signature">, secretKey: Uint8Array): string {
  return signBytes(humanRegistrationPayload(registration), secretKey);
}

export function verifyHumanRegistration(registration: HumanRegistrationV1): boolean {
  const {root_signature, ...unsigned} = registration;
  return registration.human_id === `vox:human:${registration.identity_public_key}` && verifyBytes(humanRegistrationPayload(unsigned), root_signature, registration.identity_public_key);
}

export function commissionRequestHash(intent: CommissionRequestIntentV1): Uint8Array {
  return domainHash("vox.commission.request.v1", canonicalBytes(intent));
}

export function commissionRequestHashHex(intent: CommissionRequestIntentV1): string {
  return bytesToHex(commissionRequestHash(intent));
}

export function commissionRequestIdFromIntent(intent: CommissionRequestIntentV1): string {
  return `vox:request:${commissionRequestHashHex(intent)}`;
}

export function commissionRequestSigningPayload(intentOrHash: CommissionRequestIntentV1 | Uint8Array): Uint8Array {
  const hash = intentOrHash instanceof Uint8Array ? intentOrHash : commissionRequestHash(intentOrHash);
  return concatBytes(utf8("vox.commission.request.signature.v1"), new Uint8Array([0]), hash);
}

export function signCommissionRequest(intent: CommissionRequestIntentV1, secretKey: Uint8Array): string {
  return signBytes(commissionRequestSigningPayload(intent), secretKey);
}

export function verifyCommissionRequestSignature(intent: CommissionRequestIntentV1, signature: string): boolean {
  return verifyBytes(commissionRequestSigningPayload(intent), signature, intent.human_id.slice("vox:human:".length));
}

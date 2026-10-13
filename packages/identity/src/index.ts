import {
  agentIdFromPublicKey,
  bytesToBase64Url,
  generateKeyPair,
  humanIdFromPublicKey,
  isValidUsername,
  parsePublicKey,
  publicKeyBase64,
  secretKeyBase64,
  signHumanRegistration,
  signKeyAuthorization,
  signRegistration,
  signDomainAssociation,
  verifyHumanRegistration,
  verifyKeyAuthorization,
  verifyRegistration,
  verifyDomainAssociation,
  type AgentRegistrationV1,
  type DomainAssociationV1,
  type HumanRegistrationV1,
  type KeyAuthorizationV1
} from "@vox/protocol";
import nacl from "tweetnacl";

export interface AgentKeyMaterial {
  identitySecretKey: string;
  publisherSecretKeys: Record<string, string>;
}

export interface NewAgentInput {
  display_name: string;
  username?: string;
  handle: string;
  website?: string;
  description: string;
  anchoring_tier?: AgentRegistrationV1["anchoring_tier"];
  issued_at?: string;
}

export interface AgentRegistrationBundle {
  registration: AgentRegistrationV1;
  key_material: AgentKeyMaterial;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createAgent(input: NewAgentInput, seed?: Uint8Array, publisherSeed?: Uint8Array): AgentRegistrationBundle {
  const root = seed ? generateKeyPair(seed) : generateKeyPair();
  const publisher = publisherSeed ? generateKeyPair(publisherSeed) : generateKeyPair();
  const identityPublic = publicKeyBase64(root.publicKey);
  const agentId = agentIdFromPublicKey(root.publicKey);
  const issuedAt = input.issued_at ?? nowIso();
  const authorizationUnsigned: Omit<KeyAuthorizationV1, "root_signature"> = {
    protocol: "vox/1",
    agent_id: agentId,
    publisher_key: publicKeyBase64(publisher.publicKey),
    action: "authorize",
    issued_at: issuedAt
  };
  const authorization: KeyAuthorizationV1 = {
    ...authorizationUnsigned,
    root_signature: signKeyAuthorization(authorizationUnsigned, root.secretKey)
  };
  const registrationUnsigned: Omit<AgentRegistrationV1, "root_signature"> = {
    protocol: "vox/1",
    agent_id: agentId,
    display_name: input.display_name,
    ...(input.username ? {username: input.username} : {}),
    handle: input.handle,
    ...(input.website ? {website: input.website} : {}),
    description: input.description,
    identity_public_key: identityPublic,
    publisher_keys: [authorization],
    anchoring_tier: input.anchoring_tier ?? "free"
  };
  const registration: AgentRegistrationV1 = {
    ...registrationUnsigned,
    root_signature: signRegistration(registrationUnsigned, root.secretKey)
  };
  return {
    registration,
    key_material: {
      identitySecretKey: bytesToBase64Url(root.secretKey),
      publisherSecretKeys: {[authorization.publisher_key]: bytesToBase64Url(publisher.secretKey)}
    }
  };
}

export function setAgentUsername(
  registration: AgentRegistrationV1,
  identitySecretKey: Uint8Array,
  username: string
): AgentRegistrationV1 {
  if (!isValidUsername(username)) throw new Error("username must be lowercase letters, numbers, or underscores and be at most 15 characters");
  if (registration.username && registration.username !== username) throw new Error("agent username is already set");
  const {root_signature: _oldSignature, ...withoutSignature} = {...registration, username};
  return {...withoutSignature, root_signature: signRegistration(withoutSignature, identitySecretKey)};
}

export function verifyAgentRegistration(registration: AgentRegistrationV1): boolean {
  if (registration.agent_id !== `vox:agent:${registration.identity_public_key}`) return false;
  if (!verifyRegistration(registration)) return false;
  if (registration.domain_association && (
    !verifyDomainAssociation(registration.domain_association) ||
    registration.domain_association.agent_id !== registration.agent_id ||
    registration.domain_association.identity_public_key !== registration.identity_public_key
  )) return false;
  return registration.publisher_keys.every((authorization) => (
    authorization.agent_id === registration.agent_id &&
    verifyKeyAuthorization(authorization, registration.identity_public_key)
  ));
}

export function createKeyAuthorization(
  registration: AgentRegistrationV1,
  identitySecretKey: Uint8Array,
  publisherPublicKey: Uint8Array,
  action: KeyAuthorizationV1["action"],
  reason?: string,
  issuedAt = nowIso()
): KeyAuthorizationV1 {
  const unsigned: Omit<KeyAuthorizationV1, "root_signature"> = {
    protocol: "vox/1",
    agent_id: registration.agent_id,
    publisher_key: publicKeyBase64(publisherPublicKey),
    action,
    issued_at: issuedAt,
    ...(reason ? {reason} : {})
  };
  return {...unsigned, root_signature: signKeyAuthorization(unsigned, identitySecretKey)};
}

export function isPublisherKeyAuthorizedAt(
  registration: AgentRegistrationV1,
  publisherKey: string,
  at: string
): boolean {
  if (!verifyAgentRegistration(registration)) return false;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return false;
  const records = registration.publisher_keys
    .filter((record) => record.publisher_key === publisherKey)
    .filter((record) => record.agent_id === registration.agent_id)
    .filter((record) => verifyKeyAuthorization(record, registration.identity_public_key))
    .sort((left, right) => Date.parse(left.issued_at) - Date.parse(right.issued_at));
  let authorized = false;
  for (const record of records) {
    if (Date.parse(record.issued_at) > atMs) break;
    authorized = record.action === "authorize";
  }
  return authorized;
}

export function appendKeyAuthorization(
  registration: AgentRegistrationV1,
  identitySecretKey: Uint8Array,
  action: KeyAuthorizationV1["action"],
  publisherPublicKey: Uint8Array,
  reason?: string,
  issuedAt?: string
): AgentRegistrationV1 {
  const record = createKeyAuthorization(registration, identitySecretKey, publisherPublicKey, action, reason, issuedAt);
  const unsigned = {...registration, publisher_keys: [...registration.publisher_keys, record]};
  const {root_signature: _oldSignature, ...withoutSignature} = unsigned;
  return {...withoutSignature, root_signature: signRegistration(withoutSignature, identitySecretKey)};
}

export function parseIdentitySecretKey(value: string): Uint8Array {
  const decoded = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0));
  if (decoded.length !== 64) throw new Error("Invalid identity secret key");
  return decoded;
}

export function isValidPublisherPublicKey(value: string): boolean {
  try { parsePublicKey(value); return true; } catch { return false; }
}

function identityKeyPairFromSecret(secretKey: string) {
  const bytes = parseIdentitySecretKey(secretKey);
  return nacl.sign.keyPair.fromSeed(bytes.subarray(0, 32));
}

export function normalizeIdentitySecretKey(secretKey: string): string {
  return secretKeyBase64(identityKeyPairFromSecret(secretKey).secretKey);
}

export function derivePublicKeyFromSecret(secretKey: string): string {
  return publicKeyBase64(identityKeyPairFromSecret(secretKey).publicKey);
}

export function createDomainAssociation(
  registration: AgentRegistrationV1,
  identitySecretKey: Uint8Array,
  domain: string,
  issuedAt = nowIso(),
  expiresAt?: string
): DomainAssociationV1 {
  const unsigned: Omit<DomainAssociationV1, "root_signature"> = {
    protocol: "vox/1",
    type: "domain-agent-association",
    domain: domain.toLowerCase(),
    agent_id: registration.agent_id,
    identity_public_key: registration.identity_public_key,
    issued_at: issuedAt,
    ...(expiresAt ? {expires_at: expiresAt} : {})
  };
  return {...unsigned, root_signature: signDomainAssociation(unsigned, identitySecretKey)};
}

export interface HumanKeyMaterial {
  identitySecretKey: string;
}

export interface NewHumanInput {
  display_name: string;
  username?: string;
  handle: string;
  description: string;
  issued_at?: string;
}

export interface HumanRegistrationBundle {
  registration: HumanRegistrationV1;
  key_material: HumanKeyMaterial;
}

export function createHuman(input: NewHumanInput, seed?: Uint8Array): HumanRegistrationBundle {
  const root = seed ? generateKeyPair(seed) : generateKeyPair();
  const identityPublic = publicKeyBase64(root.publicKey);
  const humanId = humanIdFromPublicKey(root.publicKey);
  const issuedAt = input.issued_at ?? nowIso();
  const registrationUnsigned: Omit<HumanRegistrationV1, "root_signature"> = {
    protocol: "vox/1",
    human_id: humanId,
    display_name: input.display_name,
    ...(input.username ? {username: input.username} : {}),
    handle: input.handle,
    description: input.description,
    identity_public_key: identityPublic
  };
  const registration: HumanRegistrationV1 = {
    ...registrationUnsigned,
    root_signature: signHumanRegistration(registrationUnsigned, root.secretKey)
  };
  return {registration, key_material: {identitySecretKey: bytesToBase64Url(root.secretKey)}};
}

export function setHumanUsername(
  registration: HumanRegistrationV1,
  identitySecretKey: Uint8Array,
  username: string
): HumanRegistrationV1 {
  if (!isValidUsername(username)) throw new Error("username must be lowercase letters, numbers, or underscores and be at most 15 characters");
  if (registration.username && registration.username !== username) throw new Error("human username is already set");
  const {root_signature: _oldSignature, ...withoutSignature} = {...registration, username};
  return {...withoutSignature, root_signature: signHumanRegistration(withoutSignature, identitySecretKey)};
}

export function verifyHumanAccount(registration: HumanRegistrationV1): boolean {
  return verifyHumanRegistration(registration);
}

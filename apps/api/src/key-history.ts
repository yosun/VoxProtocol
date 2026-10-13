import { canonicalBytes, type AgentRegistrationV1, type KeyAuthorizationV1 } from "@vox/protocol";

export interface KeyAuthorizationUpdateExpectation {
  publisher_key: string;
  action: KeyAuthorizationV1["action"];
}

export class KeyHistoryConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyHistoryConflict";
  }
}

function equalCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function registrationMetadata(registration: AgentRegistrationV1): Omit<AgentRegistrationV1, "publisher_keys" | "root_signature"> {
  const {publisher_keys: _publisherKeys, root_signature: _rootSignature, ...metadata} = registration;
  return metadata;
}

export function appendOnlyKeyAuthorizationRecords(
  current: AgentRegistrationV1,
  next: AgentRegistrationV1,
  expectation?: KeyAuthorizationUpdateExpectation
): KeyAuthorizationV1[] {
  if (current.agent_id !== next.agent_id || current.identity_public_key !== next.identity_public_key) {
    throw new KeyHistoryConflict("agent identity cannot change during a key update");
  }
  if (!equalCanonical(registrationMetadata(current), registrationMetadata(next))) {
    throw new KeyHistoryConflict("key updates cannot change registration metadata");
  }
  if (next.publisher_keys.length < current.publisher_keys.length) {
    throw new KeyHistoryConflict("publisher key history is append-only");
  }
  for (let index = 0; index < current.publisher_keys.length; index += 1) {
    if (!equalCanonical(current.publisher_keys[index], next.publisher_keys[index])) {
      throw new KeyHistoryConflict("publisher key history is append-only");
    }
  }
  const appended = next.publisher_keys.slice(current.publisher_keys.length);
  const seen = new Set(current.publisher_keys.map((record) => JSON.stringify(canonicalBytes(record))));
  for (const record of appended) {
    const fingerprint = JSON.stringify(canonicalBytes(record));
    if (seen.has(fingerprint)) throw new KeyHistoryConflict("publisher key authorization records cannot be duplicated");
    seen.add(fingerprint);
  }
  if (expectation && (
    appended.length !== 1 ||
    appended[0]!.publisher_key !== expectation.publisher_key ||
    appended[0]!.action !== expectation.action
  )) {
    throw new KeyHistoryConflict("key update does not match the requested route action");
  }
  return appended;
}

import {describe, expect, it} from "vitest";
import {createAgent, createDomainAssociation, appendKeyAuthorization, isPublisherKeyAuthorizedAt, verifyAgentRegistration} from "@vox/identity";
import {generateKeyPair, parseSecretKey, signRegistration} from "@vox/protocol";

const at = "2026-10-09T12:00:00.000Z";

describe("agent identity authority", () => {
  it("verifies a stable root identity and publisher authorization", () => {
    const bundle = createAgent({display_name: "Alice", handle: "alice@example.test", description: "test", issued_at: at}, new Uint8Array(32).fill(4));
    expect(verifyAgentRegistration(bundle.registration)).toBe(true);
    const publisher = Object.keys(bundle.key_material.publisherSecretKeys)[0]!;
    expect(isPublisherKeyAuthorizedAt(bundle.registration, publisher, "2026-10-09T12:01:00.000Z")).toBe(true);
    expect(isPublisherKeyAuthorizedAt(bundle.registration, "invalid", "2026-10-09T12:01:00.000Z")).toBe(false);
  });

  it("supports rotation and historical revocation without rewriting old signatures", () => {
    const bundle = createAgent({display_name: "Rotate", handle: "rotate@example.test", description: "test", issued_at: at}, new Uint8Array(32).fill(5));
    const oldPublisher = Object.keys(bundle.key_material.publisherSecretKeys)[0]!;
    const identitySecret = parseSecretKey(bundle.key_material.identitySecretKey);
    const next = generateKeyPair(new Uint8Array(32).fill(6));
    const withNext = appendKeyAuthorization(bundle.registration, identitySecret, "authorize", next.publicKey, "rotation", "2026-10-09T12:30:00.000Z");
    const revoked = appendKeyAuthorization(withNext, identitySecret, "revoke", new Uint8Array(Buffer.from(oldPublisher.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - oldPublisher.length % 4) % 4), "base64")), "compromised", "2026-10-09T13:00:00.000Z");
    expect(verifyAgentRegistration(revoked)).toBe(true);
    expect(isPublisherKeyAuthorizedAt(revoked, oldPublisher, "2026-10-09T12:01:00.000Z")).toBe(true);
    expect(isPublisherKeyAuthorizedAt(revoked, oldPublisher, new Date(Date.parse(at) + 2 * 60 * 60_000).toISOString())).toBe(false);
    expect(isPublisherKeyAuthorizedAt(revoked, next.publicKey.length === 32 ? Buffer.from(next.publicKey).toString("base64url") : "", new Date(Date.parse(at) + 2 * 60 * 60_000).toISOString())).toBe(true);
  });
  it("verifies an optional HTTPS domain association with the root key", () => {
    const bundle = createAgent({display_name: "Domain", handle: "domain@example.test", description: "test", issued_at: at}, new Uint8Array(32).fill(7));
    const association = createDomainAssociation(bundle.registration, parseSecretKey(bundle.key_material.identitySecretKey), "cruelty.cam", at);
    const {root_signature: _oldSignature, ...unsigned} = bundle.registration;
    const withDomain = {...unsigned, domain_association: association, root_signature: signRegistration({...unsigned, domain_association: association}, parseSecretKey(bundle.key_material.identitySecretKey))};
    expect(verifyAgentRegistration(withDomain)).toBe(true);
    expect(verifyAgentRegistration({...withDomain, domain_association: {...association, domain: "other.example"}})).toBe(false);
  });
});

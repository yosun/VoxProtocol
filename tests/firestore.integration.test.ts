import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {Firestore} from "@google-cloud/firestore";
import {FirestoreStore} from "@vox/api";
import {createAgent} from "@vox/identity";
import {createThoughtIntent, signIntent} from "@vox/client";
import {bytesToBase64Url, bytesToHex, generateKeyPair, postHash, postIdFromIntent} from "@vox/protocol";
import type {PaymentRecord, QuoteRecord, RealizationRecord} from "@vox/api";

const emulatorConfigured = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const firestoreDescribe = emulatorConfigured ? describe : describe.skip;
const projectId = "voxprotocol-emulator";

function now(): string {
  return new Date().toISOString();
}

function paymentRecord(reference: string, postId: string, quoteId: string): PaymentRecord {
  const timestamp = now();
  return {
    payment_id: `pay-${reference}`,
    payment_reference: reference,
    purpose: "realization",
    status: "reserved",
    asset: "USDC",
    network: "offchain",
    amount_usdc_atomic: "550000",
    payer_id: "emulator-viewer",
    quote_id: quoteId,
    post_id: postId,
    payment_mode: "mock",
    created_at: timestamp,
    updated_at: timestamp
  };
}

function realizationRecord(payment: PaymentRecord, postId: string, quoteId: string): RealizationRecord {
  return {
    realization_id: `job-${payment.payment_reference}`,
    post_id: postId,
    quote_id: quoteId,
    payment_id: payment.payment_id,
    requester_id: payment.payer_id,
    provider_id: "vox.emulator-provider",
    status: "delivered",
    payment_status: "reserved",
    payment_reference: payment.payment_reference,
    payment_mode: "mock",
    economic_purpose: "realization",
    mock: true,
    created_at: now()
  };
}

firestoreDescribe("Firestore emulator transactional integration", () => {
  let database: Firestore;
  const stores: FirestoreStore[] = [];

  function newStore(): FirestoreStore {
    const store = new FirestoreStore({projectId});
    stores.push(store);
    return store;
  }
  beforeAll(() => {
    database = new Firestore({projectId});
  });

  afterAll(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await database.terminate();
  });

  it("serializes concurrent publication and anchor claims across store instances", async () => {
    const firstStore = newStore();
    const secondStore = newStore();
    const issuedAt = now();
    const agent = createAgent({display_name: "Firestore Agent", handle: "firestore-emulator", description: "integration", issued_at: issuedAt}, new Uint8Array(32).fill(31));
    await firstStore.registerAgent(agent.registration);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "firestore-concurrent", text: "Firestore transaction test.", created_at: issuedAt}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const postHash = bytesToHex(postHashForIntent(signed.intent));
    const postId = postIdFromIntent(signed.intent);
    const instance = generateKeyPair(new Uint8Array(32).fill(32));
    const publishInput = {signed, post_hash: postHash, post_id: postId, accepted_at: issuedAt, instance_id: "vox.firestore-test", instance_public_key: bytesToBase64Url(instance.publicKey), instance_secret_key: instance.secretKey};

    const published = await Promise.all([firstStore.publish(publishInput), secondStore.publish(publishInput)]);
    expect(published.filter((result) => result.created)).toHaveLength(1);
    expect(published[0]!.post.envelope.sequence).toBe(1);
    expect(published[1]!.post.envelope.sequence).toBe(1);

    const claimInput = {owner_id: "emulator-worker-a", authority_id: "vox:anchor:emulator", epoch: "2026-10-10Z", tier: "free" as const, kind: "BATCH" as const, limit: 10, lease_seconds: 60};
    const claims = await Promise.all([firstStore.claimAnchorCandidates(claimInput), secondStore.claimAnchorCandidates({...claimInput, owner_id: "emulator-worker-b"})]);
    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(claims.filter((claim) => claim === undefined)).toHaveLength(1);

    const claimed = claims.find((claim) => claim !== undefined)!;
    const persistedClaim = await secondStore.getAnchorClaim(claimed.claim.claim_id);
    expect(persistedClaim?.claim.lease_expires_at).toBeTruthy();
    expect(persistedClaim?.posts[0]?.anchoring.status).toBe("claimed");

    const claimDocument = database.collection("vox_anchor_claims").doc(claimed.claim.claim_id);
    await claimDocument.update({lease_expires_at: new Date(0).toISOString()});
    const recovered = await secondStore.claimAnchorCandidates({...claimInput, owner_id: "emulator-worker-recovery"});
    expect(recovered?.claim.claim_id).toBe(claimed.claim.claim_id);
    expect(recovered?.claim.owner_id).toBe("emulator-worker-recovery");
  });

  it("atomically reserves and completes one payment reference under contention", async () => {
    const firstStore = newStore();
    const secondStore = newStore();
    const issuedAt = now();
    const agent = createAgent({display_name: "Payment Agent", handle: "payment-firestore-emulator", description: "payment integration", issued_at: issuedAt}, new Uint8Array(32).fill(33));
    await firstStore.registerAgent(agent.registration);
    const publisherKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
    const signed = signIntent(createThoughtIntent({agent_id: agent.registration.agent_id, author_key: publisherKey, client_post_id: "firestore-payment", text: "Payment transaction test.", created_at: issuedAt}), agent.key_material.publisherSecretKeys[publisherKey]!);
    const postHash = bytesToHex(postHashForIntent(signed.intent));
    const postId = postIdFromIntent(signed.intent);
    const instance = generateKeyPair(new Uint8Array(32).fill(34));
    const published = await firstStore.publish({signed, post_hash: postHash, post_id: postId, accepted_at: issuedAt, instance_id: "vox.firestore-payment", instance_public_key: bytesToBase64Url(instance.publicKey), instance_secret_key: instance.secretKey});
    const quote: QuoteRecord = {quote_id: "quote-firestore", post_id: published.post.post_id, requester_id: "emulator-viewer", style: "cinematic", duration_seconds: 12, amount_usdc_atomic: "550000", currency: "USDC", expires_at: new Date(Date.now() + 900_000).toISOString(), provider_id: "vox.emulator-provider", mock: true, status: "issued", created_at: now()};
    await firstStore.createQuote(quote);
    const payment = paymentRecord("firestore-payment-reference", postId, quote.quote_id);

    const reservations = await Promise.all([firstStore.reservePayment(payment), secondStore.reservePayment(payment)]);
    expect(reservations.filter((reservation) => reservation.created)).toHaveLength(1);
    expect(reservations.filter((reservation) => !reservation.created)).toHaveLength(1);

    const realization = realizationRecord(payment, postId, quote.quote_id);
    const completed = await Promise.all([firstStore.createRealizationWithPayment({payment, realization}), secondStore.createRealizationWithPayment({payment, realization})]);
    expect(completed[0]!.realization_id).toBe(realization.realization_id);
    expect(completed[1]!.realization_id).toBe(realization.realization_id);
    expect((await secondStore.getPayment(payment.payment_reference))?.status).toBe("captured");
    expect((await secondStore.getQuote(quote.quote_id))?.status).toBe("consumed");

    await expect(firstStore.reservePayment({...payment, post_id: "vox:post:" + "f".repeat(64)})).rejects.toThrow(/different economic record/);
  });
});

function postHashForIntent(intent: Parameters<typeof postHash>[0]): Uint8Array {
  return postHash(intent);
}

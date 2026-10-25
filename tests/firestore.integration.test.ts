import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {Firestore} from "@google-cloud/firestore";
import {createHash} from "node:crypto";
import {FirestoreStore} from "@vox/api";
import {createAgent, createHuman} from "@vox/identity";
import {createCommissionRequestIntent, createThoughtIntent, signCommissionRequestIntent, signIntent} from "@vox/client";
import {bytesToBase64Url, bytesToHex, commissionRequestHashHex, commissionRequestIdFromIntent, generateKeyPair, postHash, postIdFromIntent} from "@vox/protocol";
import type {PaymentRecord, QuoteRecord, RealizationRecord} from "@vox/api";
import type {VoxPostIntentV1} from "@vox/protocol";

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

  it("serializes character conversation turns across independent runtimes", async () => {
    const first = newStore(); const second = newStore();
    const issuedAt = now();
    const cast = ["Conversation Bob", "Conversation Luna"].map((name) => createAgent({display_name: name, handle: name.toLowerCase().replaceAll(" ", "-"), description: "Conversation concurrency test", issued_at: issuedAt}));
    await Promise.all(cast.map((agent) => first.registerAgent(agent.registration)));
    const instance = generateKeyPair();
    function input(index: number, content: VoxPostIntentV1["content"], kind: VoxPostIntentV1["kind"], clientId: string) {
      const agent = cast[index]!;
      const authorKey = Object.keys(agent.key_material.publisherSecretKeys)[0]!;
      const intent: VoxPostIntentV1 = {protocol: "vox/1", agent_id: agent.registration.agent_id, author_key: authorKey, client_post_id: clientId, created_at: issuedAt, kind, content};
      const signed = signIntent(intent, agent.key_material.publisherSecretKeys[authorKey]!);
      return {signed, post_id: postIdFromIntent(intent), post_hash: bytesToHex(postHash(intent)), accepted_at: issuedAt, instance_id: "conversation-emulator", instance_public_key: bytesToBase64Url(instance.publicKey), instance_secret_key: instance.secretKey};
    }
    const opening = input(0, {text: "Who sent the signal?", conversation: {type: "start", title: "Firestore scene", participant_ids: cast.map((agent) => agent.registration.agent_id), max_turns: 4}}, "fiction", "conversation-opening");
    await first.publish(opening);
    const makeTurn = (text: string, clientId: string) => input(1, {text, parent_id: opening.post_id, conversation: {type: "turn", root_post_id: opening.post_id, turn_index: 1}}, "reply", clientId);
    const left = makeTurn("The left tunnel.", "conversation-left");
    const right = makeTurn("The right tunnel.", "conversation-right");
    const results = await Promise.allSettled([first.publish(left), second.publish(right)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const state = await second.getCharacterConversation(opening.post_id);
    expect(state?.post_ids).toHaveLength(2);
    expect(state?.next_agent_id).toBe(cast[0]!.registration.agent_id);
    const accepted = results[0]?.status === "fulfilled" ? left : right;
    expect((await second.publish(accepted)).created).toBe(false);
    expect((await second.listCharacterConversations(50, {next_agent_id: cast[0]!.registration.agent_id})).some((item) => item.root_post_id === opening.post_id)).toBe(true);
    expect((await second.snapshot()).character_conversations?.some((item) => item.root_post_id === opening.post_id)).toBe(true);

    const human = createHuman({display_name: "Conversation audience", handle: "conversation-audience", description: "Emulator invitation"});
    await first.registerHuman(human.registration);
    const seed = {title: "Audience scene", participant_ids: cast.map((agent) => agent.registration.agent_id), max_turns: 4};
    const invitationIntent = createCommissionRequestIntent({human_id: human.registration.human_id, target_agent_id: seed.participant_ids[0]!, client_request_id: crypto.randomUUID(), text: "Find the signal together.", conversation: seed});
    const invitationId = commissionRequestIdFromIntent(invitationIntent);
    await first.createCommissionRequest({request_id: invitationId, ...signCommissionRequestIntent(invitationIntent, human.key_material.identitySecretKey), request_hash: commissionRequestHashHex(invitationIntent), accepted_at: issuedAt, status: "requested", events: [], conversation_pending: true});
    const invitedOpening = (text: string) => input(0, {text, conversation: {...seed, type: "start", request_id: invitationId}}, "fiction", `invite-${text}`);
    const invitations = await Promise.allSettled([first.publish(invitedOpening("First opening")), second.publish(invitedOpening("Second opening"))]);
    expect(invitations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const answered = await second.getCommissionRequest(invitationId);
    expect(answered?.conversation_pending).toBe(false);
    expect(answered?.conversation_id).toBeTruthy();
    expect(await second.listConversationInvitations(seed.participant_ids[0]!, 30)).toEqual([]);

    const branch = input(0, {text: "A branching scene.", conversation: {...seed, type: "start", branch_from_post_id: opening.post_id}}, "fiction", "branch-opening");
    await first.publish(branch);
    await database.collection("vox_posts").doc(opening.post_id).update({publication_status: "hidden"});
    await expect(second.publish(input(1, {text: "Continue a hidden source.", parent_id: branch.post_id, conversation: {type: "turn", root_post_id: branch.post_id, turn_index: 1}}, "reply", "hidden-branch-turn"))).rejects.toThrow("no longer public");
  });

  it("serializes NFT signer leases across independent processors", async () => {
    const first = newStore();
    const second = newStore();
    const claims = await Promise.all([first.claimNftChain("monad:testnet", "nft-worker-a", 300), second.claimNftChain("monad:testnet", "nft-worker-b", 300)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? "nft-worker-a" : "nft-worker-b";
    await second.releaseNftChain("monad:testnet", "not-the-owner");
    expect(await first.claimNftChain("monad:testnet", "nft-worker-c", 300)).toBe(false);
    await first.releaseNftChain("monad:testnet", winner);
    expect(await second.claimNftChain("monad:testnet", "nft-worker-c", 300)).toBe(true);
    await second.releaseNftChain("monad:testnet", "nft-worker-c");
  });

  it("keeps NFT wallet bindings and finalized states immutable even within the same millisecond", async () => {
    const first = newStore();
    const second = newStore();
    const timestamp = now();
    const mint = {mint_id: `emulator:nft:${timestamp}`, media_id: "emulator:media", owner_id: "emulator:human", owner_wallet: "0x" + "1".repeat(40), chain: "monad:testnet" as const, state: "queued" as const, metadata_uri: "https://example.test/metadata", metadata_hash: "a".repeat(64), attempts: 0, created_at: timestamp, updated_at: timestamp};
    await first.createNftMint(mint);
    await expect(second.updateNftMint({...mint, owner_wallet: "0x" + "2".repeat(40)}, timestamp)).rejects.toThrow("wallet binding is immutable");
    await first.updateNftMint({...mint, state: "finalized"}, timestamp);
    await expect(second.updateNftMint(mint, timestamp)).rejects.toThrow("finalized NFT state is immutable");
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

  it("finds due NFT mints beyond a full page of leased and delayed records", async () => {
    const store = newStore();
    const timestamp = now();
    const ids = Array.from({length: 47}, (_, index) => `emulator:nft-page:${timestamp}:${index}`)
      .sort((left, right) => createHash("sha256").update(left).digest("hex").localeCompare(createHash("sha256").update(right).digest("hex")));
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await Promise.all(ids.map((mint_id, index) => store.createNftMint({
      mint_id, media_id: "emulator:media-page", owner_id: "emulator:human-page", owner_wallet: "0x" + "1".repeat(40), chain: "monad:testnet", state: "queued", metadata_uri: "https://example.test/page-metadata", metadata_hash: "a".repeat(64), attempts: 0,
      created_at: timestamp, updated_at: "2000-01-01T00:00:00.000Z",
      ...(index < 22 ? {lease_owner: "other-worker", lease_expires_at: future} : index < 45 ? {next_attempt_at: future} : {})
    })));
    const candidates = await store.listNftMintsForProcessing(2);
    expect(candidates.map((mint) => mint.mint_id)).toEqual(ids.slice(45));
    const claimed = await store.claimNftMint(candidates[0]!.mint_id, "pagination-worker", 300);
    expect(claimed?.state).toBe("signing");
    await store.updateNftMint({...claimed!, lease_expires_at: "1970-01-01T00:00:00.000Z"}, claimed!.updated_at);
    expect((await store.listNftMintsForProcessing(2)).some((mint) => mint.mint_id === claimed!.mint_id && mint.state === "signing")).toBe(true);
  });
});

function postHashForIntent(intent: Parameters<typeof postHash>[0]): Uint8Array {
  return postHash(intent);
}

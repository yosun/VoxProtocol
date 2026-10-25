import {expect, test, type Page} from "@playwright/test";
import {createHuman} from "@vox/identity";
import {computeFirstPartyRealizeRightsPolicyHash, verifyCommissionRequestSignature, videoBriefPrompt, type SignedCommissionRequestV1, type VideoBriefV1} from "@vox/protocol";

const bobId = `vox:agent:${"B".repeat(43)}`;
const lunaId = `vox:agent:${"L".repeat(43)}`;
const rootId = `vox:post:${"a".repeat(64)}`;
const turnId = `vox:post:${"b".repeat(64)}`;
const branchId = `vox:post:${"c".repeat(64)}`;
const timestamp = "2026-10-14T20:00:00.000Z";
const brief: VideoBriefV1 = {title: "The last train", premise: "Bob and Luna follow a signal under the city.", setting: "An abandoned platform at midnight.", action: "Luna decodes the lights as Bob holds the closing door. The train reveals a forest inside.", visual_style: "Amber practical lighting, close handheld framing.", ending: "They step into the forest together.", duration_seconds: 12};
const agent = (id: string, name: string) => ({registration: {agent_id: id, display_name: name, username: name.toLowerCase(), handle: name.toLowerCase(), description: "An imaginary local.", identity_public_key: id.slice("vox:agent:".length), publisher_keys: [], anchoring_tier: "free"}, created_at: timestamp, updated_at: timestamp});
const bob = agent(bobId, "Bob"); const luna = agent(lunaId, "Luna");
const root = {post_id: rootId, intent: {agent_id: bobId, created_at: timestamp, kind: "fiction", content: {text: "Luna, the last train is broadcasting your name.", conversation: {type: "start", title: "The signal under the city", participant_ids: [bobId, lunaId], max_turns: 8}}}, post_hash: "a".repeat(64), signature: "test", envelope: {sequence: 1, accepted_at: timestamp, publisher_instance_id: "test"}, envelope_hash: "a".repeat(64), publication_status: "published", anchoring: {status: "unanchored", tier: "free"}};
const turn = {...root, post_id: turnId, intent: {agent_id: lunaId, created_at: timestamp, kind: "reply", content: {text: "Then we'd better get on. I can read its lights.", parent_id: rootId, conversation: {type: "turn", root_post_id: rootId, turn_index: 1}, video_brief: brief}}};
const conversation = {root_post_id: rootId, title: "The signal under the city", participant_ids: [bobId, lunaId], max_turns: 8, post_ids: [rootId, turnId], next_agent_id: bobId, status: "active", created_at: timestamp, updated_at: timestamp};
const branch = {...conversation, root_post_id: branchId, title: "The city that forgot", parent_conversation_id: rootId, branch_from_post_id: turnId, post_ids: [branchId], next_agent_id: lunaId};
const human = createHuman({display_name: "Audience", handle: "audience", description: "A test audience member."});

async function mockWorld(page: Page, failFirstInvitation = false) {
  const invitations: SignedCommissionRequestV1[] = [];
  const writes: string[] = [];
  await page.addInitScript(async ({registration, seed}) => {
    const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
    const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array([...prefix, ...seed]), {name: "Ed25519"}, false, ["sign"]);
    const database = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("vox-human-account", 1); request.onupgradeneeded = () => request.result.createObjectStore("identity"); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve) => { const transaction = database.transaction("identity", "readwrite"); transaction.objectStore("identity").put({humanId: registration.human_id, publicKey: registration.identity_public_key, privateKey, registration}, "account"); transaction.oncomplete = () => resolve(); });
    database.close();
  }, {registration: human.registration, seed: [...Buffer.from(human.key_material.identitySecretKey, "base64url").subarray(0, 32)]});
  const policy = {protocol_version: "realize/1" as const, policy_id: `vox:rights:first-party-ai:v1:${lunaId}`, version: 1, creator_id: lunaId, character_owner_id: lunaId, rights_subject_id: `vox:creator:${lunaId}`, statement: "VOX operates this first-party AI character. Customer quote acceptance is required."};
  await page.route("**/v1/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const send = (body: unknown, status = 200) => route.fulfill({status, contentType: "application/json", body: JSON.stringify(body)});
    if (route.request().method() === "POST") writes.push(path);
    if (path === "/v1/feed") return send({items: [turn, root]});
    if (path === "/v1/live-characters") return send({items: [bob, luna]});
    if (path === "/v1/conversations") return send({items: [conversation]});
    if (path === `/v1/conversations/${rootId}`) return send({conversation, posts: [root, turn], participants: [bob, luna], branches: [branch]});
    if (path === `/v1/conversations/${branchId}`) return send({conversation: branch, posts: [{...root, post_id: branchId, intent: {...root.intent, content: {...root.intent.content, text: "What if the forest remembers a different city?"}}}], participants: [bob, luna], branches: []});
    if (path === `/v1/agents/${bobId}`) return send(bob);
    if (path === `/v1/agents/${lunaId}`) return send(luna);
    if (path === "/v1/search") return send({agents: [bob, luna], posts: [], humans: []});
    if (path === "/v1/humans" || path === "/v1/me") return send({registration: human.registration, created_at: timestamp, updated_at: timestamp});
    if (path === "/v1/commission-requests") {
      const signed = route.request().postDataJSON() as SignedCommissionRequestV1;
      invitations.push(signed);
      if (failFirstInvitation && invitations.length === 1) return route.abort("failed");
      return send({request_id: `vox:request:${"d".repeat(64)}`, ...signed, status: "requested", accepted_at: timestamp, request_hash: "d".repeat(64), events: []}, 201);
    }
    if (path === "/v1/health") return send({status: "ok", instance_id: "test", instance_public_key: bob.registration.identity_public_key});
    if (path.endsWith("/capabilities")) return send({protocol_version: "realize/1", creator_id: lunaId, generation_provider_ids: ["provider:video"], capabilities: [{capability_id: "video:short-form", input_schema_uri: "https://provider.test/schema", output_media_types: ["video/mp4"], max_duration_seconds: 15}], rights_agreement_references: [policy.policy_id], rights_policy_mode: "first_party", updated_at: timestamp});
    if (path.endsWith("/input-schema")) return send({type: "object", properties: {concept: {type: "string", minLength: 3, maxLength: 2000}, duration_seconds: {type: "integer", minimum: 5, maximum: 15}, resolution: {type: "string", enum: ["480P"]}}, required: ["concept", "duration_seconds"]});
    if (path.startsWith("/v1/rights/agreements/")) return send({policy_mode: "first_party", policy, terms_hash: computeFirstPartyRealizeRightsPolicyHash(policy), status: "active"});
    return send({items: []});
  });
  return {invitations, writes};
}

test("reads character dialogue, follows a sub-story, and carries the scene brief into Realize", async ({page}) => {
  const world = await mockWorld(page);
  await page.goto(`/?conversation=${encodeURIComponent(rootId)}`);
  const dialog = page.getByRole("dialog", {name: "The signal under the city"});
  await expect(dialog.getByText("Then we'd better get on. I can read its lights.", {exact: true})).toBeVisible();
  await expect(dialog.getByText("Next: Bob", {exact: false})).toBeVisible();
  await dialog.getByRole("button", {name: /The city that forgot/}).click();
  await expect(page.getByRole("heading", {name: "The city that forgot", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "↖ Read the parent story"}).click();
  await page.screenshot({path: "test-results/conversation-thread.png", fullPage: true});
  await page.getByRole("button", {name: "✦ Realize this scene"}).click();
  await expect(page.getByLabel("Your idea")).toHaveValue(videoBriefPrompt(brief));
  await expect(page.getByLabel("Length")).toHaveValue("12");
  await expect(page.getByLabel("Create with", {exact: true})).toHaveValue(lunaId);
  expect(world.writes.filter((path) => path !== "/v1/humans")).toEqual([]);
  await page.screenshot({path: "test-results/conversation-realize.png", fullPage: true});
});

test("sends a signed audience sub-story invitation and keeps retries idempotent", async ({page}) => {
  const world = await mockWorld(page, true);
  await page.goto(`/?conversation=${encodeURIComponent(rootId)}`);
  await page.getByRole("button", {name: "↗ Suggest a sub-story from here"}).nth(1).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Scene title").fill("The forest remembers");
  await dialog.getByLabel("What brings them together?").fill("Luna recognizes a tree from Bob's childhood. Ask each other why.");
  await dialog.getByRole("button", {name: "Invite the cast", exact: true}).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn’t connect");
  await dialog.getByRole("button", {name: "Invite the cast", exact: true}).click();
  await expect(dialog.getByRole("status")).toContainText("Your invitation is in the character’s inbox.");
  expect(world.invitations).toHaveLength(2);
  expect(world.invitations[0]).toEqual(world.invitations[1]);
  expect(verifyCommissionRequestSignature(world.invitations[1]!.intent, world.invitations[1]!.signature)).toBe(true);
  expect(world.invitations[1]!.intent.content.source_post_id).toBe(turnId);
  expect(world.invitations[1]!.intent.content.conversation?.participant_ids).toEqual([lunaId, bobId]);
});

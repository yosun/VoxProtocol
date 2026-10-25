import {expect, test, type Page, type Request} from "@playwright/test";
import {createHuman} from "@vox/identity";
import {base64UrlToBytes, realizeClientRequestSigningPayload, verifyBytes} from "@vox/protocol";

const account = createHuman({display_name: "Audience", handle: "audience", description: "Browser test account."});
const legacy = createHuman({display_name: "Earlier commissioner", handle: "earlier", description: "Browser test checkout identity."});
const bobId = `vox:agent:${"B".repeat(43)}`;
const timestamp = "2026-10-14T20:00:00.000Z";
const bob = {registration: {agent_id: bobId, display_name: "Bob", username: "bob", handle: "bob", description: "An imaginary local."}, profile: {livestream: {provider: "populi", username: "bob"}}, created_at: timestamp, updated_at: timestamp};

async function seedAccounts(page: Page, includeLegacy = false) {
  const identities = [{name: "vox-human-account", key: "account", human: account}, ...(includeLegacy ? [{name: "vox-realize-private-identity", key: "commissioner", human: legacy}] : [])];
  await page.addInitScript(async (identities) => {
    for (const {name, key, registration, seed} of identities) {
      const prefix = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
      const privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array([...prefix, ...seed]), {name: "Ed25519"}, false, ["sign"]);
      const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open(name, 1); request.onupgradeneeded = () => request.result.createObjectStore("identity"); request.onsuccess = () => resolve(request.result); });
      await new Promise<void>((resolve) => { const transaction = db.transaction("identity", "readwrite"); transaction.objectStore("identity").put({humanId: registration.human_id, publicKey: registration.identity_public_key, privateKey, registration}, key); transaction.oncomplete = () => resolve(); });
      db.close();
    }
  }, identities.map(({name, key, human}) => ({name, key, registration: human.registration, seed: [...Buffer.from(human.key_material.identitySecretKey, "base64url").subarray(0, 32)]})));
}

function expectSignedRequest(request: Request, human: typeof account, body?: unknown) {
  const headers = request.headers();
  const url = new URL(request.url());
  expect(headers["x-vox-realize-human-id"]).toBe(human.registration.human_id);
  const payload = realizeClientRequestSigningPayload({method: request.method(), path: `${url.pathname}${url.search}`, principal_id: human.registration.human_id, issued_at: headers["x-vox-realize-timestamp"]!, ...(body === undefined ? {} : {body})});
  expect(verifyBytes(payload, headers["x-vox-realize-signature"]!, base64UrlToBytes(human.registration.identity_public_key))).toBe(true);
}

test("records and sends a real browser voice message with private signed media access", async ({page}) => {
  await seedAccounts(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const source = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      source.connect(destination); source.start();
      return destination.stream;
    };
  });
  const uploads: Array<{type: string; bytes: number}> = [];
  const sends: unknown[] = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    const send = (body: unknown) => route.fulfill({contentType: "application/json", body: JSON.stringify(body)});
    if (path === "/v1/humans") return send({registration: account.registration});
    if (path === "/v1/agents/by-username/bob") return send(bob);
    if (path.startsWith("/v1/dm/media/")) {
      const headers = request.headers();
      const metadata = {asset_hash: path.split("/").at(-1), file_name: decodeURIComponent(headers["x-vox-dm-file-name"]!), media_type: headers["x-vox-dm-media-type"], byte_length: Number(headers["x-vox-dm-byte-length"])};
      expectSignedRequest(request, account, metadata);
      uploads.push({type: headers["content-type"]!, bytes: request.postDataBuffer()!.length});
      return send(metadata);
    }
    if (path === "/v1/dm/messages") {
      const body = request.postDataJSON();
      expectSignedRequest(request, account, body);
      sends.push(body);
      return send({...body, sender_id: account.registration.human_id, message_id: "dm:voice", conversation_id: "conversation:voice"});
    }
    return send({items: []});
  });
  await page.goto("/?messages=true&to=bob");
  await page.getByRole("button", {name: "Start", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Messages", exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Record a voice message"}).click();
  await expect(page.getByRole("button", {name: "Stop voice recording"})).toBeVisible();
  await page.waitForTimeout(200);
  await page.getByRole("button", {name: "Stop voice recording"}).click();
  await expect(page.locator(".dm-pending-file")).toHaveCount(1);
  await page.getByRole("button", {name: "Send", exact: true}).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.type).toBe("audio/webm");
  expect(uploads[0]!.bytes).toBeGreaterThan(0);
  expect(sends[0]).toMatchObject({recipient_id: bobId, attachments: [{kind: "audio", media_type: "audio/webm"}]});
});

test("live stream entry links stay on the current preview site", async ({page}) => {
  await page.route("https://populi.cam/**", (route) => route.fulfill({contentType: "text/html", body: "<p>Local stream fixture</p>"}));
  await page.route("**/v1/**", (route) => route.fulfill({contentType: "application/json", body: JSON.stringify({items: new URL(route.request().url()).pathname === "/v1/live-characters" ? [bob] : []})}));
  await page.goto("/");
  const entries = page.getByRole("link", {name: "Watch Bob's live stream on VOX.gold", exact: true});
  await expect(entries).toHaveCount(2);
  for (const link of await entries.all()) {
    const target = new URL((await link.getAttribute("href"))!, page.url());
    expect(target.origin).toBe(new URL(page.url()).origin);
    expect(target.pathname).toBe("/bob/");
    expect(target.searchParams.get("livestream")).toBe("true");
  }
});

test("account history can claim older NFTs with the correct account and earlier checkout identity", async ({page}) => {
  await seedAccounts(page, true);
  const recipient = `0x${"2".repeat(40)}`;
  await page.addInitScript((recipient) => {
    (window as any).ethereum = {async request({method}: {method: string}) {
      if (method === "eth_requestAccounts") return [recipient];
      if (method === "eth_chainId") return "0x8f";
      if (method === "personal_sign") return `0x${"1".repeat(130)}`;
      throw new Error(`Unexpected wallet method ${method}`);
    }};
  }, recipient);
  const claims: string[] = [];
  const mintStates: Record<string, string> = {account: "claimable", legacy: "claimable"};
  const media = (key: string) => ({media_id: `media:${key}`, source_kind: "realize_commission", source_id: `commission:${key}`, output_index: 0, provider_id: "provider:test", media_uri: "https://media.example.test/completed.mp4", media_type: "video/mp4", media_sha256: "a".repeat(64), metadata_uri: "https://vox.example.test/metadata", metadata_hash: "b".repeat(64), created_at: timestamp, mints: [{mint_id: `mint:${key}`, chain: "monad:mainnet", state: mintStates[key], created_at: timestamp, ...(mintStates[key] === "finalized" ? {token_id: "42"} : {})}]});
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    const send = (body: unknown) => route.fulfill({contentType: "application/json", body: JSON.stringify(body)});
    if (path === "/v1/humans") return send({registration: account.registration});
    if (path === "/v1/realize/commissions") {
      const human = request.headers()["x-vox-realize-human-id"] === account.registration.human_id ? account : legacy;
      expectSignedRequest(request, human);
      const key = human === account ? "account" : "legacy";
      return send({items: [{commission: {commission_id: `commission:${key}`, commissioner_id: human.registration.human_id, state: "SETTLED", requested_generation_parameters: {concept: `Earlier ${key} order`}, updated_at: timestamp}, settlement_status: "settled", nft_media_ids: [`media:${key}`]}]});
    }
    if (path.startsWith("/v1/nft/media/")) return send(media(path.endsWith(":account") ? "account" : "legacy"));
    if (path.endsWith("/claim")) {
      const key = path.includes("mint:account") ? "account" : "legacy";
      expectSignedRequest(request, key === "account" ? account : legacy, request.postDataJSON());
      expect(request.postDataJSON().wallet).toBe(recipient);
      claims.push(key); mintStates[key] = "finalized";
      return send({state: "finalized"});
    }
    return send({items: []});
  });
  await page.goto("/?account=true");
  const dialog = page.getByRole("dialog", {name: "VOX human account"});
  await expect(dialog.getByRole("button", {name: "Mint on Monad", exact: true})).toHaveCount(2);
  await dialog.locator(".account-activity-card").filter({hasText: "Earlier account order"}).getByRole("button", {name: "Mint on Monad"}).click();
  await expect(dialog.locator(".account-activity-card").filter({hasText: "Earlier account order"}).getByText("Minted · Token #42")).toBeVisible();
  await dialog.locator(".account-activity-card").filter({hasText: "Earlier legacy order"}).getByRole("button", {name: "Mint on Monad"}).click();
  await expect(dialog.getByText("Minted · Token #42")).toHaveCount(2);
  expect(claims).toEqual(["account", "legacy"]);
  expect(await page.evaluate(() => sessionStorage.getItem("vox.realize.v1.checkout"))).toBeNull();
});

test("adds the supported Base Sepolia network before requesting a testnet NFT claim signature", async ({page}) => {
  await seedAccounts(page);
  const recipient = `0x${"2".repeat(40)}`;
  await page.addInitScript((recipient) => {
    let chain = "0x1";
    (window as any).__walletCalls = [];
    (window as any).ethereum = {async request({method, params}: {method: string; params: any[]}) {
      (window as any).__walletCalls.push({method, params});
      if (method === "eth_requestAccounts") return [recipient];
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("Unknown chain"), {code: 4902});
      if (method === "wallet_addEthereumChain") { chain = params[0].chainId; return null; }
      if (method === "personal_sign") return `0x${"1".repeat(130)}`;
      throw new Error(`Unexpected wallet method ${method}`);
    }};
  }, recipient);
  let claim: unknown;
  const media = {media_id: "media:base-test", source_kind: "realize_commission", source_id: "commission:base-test", output_index: 0, provider_id: "provider:test", media_uri: "https://media.example.test/completed.mp4", media_type: "video/mp4", media_sha256: "a".repeat(64), metadata_uri: "https://vox.example.test/metadata", metadata_hash: "b".repeat(64), created_at: timestamp, mints: [{mint_id: "mint:base-test", chain: "base:sepolia", state: "claimable", created_at: timestamp}]};
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    const send = (body: unknown) => route.fulfill({contentType: "application/json", body: JSON.stringify(body)});
    if (path === "/v1/humans") return send({registration: account.registration});
    if (path === "/v1/realize/commissions") return send({items: [{commission: {commission_id: "commission:base-test", commissioner_id: account.registration.human_id, state: "SETTLED", requested_generation_parameters: {concept: "Testnet output"}, updated_at: timestamp}, settlement_status: "settled", nft_media_ids: [media.media_id]}]});
    if (path.startsWith("/v1/nft/media/")) return send(media);
    if (path.endsWith("/claim")) {
      claim = request.postDataJSON();
      expectSignedRequest(request, account, claim);
      media.mints[0]!.state = "finalized";
      return send({state: "finalized"});
    }
    return send({items: []});
  });
  await page.goto("/?account=true");
  await page.getByRole("button", {name: "Mint on base", exact: true}).click();
  await expect.poll(() => claim).toMatchObject({wallet: recipient});
  const calls = await page.evaluate(() => (window as any).__walletCalls);
  expect(calls.find((call: any) => call.method === "wallet_addEthereumChain").params[0]).toMatchObject({chainId: "0x14a34", chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"]});
  const signedMessage = Buffer.from(calls.find((call: any) => call.method === "personal_sign").params[0].slice(2), "hex").toString("utf8");
  expect(signedMessage).toContain("Chain: base:sepolia");
});

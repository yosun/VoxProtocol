import {expect, test} from "@playwright/test";

test("directory previews do not join the audience and accept only valid counts from their iframe", async ({page}) => {
  await page.route("http://localhost:8787/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const agent = {
      registration: {agent_id: "vox:agent:bob", username: "bob", display_name: "Bob", handle: "bob@cruelty.cam", description: "A fictional character."},
      profile: {livestream: {provider: "populi", username: "bob", time_zone: "UTC"}},
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    return route.fulfill({json: {items: path === "/v1/live-characters" ? [agent] : []}});
  });
  await page.route("https://populi.cam/**", (route) => route.fulfill({contentType: "text/html", body: "<!doctype html><title>Mock Populi preview</title><body>Preview</body>"}));
  await page.goto("/");
  const card = page.locator(".live-stream-card");
  await card.scrollIntoViewIfNeeded();
  const iframe = card.locator("iframe");
  await expect(iframe).toHaveAttribute("src", "https://populi.cam/bob/embed?audience=preview");
  const frame = await (await iframe.elementHandle())!.contentFrame();
  await frame!.waitForURL("https://populi.cam/bob/embed?audience=preview");
  await frame!.waitForLoadState("domcontentloaded");

  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", {source: window, origin: "https://populi.cam", data: {type: "populi-live-widget-status", viewers: 999}}));
  });
  await expect(card.locator(".live-stream-viewers")).toHaveCount(0);
  for (const viewers of [4, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await frame!.evaluate(({origin, viewers}) => {
      window.parent.postMessage({type: "populi-live-widget-status", status: "live", activity: 123, viewers}, origin);
    }, {origin: new URL(page.url()).origin, viewers});
    if (Number.isSafeInteger(viewers) && viewers >= 0) await expect(card.locator(".live-stream-viewers")).toContainText(`${viewers} watching`);
    else await expect(card.locator(".live-stream-viewers")).toHaveCount(0);
  }
  await expect(card.locator(".live-stream-copy p")).toHaveText("Broadcasting now");
});

test("live windows use usernames to break viewer ties and remain ordered while counts load", async ({page}) => {
  await page.setViewportSize({width: 1800, height: 1000});
  const agents = [
    {username: "luna", stream: "a_stream"},
    {username: "edison", stream: "m_stream"},
    {username: "bob", stream: "z_stream"}
  ].map(({username, stream}) => ({
    registration: {agent_id: `vox:agent:${username}`, username, display_name: username, handle: `${username}@cruelty.cam`, description: "A fictional character."},
    profile: {livestream: {provider: "populi", username: stream, time_zone: "UTC"}},
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }));
  let discoveryRequests = 0;
  await page.route("http://localhost:8787/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/v1/live-characters") return route.fulfill({json: {items: []}});
    discoveryRequests += 1;
    return route.fulfill({json: {items: discoveryRequests % 2 ? agents : [...agents].reverse()}});
  });
  await page.route("https://populi.cam/**", (route) => route.fulfill({contentType: "text/html", body: "<!doctype html><title>Mock Populi preview</title><body>Preview</body>"}));
  await page.goto("/");
  await page.locator(".live-now-band").scrollIntoViewIfNeeded();
  const order = page.locator(".live-stream-identity span");
  const alphabetical = ["@bob", "@edison", "@luna"];
  await expect(order).toHaveText(alphabetical);

  async function reportViewers(username: string, viewers: number | null) {
    const card = page.locator(".live-stream-card").filter({has: page.getByText(`@${username}`, {exact: true})});
    const iframe = card.locator("iframe");
    await expect(iframe).toHaveCount(1);
    const frame = await (await iframe.elementHandle())!.contentFrame();
    await frame!.waitForLoadState("domcontentloaded");
    await frame!.evaluate(({origin, viewers}) => {
      window.parent.postMessage({type: "populi-live-widget-status", status: "live", viewers}, origin);
    }, {origin: new URL(page.url()).origin, viewers});
    if (viewers === null) await expect(card.locator(".live-stream-viewers")).toHaveCount(0);
    else await expect(card.locator(".live-stream-viewers")).toContainText(`${viewers} watching`);
  }

  for (const username of ["luna", "edison", "bob"]) {
    await reportViewers(username, 0);
    await expect(order).toHaveText(alphabetical);
  }
  await reportViewers("luna", 5);
  await expect(order).toHaveText(["@luna", "@bob", "@edison"]);
  await reportViewers("bob", 5);
  await expect(order).toHaveText(["@bob", "@luna", "@edison"]);
  await reportViewers("bob", null);
  await expect(order).toHaveText(["@luna", "@bob", "@edison"]);
  await reportViewers("luna", 0);
  await expect(order).toHaveText(alphabetical);

  await page.reload();
  await expect(order).toHaveText(alphabetical);
  expect(discoveryRequests).toBeGreaterThanOrEqual(2);
});

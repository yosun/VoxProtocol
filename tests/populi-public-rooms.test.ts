import {buildApp, MemoryStore} from "@vox/api";
import {describe, expect, it, vi} from "vitest";
import {createPopuliPublicRoomReader, parsePopuliPublicRooms} from "../apps/api/src/populi-public-rooms.js";

const publicHtml = `<!doctype html>
  <article class="populi-stream-card" data-character="bob"><p class="populi-stream-name">Bob</p></article>
  <article data-character="mossclerk" class="featured populi-stream-card"><p class="populi-stream-name">Moss &amp; Co</p></article>
  <article class="populi-stream-card" data-character="mossclerk"><p class="populi-stream-name">Duplicate</p></article>
  <article class="other" data-character="private"><p class="populi-stream-name">Private</p></article>
  <article class="populi-stream-card" data-character="../invalid"><p class="populi-stream-name">Invalid</p></article>`;

describe("public Populi room discovery", () => {
  it("extracts only marked public rooms, validates usernames, and decodes display names", () => {
    expect(parsePopuliPublicRooms(publicHtml)).toEqual([
      {username: "bob", display_name: "Bob"},
      {username: "mossclerk", display_name: "Moss & Co"}
    ]);
  });

  it("shares and caches requests, retaining the last public list during a short outage", async () => {
    let time = 1_000;
    let offline = false;
    const fetcher = vi.fn(async () => {
      if (offline) throw new Error("offline");
      return new Response(publicHtml);
    });
    const read = createPopuliPublicRoomReader(fetcher as typeof fetch, () => time);
    const [first, concurrent] = await Promise.all([read(), read()]);
    expect(first).toEqual(concurrent);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += 30_001;
    offline = true;
    expect(await read()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains known rooms if the public page no longer contains marked cards", async () => {
    let time = 1_000;
    let html = publicHtml;
    const fetcher = vi.fn(async () => new Response(html));
    const read = createPopuliPublicRoomReader(fetcher as typeof fetch, () => time);
    const first = await read();
    html = "<!doctype html><title>Temporarily unavailable</title>";
    time += 30_001;
    expect(await read()).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns public rooms and their counts without creating VOX agent identities", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "listPopuliLivestreamAgents").mockResolvedValue([{
      registration: {agent_id: "vox:agent:bob"},
      profile: {livestream: {provider: "populi", username: "bob"}}
    }] as never);
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return new Response(publicHtml);
      return new Response(JSON.stringify({viewers: url.searchParams.get("character") === "mossclerk" ? 5 : 2}));
    });
    const app = await buildApp({store});
    try {
      const response = await app.inject({method: "GET", url: "/v1/live-characters?limit=10&include_populi=true&include_viewers=true"});
      const result = response.json();
      expect(result.items).toHaveLength(1);
      expect(result.rooms).toEqual([{username: "bob", display_name: "Bob"}, {username: "mossclerk", display_name: "Moss & Co"}]);
      expect(result.viewers).toEqual({bob: 2, mossclerk: 5});
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
      fetcher.mockRestore();
    }
  });
});

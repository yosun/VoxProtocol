import {buildApp, MemoryStore} from "@vox/api";
import {describe, expect, it, vi} from "vitest";
import {createPopuliViewerCountReader} from "../apps/api/src/populi-viewer-counts.js";

describe("Populi viewer count discovery", () => {
  it("deduplicates concurrent reads, caches counts, and reuses only the room's session cookie", async () => {
    let time = 1_000;
    const requests: Array<{url: string; cookie?: string}> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const username = url.searchParams.get("character")!;
      requests.push({url: url.toString(), cookie: (init?.headers as Record<string, string>)?.cookie});
      const name = username === "bob" ? "bob_session" : `populi_${username}_session`;
      return new Response(JSON.stringify({viewers: username === "bob" ? 3 : 1}), {headers: {"set-cookie": `${name}=signed.session; Path=/; HttpOnly`}});
    });
    const read = createPopuliViewerCountReader(fetcher as typeof fetch, () => time);

    const [first, concurrent] = await Promise.all([read(["bob", "luna", "bob"]), read(["bob"])]);
    expect(first).toEqual({bob: 3, luna: 1});
    expect(concurrent).toEqual({bob: 3});
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests.map(({url}) => new URL(url).origin)).toEqual(["https://populi.cam", "https://populi.cam"]);
    expect(await read(["bob"])).toEqual({bob: 3});
    expect(fetcher).toHaveBeenCalledTimes(2);

    time += 30_001;
    expect(await read(["bob", "luna"])).toEqual({bob: 3, luna: 1});
    expect(requests.slice(2).map(({cookie}) => cookie)).toEqual(["bob_session=signed.session", "populi_luna_session=signed.session"]);
  });

  it("omits unavailable or invalid counts and bounds requests to valid usernames", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const username = new URL(String(input)).searchParams.get("character");
      if (username === "offline") throw new Error("unavailable");
      if (username === "invalid") return new Response(JSON.stringify({viewers: -1}));
      return new Response(JSON.stringify({viewers: 0}));
    });
    const read = createPopuliViewerCountReader(fetcher as typeof fetch);
    const results = await read(["../bad", "offline", "invalid", ...Array.from({length: 12}, (_, index) => `user${index}`)]);
    expect(results).toEqual(Object.fromEntries(Array.from({length: 8}, (_, index) => [`user${index}`, 0])));
    expect(fetcher).toHaveBeenCalledTimes(10);
    await read(["offline", "invalid"]);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("adds counts only when requested and only for registered livestream profiles", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "listPopuliLivestreamAgents").mockResolvedValue([{
      registration: {agent_id: "vox:agent:bob"},
      profile: {livestream: {provider: "populi", username: "bob"}}
    }] as never);
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({viewers: 4})));
    const app = await buildApp({store});
    try {
      const ordinary = await app.inject({method: "GET", url: "/v1/live-characters?limit=10"});
      expect(ordinary.json()).not.toHaveProperty("viewers");
      expect(fetcher).not.toHaveBeenCalled();
      const ranked = await app.inject({method: "GET", url: "/v1/live-characters?limit=10&include_viewers=true"});
      expect(ranked.json().viewers).toEqual({bob: 4});
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(ranked.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
      fetcher.mockRestore();
    }
  });
});

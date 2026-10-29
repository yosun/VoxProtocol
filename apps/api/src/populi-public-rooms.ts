export type PopuliPublicRoom = {username: string; display_name: string};

function plainText(value: string): string {
  const named: Record<string, string> = {amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " "};
  return value.replace(/<!--.*?-->|<[^>]*>/gs, "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] ?? original;
  }).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
}

// Populi publishes its active, media-ready rooms on its public homepage.
// Read only the marked cards and validate their usernames; never trust links
// or construct VOX identities from this HTML.
export function parsePopuliPublicRooms(html: string): PopuliPublicRoom[] {
  const rooms = new Map<string, PopuliPublicRoom>();
  for (const article of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article\s*>/gi)) {
    const attrs = article[1] ?? "";
    const classes = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]?.split(/\s+/) ?? [];
    const username = attrs.match(/\bdata-character\s*=\s*["']([a-z0-9_-]{1,64})["']/i)?.[1]?.toLowerCase();
    if (!classes.includes("populi-stream-card") || !username || rooms.has(username)) continue;
    const name = article[2]?.match(/<p\b[^>]*class\s*=\s*["'][^"']*\bpopuli-stream-name\b[^"']*["'][^>]*>([\s\S]*?)<\/p\s*>/i)?.[1];
    rooms.set(username, {username, display_name: name ? plainText(name) || username : username});
  }
  return [...rooms.values()].slice(0, 24);
}

export function createPopuliPublicRoomReader(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let rooms: PopuliPublicRoom[] = [];
  let expiresAt = 0;
  let pending: Promise<PopuliPublicRoom[]> | undefined;
  return async (): Promise<PopuliPublicRoom[]> => {
    if (pending) return pending;
    if (now() < expiresAt) return rooms;
    pending = (async () => {
      try {
        const response = await fetcher("https://populi.cam/", {redirect: "error", signal: AbortSignal.timeout(5_000)});
        if (!response.ok) throw new Error("Populi directory unavailable");
        const html = await response.text();
        if (html.length > 2_000_000) throw new Error("Populi directory too large");
        const parsed = parsePopuliPublicRooms(html);
        if (!parsed.length) throw new Error("Populi directory has no marked public rooms");
        rooms = parsed;
        expiresAt = now() + 30_000;
      } catch {
        // Keep the last public directory briefly if the source is unavailable.
        expiresAt = now() + 5_000;
      }
      return rooms;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

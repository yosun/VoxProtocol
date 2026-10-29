// Read public room snapshots without opening a stream or joining an audience.
// The short cache is shared by requests handled by this API instance.
type Entry = {
  value?: number;
  expiresAt: number;
  lastAccess: number;
  cookie?: string;
  pending?: Promise<number | undefined>;
};

const CACHE_MS = 30_000;
const IDLE_ENTRY_MS = 10 * 60_000;
const MAX_CHARACTERS = 10;

export function createPopuliViewerCountReader(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  async function fetchCount(username: string, entry: Entry): Promise<number | undefined> {
    const url = new URL("/api/room", "https://populi.cam");
    url.searchParams.set("character", username);
    try {
      const response = await fetcher(url, {
        headers: {accept: "application/json", ...(entry.cookie ? {cookie: entry.cookie} : {})},
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) return undefined;
      const cookieName = username === "bob" ? "bob_session" : `populi_${username}_session`;
      const cookieHeader = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
      const cookieValue = cookieHeader?.split(";", 1)[0]?.slice(cookieName.length + 1);
      if (cookieValue && /^[a-z0-9_.-]{1,512}$/i.test(cookieValue)) entry.cookie = `${cookieName}=${cookieValue}`;
      const text = await response.text();
      if (text.length > 1_000_000) return undefined;
      const viewers: unknown = (JSON.parse(text) as {viewers?: unknown}).viewers;
      return typeof viewers === "number" && Number.isSafeInteger(viewers) && viewers >= 0 ? viewers : undefined;
    } catch {
      return undefined;
    }
  }

  async function read(username: string): Promise<number | undefined> {
    const time = now();
    let entry = entries.get(username);
    if (!entry) {
      entry = {expiresAt: 0, lastAccess: time};
      entries.set(username, entry);
    }
    entry.lastAccess = time;
    if (entry.pending) return entry.pending;
    if (entry.expiresAt > time) return entry.value;
    const current = entry;
    const pending = fetchCount(username, current).then((value) => {
      if (value === undefined) delete current.value;
      else current.value = value;
      current.expiresAt = now() + CACHE_MS;
      return value;
    }).finally(() => { delete current.pending; });
    current.pending = pending;
    return pending;
  }

  return async (usernames: readonly string[]): Promise<Record<string, number>> => {
    const time = now();
    for (const [username, entry] of entries) {
      if (!entry.pending && time - entry.lastAccess > IDLE_ENTRY_MS) entries.delete(username);
    }
    const valid = [...new Set(usernames.filter((username) => /^[a-z0-9_-]{1,64}$/.test(username)))].slice(0, MAX_CHARACTERS);
    const values = await Promise.all(valid.map(async (username) => [username, await read(username)] as const));
    return Object.fromEntries(values.filter((entry): entry is readonly [string, number] => entry[1] !== undefined));
  };
}

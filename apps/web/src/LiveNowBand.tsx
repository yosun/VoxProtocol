import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {api, POPULI_DIRECTORY_AVAILABLE, POPULI_ORIGIN, trustedAvatarUrl, type AgentRecord, type PopuliPublicRoom} from "./api.js";

type LiveStatus = "connecting" | "live" | "standby" | "offline" | "preview" | "paused";

type LiveStatusMessage = {
  type: "populi-live-widget-status";
  status: Exclude<LiveStatus, "paused">;
  activity?: string;
  viewers?: number | null;
};

type LiveCharacter = {
  agent?: AgentRecord;
  username: string;
  displayName: string;
  handle: string;
  timeZone?: string;
};

function populiUsername(agent: AgentRecord): string | null {
  const configured = agent.profile?.livestream;
  if (configured !== undefined) {
    return configured?.provider === "populi" ? configured.username : null;
  }
  // POPULI's currently provisioned character uses the matching VOX handle
  // domain; keep this fallback for older registrations that predate signed
  // profile livestream settings.
  const match = agent.registration.handle.trim().match(/^@?([a-z0-9_-]+)@cruelty\.cam$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function discoverLiveCharacters(agents: Record<string, AgentRecord>, rooms: PopuliPublicRoom[]): LiveCharacter[] {
  const found = new Map<string, LiveCharacter>();
  for (const agent of Object.values(agents)) {
    const username = populiUsername(agent);
    if (!username || found.has(username)) continue;
    const handle = agent.registration.handle.split("@")[0]?.replace(/^@/, "") || username;
    const timeZone = agent.profile?.livestream?.provider === "populi" ? agent.profile.livestream.time_zone : undefined;
    found.set(username, {agent, username, displayName: agent.registration.display_name, handle, ...(timeZone ? {timeZone} : {})});
  }
  for (const room of rooms) {
    if (typeof room.username !== "string" || !/^[a-z0-9_-]{1,64}$/.test(room.username) || found.has(room.username)) continue;
    const displayName = typeof room.display_name === "string" && room.display_name ? room.display_name : room.username;
    found.set(room.username, {username: room.username, displayName, handle: room.username});
  }
  return [...found.values()];
}

function formatCharacterTime(timeZone: string, now = new Date()): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {hour: "numeric", minute: "2-digit", timeZone, timeZoneName: "short"}).format(now);
  } catch {
    return null;
  }
}

function LiveStreamCard({character, onViewersChange}: {character: LiveCharacter; onViewersChange: (username: string, viewers: number | null) => void}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [activity, setActivity] = useState("Connecting to live stream");
  const [viewers, setViewers] = useState<number | null>(null);
  const [localTime, setLocalTime] = useState(() => character.timeZone ? formatCharacterTime(character.timeZone) : null);
  const name = character.displayName;
  const avatarUrl = trustedAvatarUrl(character.agent?.profile?.avatar?.url);
  const embedUrl = `${POPULI_ORIGIN}/${encodeURIComponent(character.username)}/embed?audience=preview`;
  const voxUsername = character.agent?.registration.username;
  const profilePath = character.agent
    ? voxUsername ? `/${encodeURIComponent(voxUsername)}/?livestream=true` : `/agents/${encodeURIComponent(character.agent.registration.agent_id)}?livestream=true`
    : `${POPULI_ORIGIN}/${encodeURIComponent(character.username)}`;
  const destination = character.agent ? "VOX.gold" : "Populi.cam";

  useEffect(() => {
    const element = cardRef.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setShouldLoad(Boolean(entry?.isIntersecting));
    }, {rootMargin: "180px 120px", threshold: 0.01});
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    setActivity("Connecting to live stream");
    setViewers(null);
    onViewersChange(character.username, null);
  }, [character.username, onViewersChange, shouldLoad]);

  useEffect(() => {
    const timeZone = character.timeZone;
    if (!timeZone) {
      setLocalTime(null);
      return;
    }
    const updateTime = () => setLocalTime(formatCharacterTime(timeZone));
    updateTime();
    const interval = window.setInterval(updateTime, 30_000);
    return () => window.clearInterval(interval);
  }, [character.timeZone]);

  useEffect(() => {
    const receiveStatus = (event: MessageEvent<LiveStatusMessage>) => {
      if (event.origin !== POPULI_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== "populi-live-widget-status") return;
      setActivity(typeof data.activity === "string" ? data.activity.trim().slice(0, 90) || "Broadcasting now" : "Broadcasting now");
      const nextViewers = typeof data.viewers === "number" && Number.isSafeInteger(data.viewers) && data.viewers >= 0 ? data.viewers : null;
      setViewers(nextViewers);
      onViewersChange(character.username, nextViewers);
    };
    window.addEventListener("message", receiveStatus);
    return () => window.removeEventListener("message", receiveStatus);
  }, [character.username, onViewersChange]);

  return <article className="live-stream-card" ref={cardRef}>
    <div className="live-stream-media">
      {shouldLoad ? <div className="live-stream-frame" role="img" aria-label={`${name} live stream preview`}>
        <iframe
          ref={frameRef}
          src={embedUrl}
          title={`${name} live stream preview`}
          aria-hidden="true"
          tabIndex={-1}
          loading="lazy"
          allow="autoplay; fullscreen; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div> : <div className="live-stream-placeholder" aria-hidden="true"><span className="live-stream-placeholder-mark">◉</span></div>}
      <a className="live-stream-cover-link" href={profilePath} aria-label={`Watch ${name}'s live stream on ${destination}`} />
      <span role="note" className={`live-stream-local-time${localTime ? "" : " is-unset"}`} title={character.timeZone ?? "No time zone configured"} aria-label={localTime ? `${name}'s local time: ${localTime}` : `${name}'s local time is not configured`}>
        {localTime && character.timeZone ? <time dateTime={new Date().toISOString()}>{localTime}</time> : "Local time not set"}
      </span>
      {viewers !== null && <span className="live-stream-viewers live-stream-viewers-overlay"><span aria-hidden="true">◉</span>{viewers.toLocaleString()} watching</span>}
    </div>
    <div className="live-stream-meta">
      {avatarUrl ? <img className="live-stream-avatar" src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="live-stream-avatar live-stream-initials">{name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase()}</span>}
      <div className="live-stream-copy">
        <div className="live-stream-identity"><a className="live-stream-profile-link" href={profilePath} aria-label={character.agent ? `Open ${name}'s VOX profile` : `Open ${name}'s Populi room`}><strong>{name}</strong></a><span>@{character.handle}</span></div>
        <p title={activity}>{activity}</p>
      </div>
      <a className="live-stream-cta" href={profilePath} aria-label={`Watch ${name}'s live stream on ${destination}`}>Watch live <span aria-hidden="true">↗</span></a>
    </div>
  </article>;
}

export function LiveNowBand({agents, liveAgents, publicRooms, loading, feedError}: {agents: Record<string, AgentRecord>; liveAgents: AgentRecord[]; publicRooms: PopuliPublicRoom[]; loading: boolean; feedError: boolean}) {
  const [viewerCounts, setViewerCounts] = useState<Record<string, number>>({});
  const [candidateViewerCounts, setCandidateViewerCounts] = useState<Record<string, number>>({});
  const [discoveredRooms, setDiscoveredRooms] = useState(publicRooms);
  useEffect(() => { setDiscoveredRooms(publicRooms); }, [publicRooms]);
  const characters = useMemo(() => {
    const combined = new Map(liveAgents.map((agent) => [agent.registration.agent_id, agent] as const));
    for (const agent of Object.values(agents)) combined.set(agent.registration.agent_id, agent);
    const discovered = discoverLiveCharacters(Object.fromEntries(combined), discoveredRooms);
    const byUsername = new Map(discovered.map((character) => [character.username, character] as const));
    const candidates = new Map<string, LiveCharacter>();
    for (const username of [...liveAgents.map(populiUsername), ...discoveredRooms.map((room) => room.username)]) {
      const character = username ? byUsername.get(username) : undefined;
      if (character) candidates.set(character.username, character);
    }
    for (const character of discovered) candidates.set(character.username, character);
    return [...candidates.values()].slice(0, 10);
  }, [agents, liveAgents, discoveredRooms]);
  useEffect(() => {
    if (!POPULI_DIRECTORY_AVAILABLE) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      try {
        const result = await api.liveCharacters(10, characters.length > 5, true);
        if (!cancelled) {
          if (result.rooms?.length) setDiscoveredRooms((current) => JSON.stringify(current) === JSON.stringify(result.rooms) ? current : result.rooms!);
          if (result.viewers) setCandidateViewerCounts(Object.fromEntries(Object.entries(result.viewers).filter(([, viewers]) => Number.isSafeInteger(viewers) && viewers >= 0)));
        }
      } catch {
        // Keep the last available ranking while Populi or the VOX API recovers.
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [characters]);
  const reportViewers = useCallback((username: string, viewers: number | null) => {
    setViewerCounts((current) => {
      if (viewers === null) {
        if (!(username in current)) return current;
        const next = {...current};
        delete next[username];
        return next;
      }
      if (current[username] === viewers) return current;
      return {...current, [username]: viewers};
    });
  }, []);
  const sortedCharacters = useMemo(() => characters
    .map((character) => ({character, viewers: characters.length > 5 ? candidateViewerCounts[character.username] ?? viewerCounts[character.username] : viewerCounts[character.username]}))
    .sort((left, right) => {
      const leftUsername = left.character.agent?.registration.username ?? left.character.handle;
      const rightUsername = right.character.agent?.registration.username ?? right.character.handle;
      return (right.viewers ?? 0) - (left.viewers ?? 0)
        || leftUsername.localeCompare(rightUsername, "en", {sensitivity: "base"})
        || left.character.username.localeCompare(right.character.username, "en");
    })
    .slice(0, 5)
    .map(({character}) => character), [candidateViewerCounts, characters, viewerCounts]);

  return <section className="live-now-band" aria-labelledby="live-now-heading">
    <div className="live-now-heading">
      <div>
        <p className="eyebrow">The network, right now</p>
        <h2 id="live-now-heading"><span className="live-now-pulse" />Live windows</h2>
        <p className="live-now-description">See who’s broadcasting, ranked by live viewers.</p>
      </div>
      <div className="live-now-tools">
        <span className="live-now-count">{sortedCharacters.length ? `${sortedCharacters.length} ${sortedCharacters.length === 1 ? "broadcast" : "broadcasts"}` : feedError ? "Connection issue" : loading ? "Finding broadcasts" : "No connected rooms"}</span>
        {sortedCharacters.length > 2 && <span className="live-now-scroll-hint">Scroll to explore →</span>}
      </div>
    </div>
    {sortedCharacters.length ? <div className="live-now-track" role="region" tabIndex={0} aria-label="Live broadcasts, sorted by current viewers descending. Scroll horizontally to explore up to 5 characters.">
      {sortedCharacters.map((character) => <LiveStreamCard key={character.username} character={character} onViewersChange={reportViewers} />)}
    </div> : <div className="live-now-empty" role="status">
      <span className="live-now-empty-dot" />{feedError ? "Reconnect to the VOX feed to find live broadcasts." : loading ? "Finding live broadcasts…" : "No characters are live right now."}
    </div>}
  </section>;
}

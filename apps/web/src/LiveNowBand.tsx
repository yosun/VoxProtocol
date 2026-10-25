import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {trustedAvatarUrl, type AgentRecord} from "./api.js";

type LiveStatus = "connecting" | "live" | "standby" | "offline" | "preview" | "paused";

type LiveStatusMessage = {
  type: "populi-live-widget-status";
  status: Exclude<LiveStatus, "paused">;
  activity?: string;
  viewers?: number | null;
};

type LiveCharacter = {
  agent: AgentRecord;
  username: string;
  handle: string;
  timeZone?: string;
};

const POPULI_ORIGIN = (import.meta.env.VITE_POPULI_ORIGIN || "https://populi.cam").replace(/\/+$/, "");

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

function discoverLiveCharacters(agents: Record<string, AgentRecord>): LiveCharacter[] {
  const found = new Map<string, LiveCharacter>();
  for (const agent of Object.values(agents)) {
    const username = populiUsername(agent);
    if (!username || found.has(username)) continue;
    const handle = agent.registration.handle.split("@")[0]?.replace(/^@/, "") || username;
    const timeZone = agent.profile?.livestream?.provider === "populi" ? agent.profile.livestream.time_zone : undefined;
    found.set(username, {agent, username, handle, ...(timeZone ? {timeZone} : {})});
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
  const name = character.agent.registration.display_name;
  const avatarUrl = trustedAvatarUrl(character.agent.profile?.avatar?.url);
  const embedUrl = `${POPULI_ORIGIN}/${encodeURIComponent(character.username)}/embed`;
  const voxUsername = character.agent.registration.username;
  const voxProfilePath = voxUsername
    ? `/${encodeURIComponent(voxUsername)}/?livestream=true`
    : `/agents/${encodeURIComponent(character.agent.registration.agent_id)}?livestream=true`;
  const livestreamUrl = voxProfilePath;

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
      setActivity(data.activity?.trim().slice(0, 90) || "Broadcasting now");
      const nextViewers = typeof data.viewers === "number" && Number.isFinite(data.viewers) ? data.viewers : null;
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
      <a className="live-stream-cover-link" href={livestreamUrl} aria-label={`Watch ${name}'s live stream on VOX.gold`} />
      <span role="note" className={`live-stream-local-time${localTime ? "" : " is-unset"}`} title={character.timeZone ?? "No time zone configured"} aria-label={localTime ? `${name}'s local time: ${localTime}` : `${name}'s local time is not configured`}>
        {localTime && character.timeZone ? <time dateTime={new Date().toISOString()}>{localTime}</time> : "Local time not set"}
      </span>
      {viewers !== null && <span className="live-stream-viewers live-stream-viewers-overlay"><span aria-hidden="true">◉</span>{viewers.toLocaleString()} watching</span>}
    </div>
    <div className="live-stream-meta">
      {avatarUrl ? <img className="live-stream-avatar" src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="live-stream-avatar live-stream-initials">{name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase()}</span>}
      <div className="live-stream-copy">
        <div className="live-stream-identity"><a className="live-stream-profile-link" href={voxProfilePath} aria-label={`Open ${name}'s VOX profile`}><strong>{name}</strong></a><span>@{character.handle}</span></div>
        <p title={activity}>{activity}</p>
      </div>
      <a className="live-stream-cta" href={livestreamUrl} aria-label={`Watch ${name}'s live stream on VOX.gold`}>Watch live <span aria-hidden="true">↗</span></a>
    </div>
  </article>;
}

export function LiveNowBand({agents, liveAgents, loading, feedError}: {agents: Record<string, AgentRecord>; liveAgents: AgentRecord[]; loading: boolean; feedError: boolean}) {
  const [viewerCounts, setViewerCounts] = useState<Record<string, number>>({});
  const characters = useMemo(() => {
    const combined = new Map(liveAgents.map((agent) => [agent.registration.agent_id, agent] as const));
    for (const agent of Object.values(agents)) combined.set(agent.registration.agent_id, agent);
    return discoverLiveCharacters(Object.fromEntries(combined)).slice(0, 10);
  }, [agents, liveAgents]);
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
    .map((character, index) => ({character, index, viewers: viewerCounts[character.username]}))
    .sort((left, right) => {
      if (left.viewers === undefined && right.viewers === undefined) return left.index - right.index;
      if (left.viewers === undefined) return 1;
      if (right.viewers === undefined) return -1;
      return right.viewers - left.viewers || left.index - right.index;
    })
    .map(({character}) => character), [characters, viewerCounts]);

  return <section className="live-now-band" aria-labelledby="live-now-heading">
    <div className="live-now-heading">
      <div>
        <p className="eyebrow">The network, right now</p>
        <h2 id="live-now-heading"><span className="live-now-pulse" />Live windows</h2>
        <p className="live-now-description">See who’s broadcasting, ranked by live viewers.</p>
      </div>
      <div className="live-now-tools">
        <span className="live-now-count">{characters.length ? `${characters.length} ${characters.length === 1 ? "broadcast" : "broadcasts"}` : feedError ? "Connection issue" : loading ? "Finding broadcasts" : "No connected rooms"}</span>
        {characters.length > 2 && <span className="live-now-scroll-hint">Scroll to explore →</span>}
      </div>
    </div>
    {sortedCharacters.length ? <div className="live-now-track" role="region" tabIndex={0} aria-label="Live broadcasts, sorted by current viewers descending. Scroll horizontally to explore up to 10 characters.">
      {sortedCharacters.map((character) => <LiveStreamCard key={character.username} character={character} onViewersChange={reportViewers} />)}
    </div> : <div className="live-now-empty" role="status">
      <span className="live-now-empty-dot" />{feedError ? "Reconnect to the VOX feed to find live broadcasts." : loading ? "Finding live broadcasts…" : "No characters are live right now."}
    </div>}
  </section>;
}

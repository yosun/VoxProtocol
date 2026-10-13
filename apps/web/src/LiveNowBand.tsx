import {useEffect, useMemo, useRef, useState} from "react";
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
    found.set(username, {agent, username, handle});
  }
  return [...found.values()];
}

function LiveStreamCard({character}: {character: LiveCharacter}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [activity, setActivity] = useState("Syncing to Populi’s shared timeline");
  const [viewers, setViewers] = useState<number | null>(null);
  const name = character.agent.registration.display_name;
  const avatarUrl = trustedAvatarUrl(character.agent.profile?.avatar?.url);
  const embedUrl = `${POPULI_ORIGIN}/${encodeURIComponent(character.username)}/embed`;
  const voxUsername = character.agent.registration.username;
  const voxProfilePath = voxUsername
    ? `/${encodeURIComponent(voxUsername)}/?livestream=true`
    : `/agents/${encodeURIComponent(character.agent.registration.agent_id)}?livestream=true`;
  const livestreamUrl = voxUsername
    ? `https://vox.gold/${encodeURIComponent(voxUsername)}/?livestream=true`
    : `https://vox.gold/agents/${encodeURIComponent(character.agent.registration.agent_id)}?livestream=true`;

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
    setActivity("Syncing to Populi’s shared timeline");
    setViewers(null);
  }, [character.username, shouldLoad]);

  useEffect(() => {
    const receiveStatus = (event: MessageEvent<LiveStatusMessage>) => {
      if (event.origin !== POPULI_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== "populi-live-widget-status") return;
      setActivity(data.activity?.trim().slice(0, 90) || "Broadcasting from Populi");
      setViewers(typeof data.viewers === "number" && Number.isFinite(data.viewers) ? data.viewers : null);
    };
    window.addEventListener("message", receiveStatus);
    return () => window.removeEventListener("message", receiveStatus);
  }, []);

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
      <div className="live-stream-presence"><span className="live-stream-live-label"><span />LIVE</span><span>POPULI / {character.handle}</span></div>
      <a className="live-stream-watch-button" href={livestreamUrl} aria-label={`Watch ${name}'s live stream on VOX.gold`}>Open room <span aria-hidden="true">↗</span></a>
      <div className="live-stream-window-caption"><span>shared window</span><span>clips · idle · moments</span></div>
    </div>
    <div className="live-stream-meta">
      {avatarUrl ? <img className="live-stream-avatar" src={avatarUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="live-stream-avatar live-stream-initials">{name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase()}</span>}
      <div className="live-stream-copy">
        <div className="live-stream-identity"><a className="live-stream-profile-link" href={voxProfilePath} aria-label={`Open ${name}'s VOX profile`}><strong>{name}</strong></a><span>@{character.handle}</span></div>
        <p title={activity}>{activity}</p>
      </div>
      {viewers !== null && <span className="live-stream-viewers"><span aria-hidden="true">◉</span>{viewers.toLocaleString()} watching</span>}
    </div>
  </article>;
}

export function LiveNowBand({agents, liveAgents, loading, feedError}: {agents: Record<string, AgentRecord>; liveAgents: AgentRecord[]; loading: boolean; feedError: boolean}) {
  const characters = useMemo(() => {
    const combined = new Map(liveAgents.map((agent) => [agent.registration.agent_id, agent] as const));
    for (const agent of Object.values(agents)) combined.set(agent.registration.agent_id, agent);
    return discoverLiveCharacters(Object.fromEntries(combined)).slice(0, 10);
  }, [agents, liveAgents]);

  return <section className="live-now-band" aria-labelledby="live-now-heading">
    <div className="live-now-heading">
      <div>
        <p className="eyebrow">The network, right now</p>
        <h2 id="live-now-heading"><span className="live-now-pulse" />Live windows</h2>
        <p className="live-now-description">Populi rooms connected to VOX characters, shown independently of recent posting.</p>
      </div>
      <div className="live-now-tools">
        <span className="live-now-count">{characters.length ? `${characters.length} ${characters.length === 1 ? "broadcast" : "broadcasts"}` : feedError ? "Connection issue" : loading ? "Finding broadcasts" : "No connected rooms"}</span>
        {characters.length > 2 && <span className="live-now-scroll-hint">Scroll to explore →</span>}
      </div>
    </div>
    {characters.length ? <div className="live-now-track" role="region" tabIndex={0} aria-label="Live Populi broadcasts. Scroll horizontally to explore up to 10 characters.">
      {characters.map((character) => <LiveStreamCard key={character.username} character={character} />)}
    </div> : <div className="live-now-empty" role="status">
      <span className="live-now-empty-dot" />{feedError ? "Reconnect to the VOX feed to find live Populi broadcasts." : loading ? "Finding characters with live Populi broadcasts…" : "No Populi broadcasts are connected to VOX characters yet."}
    </div>}
  </section>;
}

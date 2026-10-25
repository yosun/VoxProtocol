import "./buffer-polyfill.js";
import {conversationRootId, videoBriefPrompt} from "@vox/protocol";
import React, {Suspense, lazy, useEffect, useMemo, useRef, useState} from "react";
import {createRoot} from "react-dom/client";
import {ApiError, api, publicPageUrl, trustedAvatarUrl, type AgentRecord, type LinkPreview, type PostRecord, type ProofResponse} from "./api.js";
import {LiveNowBand} from "./LiveNowBand.js";
import {getCurrentHumanProfile, getHumanAccountIdentity, registerHumanAccount, signFollowOperation, signedHumanGetHeaders} from "./human-account.js";
import "./styles.css";

const RealizeCheckout = lazy(() => import("./RealizeCheckout.js").then(({RealizeCheckout: component}) => ({default: component})));
const InspirationDialog = lazy(() => import("./InspirationDialog.js").then(({InspirationDialog: component}) => ({default: component})));
const HumanAccountDialog = lazy(() => import("./HumanAccount.js").then(({HumanAccountDialog: component}) => ({default: component})));
const WalletConnectDialog = lazy(() => import("./WalletConnectDialog.js").then(({WalletConnectDialog: component}) => ({default: component})));
const DirectMessages = lazy(() => import("./DirectMessages.js").then(({DirectMessages: component}) => ({default: component})));
const CharacterConversations = lazy(() => import("./CharacterConversations.js").then(({CharacterConversations: component}) => ({default: component})));

function initials(name: string): string {
  return name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "VX";
}

function Avatar({agent, name, className = ""}: {agent: AgentRecord | undefined; name: string; className?: string}) {
  const [failed, setFailed] = useState(false);
  const avatarUrl = failed ? undefined : trustedAvatarUrl(agent?.profile?.avatar?.url);
  return <div className={`avatar${className ? ` ${className}` : ""}`}>{avatarUrl ? <img className="avatar-image" src={avatarUrl} alt="" width={256} height={256} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : initials(name)}</div>;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatEpoch(epoch: string): string {
  const day = epoch.endsWith("Z") ? epoch.slice(0, -1) : epoch;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return epoch;
  return `${new Intl.DateTimeFormat("en-US", {month: "long", day: "numeric", year: "numeric", timeZone: "UTC"}).format(date)} · UTC`;
}

function formatHex(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Request failed. Please retry.";
}

type RequestContext = "feed" | "search" | "post";

function errorTitle(reason: unknown, context: RequestContext): string {
  if (context === "post") return "Couldn’t load this post";
  if (reason instanceof ApiError) {
    if (reason.kind === "network") return "Can’t connect to VOX.gold";
    if (reason.status !== undefined && reason.status >= 500) return context === "search" ? "Search is temporarily unavailable" : "VOX.gold is temporarily unavailable";
    if (reason.status !== undefined && reason.status >= 400) return context === "search" ? "Search request was rejected" : "VOX.gold request was rejected";
  }
  return context === "search" ? "Search failed" : "Couldn’t load VOX.gold";
}

async function loadAgentEntries(ids: string[], knownAgents = new Map<string, AgentRecord>()): Promise<Array<[string, AgentRecord]>> {
  const results = await Promise.all(ids.map(async (id) => {
    const known = knownAgents.get(id);
    if (known) return [id, known] as [string, AgentRecord];
    try {
      return [id, await api.agent(id)] as [string, AgentRecord];
    } catch {
      return null;
    }
  }));
  return results.filter((result): result is [string, AgentRecord] => result !== null);
}

function solanaStatusLabel(status: string): string {
  if (status === "finalized") return "Verified on Solana";
  if (status === "submitted") return "Solana submitted · awaiting finality";
  if (status === "queued") return "Solana anchoring queued";
  return "Solana verification: View proof ↗";
}

function Badge({children, tone = "quiet"}: {children: React.ReactNode; tone?: "quiet" | "good" | "gold"}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function VoxCharacterBadge() {
  return <span className="vox-character-badge" role="img" aria-label="Imaginary person" title="Imaginary person">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.4" fill="none" stroke="#f4c542" strokeWidth="3" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" fill="#f4c542" />
      <path d="m9.8 12 1.55 1.55 2.95-3.05" fill="none" stroke="#241b09" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>;
}

function postPresentation(kind: string, hasVideo: boolean): {label: string; className: string; mark: string; nativeKind: string} {
  if (hasVideo) return {label: "Realized", className: "realized", mark: "✦", nativeKind: kind};
  if (kind === "fiction") return {label: "Possibility", className: "possibility", mark: "↗", nativeKind: kind};
  if (kind === "thought" || kind === "observation" || kind === "reply") return {label: "Thought", className: "thought", mark: "·", nativeKind: kind};
  return {label: "Signal", className: "signal", mark: "○", nativeKind: kind};
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

function extractHttpUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const value = match[0]!.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "");
    try {
      const url = new URL(value).href;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    } catch {
      // Ignore malformed URL-like text.
    }
  }
  return urls;
}

function isVideoUrl(url: string): boolean {
  try { return /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i.test(new URL(url).pathname); } catch { return false; }
}

function inferVideoType(url: string): string | undefined {
  try {
    switch (new URL(url).pathname.toLowerCase().match(/\.(mp4|webm|ogg|mov)$/)?.[1]) {
      case "mp4": return "video/mp4";
      case "webm": return "video/webm";
      case "ogg": return "video/ogg";
      case "mov": return "video/quicktime";
      default: return undefined;
    }
  } catch {
    return undefined;
  }
}

function fallbackLinkPreview(url: string): LinkPreview {
  const parsed = new URL(url);
  const siteName = parsed.hostname.replace(/^www\\./i, "");
  const video = isVideoUrl(url);
  if (!video) return {url, canonicalUrl: url, title: siteName, description: `Open ${siteName} to view the shared page.`, siteName, kind: "website"};
  const videoType = inferVideoType(url);
  return {url, canonicalUrl: url, title: siteName, description: `Open ${siteName} to view the shared page.`, siteName, kind: "video", videoUrl: url, ...(videoType ? {videoType} : {})};
}

function isVideoPreview(preview: LinkPreview): boolean {
  return !!preview.videoUrl && (!!preview.videoType?.startsWith("video/") || isVideoUrl(preview.videoUrl));
}

function removeVideoUrls(text: string, previews: LinkPreview[]): string {
  const videoUrls = new Set(previews.filter(isVideoPreview).flatMap((preview) => [preview.url, preview.canonicalUrl]));
  if (videoUrls.size === 0) return text;
  const marker = "__VOX_VIDEO_URL__";
  const withoutUrls = text.replace(HTTP_URL_PATTERN, (match) => {
    const candidate = match.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "");
    try { return videoUrls.has(new URL(candidate).href) ? marker : match; } catch { return match; }
  });
  return withoutUrls.split("\n").map((line) => {
    const clean = line.replaceAll(marker, "").replace(/ {2,}/g, " ").trim();
    return clean.endsWith(":") ? clean.slice(0, -1).trimEnd() : clean;
  }).join("\n").trim();
}

interface PopuliRoomCallout {
  username: string;
  start: number;
  end: number;
}

const RESERVED_POPULI_ROOM_NAMES = new Set(["v1", "search", "docs", "onboarding", "agents", "humans", "human", "posts", "post", "request", "requests", "assets", "robots", "sitemap", "llms", "openapi", "agent-quickstart", "favicon", "site", "index"]);

function populiRoomCallout(text: string): PopuliRoomCallout | undefined {
  const match = /\b(join\s+the\s+live\s+room)\s*:\s*(https?:\/\/[^\s<>"'`]+)/i.exec(text);
  if (!match || match.index === undefined) return undefined;
  const urlText = match[2]!.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "");
  let url: URL;
  try { url = new URL(urlText); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== "populi.cam" || (url.protocol !== "https:" && url.protocol !== "http:")) return undefined;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { return undefined; }
  const pathMatch = /^\/([a-z0-9_-]{1,15})(?:\/widget)?\/?$/i.exec(pathname);
  if (!pathMatch) return undefined;
  const username = pathMatch[1]!.toLowerCase();
  if (RESERVED_POPULI_ROOM_NAMES.has(username)) return undefined;
  const calloutStart = match.index + match[0].indexOf(match[1]!);
  const urlStart = match.index + match[0].lastIndexOf(match[2]!);
  return {username, start: calloutStart, end: urlStart + urlText.length};
}

function isPopuliRoomUrl(value: string, username: string): boolean {
  try {
    const clean = value.replace(/[.,!?;:]+$/, "").replace(/[)}\]]+$/, "");
    const url = new URL(clean);
    const pathname = decodeURIComponent(url.pathname).replace(/\/$/, "");
    return url.hostname.toLowerCase() === "populi.cam" && new RegExp(`^/${username}(?:/widget)?$`, "i").test(pathname);
  } catch {
    return false;
  }
}

function VideoPremiereModal({source, type, poster, title, onClose}: {source: string; type?: string | undefined; poster?: string | undefined; title: string; onClose: () => void}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.body.classList.add("premiere-open");
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.classList.remove("premiere-open"); document.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);
  return <div className="premiere-backdrop" role="dialog" aria-modal="true" aria-label={`Premiere: ${title}`} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="premiere-stage">
      <button type="button" className="premiere-close" onClick={onClose} aria-label="Close premiere">×</button>
      <video className="premiere-video" controls autoPlay playsInline poster={poster} aria-label={title}><source src={source} type={type} /></video>
    </div>
  </div>;
}

function LinkPreviewCard({preview}: {preview: LinkPreview}) {
  const video = isVideoPreview(preview);
  const [premiereOpen, setPremiereOpen] = useState(false);
  const inlineVideo = useRef<HTMLVideoElement>(null);
  const hostname = (() => { try { return new URL(preview.canonicalUrl).hostname.replace(/^www\\./i, ""); } catch { return preview.siteName; } })();
  const platformName = preview.siteName || hostname;
  const premiereButton = video && <button type="button" className="link-preview-premiere" data-video-source={preview.videoUrl} data-video-type={preview.videoType} data-video-poster={preview.imageUrl} data-video-title={preview.title} onClick={openPremiere} aria-label={`Open ${preview.title} in premiere mode`}><span aria-hidden="true">⛶</span><span>Premiere</span></button>;
  const videoAttribution = video && <div className="link-preview-attribution"><span className="link-preview-attribution-label">From {platformName}</span><a className="link-preview-source" href={preview.url} target="_blank" rel="nofollow noopener noreferrer" aria-label={`Watch ${preview.title} on ${platformName} (opens in a new tab)`}><span className="link-preview-source-label">Watch on {platformName}</span><span aria-hidden="true">↗</span></a></div>;
  const media = video
    ? <div className="link-preview-video-shell"><video ref={inlineVideo} className="link-preview-video" controls preload="metadata" poster={preview.imageUrl} aria-label={`Preview of ${preview.title}`}><source src={preview.videoUrl} type={preview.videoType} /></video>{premiereButton}{videoAttribution}</div>
    : <a className={`link-preview-media${preview.imageUrl ? "" : " link-preview-placeholder"}`} href={preview.url} target="_blank" rel="nofollow noopener noreferrer" aria-label={`Open ${preview.title}`}>{preview.imageUrl ? <img src={preview.imageUrl} alt={preview.imageAlt ?? preview.title} loading="lazy" /> : <span>↗</span>}</a>;
  function openPremiere() {
    inlineVideo.current?.pause();
    setPremiereOpen(true);
  }
  return <>
    <article className={`link-preview${preview.kind === "video" ? " link-preview-video-card" : ""}`}>
      {media}
      <div className="link-preview-body">{!video && <span className="link-preview-site">{preview.siteName || hostname}</span>}<a className="link-preview-title" href={preview.url} target="_blank" rel="nofollow noopener noreferrer"><h3>{preview.title}</h3></a><p>{preview.description}</p>{!video && <span className="link-preview-url">{hostname}</span>}</div>
    </article>
    {premiereOpen && <VideoPremiereModal source={preview.videoUrl!} type={preview.videoType} poster={preview.imageUrl} title={preview.title} onClose={() => setPremiereOpen(false)} />}
  </>;
}

function PostContent({text, onVideoDetected}: {text: string; onVideoDetected?: (hasVideo: boolean) => void}) {
  const callout = useMemo(() => populiRoomCallout(text), [text]);
  const urls = useMemo(() => extractHttpUrls(text).filter((url) => !callout || !isPopuliRoomUrl(url, callout.username)), [callout, text]);
  const fallbackPreviews = useMemo(() => Object.fromEntries(urls.map((url) => [url, fallbackLinkPreview(url)])), [urls]);
  const [previews, setPreviews] = useState<Record<string, LinkPreview>>(() => fallbackPreviews);
  useEffect(() => {
    let active = true;
    setPreviews(fallbackPreviews);
    onVideoDetected?.(Object.values(fallbackPreviews).some(isVideoPreview));
    void Promise.all(urls.map(async (url) => {
      try { return [url, await api.linkPreview(url)] as const; } catch { return null; }
    })).then((results) => {
      if (!active) return;
      const loaded = Object.fromEntries(results.filter((result): result is readonly [string, LinkPreview] => result !== null));
      const resolved = {...fallbackPreviews, ...loaded};
      setPreviews(resolved);
      onVideoDetected?.(Object.values(resolved).some(isVideoPreview));
    });
    return () => { active = false; };
  }, [fallbackPreviews, onVideoDetected, urls]);
  const visibleText = removeVideoUrls(text, Object.values(previews));
  const calloutHref = callout ? `/${encodeURIComponent(callout.username)}/?livestream=true` : "";
  const postText = callout
    ? <>{removeVideoUrls(text.slice(0, callout.start), Object.values(previews))}<a className="post-live-room-cta" href={calloutHref}>Join the live room <span aria-hidden="true">↗</span></a>{removeVideoUrls(text.slice(callout.end), Object.values(previews))}</>
    : visibleText;
  return <><p className="post-text">{postText}</p>{urls.length > 0 && <div className="link-previews" aria-label="Shared links">{urls.map((url) => <LinkPreviewCard key={url} preview={previews[url] ?? fallbackLinkPreview(url)} />)}</div>}</>;
}

function VerificationDrawer({post, onClose}: {post: PostRecord; onClose: () => void}) {
  const [data, setData] = useState<ProofResponse | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { void api.proof(post.post_id).then(setData).catch((reason: Error) => setError(reason.message)); }, [post.post_id]);
  const solanaVerified = !!data && post.anchoring.status === "finalized" && data.bundle.anchor?.finalized === true && data.verification.chainCommitmentVerified && data.verification.chainFinalized;
  const checks = data ? [
    ["Authorship", data.verification.authorshipVerified],
    ["Record integrity", data.verification.recordIntegrityVerified],
    ["Journal signature", data.verification.journalVerified],
    ["Merkle inclusion", data.verification.merkleInclusionVerified],
    ["Solana commitment", solanaVerified && data.verification.chainCommitmentVerified],
    ["Finalized transaction", solanaVerified && data.verification.chainFinalized]
  ] as const : [];
  return <div className="drawer-backdrop" onClick={onClose}>
    <aside className="drawer" onClick={(event) => event.stopPropagation()}>
      <button className="icon-button close" onClick={onClose} aria-label="Close verification">×</button>
      <p className="eyebrow">Independent evidence</p>
      <h2>Proof of publication</h2>
      <p className="muted">This evidence proves a signed publication record. It does not prove that a fictional event happened.</p>
      {error && <div className="error-box">{error}</div>}
      {!data && !error && <div className="loading-line">Reconstructing cryptographic evidence…</div>}
      {data && <>
        <div className="check-list">{checks.map(([label, passed]) => <div className="check-row" key={label}><span className={passed ? "check pass" : "check"}>{passed ? "✓" : "–"}</span><span>{label}</span><strong>{passed ? "verified" : "pending"}</strong></div>)}</div>
        <div className="evidence-card"><span>Post hash</span><code>{post.post_hash}</code></div>
        {data.bundle.manifest && <>
          <div className="evidence-card"><span>On the record</span><strong>{formatEpoch(data.bundle.manifest.epoch)}</strong><span>Merkle root</span><code>{formatHex(data.bundle.manifest.root)}</code></div>
          <div className="evidence-card"><span>Solana verification</span><strong>{solanaVerified ? "Verified on Solana" : data.bundle.anchor ? "Awaiting finality" : "Awaiting batch anchor"}</strong>{data.bundle.anchor && <a href={`https://explorer.solana.com/tx/${data.bundle.anchor.transaction_signature}?cluster=devnet`} target="_blank" rel="noreferrer">View proof ↗</a>}</div>
        </>}
        <p className="tiny muted">{data.verification.recordValid ? data.verification.valid ? "The signed publication record is valid; chain evidence is finalized." : "The signed publication record is valid; chain finality is incomplete." : "The published record has one or more incomplete verification stages."}</p>
      </>}
    </aside>
  </div>;
}

function RealizeDialog({post, posts, agents, initialBrief, onClose}: {post: PostRecord; posts: PostRecord[]; agents: Record<string, AgentRecord>; initialBrief?: {prompt: string; durationSeconds: number} | undefined; onClose: () => void}) {
  return <Suspense fallback={<div className="drawer-backdrop"><div className="loading-line" role="status">Preparing private VOX checkout…</div></div>}><RealizeCheckout post={post} posts={posts} agents={agents} initialBrief={initialBrief} onClose={onClose} /></Suspense>;
}


function postPath(postId: string): string {
  const slug = postId.startsWith("vox:post:") ? postId.slice("vox:post:".length) : postId;
  return `/post/${slug}`;
}

function agentProfilePath(agent: AgentRecord | undefined, fallbackAgentId: string): string {
  if (agent?.registration.username) return `/${encodeURIComponent(agent.registration.username)}`;
  const slug = fallbackAgentId.startsWith("vox:agent:") ? fallbackAgentId.slice("vox:agent:".length) : fallbackAgentId;
  return `/agents/${encodeURIComponent(slug)}`;
}

function publicAgentHandle(registration: AgentRecord["registration"]): string {
  return registration.username ? `@${registration.username}` : `@${registration.handle.replace(/^.*@/, "")}`;
}

function postIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/post\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const slug = decodeURIComponent(match[1]!);
    if (/^[0-9a-f]{64}$/.test(slug)) return `vox:post:${slug}`;
    if (/^vox:post:[0-9a-f]{64}$/.test(slug)) return slug;
  } catch {
    return null;
  }
  return null;
}

function realizePostIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("realize");
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    if (/^[0-9a-f]{64}$/.test(decoded)) return `vox:post:${decoded}`;
    if (/^vox:post:[0-9a-f]{64}$/.test(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

function searchQueryFromLocation(pathname: string, search: string): string {
  if (pathname !== "/search") return "";
  return new URLSearchParams(search).get("q")?.trim() ?? "";
}

function PostCard({post, agent, onVerify, onRealize, onInspire}: {post: PostRecord; agent: AgentRecord | undefined; onVerify: (post: PostRecord) => void; onRealize: (post: PostRecord) => void; onInspire: (post: PostRecord) => void}) {
  const [liked, setLiked] = useState(false);
  const [reactionCount, setReactionCount] = useState(0);
  const [reactionError, setReactionError] = useState("");
  const [hasVideoLink, setHasVideoLink] = useState(() => extractHttpUrls(post.intent.content.text).some(isVideoUrl));
  const name = agent?.registration.display_name ?? "Unknown local";
  const handle = agent ? publicAgentHandle(agent.registration) : post.intent.agent_id;
  const profile = agentProfilePath(agent, post.intent.agent_id);
  const presentation = postPresentation(post.intent.kind, hasVideoLink);
  const realizeLabel = hasVideoLink ? "I'm inspired" : "Realize";
  async function react() {
    if (liked) return;
    try {
      const result = await api.react(post.post_id);
      setLiked(true);
      setReactionCount(result.count);
      setReactionError("");
    } catch (reason) {
      setReactionError(errorText(reason));
    }
  }
  return <article className={`post-card post-card-${presentation.className}`}>
    <a className="post-author-avatar-link" href={profile} aria-label={`Open ${name}'s VOX profile`}><Avatar agent={agent} name={name} /></a>
    <div className="post-main">
      <div className="post-meta"><a className="post-author-link" href={profile}><strong>{name}</strong></a><VoxCharacterBadge /><span className="handle">{handle}</span><span className="dot">·</span><a className="handle" href={postPath(post.post_id)} title="Open permanent link">{relativeTime(post.intent.created_at)}</a></div>
      <div className="post-type-line"><p className={`post-kind post-kind-${presentation.className}`}><span className="post-kind-mark" aria-hidden="true">{presentation.mark}</span>{presentation.label}</p><span className="post-native-kind" title={`Protocol post kind: ${presentation.nativeKind}`}>{presentation.nativeKind}</span></div>
      <PostContent text={post.intent.content.text} onVideoDetected={setHasVideoLink} />
      {conversationRootId(post) && <a className="post-story-link" href={`/?conversation=${encodeURIComponent(conversationRootId(post)!)}`}>◌ {post.intent.content.conversation?.type === "start" ? post.intent.content.conversation.title : "Read the conversation"} ↗</a>}
      <div className="post-actions"><a className="post-conversation-action" aria-label="Start a character conversation" href={`/?${conversationRootId(post) ? `conversation=${encodeURIComponent(conversationRootId(post)!)}` : `story_from=${encodeURIComponent(post.post_id)}`}`}>↩ <span>Converse</span></a><button aria-label="React" onClick={() => void react()}> {liked ? "♥" : "♡"} <span>{liked ? "Liked" : "React"}{reactionCount ? ` · ${reactionCount}` : ""}</span></button><button onClick={() => onVerify(post)} aria-label="View verification">◈ <span>On the record</span></button><button className="realize-cta" onClick={() => hasVideoLink ? onInspire(post) : onRealize(post)} aria-label={`${realizeLabel} by post`} title={hasVideoLink ? "Share this post as inspiration with a character." : "Commission this post as a video."}>✦ <span>{realizeLabel}</span></button></div>{reactionError && <span className="tiny muted" role="status">{reactionError}</span>}
      <div className="post-footer"><span className="status-dot" />Published · journal #{post.envelope.sequence}<button className="anchor-status" onClick={() => onVerify(post)}>{solanaStatusLabel(post.anchoring.status)}</button></div>
    </div>
  </article>;
}

function SearchResults({matchedAgents, posts, agents, onVerify, onRealize, onInspire}: {matchedAgents: AgentRecord[]; posts: PostRecord[]; agents: Record<string, AgentRecord>; onVerify: (post: PostRecord) => void; onRealize: (post: PostRecord) => void; onInspire: (post: PostRecord) => void}) {
  if (matchedAgents.length === 0 && posts.length === 0) {
    return <div className="empty-state"><div className="empty-orb">⌕</div><h2>No public matches.</h2><p>Try an agent name, handle, identity, or published text.</p></div>;
  }
  return <div className="search-results">
    {matchedAgents.length > 0 && <section className="search-results-section" aria-labelledby="search-characters-heading"><h2 id="search-characters-heading">Characters</h2><div className="discover-grid">{matchedAgents.map((agent) => {
      const id = agent.registration.agent_id;
      const profile = agentProfilePath(agent, id);
      return <article className="agent-card" key={id}><a className="agent-card-link" href={profile} aria-label={`Open ${agent.registration.display_name}'s VOX profile`}><Avatar agent={agent} name={agent.registration.display_name} className="large" /><div className="agent-card-heading"><h3>{agent.registration.display_name}</h3><VoxCharacterBadge /></div><span className="handle">{publicAgentHandle(agent.registration)}</span><p>{agent.registration.description}</p><span className="agent-card-arrow" aria-hidden="true">↗</span></a></article>;
    })}</div></section>}
    {posts.length > 0 && <section className="search-results-section" aria-labelledby="search-thoughts-heading"><h2 id="search-thoughts-heading">Thoughts</h2>{posts.map((post) => <PostCard key={post.post_id} post={post} agent={agents[post.intent.agent_id]} onVerify={onVerify} onRealize={onRealize} onInspire={onInspire} />)}</section>}
  </div>;
}

function App() {
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [agents, setAgents] = useState<Record<string, AgentRecord>>({});
  const [liveAgents, setLiveAgents] = useState<AgentRecord[]>([]);
  const [selected, setSelected] = useState<PostRecord | null>(null);
  const [realize, setRealize] = useState<PostRecord | null>(null);
  const [realizeContext, setRealizeContext] = useState<{posts: PostRecord[]; agents: Record<string, AgentRecord>; brief: {prompt: string; durationSeconds: number}}>();
  const [conversation, setConversation] = useState<{rootId?: string; sourcePost?: PostRecord} | null>(() => {
    const id = new URLSearchParams(window.location.search).get("conversation");
    return id && /^vox:post:[0-9a-f]{64}$/.test(id) ? {rootId: id} : new URLSearchParams(window.location.search).has("conversations") ? {} : null;
  });
  const [inspiration, setInspiration] = useState<PostRecord | null>(null);
  const [humanAccountOpen, setHumanAccountOpen] = useState(() => new URLSearchParams(window.location.search).get("account") === "true");
  const [walletOpen, setWalletOpen] = useState(() => new URLSearchParams(window.location.search).get("wallet") === "true");
  const [initialDmRecipient, setInitialDmRecipient] = useState(() => new URLSearchParams(window.location.search).get("to") ?? "");
  const [messagesOpen, setMessagesOpen] = useState(() => new URLSearchParams(window.location.search).get("messages") === "true");
  const [dmIdentityRevision, setDmIdentityRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [errorHeading, setErrorHeading] = useState("");
  const [loadMoreError, setLoadMoreError] = useState("");
  const [view, setView] = useState<"feed" | "discover">("feed");
  const initialSearchQuery = searchQueryFromLocation(window.location.pathname, window.location.search);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [searchAgents, setSearchAgents] = useState<AgentRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const initialRealizePostId = realizePostIdFromSearch(window.location.search);
  const [routePostId, setRoutePostId] = useState<string | null>(() => postIdFromPath(window.location.pathname) ?? initialRealizePostId);
  const [feedCursor, setFeedCursor] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const feedCursorRef = useRef<string>();
  const feedSentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const requestVersionRef = useRef(0);
  const isPostRoute = routePostId !== null;

  useEffect(() => {
    const source = new URLSearchParams(window.location.search).get("story_from");
    if (!source || !/^vox:post:[0-9a-f]{64}$/.test(source)) return;
    let active = true;
    void api.post(source).then((post) => { if (active) setConversation({sourcePost: post}); }).catch((reason) => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, []);

  function closeConversation() {
    setConversation(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("conversation"); url.searchParams.delete("story_from"); url.searchParams.delete("conversations");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function clearError() {
    setError("");
    setErrorHeading("");
  }

  function setRequestError(reason: unknown, context: RequestContext) {
    setError(errorText(reason));
    setErrorHeading(errorTitle(reason, context));
  }

  function resetPagination() {
    feedCursorRef.current = undefined;
    setFeedCursor(undefined);
    setHasMore(false);
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setLoadMoreError("");
  }

  function closeMessages() {
    setMessagesOpen(false);
    const url = new URL(window.location.href);
    const hadMessageRoute = url.searchParams.has("messages") || url.searchParams.has("to");
    url.searchParams.delete("messages");
    url.searchParams.delete("to");
    if (hadMessageRoute) window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function load() {
    const requestVersion = ++requestVersionRef.current;
    resetPagination();
    setLoading(true); clearError(); setSearching(false); setSearchQuery(""); setSearchAgents([]);
    setLiveAgents([]);
    try {
      const [result, liveResult] = await Promise.all([
        api.feed(),
        api.liveCharacters().catch(() => ({items: [] as AgentRecord[]})),
      ]);
      if (requestVersion !== requestVersionRef.current) return;
      setPosts(result.items);
      setLiveAgents(liveResult.items.filter((agent) => agent.profile?.livestream?.provider === "populi"));
      feedCursorRef.current = result.next_cursor;
      setFeedCursor(result.next_cursor);
      setHasMore(Boolean(result.next_cursor));
      const ids = [...new Set(result.items.map((post) => post.intent.agent_id))];
      const entries = await loadAgentEntries(ids);
      if (requestVersion !== requestVersionRef.current) return;
      setAgents(Object.fromEntries(entries));
    } catch (reason) {
      if (requestVersion === requestVersionRef.current) setRequestError(reason, "feed");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }

  async function loadMore() {
    if (loading || loadingMoreRef.current || isPostRoute || view !== "feed" || searching || !hasMore) return;
    const cursor = feedCursorRef.current;
    if (!cursor) {
      setHasMore(false);
      return;
    }
    const requestVersion = requestVersionRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const result = await api.feed(40, cursor);
      if (requestVersion !== requestVersionRef.current) return;
      const nextCursor = result.next_cursor === cursor ? undefined : result.next_cursor;
      setPosts((current) => {
        const existingIds = new Set(current.map((post) => post.post_id));
        return [...current, ...result.items.filter((post) => !existingIds.has(post.post_id))];
      });
      feedCursorRef.current = nextCursor;
      setFeedCursor(nextCursor);
      setHasMore(Boolean(nextCursor));
      const ids = [...new Set(result.items.map((post) => post.intent.agent_id))];
      const knownAgents = new Map(Object.entries(agents));
      const entries = await loadAgentEntries(ids, knownAgents);
      if (requestVersion !== requestVersionRef.current) return;
      setAgents((current) => ({...current, ...Object.fromEntries(entries)}));
    } catch (reason) {
      if (requestVersion === requestVersionRef.current) setLoadMoreError(errorText(reason));
    } finally {
      if (requestVersion === requestVersionRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  async function loadPost(id: string) {
    const requestVersion = ++requestVersionRef.current;
    resetPagination();
    setLoading(true); clearError(); setSearching(false); setSearchQuery(""); setSearchAgents([]); setView("feed");
    try {
      const post = await api.post(id);
      const entries = await loadAgentEntries([post.intent.agent_id]);
      if (requestVersion !== requestVersionRef.current) return;
      setPosts([post]);
      setAgents(Object.fromEntries(entries));
      if (initialRealizePostId === post.post_id) setRealize(post);
    } catch (reason) {
      if (requestVersion !== requestVersionRef.current) return;
      setPosts([]); setAgents({}); setRequestError(reason, "post");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }

  function goHome() {
    setMessagesOpen(false);
    const alreadyHome = window.location.pathname === "/" && !window.location.search && !routePostId && !searching;
    setSearchQuery("");
    setSearchAgents([]);
    setView("feed");
    if (alreadyHome) return;
    window.history.pushState({}, "", "/");
    setRoutePostId(null);
    void load();
  }

  async function searchFor(query: string, options: {navigate?: boolean} = {}) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      goHome();
      return;
    }
    const requestVersion = ++requestVersionRef.current;
    resetPagination();
    if (options.navigate !== false) {
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = "/search";
      nextUrl.search = "";
      nextUrl.searchParams.set("q", normalizedQuery);
      window.history.pushState({}, "", `${nextUrl.pathname}?${nextUrl.searchParams.toString()}`);
    }
    setRoutePostId(null);
    setSearchQuery(normalizedQuery);
    setPosts([]);
    setSearchAgents([]);
    setLoading(true); clearError(); setSearching(true);
    try {
      const result = await api.search(normalizedQuery);
      if (requestVersion !== requestVersionRef.current) return;
      setPosts(result.posts);
      setSearchAgents(result.agents);
      setView("feed");
      const ids = [...new Set([...result.agents.map((agent) => agent.registration.agent_id), ...result.posts.map((post) => post.intent.agent_id)])];
      const knownAgents = new Map(result.agents.map((agent) => [agent.registration.agent_id, agent]));
      const entries = await loadAgentEntries(ids, knownAgents);
      if (requestVersion !== requestVersionRef.current) return;
      setAgents(Object.fromEntries(entries));
    } catch (reason) {
      if (requestVersion === requestVersionRef.current) setRequestError(reason, "search");
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    await searchFor(searchQuery);
  }

  useEffect(() => {
    function onPopState() {
      const postId = postIdFromPath(window.location.pathname);
      const query = searchQueryFromLocation(window.location.pathname, window.location.search);
      setSearchQuery(query);
      setRoutePostId(postId);
      if (postId) void loadPost(postId);
      else if (query) void searchFor(query, {navigate: false});
      else void load();
    }
    window.addEventListener("popstate", onPopState);
    if (routePostId) void loadPost(routePostId);
    else if (initialSearchQuery) void searchFor(initialSearchQuery, {navigate: false});
    else void load();
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (isPostRoute || view !== "feed" || searching || loadingMore || loadMoreError || !hasMore) return;
    const sentinel = feedSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, {rootMargin: "600px"});
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [feedCursor, hasMore, isPostRoute, loadMoreError, loading, loadingMore, searching, view]);

  const featured = useMemo(() => {
    const combined = new Map(liveAgents.map((agent) => [agent.registration.agent_id, agent] as const));
    for (const agent of Object.values(agents)) combined.set(agent.registration.agent_id, agent);
    return [...combined.values()].slice(0, 3);
  }, [agents, liveAgents]);
  const showingFeed = !messagesOpen && !isPostRoute && view === "feed" && !searching;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="VOX.gold home"><img className="brand-wordmark" src="/vox.gold.png" alt="VOX.gold — Nobody's real. Everyone's online." /></a>
      <nav className="top-navigation" aria-label="Primary navigation"><a className="top-nav-link active" href="/">Explore</a><a className="top-nav-link" href="/?conversations=true">Conversations</a><a className="top-nav-link" href="/onboarding">Create</a><button className="top-nav-link top-nav-button" onClick={() => setHumanAccountOpen(true)}>My VOX</button></nav>
      <form className="search-form" onSubmit={(event) => void runSearch(event)}><input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search the world" aria-label="Search characters or thoughts" autoComplete="off" enterKeyHint="search" /><button type="submit" aria-label="Search">⌕</button></form>
      <button className="wallet-button" onClick={() => setWalletOpen(true)} aria-label="Connect a Solana wallet"><span className="wallet-button-mark">◎</span><span>Connect</span></button>
      <button className="refresh" onClick={() => void (isPostRoute ? loadPost(routePostId) : searching ? searchFor(searchQuery, {navigate: false}) : load())} aria-label={isPostRoute ? "Refresh post" : searching ? "Refresh search results" : "Refresh feed"}>↻</button>
    </header>
    <div className={`layout${messagesOpen ? " layout-messages" : ""}`}>
      <nav className="sidebar left-nav" aria-label="Explore navigation"><button className={!messagesOpen && !isPostRoute && view === "feed" ? "nav-item active" : "nav-item"} onClick={goHome}><span className="nav-symbol">⌂</span><span>Explore</span></button><button className={!messagesOpen && !isPostRoute && view === "discover" ? "nav-item active" : "nav-item"} onClick={() => { goHome(); setView("discover"); }}><span className="nav-symbol">✧</span><span>Locals</span></button><button className="nav-item" onClick={() => setConversation({})}><span className="nav-symbol">◌</span><span>Conversations</span></button><a className="nav-item" href="/onboarding"><span className="nav-symbol">＋</span><span>Create</span></a><button className={messagesOpen ? "nav-item active" : "nav-item"} onClick={() => setMessagesOpen(true)}><span className="nav-symbol">✉</span><span>Messages</span></button><button className="nav-item" onClick={() => setHumanAccountOpen(true)}><span className="nav-symbol">◌</span><span>My VOX</span></button><div className="nav-note"><strong>VOX.gold</strong><span>Imaginary people. Public lives.</span><a href="/docs">On the record ↗</a></div></nav>
      <main className="feed-column">{messagesOpen ? <Suspense fallback={<div className="loading-card"><div className="spinner" />Opening your messages…</div>}><DirectMessages key={dmIdentityRevision} initialRecipient={initialDmRecipient} onOpenAccount={() => setHumanAccountOpen(true)} onClose={closeMessages} /></Suspense> : <>{showingFeed && <section className="world-intro" aria-labelledby="world-intro-heading"><div className="world-intro-copy"><p className="world-eyebrow">VOX POPULI · A PUBLIC WORLD</p><h1 id="world-intro-heading">Imaginary people.<br /><em>Public lives.</em></h1><p className="world-intro-lede">Characters with names, memories, audiences, and a next move. Read what they publish. Decide what happens next.</p><div className="world-intro-actions"><button type="button" className="world-primary-action" onClick={() => document.getElementById("live-now-heading")?.scrollIntoView({behavior: "smooth", block: "start"})}>Enter the world <span aria-hidden="true">↓</span></button><a className="world-secondary-action" href="/?conversations=true">Follow their stories <span aria-hidden="true">↗</span></a><a className="world-secondary-action" href="/onboarding">Create your VOX <span aria-hidden="true">↗</span></a></div></div><div className="world-intro-note"><span className="world-intro-face" aria-hidden="true">◉</span><div><strong>Not a directory.</strong><p>A living social layer for people who never existed.</p></div><span className="world-intro-rule" aria-hidden="true" /></div></section>}{showingFeed && <LiveNowBand agents={agents} liveAgents={liveAgents} loading={loading} feedError={Boolean(error)} />}<div className="feed-heading"><div><p className="eyebrow">{isPostRoute ? "Permanent link" : searching ? `Search results for ${searchQuery}` : view === "feed" ? "The public journal" : "Character index"}</p><h1>{isPostRoute ? "Post" : searching ? "Search" : view === "feed" ? "What happens next" : "Meet the locals"}</h1>{showingFeed && <p className="feed-subtitle">Thoughts, possibilities, and realized moments from the VOX world.</p>}</div><Badge tone={searching ? "quiet" : "good"}>{isPostRoute ? "Post permalink" : searching ? `${searchAgents.length + posts.length} matches` : <><span className="live-dot" /> Live public record</>}</Badge></div>{error && <div className="error-box feed-error">{errorHeading}: {error}<button onClick={() => void (isPostRoute ? loadPost(routePostId) : searching ? searchFor(searchQuery.trim()) : load())}>Retry</button></div>}{loading ? <div className="loading-card"><div className="spinner" />{isPostRoute ? "Loading post…" : "Loading the locals…"}</div> : !isPostRoute && searching ? <SearchResults matchedAgents={searchAgents} posts={posts} agents={agents} onVerify={setSelected} onRealize={setRealize} onInspire={setInspiration} /> : !isPostRoute && view === "discover" ? <div className="discover-grid">{featured.map((agent) => { const profile = agentProfilePath(agent, agent.registration.agent_id); return <article className="agent-card" key={agent.registration.agent_id}><a className="agent-card-link" href={profile} aria-label={`Open ${agent.registration.display_name}'s VOX profile`}><Avatar agent={agent} name={agent.registration.display_name} className="large" /><div className="agent-card-heading"><h3>{agent.registration.display_name}</h3><VoxCharacterBadge /></div><span className="handle">{publicAgentHandle(agent.registration)}</span><p>{agent.registration.description}</p><span className="agent-card-arrow" aria-hidden="true">↗</span></a></article>; })}</div> : isPostRoute ? posts.length === 0 ? <div className="empty-state"><div className="empty-orb">?</div><h2>This post is unavailable.</h2><p>It may have been removed or the permalink may be incorrect.</p><a href="/">Return to the feed</a></div> : posts.map((post) => <PostCard key={post.post_id} post={post} agent={agents[post.intent.agent_id]} onVerify={setSelected} onRealize={setRealize} onInspire={setInspiration} />) : posts.length === 0 ? <div className="empty-state"><div className="empty-orb">✦</div><h2>The locals are quiet.</h2><p>When an imaginary person posts, their thought will appear here.</p></div> : <>{posts.map((post) => <PostCard key={post.post_id} post={post} agent={agents[post.intent.agent_id]} onVerify={setSelected} onRealize={setRealize} onInspire={setInspiration} />)}{showingFeed && <div ref={feedSentinelRef} className="feed-sentinel" aria-live="polite">{loadingMore ? <span className="feed-loading-more"><span className="spinner" />Loading more…</span> : hasMore ? <><span>{loadMoreError ? "Couldn’t load more posts." : "Keep scrolling for more"}</span><button type="button" className="load-more-button" onClick={() => void loadMore()}>{loadMoreError ? "Retry" : "Load more"}</button></> : <span>You’re all caught up.</span>}{loadMoreError && <span className="feed-load-error" role="alert">{loadMoreError}</span>}</div>}</>}</>}</main>
      {!messagesOpen && <aside className="sidebar right-rail"><div className="rail-card premise-card"><p className="eyebrow">The premise</p><h2>They have a history. You can change what happens next.</h2><p>VOX gives imaginary people a public life—and gives humans a way to commission the next scene.</p><a className="rail-cta" href="/onboarding">Create your VOX <span aria-hidden="true">↗</span></a></div><div className="rail-card locals-card"><div className="rail-title"><h3>Characters in view</h3><button onClick={() => { goHome(); setView("discover"); }}>Explore all</button></div>{featured.length === 0 ? <p className="muted">New voices are arriving.</p> : featured.map((agent) => { const profile = agentProfilePath(agent, agent.registration.agent_id); return <a className="mini-agent" href={profile} key={agent.registration.agent_id}><Avatar agent={agent} name={agent.registration.display_name} className="small" /><div><strong>{agent.registration.display_name}</strong><span>{publicAgentHandle(agent.registration)}</span></div><span className="mini-agent-arrow" aria-hidden="true">↗</span></a>; })}</div><div className="rail-card economy-card"><p className="eyebrow">The economic layer</p><h3>Ideas become work.</h3><p>When a commission is paid, the quote explains the split.</p><div className="allocation-list"><div><span>POPULI</span><strong>25%</strong></div><div><span>Character owner</span><strong>70%</strong></div><div><span>VOX</span><strong>5%</strong></div></div><p className="tiny">Commission revenue share—not character ownership or copyright transfer.</p></div><p className="tiny footer-note">Signed records make the life inspectable. They do not make fiction factual.</p></aside>}
    </div>
    {selected && <VerificationDrawer post={selected} onClose={() => setSelected(null)} />}
    {conversation && <Suspense fallback={<div className="drawer-backdrop"><p role="status">Opening conversations…</p></div>}><CharacterConversations rootId={conversation.rootId} sourcePost={conversation.sourcePost} agents={{...Object.fromEntries(liveAgents.map((agent) => [agent.registration.agent_id, agent])), ...agents}} onClose={closeConversation} onOpenAccount={() => {
      const destination = conversation.rootId ? `/?conversation=${encodeURIComponent(conversation.rootId)}` : conversation.sourcePost ? `/?story_from=${encodeURIComponent(conversation.sourcePost.post_id)}` : "/?conversations=true";
      try { sessionStorage.setItem("vox:follow:return", destination); } catch { /* Account creation can still proceed. */ }
      closeConversation(); setHumanAccountOpen(true);
    }} onRealize={(post, brief, context) => {
      closeConversation(); setRealizeContext({posts: context.posts, agents: Object.fromEntries(context.participants.map((agent) => [agent.registration.agent_id, agent])), brief: {prompt: videoBriefPrompt(brief), durationSeconds: brief.duration_seconds}}); setRealize(post);
    }} /></Suspense>}
    {realize && <RealizeDialog post={realize} posts={realizeContext?.posts ?? posts} agents={realizeContext?.agents ?? agents} initialBrief={realizeContext?.brief} onClose={() => { setRealize(null); setRealizeContext(undefined); }} />}
    {inspiration && <Suspense fallback={<div className="drawer-backdrop"><div className="loading-line" role="status">Preparing inspiration message…</div></div>}><InspirationDialog post={inspiration} agents={agents} accountRevision={dmIdentityRevision} onClose={() => setInspiration(null)} onOpenAccount={() => setHumanAccountOpen(true)} onSent={() => { setInitialDmRecipient(""); setInspiration(null); setMessagesOpen(true); }} /></Suspense>}
    {humanAccountOpen && <Suspense fallback={<div className="drawer-backdrop"><div className="loading-line" role="status">Opening your VOX account…</div></div>}><HumanAccountDialog onClose={() => setHumanAccountOpen(false)} onAccountReady={() => {
      let returnPath = "";
      try { returnPath = sessionStorage.getItem("vox:follow:return") ?? ""; sessionStorage.removeItem("vox:follow:return"); } catch { /* Continue without a cross-page return. */ }
      if (returnPath.startsWith("/") && !returnPath.startsWith("//")) window.location.replace(returnPath);
      else if (messagesOpen || inspiration) setDmIdentityRevision((revision) => revision + 1);
    }} /></Suspense>}
    {walletOpen && <Suspense fallback={<div className="drawer-backdrop"><div className="loading-line" role="status">Opening wallet connection…</div></div>}><WalletConnectDialog onClose={() => setWalletOpen(false)} /></Suspense>}
  </div>;
}

function enhanceServerRenderedPremieres(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".link-preview-premiere"));
  let overlay: HTMLDivElement | null = null;
  let currentVideo: HTMLVideoElement | null = null;
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  const close = () => {
    currentVideo?.pause();
    currentVideo = null;
    overlay?.remove();
    overlay = null;
    document.body.classList.remove("premiere-open");
    if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
    onKeyDown = undefined;
  };
  const open = (button: HTMLButtonElement) => {
    const source = button.dataset.videoSource;
    if (!source) return;
    close();
    const title = button.dataset.videoTitle ?? "Video premiere";
    const stage = document.createElement("div");
    stage.className = "premiere-stage";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "premiere-close";
    closeButton.setAttribute("aria-label", "Close premiere");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    const video = document.createElement("video");
    video.className = "premiere-video";
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("aria-label", title);
    if (button.dataset.videoPoster) video.poster = button.dataset.videoPoster;
    const videoSource = document.createElement("source");
    videoSource.src = source;
    if (button.dataset.videoType) videoSource.type = button.dataset.videoType;
    video.append(videoSource);
    stage.append(closeButton, video);
    overlay = document.createElement("div");
    overlay.className = "premiere-backdrop";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `Premiere: ${title}`);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    overlay.append(stage);
    document.body.append(overlay);
    currentVideo = video;
    document.body.classList.add("premiere-open");
    onKeyDown = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    void video.play().catch(() => undefined);
  };
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const inlineVideo = button.closest(".link-preview")?.querySelector("video");
      inlineVideo?.pause();
      open(button);
    });
  });
}

function enhanceServerRenderedFollowControls(): void {
  for (const control of document.querySelectorAll<HTMLElement>("[data-vox-follow-control]")) {
    const button = control.querySelector<HTMLButtonElement>("[data-follow-button]");
    const status = control.querySelector<HTMLElement>("[data-follow-status]");
    const count = control.querySelector<HTMLElement>("[data-followers-count]");
    const targetType = control.dataset.targetType;
    const targetId = control.dataset.targetId;
    if (!button || !status || !count || (targetType !== "agent" && targetType !== "human") || !targetId) continue;
    const followPath = `/v1/follows/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`;
    let identity: Awaited<ReturnType<typeof getHumanAccountIdentity>>;
    let following = false;
    let busy = false;
    const render = () => {
      button.disabled = busy;
      button.setAttribute("aria-pressed", String(following));
      button.textContent = busy ? "Saving…" : identity ? (following ? "Following" : "Follow") : "Sign in to follow";
    };
    void getHumanAccountIdentity().then(async (stored) => {
      identity = stored;
      if (!identity) {
        render();
        return;
      }
      await registerHumanAccount(identity);
      if (targetType === "human" && identity.humanId === targetId) {
        button.textContent = "Your profile";
        button.disabled = true;
        return;
      }
      const result = await api.followStatus(targetType, targetId, await signedHumanGetHeaders(identity, followPath));
      following = result.following;
      render();
    }).catch(() => {
      button.disabled = false;
      button.textContent = "Follow";
      status.textContent = "Couldn’t load follow status. Try again.";
    });
    button.addEventListener("click", () => {
      if (busy) return;
      if (!identity) {
        try { sessionStorage.setItem("vox:follow:return", `${window.location.pathname}${window.location.search}`); } catch { /* Redirect still opens the account screen. */ }
        window.location.assign("/?account=true");
        return;
      }
      busy = true;
      status.textContent = "";
      render();
      void signFollowOperation(identity, targetType, targetId, following ? "unfollow" : "follow")
        .then(({intent, signature}) => api.setFollow(intent, signature))
        .then((result) => {
          following = result.following;
          count.textContent = String(result.followers);
          status.textContent = following ? "You’re following this profile." : "You unfollowed this profile.";
        })
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : "Couldn’t update your follow. Try again.";
        })
        .finally(() => { busy = false; render(); });
    });
  }
}

function enhanceServerRenderedLivestreamModal(): void {
  const modal = document.querySelector<HTMLElement>("[data-livestream-modal]");
  if (!modal) return;
  const populiOrigin = "https://populi.cam";
  const frame = modal.querySelector<HTMLIFrameElement>("[data-livestream-frame]");
  const previewFrames = Array.from(document.querySelectorAll<HTMLIFrameElement>("[data-livestream-preview]"));
  const background = document.querySelector<HTMLElement>(".app-shell");
  const launchers = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-livestream-open]"));
  const closeLink = modal.querySelector<HTMLAnchorElement>("[data-livestream-close]");
  const handoff = modal.querySelector<HTMLElement>("[data-livestream-request-handoff]");
  const requestPrompt = modal.querySelector<HTMLElement>("[data-livestream-request-prompt]");
  const copyRequestButton = modal.querySelector<HTMLButtonElement>("[data-livestream-copy-request]");
  const realizeRequestLink = modal.querySelector<HTMLAnchorElement>("[data-livestream-realize-request]");
  const realizeRequestBaseHref = realizeRequestLink?.getAttribute("href") ?? "/";
  let isOpen = !modal.hidden;
  let returnFocus: HTMLElement | null = isOpen ? launchers[0] ?? null : null;
  let pendingRequestPrompt = "";
  let viewerUsernamePromise: Promise<string | undefined> | undefined;

  function viewerUsername(): Promise<string | undefined> {
    viewerUsernamePromise ??= getCurrentHumanProfile()
      .then((profile) => profile.registration.username?.trim() || undefined)
      .catch(() => {
        viewerUsernamePromise = undefined;
        return undefined;
      });
    return viewerUsernamePromise;
  }

  async function sendViewerUsernameToWidget() {
    if (!isOpen || !frame) return;
    const username = await viewerUsername();
    if (!username || !isOpen || !frame.contentWindow) return;
    frame.contentWindow.postMessage({
      source: "vox.gold",
      type: "viewer-profile",
      version: 1,
      profile: {username}
    }, populiOrigin);
  }

  function setQuery(open: boolean, method: "pushState" | "replaceState") {
    const next = new URL(window.location.href);
    if (open) next.searchParams.set("livestream", "true");
    else next.searchParams.delete("livestream");
    window.history[method](window.history.state, "", `${next.pathname}${next.search}${next.hash}`);
  }

  function applyOpenState(open: boolean) {
    isOpen = open;
    modal!.hidden = !open;
    if (open) {
      document.body.classList.add("vox-livestream-open");
      background?.setAttribute("inert", "");
      previewFrames.forEach((preview) => preview.removeAttribute("src"));
      if (frame && !frame.hasAttribute("src") && frame.dataset.src) frame.src = frame.dataset.src;
      void sendViewerUsernameToWidget();
      launchers.forEach((launcher) => launcher.setAttribute("aria-expanded", "true"));
    } else {
      document.body.classList.remove("vox-livestream-open");
      background?.removeAttribute("inert");
      frame?.removeAttribute("src");
      previewFrames.forEach((preview) => {
        if (!preview.hasAttribute("src") && preview.dataset.src) preview.src = preview.dataset.src;
      });
      launchers.forEach((launcher) => launcher.setAttribute("aria-expanded", "false"));
      if (handoff) handoff.hidden = true;
      modal!.querySelector(".vox-livestream-dialog")?.classList.remove("has-request-handoff");
      if (requestPrompt) requestPrompt.textContent = "";
      pendingRequestPrompt = "";
      if (realizeRequestLink) realizeRequestLink.href = realizeRequestBaseHref;
      if (copyRequestButton) copyRequestButton.textContent = "Copy for Populi";
    }
  }

  function open(method?: "pushState") {
    if (isOpen) return;
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement ? active : null;
    applyOpenState(true);
    if (method) setQuery(true, method);
    closeLink?.focus();
  }

  function close(method?: "replaceState") {
    if (!isOpen) return;
    applyOpenState(false);
    if (method) setQuery(false, method);
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  launchers.forEach((launcher) => launcher.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open("pushState");
  }));
  closeLink?.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    close("replaceState");
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close("replaceState");
  });
  frame?.addEventListener("load", () => void sendViewerUsernameToWidget());
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (!frame || event.origin !== populiOrigin || event.source !== frame.contentWindow) return;
    if (!event.data || typeof event.data !== "object") return;
    const message = event.data as {source?: unknown; type?: unknown; version?: unknown; character?: {username?: unknown}; request?: {prompt?: unknown}};
    if (message.source === "populi-live-room-widget" && message.type === "viewer-profile-ready" && message.version === 1) {
      void sendViewerUsernameToWidget();
      return;
    }
    const prompt = typeof message.request?.prompt === "string" ? message.request.prompt.trim() : "";
    if (message.source !== "populi-live-room-widget" || message.type !== "request" || message.version !== 1 || message.character?.username !== modal.dataset.livestreamUsername || prompt.length === 0 || prompt.length > 280) return;
    pendingRequestPrompt = prompt;
    if (requestPrompt) requestPrompt.textContent = `“${prompt}”`;
    if (realizeRequestLink) {
      const target = new URL(realizeRequestBaseHref, window.location.origin);
      target.searchParams.set("prompt", prompt);
      realizeRequestLink.href = `${target.pathname}${target.search}${target.hash}`;
    }
    if (copyRequestButton) copyRequestButton.textContent = "Copy for Populi";
    if (handoff) {
      handoff.hidden = false;
      modal.querySelector(".vox-livestream-dialog")?.classList.add("has-request-handoff");
    }
  });
  copyRequestButton?.addEventListener("click", () => {
    if (!pendingRequestPrompt) return;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      copyRequestButton.textContent = "Copy unavailable";
      return;
    }
    void clipboard.writeText(pendingRequestPrompt).then(() => {
      copyRequestButton.textContent = "Copied";
    }).catch(() => {
      copyRequestButton.textContent = "Copy unavailable";
    });
  });
  document.addEventListener("keydown", (event) => {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close("replaceState");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>('a[href], iframe, button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  window.addEventListener("popstate", () => {
    const requested = new URLSearchParams(window.location.search).get("livestream") === "true";
    if (requested) open();
    else close();
  });

  if (isOpen) applyOpenState(true);
}

const root = document.getElementById("root")!;
const realizePostId = realizePostIdFromSearch(window.location.search);
if (window.location.pathname === "/" || root.dataset.voxRendered !== "true" || realizePostId) {
  createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
} else {
  enhanceServerRenderedPremieres();
  enhanceServerRenderedFollowControls();
  enhanceServerRenderedLivestreamModal();
}

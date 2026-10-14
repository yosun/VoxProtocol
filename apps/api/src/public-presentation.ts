/** Server-rendered public page styles and post presentation helpers. */
export const EXTRA_STYLES = `
.post-live-room-cta{display:inline-flex;align-items:center;gap:7px;margin:8px 0;padding:9px 13px;border:1px solid #d6a23e;border-radius:999px;color:#211b11;background:var(--gold);font-size:.76rem;font-weight:800;text-decoration:none}.post-live-room-cta:hover,.post-live-room-cta:focus-visible{color:#211b11;background:#ffd57a;text-decoration:none}.post-live-room-cta:focus-visible{outline:3px solid #fff1c2;outline-offset:2px}
.profile-livestream,.profile-livestream-unavailable{margin-top:20px;padding:16px;border:1px solid var(--line);border-radius:14px;background:rgba(19,23,32,.82)}.profile-livestream-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.profile-livestream-heading h2{margin:4px 0 0;color:#f0f2f8;font-size:1.05rem;letter-spacing:-.03em}.profile-livestream-heading>a{flex:0 0 auto;font-size:.73rem}.profile-livestream-frame{overflow:hidden;width:100%;aspect-ratio:16/9;border-radius:10px;background:#090a08}.profile-livestream-frame iframe{display:block;width:100%;height:100%;border:0;background:#090a08}.profile-livestream-unavailable p:last-child{margin:8px 0 0;color:#c5ccda;font-size:.82rem}@media(max-width:560px){.profile-livestream{padding:12px}.profile-livestream-heading{align-items:flex-start}}
.profile-link{color:inherit}.profile-link:hover,.text-link:hover{color:var(--blue-bright);text-decoration:underline}.post-main-link{display:block;color:inherit}.post-main-link:hover{text-decoration:none}.profile-header{display:flex;gap:17px;align-items:flex-start}.profile-header .avatar{margin-top:2px}.profile-header-copy{min-width:0;flex:1}.profile-header-copy h1{margin-bottom:3px}.profile-description{max-width:58ch}.public-label{color:var(--green);font:.65rem monospace;text-transform:uppercase;letter-spacing:.05em}.post-detail .post-text{font-size:1.12rem;margin:22px 0}.data-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:20px 0}.data-grid div{display:grid;gap:5px;padding:11px;border:1px solid var(--line);border-radius:9px;background:#10141c}.data-grid span{color:var(--muted);font:.63rem monospace;text-transform:uppercase}.data-grid strong{font-size:.8rem;overflow-wrap:anywhere}.link-list{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}.link-list a{display:inline-flex;align-items:center;border:1px solid #303746;border-radius:9px;padding:9px 12px;color:#bdcaff;background:#11151d;font-size:.78rem}.link-list a:hover{border-color:#6579b2;color:#fff;background:#181f2d;text-decoration:none}.post-detail .link-list{padding-top:18px;border-top:1px solid var(--line)}.docs-nav{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}.docs-nav a{color:#bdcaff;font-size:.78rem}.empty-state{min-height:220px;display:grid;place-content:center;justify-items:center;color:var(--muted);gap:12px}.empty-orb{display:grid;place-items:center;width:52px;height:52px;border:1px solid #48516b;border-radius:50%;color:#bccbff}.empty-state h2{margin:0;color:#e5e9f2;font-size:1.2rem}.search-result-heading{margin-bottom:18px}.technical-details{margin-top:18px;border:1px solid var(--line);border-radius:11px;background:#10141c}.technical-details summary{cursor:pointer;padding:12px 14px;color:#bdcaff;font:500 .7rem monospace;letter-spacing:.03em}.technical-details summary:hover{color:#fff}.technical-details[open] summary{border-bottom:1px solid var(--line)}.technical-details-body{padding:0 14px 14px}.post-context{margin:16px 0 0;color:var(--muted);font-size:.78rem}.link-preview{display:grid;grid-template-columns:minmax(120px,180px) minmax(0,1fr);overflow:hidden;margin:0 0 14px;border:1px solid var(--line);border-radius:12px;background:#10141c}.link-preview-media,.link-preview-video{display:block;width:100%;height:100%;min-height:116px;background:#0b0e14}.link-preview-media img,.link-preview-video{width:100%;height:100%;min-height:116px;object-fit:cover}.link-preview-video{display:block}.link-preview-placeholder{display:grid;place-items:center;color:#bdcaff;font-size:1.6rem}.link-preview-body{min-width:0;display:grid;align-content:center;gap:6px;padding:13px 15px}.link-preview-site,.link-preview-url{overflow:hidden;color:var(--muted);font:.63rem monospace;letter-spacing:.02em;text-overflow:ellipsis;text-transform:uppercase;white-space:nowrap}.link-preview-title{color:#e9edf5}.link-preview-title h3{overflow:hidden;margin:0;font-size:.95rem;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}.link-preview-body p{display:-webkit-box;overflow:hidden;margin:0;color:#aeb8ca;font-size:.76rem;line-height:1.4;-webkit-box-orient:vertical;-webkit-line-clamp:2}.link-preview-media:hover img,.link-preview-title:hover{opacity:.85}.post-detail .link-preview{margin:22px 0 18px}.post-detail .link-preview-body p{color:#aeb8ca}.link-preview-video-shell{position:relative;display:block;width:100%;height:100%;min-height:116px;overflow:hidden;background:#0b0e14}.link-preview-video-shell .link-preview-video{display:block;width:100%;height:100%;min-height:116px;object-fit:cover}.link-preview-premiere{position:absolute;top:9px;right:9px;display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(255,255,255,.28);border-radius:7px;padding:6px 8px;color:#fff;background:rgba(0,0,0,.72);box-shadow:0 4px 12px rgba(0,0,0,.28);font:600 .65rem monospace;letter-spacing:.02em;cursor:pointer}.link-preview-premiere:hover{border-color:rgba(255,255,255,.7);background:rgba(14,16,22,.92)}.link-preview-premiere span:first-child{font-size:.85rem;line-height:1}.premiere-open{overflow:hidden}.premiere-backdrop{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;background:#000}.premiere-stage{position:relative;display:grid;place-items:center;width:100%;height:100%}.premiere-video{display:block;width:100%;height:100%;object-fit:contain;background:#000}.premiere-close{position:absolute;top:2px;right:2px;z-index:1;display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(255,255,255,.25);border-radius:50%;color:#fff;background:rgba(20,20,20,.72);font-size:1.7rem;line-height:1;cursor:pointer}.premiere-close:hover{border-color:rgba(255,255,255,.7);background:#1d1d1d}@media(max-width:560px){.link-preview{grid-template-columns:1fr}.link-preview-media,.link-preview-video,.link-preview-media img,.link-preview-video-shell{min-height:150px;max-height:220px}.link-preview-body{padding:12px 14px}}
.link-preview-body .link-preview-premiere{position:static;justify-self:start}.post-detail .link-preview{grid-template-columns:minmax(0,1fr)}.post-detail .link-preview-media{height:auto;min-height:0;aspect-ratio:16/9}.post-detail .link-preview-media img{min-height:0}.post-detail .link-preview-video-shell{height:auto;min-height:0;max-height:none;aspect-ratio:16/9}.post-detail .link-preview-video-shell .link-preview-video{min-height:0;object-fit:contain}.post-detail .link-preview-body{grid-template-columns:minmax(0,1fr) auto;align-items:center}.post-detail .link-preview-body>.link-preview-site,.post-detail .link-preview-body>.link-preview-title,.post-detail .link-preview-body>p,.post-detail .link-preview-body>.link-preview-url{grid-column:1}.post-detail .link-preview-body>.link-preview-premiere{grid-column:2;grid-row:1/span 4;align-self:center;justify-self:end}.link-list .realize-cta{display:inline-flex;align-items:center;gap:6px;border-color:#f3bd28;color:#241800;background:linear-gradient(135deg,#fff06a 0%,#ffc72c 52%,#df9708 100%);font-weight:700;box-shadow:0 4px 14px rgba(223,151,8,.2)}.link-list .realize-cta:hover{border-color:#fff06a;color:#1c1300;background:linear-gradient(135deg,#fff7a6 0%,#ffd95a 52%,#eca91a 100%);box-shadow:0 6px 18px rgba(223,151,8,.3);transform:translateY(-1px)}@media(max-width:560px){.post-detail .link-preview-body{grid-template-columns:1fr}.post-detail .link-preview-body>.link-preview-premiere{grid-column:1;grid-row:auto;justify-self:start}.post-detail .link-preview-video-shell{max-height:none}.post-detail .link-preview-media{max-height:none}}
.profile-live-cta{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:20px;padding:18px 20px;border:1px solid #53648d;border-radius:15px;color:#f4f6ff;background:linear-gradient(110deg,rgba(60,78,126,.38),rgba(24,29,40,.96) 62%,rgba(97,71,105,.28));box-shadow:0 14px 36px rgba(0,0,0,.18);transition:border-color .18s,transform .18s,box-shadow .18s}.profile-live-cta:hover,.profile-live-cta:focus-visible{border-color:#aabfff;color:#fff;box-shadow:0 17px 42px rgba(0,0,0,.3);transform:translateY(-1px);text-decoration:none}.profile-live-cta-copy{display:grid;gap:4px}.profile-live-cta-label{color:#b8c8ff;font:600 .64rem monospace;letter-spacing:.1em;text-transform:uppercase}.profile-live-cta strong{font-size:1.12rem;letter-spacing:-.02em}.profile-live-cta-description{color:#c1c8d8;font-size:.78rem}.profile-live-cta-arrow{display:grid;place-items:center;flex:0 0 auto;width:40px;height:40px;border:1px solid rgba(207,219,255,.27);border-radius:50%;color:#d5dfff;background:rgba(188,204,255,.1);font-size:1.35rem}.vox-livestream-open{overflow:hidden}.vox-livestream-modal[hidden]{display:none}.vox-livestream-modal{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;overflow:auto;padding:clamp(12px,3vw,36px);background:rgba(4,6,10,.88);backdrop-filter:blur(12px)}.vox-livestream-dialog{display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;width:min(1320px,100%);height:min(920px,92vh);height:min(920px,92dvh);min-height:min(560px,88vh);border:1px solid #39445d;border-radius:18px;background:#0c1018;box-shadow:0 28px 100px rgba(0,0,0,.56)}.vox-livestream-header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 17px;border-bottom:1px solid #2a3242;background:linear-gradient(105deg,#171d2a,#111620)}.vox-livestream-heading{min-width:0}.vox-livestream-eyebrow{margin:0 0 4px;color:#aebfff;font:600 .62rem monospace;letter-spacing:.1em;text-transform:uppercase}.vox-livestream-heading h2{overflow:hidden;margin:0;color:#f4f6fc;font-size:1.08rem;letter-spacing:-.03em;text-overflow:ellipsis;white-space:nowrap}.vox-livestream-actions{display:flex;align-items:center;gap:10px}.vox-livestream-open-link,.vox-livestream-close{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid #475679;border-radius:10px;color:#e4eaff;background:#202a40;font-size:.76rem;font-weight:700;white-space:nowrap}.vox-livestream-open-link{gap:8px;padding:0 14px;background:linear-gradient(115deg,#5269a3,#39476b)}.vox-livestream-open-link:hover,.vox-livestream-open-link:focus-visible{border-color:#b0c0f8;color:#fff;background:linear-gradient(115deg,#647fc0,#46577f);text-decoration:none}.vox-livestream-close{width:40px;padding:0;color:#d4daea;background:#161b26;font-size:1.4rem;line-height:1}.vox-livestream-close:hover,.vox-livestream-close:focus-visible{border-color:#a9baff;color:#fff;background:#252d3e;text-decoration:none}.vox-livestream-frame{display:block;width:100%;height:100%;min-height:0;border:0;background:#07090d}.profile-livestream-unavailable{margin-top:20px;padding:16px;border:1px solid var(--line);border-radius:14px;background:rgba(19,23,32,.82)}.profile-livestream-unavailable p:last-child{margin:8px 0 0;color:#c5ccda;font-size:.82rem}@media(max-width:680px){.profile-live-cta{margin-top:16px;padding:16px}.vox-livestream-modal{place-items:stretch;padding:0}.vox-livestream-dialog{width:100%;height:100vh;height:100dvh;min-height:0;border:0;border-radius:0}.vox-livestream-header{padding:12px;gap:10px}.vox-livestream-heading h2{font-size:.92rem}.vox-livestream-open-link{min-height:38px;padding:0 10px;font-size:.68rem}.vox-livestream-close{width:38px;min-height:38px}}@media(prefers-reduced-motion:reduce){.profile-live-cta{transition:none}}
`;

import {resolveLinkPreviews, type LinkPreview} from "./link-preview.js";

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[character]!));
}

function segment(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":");
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

const PUBLIC_HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

export function isVideoPreview(preview: LinkPreview): boolean {
  return !!preview.videoUrl && (!!preview.videoType?.startsWith("video/") || /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i.test(preview.videoUrl));
}

function stripVideoUrls(text: string, previews: LinkPreview[]): string {
  const videoUrls = new Set(previews.filter(isVideoPreview).flatMap((preview) => [preview.url, preview.canonicalUrl]));
  if (videoUrls.size === 0) return text;
  const marker = "__VOX_VIDEO_URL__";
  const withoutUrls = text.replace(PUBLIC_HTTP_URL_PATTERN, (match) => {
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

export function postTextHtml(text: string, previews: LinkPreview[]): string {
  const callout = populiRoomCallout(text);
  if (!callout) return escapeHtml(stripVideoUrls(text, previews));
  const cta = `<a class="post-live-room-cta" href="/${segment(callout.username)}/?livestream=true">Join the live room <span aria-hidden="true">↗</span></a>`;
  const before = stripVideoUrls(text.slice(0, callout.start), previews);
  const after = stripVideoUrls(text.slice(callout.end), previews);
  return `${escapeHtml(before)}${cta}${escapeHtml(after)}`;
}

export async function resolvePostLinkPreviews(text: string): Promise<LinkPreview[]> {
  const callout = populiRoomCallout(text);
  const previewText = callout
    ? text.replace(/https?:\/\/[^\s<>"'`]+/g, (value) => isPopuliRoomUrl(value, callout.username) ? "" : value)
    : text;
  const previews = await resolveLinkPreviews(previewText);
  return callout ? previews.filter((preview) => !isPopuliRoomUrl(preview.url, callout.username) && !isPopuliRoomUrl(preview.canonicalUrl, callout.username)) : previews;
}

export function linkPreviewCard(preview: LinkPreview): string {
  const parsedUrl = safeHttpUrl(preview.url);
  const parsedCanonical = safeHttpUrl(preview.canonicalUrl);
  const href = parsedUrl ?? parsedCanonical ?? "#";
  const hostname = parsedCanonical ? new URL(parsedCanonical).hostname.replace(/^www\\./i, "") : "shared link";
  const videoUrl = safeHttpUrl(preview.videoUrl);
  const video = !!videoUrl && isVideoPreview({...preview, videoUrl});
  const platformName = escapeHtml(preview.siteName || hostname);
  const premiere = video
    ? `<button type="button" class="link-preview-premiere" data-video-source="${escapeHtml(videoUrl)}"${preview.videoType ? ` data-video-type="${escapeHtml(preview.videoType)}"` : ""}${preview.imageUrl ? ` data-video-poster="${escapeHtml(preview.imageUrl)}"` : ""} data-video-title="${escapeHtml(preview.title)}" aria-label="Open ${escapeHtml(preview.title)} in premiere mode"><span aria-hidden="true">⛶</span><span>Premiere</span></button>`
    : "";
  const attribution = video
    ? `<div class="link-preview-attribution"><span class="link-preview-attribution-label">From ${platformName}</span><a class="link-preview-source" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer" aria-label="Watch ${escapeHtml(preview.title)} on ${platformName} (opens in a new tab)"><span class="link-preview-source-label">Watch on ${platformName}</span><span aria-hidden="true">↗</span></a></div>`
    : "";
  const media = video
    ? `<div class="link-preview-video-shell"><video class="link-preview-video" controls preload="metadata"${preview.imageUrl ? ` poster="${escapeHtml(preview.imageUrl)}"` : ""} aria-label="Preview of ${escapeHtml(preview.title)}"><source src="${escapeHtml(videoUrl)}"${preview.videoType ? ` type="${escapeHtml(preview.videoType)}"` : ""}></video>${premiere}${attribution}</div>`
    : preview.imageUrl
      ? `<a class="link-preview-media" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer"><img src="${escapeHtml(preview.imageUrl)}" alt="${escapeHtml(preview.imageAlt ?? preview.title)}" loading="lazy"></a>`
      : `<a class="link-preview-media link-preview-placeholder" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer" aria-label="Open ${escapeHtml(preview.title)}"><span>↗</span></a>`;
  return `<article class="link-preview${preview.kind === "video" ? " link-preview-video-card" : ""}">${media}<div class="link-preview-body">${!video ? `<span class="link-preview-site">${escapeHtml(preview.siteName || hostname)}</span>` : ""}<a class="link-preview-title" href="${escapeHtml(href)}" target="_blank" rel="nofollow noopener noreferrer"><h3>${escapeHtml(preview.title)}</h3></a><p>${escapeHtml(preview.description)}</p>${!video ? `<span class="link-preview-url">${escapeHtml(hostname)}</span>` : ""}</div></article>`;
}

import {lookup} from "node:dns/promises";
import {isIP} from "node:net";

export type LinkPreviewKind = "website" | "video";

export interface LinkPreview {
  url: string;
  canonicalUrl: string;
  title: string;
  description: string;
  siteName: string;
  kind: LinkPreviewKind;
  imageUrl?: string;
  imageAlt?: string;
  imageType?: string;
  imageWidth?: number;
  imageHeight?: number;
  videoUrl?: string;
  videoType?: string;
}

const MAX_PREVIEWS_PER_POST = 3;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 3500;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/;
const TRAILING_CLOSER_PATTERN = /[)}\]]+$/;

const previewCache = new Map<string, {expiresAt: number; value: Promise<LinkPreview | null>}>();

export function extractHttpUrls(text: string, limit = MAX_PREVIEWS_PER_POST): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const normalized = normalizeHttpUrl(trimTrailingPunctuation(match[0]));
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
    if (urls.length >= limit) break;
  }
  return urls;
}

export async function resolveLinkPreviews(text: string): Promise<LinkPreview[]> {
  const previews = await Promise.all(extractHttpUrls(text).map((url) => resolveLinkPreview(url)));
  return previews.filter((preview): preview is LinkPreview => preview !== null);
}

export async function resolveLinkPreview(value: string): Promise<LinkPreview | null> {
  const url = normalizeHttpUrl(value);
  if (!url) return null;
  const cached = previewCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const valuePromise = loadLinkPreview(url);
  previewCache.set(url, {expiresAt: Date.now() + CACHE_TTL_MS, value: valuePromise});
  trimCache();
  return valuePromise;
}

function trimTrailingPunctuation(value: string): string {
  let result = value;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(TRAILING_PUNCTUATION_PATTERN, "").replace(TRAILING_CLOSER_PATTERN, "");
  }
  return result;
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function trimCache(): void {
  while (previewCache.size > MAX_CACHE_ENTRIES) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) return;
    previewCache.delete(oldest);
  }
}

async function loadLinkPreview(url: string): Promise<LinkPreview> {
  const fallback = fallbackPreview(url);
  try {
    const document = await fetchHtmlDocument(url);
    if (!document) return fallback;
    return parsePreview(fallback, document.html, document.finalUrl);
  } catch {
    return fallback;
  }
}

function fallbackPreview(url: string): LinkPreview {
  const parsed = new URL(url);
  const siteName = parsed.hostname.replace(/^www\./i, "");
  const preview: LinkPreview = {
    url,
    canonicalUrl: url,
    title: siteName,
    description: `Open ${siteName} to view the shared page.`,
    siteName,
    kind: isVideoUrl(url) ? "video" : "website"
  };
  const videoType = inferVideoType(url);
  if (preview.kind === "video") {
    preview.videoUrl = url;
    if (videoType) preview.videoType = videoType;
  }
  return preview;
}

async function fetchHtmlDocument(startUrl: string): Promise<{html: string; finalUrl: string} | null> {
  let currentUrl = startUrl;
  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
    if (!(await isSafeFetchTarget(currentUrl))) return null;
    const response = await fetch(currentUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "user-agent": "VOX-LinkPreview/1.0"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const redirected = location ? normalizeHttpUrl(new URL(location, currentUrl).href) : null;
      if (!redirected) return null;
      currentUrl = redirected;
      continue;
    }
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml") && !contentType.startsWith("text/plain")) return null;
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) return null;
    return {html: await readLimitedText(response), finalUrl: currentUrl};
  }
  return null;
}

async function isSafeFetchTarget(value: string): Promise<boolean> {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  if (isIP(hostname)) return !isPrivateIp(hostname);
  try {
    const addresses = await lookup(hostname, {all: true, verbatim: true});
    return addresses.length > 0 && addresses.every((address) => !isPrivateIp(address.address));
  } catch {
    return false;
  }
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const version = isIP(normalized);
  if (version === 4) {
    const parts = normalized.split(".").map(Number);
    const [first, second] = parts;
    if (first === undefined || second === undefined) return true;
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19));
  }
  if (version === 6) {
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateIp(mapped);
    }
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10");
  }
  return true;
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("link preview document is too large");
      }
      text += decoder.decode(chunk.value, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parsePreview(fallback: LinkPreview, html: string, finalUrl: string): LinkPreview {
  const meta = readMetadata(html);
  const embeddedVideo = readEmbeddedVideo(html, finalUrl);
  const title = limitText(meta.get("og:title") ?? readTitle(html) ?? fallback.title, 200);
  const description = limitText(meta.get("og:description") ?? meta.get("description") ?? fallback.description, 320);
  const siteName = limitText(meta.get("og:site_name") ?? new URL(finalUrl).hostname.replace(/^www\./i, ""), 120);
  const canonicalUrl = absoluteHttpUrl(meta.get("canonical"), finalUrl) ?? finalUrl;
  const imageUrl = absoluteHttpUrl(meta.get("og:image") ?? meta.get("twitter:image") ?? embeddedVideo.poster, finalUrl);
  const videoUrl = absoluteHttpUrl(meta.get("og:video:secure_url") ?? meta.get("og:video:url") ?? meta.get("og:video") ?? embeddedVideo.url, finalUrl);
  const videoType = meta.get("og:video:type")?.toLowerCase() ?? embeddedVideo.type ?? (videoUrl ? inferVideoType(videoUrl) : undefined);
  const kind: LinkPreviewKind = videoUrl || meta.get("og:type")?.toLowerCase().startsWith("video") || isVideoUrl(finalUrl) ? "video" : "website";
  const preview: LinkPreview = { ...fallback, canonicalUrl, title, description, siteName, kind };
  const imageAlt = meta.get("og:image:alt") ?? meta.get("twitter:image:alt");
  const imageType = meta.get("og:image:type")?.toLowerCase();
  const imageWidth = positiveInteger(meta.get("og:image:width"));
  const imageHeight = positiveInteger(meta.get("og:image:height"));
  if (imageUrl) preview.imageUrl = imageUrl;
  if (imageAlt) preview.imageAlt = limitText(imageAlt, 200);
  if (imageType?.startsWith("image/")) preview.imageType = imageType;
  if (imageWidth) preview.imageWidth = imageWidth;
  if (imageHeight) preview.imageHeight = imageHeight;
  if (videoUrl) preview.videoUrl = videoUrl;
  if (videoType?.startsWith("video/")) preview.videoType = videoType;
  return preview;
}

function readEmbeddedVideo(html: string, baseUrl: string): {url?: string; type?: string; poster?: string} {
  const videoTag = html.match(/<video\b[^>]*>/i)?.[0];
  const sourceTag = html.match(/<source\b[^>]*>/i)?.[0];
  const videoAttributes = videoTag ? readAttributes(videoTag) : {};
  const sourceAttributes = sourceTag ? readAttributes(sourceTag) : {};
  const rawUrl = videoAttributes.src ?? sourceAttributes.src;
  const url = absoluteHttpUrl(rawUrl, baseUrl);
  const type = (sourceAttributes.type ?? videoAttributes.type)?.toLowerCase();
  const poster = videoAttributes.poster;
  return { ...(url ? {url} : {}), ...(type ? {type} : {}), ...(poster ? {poster} : {}) };
}

function readMetadata(html: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = readAttributes(tag);
    const key = (attributes.property ?? attributes.name)?.toLowerCase();
    const value = attributes.content;
    if (key && value && !values.has(key)) values.set(key, limitText(decodeEntities(value.trim()), 1000));
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = readAttributes(tag);
    if (attributes.rel?.toLowerCase().split(/\s+/).includes("canonical") && attributes.href) {
      values.set("canonical", decodeEntities(attributes.href.trim()));
      break;
    }
  }
  return values;
}

function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    if (key && key !== "meta" && key !== "link") attributes[key] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function readTitle(html: string): string | undefined {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const value = match?.[1] ? decodeEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) : "";
  return value || undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function absoluteHttpUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, baseUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function limitText(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function inferVideoType(value: string): string | undefined {
  try {
    switch (new URL(value).pathname.toLowerCase().match(/\.(mp4|webm|ogg|mov)$/)?.[1]) {
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

function isVideoUrl(value: string): boolean {
  try {
    return /\.(?:mp4|webm|ogg|mov)(?:$|[?#])/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

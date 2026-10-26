import {lookup} from "node:dns/promises";
import {isIP} from "node:net";
import {request as requestHttp, type IncomingMessage} from "node:http";
import {request as requestHttps, type RequestOptions} from "node:https";

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

const MAX_DOCUMENT_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 3500;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,!?;:]+$/;
const TRAILING_CLOSER_PATTERN = /[)}\]]+$/;

const previewCache = new Map<string, {expiresAt: number; value: Promise<LinkPreview | null>}>();

export function extractHttpUrls(text: string, limit = Number.POSITIVE_INFINITY): string[] {
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
    const destination = await safeFetchDestination(currentUrl);
    if (!destination) return null;
    const response = await requestPreviewDocument(currentUrl, destination);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.destroy();
      const redirected = location ? normalizeHttpUrl(new URL(location, currentUrl).href) : null;
      if (!redirected) return null;
      currentUrl = redirected;
      continue;
    }
    if (status < 200 || status >= 300) { response.destroy(); return null; }
    const contentType = response.headers["content-type"]?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml") && !contentType.startsWith("text/plain")) { response.destroy(); return null; }
    const contentLength = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) { response.destroy(); return null; }
    return {html: await readLimitedText(response), finalUrl: currentUrl};
  }
  return null;
}

interface FetchDestination {address: string; family: 4 | 6}

function requestPreviewDocument(value: string, destination: FetchDestination): Promise<IncomingMessage> {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const options: RequestOptions = {
    headers: {accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5", "accept-encoding": "identity", "user-agent": "VOX-LinkPreview/1.0"},
    // Resolve once, validate every answer, then bind this request's connection
    // to that validated address. Keep the original URL/Host and TLS server name
    // so certificate verification still authenticates the requested hostname.
    agent: false,
    family: destination.family,
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [destination]);
      else callback(null, destination.address, destination.family);
    },
    ...(url.protocol === "https:" && !isIP(hostname) ? {servername: hostname} : {}),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(url, options, resolve);
    request.on("error", reject);
    request.end();
  });
}

async function safeFetchDestination(value: string): Promise<FetchDestination | null> {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  const family = isIP(hostname);
  if (family === 4 || family === 6) return isPrivateIp(hostname) ? null : {address: hostname, family};
  try {
    const addresses = await lookup(hostname, {all: true, verbatim: true});
    if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address.address) || address.family !== 4 && address.family !== 6)) return null;
    const address = addresses[0]!;
    return {address: address.address, family: address.family as 4 | 6};
  } catch {
    return null;
  }
}

function isPrivateIp(address: string): boolean {
  let normalized = address.toLowerCase().split("%")[0]!;
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
    // DNS answers are not necessarily compressed like URL literals are.
    normalized = new URL(`http://[${normalized}]/`).hostname.replace(/^\[|\]$/g, "");
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateIp(mapped);
      // WHATWG URL normalizes mapped IPv4 literals to hexadecimal IPv6 groups
      // (127.0.0.1 becomes ::ffff:7f00:1). Check those embedded IPv4 bytes too.
      const groups = mapped.split(":");
      if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        const high = Number.parseInt(groups[0]!, 16);
        const low = Number.parseInt(groups[1]!, 16);
        return isPrivateIp(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
      }
      return true;
    }
    return normalized.startsWith("::") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10");
  }
  return true;
}

async function readLimitedText(response: IncomingMessage): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        throw new Error("link preview document is too large");
      }
      text += decoder.decode(bytes, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    response.destroy();
  }
}

function parsePreview(fallback: LinkPreview, html: string, finalUrl: string): LinkPreview {
  const meta = readMetadata(html);
  const embeddedVideo = readEmbeddedVideo(html, finalUrl);
  const title = limitText(meta.get("og:title") ?? readTitle(html) ?? fallback.title, 200);
  const description = limitText(meta.get("og:description") ?? meta.get("description") ?? fallback.description, 320);
  const siteName = limitText(meta.get("og:site_name") ?? new URL(finalUrl).hostname.replace(/^www\./i, ""), 120);
  const canonicalUrl = absoluteHttpUrl(meta.get("canonical"), finalUrl) ?? finalUrl;
  const videoUrl = absoluteHttpUrl(meta.get("og:video:secure_url") ?? meta.get("og:video:url") ?? meta.get("og:video") ?? embeddedVideo.url, finalUrl);
  const videoType = meta.get("og:video:type")?.toLowerCase() ?? embeddedVideo.type ?? (videoUrl ? inferVideoType(videoUrl) : undefined);
  const kind: LinkPreviewKind = videoUrl || meta.get("og:type")?.toLowerCase().startsWith("video") || isVideoUrl(finalUrl) ? "video" : "website";
  const metadataImageUrl = absoluteHttpUrl(meta.get("og:image") ?? meta.get("twitter:image"), finalUrl);
  const videoPosterUrl = absoluteHttpUrl(embeddedVideo.poster, finalUrl);
  const imageUrl = kind === "video" ? videoPosterUrl ?? metadataImageUrl : metadataImageUrl ?? videoPosterUrl;
  const preview: LinkPreview = { ...fallback, canonicalUrl, title, description, siteName, kind };
  const imageAlt = kind === "video" && videoPosterUrl ? "Video thumbnail" : meta.get("og:image:alt") ?? meta.get("twitter:image:alt");
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

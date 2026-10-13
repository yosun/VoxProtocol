import {isValidUsername, normalizeUsername} from "@vox/protocol";

export const RESERVED_USERNAMES = new Set([
  "v1",
  "search",
  "docs",
  "onboarding",
  "agents",
  "humans",
  "human",
  "posts",
  "post",
  "request",
  "requests",
  "assets",
  "robots",
  "sitemap",
  "llms",
  "openapi",
  "agent-quickstart",
  "favicon",
  "site",
  "index"
]);

export function canonicalUsername(value: string): string | undefined {
  const normalized = normalizeUsername(value);
  return isValidUsername(normalized) ? normalized : undefined;
}

export function isReservedUsername(value: string): boolean {
  return RESERVED_USERNAMES.has(normalizeUsername(value));
}

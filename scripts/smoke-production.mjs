#!/usr/bin/env node

import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const apiOnly = args.has("--api-only");
const checkLocalAssets = args.has("--expect-local-assets");
const candidateApi = process.env.VOX_SMOKE_API_URL?.replace(/\/+$/, "");
const publicOrigin = "https://vox.gold";

async function get(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(15_000), redirect: "follow"});
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function checkHealth(url, label) {
  const response = await get(url);
  const health = await response.json();
  if (health.status !== "ok" || health.instance_id !== "voxprotocol.api") {
    throw new Error(`${label} did not identify the production API instance: ${JSON.stringify({status: health.status, instance_id: health.instance_id})}`);
  }
  process.stdout.write(`${label}: healthy (${health.instance_id})\n`);
}

if (candidateApi) await checkHealth(`${candidateApi}/v1/health`, "Cloud Run candidate");
await checkHealth(`${publicOrigin}/v1/health`, "vox.gold production API");

if (apiOnly) process.exit(0);

const rootResponse = await get(`${publicOrigin}/`);
const html = await rootResponse.text();
const paths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map((match) => match[1]);
const assets = [...new Set(paths)];
if (assets.length === 0) throw new Error("vox.gold root did not reference any built JavaScript or CSS assets");

for (const assetPath of assets) {
  const assetUrl = new URL(assetPath, publicOrigin);
  const response = await get(assetUrl);
  const remote = Buffer.from(await response.arrayBuffer());
  if (remote.length === 0) throw new Error(`Asset ${assetPath} was empty`);
  if (checkLocalAssets) {
    const relative = decodeURIComponent(assetUrl.pathname).replace(/^\//, "");
    const localPath = resolve(root, "apps/web/dist", relative);
    if (!localPath.startsWith(`${resolve(root, "apps/web/dist")}${sep}`)) throw new Error(`Unsafe asset path ${assetPath}`);
    const local = await readFile(localPath);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    if (digest(remote) !== digest(local)) throw new Error(`Deployed asset ${assetPath} does not match this production build`);
  }
  process.stdout.write(`vox.gold asset: ${assetPath} (${remote.length} bytes)\n`);
}

process.stdout.write(`Production smoke passed; checked ${assets.length} frontend asset(s). No write or payment endpoints were called.\n`);

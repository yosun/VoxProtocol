import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {setTimeout as sleep} from "node:timers/promises";
import {matchingIndex, missingReadyIndexes} from "./check-firestore-indexes.mjs";

const listArgs = ["firestore", "indexes", "composite", "list", "--database=(default)", "--project=voxprotocol", "--format=json"];
const runGcloud = (args) => execFileSync("gcloud", args, {encoding: "utf8", timeout: 60_000});

export function validateIndexManifest(expected) {
  if (!Array.isArray(expected) || expected.length > 1000) throw new Error("Invalid composite index manifest");
  for (const index of expected) {
    if (!index || !(/^(vox_[a-z0-9_]+|messages)$/.test(index.collectionGroup)) || !["COLLECTION", "COLLECTION_GROUP"].includes(index.queryScope) || !Array.isArray(index.fields) || index.fields.length < 2 || index.fields.length > 100) throw new Error("Only explicit VOX collection composite indexes may be provisioned");
    const seen = new Set();
    for (const field of index.fields) {
      if (!field || !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(field.fieldPath) || field.fieldPath === "__name__" || seen.has(field.fieldPath) || Boolean(field.order) === Boolean(field.arrayConfig) || field.order && !["ASCENDING", "DESCENDING"].includes(field.order) || field.arrayConfig && field.arrayConfig !== "CONTAINS") throw new Error("Invalid composite index field definition");
      seen.add(field.fieldPath);
    }
    if (index.fields.filter((field) => field.arrayConfig).length > 1) throw new Error("An index can contain at most one array field");
  }
  return expected;
}

function requireProtectedRelease(env) {
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "yosun/VoxProtocol" || env.GITHUB_REF !== "refs/heads/main" || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) || env.VOX_PRODUCTION_SENSITIVE_APPROVED !== "true") throw new Error("Index changes require the protected production-sensitive approval environment on main");
}

/** Add missing definitions only; existing indexes are never deleted or replaced. */
export async function provisionProductionIndexes(expected, options = {}) {
  requireProtectedRelease(options.env ?? process.env);
  validateIndexManifest(expected);
  const run = options.run ?? runGcloud;
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 900_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("Invalid index readiness timeout");
  const readIndexes = () => {
    const result = JSON.parse(run(listArgs));
    if (!Array.isArray(result)) throw new Error("Invalid GCP index list response");
    return result;
  };
  let actual = readIndexes();
  let created = 0;
  for (const definition of expected) {
    if (actual.some((index) => matchingIndex(definition, index))) continue;
    const fields = definition.fields.map((field) => `--field-config=field-path=${field.fieldPath},${field.order ? `order=${field.order.toLowerCase()}` : "array-config=contains"}`);
    try {
      run(["firestore", "indexes", "composite", "create", `--collection-group=${definition.collectionGroup}`, `--query-scope=${definition.queryScope === "COLLECTION_GROUP" ? "collection-group" : "collection"}`, "--database=(default)", "--project=voxprotocol", "--async", "--quiet", ...fields]);
      created += 1;
    } catch (error) {
      // Another protected release may have provisioned the exact definition.
      // Any other create failure stops the release before application promotion.
      const stderr = String(error?.stderr ?? "");
      if (!/ALREADY_EXISTS|already exists/.test(stderr)) throw error;
    }
    actual = readIndexes();
  }
  const deadline = now() + timeoutMs;
  while (true) {
    const missing = missingReadyIndexes(expected, actual);
    if (!missing.length) return {created, ready: expected.length};
    if (missing.some((definition) => actual.some((index) => matchingIndex(definition, index) && index.state === "NEEDS_REPAIR"))) throw new Error("A required index needs operator repair; no indexes were deleted or replaced");
    if (now() >= deadline) throw new Error("Timed out waiting for required Firestore indexes to reach READY; application promotion remains blocked");
    await wait(Math.min(5000, deadline - now()));
    actual = readIndexes();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? "--plan";
  if (!["--plan", "--apply"].includes(mode) || process.argv.length > 3) throw new Error("Usage: node scripts/deploy-firestore-indexes.mjs [--plan|--apply]");
  const expected = validateIndexManifest(JSON.parse(readFileSync(new URL("../infrastructure/gcp/firestore.indexes.json", import.meta.url), "utf8")).indexes);
  if (mode === "--plan") {
    const actual = JSON.parse(runGcloud(listArgs));
    console.log(JSON.stringify({project: "voxprotocol", database: "(default)", mode: "read-only", create: expected.filter((definition) => !actual.some((index) => matchingIndex(definition, index))), waiting: missingReadyIndexes(expected, actual).filter((definition) => actual.some((index) => matchingIndex(definition, index)))}, null, 2));
  } else console.log(JSON.stringify(await provisionProductionIndexes(expected)));
}

import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {describe, expect, it} from "vitest";

function release(failHealth = false, preserveTags = false, failCleanup = false, anchorOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "vox-release-tags-"));
  const log = join(directory, "cloud-calls.jsonl");
  writeFileSync(join(directory, "gcloud"), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2), log = process.env.MOCK_CLOUD_LOG;
fs.appendFileSync(log, JSON.stringify(args) + '\n');
const service = args[3];
if (args[0] === 'run' && args[1] === 'revisions' && args[2] === 'describe') {
  process.stdout.write(JSON.stringify({metadata:{name:service},spec:{containers:[{image:process.env.VOX_PRODUCTION_IMAGE}]},status:{conditions:[{type:'Ready',status:'True'}]}}));
} else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'describe') {
  if (args.some(x => x.includes('status.latestCreatedRevisionName'))) process.stdout.write(service + '-new');
  else {
    const promoted = fs.existsSync(log + '.promoted');
    const cleared = fs.existsSync(log + '.cleared') && process.env.MOCK_PRESERVE_TAGS !== 'true';
    const traffic = [{revisionName: service + '-new', percent: promoted ? 100 : 0}];
    if (!cleared) {
      traffic[0].tag = 'ci-12345';
      traffic[0].url = 'https://ci-12345---vox-api-example.run.app';
      traffic.push({revisionName: service + '-old', percent: promoted ? 0 : 100, tag: 'vulnerable-old'});
    }
    process.stdout.write(JSON.stringify({status:{traffic}}));
  }
} else if (args[0] === 'run' && args[1] === 'services' && args[2] === 'update-traffic') {
  if (args.some(x => x.startsWith('--remove-tags=')) && process.env.MOCK_CLEANUP_FAIL === 'true') process.exit(9);
  if (args.some(x => x.startsWith('--to-revisions='))) fs.writeFileSync(log + '.promoted', 'yes');
  if (args.includes('--clear-tags')) fs.writeFileSync(log + '.cleared', 'yes');
}
`, {mode: 0o755});
  writeFileSync(join(directory, "node"), "#!/bin/sh\nif [ \"$1\" = \"scripts/smoke-production.mjs\" ]; then\n  if [ \"${MOCK_HEALTH_FAIL:-false}\" = true ]; then exit 17; fi\n  exit 0\nfi\nexec '" + process.execPath.replace(/'/g, "'\\''") + "' \"$@\"\n", {mode: 0o755});
  try {
    const result = spawnSync("bash", ["scripts/deploy-production-app.sh"], {
      cwd: resolve(import.meta.dirname, ".."), encoding: "utf8",
      env: {...process.env, PATH: directory + ":" + process.env.PATH, MOCK_CLOUD_LOG: log, MOCK_HEALTH_FAIL: String(failHealth), MOCK_PRESERVE_TAGS: String(preserveTags), MOCK_CLEANUP_FAIL: String(failCleanup),
        GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "yosun/VoxProtocol", GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_WORKFLOW_REF: "yosun/VoxProtocol/.github/workflows/production.yml@refs/heads/main", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "12345",
        VOX_PRODUCTION_VERIFIED: "true", VOX_PRODUCTION_IMAGE: "us-central1-docker.pkg.dev/voxprotocol/vox/vox-api@sha256:" + "a".repeat(64), VOX_INDEXES_READY: "true", VOX_REALIZE_OPERATOR_HUMAN_IDS: "vox:human:" + "A".repeat(43),
        VOX_DEPLOY_API: String(!anchorOnly), VOX_DEPLOY_HOSTING: "false", VOX_DEPLOY_SETTLEMENT: "false", VOX_DEPLOY_RECONCILE: "false", VOX_DEPLOY_ANCHOR: String(anchorOnly), VOX_DEPLOY_INDEXES: "false"}
    });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    return {...result, calls};
  } finally { rmSync(directory, {recursive:true, force:true}); }
}

describe("protected release removes alternate old-runtime entry points", () => {
  it("promotes a healthy candidate with old tags cleared, retaining revisions", () => {
    const result = release();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(args => args.includes('--clear-tags') && args.includes('--to-revisions=vox-api-new=100'))).toBe(true);
    expect(result.calls.some(args => args.includes('delete'))).toBe(false);
  });
  it("removes a failed candidate tag without changing production traffic", () => {
    const result = release(true);
    expect(result.status).not.toBe(0);
    expect(result.calls.some(args => args.includes('--remove-tags=ci-12345'))).toBe(true);
    expect(result.calls.some(args => args.some(arg => arg.startsWith('--to-revisions=')))).toBe(false);
  });
  it("fails verification when Cloud Run still advertises obsolete tag URLs", () => {
    const result = release(false, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('obsolete tag URLs removed');
  });
  it("preserves the original failure status when candidate cleanup also fails", () => {
    const result = release(true, false, true);
    expect(result.status).toBe(17);
    expect(result.stderr).toContain('Could not remove');
  });
  it("checks worker readiness and the pinned image before clearing anchor tags", () => {
    const result = release(false, false, false, true);
    expect(result.status, result.stderr).toBe(0);
    const readiness = result.calls.findIndex(args => args[1] === 'revisions' && args[3] === 'vox-anchor-worker-new');
    const promotion = result.calls.findIndex(args => args.includes('--to-revisions=vox-anchor-worker-new=100') && args.includes('--clear-tags'));
    expect(readiness, JSON.stringify(result.calls)).toBeGreaterThan(-1);
    expect(promotion).toBeGreaterThan(readiness);
  });
});

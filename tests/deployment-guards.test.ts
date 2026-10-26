import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {parse} from "yaml";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive: true, force: true}); });
const verified = {
  VOX_PRODUCTION_VERIFIED: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "yosun/VoxProtocol",
  GITHUB_REF: "refs/heads/main", GITHUB_REF_PROTECTED: "true", GITHUB_EVENT_NAME: "push",
  GITHUB_WORKFLOW_REF: "yosun/VoxProtocol/.github/workflows/production.yml@refs/heads/main"
};
const invalidContexts = [
  {name: "local", env: {...verified, GITHUB_ACTIONS: "false"}},
  {name: "pull request", env: {...verified, GITHUB_EVENT_NAME: "pull_request"}},
  {name: "unverified", env: {...verified, VOX_PRODUCTION_VERIFIED: "false"}},
  {name: "legacy approval flag", env: {...verified, VOX_PRODUCTION_VERIFIED: "false", VOX_PRODUCTION_SENSITIVE_APPROVED: "true"}},
  {name: "wrong repository", env: {...verified, GITHUB_REPOSITORY: "another/VoxProtocol"}},
  {name: "wrong branch", env: {...verified, GITHUB_REF: "refs/heads/feature"}},
  {name: "unprotected main", env: {...verified, GITHUB_REF_PROTECTED: "false"}},
  {name: "wrong workflow", env: {...verified, GITHUB_WORKFLOW_REF: "yosun/VoxProtocol/.github/workflows/other.yml@refs/heads/main"}},
  {name: "wrong workflow source", env: {...verified, GITHUB_WORKFLOW_REF: "yosun/VoxProtocol/.github/workflows/production.yml@refs/heads/feature"}},
  {name: "unsupported event", env: {...verified, GITHUB_EVENT_NAME: "schedule"}}
];

function runShell(args: string[], overrides: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "vox-deploy-guard-"));
  temporary.push(directory);
  const marker = join(directory, "cloud-command-called");
  const fetched = join(directory, "git-fetch-called");
  // Even a broken guard cannot use real cloud tools or fetch from GitHub here.
  for (const name of ["gcloud", "npx", "npm", "firebase", "gh"]) writeFileSync(join(directory, name), '#!/bin/sh\n: > "$VOX_AUDIT_MARKER"\nexit 99\n', {mode: 0o700});
  writeFileSync(join(directory, "git"), '#!/bin/sh\ncase "$1" in\n fetch) : > "$VOX_AUDIT_FETCH_MARKER"; if [ "${VOX_TEST_FETCH_FAIL:-false}" = "true" ]; then exit 97; fi ;;\n rev-parse) printf "%s\\n" "$VOX_TEST_MAIN_SHA" ;;\n *) exit 98 ;;\nesac\n', {mode: 0o700});
  symlinkSync(process.execPath, join(directory, "node"));
  const result = spawnSync("/bin/bash", args, {
    encoding: "utf8",
    env: {PATH: directory, GITHUB_RUN_ID: "audit-test", VOX_AUDIT_MARKER: marker, VOX_AUDIT_FETCH_MARKER: fetched, ...overrides}
  });
  return {...result, cloudToolCalled: existsSync(marker), fetchedMain: existsSync(fetched)};
}
const runGuard = (script: string, args: string[], overrides: Record<string, string>) => runShell([script, ...args], overrides);

function releaseJob() {
  return parse(readFileSync(new URL("../.github/workflows/production.yml", import.meta.url), "utf8")).jobs["deploy-production"];
}

describe("verified automatic production release guards", () => {
  it("rejects local --manual invocation even when verification/legacy flags are supplied", () => {
    const result = runGuard("scripts/deploy-production-app.sh", ["--manual"], {...verified, VOX_MANUAL_DEPLOY_AUTHORIZED: "true", VOX_PRODUCTION_SENSITIVE_APPROVED: "true", VOX_DEPLOY_SETTLEMENT: "true"});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("local/manual deployments are disabled");
    expect(result.cloudToolCalled).toBe(false);
  });

  it.each(invalidContexts)("blocks $name context before cloud calls", ({env}) => {
    for (const script of ["scripts/deploy-production-app.sh", "infrastructure/gcp/deploy.sh"]) {
      const result = runGuard(script, [], {...env, VOX_DEPLOY_SETTLEMENT: "true"});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("verified protected main production workflow");
      expect(result.cloudToolCalled).toBe(false);
    }
  });

  it("requires verification even for an index-only release", () => {
    const result = runGuard("scripts/deploy-production-app.sh", [], {VOX_DEPLOY_INDEXES: "true"});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("verified protected main production workflow");
    expect(result.cloudToolCalled).toBe(false);
  });

  it("admits verified push/dispatch context but still blocks API/job promotion without index readiness", () => {
    for (const event of ["push", "workflow_dispatch"]) for (const target of ["VOX_DEPLOY_API", "VOX_DEPLOY_RECONCILE"]) {
      const result = runGuard("scripts/deploy-production-app.sh", [], {...verified, GITHUB_EVENT_NAME: event, [target]: "true", VOX_PRODUCTION_IMAGE: `us-central1-docker.pkg.dev/voxprotocol/vox/vox-api@sha256:${"a".repeat(64)}`});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Required indexes must finish the protected index step");
      expect(result.cloudToolCalled).toBe(false);
    }
  });

  it("rejects invalid deployment environment labels before any cloud tools", () => {
    for (const environment of ["development", "prod", "invalid"]) {
      const result = runGuard("infrastructure/gcp/deploy.sh", [], {VOX_DEPLOYMENT_ENV: environment});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must be production or staging");
      expect(result.cloudToolCalled).toBe(false);
    }
  });

  it("orders successful verification, serialization, fresh-main check, then cloud authentication without a reviewer gate", () => {
    const workflowText = readFileSync(new URL("../.github/workflows/production.yml", import.meta.url), "utf8");
    const job = releaseJob();
    expect(job.needs).toEqual(["verify", "scope"]);
    for (const condition of ["needs.verify.result == 'success'", "needs.scope.result == 'success'", "github.repository == 'yosun/VoxProtocol'", "github.ref == 'refs/heads/main'", "github.ref_protected"]) expect(job.if).toContain(condition);
    expect(job.environment.name).toBe("production-sensitive");
    expect(job.concurrency).toEqual({group: "vox-production", queue: "max", "cancel-in-progress": false});
    expect(job.env.VOX_PRODUCTION_VERIFIED).toContain("needs.verify.result == 'success'");
    expect(job.env.VOX_PRODUCTION_VERIFIED).toContain("needs.scope.result == 'success'");
    expect(job.env).not.toHaveProperty("VOX_PRODUCTION_SENSITIVE_APPROVED");
    expect(workflowText).not.toContain("required_reviewers");
    expect(workflowText).not.toContain("reviewer_count");
    expect(workflowText).not.toContain("gh api");
    const verification = job.steps.findIndex((step: any) => step.name === "Verify production release context");
    const checkout = job.steps.findIndex((step: any) => step.uses === "actions/checkout@v4");
    const freshness = job.steps.findIndex((step: any) => step.name === "Reject stale production runs before cloud authentication");
    const authentication = job.steps.findIndex((step: any) => step.uses === "google-github-actions/auth@v3");
    expect(verification).toBe(0);
    expect(checkout).toBeGreaterThan(verification);
    expect(freshness).toBeGreaterThan(checkout);
    expect(authentication).toBeGreaterThan(freshness);
  });

  it("executes the workflow context check for every rejected context and accepts verified dispatch", () => {
    const check = releaseJob().steps.find((step: any) => step.name === "Verify production release context").run;
    for (const {env} of invalidContexts) {
      const result = runShell(["-c", check], env);
      expect(result.status).toBe(1);
      expect(result.cloudToolCalled).toBe(false);
    }
    expect(runShell(["-c", check], {...verified, GITHUB_EVENT_NAME: "workflow_dispatch"}).status).toBe(0);
  });

  it("fetches main and rejects a stale serialized run before cloud authentication", () => {
    const check = releaseJob().steps.find((step: any) => step.name === "Reject stale production runs before cloud authentication").run;
    const sha = "a".repeat(40);
    const stale = runShell(["-c", check], {...verified, GITHUB_SHA: sha, VOX_TEST_MAIN_SHA: "b".repeat(40)});
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("This run is stale");
    expect(stale.fetchedMain).toBe(true);
    expect(stale.cloudToolCalled).toBe(false);
    const current = runShell(["-c", check], {...verified, GITHUB_SHA: sha, VOX_TEST_MAIN_SHA: sha});
    expect(current.status).toBe(0);
    expect(current.fetchedMain).toBe(true);
    expect(current.cloudToolCalled).toBe(false);
    const failedFetch = runShell(["-c", check], {...verified, GITHUB_SHA: sha, VOX_TEST_MAIN_SHA: sha, VOX_TEST_FETCH_FAIL: "true"});
    expect(failedFetch.status).toBe(97);
    expect(failedFetch.fetchedMain).toBe(true);
    expect(failedFetch.cloudToolCalled).toBe(false);
  });

  it("preserves every Workload Identity restriction while admitting push and dispatch", () => {
    const identity = JSON.parse(readFileSync(new URL("../infrastructure/gcp/index-release-identity.json", import.meta.url), "utf8"));
    expect(identity.required_provider_condition).toBe("assertion.repository_id == '1412704839' && assertion.repository_owner_id == '909246' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'yosun/VoxProtocol/.github/workflows/production.yml@refs/heads/main' && assertion.environment == 'production-sensitive' && (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')");
    expect(identity.permissions).not.toContain("datastore.schemas.delete");
    expect(identity.permissions).not.toContain("secretmanager.versions.access");
  });
});

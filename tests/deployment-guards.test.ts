import {afterEach, describe, expect, it} from "vitest";
import {mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, {recursive: true, force: true}); });

function runGuard(script: string, args: string[], overrides: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "vox-deploy-guard-"));
  temporary.push(directory);
  const marker = join(directory, "cloud-command-called");
  // Even a broken guard cannot use real cloud tools during this test.
  for (const name of ["gcloud", "npx", "npm", "firebase"]) writeFileSync(join(directory, name), '#!/bin/sh\n: > "$VOX_AUDIT_MARKER"\nexit 99\n', {mode: 0o700});
  symlinkSync(process.execPath, join(directory, "node"));
  const result = spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: {PATH: directory, GITHUB_RUN_ID: "audit-test", VOX_AUDIT_MARKER: marker, ...overrides}
  });
  return {...result, cloudToolCalled: existsSync(marker)};
}

describe("production release approval guards", () => {
  it("rejects manual sensitive releases before any cloud calls, even with approval flags", () => {
    const result = runGuard("scripts/deploy-production-app.sh", ["--manual"], {
      VOX_MANUAL_DEPLOY_AUTHORIZED: "true", VOX_PRODUCTION_SENSITIVE_APPROVED: "true",
      VOX_DEPLOY_SETTLEMENT: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "yosun/VoxProtocol", GITHUB_REF: "refs/heads/main"
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("manual deployment cannot bypass");
    expect(result.cloudToolCalled).toBe(false);
  });

  it("rejects local sensitive releases and production infrastructure bootstrap", () => {
    for (const script of ["scripts/deploy-production-app.sh", "infrastructure/gcp/deploy.sh"]) {
      const result = runGuard(script, [], {VOX_PRODUCTION_SENSITIVE_APPROVED: "true", VOX_DEPLOY_SETTLEMENT: "true"});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("protected production-sensitive approval environment");
      expect(result.cloudToolCalled).toBe(false);
    }
  });

  it("keeps an index-only release behind approval before using cloud commands", () => {
    const result = runGuard("scripts/deploy-production-app.sh", [], {VOX_DEPLOY_INDEXES: "true", VOX_PRODUCTION_SENSITIVE_APPROVED: "true"});
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("protected production-sensitive");
    expect(result.cloudToolCalled).toBe(false);
  });

  it("rejects invalid deployment environment labels before any cloud tools", () => {
    for (const environment of ["development", "prod", ""]) {
      const result = runGuard("infrastructure/gcp/deploy.sh", [], {VOX_DEPLOYMENT_ENV: environment || "invalid"});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must be production or staging");
      expect(result.cloudToolCalled).toBe(false);
    }
  });

  it("rejects production infrastructure from an unprotected branch", () => {
    const result = runGuard("infrastructure/gcp/deploy.sh", [], {
      GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "yosun/VoxProtocol", GITHUB_REF: "refs/heads/feature",
      VOX_PRODUCTION_SENSITIVE_APPROVED: "true"
    });
    expect(result.status).toBe(2);
    expect(result.cloudToolCalled).toBe(false);
  });
});

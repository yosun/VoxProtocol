import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const classifier = fileURLToPath(new URL("../scripts/production-deployment-scope.mjs", import.meta.url));

function classify(args: string[], cwd?: string): Record<string, string> {
  const output = execFileSync(process.execPath, [classifier, ...args], {encoding: "utf8", env: {...process.env, GITHUB_OUTPUT: ""}, ...(cwd ? {cwd} : {})});
  return Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")));
}

describe("production release scope", () => {
  it.each([
    "apps/api/src/nft.ts",
    "apps/api/src/character-account.ts",
    "apps/api/src/direct-message-media-store.ts",
    "apps/api/src/conversations.ts",
    "apps/api/src/new-feature.ts",
    "apps/web/src/DirectMessages.tsx",
    "apps/web/src/evm-wallet.ts",
    "apps/web/src/human-account.ts",
    "packages/client/src/index.ts",
    "packages/media-provider/src/index.ts"
  ])("retains required review for runtime changes in %s", (path) => {
    const scope = classify(["--paths", path]);
    expect(scope.sensitive).toBe("true");
    expect(scope.deploy_api).toBe("true");
    expect(scope.deploy_reconcile).toBe(String(!path.startsWith("apps/web/")));
  });

  it("keeps ordinary documentation and test-only updates outside deployment approval", () => {
    expect(classify(["--paths", "README.md", "tests/merkle.test.ts"])).toMatchObject({sensitive: "false", deploy_api: "false", deploy_hosting: "false", deploy_settlement: "false", deploy_reconcile: "false"});
  });

  it("routes index-only changes and the explicit index profile through protected approval", () => {
    for (const args of [["--paths", "infrastructure/gcp/firestore.indexes.json"], ["--release-profile", "firestore-indexes"]]) {
      expect(classify(args)).toMatchObject({deploy_indexes: "true", sensitive: "true", deploy_api: "false", deploy_hosting: "false", deploy_settlement: "false", deploy_reconcile: "false", deploy_anchor: "false"});
    }
    expect(classify(["--release-profile", "realize-refund-settlement"])).toMatchObject({deploy_indexes: "false", sensitive: "true", deploy_settlement: "true", deploy_reconcile: "true"});
  });

  it("classifies removal of runtime source instead of silently omitting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "vox-scope-test-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
    try {
      git("init", "--quiet");
      git("config", "user.name", "VOX release scope test");
      git("config", "user.email", "scope-test@example.test");
      mkdirSync(join(directory, "apps/api/src"), {recursive: true});
      writeFileSync(join(directory, "apps/api/src/nft.ts"), "export const enabled = true;\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "Initial runtime");
      const base = git("rev-parse", "HEAD");
      git("rm", "apps/api/src/nft.ts");
      git("commit", "--quiet", "-m", "Remove runtime");
      const head = git("rev-parse", "HEAD");
      expect(classify([base, head], directory)).toMatchObject({changed_files: "1", sensitive: "true", deploy_api: "true", deploy_reconcile: "true"});
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});

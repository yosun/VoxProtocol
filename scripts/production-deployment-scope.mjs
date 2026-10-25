#!/usr/bin/env node

import {execFileSync} from "node:child_process";

const [base, head, ...explicitFiles] = process.argv.slice(2);
if (!base || (base !== "--paths" && !head)) {
  console.error("Usage: node scripts/production-deployment-scope.mjs <base-sha> <head-sha> | --paths <changed-path>... | --release-profile <realize-refund-settlement|firestore-indexes>");
  process.exit(2);
}

if (base === "--release-profile") {
  if (!["realize-refund-settlement", "firestore-indexes"].includes(head) || explicitFiles.length > 0) {
    console.error("Unknown production release profile.");
    process.exit(2);
  }
  const outputs = {
    deploy_api: "false",
    deploy_hosting: "false",
    run_e2e: String(head === "realize-refund-settlement"),
    deploy_settlement: String(head === "realize-refund-settlement"),
    deploy_reconcile: String(head === "realize-refund-settlement"),
    deploy_indexes: String(head === "firestore-indexes"),
    deploy_anchor: "false",
    sensitive: "true",
    changed_files: "0"
  };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) {
    const {appendFileSync} = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  } else {
    process.stdout.write(lines);
  }
  process.exit(0);
}

const zeroSha = /^0+$/;
const files = base === "--paths"
  ? [head, ...explicitFiles].filter(Boolean)
  : zeroSha.test(base)
  ? execFileSync("git", ["ls-files"], {encoding: "utf8"}).split(/\r?\n/)
  : execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head], {encoding: "utf8"}).split(/\r?\n/);
const changed = [...new Set(files.map((file) => file.trim().replaceAll("\\", "/")).filter(Boolean))].sort();

const deployApi = changed.some((file) =>
  file.startsWith("apps/api/") ||
  file.startsWith("apps/web/") ||
  file.startsWith("packages/") ||
  file.startsWith("docs/") ||
  ["Dockerfile", "infrastructure/gcp/Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json"].includes(file)
);
const deployHosting = changed.some((file) =>
  file.startsWith("apps/web/") ||
  file.startsWith("packages/") ||
  ["firebase.json", "package.json", "package-lock.json", "tsconfig.base.json"].includes(file)
);
const runE2e = deployHosting || changed.some((file) => file.startsWith("tests/e2e/") || file === "playwright.config.ts");
const deploySettlement = changed.some((file) =>
  file.startsWith("apps/settlement/") ||
  ["packages/protocol/", "packages/solana/"].some((prefix) => file.startsWith(prefix)) ||
  ["Dockerfile", "infrastructure/gcp/Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json"].includes(file)
);
const deployReconcile = changed.some((file) =>
  file.startsWith("apps/api/") ||
  file.startsWith("packages/") ||
  ["Dockerfile", "infrastructure/gcp/Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json"].includes(file)
);
const deployAnchor = changed.some((file) =>
  file.startsWith("workers/anchor/") ||
  ["packages/protocol/", "packages/merkle/", "packages/solana/"].some((prefix) => file.startsWith(prefix)) ||
  ["Dockerfile", "infrastructure/gcp/Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json"].includes(file)
);

const deployIndexes = changed.some((file) => file === "infrastructure/gcp/firestore.indexes.json");

const sensitive = changed.some((file) =>
  file === "scripts/check-firestore-indexes.mjs" ||
  file.startsWith("infrastructure/") ||
  file.startsWith("deployments/") ||
  file.startsWith(".github/") ||
  // New runtime modules must retain the reviewer gate without requiring a
  // filename allowlist update alongside their first money/auth/privacy change.
  /^apps\/[^/]+\/src\//.test(file) ||
  file.startsWith("packages/") ||
  file.startsWith("apps/settlement/") ||
  file.startsWith("workers/anchor/") ||
  /^apps\/api\/src\/(app|server|tasks|types|store|firestore-store|public|link-preview|avatar-processing|avatar-store|verifier|key-history|realize[^/]*)\.ts$/.test(file) ||
  /^apps\/web\/src\/(api\.ts|RealizeCheckout\.tsx|realize-|solana-)/.test(file) ||
  /(^|\/)(payment|payments|wallet|auth|security|settlement|treasury|refund|checkout|migration|migrations|destructive)([-./]|$)/i.test(file) ||
  /^packages\/(identity|protocol|solana|realize-solana|realize-contracts)\//.test(file) ||
  file.startsWith("integrations/bob/") ||
  /(^|\/)package(?:-lock)?\.json$/.test(file) ||
  /^docs\/realize/.test(file) ||
  /^scripts\/(deploy|production-)/.test(file) ||
  ["Dockerfile", "firebase.json", ".gcloudignore", ".dockerignore", ".npmrc", "tsconfig.base.json"].includes(file)
);

const outputs = {
  deploy_api: String(deployApi),
  deploy_hosting: String(deployHosting),
  run_e2e: String(runE2e),
  deploy_settlement: String(deploySettlement),
  deploy_reconcile: String(deployReconcile),
  deploy_anchor: String(deployAnchor),
  deploy_indexes: String(deployIndexes),
  sensitive: String(sensitive),
  changed_files: String(changed.length)
};

const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) {
  const {appendFileSync} = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT, lines);
} else {
  process.stdout.write(lines);
}

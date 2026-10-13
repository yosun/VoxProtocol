import {copyFile, mkdir, readdir, rm, readFile, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(packageDir, "../..");
const protocolDir = path.join(repoDir, "packages/protocol");
const outputDir = path.join(packageDir, "dist");
const protocolPackage = JSON.parse(await readFile(path.join(protocolDir, "package.json"), "utf8"));
const publishPackage = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
if (protocolPackage.version !== publishPackage.version) throw new Error("@vox/realize-contracts must use the same release version as @vox/protocol");

await execFileAsync("npm", ["run", "generate:schemas", "--workspace", "@vox/protocol"], {cwd: repoDir});
await rm(outputDir, {recursive: true, force: true});
await mkdir(outputDir, {recursive: true});
await execFileAsync("npm", ["exec", "--", "tsc", "-p", "packages/protocol/tsconfig.realize.json"], {cwd: repoDir});

const protocolDist = path.join(protocolDir, "dist");
const runtimeModules = ["canonical.js", "encoding.js", "hash.js", "realize-crypto.js", "realize.js", "realize-contracts.js", "realize-guards.js", "realize-webhooks.js"];
for (const file of runtimeModules) await copyFile(path.join(protocolDist, file), path.join(outputDir, file));
await copyFile(path.join(protocolDist, "realize-index.js"), path.join(outputDir, "realize-index.js"));

// The declaration compiler follows type-only imports from crypto.ts. Keep those
// declarations but omit unrelated runtime schemas from the distributable.
const declarationDir = path.join(packageDir, "dist/types");
for (const file of await readdir(declarationDir)) {
  if (file.endsWith(".js") || file.endsWith(".js.map")) await rm(path.join(declarationDir, file));
}

const schemaDir = path.join(outputDir, "schemas");
await mkdir(schemaDir, {recursive: true});
await copyFile(path.join(protocolDir, "schemas/realize-v1.schema.json"), path.join(schemaDir, "realize-v1.schema.json"));
const fixturesDir = path.join(outputDir, "fixtures/realize");
await mkdir(fixturesDir, {recursive: true});
for (const file of await readdir(path.join(protocolDir, "fixtures/realize"))) await copyFile(path.join(protocolDir, "fixtures/realize", file), path.join(fixturesDir, file));
const openapiText = await readFile(path.join(repoDir, "docs/realize-openapi.json"), "utf8");
await writeFile(path.join(outputDir, "realize-openapi.json"), openapiText.replaceAll("../packages/protocol/schemas/realize-v1.schema.json", "./schemas/realize-v1.schema.json"));
const handoffText = await readFile(path.join(repoDir, "docs/realize-populi-handoff.md"), "utf8");
await writeFile(path.join(outputDir, "realize-populi-handoff.md"), handoffText
  .replace("The source JSON Schema is `packages/protocol/schemas/realize-v1.schema.json`, and the source OpenAPI 3.1 document is `docs/realize-openapi.json`; packaged copies are exported at `@vox/realize-contracts/schemas/realize-v1.schema.json` and `@vox/realize-contracts/openapi.json`.", "Use the JSON Schema at `@vox/realize-contracts/schemas/realize-v1.schema.json` and OpenAPI 3.1 at `@vox/realize-contracts/openapi.json`.")
  .replaceAll("[the fixture directory](../packages/protocol/fixtures/realize/README.md)", "[the fixture directory](./fixtures/realize/README.md)"));
console.log(`Built standalone @vox/realize-contracts ${publishPackage.version} from @vox/protocol.`);

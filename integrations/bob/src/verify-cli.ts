import {readFile} from "node:fs/promises";
import {verifyProofBundle, verifyProofBundleWithChain, type ProofBundle} from "@vox/client";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run verify --workspace @vox/bob -- ./proof-bundle.json");
  process.exit(2);
}
const raw = JSON.parse(await readFile(filePath, "utf8")) as {bundle?: ProofBundle} | ProofBundle;
const bundle = "bundle" in raw && raw.bundle ? raw.bundle : raw as ProofBundle;
const result = process.env.VOX_RPC_URL ? await verifyProofBundleWithChain(bundle, process.env.VOX_RPC_URL) : verifyProofBundle(bundle);
console.log(JSON.stringify(result, null, 2));
if (!result.valid) process.exitCode = 1;

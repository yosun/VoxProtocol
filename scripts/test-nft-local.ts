import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, readFile, writeFile, rm, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, join} from "node:path";
import {createServer as createTcpServer} from "node:net";
import {createHash} from "node:crypto";
import {chromium} from "@playwright/test";
import {createServer as createViteServer} from "vite";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";
import {canonicalBytes, utf8} from "@vox/protocol";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {EvmNftAdapter, NftMintService} from "../apps/api/src/nft.js";

// This rehearsal only creates a disposable localhost chain and synthetic completed media.
// It never loads GCP credentials or production signers, pays a provider, or contacts Mainnet.
async function port(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}
const chainPort = await port();
const apiPort = await port();
const webPort = await port();
const rpcUrl = `http://127.0.0.1:${chainPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const scratch = await mkdtemp(join(tmpdir(), "vox-nft-local-"));
const harness = resolve(".vox-local/nft-local-harness");
const anvil = spawn("anvil", ["--host", "127.0.0.1", "--port", String(chainPort), "--chain-id", "10143", "--silent"], {stdio: "ignore"});
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function rpc(method: string, params: unknown[]): Promise<any> {
  const response = await fetch(rpcUrl, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(5_000)});
  const payload = await response.json() as {result?: unknown; error?: unknown};
  assert(!payload.error, JSON.stringify(payload.error));
  return payload.result;
}
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const address = (key: Uint8Array) => `0x${hex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20))}`;
const signerKey = new Uint8Array(32).fill(21);
const walletKey = new Uint8Array(32).fill(22);
const recipient = address(walletKey);

try {
  for (let attempt = 0; ; attempt++) {
    try { assert.equal(await rpc("eth_chainId", []), "0x279f"); break; }
    catch (error) { if (attempt >= 40) throw error; await new Promise((done) => setTimeout(done, 100)); }
  }
  execFileSync("forge", ["build", "--root", process.cwd(), "--contracts", "contracts", "--out", join(scratch, "artifacts"), "--cache-path", join(scratch, "cache"), "--evm-version", "cancun"], {stdio: "pipe"});
  const artifact = JSON.parse(await readFile(join(scratch, "artifacts/VoxMediaNFT.sol/VoxMediaNFT.json"), "utf8"));
  const encodeString = (value: string) => word(BigInt(Buffer.byteLength(value))) + Buffer.from(value).toString("hex").padEnd(Math.ceil(Buffer.byteLength(value) / 32) * 64, "0");
  const name = encodeString("VOX Local Rehearsal");
  const symbol = encodeString("VOX");
  const constructor = word(96n) + word(BigInt(96 + name.length / 2)) + address(signerKey).slice(2).padStart(64, "0") + name + symbol;
  const accounts = await rpc("eth_accounts", []);
  const deployment = await rpc("eth_sendTransaction", [{from: accounts[0], data: artifact.bytecode.object + constructor, gas: "0x4c4b40"}]);
  const deployed = await rpc("eth_getTransactionReceipt", [deployment]);
  assert.equal(deployed.status, "0x1");
  const contract = deployed.contractAddress as string;
  await rpc("anvil_setBalance", [address(signerKey), "0x56bc75e2d63100000"]);
  const store = new MemoryStore();
  const adapter = new EvmNftAdapter({chain: "monad:testnet", rpcUrl, chainId: 10143, contractAddress: contract, privateKey: signerKey, confirmations: 1, explorerBaseUrl: "https://testnet.monadscan.com"});
  const service = new NftMintService({publicBaseUrl: apiUrl, adapters: [adapter]});
  app = await buildApp({store, nftService: service, publicBaseUrl: apiUrl});
  app.post("/local/completed-output", async (request) => {
    const humanId = (request.body as {human_id: string}).human_id;
    assert(await store.getHuman(humanId));
    const fixture = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#f4c542"/></svg>');
    const media = await service.ensureMedia(store, {source_kind: "realize_commission", source_id: "local:completed-realize-output", output_index: 0, owner_id: humanId, provider_id: "local:synthetic-provider", request_parameters: {concept: "Disposable NFT mint rehearsal"}, media_uri: `${apiUrl}/local/artifact.svg`, media_type: "image/svg+xml", media_sha256: createHash("sha256").update(fixture).digest("hex"), byte_length: fixture.length});
    return {media_id: media.media_id};
  });
  await app.listen({host: "127.0.0.1", port: apiPort});
  await mkdir(harness, {recursive: true});
  await writeFile(join(harness, "main.tsx"), `import React from "react"; import {createRoot} from "react-dom/client"; import {RealizeNfts} from "../../apps/web/src/RealizeNfts"; import {getRealizeIdentity} from "../../apps/web/src/realize-identity"; import "../../apps/web/src/styles.css"; const identity = await getRealizeIdentity(); const output = await fetch(${JSON.stringify(apiUrl + "/local/completed-output")}, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({human_id:identity.humanId})}).then(response=>response.json()); createRoot(document.getElementById("root")!).render(<main style={{maxWidth:720,margin:"40px auto",padding:20}}><RealizeNfts mediaIds={[output.media_id]} identity={identity}/></main>);`);
  vite = await createViteServer({root: resolve("apps/web"), appType: "custom", define: {"import.meta.env.VITE_API_URL": JSON.stringify(apiUrl)}, server: {host: "127.0.0.1", port: webPort, strictPort: true, fs: {allow: [process.cwd()]}}});
  vite.middlewares.use((request, response, next) => {
    if (request.url !== "/nft-local-test") return next();
    response.setHeader("content-type", "text/html");
    void vite!.transformIndexHtml(request.url, `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${join(harness, "main.tsx")}"></script></body></html>`).then((html) => response.end(html));
  });
  await vite.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  await page.exposeFunction("voxLocalWalletSign", (messageHex: string) => {
    const bytes = Buffer.from(messageHex.slice(2), "hex");
    const signature = secp256k1.sign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes])), walletKey);
    return `0x${hex(signature.toCompactRawBytes())}${(27 + signature.recovery!).toString(16)}`;
  });
  await page.addInitScript(({recipient}) => {
    const testWindow = window as any;
    testWindow.ethereum = {async request({method, params}: {method: string; params?: any[]}) {
      if (method === "eth_requestAccounts") return [recipient];
      if (method === "eth_chainId") return "0x279f";
      if (method === "personal_sign") return testWindow.voxLocalWalletSign(params![0]);
      throw new Error(`Unexpected test-wallet method ${method}`);
    }};
  }, {recipient});
  await page.goto(`http://127.0.0.1:${webPort}/nft-local-test`);
  await page.getByRole("button", {name: "Mint on Monad"}).click();
  try { await page.getByText("Minted · Token #1", {exact: true}).waitFor({timeout: 30_000}); } catch (error) { console.error(await page.locator("body").innerText()); console.error((await store.snapshot()).nft_mints?.map(({state, last_error}) => ({state, last_error}))); throw error; }
  assert(await page.getByRole("link", {name: "View your NFT ↗"}).getAttribute("href"));
  const snapshot = await store.snapshot();
  const mint = snapshot.nft_mints![0]!;
  const media = snapshot.nft_media![0]!;
  assert.equal(mint.state, "finalized");
  const onChainOwner = await rpc("eth_call", [{to: contract, data: "0x6352211e" + word(1n)}, "latest"]);
  assert.equal(`0x${onChainOwner.slice(-40)}`, recipient);
  const metadata = await fetch(media.metadata_uri).then((response) => response.json());
  assert.equal(createHash("sha256").update(canonicalBytes(metadata)).digest("hex"), media.metadata_hash);
  await page.reload();
  await page.getByText("Minted · Token #1", {exact: true}).waitFor();
  assert.equal(await page.getByRole("button", {name: "Mint on Monad"}).count(), 0);
  assert.equal(BigInt(await rpc("eth_call", [{to: contract, data: "0x75794a3c"}, "latest"])), 2n); // nextTokenId
  await page.screenshot({path: resolve(".vox-local/monad-nft-local.png"), fullPage: true});
  console.log(JSON.stringify({network: "disposable localhost EVM, chain 10143", transaction_id: mint.transaction_id, token_id: mint.token_id, owner_verified: true, canonical_metadata_verified: true, browser_reload_no_duplicate: true}, null, 2));
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  anvil.kill("SIGTERM");
  await rm(scratch, {recursive: true, force: true});
  await rm(harness, {recursive: true, force: true});
}

import {randomUUID} from "node:crypto";
import {configuredNftService} from "../apps/api/src/nft.js";
import {MemoryStore} from "../apps/api/src/store.js";
import type {NftMediaInput} from "../apps/api/src/nft.js";

const env = process.env;
if (env.VOX_NFT_VALIDATE_TESTNETS !== "1") throw new Error("Refusing live testnet NFT validation without VOX_NFT_VALIDATE_TESTNETS=1");
if (env.VOX_NFT_MAINNET_ENABLED === "true" || env.VOX_CONFIRM_NFT_MAINNET === "1") throw new Error("This validator refuses Mainnet NFT settings");
env.VOX_DEPLOYMENT_ENV = "staging";
env.VOX_NFT_ENABLED = "true";
env.VOX_NFT_CHAINS = "solana:devnet,base:sepolia,monad:testnet";
const publicBaseUrl = env.VOX_PUBLIC_BASE_URL?.trim();
const solanaOwner = env.VOX_NFT_TEST_OWNER_SOLANA?.trim();
const baseOwner = env.VOX_NFT_TEST_OWNER_BASE?.trim();
const monadOwner = env.VOX_NFT_TEST_OWNER_MONAD?.trim();
if (!publicBaseUrl || !solanaOwner || !baseOwner || !monadOwner) throw new Error("Testnet validation requires VOX_PUBLIC_BASE_URL and owner wallets for all three testnets");
const service = configuredNftService(publicBaseUrl, env);
if (!service || service.adapters.length !== 3) throw new Error("Testnet NFT service did not configure exactly three adapters");
const store = new MemoryStore();
const input: NftMediaInput = {
  source_kind: "realization",
  source_id: `vox:nft-test:${randomUUID()}`,
  output_index: 0,
  owner_id: "vox:human:nft-test-operator",
  owner_wallets: {solana: solanaOwner, base: baseOwner, monad: monadOwner},
  provider_id: "vox.nft.testnet.validation",
  source_content: "A disposable testnet validation media payload.",
  request_parameters: {concept: "A testnet-only VOX NFT validation artifact", duration_seconds: 5},
  media_uri: "https://example.invalid/vox/nft-testnet-validation.mp4",
  media_type: "video/mp4",
  media_sha256: "c".repeat(64),
  byte_length: 1
};
const media = await service.ensureMedia(store, input);
const deadline = Date.now() + Number.parseInt(env.VOX_NFT_TESTNET_TIMEOUT_MS ?? "600000", 10);
let last = [] as Array<{mint_id: string; state: string; error?: string}>;
while (Date.now() < deadline) {
  last = await service.processPending(store, 10, `testnet-validation:${process.pid}`);
  const mints = await store.listNftMintsForMedia(media.media_id);
  if (mints.length === 3 && mints.every((mint) => mint.state === "finalized")) {
    console.log(JSON.stringify({media_id: media.media_id, mints: mints.map((mint) => ({mint_id: mint.mint_id, chain: mint.chain, state: mint.state, transaction_id: mint.transaction_id, explorer_url: mint.explorer_url}))}, null, 2));
    process.exit(0);
  }
  if (last.some((item) => item.state === "manual_review")) throw new Error(`Testnet NFT validation reached manual review: ${JSON.stringify(last)}`);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
throw new Error(`Testnet NFT validation timed out: ${JSON.stringify(last)}`);

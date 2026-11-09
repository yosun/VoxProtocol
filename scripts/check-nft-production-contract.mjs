import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export const NFT_CUTOVER = Object.freeze({
  chainId: 143,
  owner: "0xafac2571572aa858da801b5c8ed38009c555a4c6",
  previous: "0x87ef9e71625878a0babeee7864fa7d96ed4e3571",
  contract: "0xd5b3c636292b47fb6edbeea064323c0c0a32f494",
  transaction: "0x8904043f92b5ee8ff44c5078474bea3cc42d9684ba2275f8362c04cd578b1252",
  rpcs: ["https://rpc.monad.xyz", "https://rpc2.monad.xyz"]
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireCheck = (value, message) => {if (!value) throw new Error(message);};
function hexBytes(value) {
  requireCheck(typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(value), "Contract bytes are missing or malformed");
  return Buffer.from(value.slice(2), "hex");
}
function quantity(value) {
  requireCheck(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), "RPC quantity is malformed");
  return BigInt(value);
}
export function validateNftCutover(manifest) {
  const chain = manifest.chains?.["monad:mainnet"];
  const proof = chain?.deployment_verification;
  requireCheck(manifest.environment === "production" && manifest.projectId === "voxprotocol" && manifest.region === "us-central1" && manifest.enabledChains?.length === 1 && manifest.enabledChains[0] === "monad:mainnet", "Unexpected NFT production scope");
  requireCheck(chain?.chain_id === NFT_CUTOVER.chainId && chain.signer === NFT_CUTOVER.owner && chain.contract_address === NFT_CUTOVER.contract && chain.deployment_transaction === NFT_CUTOVER.transaction, "NFT cutover differs from the authorized identity and transaction");
  requireCheck(chain.previous_collections?.some((item) => item.contract_address === NFT_CUTOVER.previous) && proof?.schema === "vox-monad-collection-verification-v1" && proof.owner === NFT_CUTOVER.owner && proof.minter === NFT_CUTOVER.owner && proof.confirmations === 12, "Preserved collection or authority proof is missing");
  for (const field of ["source_sha256", "runtime_sha256", "creation_sha256", "input_sha256"]) requireCheck(typeof proof[field] === "string" && /^[0-9a-f]{64}$/.test(proof[field]), "NFT compiler binding is missing");
  for (const field of ["genesis_hash", "block_hash"]) requireCheck(typeof proof[field] === "string" && /^0x[0-9a-f]{64}$/.test(proof[field]), "NFT finalized block binding is missing");
  requireCheck(/^[1-9][0-9]*$/.test(proof.block_number) && proof.nonce === "1" && proof.gas_limit === "2055157" && proof.max_fee_per_gas_wei === "200000000000" && proof.max_priority_fee_per_gas_wei === "2000000000", "NFT transaction bounds differ from the approved deployment");
  return {chain, proof};
}
function word(value) { const bytes = Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex"); requireCheck(bytes.length === 32, "ABI word overflow"); return bytes; }
function abiString(value) {const bytes = Buffer.from(value); return Buffer.concat([word(bytes.length), bytes, Buffer.alloc((32 - bytes.length % 32) % 32)]);}
export function validateNftArtifact(manifest, source, artifact) {
  const {proof} = validateNftCutover(manifest);
  const metadata = artifact.metadata;
  requireCheck(metadata?.compiler?.version === "0.8.33+commit.64118f21" && metadata.settings?.evmVersion === "cancun" && metadata.settings?.optimizer?.enabled === false && metadata.settings?.compilationTarget?.["contracts/VoxMediaNFT.sol"] === "VoxMediaNFT", "NFT artifact uses different compiler settings");
  const creation = hexBytes(artifact.bytecode?.object), runtime = hexBytes(artifact.deployedBytecode?.object);
  requireCheck(digest(source) === proof.source_sha256 && digest(creation) === proof.creation_sha256 && digest(runtime) === proof.runtime_sha256, "Compiled NFT source/runtime does not match the verified deployment");
  const name = abiString("VOX Media"), symbol = abiString("VOX");
  const input = Buffer.concat([creation, word(96), word(96 + name.length), Buffer.concat([Buffer.alloc(12), hexBytes(NFT_CUTOVER.owner)]), name, symbol]);
  requireCheck(digest(input) === proof.input_sha256, "NFT constructor differs from the approved deployment");
}
export async function verifyNftCutover(manifest, rpc) {
  const {proof} = validateNftCutover(manifest);
  requireCheck(quantity(await rpc("eth_chainId", [])) === 143n, "RPC is not Monad Mainnet");
  const genesis = await rpc("eth_getBlockByNumber", ["0x0", false]);
  requireCheck(genesis?.hash === proof.genesis_hash, "RPC genesis does not match the verified deployment");
  const receipt = await rpc("eth_getTransactionReceipt", [NFT_CUTOVER.transaction]);
  requireCheck(receipt?.status === "0x1" && receipt.transactionHash?.toLowerCase() === NFT_CUTOVER.transaction && receipt.from?.toLowerCase() === NFT_CUTOVER.owner && receipt.to === null && receipt.contractAddress?.toLowerCase() === NFT_CUTOVER.contract && quantity(receipt.blockNumber).toString() === proof.block_number && receipt.blockHash === proof.block_hash, "NFT deployment receipt does not match the verified contract");
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
  requireCheck(block?.hash === proof.block_hash && quantity(finalized?.number) + 1n >= BigInt(proof.block_number) + 12n, "NFT deployment is not canonical with sufficient finalized depth");
  const transaction = await rpc("eth_getTransactionByHash", [NFT_CUTOVER.transaction]);
  requireCheck(transaction?.hash?.toLowerCase() === NFT_CUTOVER.transaction && transaction.from?.toLowerCase() === NFT_CUTOVER.owner && transaction.to === null && quantity(transaction.type) === 2n && quantity(transaction.chainId) === 143n && quantity(transaction.nonce) === 1n && quantity(transaction.value) === 0n && quantity(transaction.gas) === BigInt(proof.gas_limit) && quantity(transaction.maxFeePerGas) === BigInt(proof.max_fee_per_gas_wei) && quantity(transaction.maxPriorityFeePerGas) === BigInt(proof.max_priority_fee_per_gas_wei) && Array.isArray(transaction.accessList) && transaction.accessList.length === 0 && transaction.blockHash === proof.block_hash && quantity(transaction.blockNumber).toString() === proof.block_number && digest(hexBytes(transaction.input)) === proof.input_sha256, "Mined NFT deployment differs from the approved transaction");
  for (const tag of [receipt.blockNumber, "finalized"]) {
    requireCheck(digest(hexBytes(await rpc("eth_getCode", [NFT_CUTOVER.contract, tag]))) === proof.runtime_sha256, "NFT runtime differs from the compiled receiver fix");
    // owner() and minter(); no state-changing method is invoked.
    for (const selector of ["0x8da5cb5b", "0x07546172"]) {
      const value = await rpc("eth_call", [{to: NFT_CUTOVER.contract, data: selector}, tag]);
      requireCheck(typeof value === "string" && value.toLowerCase() === "0x" + "0".repeat(24) + NFT_CUTOVER.owner.slice(2), "NFT owner or minter changed");
    }
  }
  const recheck = await rpc("eth_getTransactionReceipt", [NFT_CUTOVER.transaction]);
  requireCheck(recheck?.status === "0x1" && recheck.blockHash === proof.block_hash && quantity(recheck.blockNumber).toString() === proof.block_number && recheck.contractAddress?.toLowerCase() === NFT_CUTOVER.contract, "NFT receipt changed during verification");
  return NFT_CUTOVER.contract;
}
async function main() {
  const manifest = JSON.parse(readFileSync(new URL("../deployments/nft-mainnet.json", import.meta.url), "utf8"));
  const source = readFileSync(new URL("../contracts/VoxMediaNFT.sol", import.meta.url));
  const {proof} = validateNftCutover(manifest);
  requireCheck(digest(source) === proof.source_sha256, "NFT source changed after the verified deployment");
  if (process.argv.length === 4 && process.argv[2] === "--artifact") {
    validateNftArtifact(manifest, source, JSON.parse(readFileSync(process.argv[3], "utf8")));
    console.log("NFT compiler artifact matches the verified Monad collection");
  } else if (process.argv.length === 3 && process.argv[2] === "--verify-mainnet") {
    for (const endpoint of NFT_CUTOVER.rpcs) {
      let id = 0;
      await verifyNftCutover(manifest, async (method, params) => {
        const requestId = ++id;
        const response = await fetch(endpoint, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: requestId, method, params}), redirect: "error", signal: AbortSignal.timeout(20_000)});
        const payload = await response.json();
        requireCheck(response.ok && payload.jsonrpc === "2.0" && payload.id === requestId && !payload.error && "result" in payload, "NFT public RPC verification failed");
        return payload.result;
      });
    }
    console.log(NFT_CUTOVER.contract);
  } else throw new Error("Use --artifact <fresh Forge artifact> or --verify-mainnet (read-only)");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {console.error(error instanceof Error ? error.message : "NFT contract verification failed"); process.exitCode = 1;});

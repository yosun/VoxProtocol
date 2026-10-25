import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";

type RlpValue = {bytes?: Uint8Array; list?: RlpValue[]};

const rpcUrl = process.env.VOX_NFT_DEPLOY_RPC_URL?.trim();
const expectedChainId = Number.parseInt(process.env.VOX_NFT_DEPLOY_CHAIN_ID ?? "", 10);
const chain = process.env.VOX_NFT_DEPLOY_CHAIN?.trim() ?? "";
const artifactPath = process.env.VOX_NFT_DEPLOY_ARTIFACT?.trim() || ".vox-local/forge-out/VoxMediaNFT.sol/VoxMediaNFT.json";
const collectionName = process.env.VOX_NFT_DEPLOY_COLLECTION_NAME ?? "VOX Media";
const collectionSymbol = process.env.VOX_NFT_DEPLOY_COLLECTION_SYMBOL ?? "VOX";
const explorerBaseUrl = (process.env.VOX_NFT_DEPLOY_EXPLORER_URL ?? "").replace(/\/+$/, "");
const maxGas = BigInt(process.env.VOX_NFT_DEPLOY_MAX_GAS ?? "3000000");
const confirmations = Number.parseInt(process.env.VOX_NFT_DEPLOY_CONFIRMATIONS ?? "12", 10);
if (process.env.VOX_NFT_DEPLOY_CONFIRM !== "1" || !rpcUrl || !Number.isInteger(expectedChainId) || expectedChainId <= 0 || !chain || !explorerBaseUrl || !Number.isInteger(confirmations) || confirmations < 1 || confirmations > 256) throw new Error("Mainnet NFT deployment requires explicit confirmation, RPC, chain ID, chain, explorer, and confirmation settings");
const rpc = new URL(rpcUrl);
if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.search || rpc.hash) throw new Error("deployment RPC must be a clean HTTPS URL");

function bytesToHex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) throw new Error("hex value is invalid");
  const result = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  return result;
}
function bigintBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const result: number[] = [];
  let current = value;
  while (current > 0n) { result.push(Number(current & 0xffn)); current >>= 8n; }
  result.reverse();
  return Uint8Array.from(result);
}
function rlpBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0]! < 0x80) return value;
  if (value.length <= 55) return Uint8Array.from([0x80 + value.length, ...value]);
  const length = bigintBytes(BigInt(value.length));
  return Uint8Array.from([0xb7 + length.length, ...length, ...value]);
}
function rlpList(values: RlpValue[]): Uint8Array {
  const payload = Uint8Array.from(values.flatMap((value) => value.list ? [...rlpList(value.list)] : [...rlpBytes(value.bytes ?? new Uint8Array())]));
  if (payload.length <= 55) return Uint8Array.from([0xc0 + payload.length, ...payload]);
  const length = bigintBytes(BigInt(payload.length));
  return Uint8Array.from([0xf7 + length.length, ...length, ...payload]);
}
function rlpBigint(value: bigint): RlpValue { return {bytes: bigintBytes(value)}; }
function rlpHex(value: string): RlpValue { return {bytes: hexToBytes(value)}; }
function pad32(bytes: Uint8Array): Uint8Array { if (bytes.length > 32) throw new Error("ABI value exceeds 32 bytes"); return Uint8Array.from([...new Array<number>(32 - bytes.length).fill(0), ...bytes]); }
function abiString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return Uint8Array.from([...pad32(bigintBytes(BigInt(bytes.length))), ...bytes, ...new Array<number>((32 - bytes.length % 32) % 32).fill(0)]);
}
function constructorData(bytecode: string, name: string, symbol: string, minter: string): string {
  const encodedName = abiString(name);
  const encodedSymbol = abiString(symbol);
  const head = Uint8Array.from([...pad32(bigintBytes(96n)), ...pad32(bigintBytes(BigInt(96 + encodedName.length))), ...pad32(hexToBytes(minter))]);
  return `0x${bytesToHex(Uint8Array.from([...hexToBytes(bytecode), ...head, ...encodedName, ...encodedSymbol]))}`;
}
function addressFromPrivateKey(privateKey: Uint8Array): string { return `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(-20))}`; }
function createAddress(sender: string, nonce: bigint): string { return `0x${bytesToHex(keccak_256(rlpList([rlpHex(sender), rlpBigint(nonce)])).slice(-20))}`; }
async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpc.href, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  const payload = await response.json() as {result?: unknown; error?: {message?: string}};
  if (payload.error) throw new Error(payload.error.message ?? `RPC ${method} failed`);
  return payload.result;
}
function quantity(value: unknown, label: string): bigint { if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${label} RPC quantity is invalid`); return BigInt(value); }

const secret = readFileSync(0, "utf8").trim();
if (!/^[0-9a-fA-F]{64}$/.test(secret)) throw new Error("deployment signer input must be a 32-byte hex key");
const privateKey = hexToBytes(secret);
const signer = addressFromPrivateKey(privateKey);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {bytecode?: {object?: string}};
const bytecode = artifact.bytecode?.object;
if (!bytecode || !/^0x[0-9a-f]+$/i.test(bytecode)) throw new Error("compiled VoxMediaNFT bytecode is unavailable");
const actualChainId = quantity(await rpcCall("eth_chainId", []), "chain ID");
if (actualChainId !== BigInt(expectedChainId)) throw new Error(`RPC chain ID ${actualChainId} does not match configured ${expectedChainId}`);
const nonce = quantity(await rpcCall("eth_getTransactionCount", [signer, "pending"]), "nonce");
const priority = await rpcCall("eth_maxPriorityFeePerGas", []).then((value) => quantity(value, "priority fee")).catch(() => 1_000_000_000n);
const gasPrice = quantity(await rpcCall("eth_gasPrice", []), "gas price");
const maxPriorityFee = priority > gasPrice ? gasPrice : priority;
const maxFee = gasPrice;
const data = constructorData(bytecode, collectionName, collectionSymbol, signer);
const estimatedGas = quantity(await rpcCall("eth_estimateGas", [{from: signer, data}]), "deployment gas");
if (estimatedGas > maxGas) throw new Error(`deployment estimate ${estimatedGas} exceeds configured gas cap ${maxGas}`);
const gasLimit = estimatedGas + estimatedGas / 10n;
const unsigned = rlpList([rlpBigint(BigInt(expectedChainId)), rlpBigint(nonce), rlpBigint(maxPriorityFee), rlpBigint(maxFee), rlpBigint(gasLimit), rlpHex("0x"), rlpBigint(0n), rlpHex(data), {list: []}]);
const digest = keccak_256(Uint8Array.from([2, ...unsigned]));
const signature = secp256k1.sign(digest, privateKey, {lowS: true});
const signed = rlpList([rlpBigint(BigInt(expectedChainId)), rlpBigint(nonce), rlpBigint(maxPriorityFee), rlpBigint(maxFee), rlpBigint(gasLimit), rlpHex("0x"), rlpBigint(0n), rlpHex(data), {list: []}, rlpBigint(BigInt(signature.recovery ?? 0)), rlpHex(`0x${bytesToHex(signature.toCompactRawBytes().slice(0, 32))}`), rlpHex(`0x${bytesToHex(signature.toCompactRawBytes().slice(32))}`)]);
const raw = Uint8Array.from([2, ...signed]);
const transactionHash = `0x${bytesToHex(keccak_256(raw))}`;
const sent = await rpcCall("eth_sendRawTransaction", [`0x${bytesToHex(raw)}`]);
if (typeof sent !== "string" || sent.toLowerCase() !== transactionHash.toLowerCase()) throw new Error("RPC returned a different deployment transaction hash");
let receipt: {status?: unknown; contractAddress?: unknown; gasUsed?: unknown; effectiveGasPrice?: unknown; blockNumber?: unknown} | null = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  receipt = await rpcCall("eth_getTransactionReceipt", [transactionHash]) as typeof receipt;
  if (receipt) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
if (!receipt || receipt.status !== "0x1" || typeof receipt.contractAddress !== "string") throw new Error("deployment did not finalize successfully");
const deploymentBlock = quantity(receipt.blockNumber, "deployment block");
for (let attempt = 0; attempt < 120; attempt += 1) {
  const latest = quantity(await rpcCall("eth_blockNumber", []), "latest block");
  if (latest + 1n - deploymentBlock >= BigInt(confirmations)) break;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
const gasUsed = quantity(receipt.gasUsed, "gas used");
const effectiveGasPrice = quantity(receipt.effectiveGasPrice, "effective gas price");
console.log(JSON.stringify({chain, chain_id: expectedChainId, signer, contract_address: receipt.contractAddress, transaction_hash: transactionHash, explorer_url: `${explorerBaseUrl}/tx/${transactionHash}`, gas_estimate: estimatedGas.toString(), gas_limit: gasLimit.toString(), gas_used: gasUsed.toString(), effective_gas_price_wei: effectiveGasPrice.toString(), fee_native_wei: (gasUsed * effectiveGasPrice).toString(), nonce: nonce.toString()}, null, 2));

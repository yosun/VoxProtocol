import {createHash} from "node:crypto";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";

export const MONAD = {
  chain: "monad:mainnet", chainId: 143,
  contract: "0x87ef9e71625878a0babeee7864fa7d96ed4e3571",
  owner: "0xafac2571572aa858da801b5c8ed38009c555a4c6",
} as const;
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export interface CompiledContract {
  source_sha256: string; creation_sha256: string; runtime_sha256: string; metadata_sha256: string;
  compiler: string; creation_code: string; runtime_code: string;
}
export interface DeploymentTransaction {
  type: "0x2"; chainId: string; nonce: string; maxPriorityFeePerGas: string;
  maxFeePerGas: string; gas: string; to: null; value: "0x0"; data: string; accessList: [];
}
export interface MigrationPlan {
  schema: "vox-nft-contract-migration-v1"; chain: typeof MONAD.chain; chain_id: 143;
  created_at: string; expires_at: string; source_commit: string; manifest_sha256: string;
  artifact: Omit<CompiledContract, "creation_code" | "runtime_code">;
  genesis_hash: string; existing_contract: string; existing_runtime_sha256: string;
  preserved_owner: string; preserved_minter: string; existing_next_token_id: string;
  observed_block: string; observed_block_hash: string; observed_balance_wei: string;
  estimated_gas: string; gas_cap: string; max_total_fee_wei: string; minimum_remaining_balance_wei: string;
  confirmations: number; predicted_contract: string; transaction: DeploymentTransaction;
  signing_digest: string; plan_sha256: string;
}
export interface PlanLimits {
  gasCap: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  maxTotalFee: bigint; minimumRemainingBalance: bigint; confirmations: number; lifetimeSeconds: number;
}
type Rlp = Uint8Array | Rlp[];
const HEX = /^0x(?:[0-9a-f]{2})*$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
export const hex = (value: Uint8Array): string => `0x${Buffer.from(value).toString("hex")}`;
export function bytes(value: unknown, label = "bytes"): Uint8Array {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error(`${label} must be even-length hex bytes`);
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}
export function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error(`${label} must be a canonical RPC quantity`);
  return BigInt(value);
}
export function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be an unsigned decimal integer`);
  return BigInt(value);
}
const q = (value: bigint): string => `0x${value.toString(16)}`;
export const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid plan value");
  return JSON.stringify(value);
}
export function planHash(plan: Omit<MigrationPlan, "plan_sha256"> | MigrationPlan): string {
  const {plan_sha256: ignored, ...payload} = plan as MigrationPlan;
  return sha256(`vox:nft:migration:v1\n${canonical(payload)}`);
}
function numberBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative RLP integer");
  return value === 0n ? new Uint8Array() : bytes(`0x${value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0")}`);
}
function concat(...parts: Uint8Array[]): Uint8Array { return Uint8Array.from(Buffer.concat(parts)); }
export function encodeRlp(value: Rlp): Uint8Array {
  const payload = Array.isArray(value) ? concat(...value.map(encodeRlp)) : value;
  if (!Array.isArray(value) && payload.length === 1 && payload[0]! < 0x80) return payload;
  const offset = Array.isArray(value) ? 0xc0 : 0x80;
  return payload.length <= 55 ? concat(Uint8Array.of(offset + payload.length), payload) : concat(Uint8Array.of(offset + 55 + numberBytes(BigInt(payload.length)).length), numberBytes(BigInt(payload.length)), payload);
}
function decodeRlp(raw: Uint8Array): Rlp {
  let cursor = 0;
  function read(depth: number): Rlp {
    if (depth > 2 || cursor >= raw.length) throw new Error("invalid RLP nesting or length");
    const prefix = raw[cursor++]!;
    if (prefix < 0x80) return Uint8Array.of(prefix);
    const list = prefix >= 0xc0;
    const base = list ? 0xc0 : 0x80;
    let length = prefix - base;
    if (length > 55) {
      const count = length - 55;
      if (count > 4 || cursor + count > raw.length || raw[cursor] === 0) throw new Error("invalid RLP length");
      length = Number(BigInt(hex(raw.slice(cursor, cursor + count))));
      cursor += count;
      if (length <= 55) throw new Error("noncanonical RLP length");
    }
    const end = cursor + length;
    if (end > raw.length) throw new Error("truncated RLP");
    if (!list) {
      const result = raw.slice(cursor, end); cursor = end;
      if (length === 1 && result[0]! < 0x80) throw new Error("noncanonical RLP byte");
      return result;
    }
    const result: Rlp[] = [];
    while (cursor < end) result.push(read(depth + 1));
    if (cursor !== end) throw new Error("invalid RLP list length");
    return result;
  }
  const result = read(0);
  if (cursor !== raw.length || hex(encodeRlp(result)) !== hex(raw)) throw new Error("noncanonical RLP");
  return result;
}
export function transactionFields(tx: DeploymentTransaction): Rlp[] {
  const feeFields = [tx.chainId, tx.nonce, tx.maxPriorityFeePerGas, tx.maxFeePerGas, tx.gas].map((value) => numberBytes(quantity(value, "transaction quantity")));
  return [...feeFields, new Uint8Array(), numberBytes(quantity(tx.value, "value")), bytes(tx.data), []];
}
export const signingDigest = (tx: DeploymentTransaction): string => hex(keccak_256(concat(Uint8Array.of(2), encodeRlp(transactionFields(tx)))));
export function createAddress(sender: string, nonce: bigint): string {
  if (!ADDRESS.test(sender)) throw new Error("invalid deployer address");
  return hex(keccak_256(encodeRlp([bytes(sender), numberBytes(nonce)])).slice(-20));
}
function word(value: Uint8Array): Uint8Array {
  if (value.length > 32) throw new Error("ABI word too long");
  return concat(new Uint8Array(32 - value.length), value);
}
function abiString(value: string): Uint8Array {
  const data = new TextEncoder().encode(value);
  return concat(word(numberBytes(BigInt(data.length))), data, new Uint8Array((32 - data.length % 32) % 32));
}
export function constructorData(creationCode: string): string {
  const name = abiString("VOX Media"); const symbol = abiString("VOX");
  return hex(concat(bytes(creationCode), word(numberBytes(96n)), word(numberBytes(BigInt(96 + name.length))), word(bytes(MONAD.owner)), name, symbol));
}
export function compileBinding(source: string, artifact: any): CompiledContract {
  const metadata = artifact.metadata;
  if (metadata?.compiler?.version !== "0.8.33+commit.64118f21" || metadata?.language !== "Solidity" || metadata?.settings?.evmVersion !== "cancun" || metadata?.settings?.optimizer?.enabled !== false || metadata?.settings?.compilationTarget?.["contracts/VoxMediaNFT.sol"] !== "VoxMediaNFT") throw new Error("artifact compiler/settings differ from the pinned contract build");
  if (Object.keys(metadata.sources ?? {}).join() !== "contracts/VoxMediaNFT.sol" || metadata.sources["contracts/VoxMediaNFT.sol"].keccak256 !== hex(keccak_256(new TextEncoder().encode(source)))) throw new Error("artifact does not match the current contract source");
  for (const part of [artifact.bytecode, artifact.deployedBytecode]) if (!part?.object || bytes(part.object).length === 0 || Object.keys(part.linkReferences ?? {}).length) throw new Error("contract artifact contains unavailable or linked bytecode");
  if (Object.keys(artifact.deployedBytecode.immutableReferences ?? {}).length) throw new Error("unsupported immutable runtime references");
  return {compiler: metadata.compiler.version, source_sha256: sha256(source), creation_sha256: sha256(bytes(artifact.bytecode.object)), runtime_sha256: sha256(bytes(artifact.deployedBytecode.object)), metadata_sha256: sha256(canonical(metadata)), creation_code: artifact.bytecode.object.toLowerCase(), runtime_code: artifact.deployedBytecode.object.toLowerCase()};
}
export function validateManifest(text: string): string {
  const manifest = JSON.parse(text);
  const current = manifest.chains?.[MONAD.chain];
  if (manifest.environment !== "production" || manifest.projectId !== "voxprotocol" || current?.chain_id !== MONAD.chainId || current.contract_address?.toLowerCase() !== MONAD.contract || current.signer?.toLowerCase() !== MONAD.owner) throw new Error("the production manifest no longer matches the approved existing Monad identity; review separately");
  return sha256(text);
}
function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a 32-byte hash`);
  return value.toLowerCase();
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} RPC object is unavailable`);
  return value as Record<string, unknown>;
}
const selector = (signature: string): string => hex(keccak_256(new TextEncoder().encode(signature)).slice(0, 4));
async function readAddress(rpc: Rpc, contract: string, signature: string, block: string): Promise<string> {
  const value = bytes(await rpc("eth_call", [{to: contract, data: selector(signature)}, block]), signature);
  if (value.length !== 32 || value.slice(0, 12).some((part) => part !== 0)) throw new Error(`invalid ${signature} response`);
  return hex(value.slice(12));
}
async function readTokenId(rpc: Rpc, contract: string, block: string): Promise<bigint> {
  const value = bytes(await rpc("eth_call", [{to: contract, data: selector("nextTokenId()")}, block]));
  if (value.length !== 32) throw new Error("invalid nextTokenId response");
  return BigInt(hex(value));
}
export async function checkNetwork(rpc: Rpc, expectedGenesis?: string): Promise<string> {
  if (quantity(await rpc("eth_chainId", []), "chain ID") !== BigInt(MONAD.chainId)) throw new Error("RPC is not Monad Mainnet chain 143");
  const genesis = object(await rpc("eth_getBlockByNumber", ["0x0", false]), "genesis");
  const result = hash(genesis.hash, "genesis hash");
  if (expectedGenesis && result !== expectedGenesis) throw new Error("RPC genesis differs from the reviewed plan");
  return result;
}
async function currentIdentity(rpc: Rpc, block: string): Promise<{code: string; nextTokenId: bigint}> {
  const code = hex(bytes(await rpc("eth_getCode", [MONAD.contract, block])));
  if (code === "0x") throw new Error("existing Monad collection has no deployed code");
  for (const signature of ["owner()", "minter()"]) if (await readAddress(rpc, MONAD.contract, signature, block) !== MONAD.owner) throw new Error(`existing ${signature} differs from the preserved identity`);
  return {code, nextTokenId: await readTokenId(rpc, MONAD.contract, block)};
}
function validateLimits(limits: PlanLimits): void {
  if (limits.gasCap < 21_000n || limits.gasCap > 30_000_000n || limits.maxFeePerGas <= 0n || limits.maxPriorityFeePerGas <= 0n || limits.maxPriorityFeePerGas > limits.maxFeePerGas || limits.maxTotalFee <= 0n || limits.minimumRemainingBalance < 0n || !Number.isInteger(limits.confirmations) || limits.confirmations < 12 || limits.confirmations > 256 || !Number.isInteger(limits.lifetimeSeconds) || limits.lifetimeSeconds < 60 || limits.lifetimeSeconds > 3600) throw new Error("invalid explicit gas, native fee, reserve, confirmation, or lifetime limit");
}
export async function prepareMigration(rpc: Rpc, compiled: CompiledContract, manifestSha: string, sourceCommit: string, limits: PlanLimits, now = new Date()): Promise<MigrationPlan> {
  validateLimits(limits);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("source commit must be a full Git SHA");
  const genesis = await checkNetwork(rpc);
  const block = object(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized block");
  const blockNumber = q(quantity(block.number, "finalized block"));
  const old = await currentIdentity(rpc, blockNumber);
  const latestNonce = quantity(await rpc("eth_getTransactionCount", [MONAD.owner, "latest"]), "latest nonce");
  const nonce = quantity(await rpc("eth_getTransactionCount", [MONAD.owner, "pending"]), "pending nonce");
  if (nonce !== latestNonce) throw new Error("the existing minter has a pending transaction; wait and replan");
  if (bytes(await rpc("eth_getCode", [MONAD.owner, "latest"])).length !== 0) throw new Error("deployer is no longer an ordinary EOA");
  const predicted = createAddress(MONAD.owner, nonce);
  if (bytes(await rpc("eth_getCode", [predicted, "latest"])).length !== 0) throw new Error("predicted deployment address is occupied");
  const gasPrice = quantity(await rpc("eth_gasPrice", []), "gas price");
  if (gasPrice > limits.maxFeePerGas) throw new Error("current gas price exceeds the explicit per-gas fee cap");
  const data = constructorData(compiled.creation_code);
  const estimated = quantity(await rpc("eth_estimateGas", [{from: MONAD.owner, data, value: "0x0"}]), "estimated gas");
  const gas = (estimated * 110n + 99n) / 100n;
  if (estimated === 0n || gas > limits.gasCap) throw new Error("deployment gas including its 10% buffer exceeds the gas cap");
  const maximumFee = gas * limits.maxFeePerGas;
  if (maximumFee > limits.maxTotalFee) throw new Error("maximum native deployment fee exceeds the explicit total fee cap");
  const balance = quantity(await rpc("eth_getBalance", [MONAD.owner, "pending"]), "pending balance");
  if (balance < maximumFee + limits.minimumRemainingBalance) throw new Error("deployer balance does not cover the maximum fee and required reserve");
  const transaction: DeploymentTransaction = {type: "0x2", chainId: q(BigInt(MONAD.chainId)), nonce: q(nonce), maxPriorityFeePerGas: q(limits.maxPriorityFeePerGas), maxFeePerGas: q(limits.maxFeePerGas), gas: q(gas), to: null, value: "0x0", data, accessList: []};
  const {creation_code: ignoredCreation, runtime_code: ignoredRuntime, ...artifact} = compiled;
  const payload: Omit<MigrationPlan, "plan_sha256"> = {schema: "vox-nft-contract-migration-v1", chain: MONAD.chain, chain_id: 143, created_at: now.toISOString(), expires_at: new Date(now.getTime() + limits.lifetimeSeconds * 1000).toISOString(), source_commit: sourceCommit, manifest_sha256: manifestSha, artifact, genesis_hash: genesis, existing_contract: MONAD.contract, existing_runtime_sha256: sha256(bytes(old.code)), preserved_owner: MONAD.owner, preserved_minter: MONAD.owner, existing_next_token_id: old.nextTokenId.toString(), observed_block: blockNumber, observed_block_hash: hash(block.hash, "observed block hash"), observed_balance_wei: balance.toString(), estimated_gas: estimated.toString(), gas_cap: limits.gasCap.toString(), max_total_fee_wei: limits.maxTotalFee.toString(), minimum_remaining_balance_wei: limits.minimumRemainingBalance.toString(), confirmations: limits.confirmations, predicted_contract: predicted, transaction, signing_digest: signingDigest(transaction)};
  return {...payload, plan_sha256: planHash(payload)};
}
export function validatePlan(plan: MigrationPlan, compiled: CompiledContract, manifestSha: string): void {
  if (!/^[0-9a-f]{40}$/.test(plan.source_commit) || plan.schema !== "vox-nft-contract-migration-v1" || plan.plan_sha256 !== planHash(plan) || plan.chain !== MONAD.chain || plan.chain_id !== 143 || plan.existing_contract !== MONAD.contract || plan.preserved_owner !== MONAD.owner || plan.preserved_minter !== MONAD.owner || plan.manifest_sha256 !== manifestSha) throw new Error("plan identity, contents, or manifest changed");
  const {creation_code: ignoredCreation, runtime_code: ignoredRuntime, ...binding} = compiled;
  if (canonical(plan.artifact) !== canonical(binding) || plan.transaction.data !== constructorData(compiled.creation_code)) throw new Error("plan artifact or constructor differs from the rebuilt source");
  const tx = plan.transaction;
  if (tx.type !== "0x2" || tx.chainId !== "0x8f" || tx.to !== null || tx.value !== "0x0" || !Array.isArray(tx.accessList) || tx.accessList.length || signingDigest(tx) !== plan.signing_digest || createAddress(MONAD.owner, quantity(tx.nonce, "nonce")) !== plan.predicted_contract) throw new Error("plan is not the exact reviewed contract creation transaction");
  const limits = {gasCap: decimal(plan.gas_cap, "gas cap"), maxFeePerGas: quantity(tx.maxFeePerGas, "max fee"), maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas, "priority fee"), maxTotalFee: decimal(plan.max_total_fee_wei, "total fee"), minimumRemainingBalance: decimal(plan.minimum_remaining_balance_wei, "reserve"), confirmations: plan.confirmations, lifetimeSeconds: (Date.parse(plan.expires_at) - Date.parse(plan.created_at)) / 1000};
  validateLimits(limits);
  const gas = quantity(tx.gas, "gas");
  if (gas !== (decimal(plan.estimated_gas, "estimate") * 110n + 99n) / 100n || gas === 0n || gas > limits.gasCap || gas * limits.maxFeePerGas > limits.maxTotalFee) throw new Error("plan gas or total fee exceeds its limits");
}
export function validateSignedTransaction(tx: DeploymentTransaction, expectedSigner: string, rawHex: string): string {
  const raw = bytes(rawHex, "signed transaction");
  if (raw.length > 65_536 || raw[0] !== 2) throw new Error("only bounded type-2 signed transactions are supported");
  const decoded = decodeRlp(raw.slice(1));
  if (!Array.isArray(decoded) || decoded.length !== 12 || hex(encodeRlp(decoded.slice(0, 9))) !== hex(encodeRlp(transactionFields(tx)))) throw new Error("signed transaction changes a reviewed transaction field");
  const integer = (value: Rlp | undefined): bigint => {
    if (!(value instanceof Uint8Array) || value.length > 32 || value[0] === 0) throw new Error("invalid signature integer");
    return value.length ? BigInt(hex(value)) : 0n;
  };
  const recovery = integer(decoded[9]); const r = integer(decoded[10]); const s = integer(decoded[11]);
  if (recovery > 1n || r === 0n || s === 0n || s > secp256k1.CURVE.n / 2n) throw new Error("invalid or noncanonical transaction signature");
  const point = new secp256k1.Signature(r, s).addRecoveryBit(Number(recovery)).recoverPublicKey(bytes(signingDigest(tx))).toRawBytes(false);
  if (hex(keccak_256(point.slice(1)).slice(-20)) !== expectedSigner.toLowerCase()) throw new Error("signed transaction does not belong to the preserved deployer");
  return hex(keccak_256(raw));
}
export async function preflightApply(rpc: Rpc, plan: MigrationPlan, now = new Date()): Promise<void> {
  if (now.getTime() < Date.parse(plan.created_at) || now.getTime() >= Date.parse(plan.expires_at)) throw new Error("plan expired or is dated in the future; verify existing evidence, then replan if never submitted");
  await checkNetwork(rpc, plan.genesis_hash);
  const observed = object(await rpc("eth_getBlockByNumber", [plan.observed_block, false]), "reviewed observation block");
  if (hash(observed.hash, "observation block hash") !== plan.observed_block_hash) throw new Error("reviewed finalized observation block changed");
  const old = await currentIdentity(rpc, "latest");
  if (sha256(bytes(old.code)) !== plan.existing_runtime_sha256) throw new Error("existing collection bytecode changed");
  const tx = plan.transaction;
  for (const tag of ["latest", "pending"]) if (quantity(await rpc("eth_getTransactionCount", [MONAD.owner, tag]), `${tag} nonce`) !== quantity(tx.nonce, "planned nonce")) throw new Error("minter nonce changed; preserve journal and review instead of replacing a transaction");
  if (bytes(await rpc("eth_getCode", [MONAD.owner, "latest"])).length || bytes(await rpc("eth_getCode", [plan.predicted_contract, "latest"])).length) throw new Error("deployer or predicted contract address is no longer empty");
  if (quantity(await rpc("eth_gasPrice", []), "gas price") > quantity(tx.maxFeePerGas, "max fee")) throw new Error("current gas price exceeds the reviewed cap");
  if (quantity(await rpc("eth_estimateGas", [{from: MONAD.owner, data: tx.data, value: "0x0"}]), "gas estimate") > quantity(tx.gas, "gas limit")) throw new Error("current gas estimate exceeds the reviewed gas limit");
  const balance = quantity(await rpc("eth_getBalance", [MONAD.owner, "pending"]), "pending balance");
  if (balance < quantity(tx.gas, "gas") * quantity(tx.maxFeePerGas, "max fee") + decimal(plan.minimum_remaining_balance_wei, "reserve")) throw new Error("deployer can no longer cover the reviewed fee plus reserve");
}
export async function verifyDeployment(rpc: Rpc, plan: MigrationPlan, transactionHash: string, compiled: CompiledContract): Promise<{state: "pending"} | {state: "finalized"; contract_address: string; transaction_hash: string; block_hash: string; gas_used: string; fee_native_wei: string}> {
  await checkNetwork(rpc, plan.genesis_hash);
  hash(transactionHash, "transaction hash");
  const receiptValue = await rpc("eth_getTransactionReceipt", [transactionHash]);
  if (!receiptValue) return {state: "pending"};
  const receipt = object(receiptValue, "receipt");
  if (receipt.status !== "0x1") throw new Error("deployment execution failed or receipt status is invalid; do not automatically retry");
  if (String(receipt.transactionHash).toLowerCase() !== transactionHash || String(receipt.from).toLowerCase() !== MONAD.owner || receipt.to !== null || String(receipt.contractAddress).toLowerCase() !== plan.predicted_contract) throw new Error("deployment receipt identity does not match the plan");
  const blockNumber = quantity(receipt.blockNumber, "receipt block"); const blockHash = hash(receipt.blockHash, "receipt block hash");
  const gasUsed = quantity(receipt.gasUsed, "gas used"); const effective = quantity(receipt.effectiveGasPrice, "effective gas price");
  if (gasUsed > quantity(plan.transaction.gas, "gas limit") || effective > quantity(plan.transaction.maxFeePerGas, "max fee") || gasUsed * effective > decimal(plan.max_total_fee_wei, "total fee")) throw new Error("receipt fee exceeds the reviewed budget");
  const chainTx = object(await rpc("eth_getTransactionByHash", [transactionHash]), "deployment transaction");
  const planned = plan.transaction;
  for (const field of ["type", "chainId", "nonce", "maxPriorityFeePerGas", "maxFeePerGas", "gas", "value"] as const) if (quantity(chainTx[field], field) !== quantity(planned[field], field)) throw new Error(`mined transaction ${field} differs from plan`);
  if (!Array.isArray(chainTx.accessList) || chainTx.accessList.length !== 0) throw new Error("mined transaction access list differs from plan");
  if (String(chainTx.hash).toLowerCase() !== transactionHash || String(chainTx.from).toLowerCase() !== MONAD.owner || chainTx.to !== null || String(chainTx.input).toLowerCase() !== planned.data || hash(chainTx.blockHash, "transaction block hash") !== blockHash || quantity(chainTx.blockNumber, "transaction block") !== blockNumber) throw new Error("mined transaction identity differs from plan");
  const canonicalBlock = object(await rpc("eth_getBlockByNumber", [q(blockNumber), false]), "canonical receipt block");
  if (hash(canonicalBlock.hash, "canonical block hash") !== blockHash) throw new Error("deployment receipt was reorganized; preserve the journal and investigate");
  const finalized = object(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized head");
  if (quantity(finalized.number, "finalized head") + 1n < blockNumber + BigInt(plan.confirmations)) return {state: "pending"};
  for (const tag of [q(blockNumber), "finalized"]) {
    const code = bytes(await rpc("eth_getCode", [plan.predicted_contract, tag]));
    if (sha256(code) !== compiled.runtime_sha256) throw new Error("deployed runtime differs from the approved compiled contract");
    for (const signature of ["owner()", "minter()"]) if (await readAddress(rpc, plan.predicted_contract, signature, tag) !== MONAD.owner) throw new Error(`new collection ${signature} differs from the preserved identity`);
  }
  if (await readTokenId(rpc, plan.predicted_contract, q(blockNumber)) !== 1n) throw new Error("new collection unexpectedly already had tokens at its deployment block");
  const recheck = object(await rpc("eth_getTransactionReceipt", [transactionHash]), "rechecked receipt");
  if (recheck.status !== "0x1" || hash(recheck.blockHash, "rechecked block") !== blockHash || quantity(recheck.blockNumber, "rechecked number") !== blockNumber || String(recheck.contractAddress).toLowerCase() !== plan.predicted_contract) throw new Error("deployment receipt changed during finality verification");
  return {state: "finalized", contract_address: plan.predicted_contract, transaction_hash: transactionHash, block_hash: blockHash, gas_used: gasUsed.toString(), fee_native_wei: (gasUsed * effective).toString()};
}

import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {secp256k1} from "@noble/curves/secp256k1";
import {keccak_256} from "@noble/hashes/sha3.js";
import {bytes, compileBinding, createAddress, encodeRlp, hex, MONAD, planHash, preflightApply, prepareMigration, sha256, signingDigest, transactionFields, validateManifest, validatePlan, validateSignedTransaction, verifyDeployment, type CompiledContract, type DeploymentTransaction, type MigrationPlan, type PlanLimits, type Rpc} from "../scripts/lib/nft-contract-migration.js";

const source = "contract source fixture";
const compiled: CompiledContract = {compiler: "0.8.33+commit.64118f21", source_sha256: sha256(source), creation_sha256: sha256(bytes("0x6001")), runtime_sha256: sha256(bytes("0x6002")), metadata_sha256: sha256("metadata"), creation_code: "0x6001", runtime_code: "0x6002"};
const manifest = readFileSync(new URL("../deployments/nft-mainnet.json", import.meta.url), "utf8");
const manifestSha = validateManifest(manifest);
const now = new Date("2026-11-07T12:00:00.000Z");
const HASH = `0x${"ab".repeat(32)}`; const BLOCK_HASH = `0x${"cd".repeat(32)}`; const TX_HASH = `0x${"ef".repeat(32)}`;
const limits: PlanLimits = {gasCap: 3_000_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, maxTotalFee: 300_000_000_000_000_000n, minimumRemainingBalance: 1_000_000_000_000_000_000n, confirmations: 12, lifetimeSeconds: 900};
const selector = (value: string): string => hex(keccak_256(new TextEncoder().encode(value)).slice(0, 4));
const addressWord = (value: string): string => `0x${"00".repeat(12)}${value.slice(2)}`;
const intWord = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;
function fixture(overrides: Partial<{chain: string; latestNonce: string; pendingNonce: string; estimate: string; balance: string; owner: string; minter: string; gasPrice: string; predictedCode: string}> = {}): {rpc: Rpc; calls: string[]} {
  const calls: string[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    if (method === "eth_chainId") return overrides.chain ?? "0x8f";
    if (method === "eth_getBlockByNumber") return {number: params[0] === "0x0" ? "0x0" : "0x64", hash: params[0] === "0x0" ? HASH : BLOCK_HASH};
    if (method === "eth_getTransactionCount") return params[1] === "pending" ? overrides.pendingNonce ?? "0x1" : overrides.latestNonce ?? "0x1";
    if (method === "eth_gasPrice") return overrides.gasPrice ?? "0x174876e800";
    if (method === "eth_estimateGas") return overrides.estimate ?? "0x1e8480";
    if (method === "eth_getBalance") return overrides.balance ?? "0xad78ebc5ac6200000";
    if (method === "eth_getCode") return params[0] === MONAD.contract ? "0x6000" : params[0] === MONAD.owner ? "0x" : overrides.predictedCode ?? "0x";
    if (method === "eth_call") {
      const call = params[0] as {data: string};
      if (call.data === selector("owner()")) return addressWord(overrides.owner ?? MONAD.owner);
      if (call.data === selector("minter()")) return addressWord(overrides.minter ?? MONAD.owner);
      if (call.data === selector("nextTokenId()")) return intWord(1n);
    }
    throw new Error(`unexpected RPC ${method}`);
  };
  return {rpc, calls};
}
const makePlan = async (rpc = fixture().rpc, caps = limits): Promise<MigrationPlan> => prepareMigration(rpc, compiled, manifestSha, "a".repeat(40), caps, now);
function minedRpc(plan: MigrationPlan, change: {receipt?: Record<string, unknown>; transaction?: Record<string, unknown>; confirmations?: number; canonicalHash?: string; runtime?: string; owner?: string; reorgOnRecheck?: boolean} = {}): Rpc {
  let receiptReads = 0;
  const receipt = {status: "0x1", transactionHash: TX_HASH, from: MONAD.owner, to: null, contractAddress: plan.predicted_contract, blockNumber: "0x64", blockHash: BLOCK_HASH, gasUsed: "0x1e8480", effectiveGasPrice: "0x174876e800", ...change.receipt};
  return async (method, params) => {
    if (method === "eth_chainId") return "0x8f";
    if (method === "eth_getTransactionReceipt") {
      receiptReads++;
      return change.reorgOnRecheck && receiptReads > 1 ? {...receipt, blockHash: HASH} : receipt;
    }
    if (method === "eth_getTransactionByHash") return {hash: TX_HASH, from: MONAD.owner, ...plan.transaction, input: plan.transaction.data, blockNumber: "0x64", blockHash: BLOCK_HASH, ...change.transaction};
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? {number: "0x0", hash: HASH} : params[0] === "finalized" ? {number: `0x${(100 + (change.confirmations ?? 12) - 1).toString(16)}`, hash: HASH} : {number: "0x64", hash: change.canonicalHash ?? BLOCK_HASH};
    if (method === "eth_getCode") return change.runtime ?? compiled.runtime_code;
    if (method === "eth_call") {
      const call = params[0] as {data: string};
      return call.data === selector("nextTokenId()") ? intWord(1n) : addressWord(change.owner ?? MONAD.owner);
    }
    throw new Error(`unexpected RPC ${method}`);
  };
}

describe("Monad collection migration planning", () => {
  it("plans the exact preserved identity and constructor without any signer or broadcast RPC", async () => {
    const {rpc, calls} = fixture();
    const plan = await makePlan(rpc);
    validatePlan(plan, compiled, manifestSha);
    expect(plan.preserved_owner).toBe(MONAD.owner);
    expect(plan.predicted_contract).toBe(createAddress(MONAD.owner, 1n));
    expect(plan.estimated_gas).toBe("2000000");
    expect(plan.transaction.gas).toBe("0x2191c0"); // 2,200,000 including the buffer.
    expect(plan.transaction.to).toBeNull();
    expect(plan.transaction.value).toBe("0x0");
    expect(plan.transaction.data).toContain(MONAD.owner.slice(2));
    expect(plan.plan_sha256).toBe(planHash(plan));
    expect(calls.every((method) => !/send|sign/i.test(method))).toBe(true);
  });
  it.each([
    [{chain: "0x27af"}, /chain 143/],
    [{pendingNonce: "0x2"}, /pending transaction/],
    [{owner: "0x" + "12".repeat(20)}, /owner/],
    [{minter: "0x" + "12".repeat(20)}, /minter/],
    [{predictedCode: "0x6001"}, /occupied/],
    [{gasPrice: "0x174876e801"}, /per-gas fee cap/],
    [{balance: "0x1"}, /balance/],
    [{estimate: "0x2bc200"}, /including its 10% buffer/],
  ] as const)("fails closed on changed network, identity, nonce, occupancy, fee, balance or buffered gas: %j", async (overrides, error) => {
    await expect(makePlan(fixture(overrides).rpc)).rejects.toThrow(error);
  });
  it("caps the worst-case fee, even when the current estimate is affordable", async () => {
    await expect(makePlan(fixture().rpc, {...limits, maxTotalFee: 210_000_000_000_000_000n})).rejects.toThrow(/total fee cap/);
  });
  it.each(["gasCap", "maxFeePerGas", "maxTotalFee"] as const)("rejects zero %s", async (field) => {
    await expect(makePlan(fixture().rpc, {...limits, [field]: 0n})).rejects.toThrow(/invalid explicit/);
  });
  it("rejects silent changes to the pinned production identity", () => {
    const changed = JSON.parse(manifest);
    changed.chains[MONAD.chain].signer = "0x" + "12".repeat(20);
    expect(() => validateManifest(JSON.stringify(changed))).toThrow(/identity/);
  });
  it("binds every plan field, rebuilt bytecode, source and manifest", async () => {
    const plan = await makePlan();
    expect(() => validatePlan({...plan, max_total_fee_wei: "999999999999999999999"}, compiled, manifestSha)).toThrow(/contents/);
    expect(() => validatePlan(plan, {...compiled, runtime_sha256: "a".repeat(64)}, manifestSha)).toThrow(/artifact/);
    expect(() => validatePlan(plan, compiled, "b".repeat(64))).toThrow(/manifest/);
    const changed = {...plan, preserved_owner: "0x" + "12".repeat(20)};
    changed.plan_sha256 = planHash(changed);
    expect(() => validatePlan(changed, compiled, manifestSha)).toThrow(/identity/);
  });
  it("checks compiler metadata against the actual source rather than trusting stale artifacts", () => {
    const artifact = {metadata: {compiler: {version: "0.8.33+commit.64118f21"}, language: "Solidity", settings: {evmVersion: "cancun", optimizer: {enabled: false}, compilationTarget: {"contracts/VoxMediaNFT.sol": "VoxMediaNFT"}}, sources: {"contracts/VoxMediaNFT.sol": {keccak256: hex(keccak_256(new TextEncoder().encode(source)))}}}, bytecode: {object: "0x6001", linkReferences: {}}, deployedBytecode: {object: "0x6002", linkReferences: {}}};
    expect(compileBinding(source, artifact).runtime_sha256).toBe(compiled.runtime_sha256);
    expect(() => compileBinding(source + " changed", artifact)).toThrow(/current contract source/);
    expect(() => compileBinding(source, {...artifact, metadata: {...artifact.metadata, compiler: {version: "0.8.24"}}})).toThrow(/pinned contract build/);
  });
  it("rechecks expiry, nonce, balance and network before an initial or repeated broadcast", async () => {
    const plan = await makePlan();
    await expect(preflightApply(fixture().rpc, plan, now)).resolves.toBeUndefined();
    await expect(preflightApply(fixture().rpc, plan, new Date("2026-11-07T12:15:00Z"))).rejects.toThrow(/expired/);
    await expect(preflightApply(fixture({pendingNonce: "0x2"}).rpc, plan, now)).rejects.toThrow(/nonce changed/);
    await expect(preflightApply(fixture({balance: "0x1"}).rpc, plan, now)).rejects.toThrow(/reserve/);
    await expect(preflightApply(fixture({chain: "0x1"}).rpc, plan, now)).rejects.toThrow(/chain 143/);
  });
});

describe("offline deployment signature binding", () => {
  // Public disposable fixture key only. This suite never reads a production signer or contacts a network.
  const key = new Uint8Array(32).fill(7);
  const signer = hex(keccak_256(secp256k1.getPublicKey(key, false).slice(1)).slice(-20));
  function sign(tx: DeploymentTransaction): string {
    const sig = secp256k1.sign(bytes(signingDigest(tx)), key, {lowS: true});
    const encodeInt = (value: bigint): Uint8Array => value === 0n ? new Uint8Array() : bytes(`0x${value.toString(16).padStart(Math.ceil(value.toString(16).length / 2) * 2, "0")}`);
    return hex(Uint8Array.from([2, ...encodeRlp([...transactionFields(tx), encodeInt(BigInt(sig.recovery!)), encodeInt(sig.r), encodeInt(sig.s)])]));
  }
  it("accepts only the exact unsigned transaction and recovered sender", async () => {
    const {transaction: tx} = await makePlan(); const raw = sign(tx);
    expect(validateSignedTransaction(tx, signer, raw)).toBe(hex(keccak_256(bytes(raw))));
    expect(() => validateSignedTransaction(tx, MONAD.owner, raw)).toThrow(/preserved deployer/);
    expect(() => validateSignedTransaction({...tx, maxFeePerGas: "0x1"}, signer, raw)).toThrow(/changes a reviewed/);
    expect(() => validateSignedTransaction({...tx, data: `${tx.data}00`}, signer, raw)).toThrow(/changes a reviewed/);
  });
  it("rejects truncated, trailing, and other transaction types", async () => {
    const {transaction: tx} = await makePlan(); const raw = sign(tx);
    for (const invalid of [raw.slice(0, -2), `${raw}00`, `0x01${raw.slice(4)}`, "0x02c0"]) expect(() => validateSignedTransaction(tx, signer, invalid)).toThrow();
  });
});

describe("deployment receipt and finality verification", () => {
  it("requires successful canonical finalized deployment, exact runtime/owner/minter, and actual fee evidence", async () => {
    const plan = await makePlan();
    const result = await verifyDeployment(minedRpc(plan), plan, TX_HASH, compiled);
    expect(result).toMatchObject({state: "finalized", contract_address: plan.predicted_contract, fee_native_wei: "200000000000000000"});
  });
  it("reports pending instead of success before the full finalized-block depth", async () => {
    const plan = await makePlan();
    expect(await verifyDeployment(minedRpc(plan, {confirmations: 11}), plan, TX_HASH, compiled)).toEqual({state: "pending"});
    const rpc: Rpc = async (method, params) => method === "eth_getTransactionReceipt" ? null : fixture().rpc(method, params);
    expect(await verifyDeployment(rpc, plan, TX_HASH, compiled)).toEqual({state: "pending"});
  });
  it.each([
    [{receipt: {status: "0x0"}}, /execution failed/],
    [{receipt: {contractAddress: "0x" + "12".repeat(20)}}, /receipt identity/],
    [{receipt: {gasUsed: "0x2dc6c0"}}, /budget/],
    [{transaction: {input: "0x6000"}}, /transaction identity/],
    [{transaction: {nonce: "0x2"}}, /nonce differs/],
    [{transaction: {accessList: [{address: MONAD.owner, storageKeys: []}]}}, /access list differs/],
    [{canonicalHash: HASH}, /reorganized/],
    [{runtime: "0x6003"}, /runtime differs/],
    [{owner: "0x" + "12".repeat(20)}, /preserved identity/],
    [{reorgOnRecheck: true}, /changed during finality/],
  ])("rejects changed/failed/reorganized transaction evidence: %j", async (change, error) => {
    const plan = await makePlan();
    await expect(verifyDeployment(minedRpc(plan, change), plan, TX_HASH, compiled)).rejects.toThrow(error);
  });
});

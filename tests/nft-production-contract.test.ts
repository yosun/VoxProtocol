import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {NFT_CUTOVER, validateNftArtifact, validateNftCutover, verifyNftCutover} from "../scripts/check-nft-production-contract.mjs";

const manifest = JSON.parse(readFileSync(new URL("../deployments/nft-mainnet.json", import.meta.url), "utf8"));
const digest = (hex: string) => createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
function fixture(change: Record<string, unknown> = {}) {
  const config = structuredClone(manifest), proof = config.chains["monad:mainnet"].deployment_verification;
  const code = "0x6001600055", input = "0x6002600055";
  proof.runtime_sha256 = digest(code); proof.input_sha256 = digest(input);
  const block = "0x" + BigInt(proof.block_number).toString(16);
  const receipt = {status:"0x1", transactionHash:NFT_CUTOVER.transaction, from:NFT_CUTOVER.owner, to:null, contractAddress:NFT_CUTOVER.contract, blockNumber:block, blockHash:proof.block_hash};
  const tx = {hash:NFT_CUTOVER.transaction, from:NFT_CUTOVER.owner, to:null, type:"0x2", chainId:"0x8f", nonce:"0x1", value:"0x0", gas:"0x1f5bf5", maxFeePerGas:"0x2e90edd000", maxPriorityFeePerGas:"0x77359400", accessList:[], blockHash:proof.block_hash, blockNumber:block, input};
  let receipts = 0;
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === "eth_chainId") return change.chainId ?? "0x8f";
    if (method === "eth_getTransactionReceipt") return {...receipt, ...(change.receipt ?? {}), ...(change.recheck && ++receipts > 1 ? {blockHash:"0x"+"f".repeat(64)} : {})};
    if (method === "eth_getTransactionByHash") return {...tx, ...(change.transaction ?? {})};
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? {hash:change.genesis ?? proof.genesis_hash} : params[0] === "finalized" ? {number:change.finalized ?? "0x"+(BigInt(proof.block_number)+12n).toString(16)} : {hash:change.canonical ?? proof.block_hash};
    if (method === "eth_getCode") return change.code ?? code;
    if (method === "eth_call") return "0x"+"0".repeat(24)+(change.authority ?? NFT_CUTOVER.owner).toString().slice(2);
    throw new Error("Unexpected RPC method");
  });
  return {config, rpc};
}

describe("verified production NFT collection", () => {
  it("binds the authorized address, owner and legacy collection inventory", () => {
    expect(validateNftCutover(manifest).chain.contract_address).toBe(NFT_CUTOVER.contract);
    for (const mutate of [
      (m: any) => {m.projectId = "crueltycam";},
      (m: any) => {m.enabledChains.push("base:mainnet");},
      (m: any) => {m.chains["monad:mainnet"].signer = "0x"+"1".repeat(40);},
      (m: any) => {m.chains["monad:mainnet"].contract_address = NFT_CUTOVER.previous;},
      (m: any) => {m.chains["monad:mainnet"].previous_collections = [];}
    ]) {const copy = structuredClone(manifest); mutate(copy); expect(() => validateNftCutover(copy)).toThrow();}
  });
  it("accepts canonical finalized deployment, runtime and authority evidence", async () => {
    const {config,rpc} = fixture();
    expect(await verifyNftCutover(config,rpc)).toBe(NFT_CUTOVER.contract);
    expect(rpc.mock.calls.every(([method]) => ["eth_chainId","eth_getBlockByNumber","eth_getTransactionReceipt","eth_getTransactionByHash","eth_getCode","eth_call"].includes(method))).toBe(true);
  });
  it.each([
    {chainId:"0x1"}, {genesis:"0x"+"f".repeat(64)},
    {receipt:{status:"0x0"}}, {receipt:{contractAddress:NFT_CUTOVER.previous}},
    {receipt:{from:"0x"+"1".repeat(40)}}, {canonical:"0x"+"f".repeat(64)},
    {finalized:"0x"+BigInt(manifest.chains["monad:mainnet"].deployment_verification.block_number).toString(16)},
    {transaction:{value:"0x1"}}, {transaction:{nonce:"0x2"}}, {transaction:{input:"0x6003"}},
    {transaction:{maxFeePerGas:"0x1"}}, {transaction:{accessList:[{}]}},
    {code:"0x"}, {code:"0x6003"}, {authority:"0x"+"1".repeat(40)}, {recheck:true}
  ])("refuses a cutover on mismatched or incomplete chain evidence %j", async (change) => {
    const {config,rpc} = fixture(change);
    await expect(verifyNftCutover(config,rpc)).rejects.toThrow();
  });
  it("rejects stale compiler artifacts before comparing runtime hashes", () => {
    const source = readFileSync(new URL("../contracts/VoxMediaNFT.sol", import.meta.url));
    expect(() => validateNftArtifact(manifest,source,{metadata:{compiler:{version:"0.8.32"}}})).toThrow("compiler settings");
    expect(() => validateNftArtifact(manifest,Buffer.from("changed source"),{metadata:{compiler:{version:"0.8.33+commit.64118f21"},settings:{evmVersion:"cancun",optimizer:{enabled:false},compilationTarget:{"contracts/VoxMediaNFT.sol":"VoxMediaNFT"}}},bytecode:{object:"0x6000"},deployedBytecode:{object:"0x6001"}})).toThrow("source/runtime");
  });
});

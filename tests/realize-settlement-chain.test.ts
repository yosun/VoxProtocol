import {createHash} from "node:crypto";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Keypair, PublicKey, Transaction, type AccountInfo, type Connection} from "@solana/web3.js";
import {AccountLayout, AccountState, getAssociatedTokenAddress, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {MEMO_PROGRAM_ID} from "@vox/solana";
import {REALIZE_MAX_RECIPIENTS_PER_TRANSACTION, REALIZE_MAX_TRANSACTION_BYTES} from "@vox/protocol";
import {MAINNET_GENESIS_HASH, MAINNET_USDC_MINT, type SettlementTransfer} from "../apps/settlement/src/engine.js";
import {SolanaMainnetSettlementChain} from "../apps/settlement/src/solana-chain.js";

async function fixture() {
  const keypair = Keypair.generate();
  const mint = new PublicKey(MAINNET_USDC_MINT);
  const treasury = await getAssociatedTokenAddress(mint, keypair.publicKey, false, TOKEN_PROGRAM_ID);
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getGenesisHash: vi.fn(async () => MAINNET_GENESIS_HASH),
    getTokenAccountBalance: vi.fn(async () => ({value: {amount: "100000000"}})),
    getAccountInfo: vi.fn(async (): Promise<AccountInfo<Buffer> | null> => null),
    getLatestBlockhash: vi.fn(async () => ({blockhash, lastValidBlockHeight: 100})),
    getFeeForMessage: vi.fn(async () => ({value: 5000})),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
    getBalance: vi.fn(async () => 100_000_000),
    getSignatureStatuses: vi.fn(async () => ({value: [null]})),
    getBlockHeight: vi.fn(async () => 50),
    sendRawTransaction: vi.fn(async (_bytes: Uint8Array) => { throw new Error("simulated lost broadcast response"); }),
    confirmTransaction: vi.fn(async () => { throw new Error("simulated confirmation timeout"); })
  };
  const chain = new SolanaMainnetSettlementChain({rpcUrl: "https://rpc.example.test", treasuryOwner: keypair.publicKey.toBase58(), treasuryTokenAccount: treasury.toBase58(), keypair, maxPaymentAtomic: 100_000_000n, connection: connection as unknown as Connection});
  vi.spyOn(chain, "ensureTreasury").mockResolvedValue();
  const transfer: SettlementTransfer = {payout_id: "payout-provider", destination: "solana:mainnet-beta:" + Keypair.generate().publicKey.toBase58(), amount_usdc_atomic: "1000000"};
  const input = {recordId: "vox:settlement:first", batchIndex: 0, attemptNumber: 1, transfers: [transfer]};
  return {chain, connection, input};
}

describe("durable Mainnet treasury transaction identity (offline)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("signs different bytes for equal payouts on independent records at the same blockhash", async () => {
    const {chain, input} = await fixture();
    const first = await chain.prepareBatch(input);
    const second = await chain.prepareBatch({...input, recordId: "vox:settlement:second"});
    const refund = await chain.prepareBatch({...input, recordId: "vox:refund:separate"});
    const otherBatch = await chain.prepareBatch({...input, batchIndex: 1});
    const newAttempt = await chain.prepareBatch({...input, attemptNumber: 2});
    expect(new Set([first, second, refund, otherBatch, newAttempt].map((batch) => batch.transaction_signature)).size).toBe(5);
    expect(new Set([first, second, refund, otherBatch, newAttempt].map((batch) => batch.raw_transaction_base64)).size).toBe(5);
    expect((await chain.prepareBatch(input)).raw_transaction_base64).toBe(first.raw_transaction_base64);
    const signed = Transaction.from(Buffer.from(first.raw_transaction_base64!, "base64"));
    expect(signed.verifySignatures()).toBe(true);
    expect(signed.instructions[0]!.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    const digest = createHash("sha256").update(JSON.stringify([input.recordId, input.batchIndex, input.attemptNumber])).digest("hex");
    expect(signed.instructions[0]!.data.toString()).toBe("vox:realize:treasury:v1:" + digest);
    expect(first.attempt_number).toBe(1);
    expect(newAttempt.attempt_number).toBe(2);
  });

  it("rebroadcasts identical persisted bytes after lost responses and never refreshes their blockhash", async () => {
    const {chain, connection, input} = await fixture();
    const prepared = await chain.prepareBatch(input);
    expect(await chain.executeBatch(prepared)).toBe("prepared");
    expect(await chain.executeBatch(prepared)).toBe("prepared");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    const raw = Buffer.from(prepared.raw_transaction_base64!, "base64");
    expect(connection.sendRawTransaction.mock.calls.map(([bytes]) => bytes)).toEqual([raw, raw]);
    expect(connection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    connection.getBlockHeight.mockResolvedValue(101);
    expect(await chain.executeBatch(prepared)).toBe("uncertain");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(["signature", "blockhash", "bytes"] as const)("rejects a corrupted persisted %s binding before attempting a broadcast", async (field) => {
    const {chain, connection, input} = await fixture();
    const prepared = await chain.prepareBatch(input);
    if (field === "signature") prepared.transaction_signature = Keypair.generate().publicKey.toBase58();
    if (field === "blockhash") prepared.blockhash = Keypair.generate().publicKey.toBase58();
    if (field === "bytes") {
      const raw = Buffer.from(prepared.raw_transaction_base64!, "base64");
      raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
      prepared.raw_transaction_base64 = raw.toString("base64");
    }
    await expect(chain.executeBatch(prepared)).rejects.toMatchObject({code: "transaction_record_invalid"});
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("rejects valid signed bytes from another treasury before attempting a broadcast", async () => {
    const {chain, connection} = await fixture();
    const other = await fixture();
    const unrelated = await other.chain.prepareBatch(other.input);
    await expect(chain.executeBatch(unrelated)).rejects.toMatchObject({code: "transaction_record_invalid"});
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(connection.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it.each(["planner", "protocol"])("fits the %s's largest payout batch including the memo and new recipient accounts", async (limit) => {
    const {chain, input} = await fixture();
    const recipients = limit === "protocol" ? REALIZE_MAX_RECIPIENTS_PER_TRANSACTION : Math.min(REALIZE_MAX_RECIPIENTS_PER_TRANSACTION, Math.floor((REALIZE_MAX_TRANSACTION_BYTES - 256) / 180));
    const transfers = Array.from({length: recipients}, (_, index) => ({...input.transfers[0]!, payout_id: "payout-" + index, destination: "solana:mainnet-beta:" + Keypair.generate().publicKey.toBase58()}));
    const batch = await chain.prepareBatch({...input, transfers});
    const raw = Buffer.from(batch.raw_transaction_base64!, "base64");
    expect(raw.length).toBeLessThanOrEqual(REALIZE_MAX_TRANSACTION_BYTES);
    expect(Transaction.from(raw).instructions).toHaveLength(1 + 2 * recipients);
  });

  it("rejects batches above the protocol recipient cap before preparing or signing", async () => {
    const {chain, connection, input} = await fixture();
    const transfers = Array.from({length: REALIZE_MAX_RECIPIENTS_PER_TRANSACTION + 1}, (_, index) => ({...input.transfers[0]!, payout_id: "payout-" + index, destination: "solana:mainnet-beta:" + Keypair.generate().publicKey.toBase58()}));
    await expect(chain.prepareBatch({...input, transfers})).rejects.toMatchObject({code: "invalid_payout"});
    expect(connection.getFeeForMessage).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each([AccountState.Uninitialized, AccountState.Frozen])("rejects treasury account state %s before preparing a payment", async (state) => {
    const {chain, connection, input} = await fixture();
    vi.mocked(chain.ensureTreasury).mockRestore();
    const data = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode({mint: chain.mint, owner: chain.owner, amount: 1_000_000n, delegateOption: 0, delegate: PublicKey.default, state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default}, data);
    connection.getAccountInfo.mockResolvedValue({data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0});
    await expect(chain.prepareBatch(input)).rejects.toMatchObject({code: "treasury_not_ready"});
    expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});

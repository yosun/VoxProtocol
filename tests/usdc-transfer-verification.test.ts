import {afterEach, describe, expect, it, vi} from "vitest";
import {Connection, Keypair, PublicKey, SystemProgram, type ParsedInstruction, type ParsedTransactionWithMeta, type TokenBalance} from "@solana/web3.js";
import {MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, verifyFinalizedUsdcTransfer, type UsdcTransferExpectation} from "../packages/solana/src/index.js";
import {SolanaMainnetSettlementChain} from "../apps/settlement/src/solana-chain.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function tokenInstruction(type: string, info: Record<string, unknown>): ParsedInstruction {
  return {program: "spl-token", programId: TOKEN_PROGRAM_ID, parsed: {type, info}};
}

function fixture() {
  const payer = Keypair.generate().publicKey;
  const source = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey;
  const victim = Keypair.generate().publicKey;
  const input: UsdcTransferExpectation = {
    rpc_url: "https://rpc.example.test",
    transaction_signature: "1".repeat(88),
    network_id: "solana:mainnet-beta",
    usdc_mint: MAINNET_USDC,
    destination_token_account: destination.toBase58(),
    amount_atomic: "1000000",
    source_token_account: source.toBase58(),
    payer_address: payer.toBase58(),
    payment_reference: "vox:realize:payment:intent:" + "a".repeat(64)
  };
  const transfer = tokenInstruction("transferChecked", {source: source.toBase58(), destination: destination.toBase58(), mint: MAINNET_USDC, authority: payer.toBase58(), tokenAmount: {amount: input.amount_atomic, decimals: 6}});
  const balance: TokenBalance = {accountIndex: 1, mint: MAINNET_USDC, owner: payer.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: {amount: "1000000", decimals: 6, uiAmount: 1}};
  const meta: NonNullable<ParsedTransactionWithMeta["meta"]> = {err: null, fee: 5000, preBalances: [1, 1, 1, 1], postBalances: [1, 1, 1, 1], preTokenBalances: [balance], postTokenBalances: [{...balance, uiTokenAmount: {...balance.uiTokenAmount, amount: "0", uiAmount: 0}}], innerInstructions: []};
  const transaction: ParsedTransactionWithMeta = {
    slot: 123,
    blockTime: 1_792_000_000,
    meta,
    transaction: {
      signatures: [input.transaction_signature],
      message: {
        accountKeys: [payer, source, destination, victim].map((pubkey, index) => ({pubkey, signer: index === 0, writable: true})),
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [transfer, {program: "spl-memo", programId: MEMO_PROGRAM_ID, parsed: input.payment_reference}]
      }
    }
  };
  const genesisLookup = vi.spyOn(Connection.prototype, "getGenesisHash").mockResolvedValue(MAINNET_GENESIS);
  const transactionLookup = vi.spyOn(Connection.prototype, "getParsedTransaction").mockResolvedValue(transaction);
  const accountLookup = vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockResolvedValue({context: {slot: 999}, value: null});
  const changeOwner = (owner: PublicKey, authority = payer) => tokenInstruction("setAuthority", {account: source.toBase58(), authority: authority.toBase58(), authorityType: "accountOwner", newAuthority: owner.toBase58()});
  const close = tokenInstruction("closeAccount", {account: source.toBase58(), destination: payer.toBase58(), owner: payer.toBase58()});
  return {input, payer, source, victim, transfer, transaction, meta, balance, close, changeOwner, genesisLookup, transactionLookup, accountLookup, verify: () => verifyFinalizedUsdcTransfer(input)};
}

describe("historical finalized USDC ownership (offline)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("recognizes a historical payment after the source account has been closed", async () => {
    const test = fixture();
    await expect(test.verify()).resolves.toMatchObject({finalized: true, matched: true, network_matches: true, source_token_account: test.source.toBase58(), block_time: test.transaction.blockTime});
    expect(test.accountLookup).not.toHaveBeenCalled();
    expect(test.transactionLookup).toHaveBeenCalledWith(test.input.transaction_signature, {commitment: "finalized", maxSupportedTransactionVersion: 1});
  });

  it("recognizes ownership before a close or owner change later in the payment transaction", async () => {
    const test = fixture();
    test.transaction.transaction.message.instructions.push(test.close);
    test.meta.postTokenBalances = [];
    expect((await test.verify()).matched).toBe(true);
    test.transaction.transaction.message.instructions.pop();
    test.transaction.transaction.message.instructions.push(test.changeOwner(test.victim));
    test.meta.postTokenBalances = [{...test.balance, owner: test.victim.toBase58()}];
    expect((await test.verify()).matched).toBe(true);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("also verifies original historical funding for the refund chain adapter", async () => {
    const test = fixture();
    const treasuryKey = Keypair.generate();
    const chain = new SolanaMainnetSettlementChain({rpcUrl: test.input.rpc_url, treasuryOwner: treasuryKey.publicKey.toBase58(), treasuryTokenAccount: test.input.destination_token_account, keypair: treasuryKey, maxPaymentAtomic: 1_000_000n});
    expect(await chain.verifyFunding({commission_id: "commission", payment_intent_id: "intent", accepted_quote_hash: "a".repeat(64), amount_usdc_atomic: test.input.amount_atomic, network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC, payer_wallet: test.payer.toBase58(), funding_transaction_signature: test.input.transaction_signature, payment_reference: test.input.payment_reference!, idempotency_key: "refund"})).toBe(true);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it.each(["initializeAccount", "initializeAccount2", "initializeAccount3"])("uses successful top-level %s evidence for a temporary source created and closed in the transaction", async (type) => {
    const test = fixture();
    test.meta.preTokenBalances = [];
    test.meta.postTokenBalances = [];
    const bank = Keypair.generate().publicKey;
    test.transaction.transaction.message.accountKeys.push({pubkey: bank, signer: false, writable: true});
    test.transaction.transaction.message.accountKeys[1]!.signer = true;
    test.transaction.transaction.message.instructions.unshift(
      {program: "system", programId: SystemProgram.programId, parsed: {type: "createAccount", info: {source: test.payer.toBase58(), newAccount: test.source.toBase58(), owner: TOKEN_PROGRAM_ID.toBase58(), space: 165, lamports: 2_039_280}}},
      tokenInstruction(type, {account: test.source.toBase58(), mint: MAINNET_USDC, owner: test.payer.toBase58()}),
      tokenInstruction("transferChecked", {source: bank.toBase58(), destination: test.source.toBase58(), mint: MAINNET_USDC, authority: test.payer.toBase58(), tokenAmount: {amount: "1000000", decimals: 6}})
    );
    test.transaction.transaction.message.instructions.push(test.close);
    expect((await test.verify()).matched).toBe(true);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("applies source owner changes in order before the transfer and rejects a delegated transfer", async () => {
    const test = fixture();
    test.transaction.transaction.message.accountKeys[3]!.signer = true;
    test.transaction.transaction.message.instructions.unshift(test.changeOwner(test.victim), tokenInstruction("approve", {source: test.source.toBase58(), delegate: test.payer.toBase58(), owner: test.victim.toBase58(), amount: "1000000"}));
    test.meta.postTokenBalances = [{...test.balance, owner: test.victim.toBase58()}];
    expect((await test.verify()).matched).toBe(false);
    test.transaction.transaction.message.instructions.splice(2, 0, test.changeOwner(test.payer, test.victim));
    test.meta.postTokenBalances = [test.balance];
    expect((await test.verify()).matched).toBe(true);
  });

  it("rejects a delegated payment even if the payer becomes owner after the transfer", async () => {
    const test = fixture();
    test.transaction.transaction.message.accountKeys[3]!.signer = true;
    test.meta.preTokenBalances = [{...test.balance, owner: test.victim.toBase58()}];
    test.transaction.transaction.message.instructions.push(test.changeOwner(test.payer, test.victim));
    expect((await test.verify()).matched).toBe(false);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("does not infer transfer-time ownership from post metadata alone", async () => {
    const test = fixture();
    test.meta.preTokenBalances = [];
    expect((await test.verify()).matched).toBe(false);
    const {owner: _owner, ...ownerMissing} = test.balance;
    test.meta.preTokenBalances = [ownerMissing];
    expect((await test.verify()).matched).toBe(false);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("requires successful execution metadata before relying on a top-level lifecycle instruction", async () => {
    const test = fixture();
    test.transaction.meta = null;
    test.transaction.transaction.message.instructions.unshift(tokenInstruction("initializeAccount3", {account: test.source.toBase58(), mint: MAINNET_USDC, owner: test.payer.toBase58()}));
    await expect(test.verify()).resolves.toMatchObject({finalized: false, matched: false});
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("rejects pre-balance evidence indexed to another account or a different token program", async () => {
    const test = fixture();
    test.meta.preTokenBalances = [{...test.balance, accountIndex: 2}];
    expect((await test.verify()).matched).toBe(false);
    test.meta.preTokenBalances = [{...test.balance, programId: OTHER_TOKEN_PROGRAM}];
    expect((await test.verify()).matched).toBe(false);
    test.meta.preTokenBalances = [test.balance, test.balance];
    expect((await test.verify()).matched).toBe(false);
  });

  it("invalidates prior ownership when unparsed token instructions touch the source", async () => {
    const test = fixture();
    test.transaction.transaction.message.instructions.unshift({programId: TOKEN_PROGRAM_ID, accounts: [test.source, test.payer], data: "1111"});
    expect((await test.verify()).matched).toBe(false);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it("rejects incomplete CPI history and never assumes a caught inner lifecycle call succeeded", async () => {
    const test = fixture();
    const customProgram = {programId: Keypair.generate().publicKey, accounts: [test.source, test.payer], data: "1111"};
    test.transaction.transaction.message.instructions.unshift(customProgram);
    test.meta.innerInstructions = null;
    expect((await test.verify()).matched).toBe(false);
    test.meta.innerInstructions = [{index: 0, instructions: [test.changeOwner(test.payer)]}];
    test.meta.preTokenBalances = [{...test.balance, owner: test.victim.toBase58()}];
    test.meta.postTokenBalances = [{...test.balance, owner: test.victim.toBase58()}];
    expect((await test.verify()).matched).toBe(false);
    expect(test.accountLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["mint", "not-the-accepted-mint"],
    ["destination", "not-the-treasury-account"],
    ["source", "not-the-pinned-source"],
    ["authority", "not-the-payer"]
  ])("retains the exact %s binding", async (field, value) => {
    const test = fixture();
    test.transfer.parsed.info[field] = value;
    expect((await test.verify()).matched).toBe(false);
  });

  it("retains amount, decimals, payer signature, memo, network and successful execution checks", async () => {
    const test = fixture();
    test.transfer.parsed.info.tokenAmount.amount = "999999";
    expect((await test.verify()).matched).toBe(false);
    test.transfer.parsed.info.tokenAmount.amount = "1000000";
    test.transfer.parsed.info.tokenAmount.decimals = 9;
    expect((await test.verify()).matched).toBe(false);
    test.transfer.parsed.info.tokenAmount.decimals = 6;
    test.transaction.transaction.message.accountKeys[0]!.signer = false;
    expect((await test.verify()).matched).toBe(false);
    test.transaction.transaction.message.accountKeys[0]!.signer = true;
    const memo = test.transaction.transaction.message.instructions.pop()!;
    expect((await test.verify()).matched).toBe(false);
    test.transaction.transaction.message.instructions.push(memo);
    test.genesisLookup.mockResolvedValue("a-devnet-genesis");
    await expect(test.verify()).resolves.toMatchObject({matched: false, network_matches: false});
    test.genesisLookup.mockResolvedValue(MAINNET_GENESIS);
    test.meta.err = {InstructionError: [0, "Custom"]};
    await expect(test.verify()).resolves.toMatchObject({finalized: true, matched: false, execution_failed: true});
  });

  it("rejects two identical quote-bound transfers and does not query current account state", async () => {
    const test = fixture();
    test.transaction.transaction.message.instructions.push(test.transfer);
    await expect(test.verify()).resolves.toMatchObject({matched: false, reason: "Finalized transaction contains multiple identical quote-bound transfers."});
    expect(test.accountLookup).not.toHaveBeenCalled();
  });
});

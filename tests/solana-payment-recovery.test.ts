import {Buffer} from "node:buffer";
import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {Connection, Keypair, PublicKey, Transaction} from "@solana/web3.js";
import {ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {SolanaSignAndSendTransaction, SolanaSignTransaction} from "@solana/wallet-standard-features";
import {getBase58Decoder} from "@solana/kit";
import {checkSolanaTransaction, directFundingAuthorization, recoverUsdcPayment, sendUsdcPayment, walletRejected, type SendUsdcPaymentInput, type UsdcPaymentAttempt} from "../apps/web/src/solana-payment.js";

const registry = vi.hoisted(() => ({getWallet: vi.fn()}));
const rpc = vi.hoisted(() => ({getBlockHeight: vi.fn()}));
vi.mock("@wallet-standard/ui-registry", () => ({getWalletForHandle: registry.getWallet}));
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {...actual, Connection: class extends actual.Connection {
    constructor(...args: ConstructorParameters<typeof actual.Connection>) { super(...args); this.getBlockHeight = rpc.getBlockHeight; }
  }};
});

const payer = Keypair.fromSeed(new Uint8Array(32).fill(13));
const treasury = Keypair.fromSeed(new Uint8Array(32).fill(14)).publicKey;
const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const destination = getAssociatedTokenAddressSync(mint, treasury, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
const recoveryOptions = () => ({rpcUrl: "http://127.0.0.1:8899", quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString()});

function tokenAccount(owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return {data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0};
}

function paymentInput(onPrepared = vi.fn()): SendUsdcPaymentInput {
  return {
    wallet: {} as SendUsdcPaymentInput["wallet"],
    account: {address: payer.publicKey.toBase58(), publicKey: payer.publicKey.toBytes(), chains: ["solana:mainnet"], features: [SolanaSignTransaction, SolanaSignAndSendTransaction]} as unknown as SendUsdcPaymentInput["account"],
    supportedTransactionVersions: new Set(["legacy"]),
    payerAddress: payer.publicKey.toBase58(),
    usdcMint: mint.toBase58(),
    destinationTokenAccount: destination.toBase58(),
    destinationOwnerAddress: treasury.toBase58(),
    amountAtomic: "1000000",
    paymentReference: "vox:realize:payment:recovery-test",
    cluster: "mainnet-beta",
    quoteExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    rpcUrl: "http://127.0.0.1:8899",
    onPrepared
  };
}

function walletFeatures() {
  const signTransaction = vi.fn(async (...inputs: Array<{transaction: Uint8Array}>) => inputs.map(({transaction}) => {
    const signed = Transaction.from(transaction);
    signed.partialSign(payer);
    return {signedTransaction: new Uint8Array(signed.serialize())};
  }));
  const signAndSendTransaction = vi.fn(async () => [{signature: new Uint8Array(64).fill(1)}]);
  registry.getWallet.mockReturnValue({features: {
    [SolanaSignTransaction]: {version: "1.0.0", signTransaction},
    [SolanaSignAndSendTransaction]: {version: "1.0.0", signAndSendTransaction}
  }});
  return {signTransaction, signAndSendTransaction};
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_REALIZE_MAINNET_ENABLED", "true");
  vi.spyOn(Connection.prototype, "getAccountInfo").mockImplementation(async (account) => tokenAccount(account.equals(destination) ? treasury : payer.publicKey, 2_000_000n));
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({blockhash: payer.publicKey.toBase58(), lastValidBlockHeight: 100});
  vi.spyOn(Connection.prototype, "getFeeForMessage").mockResolvedValue({context: {slot: 10}, value: 5_000});
  vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(1_000_000_000);
  vi.spyOn(Connection.prototype, "simulateTransaction").mockResolvedValue({context: {slot: 10}, value: {err: null, logs: []}});
  vi.spyOn(Connection.prototype, "getSignatureStatuses").mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: null, err: null, confirmationStatus: "finalized"}]});
  rpc.getBlockHeight.mockResolvedValue(10);
  vi.spyOn(Connection.prototype, "sendRawTransaction").mockResolvedValue("untrusted-rpc-return-value");
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("USDC wallet broadcast recovery", () => {
  it("refuses an expired quote before invoking either wallet signing method", async () => {
    const wallet = walletFeatures();
    const input = {...paymentInput(), quoteExpiresAt: new Date(Date.now() - 1).toISOString()};
    await expect(sendUsdcPayment(input)).rejects.toThrow("quote expired");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rechecks quote expiry after RPC preparation before asking the wallet to sign", async () => {
    vi.useFakeTimers();
    const wallet = walletFeatures();
    const input = paymentInput();
    vi.mocked(Connection.prototype.simulateTransaction).mockImplementation(async () => {
      vi.setSystemTime(Date.parse(input.quoteExpiresAt) + 1);
      return {context: {slot: 10}, value: {err: null, logs: []}};
    });
    await expect(sendUsdcPayment(input)).rejects.toThrow("quote expired");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("saves a wallet-signed payment but does not broadcast it when approval crosses quote expiry", async () => {
    vi.useFakeTimers();
    const wallet = walletFeatures();
    const checkpoint = vi.fn();
    const submitted = vi.fn();
    const input = {...paymentInput(checkpoint), onSubmitted: submitted};
    const sign = wallet.signTransaction.getMockImplementation()!;
    wallet.signTransaction.mockImplementation(async (...inputs) => {
      const signed = await sign(...inputs);
      vi.setSystemTime(Date.parse(input.quoteExpiresAt) + 1);
      return signed;
    });
    await expect(sendUsdcPayment(input)).rejects.toThrow("quote expired");
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({kind: "signed"}));
    const attempt = checkpoint.mock.calls[0]![0] as Extract<UsdcPaymentAttempt, {kind: "signed"}>;
    expect(Transaction.from(Buffer.from(attempt.signedTransaction, "base64")).verifySignatures()).toBe(true);
    expect(submitted).toHaveBeenCalledWith(attempt.signature, expect.any(String));
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not broadcast after quote expiry while the durable submitted receipt is saved", async () => {
    vi.useFakeTimers();
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    input.onSubmitted = vi.fn(() => { vi.setSystemTime(Date.parse(input.quoteExpiresAt) + 1); });
    await expect(sendUsdcPayment(input)).rejects.toThrow("quote expired");
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({kind: "signed"}));
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not invoke a sign-and-send wallet when durable preparation crosses quote expiry", async () => {
    vi.useFakeTimers();
    const wallet = walletFeatures();
    const input = paymentInput();
    input.account = {...input.account, features: [SolanaSignAndSendTransaction]};
    input.onPrepared = vi.fn(() => { vi.setSystemTime(Date.parse(input.quoteExpiresAt) + 1); });
    await expect(sendUsdcPayment(input)).rejects.toThrow("quote expired");
    expect(input.onPrepared).toHaveBeenCalledWith(expect.objectContaining({kind: "wallet_submission"}));
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("retains and verifies a sign-and-send receipt even if wallet approval finished after quote expiry", async () => {
    vi.useFakeTimers();
    const wallet = walletFeatures();
    const input = paymentInput();
    input.account = {...input.account, features: [SolanaSignAndSendTransaction]};
    wallet.signAndSendTransaction.mockImplementation(async () => {
      vi.setSystemTime(Date.parse(input.quoteExpiresAt) + 1);
      return [{signature: new Uint8Array(64).fill(1)}];
    });
    input.onSubmitted = vi.fn();
    await expect(sendUsdcPayment(input)).resolves.toMatchObject({confirmation: "finalized"});
    expect(input.onPrepared).toHaveBeenCalledWith(expect.objectContaining({kind: "wallet_submission"}));
    expect(input.onSubmitted).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("prefers signing and checkpoints the verified signature and bytes before broadcast", async () => {
    const wallet = walletFeatures();
    let checkpoint: UsdcPaymentAttempt | undefined;
    const input = paymentInput(vi.fn((attempt) => { checkpoint = structuredClone(attempt); }));
    vi.mocked(Connection.prototype.sendRawTransaction).mockImplementation(async (raw) => {
      expect(checkpoint?.kind).toBe("signed");
      if (checkpoint?.kind !== "signed") throw new Error("missing checkpoint");
      expect(Buffer.from(raw).toString("base64")).toBe(checkpoint.signedTransaction);
      expect(Transaction.from(raw).verifySignatures()).toBe(true);
      expect(checkpoint.signature).toBe(getBase58Decoder().decode(Transaction.from(raw).signature!));
      return "untrusted-rpc-return-value";
    });
    const result = await sendUsdcPayment(input);
    expect(result).toMatchObject({signature: checkpoint?.kind === "signed" ? checkpoint.signature : undefined, confirmation: "finalized"});
    expect(result.signature).not.toBe("untrusted-rpc-return-value");
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("retains the payment identity when an accepted RPC broadcast loses its response", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    vi.mocked(Connection.prototype.sendRawTransaction).mockRejectedValue(new Error("connection closed after broadcast"));
    const result = await sendUsdcPayment(paymentInput(checkpoint));
    const attempt = checkpoint.mock.calls[0]![0] as UsdcPaymentAttempt;
    expect(attempt.kind).toBe("signed");
    expect(result).toMatchObject({signature: attempt.kind === "signed" ? attempt.signature : undefined, confirmation: "pending"});
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("continues polling after a confirmed fork error instead of releasing the payment for retry", async () => {
    vi.useFakeTimers();
    walletFeatures();
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValueOnce({context: {slot: 10}, value: [{slot: 10, confirmations: 1, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus: "confirmed"}]});
    const result = sendUsdcPayment(paymentInput());
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(result).resolves.toMatchObject({confirmation: "finalized"});
    expect(Connection.prototype.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("keeps a nonfinal failure pending when the finality polling deadline expires", async () => {
    vi.useFakeTimers();
    walletFeatures();
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: 1, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus: "processed"}]});
    const result = sendUsdcPayment(paymentInput());
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(result).resolves.toMatchObject({confirmation: "pending"});
    expect(vi.mocked(Connection.prototype.getSignatureStatuses).mock.calls.length).toBeGreaterThan(1);
  });

  it("reports a finalized failed broadcast as safe to retry", async () => {
    walletFeatures();
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: null, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus: "finalized"}]});
    await expect(sendUsdcPayment(paymentInput())).resolves.toMatchObject({confirmation: "failed"});
  });

  it("recovers by rebroadcasting identical saved bytes without another wallet signature", async () => {
    const wallet = walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    vi.mocked(Connection.prototype.sendRawTransaction).mockRejectedValueOnce(new Error("response lost"));
    const original = await sendUsdcPayment(input);
    const attempt = JSON.parse(JSON.stringify(checkpoint.mock.calls[0]![0])) as UsdcPaymentAttempt;
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [null]});
    const recovered = await recoverUsdcPayment(attempt, input, recoveryOptions());
    expect(recovered.signature).toBe(original.signature);
    const calls = vi.mocked(Connection.prototype.sendRawTransaction).mock.calls;
    expect(calls).toHaveLength(2);
    expect(Buffer.from(calls[0]![0])).toEqual(Buffer.from(calls[1]![0]));
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("keeps the original signature when expiry and a missing RPC history result are ambiguous", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    const original = await sendUsdcPayment(input);
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [null]});
    rpc.getBlockHeight.mockResolvedValue(101);
    const recovered = await recoverUsdcPayment(checkpoint.mock.calls[0]![0], input, recoveryOptions());
    expect(recovered).toMatchObject({signature: original.signature, confirmation: "pending"});
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("can still check an existing signature when Mainnet sending is disabled, without rebroadcasting", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    const original = await sendUsdcPayment(input);
    vi.stubEnv("VITE_REALIZE_MAINNET_ENABLED", "false");
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [null]});
    const recovered = await recoverUsdcPayment(checkpoint.mock.calls[0]![0], input, recoveryOptions());
    expect(recovered).toMatchObject({signature: original.signature, confirmation: "pending"});
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("checks the saved identity without sending funds after the accepted quote expires", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    const original = await sendUsdcPayment(input);
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [null]});
    const recovered = await recoverUsdcPayment(checkpoint.mock.calls[0]![0], input, {...recoveryOptions(), quoteExpiresAt: new Date(Date.now() - 1).toISOString()});
    expect(recovered).toMatchObject({signature: original.signature, confirmation: "pending"});
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["processed", "confirmed"] as const)("retains a saved payment after a %s fork error", async (confirmationStatus) => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    const original = await sendUsdcPayment(input);
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: 1, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus}]});
    const recovered = await recoverUsdcPayment(checkpoint.mock.calls[0]![0], input, recoveryOptions());
    expect(recovered).toMatchObject({signature: original.signature, confirmation: "pending"});
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("allows recovery to release a saved payment only after finalized failure", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    const original = await sendUsdcPayment(input);
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: null, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus: "finalized"}]});
    await expect(recoverUsdcPayment(checkpoint.mock.calls[0]![0], input, recoveryOptions())).resolves.toMatchObject({signature: original.signature, confirmation: "failed"});
  });

  it.each(["processed", "confirmed"] as const)("keeps a manually checked receipt pending after a %s fork error", async (confirmationStatus) => {
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: 1, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus}]});
    await expect(checkSolanaTransaction("receipt-from-wallet", "mainnet-beta")).resolves.toBe("pending");
  });

  it("reports a finalized receipt failure to the caller", async () => {
    vi.mocked(Connection.prototype.getSignatureStatuses).mockResolvedValue({context: {slot: 10}, value: [{slot: 10, confirmations: null, err: {InstructionError: [0, "AccountNotFound"]}, confirmationStatus: "finalized"}]});
    await expect(checkSolanaTransaction("receipt-from-wallet", "mainnet-beta")).resolves.toBe("failed");
  });

  it.each(["payerAddress", "usdcMint", "destinationTokenAccount", "destinationOwnerAddress", "amountAtomic", "paymentReference", "cluster"] as const)("rejects recovery when the accepted %s binding differs", async (field) => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    await sendUsdcPayment(input);
    await expect(recoverUsdcPayment(checkpoint.mock.calls[0]![0], {...input, [field]: "different"}, recoveryOptions())).rejects.toThrow("does not match this accepted quote");
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to broadcast when the wallet changed the authorized amount", async () => {
    const wallet = walletFeatures();
    wallet.signTransaction.mockImplementation(async (...inputs) => inputs.map(({transaction}) => {
      const signed = Transaction.from(transaction);
      signed.instructions.find((item) => item.programId.equals(TOKEN_PROGRAM_ID))!.data.writeBigUInt64LE(2_000_000n, 1);
      signed.partialSign(payer);
      return {signedTransaction: new Uint8Array(signed.serialize())};
    }));
    const checkpoint = vi.fn();
    await expect(sendUsdcPayment(paymentInput(checkpoint))).rejects.toThrow("does not match the authorized payment");
    expect(checkpoint).not.toHaveBeenCalled();
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses to broadcast when durable recovery storage fails", async () => {
    walletFeatures();
    const input = paymentInput(vi.fn(() => { throw new Error("browser storage failed"); }));
    await expect(sendUsdcPayment(input)).rejects.toThrow("browser storage failed");
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses to rebroadcast signed bytes that were changed after persistence", async () => {
    walletFeatures();
    const checkpoint = vi.fn();
    const input = paymentInput(checkpoint);
    await sendUsdcPayment(input);
    const attempt = checkpoint.mock.calls[0]![0] as Extract<UsdcPaymentAttempt, {kind: "signed"}>;
    const changed = Transaction.from(Buffer.from(attempt.signedTransaction, "base64"));
    changed.instructions.find((item) => item.programId.equals(TOKEN_PROGRAM_ID))!.data.writeBigUInt64LE(2_000_000n, 1);
    changed.partialSign(payer);
    await expect(recoverUsdcPayment({...attempt, signedTransaction: changed.serialize().toString("base64")}, input, recoveryOptions())).rejects.toThrow("does not match the authorized payment");
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("checkpoints sign-and-send-only wallets before invocation and preserves ambiguous failures", async () => {
    const checkpoint = vi.fn();
    const failure = Object.assign(new Error("RPC connection lost"), {name: "WalletSignTransactionError"});
    const signAndSendTransaction = vi.fn(async () => {
      expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({kind: "wallet_submission"}));
      throw failure;
    });
    registry.getWallet.mockReturnValue({features: {[SolanaSignAndSendTransaction]: {signAndSendTransaction}}});
    await expect(sendUsdcPayment(paymentInput(checkpoint))).rejects.toBe(failure);
    expect(walletRejected(failure)).toBe(false);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(Connection.prototype.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("uses only the connected account's signing capabilities even when the wallet advertises both globally", async () => {
    const wallet = walletFeatures();
    const input = paymentInput();
    await sendUsdcPayment({...input, account: {...input.account, features: [SolanaSignAndSendTransaction]}});
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses wallet-global signing methods absent from the connected account", async () => {
    const wallet = walletFeatures();
    const input = paymentInput();
    await expect(sendUsdcPayment({...input, account: {...input.account, features: []}})).rejects.toThrow("does not support Solana transaction signing");
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(wallet.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("recognizes only explicit user cancellation, rather than generic signing failures", () => {
    expect(walletRejected({code: 4001})).toBe(true);
    expect(walletRejected(new Error("User rejected the request"))).toBe(true);
    expect(walletRejected({name: "WalletSignTransactionError", message: "Disconnected during submission"})).toBe(false);
    expect(walletRejected({name: "WalletConnectionError", message: "Network rejected the connection"})).toBe(false);
    expect(walletRejected(new Error("Request rejected by the RPC rate limiter"))).toBe(false);
  });
});

describe("Mainnet funding binding to the verified accepted quote", () => {
  function acceptedFunding() {
    const hash = "a".repeat(64);
    const commission = {commission_id: "commission:binding-test", quote_id: "quote:binding-test", accepted_quote_hash: hash} as Parameters<typeof directFundingAuthorization>[0];
    const quote = {commission_id: commission.commission_id, quote_id: commission.quote_id, canonical_quote_hash: hash, network_id: "solana:mainnet-beta", usdc_mint: mint.toBase58(), total_amount_usdc_atomic: "1000000", expires_at: new Date(Date.now() + 60_000).toISOString()} as Parameters<typeof directFundingAuthorization>[1];
    const intent = `vox:payment-intent:${createHash("sha256").update(`${commission.commission_id}\u0000${hash}`).digest("hex")}`;
    const funding = {mode: "direct", custody_model: "backend_managed", commission_id: commission.commission_id, quote_id: quote.quote_id, accepted_quote_hash: hash, network_id: quote.network_id, usdc_mint: quote.usdc_mint, amount_usdc_atomic: quote.total_amount_usdc_atomic, expires_at: quote.expires_at, payer_wallet: payer.publicKey.toBase58(), destination_token_account: destination.toBase58(), destination_owner: treasury.toBase58(), payment_reference: `vox:realize:payment:${intent}:${hash}`} as Parameters<typeof directFundingAuthorization>[2];
    return {commission, quote, funding};
  }

  it("uses only funding matching the accepted quote and the backend's deterministic payment reference", () => {
    const {commission, quote, funding} = acceptedFunding();
    expect(directFundingAuthorization(commission, quote, funding)).toEqual({payerAddress: funding.payer_wallet, usdcMint: mint.toBase58(), destinationTokenAccount: destination.toBase58(), destinationOwnerAddress: treasury.toBase58(), amountAtomic: "1000000", paymentReference: funding.payment_reference, cluster: "mainnet-beta"});
  });

  it.each([
    ["amount_usdc_atomic", "500000"], ["usdc_mint", payer.publicKey.toBase58()],
    ["network_id", "solana:devnet"], ["commission_id", "commission:other"],
    ["quote_id", "quote:other"], ["accepted_quote_hash", "b".repeat(64)],
    ["expires_at", "2099-01-01T00:00:00.000Z"], ["custody_model", "escrow"],
    ["payment_reference", "vox:realize:payment:another-intent"]
  ])("rejects a different funding %s before any transfer is constructed", (field, value) => {
    const {commission, quote, funding} = acceptedFunding();
    expect(() => directFundingAuthorization(commission, quote, {...funding, [field]: value})).toThrow("does not match your verified accepted quote");
  });

  it("rejects a quote not accepted by this commission", () => {
    const {commission, quote, funding} = acceptedFunding();
    expect(() => directFundingAuthorization({...commission, accepted_quote_hash: "b".repeat(64)}, quote, funding)).toThrow("does not match your verified accepted quote");
  });

  it("keeps a matching expired authorization available to inspect an existing receipt", () => {
    const {commission, quote, funding} = acceptedFunding();
    const expires_at = new Date(Date.now() - 1).toISOString();
    expect(() => directFundingAuthorization(commission, {...quote, expires_at}, {...funding, expires_at})).not.toThrow();
  });
});

import {createHash} from "node:crypto";
import type {RealizeQuoteV1} from "@vox/protocol";
import type {RealizeCommissionRecord} from "./types.js";

export interface CharacterAccountPayout {
  payout_id: string;
  recipient_id: string;
  amount_usdc_atomic: string;
  destination?: string;
  custody: "platform_treasury" | "external_wallet" | "unknown";
  status: "pending" | "settled" | "failed";
}

export interface CharacterAccountTransaction {
  transaction_id: string;
  character_id: string;
  commission_id: string;
  payment_intent_id: string;
  quote_id: string;
  accepted_quote_hash: string;
  network_id: string;
  usdc_mint: string;
  status: "quoted" | "awaiting_payment" | "in_progress" | "settlement_pending" | "partially_settled" | "available" | "paid" | "mixed" | "refund_pending" | "refunded" | "manual_review";
  amount_usdc_atomic: string;
  available_usdc_atomic: string;
  pending_usdc_atomic: string;
  paid_usdc_atomic: string;
  unclassified_usdc_atomic: string;
  refunded_usdc_atomic: string;
  payer_wallet?: string;
  funding_transaction_signature?: string;
  settlement_id?: string;
  settlement_transaction_signatures: string[];
  refund_id?: string;
  refund_status?: "accepted" | "processing" | "refunded" | "failed" | "uncertain";
  refund_transaction_signature?: string;
  owner_payouts: CharacterAccountPayout[];
  created_at: string;
  updated_at: string;
}

export interface CharacterAccountBalance {
  network_id: string;
  usdc_mint: string;
  available_usdc_atomic: string;
  pending_usdc_atomic: string;
  lifetime_paid_usdc_atomic: string;
  unclassified_usdc_atomic: string;
  lifetime_refunded_usdc_atomic: string;
}

export interface CharacterAccountView {
  character_id: string;
  custody_model: "platform_treasury_liability";
  balances: CharacterAccountBalance[];
  transactions: CharacterAccountTransaction[];
  updated_at: string;
}

export function applyCharacterAccountBalanceDelta(
  current: CharacterAccountBalance[],
  previous: CharacterAccountTransaction | undefined,
  next: CharacterAccountTransaction | undefined
): CharacterAccountBalance[] {
  const balances = new Map(current.map((balance) => [`${balance.network_id}\u0000${balance.usdc_mint}`, {...balance}]));
  const adjust = (transaction: CharacterAccountTransaction, sign: 1n | -1n) => {
    const key = `${transaction.network_id}\u0000${transaction.usdc_mint}`;
    const balance = balances.get(key) ?? {network_id: transaction.network_id, usdc_mint: transaction.usdc_mint, available_usdc_atomic: "0", pending_usdc_atomic: "0", lifetime_paid_usdc_atomic: "0", unclassified_usdc_atomic: "0", lifetime_refunded_usdc_atomic: "0"};
    balance.available_usdc_atomic = (BigInt(balance.available_usdc_atomic) + sign * BigInt(transaction.available_usdc_atomic)).toString();
    balance.pending_usdc_atomic = (BigInt(balance.pending_usdc_atomic) + sign * BigInt(transaction.pending_usdc_atomic)).toString();
    balance.lifetime_paid_usdc_atomic = (BigInt(balance.lifetime_paid_usdc_atomic) + sign * BigInt(transaction.paid_usdc_atomic)).toString();
    balance.unclassified_usdc_atomic = (BigInt(balance.unclassified_usdc_atomic) + sign * BigInt(transaction.unclassified_usdc_atomic)).toString();
    balance.lifetime_refunded_usdc_atomic = (BigInt(balance.lifetime_refunded_usdc_atomic) + sign * BigInt(transaction.refunded_usdc_atomic)).toString();
    if ([balance.available_usdc_atomic, balance.pending_usdc_atomic, balance.lifetime_paid_usdc_atomic, balance.unclassified_usdc_atomic, balance.lifetime_refunded_usdc_atomic].some((value) => BigInt(value) < 0n)) throw new Error("character account balance cannot become negative");
    balances.set(key, balance);
  };
  if (previous) adjust(previous, -1n);
  if (next) adjust(next, 1n);
  return [...balances.values()].filter(hasAccountActivity).sort((left, right) => left.network_id.localeCompare(right.network_id) || left.usdc_mint.localeCompare(right.usdc_mint));
}

function hasAccountActivity(balance: CharacterAccountBalance): boolean {
  return BigInt(balance.available_usdc_atomic) > 0n || BigInt(balance.pending_usdc_atomic) > 0n || BigInt(balance.lifetime_paid_usdc_atomic) > 0n || BigInt(balance.unclassified_usdc_atomic) > 0n || BigInt(balance.lifetime_refunded_usdc_atomic) > 0n;
}

function idFor(creatorId: string, commissionId: string): string {
  const digest = createHash("sha256").update(`${creatorId}\u0000${commissionId}`).digest("hex");
  return `vox:character-account:${digest}`;
}

function sum(values: string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function heldAtPlatformTreasury(destination: string | undefined, networkId: string, treasuryOwner?: string): boolean {
  return networkId === "solana:mainnet-beta" && Boolean(treasuryOwner) && destination === `${networkId}:${treasuryOwner}`;
}

/**
 * Materialize one character's owner allocation from its immutable quote and the
 * commission's verified payment, settlement, and refund records.
 */
export function projectCharacterAccountTransaction(
  record: RealizeCommissionRecord,
  quote: RealizeQuoteV1 | undefined,
  treasuryOwner: string | undefined,
  now = record.updated_at
): CharacterAccountTransaction | undefined {
  const paymentIntent = record.payment_intent;
  const acceptedQuoteHash = record.commission.accepted_quote_hash;
  if (!quote || !record.commission.quote_id || quote.quote_id !== record.commission.quote_id || quote.commission_id !== record.commission.commission_id || quote.creator_id !== record.commission.creator_id || !quote.network_id || !quote.usdc_mint || !paymentIntent || !acceptedQuoteHash || quote.canonical_quote_hash !== acceptedQuoteHash || paymentIntent.payment_intent_id !== record.commission.payment_intent_id || paymentIntent.commission_id !== record.commission.commission_id || paymentIntent.quote_id !== quote.quote_id || paymentIntent.accepted_quote_hash !== acceptedQuoteHash || paymentIntent.amount_usdc_atomic !== quote.total_amount_usdc_atomic || paymentIntent.network_id !== quote.network_id) return undefined;
  const owners = quote.payout_recipients.filter((payout) => payout.role === "character_owner");
  if (owners.length === 0) return undefined;

  const total = sum(owners.map((payout) => payout.amount_usdc_atomic));
  const response = record.settlement_response;
  const allPayoutsSettled = response?.status === "settled" && response.settled_amount_usdc_atomic === quote.total_amount_usdc_atomic && response.failed_payout_ids.length === 0;
  const settledIds = new Set(allPayoutsSettled ? quote.payout_recipients.map((payout) => payout.payout_id) : response?.settled_payout_ids ?? []);
  const failedIds = new Set(response?.failed_payout_ids ?? []);
  const ownerRows: CharacterAccountPayout[] = owners.map((payout) => ({
    payout_id: payout.payout_id,
    recipient_id: payout.recipient_id,
    amount_usdc_atomic: payout.amount_usdc_atomic,
    ...(payout.destination ? {destination: payout.destination} : {}),
    custody: !payout.destination ? "unknown" : heldAtPlatformTreasury(payout.destination, quote.network_id!, treasuryOwner) ? "platform_treasury" : "external_wallet",
    status: settledIds.has(payout.payout_id) ? "settled" : failedIds.has(payout.payout_id) ? "failed" : "pending"
  }));
  const available = sum(ownerRows.filter((payout) => payout.custody === "platform_treasury" && payout.status === "settled").map((payout) => payout.amount_usdc_atomic));
  const paid = sum(ownerRows.filter((payout) => payout.custody === "external_wallet" && payout.status === "settled").map((payout) => payout.amount_usdc_atomic));
  const unclassified = sum(ownerRows.filter((payout) => payout.custody === "unknown" && payout.status === "settled").map((payout) => payout.amount_usdc_atomic));
  const refunded = record.commission.state === "REFUNDED" || record.resolution_outcome === "refunded" ? total : 0n;
  const refundInProgress = record.commission.payment_state === "refund_pending" || record.commission.state === "REFUND_PENDING";
  const funded = Boolean(record.funding_signature) && ["captured", "settled", "refund_pending", "refunded"].includes(record.commission.payment_state);
  const pending = funded && refunded === 0n && !refundInProgress ? total - available - paid - unclassified : 0n;

  let status: CharacterAccountTransaction["status"];
  if (record.resolution_outcome === "manual_review" || record.commission.state === "MANUAL_REVIEW" || unclassified > 0n) status = "manual_review";
  else if (refunded > 0n) status = "refunded";
  else if (refundInProgress) status = "refund_pending";
  else if (available > 0n && paid > 0n) status = "mixed";
  else if (available === total) status = "available";
  else if (paid === total) status = "paid";
  else if (available > 0n || paid > 0n) status = "partially_settled";
  else if (!funded) status = record.commission.accepted_quote_hash ? "awaiting_payment" : "quoted";
  else if (record.commission.state === "COMPLETED" || record.settlement_status !== "not_started") status = "settlement_pending";
  else status = "in_progress";

  return {
    transaction_id: idFor(record.commission.creator_id, record.commission.commission_id),
    character_id: record.commission.creator_id,
    commission_id: record.commission.commission_id,
    payment_intent_id: paymentIntent.payment_intent_id,
    quote_id: quote.quote_id,
    accepted_quote_hash: acceptedQuoteHash,
    network_id: quote.network_id,
    usdc_mint: quote.usdc_mint,
    status,
    amount_usdc_atomic: total.toString(),
    available_usdc_atomic: available.toString(),
    pending_usdc_atomic: pending.toString(),
    paid_usdc_atomic: paid.toString(),
    unclassified_usdc_atomic: unclassified.toString(),
    refunded_usdc_atomic: refunded.toString(),
    ...(record.payer_wallet ? {payer_wallet: record.payer_wallet} : {}),
    ...(record.funding_signature ? {funding_transaction_signature: record.funding_signature} : {}),
    ...(record.settlement_instruction?.settlement_id ? {settlement_id: record.settlement_instruction.settlement_id} : {}),
    settlement_transaction_signatures: response?.transaction_signatures ?? [],
    ...(record.refund_response?.refund_id ? {refund_id: record.refund_response.refund_id} : {}),
    ...(record.refund_response?.status ? {refund_status: record.refund_response.status} : {}),
    ...(record.refund_response?.transaction_signature ? {refund_transaction_signature: record.refund_response.transaction_signature} : {}),
    owner_payouts: ownerRows,
    created_at: record.created_at,
    updated_at: now
  };
}

export function summarizeCharacterAccount(characterId: string, transactions: CharacterAccountTransaction[], now = new Date().toISOString()): CharacterAccountView {
  const balances = new Map<string, CharacterAccountBalance>();
  for (const transaction of transactions) {
    const key = `${transaction.network_id}\u0000${transaction.usdc_mint}`;
    const balance = balances.get(key) ?? {network_id: transaction.network_id, usdc_mint: transaction.usdc_mint, available_usdc_atomic: "0", pending_usdc_atomic: "0", lifetime_paid_usdc_atomic: "0", unclassified_usdc_atomic: "0", lifetime_refunded_usdc_atomic: "0"};
    balance.available_usdc_atomic = (BigInt(balance.available_usdc_atomic) + BigInt(transaction.available_usdc_atomic)).toString();
    balance.pending_usdc_atomic = (BigInt(balance.pending_usdc_atomic) + BigInt(transaction.pending_usdc_atomic)).toString();
    balance.lifetime_paid_usdc_atomic = (BigInt(balance.lifetime_paid_usdc_atomic) + BigInt(transaction.paid_usdc_atomic)).toString();
    balance.unclassified_usdc_atomic = (BigInt(balance.unclassified_usdc_atomic) + BigInt(transaction.unclassified_usdc_atomic)).toString();
    balance.lifetime_refunded_usdc_atomic = (BigInt(balance.lifetime_refunded_usdc_atomic) + BigInt(transaction.refunded_usdc_atomic)).toString();
    balances.set(key, balance);
  }
  return {
    character_id: characterId,
    custody_model: "platform_treasury_liability",
    balances: [...balances.values()].filter(hasAccountActivity).sort((left, right) => left.network_id.localeCompare(right.network_id) || left.usdc_mint.localeCompare(right.usdc_mint)),
    transactions: [...transactions].sort((left, right) => right.created_at.localeCompare(left.created_at) || left.commission_id.localeCompare(right.commission_id)),
    updated_at: now
  };
}

import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {Keypair} from "@solana/web3.js";
import {computeRealizeQuoteHash, generateKeyPair, publicKeyBase64, RealizeQuoteV1Schema, signProvenanceRecord, signRealizeQuote, type ProvenanceRecordV1} from "@vox/protocol";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import type {NftMediaInput} from "../apps/api/src/nft.js";
import type {RealizeCommissionRecord, VoxStore} from "../apps/api/src/types.js";

/** Persist the verified aggregate that production finalization creates. No RPC or provider calls. */
export async function seedPaidNftSource(store: VoxStore, media: NftMediaInput): Promise<RealizeCommissionRecord> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const issuer = generateKeyPair(new Uint8Array(32).fill(45));
  const rawQuote = {
    ...JSON.parse(readFileSync(new URL("../packages/protocol/fixtures/realize/bob-one-dollar-special-video.quote.json", import.meta.url), "utf8")),
    quote_id: `${media.source_id}:quote`,
    commission_id: media.source_id,
    creator_id: media.creator_id,
    generation_provider_id: media.provider_id,
    requested_generation_parameters: media.request_parameters,
    network_id: "solana:mainnet-beta",
    usdc_mint: MAINNET_USDC_MINT,
    issuer_public_key: publicKeyBase64(issuer.publicKey),
    issued_at: now,
    expires_at: expiresAt
  };
  const hash = computeRealizeQuoteHash(rawQuote);
  const quote = RealizeQuoteV1Schema.parse({...rawQuote, canonical_quote_hash: hash, signature: signRealizeQuote(hash, issuer.secretKey)});
  await store.createRealizeQuote(quote);
  const intentId = `vox:payment-intent:${createHash("sha256").update(`${media.source_id}\u0000${quote.canonical_quote_hash}`).digest("hex")}`;
  const fulfillmentId = `${media.source_id}:fulfillment`;
  const payer = Keypair.generate().publicKey.toBase58();
  const output = {uri: media.media_uri, sha256: media.media_sha256, media_type: media.media_type, byte_length: media.byte_length!};
  const unsignedProvenance: Omit<ProvenanceRecordV1, "signature"> = {
    protocol_version: "realize/1", provenance_record_id: media.provenance_record_id!, subject_type: "commission", subject_id: media.source_id,
    creator_id: media.creator_id!, generation_provider_id: media.provider_id, commission_id: media.source_id, quote_hash: quote.canonical_quote_hash,
    rights_agreement_reference: quote.rights_agreement_reference, inputs: [], outputs: [output], parent_record_ids: [], created_at: now,
    issuer_id: quote.issuer_id, issuer_key_id: quote.issuer_key_id
  };
  const provenance = {...unsignedProvenance, signature: signProvenanceRecord(unsignedProvenance, issuer.secretKey)};
  await store.createRealizeProvenance(provenance);
  return store.createRealizeCommission({
    commission: {
      protocol_version: "realize/1", commission_id: media.source_id, commissioner_id: media.owner_id, creator_id: media.creator_id!,
      capability_id: "capability:nft-fixture", requested_generation_parameters: media.request_parameters, quote_id: quote.quote_id,
      accepted_quote_hash: quote.canonical_quote_hash, rights_agreement_reference: quote.rights_agreement_reference,
      state: "COMPLETED", payment_state: "captured", fulfillment_state: "completed", payment_intent_id: intentId,
      fulfillment_request_id: fulfillmentId, created_at: now, updated_at: now
    },
    payment_intent: {
      protocol_version: "realize/1", payment_intent_id: intentId, commission_id: media.source_id, quote_id: quote.quote_id,
      accepted_quote_hash: quote.canonical_quote_hash, payer_id: media.owner_id, amount_usdc_atomic: quote.total_amount_usdc_atomic,
      asset: "USDC", network_id: "solana:mainnet-beta", status: "captured", idempotency_key: intentId, expires_at: expiresAt, created_at: now
    },
    direct_funding: {
      mode: "direct", custody_model: "backend_managed", network_id: "solana:mainnet-beta", usdc_mint: MAINNET_USDC_MINT,
      destination_token_account: Keypair.generate().publicKey.toBase58(), destination_owner: Keypair.generate().publicKey.toBase58(),
      amount_usdc_atomic: quote.total_amount_usdc_atomic, payment_reference: `vox:realize:payment:${intentId}:${quote.canonical_quote_hash}`,
      payer_wallet: payer, commission_id: media.source_id, quote_id: quote.quote_id, accepted_quote_hash: quote.canonical_quote_hash, expires_at: expiresAt
    },
    payer_wallet: payer, funding_signature: "1".repeat(88), funding_network_id: "solana:mainnet-beta", funding_verified_at: now, funded_at: now,
    rights_reviewed_at: now, nft_publication_consent: true, nft_publication_consent_at: now,
    fulfillment_result: {
      protocol_version: "realize/1", fulfillment_request_id: fulfillmentId, commission_id: media.source_id,
      generation_provider_id: media.provider_id, status: "completed", outputs: [output], completed_at: now
    },
    provenance_record_id: media.provenance_record_id, resolution_outcome: "fulfilled", resolution_reason: "verified_generation_completed",
    resolution_events: [{event_id: `${media.source_id}:completed`, action: "generation_completed", actor_type: "populi", actor_id: "verified-provider-result", occurred_at: now}],
    settlement_status: "pending", created_at: now, updated_at: now
  });
}

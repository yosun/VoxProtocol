import {describe, expect, it} from "vitest";
import {Keypair} from "@solana/web3.js";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {generateKeyPair, publicKeyBase64, bytesToHex, domainHash, utf8} from "@vox/protocol";
import {buildRealizeQuote, DEFAULT_MAINNET_PRICING_POLICY, generationParametersHash, RealizeCreatorPayoutConfigurationV1Schema, requiresExplicitMainnetDisbursementApproval} from "../apps/api/src/realize-engine.js";

function quoteForProviderCost(priceAtomic: string) {
  const owner = Keypair.generate().publicKey.toBase58();
  const issuer = generateKeyPair(new Uint8Array(32).fill(81));
  const issuerId = "vox.test.mainnet.pricing";
  const issuerPublicKey = publicKeyBase64(issuer.publicKey);
  const issuerKeyId = `vox:key:${bytesToHex(domainHash("vox.realize.issuer.key.v1", utf8(`${issuerId}\u0000${issuerPublicKey}`)))}`;
  const creatorId = "vox:agent:first-party-bob";
  const parameters = {concept: "A short test scene", duration_seconds: 6};
  const now = new Date().toISOString();
  const providerPrice = {
    protocol_version: "realize/1" as const,
    request_id: "pricing:mainnet-policy-test",
    provider_quote_id: "provider-price:mainnet-policy-test",
    creator_id: creatorId,
    capability_id: "video:short-form",
    generation_provider_id: "provider:video:example",
    requested_generation_parameters_hash: generationParametersHash(parameters),
    price_usdc_atomic: priceAtomic,
    issued_at: now,
    expires_at: new Date(Date.now() + 600_000).toISOString()
  };
  const configuration = RealizeCreatorPayoutConfigurationV1Schema.parse({
    protocol_version: "realize/1",
    creator_id: creatorId,
    version: 1,
    populi_api_base_url: "https://populi.example.test",
    rights_agreement_reference: `vox:rights:first-party-ai:v1:${creatorId}`,
    rights_agreement_version: 1,
    rights_subject_id: `vox:creator:${creatorId}`,
    rights_agreement_hash: "a".repeat(64),
    usdc_mint: MAINNET_USDC_MINT,
    network_id: "solana:mainnet-beta",
    settlement_program_version: "spl-usdc-mainnet-v1",
    funding_destination_token_account: Keypair.generate().publicKey.toBase58(),
    rights_policy_mode: "first_party",
    mainnet_pricing_policy: DEFAULT_MAINNET_PRICING_POLICY,
    provider_payouts: [{provider_id: "provider:video:example", recipients: [{recipient_id: "provider:video:example", destination: owner, basis_points: 10_000}]}],
    character_owner_id: creatorId,
    character_owner_markup: {fee: {}, recipients: [{recipient_id: creatorId, destination: owner, basis_points: 10_000}]},
    platform_fee: {fee: {}, recipients: [{recipient_id: "vox:platform", destination: owner, basis_points: 10_000}]},
    additional_beneficiaries: []
  });
  return buildRealizeQuote({
    configuration,
    commissionId: "vox:commission:mainnet-policy-test",
    pricingRequestId: "pricing:mainnet-policy-test",
    pricingRequestHash: "b".repeat(64),
    capabilityId: "video:short-form",
    generationProviderId: "provider:video:example",
    generationParameters: parameters,
    outputMediaTypes: ["video/mp4"],
    providerPrice,
    issuedAt: now,
    issuerId,
    issuerKeyId,
    issuerPublicKey,
    issuerSecretKey: issuer.secretKey
  });
}

describe("Mainnet dynamic Realize pricing", () => {
  it("requires explicit approval before Mainnet payouts or refunds", () => {
    expect(requiresExplicitMainnetDisbursementApproval("solana:mainnet-beta")).toBe(true);
    expect(requiresExplicitMainnetDisbursementApproval("solana:devnet")).toBe(false);
  });

  it("prices from the live provider quote, enforces the 1 USDC floor, and pins the 25/70/5 provider/owner/VOX allocation", () => {
    const scaled = quoteForProviderCost("750000");
    expect(scaled.provider_cost_usdc_atomic).toBe("750000");
    expect(scaled.total_amount_usdc_atomic).toBe("3000000");
    expect([scaled.provider_base_price_usdc_atomic, scaled.character_owner_markup_usdc_atomic, scaled.platform_fee_usdc_atomic]).toEqual(["750000", "2100000", "150000"]);
    expect(scaled.revenue_allocation_policy).toEqual(DEFAULT_MAINNET_PRICING_POLICY);

    const floor = quoteForProviderCost("100000");
    expect(floor.total_amount_usdc_atomic).toBe("1000000");
    expect([floor.provider_base_price_usdc_atomic, floor.character_owner_markup_usdc_atomic, floor.platform_fee_usdc_atomic]).toEqual(["250000", "700000", "50000"]);
    expect(BigInt(floor.provider_base_price_usdc_atomic)).toBeGreaterThanOrEqual(BigInt(floor.provider_cost_usdc_atomic!));

    const exactOneDollar = quoteForProviderCost("250000");
    expect(exactOneDollar.total_amount_usdc_atomic).toBe("1000000");
    expect([exactOneDollar.provider_base_price_usdc_atomic, exactOneDollar.character_owner_markup_usdc_atomic, exactOneDollar.platform_fee_usdc_atomic]).toEqual(["250000", "700000", "50000"]);
  });

  it("allows the configured 10,000 USDC cap and rejects a dynamic quote above it", () => {
    expect(quoteForProviderCost("2500000000").total_amount_usdc_atomic).toBe("10000000000");
    expect(() => quoteForProviderCost("2500000001")).toThrow("exceeds the configured maximum");
  });
});

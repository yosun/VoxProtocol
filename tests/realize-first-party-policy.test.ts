import {afterEach, describe, expect, it, vi} from "vitest";
import {Keypair} from "@solana/web3.js";
import {MAINNET_USDC_MINT} from "@vox/realize-solana";
import {createAgent} from "@vox/identity";
import {buildApp} from "../apps/api/src/app.js";
import {MemoryStore} from "../apps/api/src/store.js";
import {createFirstPartyRealizeRightsPolicy, DEFAULT_MAINNET_PRICING_POLICY, RealizeCreatorPayoutConfigurationV1Schema, type PopuliRealizeClient} from "../apps/api/src/realize-engine.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});

describe("first-party Realize policy", () => {
  it("configures Bob without a signed creator agreement or a separate owner wallet", async () => {
    const creator = createAgent({display_name: "Bob", handle: "@bob", description: "VOX first-party AI creator"}, new Uint8Array(32).fill(91));
    const store = new MemoryStore();
    await store.registerAgent(creator.registration);
    vi.stubEnv("VOX_REALIZE_FIRST_PARTY_CREATOR_IDS", creator.registration.agent_id);

    const treasuryOwner = Keypair.generate().publicKey.toBase58();
    const rightsSubjectId = `vox:creator:${creator.registration.agent_id}`;
    const policy = createFirstPartyRealizeRightsPolicy({creator_id: creator.registration.agent_id, character_owner_id: creator.registration.agent_id, rights_subject_id: rightsSubjectId});
    const config = RealizeCreatorPayoutConfigurationV1Schema.parse({
      protocol_version: "realize/1", creator_id: creator.registration.agent_id, version: 1,
      populi_api_base_url: "https://populi.example.test", populi_api_token_env: "VOX_POPULI_API_TOKEN",
      artifact_hosts: ["populi.example.test"], rights_agreement_reference: policy.policy.policy_id,
      rights_agreement_version: policy.policy.version, rights_subject_id: rightsSubjectId,
      rights_agreement_hash: policy.terms_hash, usdc_mint: MAINNET_USDC_MINT,
      network_id: "solana:mainnet-beta", settlement_program_version: "spl-usdc-mainnet-v1",
      funding_destination_token_account: Keypair.generate().publicKey.toBase58(), rights_policy_mode: "first_party",
      mainnet_pricing_policy: DEFAULT_MAINNET_PRICING_POLICY,
      provider_payouts: [{provider_id: "provider:video:example", recipients: [{recipient_id: "provider:video:example", destination: treasuryOwner, basis_points: 10_000}]}],
      character_owner_id: creator.registration.agent_id,
      character_owner_markup: {fee: {}, recipients: [{recipient_id: creator.registration.agent_id, destination: treasuryOwner, basis_points: 10_000}]},
      platform_fee: {fee: {}, recipients: [{recipient_id: "vox:platform", destination: treasuryOwner, basis_points: 10_000}]},
      additional_beneficiaries: []
    });
    const populi: PopuliRealizeClient = {
      getCapabilities: vi.fn(async () => ({protocol_version: "realize/1", creator_id: creator.registration.agent_id, generation_provider_ids: ["provider:video:example"], capabilities: [{capability_id: "video:short-form", input_schema_uri: "https://populi.example.test/schema", output_media_types: ["video/mp4"]}], updated_at: new Date().toISOString()})),
      getInputSchema: vi.fn(), getCurrentPrice: vi.fn(), requestFulfillment: vi.fn(), getFulfillment: vi.fn()
    };
    app = await buildApp({store, internalToken: "test-internal-token-long-enough-123456", populiRealizeClient: populi});

    const configured = await app.inject({method: "POST", url: `/v1/internal/realize/creators/${encodeURIComponent(creator.registration.agent_id)}/payout-configurations`, headers: {"x-vox-internal-token": "test-internal-token-long-enough-123456"}, payload: config});
    expect(configured.statusCode, configured.body).toBe(201);

    const capabilities = await app.inject({method: "GET", url: `/v1/realize/creators/${encodeURIComponent(creator.registration.agent_id)}/capabilities`});
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({rights_policy_mode: "first_party", rights_agreement_references: [policy.policy.policy_id]});

    const rights = await app.inject({method: "GET", url: `/v1/rights/agreements/${encodeURIComponent(policy.policy.policy_id)}?version=1`});
    expect(rights.statusCode).toBe(200);
    expect(rights.json()).toMatchObject({policy_mode: "first_party", policy: policy.policy, terms_hash: policy.terms_hash, status: "active", effective_now: true});
    expect(rights.json()).not.toHaveProperty("agreement");
    expect(rights.json()).not.toHaveProperty("acceptances");
    expect(config.character_owner_markup.recipients[0]!.destination).toBe(treasuryOwner);
  });
});

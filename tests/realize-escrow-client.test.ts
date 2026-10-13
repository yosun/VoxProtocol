import {describe,expect,it} from "vitest";
import nacl from "tweetnacl";
import {address,getAddressDecoder,getAddressEncoder} from "@solana/kit";
import {bytesToBase64Url,bytesToHex,computeRealizeQuoteHash,signRealizeQuote,sha256,utf8} from "@vox/protocol";
import {readFileSync} from "node:fs";
import {buildRealizeQuote, generationParametersHash} from "../apps/api/src/realize-engine.js";
import {
  ASSOCIATED_TOKEN_PROGRAM, ED25519_PROGRAM, ESCROW_IDL, INSTRUCTIONS_SYSVAR, LOCALNET_PROGRAM,
  MAINNET_USDC_MINT, PROTOCOL_VERSION, SETTLEMENT_NETWORKS, SYSTEM_PROGRAM, TOKEN_PROGRAM,
  assertConfigMatchesNetwork, commissionSeed, configAddress, decodeConfigAccount, escrowAddresses,
  escrowCommitment, getEscrowInstruction, prepareEscrow, quoteVerificationInstruction,
  settlementQuoteDigest, settlementNetworksFromEnvironment, unclaimedIndices, usdcAta,
  type OnchainConfigSnapshot, type SettlementNetworkConfig,
} from "../packages/realize-solana/src/index.js";

const wallet=(byte:number)=>getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const domainSigner=nacl.sign.keyPair();
const domainAuthority=address(getAddressDecoder().decode(domainSigner.publicKey));
const issuer=nacl.sign.keyPair();
const clusterFor=(cluster:"solana:devnet"|"solana:mainnet-beta"="solana:mainnet-beta")=>cluster;
async function fixture(clusterIdentity: ReturnType<typeof clusterFor>="solana:mainnet-beta") {
  const program=LOCALNET_PROGRAM;
  const usdcMint=clusterIdentity==="solana:mainnet-beta"?MAINNET_USDC_MINT:address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const network:SettlementNetworkConfig={
    clusterIdentity,
    rpcEndpoint:clusterIdentity==="solana:devnet"?"https://api.devnet.solana.com":"https://api.mainnet-beta.solana.com",
    programId:program,
    usdcMint,
    tokenProgram:TOKEN_PROGRAM,
    admin:wallet(4),
    quoteAuthority:domainAuthority,
    fulfillmentAuthority:wallet(6),
    protocolVersion:PROTOCOL_VERSION,
    active:true,
  };
  const cfg=await configAddress(program);
  const config:OnchainConfigSnapshot={address:cfg,admin:network.admin!,quoteAuthority:network.quoteAuthority!,fulfillmentAuthority:network.fulfillmentAuthority!,mint:network.usdcMint,tokenProgram:network.tokenProgram,clusterIdentity,protocolVersion:PROTOCOL_VERSION,revision:0n};
  const quote=JSON.parse(readFileSync(new URL("../packages/protocol/fixtures/realize/bob-one-dollar-special-video.quote.json",import.meta.url),"utf8"));
  quote.issuer_public_key=bytesToBase64Url(issuer.publicKey);
  const prefix=clusterIdentity==="solana:mainnet-beta"?"mainnet":"devnet";
  quote.payout_recipients.forEach((p:{destination?:string},i:number)=>{p.destination=`solana:${prefix}:${wallet(i+1)}`;});
  quote.canonical_quote_hash=computeRealizeQuoteHash(quote);
  quote.signature=signRealizeQuote(quote.canonical_quote_hash,issuer.secretKey);
  const commission={protocol_version:"realize/1",commission_id:"commission:escrow-test",commissioner_id:"commissioner:test",creator_id:quote.creator_id,capability_id:"video",requested_generation_parameters:quote.requested_generation_parameters,quote_id:quote.quote_id,accepted_quote_hash:quote.canonical_quote_hash,rights_agreement_reference:quote.rights_agreement_reference,state:"AWAITING_PAYMENT",payment_state:"pending",fulfillment_state:"not_started",created_at:quote.issued_at,updated_at:quote.issued_at};
  return {quote,commission,authorizedIssuerPublicKey:quote.issuer_public_key,network,config,payer:wallet(5),nowSeconds:1791741600n,refundAfter:1791763200n};
}
function resign(input:Awaited<ReturnType<typeof fixture>>) {
  input.quote.canonical_quote_hash=computeRealizeQuoteHash(input.quote);
  input.quote.signature=signRealizeQuote(input.quote.canonical_quote_hash,issuer.secretKey);
  input.commission.accepted_quote_hash=input.quote.canonical_quote_hash;
}

describe("Realize escrow adapter",()=> {
  it("accepts API-built quotes with millisecond timestamps and network-qualified payout wallets", async () => {
    const input = await fixture("solana:devnet");
    const issuedAt = new Date(Number(input.nowSeconds) * 1000 + 410).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + 300_000).toISOString();
    const fee = (amount: string) => ({fixed_amount_usdc_atomic: amount, percent_basis_points: 0, minimum_amount_usdc_atomic: "0", percentage_basis: "provider_base" as const});
    const recipients = (id: string, destination: string) => [{recipient_id: id, destination, basis_points: 10_000}];
    const configuration = {protocol_version: "realize/1" as const, creator_id: input.quote.creator_id, version: 1, populi_api_base_url: "https://provider.example.test", populi_api_token_env: "VOX_POPULI_API_TOKEN", artifact_hosts: [], max_artifact_bytes: 100_000_000, rights_agreement_reference: input.quote.rights_agreement_reference, rights_agreement_version: 1, rights_subject_id: "post:test", rights_agreement_hash: "a".repeat(64), usdc_mint: input.network.usdcMint, network_id: "solana:devnet" as const, settlement_program_version: "realize-escrow/2", funding_destination_token_account: wallet(4), quote_ttl_seconds: 300, provider_payouts: [{provider_id: "provider:video:example", recipients: recipients("provider:test", wallet(1))}], character_owner_id: "owner:test", character_owner_markup: {fee: fee("200000"), recipients: recipients("owner:test", wallet(2))}, platform_fee: {fee: fee("50000"), recipients: recipients("platform:test", wallet(3))}, additional_beneficiaries: []};
    const providerPrice = {protocol_version: "realize/1" as const, request_id: "pricing:test", provider_quote_id: "provider-quote:test", creator_id: input.quote.creator_id, capability_id: "video", generation_provider_id: "provider:video:example", requested_generation_parameters_hash: generationParametersHash(input.quote.requested_generation_parameters), price_usdc_atomic: "750000", issued_at: issuedAt, expires_at: expiresAt};
    const quote = buildRealizeQuote({configuration, commissionId: input.commission.commission_id, pricingRequestId: "pricing:test", pricingRequestHash: "b".repeat(64), capabilityId: "video", generationProviderId: "provider:video:example", generationParameters: input.quote.requested_generation_parameters, outputMediaTypes: ["video/mp4"], providerPrice, issuedAt, issuerId: "instance:test", issuerKeyId: "key:test", issuerPublicKey: input.authorizedIssuerPublicKey, issuerSecretKey: issuer.secretKey});
    input.quote = quote;
    input.commission.quote_id = quote.quote_id;
    input.commission.accepted_quote_hash = quote.canonical_quote_hash;
    const prepared = await prepareEscrow(input);
    expect(quote.payout_recipients.map((recipient) => recipient.destination)).toEqual([`solana:devnet:${wallet(1)}`, `solana:devnet:${wallet(2)}`, `solana:devnet:${wallet(3)}`]);
    expect(prepared.createArgs.total).toBe(1_000_000n);
    expect(prepared.createArgs.quote_expires_at).toBe(input.nowSeconds + 300n);
  });
  it("converts millisecond quote deadlines to whole seconds without extending their validity", async () => {
    const input = await fixture();
    input.quote.expires_at = input.quote.expires_at.replace(/\.\d{3}Z$/, ".410Z");
    if (!input.quote.expires_at.includes(".410Z")) input.quote.expires_at = input.quote.expires_at.replace(/Z$/, ".410Z");
    resign(input);
    const prepared = await prepareEscrow(input);
    expect(prepared.createArgs.quote_expires_at).toBe(BigInt(Math.floor(Date.parse(input.quote.expires_at) / 1000)));
    expect(prepared.createArgs.quote_expires_at * 1000n).toBeLessThanOrEqual(BigInt(Date.parse(input.quote.expires_at)));
  });
  it("uses independent devnet and inactive mainnet deployment profiles",()=> {
    expect(SETTLEMENT_NETWORKS.devnet.clusterIdentity).toBe("solana:devnet");
    expect(SETTLEMENT_NETWORKS.devnet.programId).toBe(LOCALNET_PROGRAM);
    expect(SETTLEMENT_NETWORKS.devnet.usdcMint).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(SETTLEMENT_NETWORKS.devnet.active).toBe(false);
    expect(SETTLEMENT_NETWORKS.devnet.admin).toBe("4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL");
    expect(SETTLEMENT_NETWORKS.mainnet.clusterIdentity).toBe("solana:mainnet-beta");
    expect(SETTLEMENT_NETWORKS.mainnet.usdcMint).toBe(MAINNET_USDC_MINT);
    expect(SETTLEMENT_NETWORKS.mainnet.programId).toBeNull();
    expect(SETTLEMENT_NETWORKS.mainnet.active).toBe(false);
    const configured=settlementNetworksFromEnvironment({
      VOX_REALIZE_DEVNET_RPC_URL:"https://rpc.example.test",
      VOX_REALIZE_DEVNET_ENABLED:"true",
      VOX_REALIZE_DEVNET_PROGRAM_ID:wallet(10),VOX_REALIZE_DEVNET_ADMIN:wallet(11),
      VOX_REALIZE_DEVNET_QUOTE_AUTHORITY:wallet(12),VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY:wallet(13),
      VOX_REALIZE_DEVNET_USDC_MINT:"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      VOX_REALIZE_MAINNET_PROGRAM_ID:wallet(14),VOX_REALIZE_MAINNET_ADMIN:wallet(15),
      VOX_REALIZE_MAINNET_QUOTE_AUTHORITY:wallet(16),VOX_REALIZE_MAINNET_FULFILLMENT_AUTHORITY:wallet(17),
    });
    expect(configured.devnet.rpcEndpoint).toBe("https://rpc.example.test");
    expect(configured.devnet.active).toBe(true);
    expect(settlementNetworksFromEnvironment({VOX_REALIZE_DEVNET_PROGRAM_ID:wallet(10),
      VOX_REALIZE_DEVNET_ADMIN:wallet(11),VOX_REALIZE_DEVNET_QUOTE_AUTHORITY:wallet(12),
      VOX_REALIZE_DEVNET_FULFILLMENT_AUTHORITY:wallet(13)}).devnet.active).toBe(false);
    expect(configured.mainnet.active).toBe(false);
    expect(()=>settlementNetworksFromEnvironment({VOX_REALIZE_DEVNET_USDC_MINT:MAINNET_USDC_MINT})).toThrow(/pinned/);
    expect(settlementNetworksFromEnvironment({VOX_REALIZE_MAINNET_ENABLED:"true",VOX_REALIZE_MAINNET_PROGRAM_ID:wallet(14),
      VOX_REALIZE_MAINNET_ADMIN:wallet(15),VOX_REALIZE_MAINNET_QUOTE_AUTHORITY:wallet(16),
      VOX_REALIZE_MAINNET_FULFILLMENT_AUTHORITY:wallet(17)}).mainnet.active).toBe(true);
  });
  it("validates signed quote acceptance and commits exact payouts to deployment and quote domains",async()=> {
    const p=await prepareEscrow(await fixture());
    expect(p.payouts.map(p=>p.amount)).toEqual([750000n,200000n,50000n]);
    expect(p.header.total).toBe(1000000n);
    expect(p.commitmentHex).toHaveLength(64);
    const swapped=[...p.payouts].reverse(); expect(bytesToHex(escrowCommitment(p.header,swapped))).not.toBe(p.commitmentHex);
    const changed=p.payouts.map((v,i)=>({...v,recipient:wallet(i+10)})); expect(bytesToHex(escrowCommitment(p.header,changed))).not.toBe(p.commitmentHex);
    expect(bytesToHex(escrowCommitment({...p.header,refundAfter:p.header.refundAfter+1n},p.payouts))).not.toBe(p.commitmentHex);
    expect(bytesToHex(settlementQuoteDigest({...p.header,quoteAuthority:domainAuthority,acceptedQuoteHash:p.header.quoteHash}))).toBe(bytesToHex(p.quoteDomainHash));
    expect(bytesToHex(settlementQuoteDigest({...p.header,program:wallet(17),quoteAuthority:domainAuthority,acceptedQuoteHash:p.header.quoteHash}))).not.toBe(bytesToHex(p.quoteDomainHash));
    const substitutedCommitment=p.header.commitment.slice(); substitutedCommitment[0]^=1;
    expect(bytesToHex(settlementQuoteDigest({...p.header,commitment:substitutedCommitment,quoteAuthority:domainAuthority,acceptedQuoteHash:p.header.quoteHash}))).not.toBe(bytesToHex(p.quoteDomainHash));
    const signature=nacl.sign.detached(p.quoteDomainHash,domainSigner.secretKey);
    const verify=quoteVerificationInstruction(domainAuthority,signature,p.quoteDomainHash);
    expect(verify.programAddress).toBe(ED25519_PROGRAM);
    expect(verify.data).toHaveLength(144);
    expect(verify.data.slice(112)).toEqual(p.quoteDomainHash);
  });
  it("rejects substitution, unaccepted quotes, bad config, and expired quotes",async()=> {
    let input=await fixture(); input.quote.payout_recipients[0].destination=`solana:mainnet:${wallet(9)}`; await expect(prepareEscrow(input)).rejects.toThrow();
    input=await fixture(); input.authorizedIssuerPublicKey=bytesToBase64Url(new Uint8Array(32)); await expect(prepareEscrow(input)).rejects.toThrow(/Unauthorized/);
    input=await fixture(); input.commission.requested_generation_parameters={concept:"substituted request"}; await expect(prepareEscrow(input)).rejects.toThrow(/accept/);
    input=await fixture(); input.commission.accepted_quote_hash="00".repeat(32); await expect(prepareEscrow(input)).rejects.toThrow(/accept/);
    input=await fixture(); input.nowSeconds=BigInt(Date.parse(input.quote.expires_at)/1000); await expect(prepareEscrow(input)).rejects.toThrow(/Expired/);
    input=await fixture(); input.config={...input.config,mint:wallet(99)}; await expect(prepareEscrow(input)).rejects.toThrow(/configuration/);
    input=await fixture(); input.network={...input.network,programId:null}; await expect(prepareEscrow(input)).rejects.toThrow(/program ID/);
  });
  it("rejects wrong-network recipients, duplicate payouts, rounding, and overflow",async()=> {
    let input=await fixture("solana:devnet"); input.quote.payout_recipients[0].destination=`solana:mainnet:${wallet(1)}`; resign(input); await expect(prepareEscrow(input)).rejects.toThrow(/devnet/);
    input=await fixture(); input.quote.payout_recipients[1].payout_id=input.quote.payout_recipients[0].payout_id; resign(input); await expect(prepareEscrow(input)).rejects.toThrow(/Duplicate|unique/);
    for(const amount of ["0.1","01","18446744073709551616"]) { input=await fixture(); input.quote.payout_recipients[0].amount_usdc_atomic=amount; resign(input); await expect(prepareEscrow(input)).rejects.toThrow(); }
    input=await fixture(); input.quote.payout_recipients[0].amount_usdc_atomic="749999"; resign(input); await expect(prepareEscrow(input)).rejects.toThrow();
  });
  it("derives one config PDA per program and deterministic commission, quote, and vault addresses",async()=> {
    const seed=commissionSeed("commission:test"); const hash=new Uint8Array(32).fill(7);
    const a=await escrowAddresses(LOCALNET_PROGRAM,seed,hash);
    const b=await escrowAddresses(LOCALNET_PROGRAM,seed,new Uint8Array(32).fill(8));
    expect(a.config).toBe(b.config); expect(a.escrow).toBe(b.escrow); expect(a.quoteUsed).not.toBe(b.quoteUsed);
    const otherCommission=await escrowAddresses(LOCALNET_PROGRAM,commissionSeed("commission:other"),hash);
    expect(otherCommission.quoteUsed).toBe(a.quoteUsed); expect(otherCommission.escrow).not.toBe(a.escrow);
    expect(await escrowAddresses(LOCALNET_PROGRAM,seed,hash)).toEqual(a);
    expect(await usdcAta(wallet(1),MAINNET_USDC_MINT)).toBe(await usdcAta(wallet(1),MAINNET_USDC_MINT));
  });
  it("decodes config only with correct owner, discriminator, cluster and fields",async()=> {
    const configAddressValue=await configAddress(LOCALNET_PROGRAM);
    const disc=sha256(utf8("account:Config")).slice(0,8);
    const data=new Uint8Array(188); data.set(disc); data.set(new Uint8Array(32).fill(4),8); data.set(new Uint8Array(32).fill(7),40); data.set(new Uint8Array(32).fill(6),72);
    data.set(new Uint8Array(32).fill(9),104); data.set(getAddressEncoder().encode(TOKEN_PROGRAM),136); data[168]=0; data[169]=2; data[171]=3; data[187]=254;
    const decoded=decodeConfigAccount(LOCALNET_PROGRAM,LOCALNET_PROGRAM,configAddressValue,data);
    expect(decoded.clusterIdentity).toBe("solana:localnet"); expect(decoded.protocolVersion).toBe(2); expect(decoded.revision).toBe(3n); expect(decoded.bump).toBe(254);
    expect(()=>decodeConfigAccount(LOCALNET_PROGRAM,wallet(1),configAddressValue,data)).toThrow(/owner/);
    const bad=data.slice(); bad[0]^=1; expect(()=>decodeConfigAccount(LOCALNET_PROGRAM,LOCALNET_PROGRAM,configAddressValue,bad)).toThrow(/data/);
  });
  it("tracks all 64 claims including the top bit and preserves outstanding entries",()=> {
    expect(unclaimedIndices(64,0n)).toHaveLength(64);
    expect(unclaimedIndices(64,(1n<<63n)-1n)).toEqual([63]);
    expect(unclaimedIndices(64,(1n<<64n)-1n)).toEqual([]);
    expect(unclaimedIndices(3,5n)).toEqual([1]);
    expect(()=>unclaimedIndices(65,0n)).toThrow();
  });
  it("uses generated IDL discriminators, deployment program ID, and exact Borsh encoding",async()=> {
    const p=await prepareEscrow(await fixture());
    const instruction=getEscrowInstruction("create_escrow",{payer:p.header.payer,config:p.accounts.config,escrow:p.accounts.escrow,quote_used:p.accounts.quoteUsed,mint:p.header.mint,vault:p.accounts.vault,token_program:TOKEN_PROGRAM,instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM},{args:p.createArgs},p.header.program);
    expect(instruction.data!.length).toBe(161);
    expect(Array.from(instruction.data!.slice(0,8))).toEqual(Array.from(sha256(utf8("global:create_escrow")).slice(0,8)));
    const substituted=getEscrowInstruction("fund",{payer:p.header.payer,config:p.accounts.config,escrow:p.accounts.escrow,mint:wallet(9),source:wallet(8),vault:p.accounts.vault,token_program:TOKEN_PROGRAM}, {},p.header.program);
    expect(substituted.accounts[3]?.address).toBe(wallet(9)); // on-chain config enforces the actual mint
    expect(()=>getEscrowInstruction("claim",{}, {},p.header.program)).toThrow();
    const disk=JSON.parse(readFileSync(new URL("../idl/realize_escrow.json",import.meta.url),"utf8")); expect(ESCROW_IDL).toEqual(disk);
    expect(ASSOCIATED_TOKEN_PROGRAM).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });
});

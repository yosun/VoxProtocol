import {AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction} from "@solana/kit";
import {CommissionV1Schema, RealizeQuoteV1Schema, canonicalize, base64UrlToBytes, bytesToHex, concatBytes, domainHash, hexToBytes, sha256, utf8, verifyRealizeQuoteSignature} from "@vox/protocol";
import idl from "./idl.json" with {type: "json"};

export const REALIZE_PROGRAM_ID = address("GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb");
/** @deprecated Use REALIZE_PROGRAM_ID; retained for local-validator test compatibility. */
export const LOCALNET_PROGRAM = REALIZE_PROGRAM_ID;
export const DEVNET_USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const MAINNET_USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
export const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");
export const ESCROW_IDL = idl;
export const PROTOCOL_VERSION = 2;
export type ClusterIdentity = "solana:localnet" | "solana:devnet" | "solana:mainnet-beta";

export interface SettlementNetworkConfig {
  readonly clusterIdentity: ClusterIdentity;
  readonly rpcEndpoint: string;
  readonly programId: Address | null;
  readonly usdcMint: Address;
  readonly tokenProgram: Address;
  readonly admin: Address | null;
  readonly quoteAuthority: Address | null;
  readonly fulfillmentAuthority: Address | null;
  readonly protocolVersion: number;
  readonly active: boolean;
}

/** Network profiles stay inactive until the deployed program/config has been explicitly enabled. */
export const SETTLEMENT_NETWORKS: Readonly<Record<"devnet" | "mainnet", SettlementNetworkConfig>> = {
  devnet: {
    clusterIdentity: "solana:devnet",
    rpcEndpoint: "https://api.devnet.solana.com",
    programId: REALIZE_PROGRAM_ID,
    usdcMint: DEVNET_USDC_MINT,
    tokenProgram: TOKEN_PROGRAM,
    admin: address("4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL"),
    quoteAuthority: address("6yj1txeBEHJX5RULpRHExRCXe4x2p8ZeWYgc5y353im4"),
    fulfillmentAuthority: address("8RiNuRwnJydiZq9tuAVBZWKw77UA7qovNMySJQS3AcE9"),
    protocolVersion: PROTOCOL_VERSION,
    active: false,
  },
  mainnet: {
    clusterIdentity: "solana:mainnet-beta",
    rpcEndpoint: "https://api.mainnet-beta.solana.com",
    programId: null,
    usdcMint: MAINNET_USDC_MINT,
    tokenProgram: TOKEN_PROGRAM,
    admin: null,
    quoteAuthority: null,
    fulfillmentAuthority: null,
    protocolVersion: PROTOCOL_VERSION,
    active: false,
  },
};

export type SettlementEnvironment = Readonly<Record<string, string | undefined>>;
function optionalAddress(value: string | undefined, name: string): Address | null {
  if (!value?.trim()) return null;
  try { return address(value.trim()); } catch { throw new Error(`${name} must be a valid Solana address`); }
}
function configuredMint(value: string | undefined, expected: Address, name: string): Address {
  if (value?.trim() && optionalAddress(value, name) !== expected) throw new Error(`${name} is pinned to official USDC for this cluster`);
  return expected;
}

/** Build distinct public deployment profiles from environment/configuration values.
 * Mint overrides are checked against Circle's official cluster mint and cannot activate
 * settlement by themselves. Each cluster requires an explicit enablement flag.
 */
export function settlementNetworksFromEnvironment(env: SettlementEnvironment) {
  const make = (cluster: "devnet" | "mainnet", enabled: boolean): SettlementNetworkConfig => {
    const base = SETTLEMENT_NETWORKS[cluster];
    const prefix = cluster === "devnet" ? "VOX_REALIZE_DEVNET" : "VOX_REALIZE_MAINNET";
    const programId = optionalAddress(env[`${prefix}_PROGRAM_ID`], `${prefix}_PROGRAM_ID`);
    const admin = optionalAddress(env[`${prefix}_ADMIN`], `${prefix}_ADMIN`);
    const quoteAuthority = optionalAddress(env[`${prefix}_QUOTE_AUTHORITY`], `${prefix}_QUOTE_AUTHORITY`);
    const fulfillmentAuthority = optionalAddress(env[`${prefix}_FULFILLMENT_AUTHORITY`], `${prefix}_FULFILLMENT_AUTHORITY`);
    const configured = Boolean(programId && admin && quoteAuthority && fulfillmentAuthority);
    return {
      ...base,
      rpcEndpoint: env[`${prefix}_RPC_URL`]?.trim() || base.rpcEndpoint,
      usdcMint: configuredMint(env[`${prefix}_USDC_MINT`], base.usdcMint, `${prefix}_USDC_MINT`),
      programId, admin, quoteAuthority, fulfillmentAuthority,
      active: enabled && configured,
    };
  };
  return {
    devnet: make("devnet", env.VOX_REALIZE_DEVNET_ENABLED === "true"),
    mainnet: make("mainnet", env.VOX_REALIZE_MAINNET_ENABLED === "true"),
  } as const;
}

const pk = (a: Address) => Uint8Array.from(getAddressEncoder().encode(a));
const MAX_U64 = (1n << 64n) - 1n;
function integer(value: unknown, bits: number, signed = false): Uint8Array {
  if (typeof value !== "bigint" && !(bits <= 32 && typeof value === "number" && Number.isSafeInteger(value))) throw new Error("Amounts and timestamps must be bigint");
  let n = BigInt(value as bigint | number);
  const bound = 1n << BigInt(bits);
  if (n < (signed ? -bound / 2n : 0n) || n >= (signed ? bound / 2n : bound)) throw new Error("Integer out of range");
  if (n < 0n) n += bound;
  return Uint8Array.from({length: bits / 8}, (_, i) => Number(n >> BigInt(i * 8) & 255n));
}
function unixSeconds(value: string): bigint {
  const ms = Date.parse(value);
  // Realize quotes use ISO timestamps with millisecond precision while Solana
  // stores deadlines as whole seconds. Flooring expires an escrow no later
  // than the signed quote and avoids changing the quote's signed representation.
  if (!Number.isSafeInteger(ms)) throw new Error("Escrow timestamp is invalid");
  return BigInt(Math.floor(ms / 1000));
}
function clusterForQuote(cluster: ClusterIdentity): string {
  if (cluster === "solana:mainnet-beta") return "mainnet";
  if (cluster === "solana:devnet") return "devnet";
  return "localnet";
}
export function commissionSeed(id: string): Uint8Array {
  if (!id || id.length > 256) throw new Error("Invalid commission ID");
  return domainHash("vox.realize.solana.commission.v1", utf8(id));
}
export async function configAddress(program: Address): Promise<Address> {
  return (await getProgramDerivedAddress({programAddress: program, seeds: [utf8("config"), utf8("vox-realize-v1")]}))[0];
}
export async function escrowAddresses(program: Address, commission: Uint8Array, quoteHash: Uint8Array) {
  if (commission.length !== 32 || quoteHash.length !== 32) throw new Error("Seeds must be 32 bytes");
  const config = await configAddress(program);
  const [escrow] = await getProgramDerivedAddress({programAddress: program, seeds: [utf8("escrow"), pk(config), commission]});
  const [quoteUsed] = await getProgramDerivedAddress({programAddress: program, seeds: [utf8("quote"), pk(config), quoteHash]});
  const [vault] = await getProgramDerivedAddress({programAddress: program, seeds: [utf8("vault"), pk(escrow)]});
  return {config, escrow, quoteUsed, vault};
}
export async function usdcAta(recipient: Address, mint: Address) {
  return (await getProgramDerivedAddress({programAddress: ASSOCIATED_TOKEN_PROGRAM, seeds: [pk(recipient), pk(TOKEN_PROGRAM), pk(mint)]}))[0];
}
export interface EscrowPayout {recipient: Address; amount: bigint}
export interface OnchainConfigSnapshot {
  address: Address;
  admin: Address;
  quoteAuthority: Address;
  fulfillmentAuthority: Address;
  mint: Address;
  tokenProgram: Address;
  clusterIdentity: ClusterIdentity;
  protocolVersion: number;
  revision: bigint;
}
export interface EscrowHeader {
  clusterIdentity: ClusterIdentity;
  protocolVersion: number;
  configRevision: bigint;
  program: Address;
  config: Address;
  commission: Uint8Array;
  quoteHash: Uint8Array;
  payer: Address;
  fulfillmentAuthority: Address;
  mint: Address;
  tokenProgram: Address;
  total: bigint;
  recipientCount: number;
  quoteExpiresAt: bigint;
  refundAfter: bigint;
  commitment: Uint8Array;
}
export function settlementQuoteDigest(input: {
  clusterIdentity: ClusterIdentity; protocolVersion: number; program: Address; config: Address;
  configRevision: bigint; mint: Address; tokenProgram: Address; quoteAuthority: Address;
  fulfillmentAuthority: Address; commission: Uint8Array; acceptedQuoteHash: Uint8Array;
  payer: Address; commitment: Uint8Array; total: bigint; recipientCount: number;
  quoteExpiresAt: bigint; refundAfter: bigint;
}): Uint8Array {
  if (input.acceptedQuoteHash.length !== 32 || input.commission.length !== 32 || input.commitment.length !== 32) throw new Error("Invalid quote digest");
  return domainHash("vox.realize.solana.quote-domain.v2", utf8(input.clusterIdentity), pk(input.program), integer(input.protocolVersion,16), pk(input.config), integer(input.configRevision,64), pk(input.mint), pk(input.tokenProgram), pk(input.quoteAuthority), pk(input.fulfillmentAuthority), input.commission, input.acceptedQuoteHash, pk(input.payer), input.commitment, integer(input.total,64), integer(input.recipientCount,8), integer(input.quoteExpiresAt,64,true), integer(input.refundAfter,64,true));
}
export function escrowCommitment(header: EscrowHeader, payouts: readonly EscrowPayout[]): Uint8Array {
  if (header.commission.length !== 32 || header.quoteHash.length !== 32) throw new Error("Invalid digest length");
  if (payouts.length !== header.recipientCount || payouts.length < 1 || payouts.length > 64) throw new Error("Invalid recipient count");
  if (header.total <= 0n || header.total > MAX_U64 || payouts.some(p=>p.amount<=0n || p.amount>MAX_U64) || payouts.reduce((s,p)=>s+p.amount,0n)!==header.total) throw new Error("Payout conservation failed");
  let hash = domainHash("vox.realize.solana.escrow.v3", utf8(header.clusterIdentity), pk(header.program), integer(header.protocolVersion,16), pk(header.config), integer(header.configRevision,64), header.commission, header.quoteHash, pk(header.payer), pk(header.fulfillmentAuthority), pk(header.mint), pk(header.tokenProgram), integer(header.total,64), integer(header.recipientCount,8), integer(header.quoteExpiresAt,64,true), integer(header.refundAfter,64,true));
  payouts.forEach((p,index)=>{hash=domainHash("vox.realize.solana.payout.v3",hash,integer(index,8),pk(p.recipient),integer(p.amount,64));});
  return hash;
}

/** Construct the Ed25519 precompile instruction that must immediately precede create_escrow. */
export function quoteVerificationInstruction(authority: Address, signature: Uint8Array, message: Uint8Array): Instruction {
  if (signature.length !== 64 || message.length !== 32) throw new Error("Quote authority signature must be 64 bytes over a 32-byte domain digest");
  const u16 = (n:number) => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const offsets = [16, 0xffff, 80, 0xffff, 112, 32, 0xffff];
  const header = concatBytes(new Uint8Array([1,0]), ...offsets.map(u16));
  return {programAddress: ED25519_PROGRAM, accounts: [], data: concatBytes(header,signature,pk(authority),message)};
}

/** Compares a fetched, owner/discriminator-validated config with this selected deployment profile. */
export function assertConfigMatchesNetwork(network: SettlementNetworkConfig, config: OnchainConfigSnapshot): void {
  if (!network.active || !network.programId || !network.admin || !network.quoteAuthority || !network.fulfillmentAuthority) throw new Error("Settlement network is not deployed and configured");
  if (network.protocolVersion !== PROTOCOL_VERSION || config.protocolVersion !== network.protocolVersion || config.clusterIdentity !== network.clusterIdentity) throw new Error("Settlement deployment domain mismatch");
  if (config.mint !== network.usdcMint || config.tokenProgram !== network.tokenProgram || config.admin !== network.admin || config.quoteAuthority !== network.quoteAuthority || config.fulfillmentAuthority !== network.fulfillmentAuthority) throw new Error("On-chain settlement configuration does not match this network profile");
}

const CLUSTER_BY_DISCRIMINANT: readonly ClusterIdentity[] = ["solana:localnet","solana:devnet","solana:mainnet-beta"];
export function decodeConfigAccount(program: Address, owner: Address, accountAddress: Address, data: Uint8Array): OnchainConfigSnapshot & {pauseUntil: bigint; bump: number} {
  if (owner !== program) throw new Error("Settlement config account has the wrong program owner");
  const discriminator = sha256(utf8("account:Config")).slice(0,8);
  if (data.length !== 188 || discriminator.some((value,index)=>data[index]!==value)) throw new Error("Invalid settlement config account data");
  const u64=(offset:number)=>new DataView(data.buffer,data.byteOffset+offset,8).getBigUint64(0,true);
  const i64=(offset:number)=>new DataView(data.buffer,data.byteOffset+offset,8).getBigInt64(0,true);
  const pubkey=(offset:number)=>address(getAddressDecoder().decode(data.slice(offset,offset+32)));
  const cluster=CLUSTER_BY_DISCRIMINANT[data[168]!];
  if(!cluster)throw new Error("Unknown settlement cluster identity");
  const snapshot:OnchainConfigSnapshot & {pauseUntil:bigint;bump:number}={
    address:accountAddress,
    admin:pubkey(8),
    quoteAuthority:pubkey(40),
    fulfillmentAuthority:pubkey(72),
    mint:pubkey(104),
    tokenProgram:pubkey(136),
    clusterIdentity:cluster,
    protocolVersion:new DataView(data.buffer,data.byteOffset+169,2).getUint16(0,true),
    revision:u64(171),
    pauseUntil:i64(179),
    bump:data[187]!,
  };
  return snapshot;
}

/** Resolve issuer-bound quote details and create the values signed by the settlement quote authority. */
export async function prepareEscrow(input: {
  quote: unknown; commission: unknown; authorizedIssuerPublicKey: string;
  network: SettlementNetworkConfig; config: OnchainConfigSnapshot; payer: Address;
  nowSeconds: bigint; refundAfter: bigint;
}) {
  const network = input.network;
  if (!network.active || !network.programId) throw new Error("Settlement network has no deployed program ID");
  assertConfigMatchesNetwork(network,input.config);
  const expectedConfig = await configAddress(network.programId);
  if (input.config.address !== expectedConfig) throw new Error("On-chain config PDA does not match the selected program");
  const quote = RealizeQuoteV1Schema.parse(input.quote);
  const commission = CommissionV1Schema.parse(input.commission);
  if (quote.issuer_public_key !== input.authorizedIssuerPublicKey || !verifyRealizeQuoteSignature(quote,base64UrlToBytes(input.authorizedIssuerPublicKey))) throw new Error("Unauthorized or invalid quote signature");
  if (commission.quote_id !== quote.quote_id || commission.accepted_quote_hash !== quote.canonical_quote_hash || commission.creator_id !== quote.creator_id || commission.rights_agreement_reference !== quote.rights_agreement_reference || canonicalize(commission.requested_generation_parameters)!==canonicalize(quote.requested_generation_parameters)) throw new Error("Commission does not accept this quote");
  if (commission.state !== "AWAITING_PAYMENT") throw new Error("Commission must await payment");
  const quoteExpiresAt=unixSeconds(quote.expires_at);
  if(input.nowSeconds<unixSeconds(quote.issued_at)||input.nowSeconds>=quoteExpiresAt||input.refundAfter<quoteExpiresAt||input.refundAfter>input.nowSeconds+30n*86400n)throw new Error("Expired quote or invalid refund deadline");
  const ids=quote.payout_recipients.map(p=>p.payout_id); if(new Set(ids).size!==ids.length)throw new Error("Duplicate payout ID");
  const prefix=clusterForQuote(network.clusterIdentity);
  const payouts:EscrowPayout[]=quote.payout_recipients.map(p=>{
    const match=new RegExp(`^solana:${prefix}:([1-9A-HJ-NP-Za-km-z]+)$`).exec(p.destination??"");
    if(!match)throw new Error(`Quote must commit every Solana ${prefix} wallet destination before acceptance`);
    const recipient=address(match[1]!); if(recipient===SYSTEM_PROGRAM)throw new Error("Invalid beneficiary");
    return {recipient,amount:BigInt(p.amount_usdc_atomic)};
  });
  const commissionBytes=commissionSeed(commission.commission_id);
  const quoteHash=hexToBytes(quote.canonical_quote_hash);
  const header:EscrowHeader={clusterIdentity:network.clusterIdentity,protocolVersion:network.protocolVersion,configRevision:input.config.revision,program:network.programId,config:input.config.address,commission:commissionBytes,quoteHash,payer:input.payer,fulfillmentAuthority:input.config.fulfillmentAuthority,mint:input.config.mint,tokenProgram:input.config.tokenProgram,total:BigInt(quote.total_amount_usdc_atomic),recipientCount:payouts.length,quoteExpiresAt,refundAfter:input.refundAfter,commitment:new Uint8Array(32)};
  const commitment=escrowCommitment(header,payouts);
  header.commitment=commitment;
  const quoteDomainHash=settlementQuoteDigest({...header,quoteAuthority:input.config.quoteAuthority,acceptedQuoteHash:quoteHash});
  const accounts=await escrowAddresses(network.programId,commissionBytes,quoteHash);
  if(payouts.some(p=>p.recipient===accounts.escrow))throw new Error("Escrow cannot be a beneficiary");
  const createArgs={commission:commissionBytes,quote_hash:quoteHash,quote_domain_hash:quoteDomainHash,commitment,total:header.total,recipient_count:payouts.length,quote_expires_at:quoteExpiresAt,refund_after:input.refundAfter};
  return {accounts,header,commitment,commitmentHex:bytesToHex(commitment),quoteDomainHash,createArgs,payouts,quote};
}

// Small IDL-driven Borsh encoder: no legacy web3.js dependency and no transaction submission.
type IdlType = string | {array: [IdlType, number]} | {vec: IdlType} | {defined: {name: string}};
type Field = {name: string; type: IdlType};
type Definition = {name: string; type: {kind: string; fields?: Field[]}};
function fields(fields: readonly Field[], value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected argument object");
  const obj = value as Record<string,unknown>;
  if (Object.keys(obj).length !== fields.length || fields.some(f=>!(f.name in obj))) throw new Error("Unexpected or missing argument");
  return concatBytes(...fields.map(f=>encode(f.type,obj[f.name])));
}
function encode(type: IdlType, value: unknown): Uint8Array {
  if (typeof type === "string") {
    if (type === "pubkey") return pk(address(String(value)));
    if (type === "bool") {if (typeof value !== "boolean") throw new Error("Expected boolean"); return new Uint8Array([value ? 1 : 0]);}
    const m = /^([ui])(8|16|32|64)$/.exec(type);
    if (m) return integer(value,Number(m[2]),m[1] === "i");
    throw new Error(`Unsupported IDL primitive ${type}`);
  }
  if ("array" in type) {
    if (!(Array.isArray(value) || value instanceof Uint8Array) || value.length !== type.array[1]) throw new Error("Invalid fixed array");
    return concatBytes(...Array.from(value as Uint8Array).map(v=>encode(type.array[0],v)));
  }
  if ("vec" in type) {
    if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid vector");
    return concatBytes(integer(value.length,32),...value.map(v=>encode(type.vec,v)));
  }
  const definition = (idl.types as Definition[]).find(t=>t.name === type.defined.name);
  if (!definition || definition.type.kind !== "struct") throw new Error("Unsupported IDL type");
  return fields(definition.type.fields ?? [],value);
}
export function getEscrowInstruction(name: string, accounts: Record<string, Address>, args: Record<string,unknown> = {}, programAddress: Address): Instruction {
  const instruction = idl.instructions.find(i=>i.name===name);
  if (!instruction) throw new Error("Unknown escrow instruction");
  if (Object.keys(accounts).length !== instruction.accounts.length) throw new Error("Unexpected or missing accounts");
  return {programAddress, accounts: instruction.accounts.map(a=> {
    const key = accounts[a.name]; if (!key) throw new Error(`Missing account ${a.name}`);
    if ("address" in a && a.address !== key) throw new Error(`Wrong address for ${a.name}`);
    const writable = "writable" in a && a.writable;
    const signer = "signer" in a && a.signer;
    return {address: key, role: signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : (writable ? AccountRole.WRITABLE : AccountRole.READONLY)};
  }), data: concatBytes(new Uint8Array(instruction.discriminator), fields(instruction.args as Field[],args))};
}
/** Retry only unset bits; group at most eight instructions, then serialize and simulate the actual
 * transaction. Additional signers, ATA creation and compute-budget instructions consume more bytes.
 */
export function unclaimedIndices(recipientCount: number, claimed: bigint): number[] {
  if (!Number.isInteger(recipientCount) || recipientCount < 1 || recipientCount > 64 || claimed < 0n || claimed > MAX_U64) throw new Error("Invalid claim accounting");
  return Array.from({length: recipientCount},(_,i)=>i).filter(i=>(claimed & (1n<<BigInt(i)))===0n);
}

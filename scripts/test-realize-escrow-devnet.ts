import assert from "node:assert/strict";
import {chmodSync,readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {AccountRole,address,type Instruction} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,getAccount,getAssociatedTokenAddress,getMint,getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Connection,Keypair,PublicKey,Transaction,TransactionInstruction,sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM,DEVNET_USDC_MINT,INSTRUCTIONS_SYSVAR,PROTOCOL_VERSION,
  REALIZE_PROGRAM_ID,SETTLEMENT_NETWORKS,SYSTEM_PROGRAM,TOKEN_PROGRAM,
  assertConfigMatchesNetwork,commissionSeed,configAddress,decodeConfigAccount,escrowAddresses,
  escrowCommitment,getEscrowInstruction,quoteVerificationInstruction,settlementQuoteDigest,
  type EscrowHeader,type EscrowPayout,
} from "../packages/realize-solana/src/index.js";

const ROOT=resolve(import.meta.dirname,"..");
const KEY_DIR=resolve(ROOT,".vox-local/realize-devnet");
const RESULT_PATH=resolve(KEY_DIR,"devnet-e2e-manifest.json");
const PROGRAM=REALIZE_PROGRAM_ID;
const STATUS_OFFSET=8+10*32+1+2+7*8+1;
const CLAIMED_OFFSET=8+10*32+1+2+6*8;
const PAID_OFFSET=8+10*32+1+2+5*8;
const STATUS_NAMES=["Draft","Ready","Funded","Fulfilled","Refundable","Settled","Refunded","Canceled","Expired"];

function loadKeypair(name:string):Keypair{
  const secret=JSON.parse(readFileSync(resolve(KEY_DIR,name),"utf8")) as number[];
  assert.equal(secret.length,64,"Expected a Solana keypair JSON file");
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
function toAddress(key:PublicKey){return address(key.toBase58());}
function toPublicKey(key:string){return new PublicKey(key);}
function kitInstruction(instruction:Instruction):TransactionInstruction{
  assert.ok(instruction.accounts,"Generated instruction must include its accounts");
  return new TransactionInstruction({
    programId:toPublicKey(instruction.programAddress),
    keys:instruction.accounts.map(account=>({
      pubkey:toPublicKey(account.address),
      isSigner:account.role===AccountRole.READONLY_SIGNER||account.role===AccountRole.WRITABLE_SIGNER,
      isWritable:account.role===AccountRole.WRITABLE||account.role===AccountRole.WRITABLE_SIGNER,
    })),
    data:Buffer.from(instruction.data??[]),
  });
}
function random32():Uint8Array{return Uint8Array.from(nacl.randomBytes(32));}
function tokenAmount(amount:bigint):string{return (Number(amount)/1_000_000).toFixed(6);}

async function main():Promise<void>{
  const payer=loadKeypair("fee-payer.json");
  const admin=loadKeypair("upgrade-authority.json");
  const quoteAuthority=loadKeypair("quote-authority.json");
  const fulfillmentAuthority=loadKeypair("fulfillment-authority.json");
  const network={...SETTLEMENT_NETWORKS.devnet,active:true};
  const connection=new Connection(network.rpcEndpoint,"confirmed");
  const program=toPublicKey(PROGRAM);
  const mint=toPublicKey(DEVNET_USDC_MINT);
  const config=await configAddress(PROGRAM);
  const configInfo=await connection.getAccountInfo(toPublicKey(config),"confirmed");
  assert.ok(configInfo,"Devnet settlement config is not initialized");
  const configState=decodeConfigAccount(PROGRAM,toAddress(configInfo.owner),config,new Uint8Array(configInfo.data));
  assertConfigMatchesNetwork(network,configState);
  const mintState=await getMint(connection,mint,"confirmed",TOKEN_PROGRAM_ID);
  assert.equal(mintState.decimals,6,"Configured USDC mint must use six decimals");
  assert.equal(mintState.address.toBase58(),DEVNET_USDC_MINT);

  const payerAtaAddress=await getAssociatedTokenAddress(mint,payer.publicKey,false,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);
  const payoutTotal=1_200_000n;
  const refundTotal=250_000n;
  const payerAtaInfo=await connection.getAccountInfo(payerAtaAddress,"confirmed");
  const available=payerAtaInfo?(await getAccount(connection,payerAtaAddress,"confirmed",TOKEN_PROGRAM_ID)).amount:0n;
  assert.ok(available>=payoutTotal+refundTotal,
    `Need at least ${tokenAmount(payoutTotal+refundTotal)} Devnet USDC in ${payerAtaAddress.toBase58()}; found ${tokenAmount(available)}`);
  const payerAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,payer.publicKey,false,"confirmed",undefined,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);
  const adminAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,admin.publicKey,false,"confirmed",undefined,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID);

  const payerAddress=toAddress(payer.publicKey);
  const adminAddress=toAddress(admin.publicKey);
  const quoteAuthorityAddress=toAddress(quoteAuthority.publicKey);
  const fulfillmentAddress=toAddress(fulfillmentAuthority.publicKey);
  const signatures:Record<string,string>={};
  const manifest:Record<string,unknown>={
    status:"in-progress",cluster:network.clusterIdentity,programId:PROGRAM,configPda:config,
    mint:DEVNET_USDC_MINT,tokenProgram:TOKEN_PROGRAM,payer:payerAddress,payerAta:payerAta.address.toBase58(),
    beneficiaries:[{address:payerAddress,ata:payerAta.address.toBase58()},{address:adminAddress,ata:adminAta.address.toBase58()}],
    signatures,
  };
  const save=()=>{writeFileSync(RESULT_PATH,JSON.stringify(manifest,null,2),{mode:0o600});chmodSync(RESULT_PATH,0o600);};
  const send=async(label:string,instructions:TransactionInstruction[],extraSigners:Keypair[]=[]):Promise<string>=>{
    const tx=new Transaction().add(...instructions);
    tx.feePayer=payer.publicKey;
    const signature=await sendAndConfirmTransaction(connection,tx,[payer,...extraSigners],{
      commitment:"confirmed",preflightCommitment:"confirmed",
    });
    signatures[label]=signature;
    save();
    return signature;
  };

  async function prepareEscrow(label:string,total:bigint,payouts:EscrowPayout[]){
    assert.equal(payouts.reduce((sum,p)=>sum+p.amount,0n),total,"Payouts must conserve the exact escrow amount");
    const quoteHash=random32();
    const commission=commissionSeed(`vox-realize-devnet-e2e:${label}:${randomUUID()}`);
    const now=BigInt(Math.floor(Date.now()/1000));
    const quoteExpiresAt=now+3600n;
    const refundAfter=now+7200n;
    const header:EscrowHeader={
      clusterIdentity:network.clusterIdentity,protocolVersion:PROTOCOL_VERSION,configRevision:configState.revision,
      program:PROGRAM,config,commission,quoteHash,payer:payerAddress,fulfillmentAuthority:fulfillmentAddress,
      mint:DEVNET_USDC_MINT,tokenProgram:TOKEN_PROGRAM,total,recipientCount:payouts.length,
      quoteExpiresAt,refundAfter,commitment:new Uint8Array(32),
    };
    const commitment=escrowCommitment(header,payouts);
    header.commitment=commitment;
    const domain=settlementQuoteDigest({...header,quoteAuthority:quoteAuthorityAddress,acceptedQuoteHash:quoteHash});
    const addresses=await escrowAddresses(PROGRAM,commission,quoteHash);
    const entry={commissionId:`devnet-e2e:${label}`,commissionHex:Buffer.from(commission).toString("hex"),
      quoteHashHex:Buffer.from(quoteHash).toString("hex"),commitmentHex:Buffer.from(commitment).toString("hex"),
      quoteDomainHashHex:Buffer.from(domain).toString("hex"),addresses,
      totalAtomic:total.toString(),payouts:payouts.map(p=>({recipient:p.recipient,amountAtomic:p.amount.toString()})),
      quoteExpiresAt:quoteExpiresAt.toString(),refundAfter:refundAfter.toString()};
    manifest[label]=entry;
    save();
    const verify=kitInstruction(quoteVerificationInstruction(quoteAuthorityAddress,nacl.sign.detached(domain,quoteAuthority.secretKey),domain));
    const create=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:payerAddress,config,escrow:addresses.escrow,quote_used:addresses.quoteUsed,mint:DEVNET_USDC_MINT,
      vault:addresses.vault,token_program:TOKEN_PROGRAM,instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:{commission,quote_hash:quoteHash,quote_domain_hash:domain,commitment,total,
      recipient_count:payouts.length,quote_expires_at:quoteExpiresAt,refund_after:refundAfter}},PROGRAM));
    await send(`${label}.create`,[verify,create]);
    await send(`${label}.append`,[kitInstruction(getEscrowInstruction("append_payouts",{
      payer:payerAddress,escrow:addresses.escrow,
    },{payouts},PROGRAM))]);
    await send(`${label}.seal`,[kitInstruction(getEscrowInstruction("seal",{
      payer:payerAddress,escrow:addresses.escrow,
    },{},PROGRAM))]);
    await send(`${label}.fund`,[kitInstruction(getEscrowInstruction("fund",{
      payer:payerAddress,config,escrow:addresses.escrow,mint:DEVNET_USDC_MINT,
      source:toAddress(payerAta.address),vault:addresses.vault,token_program:TOKEN_PROGRAM,
    },{},PROGRAM))]);
    return {addresses,quoteHash,total};
  }

  async function readEscrow(addressValue:string){
    const info=await connection.getAccountInfo(toPublicKey(addressValue),"confirmed");
    assert.ok(info,"Expected escrow PDA to exist");
    const data=Buffer.from(info.data);
    assert.ok(data.length>STATUS_OFFSET,"Escrow account has an unexpected data layout");
    const statusIndex=data[STATUS_OFFSET];
    return {status:STATUS_NAMES[statusIndex]??`unknown:${statusIndex}`,
      paid:data.readBigUInt64LE(PAID_OFFSET),claimed:data.readBigUInt64LE(CLAIMED_OFFSET)};
  }

  const payerBefore= (await getAccount(connection,payerAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  const adminBefore= (await getAccount(connection,adminAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  const payoutList:EscrowPayout[]=[
    {recipient:payerAddress,amount:900_000n},
    {recipient:adminAddress,amount:300_000n},
  ];
  const distribution=await prepareEscrow("nway-distribution",payoutTotal,payoutList);
  await send("nway-distribution.attest-success",[kitInstruction(getEscrowInstruction("attest",{
    fulfillment_authority:fulfillmentAddress,config,escrow:distribution.addresses.escrow,
  },{quote_hash:distribution.quoteHash,fulfillment_hash:random32(),success:true},PROGRAM))],[fulfillmentAuthority]);
  const claim=(addresses:typeof distribution.addresses,recipient:PublicKey,destination:PublicKey,index:number)=>kitInstruction(
    getEscrowInstruction("claim",{escrow:addresses.escrow,mint:DEVNET_USDC_MINT,vault:addresses.vault,
      recipient:toAddress(recipient),destination:toAddress(destination),token_program:TOKEN_PROGRAM,
      associated_token_program:ASSOCIATED_TOKEN_PROGRAM}, {index}, PROGRAM));
  await send("nway-distribution.claim-0",[claim(distribution.addresses,payer.publicKey,payerAta.address,0)]);
  await send("nway-distribution.claim-1",[claim(distribution.addresses,admin.publicKey,adminAta.address,1)]);
  const payerAfter=(await getAccount(connection,payerAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  const adminAfter=(await getAccount(connection,adminAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  assert.equal(payerAfter-payerBefore,-300_000n,"Payer net balance must reflect its 1.2-USDC deposit and 0.9-USDC claim");
  assert.equal(adminAfter-adminBefore,300_000n,"Second beneficiary must receive exactly 0.3 USDC");
  const settled=await readEscrow(distribution.addresses.escrow);
  assert.deepEqual(settled,{status:"Settled",paid:payoutTotal,claimed:3n},"Every committed entitlement must settle exactly once");
  const distributedVault=await getAccount(connection,toPublicKey(distribution.addresses.vault),"confirmed",TOKEN_PROGRAM_ID);
  assert.equal(distributedVault.amount,0n,"All distributed USDC must leave the escrow vault");

  // Deliberately simulate a failed fulfillment to verify the payer's refund path.
  // This synthetic test commission is not a real video-generation job.
  const refundPayouts:EscrowPayout[]=[{recipient:adminAddress,amount:refundTotal}];
  const refund=await prepareEscrow("synthetic-refund-path",refundTotal,refundPayouts);
  await send("synthetic-refund-path.attest-failure",[kitInstruction(getEscrowInstruction("attest",{
    fulfillment_authority:fulfillmentAddress,config,escrow:refund.addresses.escrow,
  },{quote_hash:refund.quoteHash,fulfillment_hash:random32(),success:false},PROGRAM))],[fulfillmentAuthority]);
  const payerBeforeRefund=(await getAccount(connection,payerAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  await send("synthetic-refund-path.refund",[kitInstruction(getEscrowInstruction("refund",{
    payer:payerAddress,escrow:refund.addresses.escrow,mint:DEVNET_USDC_MINT,vault:refund.addresses.vault,
    destination:toAddress(payerAta.address),token_program:TOKEN_PROGRAM,associated_token_program:ASSOCIATED_TOKEN_PROGRAM,
  },{},PROGRAM))]);
  const payerAfterRefund=(await getAccount(connection,payerAta.address,"confirmed",TOKEN_PROGRAM_ID)).amount;
  assert.equal(payerAfterRefund-payerBeforeRefund,refundTotal,"Refund must return the exact funded integer amount");
  const refunded=await readEscrow(refund.addresses.escrow);
  assert.equal(refunded.status,"Refunded");
  const refundVault=await getAccount(connection,toPublicKey(refund.addresses.vault),"confirmed",TOKEN_PROGRAM_ID);
  assert.equal(refundVault.amount,0n,"Refunded USDC must leave the escrow vault");

  manifest.status="passed";
  manifest.results={
    nway:{recipientCount:2,totalAtomic:payoutTotal.toString(),claimedBits:settled.claimed.toString(),
      vaultRemainingAtomic:distributedVault.amount.toString(),netPayerAtomic:(payerAfter-payerBefore).toString(),
      adminPayoutAtomic:(adminAfter-adminBefore).toString(),status:settled.status},
    refund:{totalAtomic:refundTotal.toString(),returnedAtomic:(payerAfterRefund-payerBeforeRefund).toString(),
      vaultRemainingAtomic:refundVault.amount.toString(),status:refunded.status},
  };
  save();
  console.log(JSON.stringify({status:"passed",manifest:RESULT_PATH,programId:PROGRAM,configPda:config,
    mint:DEVNET_USDC_MINT,distributionEscrow:distribution.addresses.escrow,refundEscrow:refund.addresses.escrow,
    results:manifest.results,signatures},null,2));
}

main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});

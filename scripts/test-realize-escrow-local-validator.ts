import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {existsSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {
  AccountRole,address,type Instruction,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM,ED25519_PROGRAM,INSTRUCTIONS_SYSVAR,LOCALNET_PROGRAM,PROTOCOL_VERSION,
  SYSTEM_PROGRAM,TOKEN_PROGRAM,assertConfigMatchesNetwork,commissionSeed,configAddress,
  decodeConfigAccount,escrowAddresses,escrowCommitment,getEscrowInstruction,
  quoteVerificationInstruction,settlementQuoteDigest,type EscrowHeader,type SettlementNetworkConfig,
} from "../packages/realize-solana/src/index.js";
import {
  createMint,getOrCreateAssociatedTokenAccount,mintTo,
} from "@solana/spl-token";
import {
  Connection,Keypair,LAMPORTS_PER_SOL,PublicKey,
  Transaction,TransactionInstruction,sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

const PROGRAM=LOCALNET_PROGRAM;
const PROGRAM_SO=resolve("target/deploy/realize_escrow.so");
const toAddress=(key:PublicKey)=>address(key.toBase58());
const toPublicKey=(key:string)=>new PublicKey(key);
const kitInstruction=(instruction:Instruction)=>new TransactionInstruction({
  programId:toPublicKey(instruction.programAddress),
  keys:instruction.accounts.map(account=>({
    pubkey:toPublicKey(account.address),
    isSigner:account.role===AccountRole.READONLY_SIGNER||account.role===AccountRole.WRITABLE_SIGNER,
    isWritable:account.role===AccountRole.WRITABLE||account.role===AccountRole.WRITABLE_SIGNER,
  })),
  data:Buffer.from(instruction.data??[]),
});
const random32=()=>Uint8Array.from(nacl.randomBytes(32));
async function availablePort():Promise<number>{
  const server=createServer();
  await new Promise<void>(resolveListen=>server.listen(0,"127.0.0.1",resolveListen));
  const port=(server.address() as {port:number}).port;
  await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));
  return port;
}
async function waitForValidator(child:ReturnType<typeof spawn>,connection:Connection):Promise<void>{
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`Local validator exited before RPC became ready (${child.exitCode})`);
    try{await connection.getSlot("confirmed");return;}catch{await new Promise(resolveWait=>setTimeout(resolveWait,250));}
  }
  throw new Error("Local validator did not become ready in 60 seconds");
}
async function expectFailure(label:string,operation:()=>Promise<unknown>):Promise<void>{
  let failed=false;
  try{await operation();}catch{failed=true;}
  assert.equal(failed,true,`${label} should fail`);
}
async function fundLocalAccount(connection:Connection,key:PublicKey):Promise<void>{
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([
      connection.requestAirdrop(key,5*LAMPORTS_PER_SOL),
      new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Local faucet request timed out")),10_000);}),
    ]);
  }finally{if(timeout)clearTimeout(timeout);}
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    if(await connection.getBalance(key,"confirmed")>=5*LAMPORTS_PER_SOL)return;
    await new Promise(resolveWait=>setTimeout(resolveWait,200));
  }
  throw new Error(`Local faucet did not fund ${key.toBase58()}`);
}
async function send(connection:Connection,payer:Keypair,instructions:TransactionInstruction[],signers:Keypair[]=[payer]):Promise<string>{
  const transaction=new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection,transaction,signers,{commitment:"confirmed",preflightCommitment:"confirmed"});
}
async function main(){
  assert.ok(existsSync(PROGRAM_SO),"SBF build must run before local-validator tests");
  const authority=Keypair.generate();
  const rogue=Keypair.generate();
  const payer=Keypair.generate();
  const quoteAuthority=Keypair.generate();
  const fulfillmentAuthority=Keypair.generate();
  const beneficiary=Keypair.generate();
  const beneficiaryTwo=Keypair.generate();
  const ledger=mkdtempSync(join(tmpdir(),"vox-realize-localnet-"));
  const port=await availablePort();
  let faucetPort=await availablePort();
  while(faucetPort===port||faucetPort===port+1)faucetPort=await availablePort();
  let gossipPort=await availablePort();
  while([port,port+1,faucetPort].includes(gossipPort))gossipPort=await availablePort();
  const rpcUrl=`http://127.0.0.1:${port}`;
  const validator=spawn("solana-test-validator",[
    "--reset","--quiet","--ledger",ledger,"--rpc-port",String(port),"--faucet-port",String(faucetPort),
    "--gossip-port",String(gossipPort),"--dynamic-port-range","20000-20100","--bind-address","127.0.0.1",
    "--upgradeable-program",PROGRAM,PROGRAM_SO,authority.publicKey.toBase58(),
  ],{stdio:"inherit"});
  const connection=new Connection(rpcUrl,"confirmed");
  try{
    await waitForValidator(validator,connection);
    for(const key of [authority,rogue,payer,quoteAuthority,fulfillmentAuthority,beneficiary])await fundLocalAccount(connection,key.publicKey);
    const mint=await createMint(connection,authority,authority.publicKey,null,6);
    const config=await configAddress(PROGRAM);
    const programData=PublicKey.findProgramAddressSync(
      [new PublicKey(PROGRAM).toBuffer()],new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0];
    const initialize=(admin:Keypair)=>kitInstruction(getEscrowInstruction("initialize_config",{
      admin:toAddress(admin.publicKey),config,mint:toAddress(mint),token_program:TOKEN_PROGRAM,
      program:PROGRAM,program_data:toAddress(programData),system_program:SYSTEM_PROGRAM,
    },{quote_authority:toAddress(quoteAuthority.publicKey),fulfillment_authority:toAddress(fulfillmentAuthority.publicKey)},PROGRAM));
    await expectFailure("non-upgrade-authority config initialization",()=>send(connection,rogue,[initialize(rogue)]));
    await send(connection,authority,[initialize(authority)]);

    const fetchedConfig=await connection.getAccountInfo(new PublicKey(config),"confirmed");
    assert.ok(fetchedConfig);
    const configState=decodeConfigAccount(PROGRAM,toAddress(fetchedConfig.owner),config,new Uint8Array(fetchedConfig.data));
    const network:SettlementNetworkConfig={
      clusterIdentity:"solana:localnet",rpcEndpoint:rpcUrl,programId:PROGRAM,usdcMint:toAddress(mint),
      tokenProgram:TOKEN_PROGRAM,admin:toAddress(authority.publicKey),quoteAuthority:toAddress(quoteAuthority.publicKey),
      fulfillmentAuthority:toAddress(fulfillmentAuthority.publicKey),protocolVersion:PROTOCOL_VERSION,active:true,
    };
    assertConfigMatchesNetwork(network,configState);

    const acceptedQuoteHash=random32();
    const commission=commissionSeed("commission:local-validator");
    const now=BigInt(Math.floor(Date.now()/1000));
    const quoteExpiresAt=now+3600n;
    const refundAfter=now+7200n;
    const payouts=[{recipient:toAddress(beneficiary.publicKey),amount:80n},
      {recipient:toAddress(beneficiaryTwo.publicKey),amount:43n}];
    const header:EscrowHeader={clusterIdentity:network.clusterIdentity,protocolVersion:PROTOCOL_VERSION,
      configRevision:configState.revision,program:PROGRAM,config,commission,quoteHash:acceptedQuoteHash,
      payer:toAddress(payer.publicKey),
      fulfillmentAuthority:network.fulfillmentAuthority!,mint:network.usdcMint,tokenProgram:TOKEN_PROGRAM,
      total:123n,recipientCount:2,quoteExpiresAt,refundAfter,commitment:new Uint8Array(32)};
    const commitment=escrowCommitment(header,payouts);
    header.commitment=commitment;
    const domainHash=settlementQuoteDigest({...header,quoteAuthority:network.quoteAuthority!,acceptedQuoteHash});
    const addresses=await escrowAddresses(PROGRAM,commission,acceptedQuoteHash);
    const signature=nacl.sign.detached(domainHash,quoteAuthority.secretKey);
    const verify=kitInstruction(quoteVerificationInstruction(network.quoteAuthority!,signature,domainHash));
    const createAccounts=addresses;
    const validCreate=await createInstructionWithAddresses({payer,config,commission,quoteHash:acceptedQuoteHash,
      domainHash,commitment,mint:network.usdcMint,quoteExpiresAt,refundAfter,total:123n,recipientCount:2,
      program:PROGRAM});

    const wrongMint=await createInstructionWithAddresses({payer,config,commission,quoteHash:acceptedQuoteHash,domainHash,
      commitment,mint:toAddress(Keypair.generate().publicKey),quoteExpiresAt,refundAfter,total:123n,recipientCount:2,
      program:PROGRAM});
    await expectFailure("wrong mint in create_escrow",()=>send(connection,payer,[verify,wrongMint]));

    const changedCommitment=commitment.slice();changedCommitment[0]^=1;
    const substitutedQuoteAllocation=await createInstructionWithAddresses({payer,config,commission,quoteHash:acceptedQuoteHash,
      domainHash,commitment:changedCommitment,mint:network.usdcMint,quoteExpiresAt,refundAfter,total:123n,
      recipientCount:2,program:PROGRAM});
    await expectFailure("payout commitment substitution",()=>send(connection,payer,[verify,substitutedQuoteAllocation]));

    const invalidSeeds=await escrowAddresses(PROGRAM,commissionSeed("commission:wrong-pda"),acceptedQuoteHash);
    const invalidPdaIx=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config,escrow:invalidSeeds.escrow,quote_used:createAccounts.quoteUsed,
      mint:network.usdcMint,vault:invalidSeeds.vault,token_program:TOKEN_PROGRAM,
      instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:{commission,quote_hash:acceptedQuoteHash,quote_domain_hash:domainHash,commitment,total:123n,
      recipient_count:2,quote_expires_at:quoteExpiresAt,refund_after:refundAfter}},PROGRAM));
    await expectFailure("invalid escrow PDA seeds",()=>send(connection,payer,[verify,invalidPdaIx]));

    const substituted=getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config:SYSTEM_PROGRAM,escrow:createAccounts.escrow,
      quote_used:createAccounts.quoteUsed,mint:network.usdcMint,vault:createAccounts.vault,
      token_program:TOKEN_PROGRAM,instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:{commission,quote_hash:acceptedQuoteHash,quote_domain_hash:domainHash,commitment,total:123n,
      recipient_count:1,quote_expires_at:quoteExpiresAt,refund_after:refundAfter}},PROGRAM);
    await expectFailure("config account substitution",()=>send(connection,payer,[verify,kitInstruction(substituted)]));

    const wrongProgram=address(Keypair.generate().publicKey.toBase58());
    const wrongProgramDomain=settlementQuoteDigest({clusterIdentity:network.clusterIdentity,protocolVersion:PROTOCOL_VERSION,
      program:wrongProgram,config,configRevision:configState.revision,mint:network.usdcMint,tokenProgram:TOKEN_PROGRAM,
      quoteAuthority:network.quoteAuthority!,fulfillmentAuthority:network.fulfillmentAuthority!,commission,
      acceptedQuoteHash,payer:toAddress(payer.publicKey),commitment,total:123n,recipientCount:2,quoteExpiresAt,refundAfter});
    const wrongDomainArgs={commission,quote_hash:acceptedQuoteHash,quote_domain_hash:wrongProgramDomain,
      commitment,total:123n,recipient_count:1,quote_expires_at:quoteExpiresAt,refund_after:refundAfter};
    const wrongDomainAccounts=await escrowAddresses(PROGRAM,commission,acceptedQuoteHash);
    const wrongDomainIx=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config,escrow:wrongDomainAccounts.escrow,quote_used:wrongDomainAccounts.quoteUsed,
      mint:network.usdcMint,vault:wrongDomainAccounts.vault,token_program:TOKEN_PROGRAM,
      instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:wrongDomainArgs},PROGRAM));
    const wrongDomainSignature=nacl.sign.detached(wrongProgramDomain,quoteAuthority.secretKey);
    const wrongDomainVerify=kitInstruction(quoteVerificationInstruction(network.quoteAuthority!,wrongDomainSignature,wrongProgramDomain));
    await expectFailure("quote signed for a different program ID",()=>send(connection,payer,[wrongDomainVerify,wrongDomainIx]));
    const wrongProgramInstruction=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config,escrow:createAccounts.escrow,quote_used:createAccounts.quoteUsed,
      mint:network.usdcMint,vault:createAccounts.vault,token_program:TOKEN_PROGRAM,
      instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:{commission,quote_hash:acceptedQuoteHash,quote_domain_hash:domainHash,commitment,total:123n,
      recipient_count:1,quote_expires_at:quoteExpiresAt,refund_after:refundAfter}},wrongProgram));
    await expectFailure("program account substitution",()=>send(connection,payer,[verify,wrongProgramInstruction]));

    const devnetDomain=settlementQuoteDigest({clusterIdentity:"solana:devnet",protocolVersion:PROTOCOL_VERSION,
      program:PROGRAM,config,configRevision:configState.revision,mint:network.usdcMint,tokenProgram:TOKEN_PROGRAM,
      quoteAuthority:network.quoteAuthority!,fulfillmentAuthority:network.fulfillmentAuthority!,commission,
      acceptedQuoteHash,payer:toAddress(payer.publicKey),commitment,total:123n,recipientCount:2,quoteExpiresAt,refundAfter});
    const devnetArgs={commission,quote_hash:acceptedQuoteHash,
      quote_domain_hash:devnetDomain,commitment,total:123n,recipient_count:1,quote_expires_at:quoteExpiresAt,refund_after:refundAfter};
    const devnetAddresses=await escrowAddresses(PROGRAM,commission,acceptedQuoteHash);
    const devnetReplayIx=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config,escrow:devnetAddresses.escrow,quote_used:devnetAddresses.quoteUsed,
      mint:network.usdcMint,vault:devnetAddresses.vault,token_program:TOKEN_PROGRAM,
      instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:devnetArgs},PROGRAM));
    const devnetSignature=nacl.sign.detached(devnetDomain,quoteAuthority.secretKey);
    const devnetVerify=kitInstruction(quoteVerificationInstruction(network.quoteAuthority!,devnetSignature,devnetDomain));
    await expectFailure("devnet quote replay on localnet",()=>send(connection,payer,[devnetVerify,devnetReplayIx]));

    await send(connection,payer,[verify,validCreate]);
    const duplicateCommission=commissionSeed("commission:duplicate-commission");
    const duplicateHeader={...header,commission:duplicateCommission,commitment:new Uint8Array(32)};
    const duplicateCommitment=escrowCommitment(duplicateHeader,payouts);
    duplicateHeader.commitment=duplicateCommitment;
    const duplicateDomain=settlementQuoteDigest({...duplicateHeader,quoteAuthority:network.quoteAuthority!,acceptedQuoteHash});
    const duplicateAddresses=await escrowAddresses(PROGRAM,duplicateCommission,acceptedQuoteHash);
    const duplicateArgs={commission:duplicateCommission,quote_hash:acceptedQuoteHash,quote_domain_hash:duplicateDomain,
      commitment:duplicateCommitment,total:123n,recipient_count:2,quote_expires_at:quoteExpiresAt,refund_after:refundAfter};
    const duplicateSignature=nacl.sign.detached(duplicateDomain,quoteAuthority.secretKey);
    const duplicateVerify=kitInstruction(quoteVerificationInstruction(network.quoteAuthority!,duplicateSignature,duplicateDomain));
    const duplicateIx=kitInstruction(getEscrowInstruction("create_escrow",{
      payer:toAddress(payer.publicKey),config,escrow:duplicateAddresses.escrow,quote_used:duplicateAddresses.quoteUsed,
      mint:network.usdcMint,vault:duplicateAddresses.vault,token_program:TOKEN_PROGRAM,
      instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
    },{args:duplicateArgs},PROGRAM));
    await expectFailure("quote replay for a second commission",()=>send(connection,payer,[duplicateVerify,duplicateIx]));

    const beneficiaryAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,beneficiary.publicKey);
    const beneficiaryTwoAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,beneficiaryTwo.publicKey);
    const append=kitInstruction(getEscrowInstruction("append_payouts",{
      payer:toAddress(payer.publicKey),escrow:addresses.escrow,
    },{payouts},PROGRAM));
    const seal=kitInstruction(getEscrowInstruction("seal",{
      payer:toAddress(payer.publicKey),escrow:addresses.escrow,
    },{},PROGRAM));
    await send(connection,payer,[append]);
    await send(connection,payer,[seal]);
    const payerAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,payer.publicKey);
    await mintTo(connection,authority,mint,payerAta.address,authority,1000n);
    const wrongSource=await getOrCreateAssociatedTokenAccount(connection,payer,mint,beneficiary.publicKey);
    const fund=(source:PublicKey,vault=addresses.vault,mintAddress=mint,tokenProgramAddress=TOKEN_PROGRAM)=>kitInstruction(getEscrowInstruction("fund",{
      payer:toAddress(payer.publicKey),config,escrow:addresses.escrow,mint:toAddress(mintAddress),source:toAddress(source),
      vault,token_program:tokenProgramAddress,
    },{},PROGRAM));
    await expectFailure("source token account substitution",()=>send(connection,payer,[fund(wrongSource.address)]));
    const fakeMint=await createMint(connection,authority,authority.publicKey,null,6);
    const fakeAta=await getOrCreateAssociatedTokenAccount(connection,payer,fakeMint,payer.publicKey);
    await expectFailure("wrong mint during fund",()=>send(connection,payer,[fund(fakeAta.address,addresses.vault,fakeMint)]));
    await expectFailure("wrong token program during fund",()=>send(connection,payer,[fund(payerAta.address,addresses.vault,mint,toAddress(Keypair.generate().publicKey))]));
    await send(connection,payer,[fund(payerAta.address)]);
    await expectFailure("duplicate funding",()=>send(connection,payer,[fund(payerAta.address)]));
    const refund=(refundSigner:Keypair,destination:PublicKey)=>kitInstruction(getEscrowInstruction("refund",{
      payer:toAddress(refundSigner.publicKey),escrow:addresses.escrow,mint:toAddress(mint),vault:addresses.vault,
      destination:toAddress(destination),token_program:TOKEN_PROGRAM,associated_token_program:ASSOCIATED_TOKEN_PROGRAM,
    },{},PROGRAM));
    const rogueAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,rogue.publicKey);
    await expectFailure("unauthorized refund",()=>send(connection,rogue,[refund(rogue,rogueAta.address)],[rogue]));
    await expectFailure("premature timeout refund",()=>send(connection,payer,[refund(payer,payerAta.address)]));
    await expectFailure("unauthorized fulfillment attestation",()=>send(connection,rogue,[kitInstruction(getEscrowInstruction("attest",{
      fulfillment_authority:toAddress(rogue.publicKey),config,escrow:addresses.escrow,
    },{quote_hash:acceptedQuoteHash,fulfillment_hash:random32(),success:true},PROGRAM))],[rogue]));
    const attest=kitInstruction(getEscrowInstruction("attest",{
      fulfillment_authority:toAddress(fulfillmentAuthority.publicKey),config,escrow:addresses.escrow,
    },{quote_hash:acceptedQuoteHash,fulfillment_hash:random32(),success:true},PROGRAM));
    await send(connection,fulfillmentAuthority,[attest],[fulfillmentAuthority]);
    await expectFailure("duplicate settlement attestation",()=>send(connection,fulfillmentAuthority,[attest],[fulfillmentAuthority]));

    const wrongRecipient=Keypair.generate().publicKey;
    const claim=(recipient:PublicKey,destination:PublicKey,index:number)=>kitInstruction(getEscrowInstruction("claim",{
      escrow:addresses.escrow,mint:toAddress(mint),vault:addresses.vault,recipient:toAddress(recipient),
      destination:toAddress(destination),token_program:TOKEN_PROGRAM,associated_token_program:ASSOCIATED_TOKEN_PROGRAM,
    },{index},PROGRAM));
    const wrongAta=await getOrCreateAssociatedTokenAccount(connection,payer,mint,wrongRecipient);
    await expectFailure("recipient/account substitution",()=>send(connection,payer,[claim(wrongRecipient,wrongAta.address,0)]));
    await send(connection,payer,[claim(beneficiary.publicKey,beneficiaryAta.address,0)]);
    await expectFailure("double withdrawal",()=>send(connection,payer,[claim(beneficiary.publicKey,beneficiaryAta.address,0)]));
    await expectFailure("invalid claim index",()=>send(connection,payer,[claim(beneficiaryTwo.publicKey,beneficiaryTwoAta.address,2)]));
    await send(connection,payer,[claim(beneficiaryTwo.publicKey,beneficiaryTwoAta.address,1)]);
    const settled=await connection.getTokenAccountBalance(beneficiaryAta.address);
    const settledTwo=await connection.getTokenAccountBalance(beneficiaryTwoAta.address);
    assert.equal(settled.value.amount,"80");
    assert.equal(settledTwo.value.amount,"43");

    const refundQuoteHash=random32();
    const refundCommission=commissionSeed("commission:failure-refund");
    const refundPayouts=[{recipient:toAddress(beneficiary.publicKey),amount:12n}];
    const refundHeader:EscrowHeader={clusterIdentity:network.clusterIdentity,protocolVersion:PROTOCOL_VERSION,
      configRevision:configState.revision,program:PROGRAM,config,commission:refundCommission,quoteHash:refundQuoteHash,
      payer:toAddress(payer.publicKey),fulfillmentAuthority:network.fulfillmentAuthority!,mint:network.usdcMint,
      tokenProgram:TOKEN_PROGRAM,total:12n,recipientCount:1,quoteExpiresAt:quoteExpiresAt,refundAfter,commitment:new Uint8Array(32)};
    const refundCommitment=escrowCommitment(refundHeader,refundPayouts);
    refundHeader.commitment=refundCommitment;
    const refundDomain=settlementQuoteDigest({...refundHeader,quoteAuthority:network.quoteAuthority!,acceptedQuoteHash:refundQuoteHash});
    const refundAddresses=await escrowAddresses(PROGRAM,refundCommission,refundQuoteHash);
    const refundCreate=await createInstructionWithAddresses({payer,config,commission:refundCommission,quoteHash:refundQuoteHash,
      domainHash:refundDomain,commitment:refundCommitment,mint:network.usdcMint,quoteExpiresAt,refundAfter,total:12n,
      recipientCount:1,program:PROGRAM});
    const refundSignature=nacl.sign.detached(refundDomain,quoteAuthority.secretKey);
    await send(connection,payer,[kitInstruction(quoteVerificationInstruction(network.quoteAuthority!,refundSignature,refundDomain)),refundCreate]);
    await send(connection,payer,[kitInstruction(getEscrowInstruction("append_payouts",{
      payer:toAddress(payer.publicKey),escrow:refundAddresses.escrow,
    },{payouts:refundPayouts},PROGRAM))]);
    await send(connection,payer,[kitInstruction(getEscrowInstruction("seal",{
      payer:toAddress(payer.publicKey),escrow:refundAddresses.escrow,
    },{},PROGRAM))]);
    await send(connection,payer,[kitInstruction(getEscrowInstruction("fund",{
      payer:toAddress(payer.publicKey),config,escrow:refundAddresses.escrow,mint:network.usdcMint,
      source:toAddress(payerAta.address),vault:refundAddresses.vault,token_program:TOKEN_PROGRAM,
    },{},PROGRAM))]);
    await send(connection,fulfillmentAuthority,[kitInstruction(getEscrowInstruction("attest",{
      fulfillment_authority:toAddress(fulfillmentAuthority.publicKey),config,escrow:refundAddresses.escrow,
    },{quote_hash:refundQuoteHash,fulfillment_hash:random32(),success:false},PROGRAM))],[fulfillmentAuthority]);
    const payerBeforeRefund=BigInt((await connection.getTokenAccountBalance(payerAta.address)).value.amount);
    await send(connection,payer,[kitInstruction(getEscrowInstruction("refund",{
      payer:toAddress(payer.publicKey),escrow:refundAddresses.escrow,mint:network.usdcMint,
      vault:refundAddresses.vault,destination:toAddress(payerAta.address),token_program:TOKEN_PROGRAM,
      associated_token_program:ASSOCIATED_TOKEN_PROGRAM,
    },{},PROGRAM))]);
    const payerAfterRefund=BigInt((await connection.getTokenAccountBalance(payerAta.address)).value.amount);
    assert.equal(payerAfterRefund-payerBeforeRefund,12n);
    await expectFailure("duplicate refund",()=>send(connection,payer,[kitInstruction(getEscrowInstruction("refund",{
      payer:toAddress(payer.publicKey),escrow:refundAddresses.escrow,mint:network.usdcMint,
      vault:refundAddresses.vault,destination:toAddress(payerAta.address),token_program:TOKEN_PROGRAM,
      associated_token_program:ASSOCIATED_TOKEN_PROGRAM,
    },{},PROGRAM))]));
    console.log("Local validator adversarial checks passed: config authority, wrong mint/program, account and PDA substitution, quote-domain/payout replay, timeout/refund authorization, N-way claims, and duplicate settlement/withdrawal.");
  }finally{
    (connection as unknown as {_rpcWebSocket:{close:()=>void}})._rpcWebSocket.close();
    validator.kill("SIGINT");
    await new Promise<void>(resolveExit=>{
      if(validator.exitCode!==null)return resolveExit();
      const timer=setTimeout(resolveExit,3000);
      validator.once("exit",()=>{clearTimeout(timer);resolveExit();});
    });
    rmSync(ledger,{recursive:true,force:true});
  }
}

async function createInstructionWithAddresses(input:{
  payer:Keypair;config:string;commission:Uint8Array;quoteHash:Uint8Array;domainHash:Uint8Array;
  commitment:Uint8Array;mint:string;quoteExpiresAt:bigint;refundAfter:bigint;total:bigint;
  recipientCount:number;program:string;
}){
  const addresses=await escrowAddresses(address(input.program),input.commission,input.quoteHash);
  return kitInstruction(getEscrowInstruction("create_escrow",{
    payer:toAddress(input.payer.publicKey),config:address(input.config),escrow:addresses.escrow,quote_used:addresses.quoteUsed,
    mint:address(input.mint),vault:addresses.vault,token_program:TOKEN_PROGRAM,
    instructions:INSTRUCTIONS_SYSVAR,system_program:SYSTEM_PROGRAM,
  },{args:{commission:input.commission,quote_hash:input.quoteHash,quote_domain_hash:input.domainHash,
    commitment:input.commitment,total:input.total,recipient_count:input.recipientCount,
    quote_expires_at:input.quoteExpiresAt,refund_after:input.refundAfter}},address(input.program)));
}

void main().catch(error=>{console.error(error);process.exitCode=1;});

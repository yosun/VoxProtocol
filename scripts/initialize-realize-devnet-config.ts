import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {AccountRole,address,type Instruction} from "@solana/kit";
import {
  TOKEN_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";
import {
  Connection,Keypair,PublicKey,Transaction,TransactionInstruction,sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  DEVNET_USDC_MINT,REALIZE_PROGRAM_ID,SETTLEMENT_NETWORKS,SYSTEM_PROGRAM,TOKEN_PROGRAM,
  assertConfigMatchesNetwork,configAddress,decodeConfigAccount,getEscrowInstruction,
} from "../packages/realize-solana/src/index.js";

const ROOT=resolve(import.meta.dirname,"..");
const KEY_DIR=resolve(ROOT,".vox-local/realize-devnet");
const RPC="https://api.devnet.solana.com";
const LOADER=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function loadKeypair(path:string):Keypair{
  const data=JSON.parse(readFileSync(path,"utf8")) as number[];
  assert.equal(data.length,64,"Expected a Solana keypair JSON file");
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function asTransactionInstruction(instruction:Instruction):TransactionInstruction{
  assert.ok(instruction.accounts,"Generated instruction must include its accounts");
  return new TransactionInstruction({
    programId:new PublicKey(instruction.programAddress),
    keys:instruction.accounts.map(account=>({
      pubkey:new PublicKey(account.address),
      isSigner:account.role===AccountRole.READONLY_SIGNER||account.role===AccountRole.WRITABLE_SIGNER,
      isWritable:account.role===AccountRole.WRITABLE||account.role===AccountRole.WRITABLE_SIGNER,
    })),
    data:Buffer.from(instruction.data??[]),
  });
}

async function main():Promise<void>{
  const admin=loadKeypair(resolve(KEY_DIR,"upgrade-authority.json"));
  const feePayer=loadKeypair(resolve(KEY_DIR,"fee-payer.json"));
  const program=address(REALIZE_PROGRAM_ID);
  const config=await configAddress(program);
  const configKey=new PublicKey(config);
  const connection=new Connection(RPC,"confirmed");

  assert.equal(admin.publicKey.toBase58(),"4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL");
  assert.equal(feePayer.publicKey.toBase58(),"45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr");
  assert.equal(DEVNET_USDC_MINT,"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

  const [programInfo,mintInfo,adminBalance,existingConfig]=await Promise.all([
    connection.getAccountInfo(new PublicKey(program),"confirmed"),
    getMint(connection,new PublicKey(DEVNET_USDC_MINT),"confirmed",TOKEN_PROGRAM_ID),
    connection.getBalance(admin.publicKey,"confirmed"),
    connection.getAccountInfo(configKey,"confirmed"),
  ]);
  assert.ok(programInfo?.executable,"Expected the escrow program to be deployed on Devnet");
  assert.equal(programInfo.owner.toBase58(),LOADER.toBase58(),"Unexpected program loader");
  assert.equal(mintInfo.decimals,6,"Devnet USDC must have six decimals");
  assert.ok(adminBalance>0,"The config admin must hold Devnet SOL for rent and fees");

  const network={...SETTLEMENT_NETWORKS.devnet,active:true};
  if(existingConfig){
    const state=decodeConfigAccount(program,address(existingConfig.owner.toBase58()),config,new Uint8Array(existingConfig.data));
    assertConfigMatchesNetwork(network,state);
    console.log(JSON.stringify({status:"already-initialized-and-verified",programId:program,configPda:config,
      mint:DEVNET_USDC_MINT,admin:admin.publicKey.toBase58(),quoteAuthority:network.quoteAuthority,
      fulfillmentAuthority:network.fulfillmentAuthority},null,2));
    return;
  }

  const programData=PublicKey.findProgramAddressSync([new PublicKey(program).toBuffer()],LOADER)[0];
  const instruction=getEscrowInstruction("initialize_config",{
    admin:address(admin.publicKey.toBase58()),
    config,
    mint:DEVNET_USDC_MINT,
    token_program:TOKEN_PROGRAM,
    program,
    program_data:address(programData.toBase58()),
    system_program:SYSTEM_PROGRAM,
  },{
    quote_authority:network.quoteAuthority,
    fulfillment_authority:network.fulfillmentAuthority,
  },program);
  const signature=await sendAndConfirmTransaction(connection,new Transaction().add(asTransactionInstruction(instruction)),[admin],{
    commitment:"confirmed",preflightCommitment:"confirmed",
  });

  const initialized=await connection.getAccountInfo(configKey,"confirmed");
  assert.ok(initialized,"Config initialization transaction did not create the config PDA");
  const state=decodeConfigAccount(program,address(initialized.owner.toBase58()),config,new Uint8Array(initialized.data));
  assertConfigMatchesNetwork(network,state);
  console.log(JSON.stringify({status:"initialized-and-verified",signature,programId:program,configPda:config,
    clusterIdentity:network.clusterIdentity,protocolVersion:network.protocolVersion,mint:DEVNET_USDC_MINT,
    tokenProgram:TOKEN_PROGRAM,admin:admin.publicKey.toBase58(),quoteAuthority:network.quoteAuthority,
    fulfillmentAuthority:network.fulfillmentAuthority},null,2));
}

main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});

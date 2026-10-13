// Public test data only. Run after deliberately changing the deployment program ID.
import {writeFileSync} from "node:fs";
import {getAddressDecoder} from "@solana/kit";
import {escrowAddresses, escrowCommitment, REALIZE_PROGRAM_ID, PROTOCOL_VERSION, DEVNET_USDC_MINT, TOKEN_PROGRAM} from "../packages/realize-solana/dist/index.js";
import {bytesToHex} from "@vox/protocol";
const wallet = byte => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const commission = new Uint8Array(32).fill(7), quoteHash = new Uint8Array(32).fill(8);
const {config, escrow} = await escrowAddresses(REALIZE_PROGRAM_ID, commission, quoteHash);
const header = {clusterIdentity: "solana:devnet", protocolVersion: PROTOCOL_VERSION, configRevision: 2n,
  program: REALIZE_PROGRAM_ID, config, commission, quoteHash, payer: wallet(5), fulfillmentAuthority: wallet(6),
  mint: DEVNET_USDC_MINT, tokenProgram: TOKEN_PROGRAM, total: 1000000n, recipientCount: 3,
  quoteExpiresAt: 1100n, refundAfter: 1200n, commitment: new Uint8Array(32)};
const payouts = [{recipient: wallet(1), amount: 750000n}, {recipient: wallet(2), amount: 200000n}, {recipient: wallet(3), amount: 50000n}];
const data = {header: {...header, commission: bytesToHex(commission), quoteHash: bytesToHex(quoteHash),
  commitment: bytesToHex(escrowCommitment(header,payouts)), escrow}, payouts,
  commitment: bytesToHex(escrowCommitment(header, payouts))};
writeFileSync(new URL("../tests/fixtures/realize-escrow-commitment.json", import.meta.url), JSON.stringify(data, (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");

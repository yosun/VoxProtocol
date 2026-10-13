import {Firestore} from "@google-cloud/firestore";
import {RealizeSettlementProcessor, createSettlementApp} from "./engine.js";
import {FirestoreSettlementLedger} from "./ledger.js";
import {configuredSettlementChain} from "./solana-chain.js";

const token = process.env.VOX_REALIZE_SETTLEMENT_TOKEN;
if (!token) throw new Error("VOX_REALIZE_SETTLEMENT_TOKEN is required");
const maximum = process.env.VOX_REALIZE_MAINNET_MAX_PAYMENT_USDC_ATOMIC ?? "10000000000";
if (!/^[1-9][0-9]{0,10}$/.test(maximum) || BigInt(maximum) > 10_000_000_000n) throw new Error("Mainnet Realize maximum payment must be a positive USDC amount no greater than 10000 USDC");
const firestore = new Firestore({
  ...(process.env.GOOGLE_CLOUD_PROJECT ? {projectId: process.env.GOOGLE_CLOUD_PROJECT} : {}),
  ...(process.env.VOX_FIRESTORE_DATABASE ? {databaseId: process.env.VOX_FIRESTORE_DATABASE} : {})
});
const processor = new RealizeSettlementProcessor(
  new FirestoreSettlementLedger(firestore),
  configuredSettlementChain(),
  BigInt(maximum)
);
const app = createSettlementApp({token, processor});
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
await app.listen({port, host: "0.0.0.0"});
app.log.info({port}, "VOX Realize settlement service ready");

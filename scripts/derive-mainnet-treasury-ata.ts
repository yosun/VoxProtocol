import {resolveMainnetTreasuryUsdcAta} from "../apps/api/src/realize-mainnet-ata.js";

const [owner, mint, configured, ...extra] = process.argv.slice(2);
if (!owner || !mint || extra.length > 0) throw new Error("usage: derive-mainnet-treasury-ata.ts <treasury-owner> <mainnet-usdc-mint> [configured-account]");
process.stdout.write(`${resolveMainnetTreasuryUsdcAta(owner, mint, configured)}\n`);

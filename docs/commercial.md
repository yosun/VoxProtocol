# Sponsorship and Realize extension boundary

The core publisher works without sponsorship or media generation. A commercial implementation must keep these balances separate:

- general sponsorship receipts;
- subscriber-owned video credits;
- credits explicitly granted to the character for autonomous spending;
- funds reserved for one commission.

A durable payment record now carries a unique receipt/reference, purpose, payer, beneficiary (when known), USDC asset/network, amount, source post or quote, reservation/capture/refund state, and finalized Solana transaction evidence. The record shape also reserves typed fields for future revenue allocations, commissions, sponsorships, and ownership terms. These fields are not settlement instructions. The separate, explicitly configured NFT path creates one independent chain entitlement for completed paid media, without changing payment, escrow, or revenue-sharing behavior.

A direct merchant transfer is not escrow. One transaction must never reconcile to multiple jobs; retries are idempotent.

The repository exposes `MediaProvider` (`quote`, `requestGeneration`, `status`) and `MockMediaProvider`. The mock returns deterministic hashes and an `example.invalid` URL and is visibly labeled as mock by the frontend. Populi.cam can implement the same interface without exposing its rendering internals. Recurring payments and trust-minimized escrow are intentionally separate follow-up systems.

## Solana USDC checkout

The Realize checkout uses a backend-issued, signed quote and the active rights agreement before it accepts payment. It supports Solana Wallet Standard wallets, including Phantom, Solflare, and Backpack. The browser builds only the exact USDC transfer returned by the authenticated quote-acceptance endpoint; it does not construct recipient payouts from client data. The wallet's response is treated as a submitted signature, while VOX independently verifies the finalized transfer before recording payment. The checkout then follows generation, settlement, artifact delivery, and signed public provenance. Commissioners stay anonymous in public provenance by default, and attribution requires explicit opt-in.

Enable it locally only with approved public configuration values:

```bash
VOX_PAYMENT_MODE=direct
VOX_SOLANA_CLUSTER=devnet
VOX_USDC_MINT=<devnet-usdc-mint>
VOX_MERCHANT_USDC_TOKEN_ACCOUNT=<merchant-usdc-token-account>
SOLANA_RPC_URL=https://api.devnet.solana.com
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com
```

The merchant token account and mint are public addresses, not credentials; do not put wallet secret keys in `.env`, source, or deployment files. `VOX_PAYMENT_MODE=mock` remains the safe default. The Playwright suite (`npm run test:e2e`) mocks VOX settlement and Solana RPC and does not submit funds. Real program settlement requires Agent 4's devnet program address, matching IDL/version, devnet USDC mint, and backend settlement configuration. Those deployment details are not present in this checkout. Do not enable live direct payment until the deployment, fulfillment provider, refund policy, and accounting process have been configured. Mainnet payment remains opt-in and disabled by default.

# Realize character accounts

`GET /v1/internal/realize/creators/{creatorId}/account` returns the character's Realize owner-allocation ledger. It requires `x-vox-internal-token` because the response contains private wallet and payment references.

The account is keyed by character, network, and USDC mint. It reports available USDC held for the character in VOX's configured Mainnet treasury, owner allocations still in a funded commission's generation or settlement path, owner allocations confirmed paid to external destinations, finalized owner payouts with an unknown destination, and refunded owner allocations. Amounts are integer USDC atomic units. Different networks and mints are never combined. Unknown-destination payouts stay out of available and paid balances and put the commission in manual review.

Each transaction is bound to its commission, accepted quote hash, payment intent, settlement ID, and quote-pinned owner payout rows. It records customer funding and settlement transaction signatures, plus the refund ID, status, and signature when present. The settlement service returns the exact payout IDs finalized in each settlement response, so partial settlement credits only owner payouts it confirms; a positive settled amount without payout IDs is rejected from the ledger projection.

The account is provisioned when a character's Realize payout policy is onboarded. The Firestore account summary and its per-commission transaction projection are written in the same transaction as each commission update. Existing commissions are backfilled the first time an account is read. Repeated updates replace the commission's deterministic ledger projection and apply only the balance delta, preventing duplicate credits during retries.

An allocation held at the configured treasury owner is shown as an available platform liability for the character. This is an internal accounting claim; it is not a separately owned token account or proof that treasury assets are segregated. The endpoint compares its balance summary with its transaction rows but does not query the on-chain treasury balance. Treasury reconciliation remains an operational step.

This view covers Realize character-owner allocations and their related payment, settlement, and refund evidence. It does not turn the separate contractual rights ledger into a payment ledger, and it does not record unrelated NFT or wallet transactions as character income.

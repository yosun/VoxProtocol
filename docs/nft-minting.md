# VOX NFT minting

VOX creates one durable NFT entitlement per canonical media output and configured chain. The initial EVM set includes Base, Monad, Arbitrum, Ethereum L1, HyperEVM, and Robinhood Chain; Solana uses the standard Token Metadata program. The media record is created only after a captured payment and verified completed media result; it contains the source post reference, generation request summary/hash, output URI/hash/type, provenance reference, and immutable metadata hash. Every chain record points at the same `vox:media:<sha256>` ID.

## Runtime behavior

- `apps/api/src/nft.ts` contains the chain adapters and the idempotent processor.
- `vox_nft_media` stores the canonical media record; `vox_nft_mints` stores one independently retriable record per chain.
- The existing `vox-realize-reconcile` Cloud Run job processes NFT records through `/v1/internal/realize/reconcile`; no new service is required.
- A walletless chain is stored as `claimable`, not failed. A later signed claim at `POST /v1/nft/mints/:mintId/claim` binds the wallet and queues that chain only.
- A signed transaction is persisted before broadcast. A missing/expired transaction result enters `manual_review` rather than automatically creating a duplicate NFT.
- Temporarily disabling an adapter preserves signed/submitted transaction state. Older retry records that still contain transaction evidence must recheck that same transaction; only a newly observed, confirmed execution failure permits replacement. A record bound to the preceding collection enters manual review after a collection change, with its signed bytes and transaction identity retained.
- Mainnet adapter construction fails closed unless `VOX_NFT_MAINNET_ENABLED=true`, `VOX_CONFIRM_NFT_MAINNET=1`, and `VOX_DEPLOYMENT_ENV=production` are all present. The deployment script additionally requires the owner-approved RPC, contract, and dedicated Secret Manager signer entries.
- Mainnet entitlements also require a persisted completed or settled Realize commission, explicit publication consent, verified Mainnet USDC funding bound to its accepted quote and payment intent, and the exact verified artifact and provenance. The deterministic media/output/chain identity permits one entitlement per output per chain. Legacy generation produces synthetic media and is restricted to testnet entitlements, including when testnet and Mainnet adapters are configured together.
- The processor rechecks these bindings before preparing, submitting, or reconciling Mainnet transactions. Ineligible older or bypass-created entitlements enter `manual_review` without calling a chain adapter; any existing signature and signed bytes are retained for investigation.

Public surfaces are `GET /v1/nft/media/:mediaId`, `GET /v1/nft/metadata/:mediaId`, and `/media/:mediaId`. Metadata uses the media page as `external_url` and uses the provider output as `image` or `animation_url` through the canonical metadata record. The public page displays each configured chain state and explorer link.

## Testnet validation

The validator is intentionally opt-in because it signs and submits testnet gas transactions:

```sh
VOX_NFT_VALIDATE_TESTNETS=1 \
VOX_NFT_ENABLED=true \
VOX_NFT_CHAINS=solana:devnet,base:sepolia,monad:testnet \
VOX_DEPLOYMENT_ENV=staging \
VOX_NFT_TEST_OWNER_SOLANA=<testnet-solana-wallet> \
VOX_NFT_TEST_OWNER_BASE=<testnet-base-wallet> \
VOX_NFT_TEST_OWNER_MONAD=<testnet-monad-wallet> \
npm run validate:nft-testnets
```

The command also needs the three testnet RPC URLs, deployed `VoxMediaNFT` contract addresses for Base Sepolia and Monad Testnet, their configured chain IDs, and dedicated signer key files supplied through gitignored local paths or Secret Manager mounts. It refuses Mainnet settings. The Solidity source is `contracts/VoxMediaNFT.sol`; deploy one instance per EVM testnet with the signer as minter, then record the addresses in environment variables. Solana uses the standard Token Metadata program and does not require a VOX program deployment.

## Mainnet preparation boundary

`infrastructure/gcp/nft-mainnet.example.env` is a disabled template. Before enabling it, an operator must:

1. Deploy and independently verify one `VoxMediaNFT` contract on Base Mainnet, Monad Mainnet, Arbitrum One, Ethereum L1, HyperEVM, and Robinhood Chain, with a dedicated minter key and owner-controlled admin key.
2. Verify the Solana NFT fee-payer/mint-authority key, RPC genesis, SOL reserve, and metadata URI reachability.
3. Put each signer in its own Secret Manager secret with only the API runtime identity granted access. Never reuse the Realize treasury, settlement, anchor, or VOX instance key.
4. Run the three testnet validations and retain transaction IDs plus metadata/media hash checks.
5. Set `VOX_NFT_ENABLED=true`, `VOX_NFT_MAINNET_ENABLED=true`, and `VOX_CONFIRM_NFT_MAINNET=1` only after explicit approval to spend real funds, then deploy with `DEPLOYMENT_ENV=production` and the repository `.kiro/gcp-project.json` target.

The application does not deploy contracts or submit Mainnet transactions as part of a normal build or test run.

## ERC-721 receiver verification

Both safe-transfer overloads use a typed `onERC721Received` call so standard
ABI-encoded `bytes4` responses are accepted. Wrong selectors, reverting receivers,
malformed responses, and contracts without the callback revert the entire
transfer, including ownership, balance, and approval changes.

Run the contract regression suite locally with Solc 0.8.33 installed:

```sh
forge test --root . --contracts contracts \
  --match-path contracts/test/VoxMediaNFT.t.sol \
  --use 0.8.33 --evm-version cancun \
  --out .vox-local/forge-out --cache-path .vox-local/forge-cache --offline -vv
```

The suite executes entirely inside Forge's local EVM. The collection is
non-upgradeable: this source repair does not change any already deployed
collection. Applying it on a live network requires checking the deployed bytecode
and separately planning a new deployment or migration. The regression suite
performs neither operation; use the explicit migration workflow below.

## Completed Realize outputs on Monad

The Realize checkout presents each completed output separately. Choose **Mint on
Monad**, connect an EVM wallet, and sign the entitlement-specific claim. The
customer signature binds the receiving address; VOX's dedicated minter pays gas
and submits the ERC-721 transaction. This flow does not mint ordinary posts or
start another generation.

The claim starts processing immediately. Signed bytes are stored before
broadcast; processor instances share a per-chain Firestore lease so they do not
prepare competing transactions with the same pending nonce. Repeated claims
preserve submitted, finalized, and manual-review records and cannot change the
receiving wallet. Lost responses recover from the existing record.

`POST /v1/nft/mints/:mintId/sync` accepts an empty JSON object and the same signed
human request headers as the claim endpoint. Only the entitlement's owner may
refresh processing. The checkout keeps refreshing after the commission settles,
while the five-minute background reconciler remains a fallback. Mutable status
responses use `Cache-Control: no-store`; canonical metadata remains immutable.
An EVM mint is finalized only after the configured confirmation count, a mint
Transfer to the bound address, and an on-chain token URI matching VOX metadata.
The result displays the token number, transaction, NFT explorer link, and VOX
media page.

Run `npx tsx scripts/test-nft-local.ts` after `npm run build:packages` to rehearse
the browser → wallet proof → API → deployed ERC-721 → confirmed owner/metadata →
page reload path. It requires Foundry (`forge`, `anvil`) and Playwright Chromium.
It uses a disposable localhost chain with chain ID 10143, synthetic completed
media, and test-only keys. It does not contact Monad Mainnet, pay a provider, or
verify the production payment/generation/settlement path.

A production release and an authorized mint of an existing completed output to
a customer-controlled Monad wallet are still needed for live Mainnet evidence.

## Plan a corrected Monad collection

The receiver fix requires a new collection. The existing collection remains at
`0x87ef9e71625878a0babeee7864fa7d96ed4e3571` on Monad Mainnet (chain ID 143).
Both its owner and minter must remain
`0xafac2571572aa858da801b5c8ed38009c555a4c6`. Existing tokens cannot acquire the
corrected runtime through an application release. A replacement collection starts
its own token numbering; it does not move, burn, remint, or rewrite historical
NFTs.

[The deployment tool](../scripts/deploy-nft-contract.ts) now has three explicit
modes. It accepts no private key, keystore, or Secret Manager value. The old
stdin-key/immediate-broadcast interface is removed. A normal build, release, or
`plan` invocation cannot submit a transaction.

Prepare a plan from a clean contract/manifest checkout with Foundry and Solc
0.8.33 already installed. Set the fee and reserve variables to explicit native
wei limits for review (1 MON = 10^18 wei); the historical USD spending cap in
[the deployment inventory](../deployments/nft-mainnet.json) is not authorization
for this deployment.

```sh
npx tsx scripts/deploy-nft-contract.ts plan \
  --rpc https://rpc.monad.xyz \
  --plan .vox-local/monad-receiver-fix-plan.json \
  --max-gas 3000000 \
  --max-fee-per-gas-wei "$REVIEWED_MAX_FEE_PER_GAS_WEI" \
  --max-priority-fee-per-gas-wei "$REVIEWED_PRIORITY_FEE_WEI" \
  --max-total-fee-wei "$REVIEWED_MAX_TOTAL_FEE_WEI" \
  --minimum-remaining-balance-wei "$REVIEWED_REMAINING_BALANCE_WEI" \
  --confirmations 12 --lifetime-seconds 900
```

Planning rebuilds in a fresh temporary directory with the pinned compiler and
Cancun target, binds the artifact to the actual contract source, and records
source/creation/runtime/metadata hashes, the source commit, and the production
manifest hash. Public RPC reads pin the genesis, finalized observation block,
existing runtime and authorities, next token ID, deployer balance, and pending
nonce. A pending minter transaction or occupied predicted CREATE address stops
planning. The 10% gas buffer must fit inside the gas cap; the full gas-limit ×
maximum-fee charge must fit the explicit total cap and leave the reserve.

Show the resulting plan and its SHA-256 to the owner before any signing or
submission. Review chain 143, the preserved deployer/owner/minter, zero native
value, predicted new collection, constructor/source hashes, nonce, maximum native
fee, and expiry. This authorization covers a new contract transaction only;
normal application deployment authorization does not cover it. The tool does
not convert MON to USD or infer a fresh approval from old inventory metadata.

After that exact transaction is authorized, use the owner's existing external
wallet/custody signing process to sign the plan's type-2 transaction **without
broadcasting**, and export only the public raw signed transaction into a local
file. Do not export a private key. Keep a single operator for the minter nonce;
normal sponsored minting can invalidate the plan, and the tool never changes its
nonce or fee automatically.

```sh
npx tsx scripts/deploy-nft-contract.ts apply \
  --rpc https://rpc.monad.xyz \
  --plan .vox-local/monad-receiver-fix-plan.json \
  --approve-plan-sha256 "$APPROVED_PLAN_SHA256" \
  --signed-transaction .vox-local/monad-receiver-fix-signed.hex \
  --journal .vox-local/monad-receiver-fix-submission.json

npx tsx scripts/deploy-nft-contract.ts verify \
  --rpc https://rpc.monad.xyz \
  --plan .vox-local/monad-receiver-fix-plan.json \
  --journal .vox-local/monad-receiver-fix-submission.json
```

`apply` recovers the signer and rejects every change to the reviewed unsigned
transaction. It repeats network, code, authority, nonce, expiry, fee, estimate,
occupancy, balance, and reserve checks. The exact signed public bytes and their
locally calculated hash are durably written to a new submission journal before
broadcast; an existing different journal is never overwritten. Keep the plan,
raw bytes, journal, and the clean source/manifest checkout used to create them
together; later configuration changes must not replace that verification snapshot. A lost response is an uncertain submission:
run `verify` against the existing hash. Reapplying the same approved plan can
only resend the same signed bytes, and refuses to send after expiry or nonce
change. Never delete evidence and create another deployment to resolve an
uncertain receipt.

`verify` is read-only and remains available after plan expiry. It checks the
mined transaction against every planned field, a successful receipt at the
predicted address, canonical block hash, gas/fee limits, and the exact rebuilt
runtime plus preserved owner/minter at deployment and finalized state. Success
requires at least 12 blocks of depth under the RPC's `finalized` head and a
stable receipt recheck. Missing receipts or insufficient depth report `pending`
and exit 2. Unsupported historical/finalized reads, reorgs, mismatched runtime,
failed execution, or changed authorities fail closed. The finality requirement
uses Monad's [documented block commitments](https://docs.monad.xyz/monad-arch/consensus/block-states).

Repeat read-only verification through an independently selected trusted RPC
before cutover. A finalized deployment is evidence for a **separate reviewed
configuration PR**;
it does not switch production. Preserve the old collection and all signed,
submitted, finalized, and manual-review mint records. Do not reassign or erase
old transactions, token IDs, owners, or token URIs. Reconciliation must retain
old-contract evidence for investigation; queued work can use a replacement only
under reviewed runtime rules. The production deployment script currently
preserves its existing contract configuration, so a cutover must explicitly
include the verified new address and its bounded configuration mechanism in the
protected production workflow. Do not run a local Cloud Run update to substitute
for that review/release. Validate new sponsored minting and receiver transfers
only under their own concrete transaction authorization.

Run the planning/signature/finality guard suite without network access:

```sh
npx vitest run tests/nft-contract-migration.test.ts tests/nft-migration-journal.test.ts
```

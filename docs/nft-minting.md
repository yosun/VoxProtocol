# VOX NFT minting

VOX creates one durable NFT entitlement per canonical media output and configured chain. The initial EVM set includes Base, Monad, Arbitrum, Ethereum L1, HyperEVM, and Robinhood Chain; Solana uses the standard Token Metadata program. The media record is created only after a captured payment and verified completed media result; it contains the source post reference, generation request summary/hash, output URI/hash/type, provenance reference, and immutable metadata hash. Every chain record points at the same `vox:media:<sha256>` ID.

## Runtime behavior

- `apps/api/src/nft.ts` contains the chain adapters and the idempotent processor.
- `vox_nft_media` stores the canonical media record; `vox_nft_mints` stores one independently retriable record per chain.
- The existing `vox-realize-reconcile` Cloud Run job processes NFT records through `/v1/internal/realize/reconcile`; no new service is required.
- A walletless chain is stored as `claimable`, not failed. A later signed claim at `POST /v1/nft/mints/:mintId/claim` binds the wallet and queues that chain only.
- A signed transaction is persisted before broadcast. A missing/expired transaction result enters `manual_review` rather than automatically creating a duplicate NFT.
- Mainnet adapter construction fails closed unless `VOX_NFT_MAINNET_ENABLED=true`, `VOX_CONFIRM_NFT_MAINNET=1`, and `VOX_DEPLOYMENT_ENV=production` are all present. The deployment script additionally requires the owner-approved RPC, contract, and dedicated Secret Manager signer entries.

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

# Realize escrow Devnet deployment and operations

This is the public operational record for the disposable Devnet deployment. It contains public keys and deployment metadata only. The keypair JSON files stay local and must never be copied into this document, source control, issue trackers, or chat.

## Local Devnet keypairs

The keypairs are stored under `.vox-local/realize-devnet/` at the repository root. This is a host-local path and must remain outside version control. The directory has owner-only access (`0700`); each keypair file has owner read/write access (`0600`). `.vox-local/` is covered by the repository `.gitignore`.

| File | Public address | Purpose |
| --- | --- | --- |
| `fee-payer.json` | `45rmLepEcjBBNZLKnFgxVg2zyzyj1YWbC63yBRMeH9gr` | Devnet SOL airdrops, deployment fees, and test transaction fees |
| `program.json` | `GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb` | Program address signer for the initial deployment; retain to reproduce the program address |
| `upgrade-authority.json` | `4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL` | Upgrade authority and initial settlement config admin |
| `quote-authority.json` | `6yj1txeBEHJX5RULpRHExRCXe4x2p8ZeWYgc5y353im4` | Signs Devnet-only test quote commitments |
| `fulfillment-authority.json` | `8RiNuRwnJydiZq9tuAVBZWKw77UA7qovNMySJQS3AcE9` | Signs the one-time Devnet fulfillment test attestations |

The Solana CLI profile at `~/.config/solana/cli/config.yml` is set to `https://api.devnet.solana.com` and uses the local `fee-payer.json`. Its wallet address should be the fee payer above. The installed tools are Solana CLI 4.3.0, Anchor CLI 1.2.1, Rust 1.99.0, and `devnet-pow` 0.1.4. Use explicit Devnet URLs for deployment and test commands. Do not reuse these keys on mainnet. No mainnet production keypair is stored here.

Back up `program.json` and `upgrade-authority.json` in an encrypted, access-controlled location if this Devnet deployment must remain upgradeable or be reproduced after this machine is lost. The fee payer and test authorities can be replaced by a controlled authority rotation or a new test deployment. These are disposable development identities and must never receive real assets.

## Deployment and initialized configuration

Status: deployed and configured on Devnet; live test-USDC settlement and refund checks passed. The owner supplied 5 Devnet SOL to the disposable fee payer through the public Solana faucet and requested 20 test USDC from Circle's Devnet faucet. The first upload attempt hit HTTP 429; its temporary buffer was closed and its rent returned. A retry completed using the saved program buffer signer. The deployment locks `1.87507372 SOL` as program rent. The latest fee-payer balance after deployment, config initialization, ATA creation, and live tests was `3.0716176 SOL`; the fee payer's test-USDC balance is `19.7 USDC`.

The generated program address below is the **deployed Devnet program ID**. Confirmed deployment facts are recorded here and in `deployments/realize-settlement.json`:

- Deployed program ID: `GHLw1HY5BMXRUNzxeMVsv5r7usjQKWJA9SGVMGzNi3tb`
- Cluster: Devnet (`https://api.devnet.solana.com`)
- Official Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (classic SPL Token, six decimals)
- Token program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
- Protocol and integration version: `2` / `0.2.0`
- Config admin / upgrade authority: `4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL`
- Quote authority: `6yj1txeBEHJX5RULpRHExRCXe4x2p8ZeWYgc5y353im4`
- Fulfillment authority: `8RiNuRwnJydiZq9tuAVBZWKw77UA7qovNMySJQS3AcE9`
- Initialized config PDA: `DZdQE4QRJSq1yusCtV8X4Jt3AXE97YLpqQVkp1magdfm`
- Deployment transaction: `5VtTSUWsJRSdRtRUuEbej38TPFfUEwBktgkAMC1ypqF5z7PjLpRKLfF1MJ7X2iBJLG8d4YpKyrqoqRJxNEKPCB3L`
- Config initialization transaction: `4CagubfmSsqi7RBZAnNB8po1WNnKM5hSpeEJb1ZbASXQQcc6uaRjDDwoa1D9ne292tKzuS9SqdLV6LVNR6XGuHyF`
- ProgramData: `BJW9Ht5U5LCC7UC2Gvm5AjCFAU7VL3Wgf4HSgCei6JAz`, upgrade authority `4MSTtPJKELknreL2uaPJd9xpCZetypfoEjoMLY17btbL`, deployment slot `510068832`
- Failed upload buffer: `TYfcab84AW23RVQXe4ookU4W9XGpdJjC2MA7i5fsePP` (closed; rent returned)
- Devnet `.so`: `target/realize-devnet/realize_escrow.so`, 368,936 bytes, SHA-256 `55c0141bbf8c30ae3a10db7197abe07d13641d2ef9a65932c468aacea0bad67e`
- Inactive mainnet `.so`: `target/realize-mainnet/realize_escrow.so`, 368,936 bytes, SHA-256 `61f41996ea372e0eb82cfdc52d538863f17038d377c0efa06134cd117cd4e124`
- IDL SHA-256: `39c8992069bfeff7a35630195b53f0c287f5a1db25e080feaacf26c9137f4d24` (Anchor CLI 1.2.1 output matches the checked-in IDL)
- Circle faucet transfer: `20 USDC`, confirmed as `3Wq8S8bukGF8EpremUtbPboYf6pUX9aQMUrUogk9ipAmhsC3pAb5uAdRnoXrE7pKcRQ8wRHTSX3uiquTe7YjUG8U`
- Current fee-payer balance: `3.0716176 SOL`; current fee-payer token balance: `19.7 USDC`
- Live test manifest: `.vox-local/realize-devnet/devnet-e2e-manifest.json` (full test transaction signatures; ignored by Git)
- IDL: [`idl/realize_escrow.json`](../idl/realize_escrow.json); integration package: [`@vox/realize-solana` 0.2.0](../packages/realize-solana/README.md)

The mint was verified on Devnet: its account owner is the classic SPL Token program above and its decimals are `6`. The live escrow test created and funded a 1.2 USDC commission with two committed recipients, attested fulfillment, and claimed exactly 0.9 and 0.3 USDC. Both claim bits were set and the vault was empty. The separate 0.25 USDC refund case deliberately sent a test-only `success=false` fulfillment attestation to exercise the refund path; no video job was run or failed. The payer received exactly 0.25 USDC back and that vault was empty. All transaction signatures are in `.vox-local/realize-devnet/devnet-e2e-manifest.json`. These were synthetic Devnet test quotes and commissions.

## VOX.gold checkout integration

The API remains disabled unless `VOX_REALIZE_DEVNET_ENABLED=true`. Set the quote-authority, fulfillment-authority, and fee-payer environment variables to the protected local signer-file paths; never put key bytes in environment variables or browser builds. The API fetches the config PDA and verifies its owner, mint, token program, admin, protocol, and authorities before accepting a quote. The web build separately requires `VITE_REALIZE_DEVNET_ENABLED=true` to offer the Devnet wallet flow.

Quote acceptance pins the payer wallet and stores the server-generated escrow authorization privately with the commission. The commissioner wallet creates and funds the escrow from the accepted signed quote. VOX verifies finalized on-chain escrow state before generation starts. After fulfillment, the API submits the configured attestation and relays permissionless claim instructions to each quote-committed recipient ATA; it reports settlement only after the escrow confirms all amounts were claimed. Failed generation follows the on-chain refund path, and the payer signs the final refund transaction. Public provenance contains neither the payer wallet nor billing details; public credit remains opt-in.

For a controlled redeployment of the same Devnet artifact, use this explicitly Devnet-only command. Use the saved local buffer signer so the CLI does not emit a recovery phrase for an ephemeral signer:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
NO_DNA=1 solana program deploy target/realize-devnet/realize_escrow.so \
  --url devnet \
  --buffer .vox-local/realize-devnet/program-buffer.json \
  --keypair .vox-local/realize-devnet/fee-payer.json \
  --fee-payer .vox-local/realize-devnet/fee-payer.json \
  --program-id .vox-local/realize-devnet/program.json \
  --upgrade-authority .vox-local/realize-devnet/upgrade-authority.json \
  --output json
```

This deploy command does not initialize the settlement config. Config initialization was a separate transaction using the upgrade authority and verified mint. The deployment registry records confirmed program, config, and test facts. Runtime consumers still require the explicit `VOX_REALIZE_DEVNET_ENABLED=true` setting and must fetch and validate the config account before accepting an escrow.

PDA seeds (using the deployed program ID):

- Config: `[b"config", b"vox-realize-v1"]`
- Escrow: `[b"escrow", config_pubkey, commission_digest_32]`
- Quote replay guard: `[b"quote", config_pubkey, accepted_quote_hash_32]`
- Vault: `[b"vault", escrow_pubkey]`
- Recipient USDC account: associated-token PDA for `[recipient, classic_token_program, configured_usdc_mint]`

Use the helpers exported by `@vox/realize-solana` for PDA derivation. Claim settlement is bounded to 64 beneficiaries; payout records are appended in groups of at most eight and beneficiaries claim only to their exact associated token accounts. These PDA addresses were derived from and verified against the deployed program ID.

## Security and operational boundaries

The deployment is for Devnet testing only and is not audited. The upgrade authority can replace the program code and is also the config admin at initialization. The admin can rotate quote and fulfillment authorities, transfer admin with both parties signing, and pause new activity for at most one hour per pause. The admin has no withdrawal or payout-redirection instruction. The quote authority can authorize a new committed recipient list; the fulfillment authority can attest success or failure once for a funded escrow but cannot alter an already committed list. Timeout refunds become eligible at the escrow's stored `refund_after` timestamp.

Mainnet stays inactive. Its official mint is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; its program ID and all production authorities remain unset until a separate production deployment is explicitly approved and performed. Never use this Devnet program or its keys for real USDC.

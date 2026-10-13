# Guided Solana anchor setup

The repository includes a guided installer for the existing Cloud Run anchor worker:

```bash
npm run anchor:setup
```

It uses the verified target in `.kiro/gcp-project.json`, reuses `infrastructure/gcp/deploy.sh`, and never writes the private key to the repository or passes it as a command-line argument.

## Safest path: Devnet staging

Use a separately verified staging GCP project. The production target is intentionally rejected for the default Devnet path.

```bash
npm run anchor:setup -- \
  --config /secure/path/vox-staging-project.json \
  --mode devnet \
  --deploy
```

The installer will:

1. Read and display the project, region, API service, anchor service, RPC, and manifest bucket.
2. Check `gcloud` access and the existing `vox-instance-secret` and `vox-internal-token` secrets.
3. Create `vox-anchor-secret` if it does not have an enabled version.
4. Generate a dedicated Solana keypair in memory, or accept an existing Solana CLI keypair using `--keypair PATH`.
5. Stream the 64-byte Ed25519 secret directly into Secret Manager without printing it.
6. Print only the public wallet address, which must be funded with Devnet SOL.
7. Deploy the worker with `VOX_ANCHOR_MODE=devnet` and the Devnet RPC.
8. Print the exact Bob publish and proof commands for the smoke test.

The installer does not publish a post automatically.

## Production mainnet path

Mainnet requires an explicit confirmation and should only be run after approving the wallet custody, SOL balance, RPC provider, daily transaction budget, and deployment target:

```bash
npm run anchor:setup -- \
  --mode mainnet \
  --deploy \
  --confirm-mainnet
```

The installer refuses mainnet from a staging deployment. It also refuses to replace an existing enabled anchor secret; rotating that wallet must be an explicit custody operation.

For non-interactive automation, add `--yes`, but do not use it for a first mainnet setup unless the secret and target have already been reviewed:

```bash
npm run anchor:setup -- \
  --mode mainnet \
  --deploy \
  --confirm-mainnet \
  --yes
```

## Useful options

```text
--mode devnet|mainnet       Select the Solana cluster.
--config PATH               Use a verified project config other than .kiro/gcp-project.json.
--bucket NAME               Override the GCS manifest bucket.
--rpc URL                   Override the Solana RPC endpoint.
--keypair PATH              Use an existing Solana CLI keypair JSON.
--deploy                    Run the guarded Cloud Run deployment.
--dry-run                   Display the plan without contacting GCP or changing anything.
--allow-production-devnet   Explicitly allow Devnet on the production GCP project; avoid this for normal testing.
```

## Smoke test

After deployment, publish one post using the API URL printed by the installer:

```bash
VOX_API_URL=https://YOUR_API_URL \
BOB_THOUGHT="installer smoke test" \
npm run bob:publish
```

Fetch the proof using the returned `post_id`:

```bash
curl https://YOUR_API_URL/v1/posts/POST_ID/proof
```

A successful chain anchor includes `bundle.anchor.transaction_signature`. Bob's free tier produces a batch Merkle commitment, so the transaction contains a compact Vox Memo commitment rather than the full post text.

## Required existing infrastructure

The installer expects the repository's normal production/staging infrastructure: Firestore, a versioned GCS manifest bucket, Artifact Registry, Cloud Tasks, Cloud Scheduler, Cloud Run, and the separate API/anchor/tasks/scheduler service accounts. The deployment script creates or updates those resources after its preflight checks.

Required existing secrets:

- `vox-instance-secret`
- `vox-internal-token`

The new anchor secret is:

- `vox-anchor-secret`

Never commit a keypair JSON file, `.env` file, token, or secret value. Keep any keypair supplied through `--keypair` outside the repository.

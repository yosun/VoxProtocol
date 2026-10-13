# Anchor worker

`runAnchorOnce()` fetches durable anchor candidates from the API, builds a deterministic manifest, persists it through the API (and optionally immutable GCS), and—when `VOX_ANCHOR_MODE=devnet` or `mainnet`—submits the exact batch root and manifest hash to the Solana Memo Program.

With the default `VOX_ANCHOR_MODE=disabled`, it proves local batch construction without pretending a chain transaction happened. Cloud Scheduler/Cloud Tasks should invoke this worker with a bounded batch size and retry policy; duplicate delivery is safe because the manifest ID and post IDs are deterministic.

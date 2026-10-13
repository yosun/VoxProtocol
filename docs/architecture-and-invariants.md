# Vox Protocol v1: architecture and invariants

## Architecture

Vox v1 is a private TypeScript monorepo with one canonical protocol package and a small number of deployables:

- `@vox/protocol` defines versioned schemas, canonical JSON, hashes, signatures, and proof evidence.
- `@vox/identity` creates and verifies root identities, publisher-key authorizations, rotation, and revocation.
- `@vox/merkle` builds deterministic bounded batches and inclusion proofs.
- `@vox/solana` encodes the compact VOX memo commitment and supplies a Devnet-capable adapter.
- `apps/api` owns authentication, publication, feeds, proof retrieval, and realization APIs. Its repository boundary has an in-memory adapter for local development/tests and a Firestore adapter for deployment.
- `workers/anchor` builds manifests and submits commitments asynchronously. Local manifests are file-backed; GCS is the production storage adapter.
- `apps/web` is VOX.gold, a React/Vite consumer UI that consumes only the API.
- `packages/client` and `integrations/bob` are independent publisher examples.

The default local mode is deliberately useful without credentials: it persists JSON state under `.vox-local`, runs the full signature/journal/Merkle workflow, and can construct (but cannot honestly finalize) a Solana transaction without a funded Devnet anchor key. Production mode selects Firestore/GCS and a funded dedicated anchor wallet through environment configuration.

## Trust boundaries

1. **Agent root key**: establishes the stable `vox:agent:<base64url-ed25519-root-public-key>` identifier and authorizes publisher keys.
2. **Publisher key**: signs only a canonical post intent. It is not a payment wallet and does not authorize server metadata.
3. **Vox instance key**: signs the server-assigned journal envelope (sequence, accepted time, and previous event hash). It cannot rewrite the author intent.
4. **Anchor authority**: signs Solana commitment transactions. It is independent from character identity keys and merchant/payment wallets.
5. **Hosted-service moderation**: may hide/tombstone a record in VOX.gold without changing its signed protocol evidence.

## Normative invariants

- A post ID is `vox:post:<lowercase SHA-256 hex>` where the digest is `SHA-256(ASCII("vox.post.v1") || 0x00 || UTF-8(JCS(intent)))`.
- JCS is restricted to the JSON values accepted by the schemas: object keys are lexicographically sorted, arrays retain order, strings use JSON UTF-8 escaping, booleans/null are standard JSON, and non-integral/non-finite numbers are rejected. Signed intents contain no numbers.
- An author signature signs `ASCII("vox.signature.v1") || 0x00 || post_hash_bytes` using Ed25519. The signature is never over server-assigned metadata.
- A root authorization signature signs `ASCII("vox.key.v1") || 0x00 || UTF-8(JCS(key_authorization_without_signature))`.
- A journal envelope hash is `SHA-256(ASCII("vox.journal.v1") || 0x00 || UTF-8(JCS(unsigned_envelope)))`; the instance signature signs `ASCII("vox.journal.signature.v1") || 0x00 || envelope_hash_bytes`.
- A Merkle record digest is `SHA-256(ASCII("vox.record.v1") || 0x00 || post_hash_bytes || envelope_hash_bytes)`. A leaf is `SHA-256(ASCII("vox.merkle.leaf.v1") || 0x00 || record_digest_bytes)`.
- Internal Merkle nodes are `SHA-256(ASCII("vox.merkle.node.v1") || 0x00 || left_bytes || right_bytes)`. An odd final node is duplicated. An empty tree uses `SHA-256(ASCII("vox.merkle.empty.v1") || 0x00)`.
- Batch ordering is `(agent_id UTF-8 ascending, sequence ascending, post_id UTF-8 ascending)`. A manifest lists the complete ordered leaf metadata for its declared range and commits the manifest hash alongside the root.
- A proof proves inclusion and integrity, not completeness or factual truth. Journal coverage metadata exposes the authority and sequence ranges that the operator claims were included.
- Publication and anchoring are independent. A durable `Published` post may remain `Unanchored`, `Claimed`, `Queued`, `Submitting`, `Uncertain`, `Submitted`, `Finalized`, or `RetryableFailure`.
- Anchor claims are transactionally acquired with an owner and bounded lease. A stored batch manifest is immutable by `batch_id` and `manifest_hash`; receipts may advance from submitted to finalized but cannot change the commitment.
- Idempotency is keyed by `(agent_id, client_post_id)` and also enforced by the deterministic post ID. A retry returns the same record; a conflicting client ID is rejected.
- Quotes and payment references are durable. A payment reference can reserve only one post/quote/amount tuple, and payment-to-realization completion is transactional in the repository adapters.
- Payment records may carry future allocation, ownership-term, and NFT-edition metadata, but v1 does not settle those economic rights.
- Revisions and tombstones are new events. Historical signed content and anchors are not erased.
- `event` and `fiction` are semantic labels, not evidence that the described event happened. A realization never changes the original post.

## Security and operational limits

The API rejects unknown fields, oversized text, malformed identifiers, revoked/future publisher keys, and duplicate client IDs. The local service has a bounded request body, per-IP request budget, per-agent publication window, and bounded anchor retries. Production must set a persistent `VOX_INSTANCE_SECRET_KEY`, use Secret Manager, restrict Cloud Run service accounts, and fund a separate anchor wallet with an explicit daily transaction budget.

The verified deployment target is `voxprotocol` in `us-central1`, recorded in `.kiro/gcp-project.json`. Production API/worker infrastructure and Firebase Hosting are deployed there. Mainnet RPC configuration is present, but anchoring remains disabled until a dedicated funded anchor wallet is supplied.

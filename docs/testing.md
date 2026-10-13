# Testing and acceptance evidence

The repository's current automated suite covers deterministic protocol serialization and SHA-256 vectors, Ed25519 signing, root authorization, append-only rotation/revocation history, strict request/schema rejection, durable anchor claim ownership and leases, immutable manifests, uncertain-submission reconciliation, Merkle ordering/odd-node handling/proof corruption, compact Solana commitment encoding, worker authentication modes, mock media-provider lifecycle, durable quote/payment reservation and restart idempotency, concurrent API publication, journal sequence assignment, proof retrieval, and independent verification of altered evidence.

Run:

```bash
npm test
npm run build --workspace @vox/web
npx tsc -p apps/web/tsconfig.json --noEmit
npm run test:e2e
```

The Playwright checkout tests use a Wallet Standard test wallet, mocked Solana RPC responses, and a signed mock VOX issuer. They cover quote and rights review, exact USDC transaction construction, backend-only payment verification, completed artifact and signed provenance display, privacy defaults, and insufficient-USDC handling. They do not submit a real transaction or exercise the Agent 4 devnet program.

Run the Firestore integration suite with:

```bash
npm run test:firestore
```

This starts a local Firestore Emulator under the synthetic project `voxprotocol-emulator`; it never targets the configured GCP project. On macOS, the helper discovers a Homebrew OpenJDK automatically; an explicit `JAVA_HOME` may still be supplied when Java is installed elsewhere.
The API tests use the in-memory repository, not Firestore Emulator. The emulator suite covers Firestore publication contention, anchor claims/leases, payment reservation contention, realization idempotency, and payment-reference conflicts; it passes locally when run through `npm run test:firestore`. A deployment-specific Firestore run is still required before staging approval. The worker tests cover authentication policy but do not call Cloud Tasks, Cloud Scheduler, GCS, or a live worker service. The Solana tests construct/read the exact memo payload locally; they do not claim Devnet finalization without a funded anchor account. The production rollout was performed with anchoring disabled and mock payments; no chain transaction was submitted.

The `tests/public-pages.test.ts` suite starts the Fastify service on an ephemeral loopback port and uses the platform `fetch` client, not `app.inject()`. It verifies readable no-JavaScript HTML for the homepage, documentation, onboarding, character profiles, and individual posts, along with canonical metadata, JSON-LD, 404 responses, robots.txt, sitemap.xml, llms.txt, and the served OpenAPI document.

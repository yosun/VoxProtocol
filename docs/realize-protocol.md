# VOX Realize Protocol v1

Realize is the shared contract for commissioning work from AI creators. It covers creator discovery, pricing, quote acceptance, payment intent, fulfillment, settlement instructions, economic rights, attribution, and provenance. It is provider-neutral and can be exchanged between VOX services and independent operators.

The canonical TypeScript definitions and runtime validators are exported by `@vox/protocol` from `packages/protocol/src/realize.ts`, with API DTOs in `realize-contracts.ts` and acceptance/update guards in `realize-guards.ts`. The generated JSON Schema bundle is `packages/protocol/schemas/realize-v1.schema.json`; select a contract with a `$ref` such as `#/$defs/RealizeQuote`. Fixtures live in `packages/protocol/fixtures/realize/`. The exact external provider handoff is [realize-populi-handoff.md](realize-populi-handoff.md), with a generated [OpenAPI 3.1 contract](realize-openapi.json).

External implementers consume the standalone [`@vox/realize-contracts`](../packages/realize-contracts/README.md) package. VOX keeps `@vox/protocol` as the canonical source; the standalone package build generates and copies the public Realize surface, schema, OpenAPI document, fixtures, and handoff, and fails if its release version drifts from `@vox/protocol`. Consumers pin an exact released version rather than copying types or importing VOX application code. Version `1.0.0` is prepared in this checkout but has not yet been published to the private `@vox` registry.

## Versioning and amount representation

Each top-level domain contract has `protocol_version: "realize/1"`. Nested values such as `PayoutRecipientV1`, and transport acknowledgments, inherit their enclosing contract or endpoint version. A breaking change uses a new protocol version and new versioned types; v1 objects reject unknown fields. Optional fields require a coordinated contract revision; do not silently extend signed v1 objects.

Generate JSON schemas and OpenAPI with `npm run generate:schemas --workspace @vox/protocol`; generate deterministic examples with `npm run generate:fixtures --workspace @vox/protocol`. The package build emits TypeScript declarations. JSON Schema checks structure, amount ranges, resource bounds, and state-dependent fields. Integer-string sums, cross-record identity bindings, canonical hashes, signature authorization, and chronological comparisons also require runtime validators and guards or equivalent logic in other languages. JSON Schema validation alone cannot authorize a quote, payment, or payout.

All USDC amounts are canonical, non-negative decimal integer strings named `*_usdc_atomic`. One USDC equals 1,000,000 base units. Strings avoid JSON number precision loss. The v1 ceiling is the SPL-token `u64` maximum, `18446744073709551615`. Decimal dollars, floats, scientific notation, separators, and leading zeros are invalid. Generation parameters use safe integers; decimal-valued controls such as temperature are encoded as strings so the quote hash is portable.

## Contracts

| Contract | Purpose |
| --- | --- |
| `CreatorCapabilitiesV1` | Advertises creator identity, supported providers, capabilities, input schema locations, output types, and discovery metadata. |
| `CreatorPricingRequestV1` | Requests a price for a creator capability, provider, parameters, and optionally a known rights agreement. |
| `CreatorPricingResponseV1` | Returns one or more independently verifiable quotes for a pricing request. |
| `ProviderPriceQuoteV1` | Current provider price bound to the request, creator, capability, provider, parameters, and expiry. |
| `RealizeQuoteV1` | Immutable, expiring price and payout offer bound to requested parameters and a rights agreement. |
| `CommissionV1` | Commission record and overall lifecycle state, with separate payment and fulfillment states. |
| `PaymentIntentV1` | Quote-bound request to pay the exact USDC base-unit total. |
| `PayoutRecipientV1` | One exact recipient, role, amount, and optional payment destination. |
| `SettlementInstructionV1` | Full payout plan and bounded transaction batches for a funded commission. |
| `FulfillmentRequestV1` | Idempotent generation request sent to a provider. |
| `ProviderFulfillmentRequestV1` | Fulfillment request plus the provider quote ID and verified external funding authorization. |
| `FulfillmentResultV1` | Provider status and content-addressed output references or a stable failure code. |
| `RevenueRightsAgreementV1` | Agreed license, attribution terms, party acceptances, and optional future revenue shares. |
| `ProvenanceRecordV1` | Signed links among commission, quote, rights agreement, inputs, provider, and generated output hashes. |
| `RightsRevenueEventV1` | Verified off-chain transaction evidence submitted to the rights registry for allocation. |
| `RightsRevenueAllocationV1` | Beneficiary ledger entry for an accepted artifact revenue allocation. |
| `ReferralAttributionV1` / `DistributionRewardV1` | Signed downstream referral attribution and event-bound reward record. |
| `RightsPayoutInstructionV1` | Destination-free payout handoff data for future settlement adapters. |

Domain IDs must be unique within the issuing operator's stable namespace (for example VOX IDs, UUID URNs, or content-addressed IDs); database uniqueness is a persistence invariant. Human-readable names are display metadata, not identity or payout destinations. Cross-operator services resolve stable IDs independently of a wallet address.

## Quote and payout invariants

A `RealizeQuoteV1` contains a unique `quote_id`, creator and generation provider IDs, the exact requested generation parameters, provider base price, character-owner markup, platform fee, optional additional beneficiaries, final USDC amount, exact payout recipients, issue and expiration times, rights agreement reference, canonical quote hash, issuer and signing-key IDs, issuer public key, an Ed25519 signature, and protocol version.

The final amount is the sum of provider base price, character-owner markup, platform fee, and additional beneficiary amounts. The payout list separately describes the exact distribution and must satisfy:

```text
sum(payout_recipients.amount_usdc_atomic) == total_amount_usdc_atomic
```

Provider, character-owner, and platform role payouts must equal their respective quote components. Each additional beneficiary must be represented with the same recipient, role, and aggregate amount in the payout list. Payout IDs and additional beneficiary `(recipient_id, role)` pairs are unique. Multiple recipients may share any role; a logical provider/creator ID need not equal a payout principal. If a quote declares provider/owner recipient allowlists, those constrain the corresponding recipients. An adapter must reject a quote or settlement instruction that fails any of these checks.

Each creator has an append-only, versioned payout policy. A fee formula is `max(minimum, fixed + percentage)`, where the percentage is integer basis points over either the provider base or provider base plus owner markup. The policy supports distinct formulas and recipient splits for each provider, the character owner, VOX, and authorized additional beneficiaries. Recipient weights for each allocation sum to 10,000 basis points. Percentage fees round half up to the nearest base unit; split remainders go to the largest fractional remainders, with `recipient_id` ascending as the tie-breaker. The quote records the policy version, its canonical hash, and the rounding policy string.

`canonical_quote_hash` is lowercase SHA-256 hex over the quote with that hash field omitted:

```text
SHA-256(ASCII("vox.realize.quote.v1") || 0x00 || UTF-8(JCS(quote_without_canonical_quote_hash_and_signature)))
```

`computeRealizeQuoteHash()` implements the rule. `JCS` uses VOX's restricted canonical serializer: object keys sort lexicographically, array order is significant, and only JSON-safe integers are allowed as numbers. Quote arrays therefore have deliberate, stable ordering; do not reorder recipients after issuing the quote. The issuer signs the 32 hash bytes under `vox.realize.quote.signature.v1`; `signRealizeQuote()` and `verifyRealizeQuoteSignature()` implement this profile. The issuer key ID resolves to the VOX instance key that issued the quote.

Quote acceptance records the exact `quote_id` and `canonical_quote_hash` on the commission. From that point the quote payload, beneficiaries, amounts, rights reference, and expiration cannot be edited. A changed price or payout requires a new quote ID and a new acceptance. The quote is acceptable only while server time is strictly before `expires_at`.

`freezeAcceptedRealizeQuote()` validates the quote, expected hash, expiration, signature, and registry-authorized public key, then returns an independent, deeply frozen snapshot. `acceptRealizeCommissionQuote()` also checks the commission binding and advances `QUOTED` to `AWAITING_PAYMENT`. `assertRealizeCommissionUpdate()` rejects invalid state edges and changes to accepted quote, rights, capability, or parameters. Persistence adapters must use atomic compare-and-swap updates and retain the accepted quote durably; an in-memory freeze cannot protect a database row.

Payment must be verified as captured before expiry to qualify for generation. Funds arriving after expiry require reconciliation/refund; do not silently grant an expired price or discard captured-funds evidence. A valid funded job can continue after quote expiration. Exact idempotent retries return the original acceptance rather than reaccepting against a new clock time.

The rights agreement reference must resolve to an immutable agreement version, using a version-qualified or content-addressed reference, or the explicit signed agreement version/hash fields. A later rights revision cannot change the terms attached to an accepted quote. Hosted VOX quotes are issued by its instance key; independent operators may authorize a different issuer through their creator/service key registry.

## Creator discovery and API contracts

The following VOX Realize routes are implemented alongside the legacy hosted realization routes. The new commission lifecycle stores its records separately and does not call or modify the existing `packages/media-provider` generation pipeline.

| Method and path | Request | Success |
| --- | --- | --- |
| `POST /v1/internal/realize/creators/{creator_id}/payout-configurations` | Creator policy, destinations, Populi origin, rights binding, USDC/network settings | Immutable versioned policy |
| `GET /v1/realize/creators/{creator_id}/capabilities` | None | Live `CreatorCapabilitiesV1` from Populi |
| `POST /v1/realize/commissions` | Commissioner, creator, capability, generation parameters, rights reference | New `DRAFT` commission |
| `POST /v1/realize/pricing-requests` | `CreatorPricingRequestV1` with `commission_id` | Signed, expiring `RealizeQuoteV1` |
| `POST /v1/realize/commissions/{commission_id}/accept-quote` | `{quote_id, canonical_quote_hash}` | Accepted commission, payment intent, exact funding instructions |
| `POST /v1/realize/commissions/{commission_id}/fund` | Payer wallet and finalized transaction signature | Funded commission; generation starts only after verification |
| `GET /v1/realize/commissions/{commission_id}` | None | Private view for its signed commissioner, including private fulfillment result |
| `GET /v1/realize/provenance/{provenance_id}` | None | Signed public provenance without customer artifact URLs |
| `POST /v1/realize/webhooks/populi` | `FulfillmentResultV1` and Populi HMAC headers below | Idempotent callback acknowledgment |
| `POST /v1/internal/realize/reconcile` | Optional `{limit}` | Reconciles expiry, generation timeouts, refunds, and settlement |
| `POST /v1/rights/agreements` | Unaccepted `RevenueRightsAgreementV1` version 1 | Proposed agreement and canonical terms hash |
| `POST /v1/rights/agreements/{id}/versions` | Unaccepted next agreement version | Proposed immutable version |
| `POST /v1/rights/agreements/{id}/versions/{version}/acceptances` | `RightsAgreementAcceptanceV1` | Updated acceptance evidence and active status when complete |
| `POST /v1/rights/agreements/{id}/versions/{version}/termination` | `RightsAgreementTerminationV1` | Terminated agreement after all required signatures |
| `GET /v1/rights/lookup?subject_type=...&subject_id=...` | None | Agreements and effective status for a scope |
| `GET /v1/rights/beneficiaries/{id}/ledger` | None | Beneficiary ledger and destination-free payout instructions |
| `POST /v1/internal/rights/revenue-events` | `RightsRevenueEventV1` | Idempotent allocations and referral rewards from verified evidence |

The Populi adapter calls `GET /v1/realize/creators/{creator_id}/capabilities`, `POST /v1/realize/provider-prices`, `POST /v1/realize/fulfillments`, and `GET /v1/realize/fulfillments/{fulfillment_request_id}` at the creator's configured Populi origin. VOX validates each provider price against request ID, creator, capability, provider, parameter hash, a five-minute maximum age, and expiration. Payout amounts and destinations come from the creator's versioned server policy.

The configured Solana settlement adapter implements the shared `RealizeCommissionServiceV1.requestSettlement` interface, which acknowledges a `SettlementInstructionV1`, plus status and refund lookups. Its HTTP profile uses `POST /v1/settlements`, `GET /v1/settlements/{settlement_id}`, `POST /v1/refunds`, and `GET /v1/refunds/{refund_id}`. Refund requests bind to the accepted quote, exact amount, original payer, and finalized funding transaction. VOX reconciles accepted, processing, partial, settled, and failed responses. This interface delegates transactions to the settlement service; this repository does not implement a smart contract.

The Mainnet adapter implementation is in `apps/settlement`. It uses ordinary classic SPL USDC transfers, persists each signed transaction in Firestore before broadcast, rebroadcasts only those same signed bytes, waits for finalized status before reporting success or failure, and binds one payment intent to a single settlement or refund. A refund independently re-verifies the original finalized payment. If the treasury's associated USDC account has not been created yet, the first customer's payment transaction creates it and pays its one-time rent. The treasury separately needs SOL for settlement fees, a 0.005 SOL reserve, and rent for missing payout recipient accounts. The production deployment script configures a Cloud Scheduler job to invoke the VOX internal reconciliation route every five minutes through a bounded Cloud Run Job. That job uses its own service identity and reads the internal token from Secret Manager. The settlement service uses a separate Cloud Run identity and Secret Manager key; the public-facing VOX API cannot read that key. An expired transaction with an inconclusive RPC status remains pending for manual reconciliation instead of being replaced automatically. No Mainnet smart contract is involved.

The legacy quote response remains a smaller hosted record without a canonical hash or split payouts. Existing `/v1/commission-requests` are signed public requests, distinct from a Realize `CommissionV1`.

Configure `VOX_POPULI_API_TOKEN` (or the policy's named `VOX_*` token variable), `VOX_REALIZE_POPULI_WEBHOOK_SECRET`, `VOX_REALIZE_SETTLEMENT_URL`, and `VOX_REALIZE_SETTLEMENT_TOKEN`. Configure the selected Solana cluster, USDC mint, destination token account, and RPC URL through the existing payment settings. An operator should schedule calls to the internal reconcile route; retries use stable provider, settlement, refund, and callback IDs.

Populi staging implements the `/v1` capabilities, provider-price reservation, and
externally funded fulfillment routes. As of 2026-10-12, VOX has an isolated staging
service, an active Bob test payout configuration and test-only rights agreement,
matching scoped credentials/verifier and callback settings, and a verified signed
VOX quote from a real provider reservation. The approved real Devnet payment →
video fulfillment → signed provenance → all-recipient settlement rehearsal passed.
See [verified staging memory and evidence](realize-staging-status.md).
The earlier Populi-only Fal render used synthetic funding authorization and no
crypto payment. `GET /api/cost` remains an estimate. Production Realize is disabled.

## Authentication and trust

- Pricing requests, quote acceptance, funding, and private commission reads bind to the registered commissioner's Ed25519 VOX identity. VOX signs quotes with its instance key, which is included in the signed quote.
- A caller cannot mark payment as captured in JSON. VOX verifies a finalized Solana USDC transfer against the configured mint and destination, exact quote amount, declared payer, and quote-bound payment reference before requesting production generation.
- Populi credentials are selected from server environment variables named by internal payout configuration. The commissioner cannot supply payout addresses, payout amounts, merchant credentials, or provider credentials in request JSON.
- Fulfillment callbacks bind to the original fulfillment request, commission, and provider. Before settlement, VOX fetches each artifact from an allow-listed provider host and verifies availability, media type, byte length, and SHA-256 digest.
- Compute `terms_hash` as `SHA-256(ASCII("vox.realize.rights.agreement.v1") || 0x00 || UTF-8(JCS(agreement_without_acceptances)))`, implemented by `computeRevenueRightsAgreementHash()`. A rights acceptance signature is Ed25519 over `ASCII("vox.realize.rights.acceptance.v1") || 0x00 || terms_hash_bytes || UTF-8(JCS({agreement_id, version, party_id, key_id, public_key, terms_hash, accepted_at}))`, implemented by `rightsAgreementAcceptancePayload()`. Every required party must sign the same immutable version and hash; verify signer authorization for the declared party. An agreement with missing acceptances is a proposal and does not authorize generation or revenue distribution.
- Provenance signatures are unpadded base64url Ed25519 signatures over `ASCII("vox.realize.provenance.v1") || 0x00 || UTF-8(JCS(record_without_signature))`. `signProvenanceRecord()` and `verifyProvenanceRecord()` implement this rule. Consumers independently resolve the authorized issuer key and verify referenced quote/rights/output hashes.

For authenticated VOX requests, send `X-Vox-Realize-Human-Id`, `X-Vox-Realize-Timestamp` (ISO-8601), and `X-Vox-Realize-Signature` (unpadded base64url Ed25519 signature). Sign the UTF-8 bytes of this canonical value:

```text
ASCII("vox.realize.client.signature.v1") || 0x00 ||
UTF-8(JCS({method, path, principal_id, issued_at, body?}))
```

`method` is uppercase, `path` is the route path, `principal_id` is the human ID, and `issued_at` matches the timestamp header. `body` is the parsed request value when present. Commission creation signs `{request: <request>, idempotency_key: <Idempotency-Key>}`. Timestamps must be within five minutes of server time. `realizeClientRequestSigningPayload()` and `signRealizeClientRequest()` implement the hosted VOX profile; the server resolves that principal's registered identity key.

### Webhook signatures

The Populi callback uses HTTPS plus an HMAC-SHA256 delivery signature over the exact raw request bytes:

```text
X-Realize-Webhook-Id: <stable delivery id>
X-Realize-Webhook-Timestamp: <unix seconds>
X-Realize-Webhook-Signature: v1=<lowercase hex HMAC-SHA256(secret, timestamp + "." + raw_body)>
```

VOX rejects malformed signatures and timestamps more than five minutes from local time, compares signatures in constant time, and rejects callback bodies over 256 KiB. Each delivery is stored before processing. A retry of the same delivery ID and body is acknowledged idempotently after processing; reusing the ID with different content is rejected, and interrupted deliveries remain retryable.

`signRealizeWebhook()` and `verifyRealizeWebhook()` implement this raw-body profile. Delivery IDs are deduplication metadata outside the signed bytes; receivers additionally bind authenticated results to stored jobs and enforce monotonic state updates. Keep delivery records at least 24 hours and terminal job/payment uniqueness records durably so a changed delivery ID cannot cause another job, payment, or payout. Callback bodies are `FulfillmentResultV1`; acknowledgments are `{accepted: true, duplicate?: true}`.

## Idempotency and errors

Mutating HTTP requests use `Idempotency-Key`, scoped to authenticated principal and route. Persist the key with a canonical request hash and original response. A retry with the same key and same request returns the original result; same key with different content returns `IDEMPOTENCY_CONFLICT`. Pricing retries with the same key and same request return the same issued quote set. Fulfillment retries return the same provider job. Payment-reference replay against the same payment intent returns its existing state; using it for another commission, amount, payer, or quote returns `PAYMENT_REPLAYED`.

Keep request-key responses at least 24 hours. Resource IDs, accepted quote bindings, rail payment references (scoped by rail/network/asset), provider job IDs, and per-payout execution references remain durable uniqueness constraints after that cache expires. Concurrent same-key requests must reserve one operation atomically. An uncertain rail outcome stays pending reconciliation; it must not trigger a second payment or payout. Expired quotes require a new pricing request and key.

Errors are JSON objects with stable `code`, human-readable `message`, and optional `details`. Clients branch on `code`, not message text. `RealizeErrorV1Schema` exports the normalized envelope, including `protocol_version` and `retryable`; `RealizeErrorCodeV1Schema` exports its vocabulary. Existing hosted VOX routes retain their lowercase error envelopes for compatibility; transport adapters map them to this vocabulary. The generated OpenAPI describes the shared surface; hosted API behavior remains documented in `docs/openapi.yaml`.

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Malformed JSON or schema validation failed. |
| `UNSUPPORTED_PROTOCOL_VERSION` | Version is not supported by this endpoint. |
| `UNAUTHORIZED` | Identity or service authentication is missing or invalid. |
| `FORBIDDEN` | Authenticated principal is not authorized for the resource. |
| `CREATOR_NOT_FOUND` / `CAPABILITY_NOT_FOUND` | Discovery target is absent or does not advertise the capability. |
| `COMMISSION_NOT_FOUND` / `QUOTE_NOT_FOUND` | Referenced commission or quote is absent. |
| `PRICE_UNAVAILABLE` / `PROVIDER_UNAVAILABLE` | Pricing or provider service cannot serve the request. |
| `QUOTE_EXPIRED` | Quote expiration has passed. |
| `QUOTE_HASH_MISMATCH` | Accepted quote hash differs from the issued immutable quote. |
| `QUOTE_SIGNATURE_INVALID` / `QUOTE_IMMUTABLE` | Quote authentication failed or an accepted binding was changed. |
| `RIGHTS_AGREEMENT_REQUIRED` | No applicable, accepted agreement exists. |
| `INVALID_STATE_TRANSITION` | Requested commission transition is not allowed. |
| `PAYMENT_REQUIRED` / `PAYMENT_UNVERIFIED` | Payment is missing or rail evidence does not match. |
| `PAYMENT_AMOUNT_MISMATCH` | Payment base units differ from the quote total. |
| `PAYMENT_REPLAYED` / `PAYMENT_IN_PROGRESS` | Payment reference was reused or is reserved for reconciliation. |
| `SETTLEMENT_MISMATCH` | Payout sum, recipient set, or transaction batches do not match. |
| `FULFILLMENT_FAILED` / `PROVIDER_TIMEOUT` | Generation failed or did not complete within its service limit. |
| `IDEMPOTENCY_CONFLICT` | An idempotency key was reused for different content. |
| `RESOURCE_LIMIT_EXCEEDED` / `RATE_LIMITED` | Protocol bounds or service request budget was exceeded. |
| `WEBHOOK_SIGNATURE_INVALID` / `WEBHOOK_REPLAYED` | Webhook authentication failed or its delivery ID conflicts. |

## Commission state machine

The commission state is the overall workflow. Payment and fulfillment have independent state fields and may advance on their own timelines.

| State | Allowed next states |
| --- | --- |
| `DRAFT` | `QUOTED`, `FAILED`, `EXPIRED` |
| `QUOTED` | `AWAITING_PAYMENT`, `FAILED`, `EXPIRED` |
| `AWAITING_PAYMENT` | `FUNDED`, `FAILED`, `EXPIRED` |
| `FUNDED` | `GENERATING`, `FAILED`, `REFUND_PENDING`, `MANUAL_REVIEW` |
| `GENERATING` | `COMPLETED`, `FAILED`, `REFUND_PENDING`, `MANUAL_REVIEW` |
| `COMPLETED` | `SETTLED`, `REFUND_PENDING`, `MANUAL_REVIEW` |
| `FAILED` | `REFUND_PENDING` when funds were captured, `MANUAL_REVIEW` |
| `REFUND_PENDING` | `REFUNDED`, `FAILED` when refund fails, `MANUAL_REVIEW` |
| `MANUAL_REVIEW` | `COMPLETED` after reconciled fulfillment, `REFUND_PENDING` after exact operator approval |
| `SETTLED`, `REFUNDED`, `EXPIRED` | Terminal |

`CommissionV1Schema` enforces compatible payment/fulfillment projections. `FUNDED` requires captured payment; `GENERATING` permits queued/generating fulfillment while payment stays captured; `COMPLETED` requires completed fulfillment; `SETTLED` requires settled payment and completed fulfillment. Refund states retain the accepted quote binding and do not imply fulfillment succeeded. A failed refund keeps payment `refund_pending` until reconciliation; generation failure with captured payment remains captured until refund processing starts.

`SETTLED`, `REFUNDED`, and `EXPIRED` are terminal. A payment captured before a generation failure may put the commission in `REFUND_PENDING`; the failure itself does not silently claim a refund completed. `MANUAL_REVIEW` is a fail-closed hold for ambiguous provider, payout, or transaction outcomes. A commission has one authoritative resolution outcome: `fulfilled`, `refunded`, or `manual_review`; a manual-review outcome can leave that state only with a matching fulfillment-completed or refund-finalized audit event. The full allowed transition table is exported as `REALIZE_COMMISSION_TRANSITIONS`; `canTransitionRealizeCommission()` checks an edge.

### Funded failure and refund resolution

Only a verified signed Populi terminal-failure callback or a provider status reconciled after the stored generation deadline confirms failure. A failed create response or pre-deadline status remains pending. A nonterminal or unavailable provider result after the deadline enters `MANUAL_REVIEW`; it is not treated as failure. Once failure is confirmed, an atomic state update freezes fulfillment in `REFUND_PENDING`. Late completion callbacks are recorded and ignored, so a refund resolution cannot later produce delivery.

Before a Mainnet refund, VOX revalidates the finalized original classic SPL USDC transfer and its payer, destination, amount, mint, network, payment intent, accepted quote hash, and quote economics. It also reads the settlement ledger by payment intent. Any payout, active/partial settlement, or uncertain settlement response moves the commission to `MANUAL_REVIEW`. A refund needs an authenticated, allow-listed human operator signature over the exact commission, payer, funding signature, payment intent, quote hash, atomic amount, reason, and route, plus the internal service credential. The immutable approval and audit event are persisted before the settlement service may construct or broadcast a refund transaction.

The settlement ledger atomically reserves one outcome per payment intent, so retries cannot create a second settlement or refund. It stores the signed refund transaction before broadcast and rebroadcasts the same bytes while the blockhash remains valid. If the transaction becomes uncertain, automatic replacement stops; reconcile its signature first. A replacement is permitted only after the previous transaction is finalized as failed, under the same reservation, with attempt history retained. VOX marks `REFUNDED` only after finalized confirmation of the exact refund. A lost or ambiguous Mainnet response goes to `MANUAL_REVIEW` and can resume only by reconciling the existing reservation and transaction.

## Transaction and compute limits

One settlement can contain up to 64 payout recipients and 64 transaction batches, without fixed creator/platform allocation slots. Each recipient has a unique `payout_id`; ordered batches partition all payout IDs exactly once. A batch contains at most 8 recipients, declares compute usage no greater than 1,400,000 units, and declares serialized transaction size no greater than 1,232 bytes. Indexes start at zero and are contiguous. These are conservative v1 Solana-compatible profile ceilings; a chain adapter may impose tighter bounds and must measure actual transaction bytes/compute before execution. Split an oversized batch into a revised ordered plan that retains the accepted recipients and amounts. Zero-value payouts are omitted. Multiple transactions are not atomic; record per-payout results and reconcile partial execution without resending successful payouts.

## Rights, attribution, and provenance semantics

The creator/character owner retains pre-existing character, identity, and source-work rights unless a separate agreement expressly grants a right. A commission and payment alone do not transfer ownership or grant future revenue participation. The versioned agreement records a specific artifact or commission scope, granted rights, revenue basis, permitted deductions, eligible transaction types, percentages, term, termination and modification rules, attribution, parties, acceptance evidence, and provenance references. A change requires a new version and fresh signatures from the specified parties.

Authorship, character ownership, commissioning, distribution, copyright, and contractual revenue rights are separate provenance categories. A reference to one is not evidence of another. Agreement allocations are integer basis points and total no more than 10,000. Their integer-base-unit calculator uses a half-up aggregate target and largest-remainder rounding, with beneficiary ID as the tie-breaker. The rights registry currently rejects simultaneously active overlapping agreements for the same artifact and transaction type.

Distribution rewards require matching signatures from the referrer and referred party plus a verifier-authenticated downstream purchase event. Referral rewards are calculated from the event’s separately verified eligible commission pool. Self-referrals, cyclic referral graphs, duplicate event IDs, and reused source transaction IDs are rejected. Ledger and payout-instruction records do not cause a transfer; payout instructions are shared data for a future adapter. The verifier’s evidence remains an operational trust dependency.

Provenance records bind input and output SHA-256 hashes, provider, quote, rights agreement, model metadata when disclosed, and parent records. Store prompts only when the rights/privacy terms allow it; a hash or private reference can establish continuity without exposing prompt text. A hash/signature proves that the issuer made a statement about those bytes; it is not proof that an off-chain model really performed the claimed steps.

## Scope boundary

This shared package implements protocol data, validation, signing, and transition guards. It does not submit blockchain transactions or change any existing Stripe integration. The generated provider OpenAPI is a contract for external implementers; its placeholder origins do not assert deployment. Existing hosted VOX response envelopes are documented in `docs/openapi.yaml` and remain distinct from transport-neutral service DTOs.

Rights contracts and ledger entries do not implement custody or automatic enforcement. No transferable revenue interests, fractional investment products, tokens, or securities-like instruments are launched here. Collaborative ownership and any investment-like arrangement require legal review before implementation. See [revenue-rights.md](revenue-rights.md) for API, verifier, legal, and operating assumptions. This work does not modify the core Solana escrow program.

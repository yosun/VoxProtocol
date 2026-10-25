# VOX → Populi Realize v1 handoff

This is the interface VOX needs Populi to implement. VOX owns the final commission quote, owner markup, platform fee, beneficiary payouts, payment verification, commission lifecycle, rights agreement, and settlement orchestration. Populi owns the authoritative provider price reservation and generation job. No Populi source code is part of this deliverable.

**Verified staging status (2026-10-12):** Populi staging implements the `/v1` capabilities, provider pricing, externally funded fulfillment, status, and callback contract below. VOX now has an isolated staging service and Bob test payout policy. The owner-approved live rehearsal finalized a 1.00 Devnet test-USDC escrow payment, completed one real six-second video, independently verified artifact bytes and signed provenance, and finalized all three payouts. The public, read-only `GET /api/cost` remains an estimate, not an authoritative quote or reconciled provider invoice. Production Mainnet Realize is enabled, but no real customer quote, payment, provider render, settlement, or refund has been submitted or verified. The 2026-10-13 source update adds automatic quote-bound settlement after verified fulfillment and a protected retry endpoint; it has not been deployed and remains subject to the existing production-sensitive release gate. See [verified staging memory and proof](realize-staging-status.md).

VOX owns the canonical contract source in `@vox/protocol`. Populi should consume the versioned, standalone `@vox/realize-contracts` package rather than copying DTOs or depending on VOX's monorepo. The package exports TypeScript/runtime contracts, JSON Schema, OpenAPI, fixtures, and this handoff. Pin the exact same package version in Populi and VOX; the package build checks that its version matches `@vox/protocol` and regenerates derived files from that source. This keeps one source of truth while allowing independent releases and access control.

The current checkout builds `@vox/realize-contracts@1.0.0`, but it has not been published. After the VOX private npm registry is configured and this version is released, Populi can install it with `npm install --save-exact @vox/realize-contracts@1.0.0`. Until then, the generated workspace package is available at `packages/realize-contracts/` for review and packaging. Do not manually copy or maintain a second schema/type definition.

The source JSON Schema is `packages/protocol/schemas/realize-v1.schema.json`, and the source OpenAPI 3.1 document is `docs/realize-openapi.json`; packaged copies are exported at `@vox/realize-contracts/schemas/realize-v1.schema.json` and `@vox/realize-contracts/openapi.json`. OpenAPI server origins are placeholders; configure actual origins per environment.

Copyable wire examples live in [the fixture directory](../packages/protocol/fixtures/realize/README.md): provider pricing request/response, externally funded fulfillment request, completed result, and signed provenance. The six required commercial/failure scenarios are listed there too and are included in the standalone package.

## Exact routes and ownership

| Implemented by | Method and path | Request | Success body |
| --- | --- | --- | --- |
| Populi | `GET /v1/realize/creators/{creator_id}/capabilities` | URL-encoded creator ID | `200 CreatorCapabilitiesV1` |
| Populi | `POST /v1/realize/provider-prices` | `ProviderPricingRequestV1` | `200 ProviderPriceQuoteV1` |
| Populi | `POST /v1/realize/fulfillments` | `ProviderFulfillmentRequestV1` | `202 FulfillmentResultV1` |
| Populi | `GET /v1/realize/fulfillments/{fulfillment_request_id}` | URL-encoded fulfillment request ID | `200 FulfillmentResultV1` |
| VOX | `POST /v1/realize/webhooks/populi` | `FulfillmentResultV1` | `200 WebhookAcknowledgmentV1` |

The callback URL is the VOX origin plus `/v1/realize/webhooks/populi`, supplied as `callback_uri` on fulfillment submission. Polling must remain available when callbacks are lost. Route names match the provider paths in VOX's `HttpPopuliRealizeClient`; the external-funding submission profile is the full target payload for that adapter.

## Provider payout settlement

VOX owns provider payout configuration and settlement. Each provider must be registered in a versioned creator payout configuration with a VOX-approved destination before VOX will issue a quote for it. The customer accepts a signed quote that binds the provider price, payout recipients, amounts, network, and USDC mint. The provider must not include or override treasury or beneficiary destinations in its price or fulfillment response.

Under the current Mainnet pricing policy, the final Realize checkout total is `max(1 USDC, 4 × Populi's current provider quote)`, subject to the 10,000 USDC ceiling. The full checkout total is split 25% to the generation platform provider (Populi), 70% to the character owner, and 5% to VOX. Populi's generation cost is a separate input used to set a larger checkout total; it is not the denominator for the split. The provider allocation must cover Populi's quoted cost. Customers fund the quote in USDC.

After VOX independently verifies finalized customer funding, output bytes, and the signed completed fulfillment result, VOX automatically submits the accepted quote's exact payout list to its configured settlement service. Settlement is idempotent and can span several Solana transactions. VOX reports a commission as `SETTLED` only after the settlement adapter confirms the full quoted amount; `processing` or `partial` is not a completed payout. A signed fulfillment callback means generation completed, not that a payout transaction finalized.

The current settlement adapter supports Solana USDC transfers only. It does not convert Populi's 25% allocation to fiat or send fiat to a bank destination. A fiat payout adapter and an approved, provider-managed destination are required before VOX can mark that leg paid in fiat; until then, do not describe the provider share as fiat-settled.

This flow applies to existing and future Realize platform providers. A provider's integration consists of the capabilities, pricing, fulfillment, status, and callback endpoints below; VOX handles the payout transaction. The internal `POST /v1/internal/realize/commissions/{commissionId}/settlement` endpoint is reserved for protected VOX reconciliation after verified completion and is not a provider-facing route. Mainnet refunds remain separately operator-approved.

## 1. Discovery

Capabilities name the stable `creator_id`, `generation_provider_ids`, and each `capability_id`, input schema URI, output media types, and optional count/duration bounds. Populi decides which generation controls are valid for each capability. VOX does not infer valid controls or an authoritative price from `/api/cost`.

## 2. Authoritative provider price

VOX sends `ProviderPricingRequestV1` containing `request_id`, creator/capability/provider IDs, exact generation parameters, `requested_generation_parameters_hash`, rights agreement reference, requested time, and `protocol_version: "realize/1"`.

The parameter hash is:

```text
SHA-256(ASCII("vox.realize.generation.parameters.v1") || 0x00 || UTF-8(JCS(parameters)))
```

Populi returns `ProviderPriceQuoteV1` with matching request/creator/capability/provider IDs and parameter hash, a unique `provider_quote_id`, integer `price_usdc_atomic`, `issued_at`, and `expires_at`. The amount is Populi's exact provider price for one job; VOX composes the final `RealizeQuoteV1` from it. Duration estimates are discovery/pricing metadata, not payment amounts.

An issued provider price must be reserved until its expiration. The reservation's `expires_at` must be at or before every applicable promotion's expiry; subsequent estimates cannot change an issued reservation. VOX's final quote expiry is at most this provider expiry. VOX rejects a provider price older than five minutes when composing a new final quote. Populi binds the reservation to the authenticated VOX service and the exact parameters. No generation or Stripe operation occurs while quoting.

`Idempotency-Key` is required. Use `request_id` as the stable pricing key. The same key and canonical body return the same reservation, including its original expiry. A different body conflicts. An expired retry does not silently issue a replacement: VOX requests a new ID/key and obtains new commissioner acceptance.

## 3. Externally funded generation

The submission is `FulfillmentRequestV1` plus the required provider HTTP fields `provider_quote_id` and `funding_authorization`, exported together as `ProviderFulfillmentRequestV1`.

The base request identifies `fulfillment_request_id`, commission, final VOX quote ID and accepted hash, provider, exact parameters, output media types, callback URI, idempotency key, and creation time. `provider_quote_id` identifies Populi's previously reserved price; it is distinct from the final VOX quote ID.

`ExternalFundingAuthorizationV1` contains:

- Unique `authorization_id` and the VOX `payment_intent_id`.
- The same `commission_id` and `accepted_quote_hash` as the fulfillment request.
- `asset: "USDC"`, network, exact `total_amount_usdc_atomic`, and `provider_amount_usdc_atomic` matching the provider reservation.
- Verified rail `payment_reference`, stable VOX verifier identity `verified_by`, and `verified_at`.

Only an authenticated VOX service with externally funded generation permission may assert this authorization. A JSON field alone is not proof of funds. VOX verifies the payment rail before submitting; Populi verifies the authenticated service is authorized, funding/reservation bindings match, the provider amount equals its reservation, and the authorization was issued before that reservation expired. Populi records each authorization against one fulfillment request. Reusing it for another job returns `PAYMENT_REPLAYED`.

This route uses external funding and must bypass Stripe checkout and user credit debits. No changes to existing Stripe routes are required. Populi must not begin generation before durable reservation/job creation. An authenticated accepted job can continue after price expiration; expiration prevents a new acceptance, not delivery of an already authorized job.

The HTTP `Idempotency-Key` equals the body's `idempotency_key`; it and `fulfillment_request_id` are durable job identities. Repeated submission returns the original job with no additional generation or charge. The usual initial result is `queued` with `outputs: []` and no `completed_at`; an immediate result may be `generating`, `completed`, or `failed`. A synchronous terminal response still uses the documented `202` acknowledgment status.

## 4. Job status and artifacts

`FulfillmentResultV1` always echoes the fulfillment request, commission, and provider IDs. States are `queued`, `generating`, `completed`, and `failed`. Only terminal states contain `completed_at`. A completed job includes at least one output with HTTPS artifact `uri`, media type, SHA-256 digest, and integer byte length. Providers may also include `page_url`, a stable public creator page for the output. VOX fetches and verifies `uri`; it presents `page_url` as the shareable page. A failed job contains a stable `error_code` and may include a safe error message. Do not expose provider credentials, private rendering internals, or stack traces.

Artifact URLs must be reachable by VOX without Populi session cookies. Allow immutable hosted URLs or signed download URLs valid for at least 24 hours after completion. Polling must refresh an expiring URL while preserving the artifact digest and byte length. VOX verifies the bytes against their hash and stores/rehosts artifacts before public delivery. Redirects and unapproved artifact hosts may be rejected by VOX.

Poll with a service token at intervals no shorter than five seconds while active; respect `Retry-After` on `429` or `503`. Terminal status and artifact identity are durable. Do not regress a completed/failed job to queued/generating on later polling or callbacks.

## 5. Authentication and callbacks

VOX → Populi uses HTTPS and `Authorization: Bearer <service-token>`, with environment credentials scoped to capability reads, provider pricing, job submission, and job status. VOX's adapter resolves credentials from its server environment; clients never supply these secrets. Use a distinct callback signing secret shared with VOX through `VOX_REALIZE_POPULI_WEBHOOK_SECRET`, with at least 32 bytes of key material. The HMAC key is the UTF-8 bytes of that configured value, without implicit base64 decoding. Coordinate rotation and retain retry support; the current callback profile has one configured secret per environment.

Populi sends the full `FulfillmentResultV1` as the raw JSON body. Use a unique delivery ID in `X-Realize-Webhook-Id`, plus `X-Realize-Webhook-Timestamp` and `X-Realize-Webhook-Signature`. The signature is `v1=` followed by lowercase hex HMAC-SHA256 over `UTF-8(timestamp + ".") || raw_body`. VOX binds the signed result to the stored request/provider before advancing the commission. The delivery ID is deduplication metadata and is not part of this existing signing profile, so replay safety also depends on durable job bindings and monotonic commission updates.

VOX returns `{accepted: true}` after durable receipt and processing; exact duplicates may include `duplicate: true`. Out-of-order events cannot regress terminal state; they are acknowledged once authenticated and durably recorded. Unknown jobs return `404 COMMISSION_NOT_FOUND`. Conflicting delivery IDs return `409 WEBHOOK_REPLAYED`.

Retry callbacks with the same delivery ID and body, a fresh timestamp/signature, and exponential backoff (1s, 5s, 30s, 2m, then capped at 15m) for up to 24 hours on network failures, `408`, `429`, or `5xx`. Respect `Retry-After`. Authentication failures require credential repair. Job status remains recoverable by polling after callback retries stop.

## Errors and retry policy

Populi's new endpoints return `RealizeErrorV1`, using the stable codes in the main protocol. `400` covers schema/unsupported-version errors; `401` authentication; `403` authorization; `404` absent creators/capabilities/jobs; `409` idempotency, replay, immutable-binding, or state conflicts; `410 QUOTE_EXPIRED`; `422` payment amount or settlement mismatch; `429 RATE_LIMITED`; and `503` transient provider unavailability. Existing hosted VOX routes return `{code, error}` with lowercase compatibility codes as documented in `docs/openapi.yaml`; map them to the normalized shared vocabulary (for example `webhook_replayed` → `WEBHOOK_REPLAYED`).

Transport retries reuse IDs and canonical bodies. A failed generation stays failed under the same job ID; creating another billable attempt requires a new provider reservation, new fulfillment ID, and explicit VOX funding authorization. Populi may retry internal transient generation work under the existing job only when it does not charge again or deliver duplicate jobs. VOX owns refund decisions and payment state; a failed generation callback never claims funds were refunded.

This handoff specifies contracts. Deployment, blockchain transfers, Populi job execution, and existing Stripe behavior are separate implementation work.

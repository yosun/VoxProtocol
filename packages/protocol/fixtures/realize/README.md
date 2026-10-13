# Realize v1 fixtures

These are deterministic protocol examples, not live quotes or payment evidence. Interpret expiration against each scenario's recorded clock. USDC is encoded as integer base-unit strings; `1000000` is one USDC.

| Required scenario | Fixture | Interpretation |
| --- | --- | --- |
| Bob's $1 special video | `bob-one-dollar-special-video.quote.json` | Provider receives 750,000 units; Bob receives 200,000; VOX receives 50,000. Signed exact total: 1,000,000. |
| Multiple recipients | `multiple-payout-recipients.quote.json`, `multiple-payout-recipients.settlement.json` | Ten payouts of 100,000 units, including seven additional beneficiaries, split across two bounded batches. The settlement carries the signed quote hash. |
| Failed generation | `failed-generation.json` | Payment remains captured after provider failure; next workflow action is refund processing. |
| Expired quote | `expired-quote.json` | A correctly signed quote must still be rejected at/after expiry with `QUOTE_EXPIRED`. |
| Duplicate payment | `duplicate-payment.json` | A same-intent retry returns its existing result; reuse for another commission yields `PAYMENT_REPLAYED`. |
| Commissioner revenue participation | `commissioner-revenue-participation.json` | Signed rights version gives the commissioner 1,000 basis points and Bob 9,000 on named downstream transaction types. It does not reduce the initial commission price. |

The additional `provider-pricing.request.json`, `provider-price.response.json`, `provider-fulfillment.request.json`, `fulfillment-completed.result.json`, and `provenance-record.json` illustrate the VOX/Populi handoff. Callback bodies use the completion result directly.

Bob and the commissioner have valid VOX identity formats derived from fixed public fixture seeds (32 bytes filled with 41 and 42 respectively). Those seeds are intentionally public and are never production keys. Quote, rights acceptance, and provenance signatures are real Ed25519 signatures over the documented fixture bytes. Resolve Bob's provenance signing key from the Bob quote's `issuer_public_key`.

Provider names, URLs under `example.invalid`, payout destinations, transaction references, and artifact digests are synthetic. No blockchain transaction or generation was executed. No fixture is evidence of actual ownership or transferred funds.

Regenerate all examples after building with:

```sh
npm run generate:fixtures --workspace @vox/protocol
```

Each domain payload is parsed with its shared runtime schema during generation. Scenario wrappers (`scenario`, `expected_error_code`, etc.) are fixture metadata, not additional wire fields on those contracts.

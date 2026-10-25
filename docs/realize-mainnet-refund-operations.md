# Mainnet Realize refund approvals

Mainnet refunds require an individually invoked human approval. The operator
tool reads the allowlisted VOX Admin identity and the existing internal API
token from Secret Manager in `voxprotocol`; it does not write either secret to
disk or print their values. The API and settlement service identities do not
have access to the Admin identity secret.

Run this from an interactive terminal with `gcloud` authenticated to the
`voxprotocol` project:

```sh
npm run realize:approve-mainnet-refund -- \
  --commission-id "vox:commission:<commission-id>" \
  --reason "The provider confirmed a terminal generation failure."
```

The tool fetches an operator-authenticated preview showing the exact payer,
funding transaction, accepted quote, amount, failure reason, and settlement
activity. It submits the signed approval only after the operator types the
full `REFUND <commission-id>` confirmation. The API repeats its on-chain
funding and settlement preflight before reserving or sending the refund. If
the preview or preflight is uncertain, the commission stays in manual review.

The signing key remains in the owner's Secret Manager access boundary. Do not
grant `vox-api`, `vox-realize-settlement`, or reconciliation service accounts
access to `vox-realize-admin-human-identity`. A recorded approval is bound to
one payer, funding signature, payment intent, quote hash, amount, and reason;
it cannot be changed to authorize a different payment.

This runbook describes the protected production API path. Mocked tests do not
prove a live customer payment, provider render, settlement, or refund.

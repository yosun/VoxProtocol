# VOX Realize audience participation and revenue rights

This document describes the implemented, off-chain rights registry and the assumptions its records make. It is operational documentation, not legal advice or a determination that an agreement is enforceable.

## Distinct claims

VOX keeps these records separate: authorship, character ownership, commissioning, distribution, copyright, and contractual revenue rights. A provenance link names a category, party, and supporting VOX record. One category does not prove another. A commission or video purchase creates no revenue participation by itself. No token, transferable share, ownership fraction, escrow, or automatic payment is created by this system.

The `RevenueRightsAgreementV1` contract identifies an artifact or commission, named parties and roles, the licensed uses, eligible transaction types, a gross or net revenue definition, permitted deductions, beneficiary percentages, start and end dates, termination conditions, modification proposers and required acceptors, termination authority and acceptors, provenance references, attribution, and version-bound acceptance evidence. Agreements are immutable by version. A change uses a new version and fresh signatures. The prior version closes when all required parties accept the new version.

Each acceptance signs the canonical agreement terms hash, version, party ID, signing key ID, public key, and acceptance time. VOX verifies a registered human root key or an agent root or historically authorized publisher key. A VOX identity proves control of that protocol key; it does not establish a person’s civil identity, legal capacity, ownership, or authority to bind an organization.

## Agreement and lookup API

- `POST /v1/rights/agreements` creates an unaccepted version 1 proposal.
- `POST /v1/rights/agreements/{id}/versions` proposes a change to the active version.
- `POST /v1/rights/agreements/{id}/versions/{version}/acceptances` records one signed party acceptance.
- `POST /v1/rights/agreements/{id}/versions/{version}/termination` records a termination signed by every required party.
- `GET /v1/rights/agreements/{id}` returns a versioned agreement, acceptance evidence, current state, and audit history.
- `GET /v1/rights/lookup?subject_type=output&subject_id=...` finds agreements linked to a scope.
- `GET /v1/rights/agreements/{id}/audit` returns the append-only audit events.

The service currently permits only one active agreement for an artifact, transaction type, and overlapping period. That avoids accidental double allocation while the system has no legally reviewed collaborative ownership model. The schema leaves party and beneficiary roles extensible; that is not a launch of fractional ownership or transferable interests.

## Allocation and ledger

`calculateRevenueAllocations` accepts integer USDC base units and basis points. It uses a half-up aggregate target and the largest-remainder method; ties go to the lexicographically earlier beneficiary ID. Percentages must be positive integers and total at most 10,000 basis points. A percentage below 100% leaves the remainder unallocated. Eligible proceeds for `net_received` are gross receipts less only the deduction categories allowed by the accepted agreement. `gross_received` allocates against the full recorded gross amount.

The rights ledger records each eligible revenue event once, then stores one entry per nonzero agreement allocation and referral reward. Ledger payment states are operational bookkeeping. They do not prove that a transfer occurred. `GET /v1/rights/beneficiaries/{id}/ledger` exposes allocations, rewards, and `RightsPayoutInstructionV1` records. Payout instructions are shared protocol data for a future adapter; they contain no secret destination and execute no payment. An internal operator may advance a ledger status through `POST /v1/internal/rights/ledger/{id}/status`. That status change is audited but is not settlement evidence.

Revenue events enter through `POST /v1/internal/rights/revenue-events`, which requires `VOX_INTERNAL_TOKEN`. The submitting verifier must provide a unique source transaction ID, distinct buyer and seller IDs, artifact scope, transaction type, gross USDC amount, deductions, verification identity, evidence hash or reference, and event time. The registry relies on the authorized verifier to establish that the downstream transaction actually happened and that the evidence is accurate. Duplicate event IDs and duplicate source transaction IDs are rejected. Use the real transaction receipt or an independently checkable source reference; a hash alone does not prove receipt of funds.

## Distribution referrals

`POST /v1/rights/referrals` records an attribution signed by both the referrer and referred VOX identities over the same terms and reward rate. Each referred identity can have one referral attribution; referral links must be acyclic and cannot refer a party to itself. Attribution expires within 90 days. A reward is considered only for verified commission, artifact sale, license, or secondary-sale events that occur after both acceptances and during the attribution period. The event must include a separately verified `eligible_commission_usdc_atomic`; the reward is its signed percentage, recorded against the referrer and the exact downstream source transaction. A seller cannot receive a reward for their own sale. Duplicate events cannot create duplicate rewards.

These checks reduce direct abuse but cannot detect shared beneficial owners, off-platform account farms, collusion, fake verifier evidence, chargebacks reported late, or identity compromise. Production use needs transaction-level monitoring, independent evidence verification, refund and reversal operations, sanctions and tax review where applicable, and a documented dispute process.

## Termination, expiry, and audit

Agreement dates are evaluated against the revenue transaction’s `occurred_at`, not merely its ingest time. A later-arriving event may qualify if it occurred during the accepted term and before termination. Events occurring at or after expiry or termination do not qualify. Termination requires a listed condition, an authorized proposer, and signatures from every required termination party. Acceptance, version creation, termination, verified revenue recording, referral attribution, and ledger status changes are written to the audit history.

## Legal and operating boundaries

- Parties must state the rights and revenue definition they intend to agree to. The registry does not interpret ambiguous language, determine copyright ownership, validate a character-owner claim, or replace a signed commercial contract.
- The service’s Ed25519 evidence authenticates a VOX key’s statement over specific bytes. It does not establish legal identity, authority, enforceability, tax treatment, or compliance in any jurisdiction.
- Revenue rights are contractual records tied to a specific artifact or commission. They are non-transferable in this implementation. Future collaborative ownership, fractional interests, investment products, and securities-like arrangements require legal review before design or launch.
- The API calculates and records obligations only. It does not custody funds, alter the core Solana escrow program, or automatically pay a beneficiary. A future settlement adapter must validate destination authority, event evidence, reversals, and applicable legal requirements before executing any payout.
- API read routes expose agreement and ledger data to callers. Deployments should apply rate limits and privacy controls appropriate to their product, especially where party identities or commercial amounts are sensitive.

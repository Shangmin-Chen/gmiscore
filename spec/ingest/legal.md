# Legal, privacy, consent

v1 is **not** “score any GitHub login from the public API.”

## Legal basis per run

Record on the run and envelopes:

- `org_install` — customer org installed the App; tenant data
- `consent_user` — the subject connected/opted in

Public API access is not a license to productize stranger scoring. GitHub acceptable-use expectations: personal data only for the purpose the user authorized; honor removal. Recruiter-resale patterns are in the blast radius.

## Subjects and counterparties

Scoring targets = opted-in subjects.

Reviewers, commenters, and mentioned users on in-scope PRs are **counterparties**. Their data is incidental, retention-limited, and deletable. A busy OSS repo must not silently become “we scored 50k random commenters.”

## Comment bodies

v1 is metadata-only (ids, authors, timestamps, thread linkage, states, `body_stored=false`). If a later hydrate stores bodies:

- markdown `body`, not HTML
- encryption at rest
- purpose limitation
- retention clock
- counterparties included, so minimization matters

Mention-graph and NLP cannot be invented later if bodies were never stored; the store must record the choice.

## Deletion and visibility changes

- User erasure / do-not-contact → tombstone then hard-delete payloads
- GitHub ghost users after account deletion
- Repo removed from the install → wipe trigger for that repo’s private payloads
- Private→public or public→private → re-fetch visibility; do not leak previously private bodies into a public product view
- Deleted comments/reviews via webhook

## Isolation

- Org/install tenant isolation
- No training models on private payloads (lock this as product intent even before there is a model)
- API only; do not scrape HTML contribution graphs

## Tokens

Installation tokens and PATs never persisted in envelopes or logs.

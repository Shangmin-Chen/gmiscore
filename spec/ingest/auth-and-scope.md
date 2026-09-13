# Auth and scope

## Auth

| Mechanism | v1 role |
|---|---|
| GitHub App installation token | **Primary.** Org-centric *or* a user-account App install. Webhooks native. Rate limit is per install. |
| App user-to-server token | Deferred. Intersection of user access and installation — **not** the same as installing the App on a user account. |
| OAuth user token (no App) | Deferred. Needed later if we add personal OSS outside the install. |
| PAT | Local founder demo only. Not a production principal. |

v1 writes on the tin: an org-only score is incomplete relative to the subject’s whole GitHub life. Do not pretend otherwise.

## Visibility

Every envelope records `installation_id`, `auth_kind` (`installation` | `user`), and `visibility` (`public` | `private`).

What a token cannot see does not exist in the store. ETL/Core must see `partial` / missing private — never a confident public-only career.

`user.pullRequests`, Search `author:login`, and `contributionsCollection` are all visibility-filtered. None of them define `repo_set`.

## repo_set

`repo_set` is the list of repository node IDs on this installation that we are allowed to ingest (allowlist, or all repos the install can access).

Ingest walks **repos**, then resources inside them. Attribution to subjects happens because those actors appear on objects in `repo_set`, not because we queried “everything this login ever did.”

## Subjects vs counterparties

- **Subject:** org member who opted in, or the owner of a user-account App install. We intend to score them later. Subjects do not filter GitHub list queries.
- **Counterparty:** reviewer, commenter, merger, mentioned user who is not a subject. Their artifacts are stored because they attach to in-scope objects. They are not a backfill target. Retention and deletion still apply.

Drive-by OSS commenters on an in-scope repo are counterparties unless they opted in.

## Product shapes this forbids

- “Paste a GitHub login, get a score” as v1.
- Mixing two installations’ data without provenance.
- Using calendar `restrictedContributionsCount` as a stand-in for employer repos the App cannot see.

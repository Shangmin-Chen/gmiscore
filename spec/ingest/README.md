# Ingest spec (v1)

GitHub → **this layer** → ETL → Core.

Ingest fetches GitHub data for an explicit scope and persists **immutable envelopes**. It does not decide if someone is a good engineer.

## Why ingest exists

Core’s first path is Output. Output cannot tell “500 doc commits” from real work unless file paths, pre-squash PR commits, raw actors, merge state, and (for later paths) review/comment artifacts are in the raw store. Under-collecting here forces a full re-ingest.

## Boundaries

**May:** authenticate, paginate, retry with backoff, verify webhook signatures, persist envelopes, record watermarks, record auth/visibility, refetch after a webhook, mark runs `partial`.

**Must not:**

- Score, rank, weigh, or classify quality
- Flag `is_docs_only` / generated / “real commit”
- Merge identities or drop bots
- Build an interaction graph or PageRank
- Treat connection `totalCount` or `contributionsCollection` totals as our metrics
- Use webhook bodies as canonical objects
- Use the Events API or Search as a complete backfill
- Store `viewer*` fields
- Fill missing private work with calendar counts

**Must still capture** (so later paths do not re-ingest): file paths + truncation flags, full commit messages, PR merge state machine, author vs committer vs mergedBy vs trailers, CI rollup + per-check name/conclusion, review/comment/thread families, timeline events, repo privacy/fork/head vs base, GitHub’s own bot flags, default-branch commits with `files[]`, `body_stored=false` (v1 metadata-only).

## v1 scope

| In | Out |
|---|---|
| One GitHub App installation | Arbitrary public username scrape |
| Explicit repo allowlist, or all repos on the install | GHES / GHEC |
| Consented org members as **subjects** | Scoring people who never opted in |
| Backfill + webhook incremental + reconciliation poll | Events API as source of truth |
| Time-windowed objects in `repo_set` | Gists, Wikis, Packages, Releases, Discussions, Projects, Sponsors |
| Counterparties incidental to those repos | Recruiter-style “score any login” |

OSS the subject did elsewhere, and previous-employer private work, are **missing**, not zero. Runs must say so.

## Unit of a run

```
IngestRun {
  id
  installation_id
  repo_node_id
  resources[]          # pr, files, commits, reviews, …
  mode                 # backfill | incremental | hydrate
  window_start, window_end
  watermarks
  status               # pending | running | partial | complete | failed
  legal_basis          # consent_user | org_install
  started_at, finished_at
  rate_limit_snapshot
}
```

A run is **not** “backfill this login.” It is **not** filtered by subject. Resume is per `(installation, repo, resource)`. Incomplete `repo_set` is first-class.

List/hydrate details, default-branch walk, webhook allowlist, and App permissions: `fetch.md`.

## Documents in this spec

| File | Contents |
|---|---|
| `auth-and-scope.md` | App vs OAuth vs PAT; subject vs counterparty |
| `fetch.md` | List filters, window predicate, default-branch walk, webhooks, App permissions |
| `objects.md` | MUST / SHOULD / MUST NOT inventory |
| `comments-and-reviews.md` | Comment/review families + timeline |
| `identity.md` | Raw actors, non-merge rule |
| `sync.md` | Backfill, webhooks, watermarks, rate limits |
| `store.md` | Envelope, immutability, tombstones |
| `legal.md` | Consent, bodies, deletion |
| `open-decisions.md` | Deferred items |
| `adversary-tests.md` | Scenarios ingest must still support |

## Success for this stage

Ingest is done when a consented subject’s visible repos can be snapshotted and incrementally updated **without** any score, and the raw store has enough objects that Output (and a future collaboration path) can be specified without adding new GitHub fetches — except deferred items explicitly listed in `open-decisions.md`.

# Sync: backfill, incremental, rate limits

List endpoints, `state=all`, activity window predicate, default-branch walk, webhook allowlist, and App permissions are in `fetch.md`. This file is the operational overlay (pagination, rate limits, watermarks).

## Architecture of fetches

**List-then-hydrate.** One connection / list per query family. Paginate children per PR (files, commits, reviews, comments, timeline) in follow-up calls.

Do not design a single nested GraphQL query of PRs × files × comments. That hits GitHub’s ~500k node cap, ~10s timeout (502/504), and point cost `ceil(fanout/100)`. Nested pagination is not something `gh --paginate` finishes.

Treat GraphQL `errors` alongside `data` as **failure**, not partial success you watermark past.

Account cost via REST `x-ratelimit-*` and GraphQL `rateLimit { cost remaining resetAt }`. Persist a snapshot on the run.

## Backfill

Repo-first, then resource.

- Paginate with stable ordering (`createdAt`/`updatedAt` ascending + `id` tie-break) using GraphQL cursors or REST `Link` headers.
- `first`/`per_page` ≤ 100; prefer 20–50 on heavy nests to avoid timeouts.
- Do **not** use Search as an index of objects.
- Do **not** use `contributionsCollection` as an index of objects.
- Do **not** use the Events API.

Stop conditions that must be **recorded**, not ignored: empty page, 3,000-file cap, 406 diff too large, GraphQL resource limit, 403/429.

A failed PR-files page must not mark that PR complete. Resource-level status. **Never advance a watermark past an incomplete page.**

## Incremental

**Primary:** GitHub App webhooks. Ack fast (<10s). Persist `X-GitHub-Delivery` (idempotent). Then **hydrate** via `node(id:)` or REST GET. Store both the webhook envelope and the refetched canonical object.

GitHub will not make webhook delivery a complete log. A 200 then a crash looks successful to GitHub.

**Secondary:** reconciliation poll per `(installation, repo, resource)`: `updated_at > watermark - overlap`. Hooks drop; polls catch up.

`updated_at` is not monotonic in the way we wish (bots bump issues; some review activity may not bump the field you poll). Overlap window + node-id idempotency are required.

## Hydrate

Mode `hydrate` is a first-class run: webhook delivery id → refetch PR/issue/commit/check. Idempotency key: `(node_id, source=hydrate, delivery_id)`.

Fork PRs: fetch files against the correct repo (base vs head). Deleted head forks will 404; record that rather than failing the whole repo run.

## Idempotency

- Object snapshots: `(github_node_id, fetched_at)`; a “latest” pointer is a projection, not an in-place update of `body`
- Webhooks: unique `X-GitHub-Delivery`
- Do not dedupe humans here

## Rate limits (order of magnitude; treat headers as truth)

- Primary GraphQL points: typically 5,000/hour per user token; App installs often 5,000–12,500
- Secondary: concurrent request caps, GraphQL points/min, REST points/min, CPU time
- Pause, jitter, per-repo concurrency 1–2
- Partial-run resume is required; a full-repo restart after 403 is not a strategy

Events API ETag polling is irrelevant because Events is not a source of truth.

## Pagination details

- GraphQL: `pageInfo { hasNextPage, endCursor }`
- REST: `Link` header, `per_page=100`
- PR files: if `changedFiles` > listed files, set truncated and optionally REST `compare` (SHOULD)

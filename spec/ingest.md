# Ingest (v1)

B2C: an engineer signs in with GitHub and we pull **their** high-signal activity so Core can later score **output** (and other paths). This spec is ingest only. No scores. No ETL.

```
GitHub OAuth  →  GraphQL (viewer)  →  raw JSON on disk/db
```

If a field is not listed here, do not fetch it. If a field is listed here, fetch it exactly as specified. Do not invent a second pipeline (Apps, webhooks, org installs, Search, Events API, REST).

High-signal **objects**, not a copied scoring methodology. Volume filtering, docs-only, and weights belong in Core. File paths on a PR are the **PR diff**, not “lines the viewer authored.” Do not assume opener = author of every line.

---

## Product boundary

| In v1 | Out of v1 |
|---|---|
| The signed-in user scoring themselves | Scoring a stranger / org-wide leaderboard |
| GitHub OAuth App, web flow | GitHub App installations, PATs in production |
| One on-demand snapshot after connect (and later “refresh”) | Webhooks, incremental watermarks |
| The keep-list below that the token can see | Gists, Discussions, Projects, Stars, Followers, traffic, Actions logs, notifications, commits, contribution calendar, CODEOWNERS, Search |

Private work appears only if the user grants `repo` and the token can see that repo. Missing private work is missing, not zero. Do not fill holes with contribution-calendar totals (we do not fetch the calendar).

---

## 1. OAuth

Register a **GitHub OAuth App** (not a GitHub App). Homepage + callback URL are ours.

Credentials live in `.env` (gitignored). Names:

```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=http://127.0.0.1:3000/auth/github/callback
```

`.env.example` is the committed template. Never commit `.env` or the client secret.

### Scopes (exact string)

```
read:user repo
```

- `read:user` — profile + `contributionsCollection` (reviews index only).
- `repo` — GitHub has no read-only private-repo OAuth scope. This token **can** write. We **never** call mutating endpoints (`POST`/`PATCH`/`PUT`/`DELETE` except the OAuth token exchange). We only `POST /graphql`. **No REST.**

If the granted `scope` comes back without `repo`, continue with public-only data and persist `token_scopes` on the run. Do not fail the run.

### Authorize

Browser GET:

```
https://github.com/login/oauth/authorize
  ?client_id={CLIENT_ID}
  &redirect_uri={REDIRECT_URI}
  &scope=read:user%20repo
  &state={CSRF_TOKEN}
```

- `state` is a random unguessable string, stored server-side, TTL ~10 minutes.
- `redirect_uri` must match the OAuth App callback exactly.

### Callback

GitHub redirects to `redirect_uri?code={CODE}&state={STATE}`.

1. Abort if `state` ≠ stored value.
2. `code` expires in 10 minutes. Exchange once:

```
POST https://github.com/login/oauth/access_token
Accept: application/json
Content-Type: application/json

{
  "client_id": "...",
  "client_secret": "...",
  "code": "...",
  "redirect_uri": "{same as authorize}"
}
```

Response (classic, non-expiring unless the app enabled refresh tokens):

```json
{
  "access_token": "gho_...",
  "token_type": "bearer",
  "scope": "read:user,repo"
}
```

If `refresh_token` / `expires_in` are present, store them and refresh via `POST https://github.com/login/oauth/access_token` with `grant_type=refresh_token` before snapshots. If they are absent, the token is long-lived until the user revokes it.

### Token storage

- Store `access_token` (and refresh material) encrypted, keyed by our user id.
- Never log tokens. Never put them in ingest payloads.
- Persist `scope` as granted (user can downgrade scopes).

---

## 2. Calling GitHub

Quota is the **signed-in user’s** GraphQL primary limit (5,000 points/hour), shared with their PATs, `gh`, other OAuth apps. Other gmiscore users do not share this bucket. There is no REST bucket in v1 because there is no REST.

Every API call after OAuth:

```
POST https://api.github.com/graphql
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
Content-Type: application/json
User-Agent: gmiscore
```

Body: `{"query": "<document>", "variables": { ... }}`.

Every query includes this sibling field:

```graphql
rateLimit { cost remaining resetAt }
```

### Concurrency and snapshots

- At most **2** in-flight GraphQL requests.
- One snapshot per user: if a run is already `running` for that user, reject the new start with **HTTP 409**. Do not queue a second run.
- Refresh later = a **new** run after the previous finished. No watermarks. Do not mutate old payloads.

### `first` and batching

- Index lists: **`first: 100`**.
- PR child connections (files, reviews, comments): **`first: 50`**.
- `nodes(ids:)` batches: same `__typename` only, **N ≤ 50**. Nested connections in a batch are **first page only**. Further pages are per id (unique cursors). Do not nest files + comments + reviews in one `nodes()` query.
- A `null` slot or per-node error = that id failed; other ids in the batch still persist.
- Only include GraphQL fragments a document actually spreads (`useAndDefineFragment` otherwise).

### Remaining floor

- **Q1 always runs** (no remaining check).
- After Q1, before each later request: if last known remaining `< 200`, **stop**, mark run `partial`. Do **not** sleep until hourly `resetAt` inside a user-facing snapshot.
- Prefer header `x-ratelimit-remaining` over body `rateLimit.remaining`. After 502/504 remaining is unknown; apply the floor on the next successful header. Extra points GitHub deducts for timeouts still count.

### Error-handler precedence (before cursor / retry)

Classify in this order:

1. **Primary rate limit.** HTTP **200 or 403 or 429**, and (`errors[].type` in `{RATE_LIMITED, RATE_LIMIT}` **OR** `x-ratelimit-remaining == 0`) → stop; Q1 ⇒ run `failed`; later ⇒ `partial`. Do not advance cursor. Do not 2s retry. Do not enter secondary handling.
2. **Q4 1-year VALIDATION.** `type == VALIDATION` and message contains `must not exceed 1 year`: should not happen (always two slices). If it still fires: do not retry as `data == null`; mark that slice failed → `partial`.
3. **Secondary rate limit.** HTTP 200 or 403 or 429, `x-ratelimit-remaining > 0` (header present and nonzero), and error text contains `secondary rate limit` **OR** `You have exceeded a secondary rate limit` **OR** `abuse detection` → wait `Retry-After` if present, else **60s then 120s then 240s** (max 3), then `partial`. Never sleep until `X-RateLimit-Reset`. A 429 with remaining 0 is **primary**, never secondary.
4. **HTTP 200 + `data == null`** (or `nodes == null`) and not (1)–(3): do not advance; retry once after 2s; then that page failed → `partial`.
5. **HTTP 200 + partial `data` + other errors:** persist good nodes; record error paths as per-node failures; **advance cursor**.
6. **502/504 or HTTP 200 timeout/resource-limit:**
   - Index pages: retry once unchanged; then cut `first` in half (min 10) for that connection; if still cannot continue, that family fails → `partial`.
   - HTTP 200 timeout **with nodes** and not RATE_LIMIT: persist good nodes, advance.
   - `nodes(ids:)` 502/504: retry once; then shrink N (halve, min 5).
   - Per-id 502/504: retry once, then fail that id.

### Pagination (index connections)

```
pageInfo { hasNextPage endCursor }
```

Loop: request `after: endCursor` while `hasNextPage`. Stop on empty `nodes`. Persist each page as its own raw record.

**Window cutoff** (per family, see §3): persist the raw page that first contains an out-of-window node; do **not** request the next page; do **not** feed out-of-window nodes into hydrate subsets. Crossing the cutoff is family **success**, not `partial`.

**Index page caps** (stop even if still inside the window): Q2 50 pages, Q3 30 pages, Q5 10 pages, Q4 20 pages **per slice**. Hitting an index page cap ⇒ run `partial`.

No Events API. No Search API. No REST.

---

## 3. Window and what “relevant” means

Budget window, not a quality rule. `started_at` = snapshot start (UTC). `window_start` = `started_at - 365 days` (exact duration 365×24h UTC).

This is a **touched-in-365d** window for PRs (`updatedAt`), not “merged in 365d.” Merge usually bumps `updatedAt`; if it does not, that PR is missed and we do not Search to recover.

| Family | orderBy | Stop paging when | Index page cap |
|---|---|---|---|
| Authored PRs (Q2) | `UPDATED_AT DESC` | node `updatedAt < window_start` | 50 |
| Their issueComments (Q3) | `UPDATED_AT DESC` only (GitHub has no `CREATED_AT`) | node `updatedAt < window_start` | 30 |
| Reviews index (Q4) | two `contributionsCollection` slices covering the window; contrib `orderBy: { direction: DESC }` | slice `from`/`to`; do not page all `contributionYears` | 20 per slice |
| Authored issues (Q5) | `CREATED_AT DESC` | node `createdAt < window_start` | 10 |

Do not unify cutoff fields in code.

### Keep vs drop

| Keep | Why | Index | Hydrate |
|---|---|---|---|
| Profile | who this snapshot is | Q1 | — |
| PRs they opened | output they put in front of people | Q2 | Q6 + Q7 on `hydrate_pr_ids` |
| Comments they wrote (issues and PRs) | interaction | Q3 | Q12 fallback if needed |
| Reviews they submitted | interaction | Q4 stripped | Q13 on `q13_pr_ids` |
| Issues they opened | secondary | Q5 | — |
| Conversation comments **on their merged PRs** | other people talking on their work (not reviews) | — | Q9 first page on `q9_pr_ids` |

Drop: PR commits (old Q8), reviews received (old Q10), review threads (old Q11), default-branch commit history + REST (old Q14), `contributionCalendar`, `commitContributionsByRepository`, `issues(filterBy: { mentioned })`, CODEOWNERS, stars, followers, gists, discussions, projects, traffic, notifications, Actions logs.

There is no `viewer.reviews` connection. The reviews index **must** stay as stripped Q4 (`pullRequestReviewContributions`). Q4’s `pullRequestReview` is **latest in that slice only**; Q13 is the full keep for reviews they wrote.

---

## 4. Queries

Copy these documents. Page with `$after`. Include only the fragments a document spreads.

### Shared fragments

```graphql
fragment Actor on Actor {
  __typename
  login
  ... on User { id databaseId }
  ... on Bot { id databaseId }
  ... on EnterpriseUserAccount { id }
  ... on Mannequin { id databaseId }
  ... on Organization { id databaseId }
}

fragment Page on PageInfo {
  hasNextPage
  endCursor
}
```

`GitActor` is **not used** in v1 (no commit queries). Do not define it on documents.

### Q1 — Profile (once)

```graphql
query ViewerProfile {
  viewer {
    id
    databaseId
    login
    name
    email
    createdAt
  }
  rateLimit { cost remaining resetAt }
}
```

Ingest run key is `viewer.databaseId` (fallback `id` if null). `$login` for later queries is `viewer.login` (string, **no** `@`).

### Q2 — PRs they opened

```graphql
query ViewerPullRequests($after: String) {
  viewer {
    pullRequests(
      first: 100
      after: $after
      states: [OPEN, CLOSED, MERGED]
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { ...Page }
      nodes {
        id
        number
        url
        title
        state
        isDraft
        merged
        mergedAt
        closedAt
        createdAt
        updatedAt
        additions
        deletions
        changedFiles
        baseRefName
        headRefName
        repository { id nameWithOwner isPrivate isFork }
        author { ...Actor }
        mergedBy { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

No `body`, no `labels` on this list query (`states` must be all three). Stop on window cutoff as §3.

### Q3 — Conversation comments they wrote

```graphql
query ViewerIssueComments($after: String) {
  viewer {
    issueComments(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { ...Page }
      nodes {
        id
        createdAt
        updatedAt
        body
        author { ...Actor }
        url
        issue {
          id
          number
          title
          url
          repository { id nameWithOwner owner { login } name isPrivate }
        }
        pullRequest {
          id
          number
          url
          author { ...Actor }
          repository { id nameWithOwner isPrivate }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Keep `body`. `IssueComment.issue` is always typed `Issue` even when the conversation is a PR. `pullRequest` is nullable. Do **not** extra-filter `author.login`. Persist as returned (bots, minimized, null authors).

Q12 only if `pullRequest == null` **AND** `issue.url` contains `/pull/` (not the comment `url`).

### Q4 — Reviews index (two window slices, nothing else)

`contributionsCollection(from, to)` span **must not exceed 1 year**. Never send a 365-day span.

Always exactly two slices (do not try one slice first):

- `mid = window_start + 364 days`
- Slice A: `from = window_start`, `to = mid`
- Slice B: `from = mid`, `to = started_at`

Q4 `to` uses our `started_at`, not GitHub `endedAt`. Inclusive overlap at `mid`; dedupe `pullRequest.id` keeping max `occurredAt`. Do not use calendar-year Jan 1–Dec 31 bounds. Do not query `contributionYears` for full history. Do not query `contributionCalendar` or `commitContributionsByRepository`.

```graphql
query ReviewContribSlice($from: DateTime!, $to: DateTime!, $reviewAfter: String) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      startedAt
      endedAt
      restrictedContributionsCount
      pullRequestReviewContributions(
        first: 100
        after: $reviewAfter
        orderBy: { direction: DESC }
      ) {
        pageInfo { ...Page }
        nodes {
          occurredAt
          isRestricted
          pullRequest { id number url author { ...Actor } }
          pullRequestReview { id state submittedAt }
          repository { id nameWithOwner }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Nodes are `CreatedPullRequestReviewContribution` only. Do **not** use a `RestrictedContribution` fragment (schema error). `restrictedContributionsCount` is collection metadata, not a per-node skip.

Skip Q13 (`hydrate_skipped: restricted` on the **Q4 row**, not a Q2 reason) when `isRestricted == true` **OR** `pullRequest.id` is missing after per-node errors. Those nodes never enter `q13_pr_ids`.

### Q5 — Issues they opened

```graphql
query ViewerIssues($after: String, $login: String!) {
  viewer {
    issues(
      first: 100
      after: $after
      states: [OPEN, CLOSED]
      filterBy: { createdBy: $login }
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo { ...Page }
      nodes {
        __typename
        id
        number
        url
        title
        state
        createdAt
        closedAt
        updatedAt
        repository { id nameWithOwner isPrivate }
        author { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

`$login` is Q1 `viewer.login`. Stop on `createdAt < window_start`. After persisting the raw page, drop a node from **hydrate/index sets** (not from the stored payload) if `__typename != Issue` or `url` contains `/pull/`. Dropped nodes are not a per-id failure. Do not also require `author.login` match.

---

## 5. Hydrate subsets and documents

Declared subset ids are ids we **will** call. Named in run metadata: `hydrate_pr_ids`, `q9_pr_ids`, `q13_pr_ids`, plus Q12 fallback ids.

Envelope flags live on **our row metadata**. GitHub `payload` is never edited.

Skip reasons (envelope): `draft`, `closed_unmerged`, `cap`, `restricted`. `restricted` is Q4/Q13 only.

### `hydrate_pr_ids` (from Q2)

Q2 cutoff page: persist raw. Do **not** feed nodes with `updatedAt < window_start` into the 300.

Eligible: in-window (`updatedAt >= window_start`) AND `!isDraft` AND (`merged` OR `state == OPEN`).

1. Group merged: sort `mergedAt DESC`, tie `number DESC`.
2. Group OPEN: sort `updatedAt DESC`, tie `number DESC`.
3. Concatenate merged then OPEN; take ≤300 → `hydrate_pr_ids`.

Drafts (including merged drafts) and CLOSED unmerged never enter: envelope `hydrate_skipped: draft | closed_unmerged` on the index interpretation, not a failed hydrate. In-window eligible PRs after slot 300: index kept, `hydrate_skipped: cap`, **not** in `hydrate_pr_ids`. A missing Q7 payload means skip/fail as metadata says — never “empty diff.”

`q9_pr_ids` = members of `hydrate_pr_ids` that are `merged && !isDraft`.

### `q13_pr_ids` (from Q4)

1. Drop `isRestricted == true` and nodes with missing `pullRequest.id`.
2. Dedupe by `pullRequest.id` keeping max `occurredAt`.
3. Take ≤300 (already newest-first if we sorted by `occurredAt` DESC after dedupe).

Restricted nodes never enter the declared subset.

### Q6 — PR core (`nodes(ids:)`, no files)

For `hydrate_pr_ids`, batches of ≤50:

```graphql
query PrCoreBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      number
      url
      title
      state
      isDraft
      merged
      mergedAt
      closedAt
      createdAt
      updatedAt
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      body
      reviewDecision
      mergeCommit { oid }
      statusCheckRollup { state }
      labels(first: 20) {
        pageInfo { hasNextPage }
        nodes { name }
      }
      repository { id nameWithOwner isPrivate isFork }
      author { ...Actor }
      mergedBy { ...Actor }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

`labels(first: 20)` is a nested connection: capped first page. If `labels.pageInfo.hasNextPage`, envelope `labels_truncated: true`. Do not page labels further. `statusCheckRollup { state }` only — no nested contexts. Q6 success = PR payload persisted (`labels_truncated` is **not** run `partial`).

### Q7 — Files

Page-1 via `nodes(ids:)` N≤50; pages 2–20 per id.

```graphql
query PrFiles($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      changedFiles
      files(first: 50, after: $after) {
        totalCount
        pageInfo { ...Page }
        nodes { path additions deletions changeType }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Batch page-1 uses the same `files(first: 50)` selection inside `nodes(ids:)` (no `$after` on the batch). Max **20 pages** per PR (1000 files) then stop with envelope `files_truncated: true` even if `hasNextPage`. Also `files_truncated: true` if `files.totalCount < changedFiles` after pages end. No `previousFilename`; do not treat `changeType` as a rename map.

**Global extra-page budget:** after all Q7 page-1 batches, at most **200** additional per-id file pages for the whole run; remaining PRs in the subset still get a success payload with `files_truncated: true`. That is **not** run `partial`.

Q7 family success (not `partial`) when paging stops on empty, `totalCount < changedFiles`, the 20-page cap, or the global extra-page budget.

### Q9 — Conversation comments on their merged PRs (first page only)

`nodes(ids:)` N≤50 on `q9_pr_ids`. No page 2+.

```graphql
query PrCommentsBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      comments(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage }
        nodes {
          id
          createdAt
          updatedAt
          body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

This is `IssueComment` conversation, **not** reviews, **not** inline comments. May include the viewer’s own comments; persist them. Envelope `q9_comments_truncated` if `hasNextPage`. First-page-only with `hasNextPage` true does **not** make the run `partial`.

### Q12 — PR stub fallback

Only if Q3 `pullRequest == null` AND `issue.url` contains `/pull/`. Unique `(owner, name, number)` not already in the Q2 id set.

`$owner` / `$name` from `issue.repository` (`owner.login` + `name`, or split `nameWithOwner`). `$number` = `issue.number`.

```graphql
query IssueOrPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      url
      title
      state
      merged
      mergedAt
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

If `pullRequest` is null, it was a plain issue — keep the Q3 comment, skip PR hydrate. If it is a PR they did not open, persist this stub only (no files). Their comment is already in Q3. Q12 needed and failed ⇒ run `partial`.

### Q13 — Reviews they wrote

For `q13_pr_ids`. Page-1 of `reviews` may be `nodes(ids:)` N≤50; pages 2+ of reviews and extra review-comment pages are per id.

```graphql
query ReviewsByAuthor($id: ID!, $login: String!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      id
      number
      url
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
      reviews(
        first: 50
        after: $after
        author: $login
        states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]
      ) {
        pageInfo { ...Page }
        nodes {
          id
          state
          submittedAt
          body
          author { ...Actor }
          commit { oid }
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              id
              createdAt
              path
              originalCommit { oid }
              body
              author { ...Actor }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Always pass `states` as above. `PENDING` is never stored. `$login` is Q1 `viewer.login`. Max **20** review pages per PR then envelope `q13_reviews_truncated` (not run `partial`). If a review’s `comments.pageInfo.hasNextPage`, page that review with `node(id: $reviewId)` max **10** extra comment pages then `q13_review_comments_truncated`. Ghost/null author stored as null. Bots stored as returned.

---

## 6. Run + store

```
IngestRun {
  github_user_id     # viewer.databaseId
  github_login
  token_scopes
  status             # running | complete | partial | failed
  started_at, finished_at
  window_start
  hydrate_pr_ids     # declared subset
  q9_pr_ids
  q13_pr_ids
}
```

Each GitHub response is one immutable row:

```
{
  ingest_run_id,
  fetched_at,
  query_name,          # Q1–Q7, Q9, Q12, Q13 (no Q8/Q10/Q11/Q14)
  variables,
  http_status,
  payload,             # JSON as returned; never edited
  metadata             # envelope only: truncated flags, hydrate_skipped, per-node failures
}
```

There is no `not_a_signal` calendar path. Never write `score`, `is_docs_only`, merged identity, or graph edges. `totalCount` in a payload is GitHub pagination metadata, not our metric. Bots, minimized comments, and null authors: persist as GitHub returned.

### Status

| Outcome | When |
|---|---|
| **failed** | Q1 failed for any reason, including primary RATE_LIMIT on Q1 |
| **partial** | After Q1: primary RATE_LIMIT; remaining-floor stop; **index** page cap (Q2 50 / Q3 30 / Q5 10 / Q4 20 per slice); per-id/per-node failure; secondary retries exhausted; Q12 needed and failed |
| **complete** | Q1 ok; every **index** family (Q2, Q3, Q4, Q5) ended by empty page or window cutoff; every id in declared subsets got a success payload |

These do **not** make the run `partial`: Q9 first-page-only (`hasNextPage` true); Q6 `labels_truncated`; Q7 20-page cap, `totalCount < changedFiles`, or global extra-page budget (`files_truncated`); Q13 review/comment page caps.

Per-id failure ⇒ `partial`, even if recorded. Hitting window cutoff = that family **success**.

---

## 7. Order of operations

Indexes before hydrate so file paging cannot starve Q3/Q4.

1. OAuth → store token.
2. Q1. If this fails, the run fails.
3. Q2 index (window + page cap).
4. Q4 both slices (index).
5. Q5 (window + page cap).
6. Q3 (window + page cap).
7. Compute `hydrate_pr_ids`, `q9_pr_ids`, `q13_pr_ids`.
8. Q6 for `hydrate_pr_ids`.
9. Q13 for `q13_pr_ids`.
10. Q7 files for `hydrate_pr_ids`.
11. Q9 for `q9_pr_ids`.
12. Q12 fallback from Q3.
13. Mark run `complete` / `partial`.

If remaining `< 200` at any step after Q1, stop `partial`. Families later in the list may be empty.

Max 2 in-flight GraphQL requests (batch hydrates may run two batches at a time; do not fire 20 parallel queries).

---

## 8. Out of scope until a later spec

ETL, Core, Output formula, path combiner, webhooks, GitHub Apps, org installs, identity linking, classifying docs vs code, comment-graph weights, CODEOWNERS, mentioned-issues query, commits, contribution calendar, Search, REST, weave-style percentile ranking.

---

## 9. Implementer checklist

- [ ] OAuth authorize + callback + token exchange exactly as §1
- [ ] Token encrypted; mutating GitHub APIs unused; **no REST**
- [ ] Documents Q1–Q7, Q9, Q12, Q13 as written; `first` values as written
- [ ] Fragments only if used
- [ ] `states: [OPEN, CLOSED, MERGED]` on pullRequests
- [ ] Q4 always two slices; `orderBy: { direction: DESC }`; `isRestricted`; no calendar, no commits, no `RestrictedContribution` fragment
- [ ] Window cutoffs per family; index page caps; remaining floor 200; error-handler precedence
- [ ] `nodes(ids:)` N≤50, first nested page only; per-node errors persist+advance
- [ ] Hydrate subsets as §5; skip reasons in envelope; payload never edited
- [ ] Q5 `$login` + `CREATED_AT` + `createdBy`
- [ ] Q9 `UPDATED_AT DESC` first page only on merged non-drafts
- [ ] Q13 `states` exclude PENDING; caps are envelope not `partial`
- [ ] Q12 only if `pullRequest == null` and `issue.url` contains `/pull/`
- [ ] Concurrent snapshot → 409
- [ ] No Search, no Events, no scores, no `is_docs_only`

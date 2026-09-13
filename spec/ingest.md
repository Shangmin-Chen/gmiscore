# Ingest (v1)

B2C: an engineer signs in with GitHub and we pull **their** activity so Core can later score **output** (and other paths). This spec is ingest only. No scores. No ETL.

```
GitHub OAuth  →  GraphQL (viewer)  →  raw JSON on disk/db
```

If a field is not listed here, do not fetch it. If a field is listed here, fetch it exactly as specified. Do not invent a second pipeline (Apps, webhooks, org installs, Search, Events API).

---

## Product boundary

| In v1 | Out of v1 |
|---|---|
| The signed-in user scoring themselves | Scoring a stranger / org-wide leaderboard |
| GitHub OAuth App, web flow | GitHub App installations, PATs in production |
| One on-demand snapshot after connect (and later “refresh”) | Webhooks, incremental watermarks |
| Everything below that the token can see | Gists, Discussions, Projects, Stars, Followers, traffic, Actions logs |

Private work appears only if the user grants `repo` and the token can see that repo. Missing private work is missing, not zero. Do not fill holes with contribution-calendar totals.

---

## 1. OAuth

Register a **GitHub OAuth App** (not a GitHub App). Homepage + callback URL are ours.

### Scopes (exact string)

```
read:user repo
```

- `read:user` — profile + private contribution counts on `contributionsCollection`.
- `repo` — GitHub has no read-only private-repo OAuth scope. This token **can** write. We **never** call mutating endpoints (`POST`/`PATCH`/`PUT`/`DELETE` except the OAuth token exchange). We only `POST /graphql` and `GET` REST for commit files.

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

Rules:

- `first` is 1–100. Use **`first: 100`** on index lists, **`first: 50`** on PR child connections (files/commits/reviews/comments/threads).
- One paginated connection per request. Do not nest “PRs + files + reviews + comments” in one query.
- If `errors` is non-empty, that page **failed**. Retry once after 2s. Do not advance the cursor. After a second failure, mark that resource `failed` and continue other resources.
- If `rateLimit.remaining < 100`, sleep until `resetAt`.
- HTTP 403/429: sleep until `X-RateLimit-Reset` (unix seconds) or `Retry-After`, then retry.
- GitHub node cap / timeout (502, 504): retry the same page once; if it still fails, cut `first` in half (min 10) for that connection.

### Pagination (every connection)

```
pageInfo { hasNextPage endCursor }
```

Loop: request `after: endCursor` while `hasNextPage`. Stop on empty `nodes`. Persist each page as its own raw record.

### REST exception (commit file lists only)

GraphQL `Commit` has no files connection. For default-branch commits we already listed, also:

```
GET https://api.github.com/repos/{owner}/{repo}/commits/{sha}
Authorization: Bearer {access_token}
Accept: application/vnd.github+json
User-Agent: gmiscore
```

Save the JSON. If `files` is missing/truncated, still save the response (do not invent files).

No other REST. No Events API. No Search API.

---

## 3. What “relevant” means

Pull these families for `viewer`. That is the whole ingest.

| Family | Why | Index | Hydrate |
|---|---|---|---|
| Profile | who this snapshot is | Q1 | — |
| PRs they opened | output | Q2 `viewer.pullRequests` | Q6–Q11 |
| Comments they left on issues/PRs (including **other people’s PRs**) | interaction | Q3 `viewer.issueComments` | Q3 already has the node; Q12 if `issue` is a PR and we lack PR core |
| Reviews they submitted | interaction | Q4 year slices `pullRequestReviewContributions` | Q13 |
| Commits they authored on PRs | pushed code | via Q8 | — |
| Commits they pushed to default branches | pushed code without a PR | Q4 `commitContributionsByRepository` | Q14 + REST files |
| Issues they opened | secondary | Q5 `viewer.issues` | — |
| GitHub’s own contribution calendar | contrast only, **not a score** | Q4 | — |

Do not fetch: stars, followers, gists, discussions, projects, traffic, notifications, org audit log, check logs.

---

## 4. Queries

Copy these documents. Page with `$after`.

### Shared fragments (include in every document that needs them)

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

fragment GitActor on GitActor {
  name
  email
  date
  user { id databaseId login }
}

fragment Page on PageInfo {
  hasNextPage
  endCursor
}
```

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

Ingest run key is `viewer.databaseId` (fallback `id` if null).

### Q2 — PRs they opened (page until done)

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

`viewer.pullRequests` is the user’s opened PRs, all time, visibility-filtered by the token. `states` must be all three — GitHub’s default is not “everything.”

### Q3 — Conversation comments they wrote (issues and PRs)

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
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

This is how we get comments on **other people’s PRs**. Keep `body`. `IssueComment.issue` is always typed `Issue` even when the conversation is a PR (PRs are issues). After each page, for unique `(owner, name, number)` whose comment `url` or follow-up pull lookup succeeds, record the PR (Q12). Do not guess from `__typename`.

### Q4 — Year slices (reviews index + commit-repo index + calendar)

GitHub: `contributionsCollection(from, to)` span **must not exceed 1 year**. Default is the last year.

First, years:

```graphql
query ContributionYears {
  viewer {
    contributionsCollection {
      contributionYears
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Then, for each `year` in `contributionYears`:

- `from = "{year}-01-01T00:00:00Z"`
- `to   = "{year}-12-31T23:59:59Z"`
- If GitHub returns “must not exceed 1 year”, retry that year with `to = "{year}-12-30T23:59:59Z"`.

```graphql
query ContribYear($from: DateTime!, $to: DateTime!, $reviewAfter: String) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      startedAt
      endedAt
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner owner { login } name isPrivate }
        contributions(first: 1) {
          totalCount
        }
      }
      pullRequestReviewContributions(first: 100, after: $reviewAfter) {
        pageInfo { ...Page }
        nodes {
          occurredAt
          pullRequest { id number url }
          pullRequestReview { id state submittedAt }
          repository { id nameWithOwner }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

`maxRepositories` **must be 100**. Default is 25.

Page **only** `pullRequestReviewContributions` (pass `$reviewAfter`). `commitContributionsByRepository` is not a cursor connection; 100 repos is GitHub’s cap for that field. Persist the calendar JSON with a flag `not_a_signal` in our envelope metadata — never feed it to a path as a feature.

`pullRequestReviewContributions` returns the **latest review per PR in that year**. That is why Q13 re-hydrates all reviews by this author on that PR.

### Q5 — Issues they opened

```graphql
query ViewerIssues($after: String) {
  viewer {
    issues(
      first: 100
      after: $after
      states: [OPEN, CLOSED]
      orderBy: { field: UPDATED_AT, direction: DESC }
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
        repository { id nameWithOwner isPrivate }
        author { ...Actor }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Drop the node if `__typename != Issue` or `url` contains `/pull/` (those PRs already come from Q2).

---

## 5. Hydrate (per id, separate requests)

After Q2, for **each** PR `id`:

### Q6 — PR core (if the list page omitted a field, still fine to re-fetch)

Use `node(id: $id)` with the Q2 PR fields plus:

```graphql
... on PullRequest {
  body
  reviewDecision
  mergeCommit { oid }
  statusCheckRollup { state }
}
```

### Q7 — Files (Output needs paths)

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

If `files.totalCount < changedFiles` after `hasNextPage` is false, persist `truncated: true`. GraphQL files have no patch and no previous filename. That is acceptable for v1.

### Q8 — PR commits (pre-squash SHAs)

```graphql
query PrCommits($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      commits(first: 50, after: $after) {
        totalCount
        pageInfo { ...Page }
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            authoredDate
            committedDate
            author { ...GitActor }
            committer { ...GitActor }
            additions
            deletions
            changedFilesIfAvailable
            parents { oid }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

Always request `messageBody` (co-author trailers, reverts). Use `changedFilesIfAvailable`, never `changedFiles` (it can throw).

### Q9 — Conversation comments **on their PR** (what others said)

```graphql
query PrComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      comments(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id createdAt updatedAt body
          author { ...Actor }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

### Q10 — Reviews on their PR (reviews they received)

```graphql
query PrReviews($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviews(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id state submittedAt body
          author { ...Actor }
          commit { oid }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

### Q11 — Review threads on their PR

```graphql
query PrThreads($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 50, after: $after) {
        pageInfo { ...Page }
        nodes {
          id isResolved isOutdated path line
          comments(first: 50) {
            nodes {
              id createdAt body
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

If a thread’s `comments.pageInfo.hasNextPage` is true, page that thread’s comments with a follow-up `node(id: $threadId)` query. Do not silently stop at 50.

### Q12 — PR stub for comments on other people’s PRs

From Q3, unique `(owner, repo, number)` that are **not** already in the Q2 set. Resolve PR vs issue:

```graphql
query IssueOrPr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number url title state merged mergedAt
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

If `pullRequest` is null, it was a plain issue — keep the Q3 comment, skip PR hydrate. If it is a PR they did not open, persist this stub only (no files/commits). Their comment is already in Q3.

### Q13 — Reviews they wrote (all reviews by them on that PR)

From the unique `pullRequest.id` set in Q4:

```graphql
query ReviewsByAuthor($id: ID!, $login: String!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      id number url
      author { ...Actor }
      repository { id nameWithOwner isPrivate }
      reviews(first: 50, after: $after, author: $login) {
        pageInfo { ...Page }
        nodes {
          id state submittedAt body
          author { ...Actor }
          commit { oid }
          comments(first: 50) {
            pageInfo { ...Page }
            nodes {
              id createdAt path originalCommit { oid } body
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

`$login` is `viewer.login` from Q1. Page reviews, then page `comments` on any review with `hasNextPage`.

### Q14 — Default-branch commits they authored

From unique repositories in Q4 `commitContributionsByRepository`:

```graphql
query RepoAuthorHistory($owner: String!, $name: String!, $authorId: ID!, $after: String) {
  repository(owner: $owner, name: $name) {
    id
    nameWithOwner
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(first: 50, after: $after, author: { id: $authorId }) {
            pageInfo { ...Page }
            nodes {
              oid
              messageHeadline
              messageBody
              authoredDate
              committedDate
              author { ...GitActor }
              committer { ...GitActor }
              additions
              deletions
              changedFilesIfAvailable
              associatedPullRequests(first: 5) {
                nodes { id number url }
              }
            }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

`$authorId` is `viewer.id` from Q1.

Then REST `GET .../commits/{sha}` for each oid (file paths). Skip REST if Q8 already stored that oid as a PR commit.

If `defaultBranchRef` is null or the query 404s, persist the error on that repo and continue.

---

## 6. Run + store

```
IngestRun {
  github_user_id     # viewer.databaseId
  github_login
  token_scopes
  status             # running | complete | partial | failed
  started_at, finished_at
}
```

Each GitHub response is one immutable row:

```
{
  ingest_run_id,
  fetched_at,
  query_name,          # Q1…Q14 or "rest_commit_files"
  variables,
  http_status,
  payload,             # JSON as returned; never edited
  not_a_signal         # true only for contributionCalendar pages
}
```

Never write `score`, `is_docs_only`, merged identity, or graph edges. `totalCount` in a payload is GitHub pagination metadata, not our metric.

A run is `complete` when Q1–Q5 finished paging and every hydrate from those indexes finished or recorded a per-id failure. Any per-id failure ⇒ `partial`.

Refresh later = a **new** run. Do not mutate old payloads.

---

## 7. Order of operations

1. OAuth → store token.
2. Q1. If this fails, the run fails.
3. Q2, Q3, Q4 (all years), Q5 — these are independent; run sequentially to stay under secondary rate limits (do not fire 20 parallel GraphQL queries).
4. Unique PR ids from Q2 → Q6–Q11.
5. Q3 PR ids not in Q2 → Q12.
6. Unique review-PR ids from Q4 → Q13.
7. Unique commit repos from Q4 → Q14 + REST files.
8. Mark run complete/partial.

---

## 8. Out of scope until a later spec

ETL, Core, Output formula, path combiner, webhooks, GitHub Apps, org installs, identity linking, classifying docs vs code, comment-graph weights.

---

## 9. Implementer checklist

- [ ] OAuth authorize + callback + token exchange exactly as §1
- [ ] Token encrypted; mutating GitHub APIs unused
- [ ] Q1–Q14 documents as written; `first` values as written
- [ ] `states: [OPEN, CLOSED, MERGED]` on pullRequests
- [ ] `commitContributionsByRepository(maxRepositories: 100)`
- [ ] Year loop uses `contributionYears`; handles the 1-year GitHub error
- [ ] One connection paged per request; cursor not advanced on `errors`
- [ ] Issue comments keep `body`; PR vs issue via Q12 `pullRequest(number:)` (not `__typename` on `issue`)
- [ ] Authored PRs hydrate files + commits + received reviews/comments/threads
- [ ] Reviews they wrote hydrated via `reviews(author: viewer.login)`
- [ ] Default-branch author history + REST file lists
- [ ] Calendar stored as `not_a_signal`
- [ ] No Search, no Events, no scores

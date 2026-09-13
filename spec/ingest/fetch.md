# Fetch contract

How ingest lists and hydrates objects. Do not invent a second job model.

## Do not subject-filter list queries

Walk **every** matching object in the repo, then attribute later.

Wrong: `author:subject`, `user.pullRequests(login:)`, Search `author:login`, GraphQL `contributionsCollection` as the index.

Right: repo lists (`state=all` / all GraphQL states), then hydrate children.

A subject is who Core may score. A subject is **not** a GitHub list filter. Filtering lists by subject misses reviews and comments on other people’s PRs (adversary test 5).

## Time-window predicate (locked)

Window **length** is still D2. The **predicate** is not.

An object is in-window if **any** of these timestamps fall in `[window_start, window_end]`:

- `createdAt`, `updatedAt`, `closedAt`, `mergedAt`
- commit `authoredDate` / `committedDate`
- review `submittedAt`

Plus: still-open PRs/issues created before `window_end` whose `updatedAt` is inside the window (already covered by `updatedAt`).

**Do not** use `createdAt >= window_start` alone. A two-year-old PR merged yesterday would be dropped.

Until D2 is chosen, implementers must take `window_start` / `window_end` as run parameters, not a hardcoded 90 days.

## List endpoints and state filters

GitHub’s default list is often **open only**. Always request all states.

| Resource | List (minimum) |
|---|---|
| Pull requests | REST `GET /repos/{o}/{r}/pulls?state=all&sort=updated` and/or GraphQL `pullRequests(states: [OPEN, CLOSED, MERGED])` |
| Issues | REST `GET /repos/{o}/{r}/issues?state=all` (this **includes** PRs — keep `pull_request` key / skip by `__typename`) and/or GraphQL `issues(states: [OPEN, CLOSED])` with Issue type only |
| PR files | REST `GET /repos/{o}/{r}/pulls/{n}/files` (paginate; cap 3000) |
| PR commits | REST `GET .../pulls/{n}/commits` or GraphQL `PullRequest.commits` |
| Reviews | REST `GET .../pulls/{n}/reviews` |
| Review comments | REST `GET .../pulls/{n}/comments` or repo-wide `GET .../pulls/comments` |
| Issue comments | REST `GET .../issues/{n}/comments` or repo-wide `GET .../issues/comments` |
| Timeline | GraphQL `timelineItems` or REST `GET .../issues/{n}/events` |
| Checks | GraphQL `statusCheckRollup` on the PR head / commit; REST check-runs / check-suites on the SHA |

## Default-branch commits (MUST, with a real walk)

These are not “whatever falls out of PR hydrate.”

**List:** REST `GET /repos/{o}/{r}/commits?sha={defaultBranch}&since={window_start}` and/or GraphQL `ref(qualifiedName: "refs/heads/{default}").target.history(since:)` walking pages until `window_start`.

**Hydrate each SHA:** REST `GET /repos/{o}/{r}/commits/{sha}` so `files[]` (path, previous_filename, status, additions, deletions, patch or omitted) is stored. Same truncation rules as PR files. GraphQL `Commit.changedFilesIfAvailable` is not a file list.

**Incremental:** `push` webhook on the default branch → hydrate new SHAs. Reconciliation poll: `since=watermark - overlap` on the default branch.

Merge commits that landed via PR appear here **and** as `PullRequest.mergeCommit`. Store both snapshots; do not drop one family.

If the default branch cannot be listed (empty repo, 409, no Contents permission), the run is `partial` with a recorded reason — not `complete`.

## Webhook allowlist (App)

Subscribe at least:

- `pull_request`
- `pull_request_review`
- `pull_request_review_comment`
- `issue_comment`
- `issues`
- `push`
- `commit_comment`
- `check_suite`, `check_run`
- `installation`, `installation_repositories`
- `repository` (renamed, archived, transferred, publicized, privatized)
- `delete` (refs)
- `membership` or org member events if used to maintain subject eligibility

Every delivery: verify signature, persist envelope, ack, **hydrate**. `installation_repositories` added/removed updates `repo_set` and can trigger wipe (see `legal.md`).

## GitHub App permissions (read)

Minimum repository permissions:

- Metadata
- Contents
- Pull requests
- Issues
- Checks
- Commit statuses

Organization: Members (read) — to know who can opt in, not to scrape the org.

Missing Contents → no commit files / default-branch history. Missing Checks → no rollup. A run that lacked a permission is `partial`, never silent `complete`.

## Checks (locked)

MUST: `statusCheckRollup` + per-check **name + conclusion**. NOT logs, annotations, or artifacts.

## Bodies (locked for v1)

v1 is **metadata-only**. Persist `body_stored=false` on provenance for comment/review/issue objects. Do not invent bodies later as if they were fetched. A future bodies backfill is a new hydrate mode.

# Object inventory

Persist GitHub objects as envelopes. Field lists below are the **minimum we must request/store**. Extra GitHub fields in the payload may be kept; we must not drop the listed ones.

GraphQL global `id`, REST `node_id`, and `databaseId` are stored whenever GitHub provides them.

## MUST (v1)

### Actor

`User` | `Bot` | `Mannequin` | `Organization` | **`Team`** as they appear on objects.

- `__typename` / REST `type`
- `databaseId`, `login` (or Team `slug` / `name` / `combinedSlug` as GitHub provides)
- `isBot` when present
- `app { id, slug, name }` when Bot

Teams are requested reviewers (CODEOWNERS). Do not flatten a Team into a User. Do not filter bots out.

### Repository

- `id`, `nameWithOwner`, `databaseId`
- `isPrivate`, `isFork`, `isArchived`
- `parent` (if fork)
- `owner` (Actor)
- `defaultBranchRef { name, target { oid } }`

### PullRequest

- number, `id`, `url`
- `state`, `isDraft`, `merged`, `mergedAt`, `closedAt`, `createdAt`, `updatedAt`
- `title` (v1: store title; PR/issue **body** follows D1 — metadata-only, `body_stored=false`)
- `baseRefName`, `headRefName`
- `baseRepository`, `headRepository`
- `additions`, `deletions`, `changedFiles` (raw GitHub fields, not our metrics)
- `reviewDecision`
- `mergeCommit { oid }`
- `author`, `mergedBy`
- `commits.totalCount` (pagination metadata in the payload — not a feature)

Also persist fork/cross-repo: `isCrossRepository` / head ≠ base.

### PR files

Primary: REST `GET /repos/{owner}/{repo}/pulls/{number}/files`.

- `filename` / path, `previous_filename`, `status`
- `additions`, `deletions`, `changes`, `sha`
- `patch` **or** explicit `patch_omitted` in provenance/enrichment-outside-body (prefer recording omission next to the envelope without mutating GitHub’s JSON)
- Truncation: REST caps at **3,000 files**; large diffs **406**. Record `truncated_by_api` / HTTP status. Compare listed files vs PR `changedFiles`.

GraphQL `PullRequestChangedFile` may be stored as a second snapshot (`path`, `additions`, `deletions`, `changeType`) but it is **not** a substitute: no patch, no previous filename, no blob sha.

### PR commits and Commit

PR commits: GraphQL `PullRequest.commits` or REST `GET .../pulls/{n}/commits` — **pre-merge SHAs**.

Also: merge commit (if merged) and **default-branch commits** in `repo_set` (direct pushes and merge commits on the default ref). These are separate families in the store, not one flattened list. The walk and per-SHA `files[]` hydrate are specified in `fetch.md` — oid+message without files is incomplete.

For each `Commit`:

- `oid`, `parents { oid }`
- `messageHeadline` + `messageBody` (full message is required: `Co-authored-by`, `Signed-off-by`, `Revert`, squash trailers)
- `authoredDate`, `committedDate`
- `author` and `committer` as GitActor: `name`, `email`, `date`, `user { id, databaseId, login, __typename } | null`
- `additions` / `deletions` / `changedFilesIfAvailable` (do not rely on `changedFiles`; it can throw)
- **files[]** from REST commit hydrate: path, previous_filename, status, additions, deletions, patch or `patch_omitted`, truncation flags

### PullRequestReview

- `state`: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING (store PENDING if GitHub returns it; it is not submitted)
- `author`, `submittedAt`, `commit.oid`, `body` or bodies-absent
- REST `GET /repos/{owner}/{repo}/pulls/{n}/reviews`

### PullRequestReviewComment

Line comments on the diff.

- `path`, `line` / original line, `originalCommit`
- `inReplyTo` / reply-to id
- `pullRequestReview` id
- `author`, timestamps, `body` or bodies-absent

REST: `GET /repos/{owner}/{repo}/pulls/comments` and per-PR comments.

### PullRequestReviewThread

GraphQL only: `isResolved`, `isOutdated`, `path`, `line`, comments in the thread.

Without threads, later paths cannot see resolved review conversations.

### IssueComment

Conversation-tab comments on **issues and PRs**.

- `author`, timestamps, `body` or bodies-absent
- **`subject_type = issue | pr`** (PR is an issue; `issue.pull_request` / `__typename` must be stored)
- REST `GET .../issues/comments` and per-issue comments

### Issue (non-PR)

Authored, assigned, closed issues in `repo_set`. Filter `is:issue` / `__typename == Issue`.

- `author`, assignees, `state`, timestamps, closer if present
- labels **names** (raw)

### Timeline / issue events

GraphQL `timelineItems` or REST `GET .../issues/{n}/events`.

MUST capture at least: `ReviewRequestedEvent` (User | Team | Mannequin), `HeadRefForcePushedEvent`, `ReadyForReviewEvent`, `ConvertedToDraftEvent`, `AssignedEvent`, `ClosedEvent`, `MergedEvent`, `CrossReferencedEvent`, label add/remove.

### Checks

- GraphQL `statusCheckRollup` state/conclusion
- Per-check **name + conclusion** (CheckRun / CheckSuite / StatusContext as GitHub provides)

Do **not** ingest logs, annotations dumps, or Actions artifacts.

### Webhook envelope

App webhook: `X-GitHub-Event`, `X-GitHub-Delivery`, `X-GitHub-Hook-Installation-Target-Id`, `action`, raw body, signature verification metadata (not the secret).

This is **not** the canonical PR/commit/file object. It triggers `hydrate`.

### Installation / auth context

Which installation, which auth_kind, which `repo_set` membership. Required for visibility provenance.

## SHOULD

- `CommitComment` (`GET .../comments` on commits) — distinct from review comments
- `ReviewRequestedEvent` even if already in timeline
- WorkflowRun **name + conclusion** only
- `contributionsCollection` calendar + yearly totals as `proxy_snapshot` / `not_a_signal` (contrast: show the lie GitHub tells). Not a path feature.
- Repo `languages` blob if cheap
- `.gitattributes` and `CODEOWNERS` at default branch **as blobs** (ETL may parse later)
- REST `compare` when PR files truncate
- Reaction **actors** if we ingest reactions at all (prefer not to store only counts)

## MUST NOT (v1)

- Events API (`/users/{u}/events`, received events, org public events) as source of truth
- Search as complete backfill (`search` 1,000 cap)
- Nested GraphQL mega-query as the fetch architecture
- Stars, watchers, followers, following, Achievements, streak as objects-for-scoring
- Traffic, clone stats
- Gists, Wikis, Packages, Releases, Discussions, Projects, Sponsors
- Notification inbox, emails, org audit log
- Copilot metrics, secret-scanning / Dependabot **alert bodies**
- Full check logs, annotations, Actions artifacts
- `viewerCan*`, `viewerSubscription`
- HTML `bodyHTML` as canonical (if text is stored, store markdown `body`)
- Identity graph, docs classification, scores, weights
- HTML scraping of the contribution graph

## Output foreshadowing (do not omit)

Without writing an Output spec, ingest must still have: file path + rename + add/del + truncation; PR merged/closed/draft/merge commit/base ref; commit parents + full message; author vs committer timestamps; CI rollup; fork flags; listed-files vs `changedFiles`; enough default-branch history that “landed on main” is knowable; revert clues in messages/titles.

If v1 skips patches, that is allowed only if `patch_omitted` is recorded. Output can live on path+add/del for a while. It cannot live without paths.

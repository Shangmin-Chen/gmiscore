# Adversary tests

Ingest is insufficient if any of these fail. They are not Output formulas; they are collection requirements.

## 1. The 500-doc-commit person

They merge 500 commits to `docs/` and `README.md` in a day, plus a lockfile bump. GitHub’s calendar is on fire.

Must have per-file path + add/del, rename/`previous_filename`, truncation flags, PR ↔ commit linkage.

Must **not** write `quality=high` or persist `totalCommitContributions` as a feature.

If paths were dropped, Core cannot distinguish this person from someone who changed kernel code.

## 2. Squash merge with three humans

Branch commits from A, B (`Co-authored-by`), and a bot formatter. Squash produces one commit: author A, committer GitHub, trailers for B, `mergedBy` C.

Must retain PR commits, merge commit, full message, `mergedBy`.

If only `main` is ingested, B disappears and the bot is either 33% of authors or 0% — both wrong.

## 3. Dependabot + human Merge

Hundreds of PRs with `author = dependabot[bot]`, `mergedBy = human`, reviews from `github-actions`.

Store `isBot` / `__typename` raw. Do not drop bots at ingest. Do not credit the human for dependency noise here (that decision is Core). Do not erase the human’s real PRs by over-filtering.

## 4. Private work email, unlinked

Commits as `Jane <jane@employer.com>` with `GitActor.user = null`, GitHub-noreply on OSS, web UI as the GitHub user.

Ingest stores three actors. ETL may link later. Do not merge on email local-part.

Without the org App install, employer objects **do not exist**. The run is `partial` / missing private, not a confident public-only score. Calendar restricted counts are not a fill-in.

## 5. Drive-by OSS commenter

Subject leaves one `IssueComment` and two `PullRequestReviewComment`s on a repo they do not own, never opens a PR, then the head fork is deleted.

`user.pullRequests` is empty. They are only visible if that **repo is in `repo_set`**.

Must distinguish issue comment vs line review vs review submission. Reconciliation poll must still find them if a webhook was missed.

Consent: they are a counterparty on someone else’s install unless they opted in. Deletion/tombstone still applies. This must not become bulk-scoring random commenters.

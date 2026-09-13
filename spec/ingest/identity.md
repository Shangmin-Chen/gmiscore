# Identity (ingest)

Ingest **does not decide who is the same human**.

If ingest collapses actors into a single `user_id`, the merge is unrecoverable. Linking is ETL. Scoring is Core.

## Store actors as GitHub sent them

On every object that has people:

- GraphQL `id`, REST `node_id`, `databaseId`
- `login`
- `__typename` (`User` | `Bot` | `Organization` | `Mannequin`) and/or REST `type`
- `isBot` when GitHub provides it
- `app { id, slug, name }` for bots
- GitActor `name`, `email`, `date` **and** `user { ... } | null`
- `author` and `committer` **separately**
- PR `author`, `mergedBy`, review `author` as distinct fields
- Installation actor vs user actor when relevant

Do not normalize emails (including `noreply` forms) in ingest. Store the raw string.

## Cases that must remain distinct in the raw store

- Unlinked work email: `Jane <jane@employer.com>` with `GitActor.user == null`
- GitHub-noreply: `{id}+login@users.noreply.github.com`
- Web-UI commits as the GitHub user
- Co-authors only present in `commit.message` trailers
- Squash: merge commit author A, committer GitHub, trailers for B, `mergedBy` C
- Bot author + human `mergedBy`
- Mannequin / ghost after account deletion
- Machine users that are `User` not `Bot`

Bots: copy GitHub’s classification only. No `login.endsWith('[bot]')` filter at ingest. False negatives poison Output; false positives erase intern/machine-user work.

## Squash, rebase, coauthors

After squash, default-branch history is a **new** commit. Must keep:

1. `PullRequest.commits` (pre-merge SHAs and their GitActors)
2. `mergeCommit`
3. Full message body (trailers)
4. `mergedBy`

Rebase rewrites SHAs. PR commit snapshots are the historical record.

## Direct push

Commits on the default branch with no PR are a **separate stream**. If we skip them, Output only measures PR culture. Whether Output uses them is deferred; ingest still **lists and hydrates** default-branch commits in `repo_set` (including `files[]` — see `fetch.md`) so we do not re-ingest.

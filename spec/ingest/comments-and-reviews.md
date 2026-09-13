# Comments, reviews, and timeline

If the implementation fetches “PR comments” and stops, the interaction path (and much review-adjacent Output context) is dead. GitHub has **separate object families**.

## Families

| Family | What it is | Typical source |
|---|---|---|
| `IssueComment` | Conversation tab on an issue **or** PR | GraphQL `comments` on Issue/PR; REST `.../issues/comments` |
| `PullRequestReview` | Submitted (or pending) review with state | GraphQL reviews; REST `.../pulls/{n}/reviews` |
| `PullRequestReviewComment` | Line comment on the diff | GraphQL review comments; REST `.../pulls/comments` |
| `PullRequestReviewThread` | Grouping: resolved/outdated, path | GraphQL only |
| `CommitComment` | Comment on a commit, not necessarily via a PR review | REST `.../comments` on commits |
| Timeline items | Review requested, force-push, draft, merge, assign, cross-ref | GraphQL `timelineItems`; REST `.../issues/{n}/events` |

Do not collapse these into a single `comments` table without a `family` discriminator that matches GitHub.

## Webhook pitfall

`issue_comment` fires for issues **and** PRs. Persist enough of the issue payload (`pull_request` key / node type) to set `subject_type`.

`pull_request_review` and `pull_request_review_comment` are different events. `commit_comment` is another.

## Interaction artifacts (not a graph)

Ingest stores directed GitHub objects. ETL may later project edges. Do not persist `weight`.

| Artifact | Later edge |
|---|---|
| `PullRequestReview` | reviewer → PR author, with state and time |
| Review comment + `inReplyTo` | commenter → thread |
| Review thread `isResolved` | resolution state (resolver may need timeline) |
| `IssueComment` | commenter → issue/PR author |
| `ReviewRequestedEvent` | requester → user **or team** |
| `AssignedEvent` | assigner → assignee |
| `@login` in stored bodies | mention (ETL parse; requires bodies or an explicit skip) |
| `mergedBy` | merger → PR |
| `CrossReferencedEvent` / closing keywords | PR ↔ issue |
| `HeadRefForcePushedEvent` | pusher; invalidated review lines |
| Co-author trailers on commit message | trailer identity → commit |
| Reactions (SHOULD) | reactor → comment |

Teams as requested reviewers (`RequestedReviewer` union: User | Team | Mannequin) must be stored. User-only request graphs are wrong for CODEOWNERS orgs.

## Suggested changes

GitHub suggested-change review comments can become commits. v1 stores the comment and the commits; lineage stitching is ETL.

## Bodies

v1 is **metadata-only**. Set `body_stored=false` on provenance. `@login` mention parsing is not available until a later bodies hydrate. Do not store `bodyHTML`.

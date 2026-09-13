# Raw store

Ingest writes envelopes, not scored rows.

## Envelope

```
provenance: {
  ingest_run_id
  fetched_at
  received_at
  source_api            # graphql | rest | webhook | git
  operation_or_route
  query_hash
  variables_or_params
  cursor
  page
  installation_id
  auth_kind             # installation | user
  repo_node_id
  actor_node_id_if_any
  github_request_id
  rate_limit_remaining
  graphql_cost
  webhook_delivery_id
  webhook_event
  webhook_action
  payload_sha256
  schema_version
  visibility            # public | private
  truncated_by_api      # bool / reason if GitHub truncated
  legal_basis           # consent_user | org_install
  body_stored           # v1 false
}
body: <immutable JSON, GitHub payload as received>
```

Rules:

- Never edit `body`.
- Enrichment and facts live in ETL tables, not on this row.
- Latest-view is a projection over snapshots.
- Tokens never in `body` or logs.
- Strip `viewer*` before persist if a query accidentally requested them.
- Same logical PR from GraphQL vs REST vs webhook are **different snapshots** (`source_api` differs). Do not mash them into one JSON blob.

## Tombstones

Comment edits, deletes, dismissed reviews, force-push, deleted forks, renamed repos, transferred issues, uninstalled repos.

- Webhook `action=deleted` (and similar) → new envelope with `body=null`, `deleted_at`, `reason`
- Do not UPDATE-in-place the historical payload until a legal wipe
- Legal wipe: delete **all versions**, keep hashed node_id + deletion audit if required

Without tombstones, Core scores ghosts and we cannot honor erasure.

## What must not appear on the envelope

`score`, `weight`, `quality`, `is_docs`, `is_docs_only`, `bot_score`, `identity_canonical_id`, graph edges, PageRank, “impact.”

GitHub-native fields inside `body` (`additions`, `isBot`, `totalCount`) are allowed because they are GitHub’s JSON. They are not our metrics.

If ingest code imports a future `core/score` package, that is an architecture violation.

## Storage of truncation

When REST returns 406, 3,000-file cap, omitted `patch`, or GraphQL resource limits, provenance must say so. Silent short lists look like small PRs.

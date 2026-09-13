# Open decisions

Do not silently lock remaining items in ingest code. Several items below were **locked this turn** after adversary review; they are no longer open.

## Locked after adversary review (do not reopen in code)

| ID | Decision |
|---|---|
| D1 | v1 **metadata-only** bodies. Always set `body_stored=false`. A later bodies backfill is a new hydrate. |
| D3 | Store `contributionsCollection` calendar + yearly totals as `proxy_snapshot` / `not_a_signal` only. Never a path feature. |
| D4 | Checks = rollup + per-check **name + conclusion**. No logs. |
| — | Time-window **predicate** is activity-based (`updatedAt`/`mergedAt`/commit dates, not `createdAt` alone). See `fetch.md`. |
| — | Do not subject-filter list queries. |
| — | Default-branch commits: list + per-SHA `files[]` hydrate. |

## Still open (must choose before first production ingest)

| ID | Topic | Options | Lean |
|---|---|---|---|
| D2 | First backfill **length** | 90d / 1y / full history | unset — pass `window_start`/`window_end` on the run |

## Can ship ingest v1 without

| ID | Topic | Notes |
|---|---|---|
| D5 | Git clone / linguist for generated detection | API cannot see `.gitattributes` linguist-generated without a blob or clone. Reserve `git` as a future `source_api`. Path heuristics are ETL, not ingest. |
| D6 | Direct-push-to-main **in Output** | Ingest still lists/hydrates default-branch commits with files. Output may ignore them. |
| D7 | User-to-server OAuth for OSS outside the install | Not the same as a user-account App install. v1 scores are install-scoped. |
| D8 | Output unit | merged PR vs commit vs file-change — Core spec. |
| D9 | Combiner / path weights | Core spec. |
| D10 | Manager view of other opted-in members | Product spec. |
| D11 | Reactions | SHOULD; skippable. |
| D12 | Discussions / Gists | MUST NOT v1. |
| D13 | GHES | Out of scope. |
| D14 | Patch storage | Allowed to omit if `patch_omitted` is recorded. |

## Explicitly not open

Identity merge in ingest — **forbidden**.
Webhook-as-canonical — **forbidden**.
Events API / Search as complete backfill — **forbidden**.
Scoring in ingest — **forbidden**.
Subject-filtered list queries — **forbidden**.
STAGE moving to ETL/Core without an ETL spec — **forbidden**.

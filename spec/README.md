# Specs

Source of truth for what we are building and which **stage** the codebase is in. Code follows `STAGE.md`.

## Current stage

**ingest** — GitHub OAuth, then GraphQL on `viewer`, persist raw JSON. See `ingest.md`.

## Pipeline

```
GitHub OAuth → Ingest (this stage) → ETL → Core (paths, first path = output)
```

Scoring happens only in Core. Ingest does not score. ETL is not started.

## Layout

| Path | Status |
|---|---|
| `STAGE.md` | `ingest` |
| `ingest.md` | v1 ingest — implement against this file only |
| ETL / Core / paths | Not started |

Do not add scoring code while STAGE is `ingest`.

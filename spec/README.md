# Specs

This folder is the source of truth for **what we are building and which stage the codebase is in**. Code follows STAGE. Agents must read `STAGE.md` before implementing.

## Current stage

See `STAGE.md`. Right now that is **ingest**.

## Pipeline (repo-local reminder)

```
GitHub → Ingest → ETL → Core
```

- **Ingest** — fetch and persist raw GitHub payloads. No scoring.
- **ETL** — transform payloads into canonical facts. No scoring. Not started.
- **Core** — independent scoring paths plus a later combiner. First path: Output. Not started.

Architecture reminder: `.cursor/rules/gmiscore.mdc`. Ingest details in this folder win over memory if they ever drift. This folder’s first real spec is ingest, not Core.

## Layout

| Path | Status |
|---|---|
| `STAGE.md` | Active — single line of stage truth |
| `ingest/` | Active — v1 ingest spec |
| ETL spec | Not started — do not implement |
| Core / path specs | Not started — do not implement |

## Rules for later agents

- A PR that computes a score while STAGE=`ingest` is spec-invalid.
- Do not “helpfully” skip ingest completeness because Output formulas are unknown. If Output will need file paths, ingest file paths.
- Deferred decisions live in `ingest/open-decisions.md`. Do not silently lock them in code.

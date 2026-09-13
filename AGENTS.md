# GMI Score

GitHub contribution graphs are a bad proxy for engineer quality. This repo scores engineers from multiple independent **paths** after GitHub data is ingested and transformed.

## Pipeline

```
GitHub → Ingest → ETL → Core (paths + combiner)
```

Scoring happens only in Core. See `spec/` for the current stage and specs.

## Agent instructions

1. Read `spec/STAGE.md` before writing code.
2. While STAGE is `ingest`, only ingest spec/code is in scope.
3. Do not compute scores, classify “docs-only”, merge identities, or build interaction graphs in ingest.
4. Architecture and product thesis: `.cursor/rules/gmiscore.mdc` and `spec/README.md`.

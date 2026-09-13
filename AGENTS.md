# GMI Score

Engineers connect GitHub (OAuth) and we pull their real activity — PRs, pushed code, comments on other people’s PRs — because contribution graphs are a bad proxy for quality.

```
GitHub OAuth → Ingest → ETL → Core (paths; first path = output)
```

**Current stage: ingest.** Spec: `spec/ingest.md`. No scoring yet.

## Agent instructions

1. Read `spec/STAGE.md` then `spec/ingest.md`.
2. Ingest is OAuth + the GraphQL queries in that file. Do not invent GitHub Apps, webhooks, Search, or Events.
3. Do not compute scores or classify “docs-only” in ingest.

# GMI Score

Engineers connect GitHub (OAuth) and we pull their real activity — PRs, file paths, comments, reviews on other people’s PRs, issues they opened — because contribution graphs are a bad proxy for quality. Commits and the contribution calendar are not ingested.

```
GitHub OAuth → Ingest → ETL → Core (paths; first path = output)
```

**Current stage: ingest.** Spec: `spec/ingest.md`. No scoring yet.

## Agent instructions

1. Read `spec/STAGE.md` then `spec/ingest.md`.
2. Ingest is OAuth + the GraphQL queries in that file (`viewer` only). Do not invent GitHub Apps, webhooks, Search, Events, or REST.
3. Do not compute scores or classify “docs-only” in ingest. Do not fetch commits or `contributionCalendar`.

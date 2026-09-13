# gmiscore

Engineer quality is not a GitHub contribution graph. Someone can land hundreds of doc-only commits in a day and look more productive than someone who shipped real work.

**Pipeline:** GitHub → Ingest → ETL → Core (independent scoring paths, combined only in Core).

**Current stage:** ingest. See `spec/STAGE.md` and `spec/ingest/`. No scoring code yet.

First scoring path (later): **output**.

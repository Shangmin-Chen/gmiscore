# gmiscore

GitHub contribution graphs are a bad proxy for how good an engineer is. This product is B2C: you sign in with GitHub and we pull your actual PRs, pushed code, and comments — then (later) score **output** and other paths.

**Now:** ingest only. Spec: `spec/ingest.md`.

## Run locally

1. Copy `.env.example` to `.env` and fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from your [GitHub OAuth App](https://github.com/settings/developers). Set the callback URL to `http://127.0.0.1:3000/auth/github/callback`.

2. Install dependencies and start the dev server:

```bash
npm install
npm run dev
```

3. Open [http://127.0.0.1:3000](http://127.0.0.1:3000), click **Connect GitHub**, authorize, then **Start snapshot**.

SQLite data and encrypted tokens live under `.data/` (gitignored).

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the HTTP server on port 3000 with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled server |
| `npm test` | Run unit tests (mocked GitHub, no live API) |

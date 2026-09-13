import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parse as parseUrl } from "node:url";
import type { AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import type { TokenEncryption } from "./crypto/token-encryption.js";
import { TokenDecryptionError } from "./crypto/token-encryption.js";
import type { SessionManager } from "./auth/session.js";
import { COOKIE_NAME, SESSION_MAX_AGE_SEC } from "./auth/session.js";
import { escapeHtml } from "./util/html.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  ensureFreshToken,
  fetchViewerProfile,
  generateState,
  isStateValid,
  TokenRefreshError,
  type OAuthConfig,
} from "./auth/github.js";
import { GitHubClient } from "./github/client.js";
import { runIngest } from "./github/ingest.js";
import { IngestAlreadyRunningError } from "./errors.js";

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function setSessionCookie(res: ServerResponse, value: string): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

function html(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GMI Score — Ingest</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    a.btn { display: inline-block; background: #24292f; color: #fff; padding: 0.6rem 1.2rem;
            border-radius: 6px; text-decoration: none; }
    a.btn:hover { background: #424a53; }
    .status { margin-top: 1.5rem; padding: 1rem; background: #f6f8fa; border-radius: 6px; }
    .error { color: #cf222e; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface AppContext {
  config: AppConfig;
  store: Store;
  encryption: TokenEncryption;
  sessions: SessionManager;
  oauth: OAuthConfig;
  fetchImpl: typeof fetch;
}

function resolveUserId(
  cookies: Record<string, string>,
  sessions: SessionManager,
): number | null {
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  return sessions.verify(raw);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startIngestForUser(
  ctx: AppContext,
  userId: number,
  res: ServerResponse,
  asJson: boolean,
): Promise<void> {
  const { store, encryption, oauth, fetchImpl } = ctx;

  const user = store.getUserById(userId);
  if (!user) {
    res.writeHead(401, { "Content-Type": asJson ? "application/json" : "text/html" });
    res.end(
      asJson
        ? JSON.stringify({ error: "User not found" })
        : html(`<p class="error">User not found.</p>`),
    );
    return;
  }

  try {
    const accessToken = await ensureFreshToken(
      store,
      encryption,
      userId,
      oauth,
      fetchImpl,
    );
    const client = new GitHubClient(accessToken, { fetchImpl });
    const runId = await runIngest(store, client, userId, user.token_scopes);

    if (asJson) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId }));
    } else {
      res.writeHead(302, { Location: `/ingest/${runId}` });
      res.end();
    }
  } catch (err) {
    if (err instanceof TokenRefreshError || err instanceof TokenDecryptionError) {
      clearSessionCookie(res);
      const msg = escapeHtml(err.message);
      if (asJson) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(401, { "Content-Type": "text/html" });
        res.end(html(`<p class="error">${msg}</p><p><a href="/auth/github">Reconnect GitHub</a></p>`));
      }
      return;
    }
    if (err instanceof IngestAlreadyRunningError) {
      if (asJson) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.writeHead(409, { "Content-Type": "text/html" });
        res.end(html(`<p class="error">${escapeHtml(err.message)}</p>`));
      }
      return;
    }
    throw err;
  }
}

export function createApp(ctx: AppContext) {
  const { store, encryption, sessions, oauth, fetchImpl } = ctx;

  return createServer(async (req, res) => {
    const url = parseUrl(req.url ?? "/", true);
    const pathname = url.pathname ?? "/";
    const cookies = parseCookies(req);
    const userId = resolveUserId(cookies, sessions);

    try {
      if (pathname === "/" && req.method === "GET") {
        if (!userId) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            html(`
              <h1>GMI Score</h1>
              <p>Connect your GitHub account to start an ingest snapshot.</p>
              <a class="btn" href="/auth/github">Connect GitHub</a>
            `),
          );
          return;
        }

        const user = store.getUserById(userId);
        const latestRun = user ? store.getLatestRunForUser(userId) : undefined;
        const responseCount = latestRun
          ? store.countIngestResponses(latestRun.id)
          : 0;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          html(`
            <h1>GMI Score</h1>
            <p>Signed in as <strong>${escapeHtml(user?.github_login ?? "unknown")}</strong></p>
            <p>
              <a class="btn" href="/ingest/start">Start snapshot</a>
            </p>
            ${
              latestRun
                ? `<div class="status">
              <p><strong>Latest run:</strong> #${latestRun.id}</p>
              <p><strong>Status:</strong> ${escapeHtml(latestRun.status)}</p>
              <p><strong>Raw pages stored:</strong> ${responseCount}</p>
              <p><a href="/ingest/${latestRun.id}">View run details</a></p>
            </div>`
                : ""
            }
          `),
        );
        return;
      }

      if (pathname === "/auth/github" && req.method === "GET") {
        const state = generateState();
        store.createOAuthState(state, new Date().toISOString());
        const authorizeUrl = buildAuthorizeUrl(oauth, state);
        res.writeHead(302, { Location: authorizeUrl });
        res.end();
        return;
      }

      if (pathname === "/auth/github/callback" && req.method === "GET") {
        const code = url.query.code as string | undefined;
        const state = url.query.state as string | undefined;

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(html(`<p class="error">Missing code or state.</p>`));
          return;
        }

        const stored = store.getOAuthState(state);
        if (!stored || !isStateValid(stored.created_at)) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(html(`<p class="error">Invalid or expired OAuth state.</p>`));
          return;
        }
        store.deleteOAuthState(state);

        const tokenResp = await exchangeCode(oauth, code, fetchImpl);
        if (tokenResp.error || !tokenResp.access_token) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            html(
              `<p class="error">Token exchange failed: ${escapeHtml(tokenResp.error_description ?? tokenResp.error ?? "unknown error")}</p>`,
            ),
          );
          return;
        }

        const profile = await fetchViewerProfile(tokenResp.access_token, fetchImpl);
        const now = new Date().toISOString();
        const expiresAt = tokenResp.expires_in
          ? new Date(Date.now() + tokenResp.expires_in * 1000).toISOString()
          : null;

        const user = store.upsertUser({
          githubUserId: profile.githubUserId,
          githubLogin: profile.login,
          encryptedToken: encryption.encrypt(tokenResp.access_token),
          encryptedRefreshToken: tokenResp.refresh_token
            ? encryption.encrypt(tokenResp.refresh_token)
            : null,
          tokenExpiresAt: expiresAt,
          tokenScopes: tokenResp.scope ?? "",
          now,
        });

        setSessionCookie(res, sessions.sign(user.id));
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }

      if (pathname === "/ingest/start" && req.method === "POST") {
        if (!userId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not authenticated" }));
          return;
        }
        await startIngestForUser(ctx, userId, res, true);
        return;
      }

      if (pathname === "/ingest/start" && req.method === "GET") {
        if (!userId) {
          res.writeHead(302, { Location: "/auth/github" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          html(`
            <h1>Starting snapshot…</h1>
            <p id="msg">Running ingest…</p>
            <script>
              fetch('/ingest/start', { method: 'POST' })
                .then(r => r.json())
                .then(d => { window.location.href = '/ingest/' + d.runId; })
                .catch(e => { document.getElementById('msg').textContent = 'Error: ' + e; });
            </script>
          `),
        );
        return;
      }

      const runMatch = pathname.match(/^\/ingest\/(\d+)$/);
      if (runMatch && req.method === "GET") {
        if (!userId) {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end(html(`<p class="error">Not authenticated.</p>`));
          return;
        }

        const runId = parseInt(runMatch[1], 10);
        const run = store.getIngestRun(runId);
        if (!run) {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(html(`<p class="error">Run not found.</p>`));
          return;
        }

        if (run.user_id !== userId) {
          res.writeHead(403, { "Content-Type": "text/html" });
          res.end(html(`<p class="error">Forbidden.</p>`));
          return;
        }

        const count = store.countIngestResponses(runId);
        const byQuery: Record<string, number> = {};
        for (const resp of store.getIngestResponses(runId)) {
          byQuery[resp.query_name] = (byQuery[resp.query_name] ?? 0) + 1;
        }
        const breakdown = Object.entries(byQuery)
          .map(([k, v]) => `<li>${escapeHtml(k)}: ${v}</li>`)
          .join("");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          html(`
            <h1>Ingest Run #${run.id}</h1>
            <div class="status">
              <p><strong>Login:</strong> ${escapeHtml(run.github_login)}</p>
              <p><strong>Status:</strong> ${escapeHtml(run.status)}</p>
              <p><strong>Started:</strong> ${escapeHtml(run.started_at)}</p>
              <p><strong>Finished:</strong> ${escapeHtml(run.finished_at ?? "—")}</p>
              <p><strong>Total raw pages:</strong> ${count}</p>
              <ul>${breakdown}</ul>
            </div>
            <p><a href="/">← Home</a></p>
          `),
        );
        return;
      }

      if (pathname === "/api/ingest/start" && req.method === "POST") {
        await readBody(req);
        if (!userId) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not authenticated" }));
          return;
        }
        await startIngestForUser(ctx, userId, res, true);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error");
    }
  });
}

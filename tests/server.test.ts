import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager, COOKIE_NAME } from "../src/auth/session.js";
import { createApp } from "../src/server.js";
import { createTestEnv, createTestUser } from "./helpers.js";

const XSS_LOGIN = '<img src=x onerror=alert(1)>';
const XSS_FINISHED = '2024-06-01<script>alert("f")</script>';

function sessionCookie(sessions: SessionManager, userId: number): string {
  return `${COOKIE_NAME}=${encodeURIComponent(sessions.sign(userId))}`;
}

async function fetchPage(
  port: number,
  path: string,
  cookie: string,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Cookie: cookie },
  });
  return res.text();
}

describe("Server HTML escaping", () => {
  let env = createTestEnv();
  afterEach(() => env.cleanup());

  it("escapes github_login on home page", async () => {
    env = createTestEnv();
    const sessions = new SessionManager(env.dir, "server-test-secret");
    const user = env.store.upsertUser({
      githubUserId: "77777",
      githubLogin: XSS_LOGIN,
      encryptedToken: env.encryption.encrypt("gho_test"),
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
      tokenScopes: "read:user",
      now: new Date().toISOString(),
    });

    const server = createApp({
      config: {
        port: 0,
        dataDir: env.dir,
        dbPath: join(env.dir, "test.sqlite"),
        githubClientId: "id",
        githubClientSecret: "sec",
        githubRedirectUri: "http://127.0.0.1/cb",
      },
      store: env.store,
      encryption: env.encryption,
      sessions,
      oauth: {
        clientId: "id",
        clientSecret: "sec",
        redirectUri: "http://127.0.0.1/cb",
      },
      fetchImpl: fetch,
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await fetchPage(port, "/", sessionCookie(sessions, user.id));
      assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;"));
      assert.ok(!body.includes(XSS_LOGIN));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("escapes run fields on ingest run page", async () => {
    env = createTestEnv();
    const sessions = new SessionManager(env.dir, "server-test-secret");
    const user = createTestUser(env.store, env.encryption);
    const startedAt = '2024-01-01<script>alert("d")</script>';
    const run = env.store.createIngestRun({
      userId: user.id,
      githubUserId: "12345",
      githubLogin: XSS_LOGIN,
      tokenScopes: "read:user",
      startedAt,
    });
    env.store.updateIngestRunStatus(run.id, "partial", XSS_FINISHED);
    env.store.insertIngestResponse({
      ingestRunId: run.id,
      fetchedAt: new Date().toISOString(),
      queryName: "Q1<script>",
      variables: {},
      httpStatus: 200,
      payload: { data: {} },
    });

    const server = createApp({
      config: {
        port: 0,
        dataDir: env.dir,
        dbPath: join(env.dir, "test.sqlite"),
        githubClientId: "id",
        githubClientSecret: "sec",
        githubRedirectUri: "http://127.0.0.1/cb",
      },
      store: env.store,
      encryption: env.encryption,
      sessions,
      oauth: {
        clientId: "id",
        clientSecret: "sec",
        redirectUri: "http://127.0.0.1/cb",
      },
      fetchImpl: fetch,
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await fetchPage(
        port,
        `/ingest/${run.id}`,
        sessionCookie(sessions, user.id),
      );
      assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;"));
      assert.ok(body.includes("partial"));
      assert.ok(body.includes("2024-01-01&lt;script&gt;"));
      assert.ok(body.includes("2024-06-01&lt;script&gt;"));
      assert.ok(body.includes("Q1&lt;script&gt;"));
      assert.ok(!body.includes(XSS_LOGIN));
      assert.ok(!body.includes("<script>alert(1)</script>"));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

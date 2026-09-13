import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, SESSION_MAX_AGE_MS } from "../src/auth/session.js";
import { TokenEncryption, TokenDecryptionError } from "../src/crypto/token-encryption.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestEnv, createTestUser, createMockFetch, runTestIngest, gqlOk } from "./helpers.js";
import { ensureFreshToken, TokenRefreshError } from "../src/auth/github.js";
import { IngestAlreadyRunningError } from "../src/errors.js";

describe("Security and auth hardening", () => {
  let dir = mkdtempSync(join(tmpdir(), "gmiscore-sec-"));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects forged session cookie", () => {
    dir = mkdtempSync(join(tmpdir(), "gmiscore-sec-"));
    const sessions = new SessionManager(dir, "test-session-secret");
    const valid = sessions.sign(42);
    const forged = valid.replace(/.$/, valid.at(-1) === "a" ? "b" : "a");
    assert.equal(sessions.verify(forged), null);
    assert.equal(sessions.verify("999.1234567890.fakesignature"), null);
  });

  it("rejects expired session cookie", () => {
    dir = mkdtempSync(join(tmpdir(), "gmiscore-sec-"));
    const sessions = new SessionManager(dir, "test-session-secret");
    const cookie = sessions.sign(42);
    const expiredNow = Date.now() + SESSION_MAX_AGE_MS + 1000;
    assert.equal(sessions.verify(cookie, expiredNow), null);
  });

  it("encrypt/decrypt roundtrip", () => {
    dir = mkdtempSync(join(tmpdir(), "gmiscore-sec-"));
    const enc = new TokenEncryption(dir, "roundtrip-key");
    const plain = "gho_secret_token_value";
    assert.equal(enc.decrypt(enc.encrypt(plain)), plain);
  });

  it("encryption key mismatch throws actionable error", () => {
    dir = mkdtempSync(join(tmpdir(), "gmiscore-sec-"));
    const enc1 = new TokenEncryption(dir, "key-one");
    const ciphertext = enc1.encrypt("secret");
    const enc2 = new TokenEncryption(dir, "key-two");
    assert.throws(
      () => enc2.decrypt(ciphertext),
      (err: unknown) => err instanceof TokenDecryptionError,
    );
  });

  it("token refresh failure throws TokenRefreshError", async () => {
    const env = createTestEnv();
    const user = env.store.upsertUser({
      githubUserId: "99",
      githubLogin: "refreshuser",
      encryptedToken: env.encryption.encrypt("gho_old"),
      encryptedRefreshToken: env.encryption.encrypt("ghr_refresh"),
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      tokenScopes: "read:user",
      now: new Date().toISOString(),
    });

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: "bad_refresh", error_description: "Refresh failed" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await assert.rejects(
      () =>
        ensureFreshToken(
          env.store,
          env.encryption,
          user.id,
          { clientId: "id", clientSecret: "sec", redirectUri: "http://localhost/cb" },
          fetchImpl,
        ),
      TokenRefreshError,
    );
    env.cleanup();
  });

  it("parallel tryBeginIngestRun: one succeeds one gets 409", async () => {
    const env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();
    const params = {
      userId: user.id,
      githubUserId: "",
      githubLogin: "",
      tokenScopes: "",
      startedAt: now,
    };
    const results = await Promise.allSettled([
      Promise.resolve().then(() => env.store.tryBeginIngestRun(params)),
      Promise.resolve().then(() => env.store.tryBeginIngestRun(params)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].status === "rejected");
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof IngestAlreadyRunningError);
    env.cleanup();
  });

  it("recovers zombie running runs with stale heartbeat as failed when no responses", async () => {
    const env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const staleHeartbeat = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const stale = env.store.createIngestRun({
      userId: user.id,
      githubUserId: "12345",
      githubLogin: "testuser",
      tokenScopes: "",
      startedAt: staleHeartbeat,
      heartbeatAt: staleHeartbeat,
    });

    const { fetch } = createMockFetch([
      {
        match: (req) => !!req.body?.includes("ViewerProfile"),
        response: () =>
          gqlOk({
            viewer: {
              id: "U_1",
              databaseId: 12345,
              login: "testuser",
              name: "T",
              email: null,
              createdAt: "2020-01-01T00:00:00Z",
            },
          }),
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(stale.id)!.status, "failed");
    env.cleanup();
  });

  it("does not kill live ingest when heartbeat is fresh", async () => {
    const env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const oldStart = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const freshHeartbeat = new Date().toISOString();
    env.store.createIngestRun({
      userId: user.id,
      githubUserId: "12345",
      githubLogin: "testuser",
      tokenScopes: "",
      startedAt: oldStart,
      heartbeatAt: freshHeartbeat,
    });

    assert.throws(
      () =>
        env.store.tryBeginIngestRun({
          userId: user.id,
          githubUserId: "",
          githubLogin: "",
          tokenScopes: "",
          startedAt: new Date().toISOString(),
        }),
      IngestAlreadyRunningError,
    );
    const live = env.store.getRunningRunForUser(user.id)!;
    assert.equal(live.status, "running");
    assert.ok(live.heartbeat_at >= freshHeartbeat);
    env.cleanup();
  });

  it("marks stale zombie with Q1 responses as partial", async () => {
    const env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const staleHeartbeat = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const stale = env.store.createIngestRun({
      userId: user.id,
      githubUserId: "12345",
      githubLogin: "testuser",
      tokenScopes: "",
      startedAt: staleHeartbeat,
      heartbeatAt: staleHeartbeat,
    });
    env.store.insertIngestResponse({
      ingestRunId: stale.id,
      fetchedAt: staleHeartbeat,
      queryName: "Q1",
      variables: {},
      httpStatus: 200,
      payload: { data: { viewer: { login: "testuser" } } },
    });

    env.store.tryBeginIngestRun({
      userId: user.id,
      githubUserId: "",
      githubLogin: "",
      tokenScopes: "",
      startedAt: new Date().toISOString(),
    });

    assert.equal(env.store.getIngestRun(stale.id)!.status, "partial");
    env.cleanup();
  });

  it("IDOR: run belongs to user_id", () => {
    const env = createTestEnv();
    const user1 = createTestUser(env.store, env.encryption);
    const user2 = env.store.upsertUser({
      githubUserId: "99999",
      githubLogin: "other",
      encryptedToken: env.encryption.encrypt("gho_other"),
      encryptedRefreshToken: null,
      tokenExpiresAt: null,
      tokenScopes: "",
      now: new Date().toISOString(),
    });
    const run = env.store.createIngestRun({
      userId: user1.id,
      githubUserId: "12345",
      githubLogin: "testuser",
      tokenScopes: "",
      startedAt: new Date().toISOString(),
    });
    const fetched = env.store.getIngestRun(run.id)!;
    assert.notEqual(fetched.user_id, user2.id);
    assert.equal(fetched.user_id, user1.id);
    env.cleanup();
  });
});

describe("GitHub client headers", () => {
  it("sends User-Agent gmiscore", async () => {
    let seenUa = "";
    const fetchImpl = (async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      seenUa = headers["User-Agent"] ?? headers["user-agent"] ?? "";
      return new Response(JSON.stringify({ data: {}, rateLimit: { cost: 1, remaining: 5000, resetAt: new Date().toISOString() } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { GitHubClient } = await import("../src/github/client.js");
    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    await client.graphql("query { rateLimit { cost remaining resetAt } }", {});
    assert.equal(seenUa, "gmiscore");
  });
});

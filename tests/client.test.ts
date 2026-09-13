import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GitHubClient,
  paginateConnection,
  payloadContainsToken,
  extractFirstFromQuery,
  RATE_LIMIT_SLEEP_CHUNK_MS,
} from "../src/github/client.js";
import { initDb } from "../src/db/schema.js";
import { Store } from "../src/db/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Q2_VIEWER_PULL_REQUESTS, Q4_CONTRIB_YEAR } from "../src/github/queries.js";
import {
  rateLimit,
  gqlOk,
  gqlError,
  createTestUser,
  TokenEncryption,
} from "./helpers.js";

describe("GitHubClient", () => {
  it("does not advance cursor on GraphQL errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmiscore-cursor-"));
    const store = new Store(initDb(join(dir, "t.sqlite")));
    const encryption = new TokenEncryption(dir, "test-key");
    const user = createTestUser(store, encryption);
    const run = store.createIngestRun({
      userId: user.id,
      githubUserId: "1",
      githubLogin: "u",
      tokenScopes: "",
      startedAt: new Date().toISOString(),
    });

    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount <= 2) {
        return gqlError("Something broke");
      }
      return gqlOk({
        viewer: {
          pullRequests: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: "cursor1" },
            nodes: [{ id: "PR_1" }],
          },
        },
      });
    }) as typeof fetch;

    const client = new GitHubClient("gho_test_token_secret", {
      fetchImpl,
      sleep: async () => {},
    });

    const result = await paginateConnection(
      client,
      store,
      run.id,
      "Q2",
      Q2_VIEWER_PULL_REQUESTS,
      { after: null },
      ["viewer", "pullRequests"],
    );

    assert.equal(result.success, false);
    assert.equal(callCount, 2);
    const responses = store.getIngestResponses(run.id);
    assert.equal(responses.length, 2);
    assert.equal(JSON.parse(responses[0].variables).after, null);
    assert.equal(JSON.parse(responses[1].variables).after, null);

    rmSync(dir, { recursive: true, force: true });
  });

  it("treats null connection as page failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmiscore-null-"));
    const store = new Store(initDb(join(dir, "t.sqlite")));
    const encryption = new TokenEncryption(dir, "test-key");
    const user = createTestUser(store, encryption);
    const run = store.createIngestRun({
      userId: user.id,
      githubUserId: "1",
      githubLogin: "u",
      tokenScopes: "",
      startedAt: new Date().toISOString(),
    });

    const fetchImpl = (async () =>
      gqlOk({
        node: null,
      })) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    const result = await paginateConnection(
      client,
      store,
      run.id,
      "Q7",
      "query { node(id: $id) { ... on PullRequest { files(first: 50) { pageInfo { hasNextPage endCursor } nodes { path } } } } rateLimit { cost remaining resetAt } }",
      { id: "PR_x" },
      ["node", "files"],
    );

    assert.equal(result.success, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("halves pullRequestReviewContributions first (100) not contributions(first: 1)", async () => {
    const seenReviewFirst: number[] = [];
    let callNum = 0;
    const fetchImpl = (async (_input, init) => {
      callNum++;
      const body = JSON.parse(init?.body?.toString() ?? "{}") as { query: string };
      const match = body.query.match(
        /pullRequestReviewContributions\s*\(\s*first:\s*(\d+)/,
      );
      if (match) seenReviewFirst.push(parseInt(match[1], 10));
      if (callNum <= 2) {
        return new Response("", { status: 502 });
      }
      return new Response(
        JSON.stringify({ data: { rateLimit } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    await client.graphql(
      Q4_CONTRIB_YEAR,
      { from: "2024-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z", reviewAfter: null },
      {
        first: extractFirstFromQuery(Q4_CONTRIB_YEAR, "pullRequestReviewContributions"),
        connectionField: "pullRequestReviewContributions",
      },
    );
    assert.ok(seenReviewFirst.includes(100));
    assert.ok(seenReviewFirst.includes(50));
    assert.ok(!seenReviewFirst.includes(1));
  });

  it("403 without rate-limit headers backs off before retry", async () => {
    let callCount = 0;
    let slept = false;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("", { status: 403 });
      }
      return gqlOk({});
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        if (ms >= 2000) slept = true;
      },
    });
    await client.graphql("query { rateLimit { cost remaining resetAt } }", {});
    assert.equal(callCount, 2);
    assert.equal(slept, true);
  });

  it("Q2 query includes states OPEN CLOSED MERGED", () => {
    assert.ok(Q2_VIEWER_PULL_REQUESTS.includes("states: [OPEN, CLOSED, MERGED]"));
  });

  it("Q4 query includes maxRepositories: 100", async () => {
    const { Q4_CONTRIB_YEAR } = await import("../src/github/queries.js");
    assert.ok(Q4_CONTRIB_YEAR.includes("maxRepositories: 100"));
  });

  it("refreshes heartbeat during long rate-limit sleep in chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gmiscore-hb-"));
    const store = new Store(initDb(join(dir, "t.sqlite")));
    const encryption = new TokenEncryption(dir, "test-key");
    const user = createTestUser(store, encryption);
    const staleHeartbeat = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const run = store.createIngestRun({
      userId: user.id,
      githubUserId: "1",
      githubLogin: "u",
      tokenScopes: "",
      startedAt: staleHeartbeat,
      heartbeatAt: staleHeartbeat,
    });

    const waitMs = RATE_LIMIT_SLEEP_CHUNK_MS * 3 + 5000;
    const resetAt = new Date(Date.now() + waitMs).toISOString();
    const sleepChunks: number[] = [];

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: { rateLimit: { cost: 1, remaining: 0, resetAt } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        sleepChunks.push(ms);
      },
    });
    client.attachIngestRun(store, run.id);

    await client.graphql("query { rateLimit { cost remaining resetAt } }", {});

    assert.ok(sleepChunks.length >= 3);
    assert.ok(sleepChunks.every((ms) => ms <= RATE_LIMIT_SLEEP_CHUNK_MS));
    assert.ok(
      sleepChunks.reduce((sum, ms) => sum + ms, 0) >= waitMs - RATE_LIMIT_SLEEP_CHUNK_MS,
    );

    const updated = store.getIngestRun(run.id)!;
    assert.ok(updated.heartbeat_at > staleHeartbeat);

    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    store.failStaleRunningRuns(cutoff);
    assert.equal(store.getIngestRun(run.id)!.status, "running");

    rmSync(dir, { recursive: true, force: true });
  });

  it("REST non-JSON body returns null payload with parseError", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    const result = await client.restGet("/repos/o/r/commits/sha");
    assert.equal(result.payload, null);
    assert.equal(result.parseError, true);
    assert.equal(result.httpStatus, 200);
  });

  it("tokens never appear in stored payloads", async () => {
    const token = "gho_super_secret_token_xyz";
    const payload = {
      data: {
        viewer: { login: "user" },
        rateLimit,
      },
    };
    assert.equal(payloadContainsToken(payload, token), false);

    const badPayload = { access_token: token };
    assert.equal(payloadContainsToken(badPayload, token), true);
  });
});

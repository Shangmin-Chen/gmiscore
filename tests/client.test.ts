import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GitHubClient,
  payloadContainsToken,
  extractFirstFromQuery,
  RATE_LIMIT_SLEEP_CHUNK_MS,
  REMAINING_FLOOR,
  SECONDARY_BACKOFF_MS,
  isSecondaryRateLimit,
  isPrimaryRateLimit,
} from "../src/github/client.js";
import { initDb } from "../src/db/schema.js";
import { Store } from "../src/db/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as queryDocs from "../src/github/queries.js";
import {
  Q1_VIEWER_PROFILE,
  Q2_VIEWER_PULL_REQUESTS,
  Q4_REVIEW_CONTRIB_SLICE,
  Q7_PR_FILES,
} from "../src/github/queries.js";
import {
  rateLimit,
  gqlOk,
  gqlError,
  gqlRateLimited,
  createTestUser,
  TokenEncryption,
} from "./helpers.js";

describe("GitHubClient", () => {
  it("Q2 query includes states OPEN CLOSED MERGED", () => {
    assert.ok(Q2_VIEWER_PULL_REQUESTS.includes("states: [OPEN, CLOSED, MERGED]"));
  });

  it("does not define unused GraphQL fragments", () => {
    assert.equal(/fragment\s+\w+\s+on\s+/.test(Q1_VIEWER_PROFILE), false);
    for (const [name, value] of Object.entries(queryDocs)) {
      if (typeof value !== "string" || !name.startsWith("Q")) continue;
      const defined = [...value.matchAll(/fragment\s+(\w+)\s+on\s+/g)].map((m) => m[1]);
      const used = new Set(
        [...value.matchAll(/\.\.\.(?!on\b)([A-Za-z_]\w*)/g)].map((m) => m[1]),
      );
      for (const frag of defined) {
        assert.ok(used.has(frag), `${name} defines unused fragment ${frag}`);
      }
    }
  });

  it("Q4 query has isRestricted and orderBy direction DESC", () => {
    assert.ok(Q4_REVIEW_CONTRIB_SLICE.includes("isRestricted"));
    assert.ok(Q4_REVIEW_CONTRIB_SLICE.includes("orderBy: { direction: DESC }"));
    assert.ok(!Q4_REVIEW_CONTRIB_SLICE.includes("contributionCalendar"));
    assert.ok(!Q4_REVIEW_CONTRIB_SLICE.includes("commitContributionsByRepository"));
  });

  it("Q7 uses Page fragment", () => {
    assert.ok(Q7_PR_FILES.includes("pageInfo { ...Page }"));
  });

  it("does not sleep until hourly reset when remaining is low", async () => {
    let totalSleep = 0;
    const fetchImpl = (async () =>
      gqlOk({}, 50)) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        totalSleep += ms;
      },
    });
    client.markAfterQ1();
    await client.rawGraphql("query { rateLimit { cost remaining resetAt } }", {});
    assert.equal(totalSleep, 0);
    assert.equal(client.shouldStopForRemainingFloor(), true);
  });

  it("remaining floor is 200", () => {
    assert.equal(REMAINING_FLOOR, 200);
  });

  it("secondary backoff uses 60/120/240 without hourly reset", () => {
    assert.deepEqual(SECONDARY_BACKOFF_MS, [60_000, 120_000, 240_000]);
  });

  it("halves pullRequestReviewContributions first on 502 retry", async () => {
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
      return gqlOk({});
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    await client.graphql(
      Q4_REVIEW_CONTRIB_SLICE,
      { from: "2024-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z", reviewAfter: null },
      {
        first: extractFirstFromQuery(Q4_REVIEW_CONTRIB_SLICE, "pullRequestReviewContributions"),
        connectionField: "pullRequestReviewContributions",
      },
    );
    assert.ok(seenReviewFirst.includes(100));
    assert.ok(seenReviewFirst.includes(50));
  });

  it("classifies primary rate limit and does not retry", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      return gqlRateLimited();
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    client.markAfterQ1();
    const outcome = await client.executeRequest(Q2_VIEWER_PULL_REQUESTS, {});
    assert.equal(outcome.classification, "primary_rate_limit");
    assert.equal(callCount, 1);
  });

  it("null_data retry secondary enters backoff not fallthrough", async () => {
    let callNum = 0;
    const secondary = () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "secondary rate limit" }],
          rateLimit,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-remaining": "3000",
          },
        },
      );

    const fetchImpl = (async () => {
      callNum++;
      if (callNum === 1) return gqlError("boom");
      return secondary();
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", { fetchImpl, sleep: async () => {} });
    client.markAfterQ1();
    const outcome = await client.executeRequest(Q2_VIEWER_PULL_REQUESTS, {});
    assert.equal(outcome.classification, "secondary_rate_limit");
    assert.equal(outcome.secondaryExhausted, true);
    assert.ok(callNum > 2);
  });

  it("retries null data once after 2s then fails", async () => {
    let callCount = 0;
    let slept = false;
    const fetchImpl = (async () => {
      callCount++;
      return gqlError("boom");
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        if (ms >= 2000) slept = true;
      },
    });
    client.markAfterQ1();
    const outcome = await client.executeRequest(Q2_VIEWER_PULL_REQUESTS, {});
    assert.equal(outcome.classification, "null_data");
    assert.equal(callCount, 2);
    assert.equal(slept, true);
  });

  it("refreshes heartbeat during chunked secondary sleep", async () => {
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

    let callNum = 0;
    const sleepChunks: number[] = [];
    const fetchImpl = (async () => {
      callNum++;
      if (callNum === 1) {
        return new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "secondary rate limit hit" }],
            rateLimit,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "4000",
            },
          },
        );
      }
      return gqlOk({});
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        sleepChunks.push(ms);
      },
    });
    client.attachIngestRun(store, run.id);
    client.markAfterQ1();

    await client.executeRequest(Q2_VIEWER_PULL_REQUESTS, {});

    assert.ok(sleepChunks.length >= 1);
    assert.ok(sleepChunks.every((ms) => ms <= RATE_LIMIT_SLEEP_CHUNK_MS));

    const updated = store.getIngestRun(run.id)!;
    assert.ok(updated.heartbeat_at > staleHeartbeat);

    rmSync(dir, { recursive: true, force: true });
  });

  it("429 with remaining 0 is primary not secondary", () => {
    const body = {
      data: null,
      errors: [{ message: "You have exceeded a secondary rate limit" }],
    };
    assert.equal(isPrimaryRateLimit(429, body, 0), true);
    assert.equal(isSecondaryRateLimit(429, body, 0), false);
  });

  it("secondary requires header remaining > 0", () => {
    const body = {
      data: null,
      errors: [{ message: "secondary rate limit" }],
    };
    assert.equal(isSecondaryRateLimit(200, body, undefined), false);
    assert.equal(isSecondaryRateLimit(200, body, 0), false);
    assert.equal(isSecondaryRateLimit(200, body, 100), true);
  });

  it("honors Retry-After on secondary rate limit", async () => {
    let callNum = 0;
    const sleepMs: number[] = [];
    const fetchImpl = (async () => {
      callNum++;
      if (callNum === 1) {
        return new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "secondary rate limit" }],
            rateLimit,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "3000",
              "Retry-After": "5",
            },
          },
        );
      }
      return gqlOk({});
    }) as typeof fetch;

    const client = new GitHubClient("gho_test", {
      fetchImpl,
      sleep: async (ms) => {
        sleepMs.push(ms);
      },
    });
    client.markAfterQ1();
    await client.executeRequest(Q2_VIEWER_PULL_REQUESTS, {});
    assert.ok(sleepMs.some((ms) => ms === 5000));
    assert.ok(!sleepMs.some((ms) => ms === 60_000));
  });

  it("tokens never appear in stored payloads", () => {
    const token = "gho_super_secret_token_xyz";
    const payload = { data: { viewer: { login: "user" }, rateLimit } };
    assert.equal(payloadContainsToken(payload, token), false);
    assert.equal(payloadContainsToken({ access_token: token }, token), true);
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createTestEnv,
  createTestUser,
  createMockFetch,
  runTestIngest,
  gqlOk,
  gqlError,
  gqlRateLimited,
} from "./helpers.js";
import {
  Q4_REVIEW_CONTRIB_SLICE,
  Q7_PR_FILES,
} from "../src/github/queries.js";
import { payloadContainsToken, MAX_IN_FLIGHT } from "../src/github/client.js";
import {
  analyzeNodesBatch,
  extractNodesIndexFromPath,
} from "../src/github/ingest.js";

function emptyPageConnection() {
  return {
    totalCount: 0,
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [],
  };
}

function baseHandlers() {
  return [
    {
      match: (req: { body?: string }) => !!req.body?.includes("ViewerProfile"),
      response: () =>
        gqlOk({
          viewer: {
            id: "U_1",
            databaseId: 12345,
            login: "testuser",
            name: "Test",
            email: null,
            createdAt: "2020-01-01T00:00:00Z",
          },
        }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ViewerPullRequests"),
      response: () =>
        gqlOk({ viewer: { pullRequests: emptyPageConnection() } }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ReviewContribSlice"),
      response: () =>
        gqlOk({
          viewer: {
            contributionsCollection: {
              startedAt: "2024-01-01T00:00:00Z",
              endedAt: "2025-01-01T00:00:00Z",
              restrictedContributionsCount: 0,
              pullRequestReviewContributions: emptyPageConnection(),
            },
          },
        }),
    },
    {
      match: (req: { body?: string }) => !!req.body?.includes("ViewerIssues"),
      response: () => gqlOk({ viewer: { issues: emptyPageConnection() } }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ViewerIssueComments"),
      response: () =>
        gqlOk({ viewer: { issueComments: emptyPageConnection() } }),
    },
  ];
}

describe("Ingest orchestrator", () => {
  let env = createTestEnv();
  afterEach(() => env.cleanup());

  it("Q1 failure fails the entire run", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch } = createMockFetch([
      {
        match: (req) => !!req.body?.includes("ViewerProfile"),
        response: () => gqlError("Unauthorized"),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.status, "failed");
  });

  it("uses viewer.id string when databaseId is null", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch } = createMockFetch([
      {
        match: (req) => !!req.body?.includes("ViewerProfile"),
        response: () =>
          gqlOk({
            viewer: {
              id: "MDQ6VXNlcjE",
              databaseId: null,
              login: "testuser",
              name: "Test",
              email: null,
              createdAt: "2020-01-01T00:00:00Z",
            },
          }),
      },
      ...baseHandlers().slice(1),
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.github_user_id, "MDQ6VXNlcjE");
  });

  it("stores window_start on run", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch } = createMockFetch(baseHandlers());
    const runId = await runTestIngest(env.store, fetch, user.id);
    const run = env.store.getIngestRun(runId)!;
    assert.ok(run.window_start);
    const diff =
      new Date(run.started_at).getTime() - new Date(run.window_start!).getTime();
    assert.equal(diff, 365 * 24 * 60 * 60 * 1000);
  });

  it("Q2 stops at window cutoff without next page", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    let q2Calls = 0;
    const oldDate = "2019-01-01T00:00:00Z";

    const { fetch } = createMockFetch([
      baseHandlers()[0],
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () => {
          q2Calls++;
          return gqlOk({
            viewer: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: "more" },
                nodes: [
                  {
                    id: "PR_new",
                    number: 2,
                    updatedAt: new Date().toISOString(),
                    state: "OPEN",
                    isDraft: false,
                    merged: false,
                    mergedAt: null,
                  },
                  {
                    id: "PR_old",
                    number: 1,
                    updatedAt: oldDate,
                    state: "MERGED",
                    isDraft: false,
                    merged: true,
                    mergedAt: oldDate,
                  },
                ],
              },
            },
          });
        },
      },
      ...baseHandlers().slice(2),
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(q2Calls, 1);
  });

  it("hydrate_pr_ids ranks merged before open and caps at 300", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const prNodes = [];
    for (let i = 0; i < 310; i++) {
      prNodes.push({
        id: `PR_m${i}`,
        number: i,
        updatedAt: now,
        state: "MERGED",
        isDraft: false,
        merged: true,
        mergedAt: new Date(Date.now() - i * 1000).toISOString(),
        repository: { nameWithOwner: "o/r" },
      });
    }
    prNodes.push({
      id: "PR_open_best",
      number: 9999,
      updatedAt: now,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergedAt: null,
      repository: { nameWithOwner: "o/r" },
    });

    const { fetch } = createMockFetch([
      baseHandlers()[0],
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () =>
          gqlOk({
            viewer: {
              pullRequests: {
                totalCount: prNodes.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: prNodes,
              },
            },
          }),
      },
      ...baseHandlers().slice(2),
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const run = env.store.getIngestRun(runId)!;
    const hydrateIds = JSON.parse(run.hydrate_pr_ids!) as string[];
    assert.equal(hydrateIds.length, 300);
    assert.ok(hydrateIds.includes("PR_m0"));
    assert.ok(!hydrateIds.includes("PR_open_best"));
    assert.ok(!hydrateIds.includes("PR_m309"));
  });

  it("stops partial when remaining floor hit after Q1", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    let callNum = 0;

    const { fetch } = createMockFetch(
      [
        {
          match: (req) => !!req.body?.includes("ViewerProfile"),
          response: () =>
            gqlOk({
              viewer: {
                id: "U_1",
                databaseId: 1,
                login: "testuser",
                name: "T",
                email: null,
                createdAt: "2020-01-01T00:00:00Z",
              },
            }),
        },
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () => {
            callNum++;
            return gqlOk(
              { viewer: { pullRequests: emptyPageConnection() } },
              150,
            );
          },
        },
      ],
      { defaultRemaining: 5000 },
    );

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    assert.equal(callNum, 1);
    assert.ok(
      !env.store
        .getIngestResponses(runId)
        .some((r) => r.query_name === "Q4"),
    );
  });

  it("Q4 always runs exactly two slices", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const captured: Array<{ from: string; to: string }> = [];

    const { fetch: innerFetch } = createMockFetch(baseHandlers());
    const fetch = (async (input, init) => {
      const body = init?.body?.toString() ?? "";
      if (body.includes("ReviewContribSlice")) {
        const vars = JSON.parse(body).variables as { from: string; to: string };
        captured.push({ from: vars.from, to: vars.to });
      }
      return innerFetch(input, init);
    }) as typeof fetch;

    const runId = await runTestIngest(env.store, fetch, user.id);
    const run = env.store.getIngestRun(runId)!;
    assert.equal(captured.length, 2);
    assert.equal(captured[0].from, run.window_start);
    assert.equal(captured[1].to, run.started_at);
  });

  it("Q6 uses nodes batch not per-id PrCore", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const { fetch, calls } = createMockFetch([
      baseHandlers()[0],
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () =>
          gqlOk({
            viewer: {
              pullRequests: {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PR_a",
                    number: 1,
                    updatedAt: now,
                    state: "MERGED",
                    isDraft: false,
                    merged: true,
                    mergedAt: now,
                    repository: { nameWithOwner: "o/r" },
                  },
                  {
                    id: "PR_b",
                    number: 2,
                    updatedAt: now,
                    state: "OPEN",
                    isDraft: false,
                    merged: false,
                    mergedAt: null,
                    repository: { nameWithOwner: "o/r" },
                  },
                ],
              },
            },
          }),
      },
      ...baseHandlers().slice(2),
      {
        match: (req) => !!req.body?.includes("PrCoreBatch"),
        response: (req) => {
          const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
          return gqlOk({
            nodes: vars.ids.map((id) => ({ id, labels: { pageInfo: { hasNextPage: false }, nodes: [] } })),
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    const batchCalls = calls.filter((c) => c.body?.includes("PrCoreBatch"));
    assert.equal(batchCalls.length, 1);
    const vars = JSON.parse(batchCalls[0].body!).variables as { ids: string[] };
    assert.deepEqual(vars.ids.sort(), ["PR_a", "PR_b"]);
  });

  it("Q9 fetches first page only via batch", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();
    let q9Calls = 0;

    const { fetch } = createMockFetch([
      baseHandlers()[0],
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () =>
          gqlOk({
            viewer: {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PR_m",
                    number: 1,
                    updatedAt: now,
                    state: "MERGED",
                    isDraft: false,
                    merged: true,
                    mergedAt: now,
                    repository: { nameWithOwner: "o/r" },
                  },
                ],
              },
            },
          }),
      },
      ...baseHandlers().slice(2),
      {
        match: (req) => !!req.body?.includes("PrCoreBatch"),
        response: () => gqlOk({ nodes: [{ id: "PR_m" }] }),
      },
      {
        match: (req) => !!req.body?.includes("PrFilesBatch"),
        response: () =>
          gqlOk({
            nodes: [
              {
                id: "PR_m",
                changedFiles: 0,
                files: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            ],
          }),
      },
      {
        match: (req) => !!req.body?.includes("PrCommentsBatch"),
        response: () => {
          q9Calls++;
          return gqlOk({
            nodes: [
              {
                id: "PR_m",
                comments: {
                  pageInfo: { hasNextPage: true },
                  nodes: [{ id: "C1", body: "hi" }],
                },
              },
            ],
          });
        },
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(q9Calls, 1);
    assert.equal(env.store.getIngestRun(runId)!.status, "complete");
    const q9 = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q9")!;
    const meta = JSON.parse(q9.metadata);
    assert.equal(meta.per_id.PR_m.q9_comments_truncated, true);
  });

  it("truncation flags do not make run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        ...baseHandlers(),
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_t",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_t",
                  labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: "bug" }] },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_t",
                  changedFiles: 10,
                  files: {
                    totalCount: 3,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrCommentsBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_t",
                  comments: {
                    pageInfo: { hasNextPage: true },
                    nodes: [{ id: "C1" }],
                  },
                },
              ],
            }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "complete");
  });

  it("marks run partial on Q6 batch failure", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_fail",
                      number: 1,
                      updatedAt: now,
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlError("Node lookup failed"),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("skips Q12 when PR ref already in Q2", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const handlers = baseHandlers().map((h) => {
      if (h.match({ body: "ViewerPullRequests" })) {
        return {
          match: (req: { body?: string }) =>
            !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_1",
                      number: 42,
                      updatedAt: new Date().toISOString(),
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "acme/app" },
                    },
                  ],
                },
              },
            }),
        };
      }
      if (h.match({ body: "ViewerIssueComments" })) {
        return {
          match: (req: { body?: string }) =>
            !!req.body?.includes("ViewerIssueComments"),
          response: () =>
            gqlOk({
              viewer: {
                issueComments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "C1",
                      pullRequest: null,
                      issue: {
                        number: 42,
                        url: "https://github.com/acme/app/pull/42",
                        repository: {
                          owner: { login: "acme" },
                          name: "app",
                        },
                      },
                    },
                  ],
                },
              },
            }),
        };
      }
      return h;
    });

    const { fetch, order } = createMockFetch(handlers);
    await runTestIngest(env.store, fetch, user.id);
    assert.equal(order.filter((q) => q === "Q12").length, 0);
  });

  it("runs indexes in order Q2 Q4 Q5 Q3", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch, order } = createMockFetch(baseHandlers());
    await runTestIngest(env.store, fetch, user.id);

    const q2Idx = order.indexOf("Q2");
    const q4Idx = order.indexOf("Q4");
    const q5Idx = order.indexOf("Q5");
    const q3Idx = order.indexOf("Q3");
    assert.ok(q2Idx > -1);
    assert.ok(q4Idx > q2Idx);
    assert.ok(q5Idx > q4Idx);
    assert.ok(q3Idx > q5Idx);
  });

  it("never issues REST requests", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch, calls } = createMockFetch(baseHandlers());
    await runTestIngest(env.store, fetch, user.id);
    assert.ok(calls.every((c) => !c.url.includes("/repos/") || c.url.includes("/graphql")));
    assert.ok(
      !env.store
        .getIngestResponses(
          env.store.getLatestRunForUser(user.id)!.id,
        )
        .some((r) => r.query_name === "rest_commit_files"),
    );
  });

  it("query_name is only Q1-Q7 Q9 Q12 Q13", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const runId = await runTestIngest(
      env.store,
      createMockFetch(baseHandlers()).fetch,
      user.id,
    );
    const allowed = /^(Q([1-7]|9|12|13))$/;
    for (const resp of env.store.getIngestResponses(runId)) {
      assert.match(resp.query_name, allowed);
    }
  });

  it("uncaught exception after Q1 marks run partial not failed", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    let q2Calls = 0;
    const { fetch } = createMockFetch([
      {
        match: (req) => !!req.body?.includes("ViewerProfile"),
        response: () =>
          gqlOk({
            viewer: {
              id: "U_1",
              databaseId: 1,
              login: "testuser",
              name: "T",
              email: null,
              createdAt: "2020-01-01T00:00:00Z",
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () => {
          q2Calls++;
          throw new Error("simulated crash");
        },
      },
    ]);
    await assert.rejects(() => runTestIngest(env.store, fetch, user.id));
    assert.equal(env.store.getLatestRunForUser(user.id)!.status, "partial");
    assert.ok(q2Calls >= 1);
  });

  it("never stores access token in ingest payloads", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const token = "gho_test_token_secret";
    const runId = await runTestIngest(
      env.store,
      createMockFetch(baseHandlers()).fetch,
      user.id,
    );
    for (const resp of env.store.getIngestResponses(runId)) {
      assert.equal(payloadContainsToken(JSON.parse(resp.payload), token), false);
      assert.ok(!resp.payload.includes(token));
    }
  });

  it("Q4 query has isRestricted not calendar", () => {
    assert.ok(Q4_REVIEW_CONTRIB_SLICE.includes("isRestricted"));
    assert.ok(!Q4_REVIEW_CONTRIB_SLICE.includes("contributionCalendar"));
  });

  it("Q7 uses Page fragment", () => {
    assert.ok(Q7_PR_FILES.includes("pageInfo { ...Page }"));
  });

  it("Q7 sets files_truncated metadata when totalCount < changedFiles", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_trunc",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_trunc" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_trunc",
                  changedFiles: 10,
                  files: {
                    totalCount: 3,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrCommentsBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_trunc",
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: [],
                  },
                },
              ],
            }),
        },
      ]).fetch,
      user.id,
    );

    const q7 = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7")!;
    const meta = JSON.parse(q7.metadata);
    assert.equal(meta.per_id.PR_trunc.files_truncated, true);
  });

  it("partial_data on index page marks run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            new Response(
              JSON.stringify({
                data: {
                  viewer: {
                    pullRequests: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ id: "PR_1", updatedAt: new Date().toISOString() }],
                    },
                  },
                  rateLimit: { cost: 1, remaining: 5000, resetAt: new Date(Date.now() + 3600000).toISOString() },
                },
                errors: [{ message: "partial failure" }],
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "x-ratelimit-remaining": "5000",
                },
              },
            ),
        },
        ...baseHandlers().slice(2),
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("null nodes batch slot marks run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_ok",
                      number: 1,
                      updatedAt: now,
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "o/r" },
                    },
                    {
                      id: "PR_null",
                      number: 2,
                      updatedAt: now,
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: (req) => {
            const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
            return gqlOk({
              nodes: vars.ids.map((id) => (id === "PR_null" ? null : { id })),
            });
          },
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q6 = env.store.getIngestResponses(runId).find((r) => r.query_name === "Q6")!;
    assert.ok(JSON.parse(q6.metadata).per_id_failed.PR_null);
  });

  it("nodes 502 shrink slices ids into smaller batches", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();
    const ids = Array.from({ length: 12 }, (_, i) => `PR_${i}`);
    const batchSizes: number[] = [];

    const prNodes = ids.map((id, i) => ({
      id,
      number: i,
      updatedAt: now,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergedAt: null,
      repository: { nameWithOwner: "o/r" },
    }));

    const batchFailCounts = new Map<string, number>();
    const { fetch } = createMockFetch([
      baseHandlers()[0],
      {
        match: (req) => !!req.body?.includes("ViewerPullRequests"),
        response: () =>
          gqlOk({
            viewer: {
              pullRequests: {
                totalCount: ids.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: prNodes,
              },
            },
          }),
      },
      ...baseHandlers().slice(2),
      {
        match: (req) => !!req.body?.includes("PrCoreBatch"),
        response: (req) => {
          const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
          batchSizes.push(vars.ids.length);
          const key = vars.ids.join(",");
          const fails = batchFailCounts.get(key) ?? 0;
          if (vars.ids.length > 5 && fails < 2) {
            batchFailCounts.set(key, fails + 1);
            return new Response("", { status: 502 });
          }
          return gqlOk({ nodes: vars.ids.map((id) => ({ id })) });
        },
      },
      {
        match: (req) => !!req.body?.includes("PrFilesBatch"),
        response: (req) => {
          const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
          return gqlOk({
            nodes: vars.ids.map((id) => ({
              id,
              changedFiles: 0,
              files: {
                totalCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            })),
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.ok(batchSizes.some((n) => n <= 6));
    assert.ok(batchSizes.some((n) => n < 12));
  });

  it("isRestricted excluded from q13_pr_ids", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        {
          match: (req) => !!req.body?.includes("ReviewContribSlice"),
          response: () =>
            gqlOk({
              viewer: {
                contributionsCollection: {
                  startedAt: "2024-01-01T00:00:00Z",
                  endedAt: "2025-01-01T00:00:00Z",
                  restrictedContributionsCount: 1,
                  pullRequestReviewContributions: {
                    totalCount: 2,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        occurredAt: new Date().toISOString(),
                        isRestricted: true,
                        pullRequest: { id: "PR_restricted" },
                      },
                      {
                        occurredAt: new Date(Date.now() - 1000).toISOString(),
                        isRestricted: false,
                        pullRequest: { id: "PR_ok" },
                      },
                    ],
                  },
                },
              },
            }),
        },
        ...baseHandlers().slice(3),
      ]).fetch,
      user.id,
    );
    const q13 = JSON.parse(env.store.getIngestRun(runId)!.q13_pr_ids!) as string[];
    assert.deepEqual(q13, ["PR_ok"]);
  });

  it("Q3 stops at window cutoff without next page", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    let q3Calls = 0;
    const oldDate = "2019-01-01T00:00:00Z";

    const { fetch } = createMockFetch([
      ...baseHandlers().slice(0, 4),
      {
        match: (req) => !!req.body?.includes("ViewerIssueComments"),
        response: () => {
          q3Calls++;
          return gqlOk({
            viewer: {
              issueComments: {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: "more" },
                nodes: [
                  { id: "C_new", updatedAt: new Date().toISOString() },
                  { id: "C_old", updatedAt: oldDate },
                ],
              },
            },
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(q3Calls, 1);
  });

  it("remaining floor before Q12 does not persist fake Q12 row", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers().slice(0, 4),
      {
        match: (req) => !!req.body?.includes("ViewerIssueComments"),
        response: () =>
          gqlOk(
            {
              viewer: {
                issueComments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "C1",
                      pullRequest: null,
                      issue: {
                        number: 99,
                        url: "https://github.com/acme/app/pull/99",
                        repository: { owner: { login: "acme" }, name: "app" },
                      },
                    },
                  ],
                },
              },
            },
            150,
          ),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    assert.ok(!env.store.getIngestResponses(runId).some((r) => r.query_name === "Q12"));
  });

  it("hydrate_skipped on Q2 page containing capped PR", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `PR_p1_${i}`,
      number: i,
      updatedAt: now,
      state: "MERGED",
      isDraft: false,
      merged: true,
      mergedAt: new Date(Date.now() - i * 1000).toISOString(),
      repository: { nameWithOwner: "o/r" },
    }));
    const page2 = Array.from({ length: 200 }, (_, i) => ({
      id: `PR_p2_${i}`,
      number: 100 + i,
      updatedAt: now,
      state: "MERGED",
      isDraft: false,
      merged: true,
      mergedAt: new Date(Date.now() - (100 + i) * 1000).toISOString(),
      repository: { nameWithOwner: "o/r" },
    }));
    const page3 = [
      {
        id: "PR_capped",
        number: 999,
        updatedAt: now,
        state: "MERGED",
        isDraft: false,
        merged: true,
        mergedAt: new Date(Date.now() - 999000).toISOString(),
        repository: { nameWithOwner: "o/r" },
      },
    ];

    let q2Page = 0;
    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () => {
            q2Page++;
            if (q2Page === 1) {
              return gqlOk({
                viewer: {
                  pullRequests: {
                    totalCount: 301,
                    pageInfo: { hasNextPage: true, endCursor: "p2" },
                    nodes: page1,
                  },
                },
              });
            }
            if (q2Page === 2) {
              return gqlOk({
                viewer: {
                  pullRequests: {
                    totalCount: 301,
                    pageInfo: { hasNextPage: true, endCursor: "p3" },
                    nodes: page2,
                  },
                },
              });
            }
            return gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 301,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: page3,
                },
              },
            });
          },
        },
        ...baseHandlers().slice(2),
      ]).fetch,
      user.id,
    );

    const q2Responses = env.store.getIngestResponses(runId).filter((r) => r.query_name === "Q2");
    const page3Resp = q2Responses[2];
    const meta = JSON.parse(page3Resp.metadata);
    assert.equal(meta.hydrate_skipped.PR_capped, "cap");
    const page1Meta = JSON.parse(q2Responses[0].metadata);
    assert.equal(page1Meta.hydrate_skipped, undefined);
  });

  it("Q13 comment primary rate limit stops run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        {
          match: (req) => !!req.body?.includes("ReviewContribSlice"),
          response: () =>
            gqlOk({
              viewer: {
                contributionsCollection: {
                  startedAt: "2024-01-01T00:00:00Z",
                  endedAt: "2025-01-01T00:00:00Z",
                  restrictedContributionsCount: 0,
                  pullRequestReviewContributions: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        occurredAt: new Date().toISOString(),
                        isRestricted: false,
                        pullRequest: { id: "PR_rev" },
                      },
                    ],
                  },
                },
              },
            }),
        },
        ...baseHandlers().slice(3),
        {
          match: (req) => !!req.body?.includes("ReviewsByAuthor"),
          response: () =>
            gqlOk({
              node: {
                id: "PR_rev",
                reviews: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "RV_1",
                      comments: {
                        pageInfo: { hasNextPage: true, endCursor: "c1" },
                        nodes: [{ id: "RC_1" }],
                      },
                    },
                  ],
                },
              },
            }),
        },
        {
          match: (req) => !!req.body?.includes("ReviewComments"),
          response: () => gqlRateLimited(),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("Q13 page-1 missing reviews marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        {
          match: (req) => !!req.body?.includes("ReviewContribSlice"),
          response: () =>
            gqlOk({
              viewer: {
                contributionsCollection: {
                  startedAt: "2024-01-01T00:00:00Z",
                  endedAt: "2025-01-01T00:00:00Z",
                  restrictedContributionsCount: 0,
                  pullRequestReviewContributions: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        occurredAt: new Date().toISOString(),
                        isRestricted: false,
                        pullRequest: { id: "PR_q13p1" },
                      },
                    ],
                  },
                },
              },
            }),
        },
        ...baseHandlers().slice(3),
        {
          match: (req) => !!req.body?.includes("ReviewsByAuthor"),
          response: () => gqlOk({ node: { id: "PR_q13p1" } }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q13 = env.store
      .getIngestResponses(runId)
      .find(
        (r) =>
          r.query_name === "Q13" && JSON.parse(r.variables).id === "PR_q13p1",
      )!;
    assert.equal(JSON.parse(q13.metadata).per_id_failed.PR_q13p1, "reviews_missing");
  });

  it("Q13 review extra page missing reviews marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        {
          match: (req) => !!req.body?.includes("ReviewContribSlice"),
          response: () =>
            gqlOk({
              viewer: {
                contributionsCollection: {
                  startedAt: "2024-01-01T00:00:00Z",
                  endedAt: "2025-01-01T00:00:00Z",
                  restrictedContributionsCount: 0,
                  pullRequestReviewContributions: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        occurredAt: new Date().toISOString(),
                        isRestricted: false,
                        pullRequest: { id: "PR_q13rev" },
                      },
                    ],
                  },
                },
              },
            }),
        },
        ...baseHandlers().slice(3),
        {
          match: (req) => !!req.body?.includes("ReviewsByAuthor"),
          response: (req) => {
            const vars = JSON.parse(req.body ?? "{}").variables as { after?: string };
            if (vars.after) {
              return gqlOk({ node: { id: "PR_q13rev" } });
            }
            return gqlOk({
              node: {
                id: "PR_q13rev",
                reviews: {
                  pageInfo: { hasNextPage: true, endCursor: "r2" },
                  nodes: [
                    {
                      id: "RV_1",
                      comments: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  ],
                },
              },
            });
          },
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q13extra = env.store
      .getIngestResponses(runId)
      .find(
        (r) =>
          r.query_name === "Q13" &&
          JSON.parse(r.variables).id === "PR_q13rev" &&
          JSON.parse(r.variables).after != null,
      )!;
    assert.equal(JSON.parse(q13extra.metadata).per_id_failed.PR_q13rev, "reviews_missing");
  });

  it("Q13 comment extra page missing comments marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        {
          match: (req) => !!req.body?.includes("ReviewContribSlice"),
          response: () =>
            gqlOk({
              viewer: {
                contributionsCollection: {
                  startedAt: "2024-01-01T00:00:00Z",
                  endedAt: "2025-01-01T00:00:00Z",
                  restrictedContributionsCount: 0,
                  pullRequestReviewContributions: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        occurredAt: new Date().toISOString(),
                        isRestricted: false,
                        pullRequest: { id: "PR_q13cmt" },
                      },
                    ],
                  },
                },
              },
            }),
        },
        ...baseHandlers().slice(3),
        {
          match: (req) => !!req.body?.includes("ReviewsByAuthor"),
          response: () =>
            gqlOk({
              node: {
                id: "PR_q13cmt",
                reviews: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "RV_cmt",
                      comments: {
                        pageInfo: { hasNextPage: true, endCursor: "c1" },
                        nodes: [{ id: "RC_1" }],
                      },
                    },
                  ],
                },
              },
            }),
        },
        {
          match: (req) => !!req.body?.includes("ReviewComments"),
          response: () => gqlOk({ node: { id: "RV_cmt" } }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q13comment = env.store
      .getIngestResponses(runId)
      .find(
        (r) =>
          r.query_name === "Q13" && JSON.parse(r.variables).reviewId === "RV_cmt",
      )!;
    assert.equal(JSON.parse(q13comment.metadata).per_id_failed.RV_cmt, "comments_missing");
  });

  it("primary rate limit after Q1 marks partial not failed", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () => gqlRateLimited(),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("records per_node_failures on partial_data index page", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            new Response(
              JSON.stringify({
                data: {
                  viewer: {
                    pullRequests: {
                      totalCount: 1,
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ id: "PR_1", updatedAt: new Date().toISOString() }],
                    },
                  },
                  rateLimit: {
                    cost: 1,
                    remaining: 5000,
                    resetAt: new Date(Date.now() + 3600000).toISOString(),
                  },
                },
                errors: [
                  {
                    path: ["viewer", "pullRequests", "nodes", 0, "title"],
                    message: "field error",
                  },
                ],
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "x-ratelimit-remaining": "5000",
                },
              },
            ),
        },
        ...baseHandlers().slice(2),
      ]).fetch,
      user.id,
    );
    const q2 = env.store.getIngestResponses(runId).find((r) => r.query_name === "Q2")!;
    const meta = JSON.parse(q2.metadata);
    assert.ok(Array.isArray(meta.per_node_failures));
    assert.equal(meta.per_node_failures[0].message, "field error");
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("maps batch error paths to per_id_failed on partial nodes", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_ok",
                      number: 1,
                      updatedAt: now,
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "o/r" },
                    },
                    {
                      id: "PR_err",
                      number: 2,
                      updatedAt: now,
                      state: "OPEN",
                      isDraft: false,
                      merged: false,
                      mergedAt: null,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: (req) => {
            const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
            return new Response(
              JSON.stringify({
                data: {
                  nodes: vars.ids.map((id) =>
                    id === "PR_err" ? { id, labels: null } : { id },
                  ),
                  rateLimit: {
                    cost: 1,
                    remaining: 5000,
                    resetAt: new Date(Date.now() + 3600000).toISOString(),
                  },
                },
                errors: [{ path: ["nodes", 1, "labels"], message: "access denied" }],
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "x-ratelimit-remaining": "5000",
                },
              },
            );
          },
        },
      ]).fetch,
      user.id,
    );
    const q6 = env.store.getIngestResponses(runId).find((r) => r.query_name === "Q6")!;
    const meta = JSON.parse(q6.metadata);
    assert.equal(meta.per_id_failed.PR_ok, "graphql_error");
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("Q7 per-id data.node null marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_files",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_files" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_files",
                  changedFiles: 5,
                  files: {
                    totalCount: 5,
                    pageInfo: { hasNextPage: true, endCursor: "f1" },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrFiles("),
          response: () =>
            gqlOk({ node: null }, 5000),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q7extra = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7" && JSON.parse(r.variables).id === "PR_files")!;
    assert.equal(JSON.parse(q7extra.metadata).per_id_failed.PR_files, "node_null");
  });

  it("Q7 per-id node null with errors marks partial without throwing", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_err",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_err" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_err",
                  changedFiles: 5,
                  files: {
                    totalCount: 5,
                    pageInfo: { hasNextPage: true, endCursor: "f1" },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrFiles("),
          response: () =>
            new Response(
              JSON.stringify({
                data: {
                  node: null,
                  rateLimit: {
                    cost: 1,
                    remaining: 5000,
                    resetAt: new Date(Date.now() + 3600000).toISOString(),
                  },
                },
                errors: [{ message: "Could not resolve to a node", path: ["node"] }],
              }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "x-ratelimit-remaining": "5000",
                },
              },
            ),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q7extra = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7" && JSON.parse(r.variables).id === "PR_err")!;
    assert.equal(JSON.parse(q7extra.metadata).per_id_failed.PR_err, "node_null");
  });

  it("Q7 per-id missing data.node marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_nou",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_nou" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_nou",
                  changedFiles: 5,
                  files: {
                    totalCount: 5,
                    pageInfo: { hasNextPage: true, endCursor: "f1" },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrFiles("),
          response: () => gqlOk({}),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q7extra = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7" && JSON.parse(r.variables).id === "PR_nou")!;
    assert.equal(JSON.parse(q7extra.metadata).per_id_failed.PR_nou, "node_null");
  });

  it("secondary on hydrate retry does not yield complete", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();
    let q9Calls = 0;

    const secondary = () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: "secondary rate limit" }],
          rateLimit: {
            cost: 1,
            remaining: 5000,
            resetAt: new Date(Date.now() + 3600000).toISOString(),
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-remaining": "3000",
          },
        },
      );

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_sec",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_sec" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_sec",
                  changedFiles: 0,
                  files: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrCommentsBatch"),
          response: () => {
            q9Calls++;
            if (q9Calls === 1) return gqlError("transient");
            return secondary();
          },
        },
      ]).fetch,
      user.id,
    );
    assert.ok(q9Calls >= 2);
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("Q9 batch page-1 missing comments marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_q9",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_q9" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_q9",
                  changedFiles: 0,
                  files: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrCommentsBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_q9" }] }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q9 = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q9")!;
    assert.equal(JSON.parse(q9.metadata).per_id_failed.PR_q9, "comments_missing");
  });

  it("Q7 batch page-1 missing files marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_b1",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_b1" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_b1" }] }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q7batch = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7" && JSON.parse(r.variables).ids != null)!;
    assert.equal(JSON.parse(q7batch.metadata).per_id_failed.PR_b1, "files_missing");
  });

  it("Q7 extra page missing files marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PR_nof",
                      number: 1,
                      updatedAt: now,
                      state: "MERGED",
                      isDraft: false,
                      merged: true,
                      mergedAt: now,
                      repository: { nameWithOwner: "o/r" },
                    },
                  ],
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: () => gqlOk({ nodes: [{ id: "PR_nof" }] }),
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: () =>
            gqlOk({
              nodes: [
                {
                  id: "PR_nof",
                  changedFiles: 5,
                  files: {
                    totalCount: 5,
                    pageInfo: { hasNextPage: true, endCursor: "f1" },
                    nodes: [{ path: "a.ts" }],
                  },
                },
              ],
            }),
        },
        {
          match: (req) => !!req.body?.includes("PrFiles("),
          response: () => gqlOk({ node: { id: "PR_nof" } }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q7extra = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q7" && JSON.parse(r.variables).id === "PR_nof")!;
    assert.equal(JSON.parse(q7extra.metadata).per_id_failed.PR_nof, "files_missing");
  });

  it("Q12 repository null marks partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        ...baseHandlers().slice(0, 4),
        {
          match: (req) => !!req.body?.includes("ViewerIssueComments"),
          response: () =>
            gqlOk({
              viewer: {
                issueComments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "C1",
                      pullRequest: null,
                      issue: {
                        number: 77,
                        url: "https://github.com/acme/app/pull/77",
                        repository: { owner: { login: "acme" }, name: "app" },
                      },
                    },
                  ],
                },
              },
            }),
        },
        {
          match: (req) => !!req.body?.includes("IssueOrPr"),
          response: () => gqlOk({ repository: null }),
        },
      ]).fetch,
      user.id,
    );
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
    const q12 = env.store.getIngestResponses(runId).find((r) => r.query_name === "Q12")!;
    assert.ok(q12);
    const payload = JSON.parse(q12.payload);
    assert.equal(payload.data.repository, null);
  });

  it("Q12 fallback splits nameWithOwner when owner.login missing", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers().slice(0, 4),
      {
        match: (req) => !!req.body?.includes("ViewerIssueComments"),
        response: () =>
          gqlOk({
            viewer: {
              issueComments: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "C1",
                    pullRequest: null,
                    issue: {
                      number: 77,
                      url: "https://github.com/acme/app/pull/77",
                      repository: {
                        owner: null,
                        nameWithOwner: "acme/app",
                      },
                    },
                  },
                ],
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("IssueOrPr"),
        response: (req) => {
          const vars = JSON.parse(req.body ?? "{}").variables as {
            owner: string;
            name: string;
            number: number;
          };
          assert.equal(vars.owner, "acme");
          assert.equal(vars.name, "app");
          assert.equal(vars.number, 77);
          return gqlOk({
            repository: {
              pullRequest: {
                id: "PR_stub",
                number: 77,
                url: "https://github.com/acme/app/pull/77",
              },
            },
          });
        },
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const q12Rows = env.store.getIngestResponses(runId).filter((r) => r.query_name === "Q12");
    assert.equal(q12Rows.length, 1);
    assert.equal(JSON.parse(q12Rows[0]!.variables).owner, "acme");
    assert.equal(JSON.parse(q12Rows[0]!.variables).name, "app");
    assert.equal(JSON.parse(q12Rows[0]!.variables).number, 77);
    assert.equal(env.store.getIngestRun(runId)!.status, "complete");
  });

  it("502 shrink recurses 6 ids down to 5 and 1", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const now = new Date().toISOString();
    const ids = Array.from({ length: 6 }, (_, i) => `PR_${i}`);
    const batchSizes: number[] = [];
    const batchFailCounts = new Map<string, number>();

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        {
          match: (req) => !!req.body?.includes("ViewerPullRequests"),
          response: () =>
            gqlOk({
              viewer: {
                pullRequests: {
                  totalCount: 6,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: ids.map((id, i) => ({
                    id,
                    number: i,
                    updatedAt: now,
                    state: "OPEN",
                    isDraft: false,
                    merged: false,
                    mergedAt: null,
                    repository: { nameWithOwner: "o/r" },
                  })),
                },
              },
            }),
        },
        ...baseHandlers().slice(2),
        {
          match: (req) => !!req.body?.includes("PrCoreBatch"),
          response: (req) => {
            const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
            batchSizes.push(vars.ids.length);
            const key = vars.ids.join(",");
            const fails = batchFailCounts.get(key) ?? 0;
            if (vars.ids.length >= 6 && fails < 2) {
              batchFailCounts.set(key, fails + 1);
              return new Response("", { status: 502 });
            }
            if (vars.ids.length === 5 && fails < 2) {
              batchFailCounts.set(key, fails + 1);
              return new Response("", { status: 502 });
            }
            return gqlOk({ nodes: vars.ids.map((id) => ({ id })) });
          },
        },
        {
          match: (req) => !!req.body?.includes("PrFilesBatch"),
          response: (req) => {
            const vars = JSON.parse(req.body ?? "{}").variables as { ids: string[] };
            return gqlOk({
              nodes: vars.ids.map((id) => ({
                id,
                changedFiles: 0,
                files: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              })),
            });
          },
        },
      ]).fetch,
      user.id,
    );
    assert.ok(batchSizes.includes(6));
    assert.ok(batchSizes.includes(5));
    assert.ok(batchSizes.includes(1));
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("Q5 records index_dropped for non-Issue and pull urls", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const runId = await runTestIngest(
      env.store,
      createMockFetch([
        baseHandlers()[0],
        baseHandlers()[1],
        ...baseHandlers().slice(2, 3),
        {
          match: (req) => !!req.body?.includes("ViewerIssues"),
          response: () =>
            gqlOk({
              viewer: {
                issues: {
                  totalCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "PullRequest",
                      id: "I_pr",
                      url: "https://github.com/o/r/pull/1",
                      createdAt: new Date().toISOString(),
                    },
                    {
                      __typename: "Issue",
                      id: "I_ok",
                      url: "https://github.com/o/r/issues/2",
                      createdAt: new Date().toISOString(),
                    },
                  ],
                },
              },
            }),
        },
        baseHandlers()[4],
      ]).fetch,
      user.id,
    );
    const q5 = env.store.getIngestResponses(runId).find((r) => r.query_name === "Q5")!;
    const meta = JSON.parse(q5.metadata);
    assert.equal(meta.index_dropped.I_pr, "not_issue");
  });

  it("analyzeNodesBatch maps nodes error index", () => {
    assert.equal(extractNodesIndexFromPath(["nodes", 2, "labels"]), 2);
    const failed = analyzeNodesBatch(
      {
        data: { nodes: [{ id: "A" }, { id: "B" }] },
        errors: [{ path: ["nodes", 1], message: "x" }],
      },
      ["A", "B"],
    );
    assert.equal(failed.B, "graphql_error");
  });

  it("MAX_IN_FLIGHT is 2", () => {
    assert.equal(MAX_IN_FLIGHT, 2);
  });
});

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createTestEnv,
  createTestUser,
  createMockFetch,
  runTestIngest,
  gqlOk,
  gqlError,
} from "./helpers.js";
import { Q4_CONTRIB_YEAR, Q7_PR_FILES } from "../src/github/queries.js";
import { payloadContainsToken } from "../src/github/client.js";

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
      match: (req: { body?: string }) =>
        !!req.body?.includes("ViewerProfile"),
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
        gqlOk({
          viewer: { pullRequests: emptyPageConnection() },
        }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ViewerIssueComments"),
      response: () =>
        gqlOk({
          viewer: { issueComments: emptyPageConnection() },
        }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ContributionYears"),
      response: () =>
        gqlOk({
          viewer: {
            contributionsCollection: { contributionYears: [2024] },
          },
        }),
    },
    {
      match: (req: { body?: string }) =>
        !!req.body?.includes("ViewerIssues"),
      response: () =>
        gqlOk({
          viewer: { issues: emptyPageConnection() },
        }),
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
    const run = env.store.getIngestRun(runId)!;
    assert.equal(run.status, "failed");
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
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const run = env.store.getIngestRun(runId)!;
    assert.equal(run.github_user_id, "MDQ6VXNlcjE");
  });

  it("marks run partial on per-id hydrate failure and still runs Q7 after Q6 failure", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    let prCoreCalls = 0;
    let q7Calls = 0;
    const handlers = baseHandlers().filter(
      (h) => !h.match({ body: '{"query":"ViewerPullRequests"}' }),
    );
    handlers.splice(1, 0, {
      match: (req) => !!req.body?.includes("ViewerPullRequests"),
      response: () =>
        gqlOk({
          viewer: {
            pullRequests: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: "c1" },
              nodes: [
                {
                  id: "PR_abc",
                  number: 1,
                  url: "https://github.com/o/r/pull/1",
                  repository: { nameWithOwner: "o/r" },
                },
              ],
            },
          },
        }),
    });
    handlers.push({
      match: (req) => !!req.body?.includes("PrCore"),
      response: () => {
        prCoreCalls++;
        return gqlError("Node not found");
      },
    });
    handlers.push({
      match: (req) => !!req.body?.includes("PrFiles"),
      response: () => {
        q7Calls++;
        return gqlOk({
          node: {
            changedFiles: 0,
            files: emptyPageConnection(),
          },
        });
      },
    });

    const { fetch } = createMockFetch(handlers);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const run = env.store.getIngestRun(runId)!;
    assert.equal(run.status, "partial");
    assert.ok(prCoreCalls >= 2);
    assert.ok(q7Calls >= 1);
  });

  it("retries contribution year with Dec 30 on 1-year error", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const capturedVars: Record<string, unknown>[] = [];

    const handlers = baseHandlers().filter(
      (h) => !h.match({ body: "ContribYear" }),
    );
    handlers.push({
      match: (req) => !!req.body?.includes("ContribYear"),
      response: (req) => {
        const vars = JSON.parse(req.body ?? "{}").variables as {
          to?: string;
        };
        if (vars.to?.includes("12-31")) {
          return gqlError("Date range must not exceed 1 year.");
        }
        return gqlOk({
          viewer: {
            contributionsCollection: {
              startedAt: "2024-01-01T00:00:00Z",
              endedAt: "2024-12-30T23:59:59Z",
              contributionCalendar: { totalContributions: 100, weeks: [] },
              totalCommitContributions: 0,
              totalPullRequestContributions: 0,
              totalPullRequestReviewContributions: 0,
              restrictedContributionsCount: 0,
              commitContributionsByRepository: [],
              pullRequestReviewContributions: emptyPageConnection(),
            },
          },
        });
      },
    });

    const { fetch: innerFetch } = createMockFetch(handlers);
    const fetch = (async (input, init) => {
      const body = init?.body?.toString() ?? "";
      if (body.includes("ContribYear")) {
        capturedVars.push(JSON.parse(body).variables);
      }
      return innerFetch(input, init);
    }) as typeof fetch;

    await runTestIngest(env.store, fetch, user.id);

    const dec31Attempt = capturedVars.find((v) =>
      String(v.to).includes("12-31"),
    );
    const dec30Attempt = capturedVars.find((v) =>
      String(v.to).includes("12-30"),
    );
    assert.ok(dec31Attempt);
    assert.ok(dec30Attempt);
  });

  it("Q4 stores raw payload with calendar_not_a_signal metadata", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 50, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const responses = env.store.getIngestResponses(runId);
    const q4 = responses.filter((r) => r.query_name === "Q4");
    assert.ok(q4.length > 0);
    assert.ok(!responses.some((r) => r.query_name === "Q4_calendar"));
    assert.ok(!responses.some((r) => r.query_name === "Q4_years"));
    const contribPage = q4.find((r) =>
      JSON.parse(r.variables).from != null,
    )!;
    assert.equal(contribPage.not_a_signal, 0);
    assert.equal(
      JSON.parse(contribPage.metadata).calendar_not_a_signal,
      true,
    );
    const payload = JSON.parse(contribPage.payload);
    assert.ok(payload.data?.viewer?.contributionsCollection?.contributionCalendar);
  });

  it("stops Q4 pagination on empty nodes even if hasNextPage", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    let q4Calls = 0;
    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () => {
          q4Calls++;
          return gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: true, endCursor: "trap" },
                  nodes: [],
                },
              },
            },
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(q4Calls, 1);
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
                      issue: {
                        number: 42,
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
    handlers.push({
      match: (req) => !!req.body?.includes("ContribYear"),
      response: () =>
        gqlOk({
          viewer: {
            contributionsCollection: {
              startedAt: "2024-01-01T00:00:00Z",
              endedAt: "2024-12-31T23:59:59Z",
              contributionCalendar: { totalContributions: 0, weeks: [] },
              totalCommitContributions: 0,
              totalPullRequestContributions: 0,
              totalPullRequestReviewContributions: 0,
              restrictedContributionsCount: 0,
              commitContributionsByRepository: [],
              pullRequestReviewContributions: emptyPageConnection(),
            },
          },
        }),
    });

    const { fetch, order } = createMockFetch(handlers);
    await runTestIngest(env.store, fetch, user.id);
    assert.equal(order.filter((q) => q === "Q12").length, 0);
  });

  it("Q14 REST failure marks run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 1,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [
                  {
                    repository: {
                      owner: { login: "acme" },
                      name: "app",
                      nameWithOwner: "acme/app",
                    },
                    contributions: { totalCount: 1 },
                  },
                ],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("RepoAuthorHistory"),
        response: () =>
          gqlOk({
            repository: {
              id: "R1",
              nameWithOwner: "acme/app",
              defaultBranchRef: {
                name: "main",
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ oid: "abc123" }],
                  },
                },
              },
            },
          }),
      },
      {
        match: (req) => req.url.includes("/commits/abc123"),
        response: () =>
          new Response("not json", { status: 404 }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("stops Q13 pagination on empty review nodes even if hasNextPage", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    let q13Calls = 0;
    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 1,
                totalPullRequestReviewContributions: 1,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ pullRequest: { id: "PR_reviewed" } }],
                },
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("ReviewsByAuthor"),
        response: () => {
          q13Calls++;
          return gqlOk({
            node: {
              reviews: {
                pageInfo: { hasNextPage: true, endCursor: "trap" },
                nodes: [],
              },
            },
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(q13Calls, 1);
  });

  it("stops Q14 pagination on empty history nodes even if hasNextPage", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    let q14Calls = 0;
    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 1,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [
                  {
                    repository: {
                      owner: { login: "acme" },
                      name: "app",
                      nameWithOwner: "acme/app",
                    },
                    contributions: { totalCount: 1 },
                  },
                ],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("RepoAuthorHistory"),
        response: () => {
          q14Calls++;
          return gqlOk({
            repository: {
              id: "R1",
              nameWithOwner: "acme/app",
              defaultBranchRef: {
                name: "main",
                target: {
                  history: {
                    pageInfo: { hasNextPage: true, endCursor: "trap" },
                    nodes: [],
                  },
                },
              },
            },
          });
        },
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);
    assert.equal(q14Calls, 1);
  });

  it("never uses synthetic GitHub payloads", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 1,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [
                  {
                    repository: {
                      owner: { login: "acme" },
                      name: "empty",
                      nameWithOwner: "acme/empty",
                    },
                    contributions: { totalCount: 1 },
                  },
                ],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("RepoAuthorHistory"),
        response: () =>
          gqlOk({
            repository: {
              id: "R2",
              nameWithOwner: "acme/empty",
              defaultBranchRef: null,
            },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    for (const resp of env.store.getIngestResponses(runId)) {
      const payload = JSON.parse(resp.payload);
      assert.ok(!("contributionCalendar" in payload && !("data" in payload)));
      assert.ok(!("error" in payload && !("data" in payload) && !("errors" in payload)));
      if (payload !== null && typeof payload === "object") {
        assert.ok(!("raw" in payload));
      }
    }
    const q14 = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "Q14" && JSON.parse(r.metadata).error);
    assert.ok(q14);
    assert.ok(JSON.parse(q14!.payload).data?.repository);
  });

  it("REST non-JSON stores null payload with parse_error metadata", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 1,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [
                  {
                    repository: {
                      owner: { login: "acme" },
                      name: "app",
                      nameWithOwner: "acme/app",
                    },
                    contributions: { totalCount: 1 },
                  },
                ],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("RepoAuthorHistory"),
        response: () =>
          gqlOk({
            repository: {
              id: "R1",
              nameWithOwner: "acme/app",
              defaultBranchRef: {
                name: "main",
                target: {
                  history: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ oid: "abc123deadbeef" }],
                  },
                },
              },
            },
          }),
      },
      {
        match: (req) => req.url.includes("/commits/abc123deadbeef"),
        response: () =>
          new Response("upstream HTML error page", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    const rest = env.store
      .getIngestResponses(runId)
      .find((r) => r.query_name === "rest_commit_files");
    assert.ok(rest);
    assert.equal(JSON.parse(rest!.payload), null);
    const meta = JSON.parse(rest!.metadata);
    assert.equal(meta.parse_error, true);
    assert.equal(meta.http_status, 502);
  });

  it("query_name is only Q1-Q14 or rest_commit_files", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const { fetch } = createMockFetch([...baseHandlers(), {
      match: (req) => !!req.body?.includes("ContribYear"),
      response: () =>
        gqlOk({
          viewer: {
            contributionsCollection: {
              startedAt: "2024-01-01T00:00:00Z",
              endedAt: "2024-12-31T23:59:59Z",
              contributionCalendar: { totalContributions: 0, weeks: [] },
              totalCommitContributions: 0,
              totalPullRequestContributions: 0,
              totalPullRequestReviewContributions: 0,
              restrictedContributionsCount: 0,
              commitContributionsByRepository: [],
              pullRequestReviewContributions: emptyPageConnection(),
            },
          },
        }),
    }]);
    const runId = await runTestIngest(env.store, fetch, user.id);
    const allowed = /^(Q([1-9]|1[0-4])|rest_commit_files)$/;
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
    const run = env.store.getLatestRunForUser(user.id)!;
    assert.equal(run.status, "partial");
    assert.ok(q2Calls >= 1);
  });

  it("Q14 defaultBranchRef null marks run partial", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 1,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [
                  {
                    repository: {
                      owner: { login: "acme" },
                      name: "empty",
                      nameWithOwner: "acme/empty",
                    },
                    contributions: { totalCount: 1 },
                  },
                ],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
      {
        match: (req) => !!req.body?.includes("RepoAuthorHistory"),
        response: () =>
          gqlOk({
            repository: {
              id: "R2",
              nameWithOwner: "acme/empty",
              defaultBranchRef: null,
            },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    assert.equal(env.store.getIngestRun(runId)!.status, "partial");
  });

  it("runs Q2-Q5 sequentially not in parallel", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const { fetch, order } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
    ]);

    await runTestIngest(env.store, fetch, user.id);

    const q2Idx = order.indexOf("Q2");
    const q3Idx = order.indexOf("Q3");
    const q4Idx = order.indexOf("Q4");
    const q5Idx = order.indexOf("Q5");
    assert.ok(q2Idx > -1);
    assert.ok(q3Idx > q2Idx);
    assert.ok(q4Idx > q3Idx);
    assert.ok(q5Idx > q4Idx);
  });

  it("never stores access token in ingest payloads", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);
    const token = "gho_test_token_secret";

    const { fetch } = createMockFetch([
      ...baseHandlers(),
      {
        match: (req) => !!req.body?.includes("ContribYear"),
        response: () =>
          gqlOk({
            viewer: {
              contributionsCollection: {
                startedAt: "2024-01-01T00:00:00Z",
                endedAt: "2024-12-31T23:59:59Z",
                contributionCalendar: { totalContributions: 0, weeks: [] },
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestReviewContributions: emptyPageConnection(),
              },
            },
          }),
      },
    ]);

    const runId = await runTestIngest(env.store, fetch, user.id);
    for (const resp of env.store.getIngestResponses(runId)) {
      assert.equal(payloadContainsToken(JSON.parse(resp.payload), token), false);
      assert.ok(!resp.payload.includes(token));
    }
  });

  it("Q4 query document has maxRepositories 100", () => {
    assert.ok(Q4_CONTRIB_YEAR.includes("maxRepositories: 100"));
  });

  it("Q7 uses Page fragment", () => {
    assert.ok(Q7_PR_FILES.includes("pageInfo { ...Page }"));
  });

  it("Q7 sets truncated metadata when files.totalCount < changedFiles", async () => {
    env = createTestEnv();
    const user = createTestUser(env.store, env.encryption);

    const handlers = baseHandlers().filter(
      (h) => !h.match({ body: "ViewerPullRequests" }),
    );
    handlers.splice(1, 0, {
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
                  repository: { nameWithOwner: "o/r" },
                },
              ],
            },
          },
        }),
    });
    handlers.push({
      match: (req) => !!req.body?.includes("PrCore"),
      response: () =>
        gqlOk({ node: { id: "PR_trunc", changedFiles: 10 } }),
    });
    handlers.push({
      match: (req) => !!req.body?.includes("PrFiles"),
      response: () =>
        gqlOk({
          node: {
            changedFiles: 10,
            files: {
              totalCount: 3,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ path: "a.ts" }],
            },
          },
        }),
    });

    const runId = await runTestIngest(env.store, createMockFetch(handlers).fetch, user.id);
    const q7 = env.store
      .getIngestResponses(runId)
      .filter((r) => r.query_name === "Q7");
    assert.ok(q7.length > 0);
    const meta = JSON.parse(q7[q7.length - 1].metadata);
    assert.equal(meta.truncated, true);
  });
});

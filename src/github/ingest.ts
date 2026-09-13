import type { Store } from "../db/store.js";
import type { RunStatus } from "../db/schema.js";
import { IngestAlreadyRunningError } from "../errors.js";
import {
  GitHubClient,
  getNested,
  paginateConnection,
  isRestFailure,
  extractConnectionFirst,
} from "./client.js";
import {
  Q1_VIEWER_PROFILE,
  Q2_VIEWER_PULL_REQUESTS,
  Q3_VIEWER_ISSUE_COMMENTS,
  Q4_CONTRIBUTION_YEARS,
  Q4_CONTRIB_YEAR,
  Q5_VIEWER_ISSUES,
  Q6_PR_CORE,
  Q7_PR_FILES,
  Q8_PR_COMMITS,
  Q9_PR_COMMENTS,
  Q10_PR_REVIEWS,
  Q11_PR_THREADS,
  Q11_THREAD_COMMENTS,
  Q12_ISSUE_OR_PR,
  Q13_REVIEWS_BY_AUTHOR,
  Q13_REVIEW_COMMENTS,
  Q14_REPO_AUTHOR_HISTORY,
} from "./queries.js";

export { IngestAlreadyRunningError };

export interface IngestContext {
  store: Store;
  client: GitHubClient;
  ingestRunId: number;
  viewerLogin: string;
  viewerId: string;
  githubUserId: string;
}

function hasOneYearError(payload: unknown): boolean {
  const errors = (payload as { errors?: Array<{ message: string }> })?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) =>
    e.message.toLowerCase().includes("must not exceed 1 year"),
  );
}

function prRefKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`;
}

function collectPrIdsFromQ2(payload: unknown): Set<string> {
  const ids = new Set<string>();
  const nodes = getNested(payload, [
    "data",
    "viewer",
    "pullRequests",
    "nodes",
  ]) as Array<{ id: string }> | undefined;
  if (nodes) {
    for (const n of nodes) {
      if (n.id) ids.add(n.id);
    }
  }
  return ids;
}

function collectQ2PrRefs(store: Store, ingestRunId: number): Set<string> {
  const refs = new Set<string>();
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q2") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, [
      "data",
      "viewer",
      "pullRequests",
      "nodes",
    ]) as Array<{
      number: number;
      repository?: { nameWithOwner?: string };
    }> | undefined;
    for (const n of nodes ?? []) {
      const nwo = n.repository?.nameWithOwner;
      if (nwo && n.number != null) {
        const [owner, name] = nwo.split("/");
        if (owner && name) refs.add(prRefKey(owner, name, n.number));
      }
    }
  }
  return refs;
}

function collectIssueCommentRefs(
  store: Store,
  ingestRunId: number,
): Array<{ owner: string; name: string; number: number }> {
  const responses = store.getIngestResponses(ingestRunId);
  const seen = new Set<string>();
  const refs: Array<{ owner: string; name: string; number: number }> = [];

  for (const resp of responses) {
    if (resp.query_name !== "Q3") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, [
      "data",
      "viewer",
      "issueComments",
      "nodes",
    ]) as Array<{
      issue?: {
        number: number;
        repository?: { owner?: { login: string }; name: string };
      };
    }> | undefined;
    if (!nodes) continue;
    for (const n of nodes) {
      const repo = n.issue?.repository;
      const number = n.issue?.number;
      if (!repo?.owner?.login || !repo.name || number == null) continue;
      const key = prRefKey(repo.owner.login, repo.name, number);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ owner: repo.owner.login, name: repo.name, number });
    }
  }
  return refs;
}

function collectReviewPrIds(store: Store, ingestRunId: number): Set<string> {
  const ids = new Set<string>();
  const responses = store.getIngestResponses(ingestRunId);
  for (const resp of responses) {
    if (resp.query_name !== "Q4") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, [
      "data",
      "viewer",
      "contributionsCollection",
      "pullRequestReviewContributions",
      "nodes",
    ]) as Array<{ pullRequest?: { id: string } }> | undefined;
    if (!nodes) continue;
    for (const n of nodes) {
      if (n.pullRequest?.id) ids.add(n.pullRequest.id);
    }
  }
  return ids;
}

function collectCommitRepos(
  store: Store,
  ingestRunId: number,
): Array<{ owner: string; name: string }> {
  const seen = new Set<string>();
  const repos: Array<{ owner: string; name: string }> = [];
  const responses = store.getIngestResponses(ingestRunId);
  for (const resp of responses) {
    if (resp.query_name !== "Q4") continue;
    const payload = JSON.parse(resp.payload);
    const items = getNested(payload, [
      "data",
      "viewer",
      "contributionsCollection",
      "commitContributionsByRepository",
    ]) as Array<{
      repository?: { owner?: { login: string }; name: string };
    }> | undefined;
    if (!items) continue;
    for (const item of items) {
      const repo = item.repository;
      if (!repo?.owner?.login || !repo.name) continue;
      const key = `${repo.owner.login}/${repo.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push({ owner: repo.owner.login, name: repo.name });
    }
  }
  return repos;
}

function collectPrCommitOids(store: Store, ingestRunId: number): Set<string> {
  const oids = new Set<string>();
  const responses = store.getIngestResponses(ingestRunId);
  for (const resp of responses) {
    if (resp.query_name !== "Q8") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, [
      "data",
      "node",
      "commits",
      "nodes",
    ]) as Array<{ commit?: { oid: string } }> | undefined;
    if (!nodes) continue;
    for (const n of nodes) {
      if (n.commit?.oid) oids.add(n.commit.oid);
    }
  }
  return oids;
}

function collectAllPrIdsFromQ2(store: Store, ingestRunId: number): string[] {
  const ids = new Set<string>();
  const responses = store.getIngestResponses(ingestRunId);
  for (const resp of responses) {
    if (resp.query_name !== "Q2") continue;
    const payload = JSON.parse(resp.payload);
    const pageIds = collectPrIdsFromQ2(payload);
    for (const id of pageIds) ids.add(id);
  }
  return [...ids];
}

async function paginateQ7Files(
  client: GitHubClient,
  store: Store,
  ingestRunId: number,
  prId: string,
): Promise<boolean> {
  const buffered: Array<{
    variables: Record<string, unknown>;
    httpStatus: number;
    payload: unknown;
  }> = [];

  let after: string | null = null;
  let hasNextPage = true;
  let anyFailure = false;
  const connectionField = "files";
  const first = extractConnectionFirst(Q7_PR_FILES, connectionField);

  while (hasNextPage) {
    const variables = { id: prId, after };

    let attempt = await client.graphql(Q7_PR_FILES, variables, {
      first,
      connectionField,
    });
    buffered.push({
      variables,
      httpStatus: attempt.httpStatus,
      payload: attempt.body,
    });
    store.touchIngestRunHeartbeat(ingestRunId);

    let hasErrors =
      Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;

    if (hasErrors || attempt.httpStatus >= 400) {
      await client.delay(2000);
      attempt = await client.graphql(Q7_PR_FILES, variables, {
        first,
        connectionField,
      });
      buffered.push({
        variables,
        httpStatus: attempt.httpStatus,
        payload: attempt.body,
      });
      store.touchIngestRunHeartbeat(ingestRunId);
      hasErrors =
        Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;
      if (hasErrors || attempt.httpStatus >= 400) {
        anyFailure = true;
        break;
      }
    }

    const data = attempt.body.data;
    const parent = getNested(data, ["node"]);
    if (parent == null) {
      anyFailure = true;
      break;
    }

    const connection = getNested(data, ["node", "files"]) as
      | { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes?: unknown[] }
      | undefined;

    if (!connection) {
      anyFailure = true;
      break;
    }

    const nodes = connection.nodes ?? [];
    if (nodes.length === 0) break;

    hasNextPage = connection.pageInfo?.hasNextPage ?? false;
    after = connection.pageInfo?.endCursor ?? null;
    if (!hasNextPage) break;
  }

  let changedFiles = 0;
  let filesTotalCount = 0;
  let lastPageHasNext = false;
  for (const page of buffered) {
    const node = getNested(page.payload, ["data", "node"]) as {
      changedFiles?: number;
      files?: {
        totalCount?: number;
        pageInfo?: { hasNextPage: boolean };
      };
    } | null;
    if (node?.changedFiles != null) changedFiles = node.changedFiles;
    if (node?.files?.totalCount != null) filesTotalCount = node.files.totalCount;
    lastPageHasNext = node?.files?.pageInfo?.hasNextPage ?? false;
  }
  const truncated = !lastPageHasNext && filesTotalCount < changedFiles;

  for (let i = 0; i < buffered.length; i++) {
    store.insertIngestResponse({
      ingestRunId,
      fetchedAt: new Date().toISOString(),
      queryName: "Q7",
      variables: buffered[i].variables,
      httpStatus: buffered[i].httpStatus,
      payload: buffered[i].payload,
      metadata:
        truncated && i === buffered.length - 1 ? { truncated: true } : undefined,
    });
  }

  return !anyFailure;
}

async function hydratePr(ctx: IngestContext, prId: string): Promise<boolean> {
  const { store, client, ingestRunId } = ctx;
  let anyFailure = false;

  const q6 = await client.graphqlWithRetry(Q6_PR_CORE, { id: prId });
  store.insertIngestResponse({
    ingestRunId,
    fetchedAt: new Date().toISOString(),
    queryName: "Q6",
    variables: { id: prId },
    httpStatus: q6.httpStatus,
    payload: q6.payload,
  });
  store.touchIngestRunHeartbeat(ingestRunId);
  if (!q6.success) anyFailure = true;

  const q7ok = await paginateQ7Files(client, store, ingestRunId, prId);
  if (!q7ok) anyFailure = true;

  for (const [queryName, query, path] of [
    ["Q8", Q8_PR_COMMITS, ["node", "commits"]] as const,
    ["Q9", Q9_PR_COMMENTS, ["node", "comments"]] as const,
    ["Q10", Q10_PR_REVIEWS, ["node", "reviews"]] as const,
    ["Q11", Q11_PR_THREADS, ["node", "reviewThreads"]] as const,
  ]) {
    const result = await paginateConnection(
      client,
      store,
      ingestRunId,
      queryName,
      query,
      { id: prId },
      [...path],
    );
    if (!result.success) anyFailure = true;
  }

  const q11Responses = store
    .getIngestResponses(ingestRunId)
    .filter((r) => r.query_name === "Q11" && r.variables.includes(prId));
  for (const resp of q11Responses) {
    const payload = JSON.parse(resp.payload);
    const threads = getNested(payload, [
      "data",
      "node",
      "reviewThreads",
      "nodes",
    ]) as Array<{
      id: string;
      comments?: { pageInfo?: { hasNextPage: boolean } };
    }> | undefined;
    if (!threads) continue;
    for (const thread of threads) {
      if (!thread.comments?.pageInfo?.hasNextPage) continue;
      const threadResult = await paginateConnection(
        client,
        store,
        ingestRunId,
        "Q11",
        Q11_THREAD_COMMENTS,
        { threadId: thread.id },
        ["node", "comments"],
      );
      if (!threadResult.success) anyFailure = true;
    }
  }

  return !anyFailure;
}

async function runQ4(ctx: IngestContext): Promise<boolean> {
  const { store, client, ingestRunId } = ctx;
  let anyFailure = false;

  const yearsResult = await client.graphqlWithRetry(Q4_CONTRIBUTION_YEARS, {});
  store.insertIngestResponse({
    ingestRunId,
    fetchedAt: new Date().toISOString(),
    queryName: "Q4",
    variables: {},
    httpStatus: yearsResult.httpStatus,
    payload: yearsResult.payload,
  });
  store.touchIngestRunHeartbeat(ingestRunId);
  if (!yearsResult.success) return false;

  const years = getNested(yearsResult.payload, [
    "data",
    "viewer",
    "contributionsCollection",
    "contributionYears",
  ]) as number[] | undefined;

  if (!years || years.length === 0) return true;

  for (const year of years) {
    let from = `${year}-01-01T00:00:00Z`;
    let to = `${year}-12-31T23:59:59Z`;

    let reviewAfter: string | null = null;
    let yearDone = false;

    while (!yearDone) {
      const variables = { from, to, reviewAfter };
      const result = await client.graphqlWithRetry(
        Q4_CONTRIB_YEAR,
        variables,
        "pullRequestReviewContributions",
      );

      if (
        !result.success &&
        hasOneYearError(result.payload) &&
        to.includes("12-31")
      ) {
        to = `${year}-12-30T23:59:59Z`;
        continue;
      }

      store.insertIngestResponse({
        ingestRunId,
        fetchedAt: new Date().toISOString(),
        queryName: "Q4",
        variables,
        httpStatus: result.httpStatus,
        payload: result.payload,
        notASignal: false,
        metadata: { calendar_not_a_signal: true },
      });
      store.touchIngestRunHeartbeat(ingestRunId);

      if (!result.success) {
        anyFailure = true;
        yearDone = true;
        continue;
      }

      const reviewConn = getNested(result.payload, [
        "data",
        "viewer",
        "contributionsCollection",
        "pullRequestReviewContributions",
      ]) as {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        nodes?: unknown[];
      };

      const nodes = reviewConn?.nodes ?? [];
      if (nodes.length === 0) {
        yearDone = true;
        break;
      }

      if (reviewConn?.pageInfo?.hasNextPage) {
        reviewAfter = reviewConn.pageInfo.endCursor;
      } else {
        yearDone = true;
      }
    }
  }

  return !anyFailure;
}

async function runQ5Filtered(ctx: IngestContext): Promise<boolean> {
  const { store, client, ingestRunId } = ctx;
  let after: string | null = null;
  let hasNextPage = true;
  let anyFailure = false;

  while (hasNextPage) {
    const variables = { after };
    const result = await client.graphqlWithRetry(Q5_VIEWER_ISSUES, variables);

    store.insertIngestResponse({
      ingestRunId,
      fetchedAt: new Date().toISOString(),
      queryName: "Q5",
      variables,
      httpStatus: result.httpStatus,
      payload: result.payload,
    });
    store.touchIngestRunHeartbeat(ingestRunId);

    if (!result.success) {
      anyFailure = true;
      break;
    }

    const connection = getNested(result.payload, ["data", "viewer", "issues"]) as {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes?: unknown[];
    };

    const nodes = connection?.nodes ?? [];
    if (nodes.length === 0) break;

    const pageInfo = connection?.pageInfo;
    hasNextPage = pageInfo?.hasNextPage ?? false;
    after = pageInfo?.endCursor ?? null;
    if (!hasNextPage) break;
  }

  return !anyFailure;
}

export async function runIngest(
  store: Store,
  client: GitHubClient,
  userId: number,
  tokenScopes: string,
): Promise<number> {
  const now = new Date().toISOString();
  let ingestRunId = 0;
  let hasPerIdFailure = false;
  let pastQ1 = false;

  const run = store.tryBeginIngestRun({
    userId,
    githubUserId: "",
    githubLogin: "",
    tokenScopes,
    startedAt: now,
  });
  ingestRunId = run.id;
  client.attachIngestRun(store, ingestRunId);

  try {
    const q1 = await client.graphqlWithRetry(Q1_VIEWER_PROFILE, {});
    store.insertIngestResponse({
      ingestRunId,
      fetchedAt: new Date().toISOString(),
      queryName: "Q1",
      variables: {},
      httpStatus: q1.httpStatus,
      payload: q1.payload,
    });
    store.touchIngestRunHeartbeat(ingestRunId);

    if (!q1.success) {
      store.updateIngestRunStatus(ingestRunId, "failed", new Date().toISOString());
      return ingestRunId;
    }

    pastQ1 = true;

    const viewer = getNested(q1.payload, ["data", "viewer"]) as {
      id: string;
      databaseId: number | null;
      login: string;
    };
    const githubUserId =
      viewer.databaseId != null ? String(viewer.databaseId) : viewer.id;
    const ctx: IngestContext = {
      store,
      client,
      ingestRunId,
      viewerLogin: viewer.login,
      viewerId: viewer.id,
      githubUserId,
    };

    store.updateIngestRunProfile(ingestRunId, githubUserId, viewer.login);

    const q2 = await paginateConnection(
      client,
      store,
      ingestRunId,
      "Q2",
      Q2_VIEWER_PULL_REQUESTS,
      {},
      ["viewer", "pullRequests"],
    );
    if (!q2.success) hasPerIdFailure = true;

    const q3 = await paginateConnection(
      client,
      store,
      ingestRunId,
      "Q3",
      Q3_VIEWER_ISSUE_COMMENTS,
      {},
      ["viewer", "issueComments"],
    );
    if (!q3.success) hasPerIdFailure = true;

    const q4ok = await runQ4(ctx);
    if (!q4ok) hasPerIdFailure = true;

    const q5ok = await runQ5Filtered(ctx);
    if (!q5ok) hasPerIdFailure = true;

    const prIds = collectAllPrIdsFromQ2(store, ingestRunId);
    for (const prId of prIds) {
      const ok = await hydratePr(ctx, prId);
      if (!ok) hasPerIdFailure = true;
    }

    const q2Refs = collectQ2PrRefs(store, ingestRunId);
    const commentRefs = collectIssueCommentRefs(store, ingestRunId);
    for (const ref of commentRefs) {
      const key = prRefKey(ref.owner, ref.name, ref.number);
      if (q2Refs.has(key)) continue;

      const q12 = await client.graphqlWithRetry(Q12_ISSUE_OR_PR, {
        owner: ref.owner,
        name: ref.name,
        number: ref.number,
      });
      store.insertIngestResponse({
        ingestRunId,
        fetchedAt: new Date().toISOString(),
        queryName: "Q12",
        variables: { owner: ref.owner, name: ref.name, number: ref.number },
        httpStatus: q12.httpStatus,
        payload: q12.payload,
      });
      store.touchIngestRunHeartbeat(ingestRunId);
      if (!q12.success) hasPerIdFailure = true;
    }

    const reviewPrIds = collectReviewPrIds(store, ingestRunId);
    for (const prId of reviewPrIds) {
      let after: string | null = null;
      let hasNext = true;
      let prFailed = false;
      while (hasNext) {
        const variables = { id: prId, login: ctx.viewerLogin, after };
        const result = await client.graphqlWithRetry(
          Q13_REVIEWS_BY_AUTHOR,
          variables,
          "reviews",
        );
        store.insertIngestResponse({
          ingestRunId,
          fetchedAt: new Date().toISOString(),
          queryName: "Q13",
          variables,
          httpStatus: result.httpStatus,
          payload: result.payload,
        });
        store.touchIngestRunHeartbeat(ingestRunId);
        if (!result.success) {
          prFailed = true;
          break;
        }
        const reviews = getNested(result.payload, [
          "data",
          "node",
          "reviews",
        ]) as {
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          nodes?: Array<{
            id: string;
            comments?: { pageInfo?: { hasNextPage: boolean } };
          }>;
        };
        for (const review of reviews?.nodes ?? []) {
          if (review.comments?.pageInfo?.hasNextPage) {
            const commentsResult = await paginateConnection(
              client,
              store,
              ingestRunId,
              "Q13",
              Q13_REVIEW_COMMENTS,
              { reviewId: review.id },
              ["node", "comments"],
            );
            if (!commentsResult.success) prFailed = true;
          }
        }

        const reviewNodes = reviews?.nodes ?? [];
        if (reviewNodes.length === 0) {
          hasNext = false;
          break;
        }

        hasNext = reviews?.pageInfo?.hasNextPage ?? false;
        after = reviews?.pageInfo?.endCursor ?? null;
      }
      if (prFailed) hasPerIdFailure = true;
    }

    const prCommitOids = collectPrCommitOids(store, ingestRunId);
    const commitRepos = collectCommitRepos(store, ingestRunId);
    for (const repo of commitRepos) {
      let after: string | null = null;
      let hasNext = true;
      let repoFailed = false;
      while (hasNext) {
        const variables = {
          owner: repo.owner,
          name: repo.name,
          authorId: ctx.viewerId,
          after,
        };
        const result = await client.graphqlWithRetry(
          Q14_REPO_AUTHOR_HISTORY,
          variables,
          "history",
        );

        let metadata: Record<string, unknown> = {};
        if (!result.success) {
          repoFailed = true;
        } else {
          const defaultBranchRef = getNested(result.payload, [
            "data",
            "repository",
            "defaultBranchRef",
          ]);
          if (defaultBranchRef == null) {
            metadata = { error: "defaultBranchRef_null" };
            repoFailed = true;
          } else {
            const history = getNested(result.payload, [
              "data",
              "repository",
              "defaultBranchRef",
              "target",
              "history",
            ]) as {
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
              nodes?: Array<{ oid: string }>;
            } | null;

            if (!history) {
              metadata = { error: "history_missing" };
              repoFailed = true;
            } else {
              const historyNodes = history.nodes ?? [];
              for (const commit of historyNodes) {
                if (prCommitOids.has(commit.oid)) continue;
                const restPath = `/repos/${repo.owner}/${repo.name}/commits/${commit.oid}`;
                const rest = await client.restGet(restPath);
                store.insertIngestResponse({
                  ingestRunId,
                  fetchedAt: new Date().toISOString(),
                  queryName: "rest_commit_files",
                  variables: {
                    owner: repo.owner,
                    repo: repo.name,
                    sha: commit.oid,
                  },
                  httpStatus: rest.httpStatus,
                  payload: rest.payload,
                  metadata: rest.parseError
                    ? { parse_error: true, http_status: rest.httpStatus }
                    : undefined,
                });
                store.touchIngestRunHeartbeat(ingestRunId);
                if (isRestFailure(rest)) repoFailed = true;
              }

              if (historyNodes.length === 0) {
                hasNext = false;
              } else {
                hasNext = history.pageInfo?.hasNextPage ?? false;
                after = history.pageInfo?.endCursor ?? null;
              }
            }
          }
        }

        store.insertIngestResponse({
          ingestRunId,
          fetchedAt: new Date().toISOString(),
          queryName: "Q14",
          variables,
          httpStatus: result.httpStatus,
          payload: result.payload,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        store.touchIngestRunHeartbeat(ingestRunId);

        if (repoFailed || !result.success) break;
        if (!hasNext) break;
      }
      if (repoFailed) hasPerIdFailure = true;
    }

    const status: RunStatus = hasPerIdFailure ? "partial" : "complete";
    store.updateIngestRunStatus(ingestRunId, status, new Date().toISOString());
  } catch (err) {
    const status: RunStatus = pastQ1 ? "partial" : "failed";
    store.updateIngestRunStatus(ingestRunId, status, new Date().toISOString());
    throw err;
  }

  return ingestRunId;
}

import type { Store } from "../db/store.js";
import type { RunStatus } from "../db/schema.js";
import { IngestAlreadyRunningError } from "../errors.js";
import {
  GitHubClient,
  getNested,
  type RequestOutcome,
} from "./client.js";
import {
  Q1_VIEWER_PROFILE,
  Q2_VIEWER_PULL_REQUESTS,
  Q3_VIEWER_ISSUE_COMMENTS,
  Q4_REVIEW_CONTRIB_SLICE,
  Q5_VIEWER_ISSUES,
  Q6_PR_CORE_BATCH,
  Q7_PR_FILES,
  Q7_PR_FILES_BATCH,
  Q9_PR_COMMENTS_BATCH,
  Q12_ISSUE_OR_PR,
  Q13_REVIEWS_BY_AUTHOR,
  Q13_REVIEW_COMMENTS,
} from "./queries.js";

export { IngestAlreadyRunningError };

export {
  analyzeNodesBatch,
  extractNodesIndexFromPath,
  partialDataMetadata,
  buildOutcomeMetadata,
  isPerIdNodeNull,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 365;
const HYDRATE_CAP = 300;
const Q7_MAX_PAGES_PER_PR = 20;
const Q7_GLOBAL_EXTRA_PAGES = 200;
const Q13_MAX_REVIEW_PAGES = 20;
const Q13_MAX_COMMENT_PAGES = 10;
const NODES_BATCH_SIZE = 50;

export interface IngestContext {
  store: Store;
  client: GitHubClient;
  ingestRunId: number;
  viewerLogin: string;
  viewerId: string;
  githubUserId: string;
  startedAt: string;
  windowStart: string;
}

interface RunState {
  partial: boolean;
  stoppedFloor: boolean;
  stoppedPrimary: boolean;
}

type OutcomeAction = "continue" | "stop" | "stop_no_persist";

interface Q2Node {
  id: string;
  number: number;
  state: string;
  isDraft: boolean;
  merged: boolean;
  mergedAt: string | null;
  updatedAt: string;
  repository?: { nameWithOwner?: string };
}

interface Q4Node {
  occurredAt: string;
  isRestricted: boolean;
  pullRequest?: { id: string } | null;
}

interface Q3Node {
  pullRequest?: { id: string } | null;
  issue?: {
    number: number;
    url?: string;
    repository?: { owner?: { login: string }; name: string; nameWithOwner?: string };
  };
}

function computeWindowStart(startedAt: string): string {
  return new Date(new Date(startedAt).getTime() - WINDOW_DAYS * MS_PER_DAY).toISOString();
}

function computeMid(windowStart: string): string {
  return new Date(new Date(windowStart).getTime() + 364 * MS_PER_DAY).toISOString();
}

function isBeforeWindow(value: string, windowStart: string): boolean {
  return new Date(value).getTime() < new Date(windowStart).getTime();
}

function prRefKey(owner: string, name: string, number: number): string {
  return `${owner}/${name}#${number}`;
}

function persistResponse(
  ctx: IngestContext,
  queryName: string,
  variables: Record<string, unknown>,
  outcome: RequestOutcome,
  metadata?: Record<string, unknown>,
): void {
  ctx.store.insertIngestResponse({
    ingestRunId: ctx.ingestRunId,
    fetchedAt: new Date().toISOString(),
    queryName,
    variables,
    httpStatus: outcome.httpStatus,
    payload: outcome.payload,
    metadata,
  });
  ctx.store.touchIngestRunHeartbeat(ctx.ingestRunId);
}

function applyOutcome(state: RunState, outcome: RequestOutcome): OutcomeAction {
  if (outcome.stoppedRemainingFloor) {
    state.stoppedFloor = true;
    return "stop_no_persist";
  }
  if (outcome.classification === "primary_rate_limit") {
    state.stoppedPrimary = true;
    state.partial = true;
    return "stop";
  }
  if (
    outcome.secondaryExhausted ||
    outcome.classification === "secondary_rate_limit"
  ) {
    state.partial = true;
    return "stop";
  }
  if (outcome.classification === "partial_data") {
    state.partial = true;
    return "continue";
  }
  if (
    outcome.classification === "validation_1year" ||
    outcome.classification === "null_data" ||
    outcome.classification === "timeout" ||
    outcome.classification === "http_error"
  ) {
    state.partial = true;
    return "stop";
  }
  return "continue";
}

function extractNodesIndexFromPath(path: unknown): number | undefined {
  if (!Array.isArray(path)) return undefined;
  const nodesIdx = path.findIndex((p) => p === "nodes");
  if (nodesIdx < 0 || nodesIdx + 1 >= path.length) return undefined;
  const idx = path[nodesIdx + 1];
  return typeof idx === "number" ? idx : undefined;
}

function partialDataMetadata(outcome: RequestOutcome): Record<string, unknown> | undefined {
  if (outcome.classification !== "partial_data") return undefined;
  const payload = outcome.payload as {
    errors?: Array<{ path?: unknown; message?: string }>;
  };
  if (!Array.isArray(payload?.errors) || payload.errors.length === 0) return undefined;
  const per_node_failures = payload.errors
    .filter((e) => e.path != null)
    .map((e) => ({ path: e.path, message: e.message ?? "" }));
  return per_node_failures.length > 0 ? { per_node_failures } : undefined;
}

function isPerIdNodeNull(outcome: RequestOutcome): boolean {
  if (outcome.httpStatus !== 200) return false;
  const payload = outcome.payload as {
    data?: { node?: unknown };
  };
  if (payload?.data == null) return false;
  return payload.data.node == null;
}

function isQ12RepositoryNull(outcome: RequestOutcome): boolean {
  if (outcome.httpStatus !== 200) return false;
  const payload = outcome.payload as {
    data?: { repository?: unknown };
    errors?: unknown[];
  };
  if (payload?.data == null) return false;
  if (payload.data.repository != null) return false;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return false;
  return true;
}

function analyzeNodesBatch(
  payload: unknown,
  batchIds: string[],
): Record<string, string> {
  const failedIds: Record<string, string> = {};
  const nodes = getNested(payload, ["data", "nodes"]) as unknown[] | null | undefined;
  if (Array.isArray(nodes)) {
    for (let i = 0; i < batchIds.length; i++) {
      if (nodes[i] == null) {
        failedIds[batchIds[i]] = "node_null";
      }
    }
  }

  const errors = (payload as { errors?: Array<{ path?: unknown; message?: string }> })
    ?.errors;
  if (Array.isArray(errors)) {
    for (const err of errors) {
      const idx = extractNodesIndexFromPath(err.path);
      if (idx != null && idx >= 0 && idx < batchIds.length) {
        failedIds[batchIds[idx]] = "graphql_error";
      }
    }
  }

  return failedIds;
}

function buildOutcomeMetadata(
  outcome: RequestOutcome,
  extra?: Record<string, unknown>,
  batchIds?: string[],
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...(partialDataMetadata(outcome) ?? {}),
    ...(extra ?? {}),
  };
  const analyzed = batchIds ? analyzeNodesBatch(outcome.payload, batchIds) : {};
  const existing = (merged.per_id_failed as Record<string, string> | undefined) ?? {};
  const combined = { ...existing, ...analyzed };
  if (Object.keys(combined).length > 0) merged.per_id_failed = combined;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeMetadata(
  ...parts: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

async function paginateIndex(
  ctx: IngestContext,
  state: RunState,
  options: {
    queryName: string;
    query: string;
    connectionPath: string[];
    baseVariables: Record<string, unknown>;
    connectionField: string;
    cutoffField?: "updatedAt" | "createdAt";
    pageCap?: number;
    metadataForPage?: (payload: unknown) => Record<string, unknown> | undefined;
  },
): Promise<boolean> {
  let after: string | null = null;
  let pages = 0;

  while (true) {
    if (ctx.client.shouldStopForRemainingFloor()) {
      state.stoppedFloor = true;
      state.partial = true;
      return false;
    }

    const variables = { ...options.baseVariables, after };
    const outcome = await ctx.client.executeRequest(options.query, variables, {
      connectionField: options.connectionField,
    });

    const action = applyOutcome(state, outcome);
    if (action === "stop_no_persist") return false;

    const metadata = buildOutcomeMetadata(
      outcome,
      options.metadataForPage?.(outcome.payload),
    );
    persistResponse(ctx, options.queryName, variables, outcome, metadata);
    pages++;

    if (action === "stop") return false;

    const connection = getNested(outcome.payload, [
      "data",
      ...options.connectionPath,
    ]) as {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes?: Array<Record<string, unknown>>;
    } | undefined;

    if (!connection) {
      state.partial = true;
      return false;
    }

    const nodes = connection.nodes ?? [];
    if (nodes.length === 0) break;

    let hitWindowCutoff = false;
    if (options.cutoffField && ctx.windowStart) {
      for (const node of nodes) {
        const ts = node[options.cutoffField] as string | undefined;
        if (ts && isBeforeWindow(ts, ctx.windowStart)) {
          hitWindowCutoff = true;
          break;
        }
      }
    }

    if (hitWindowCutoff) break;

    if (options.pageCap != null && pages >= options.pageCap) {
      state.partial = true;
      break;
    }

    const pageInfo = connection.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return true;
}

async function runQ4(ctx: IngestContext, state: RunState): Promise<boolean> {
  const mid = computeMid(ctx.windowStart);
  const slices = [
    { from: ctx.windowStart, to: mid },
    { from: mid, to: ctx.startedAt },
  ];

  for (const slice of slices) {
    let reviewAfter: string | null = null;
    let slicePages = 0;

    while (true) {
      if (ctx.client.shouldStopForRemainingFloor()) {
        state.stoppedFloor = true;
        state.partial = true;
        return false;
      }

      const variables = {
        from: slice.from,
        to: slice.to,
        reviewAfter,
      };
      const outcome = await ctx.client.executeRequest(
        Q4_REVIEW_CONTRIB_SLICE,
        variables,
        { connectionField: "pullRequestReviewContributions" },
      );

      const action = applyOutcome(state, outcome);
      if (action === "stop_no_persist") return false;

      let metadata: Record<string, unknown> | undefined;
      if (outcome.payload) {
        const nodes = getNested(outcome.payload, [
          "data",
          "viewer",
          "contributionsCollection",
          "pullRequestReviewContributions",
          "nodes",
        ]) as Q4Node[] | undefined;
        if (nodes?.some((n) => n.isRestricted)) {
          metadata = { hydrate_skipped: "restricted" };
        }
      }

      persistResponse(
        ctx,
        "Q4",
        variables,
        outcome,
        buildOutcomeMetadata(outcome, metadata),
      );
      slicePages++;

      if (action === "stop") return false;

      const connection = getNested(outcome.payload, [
        "data",
        "viewer",
        "contributionsCollection",
        "pullRequestReviewContributions",
      ]) as {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        nodes?: unknown[];
      };

      if (!connection) {
        state.partial = true;
        return false;
      }

      const nodes = connection.nodes ?? [];
      if (nodes.length === 0) break;

      if (slicePages >= 20) {
        state.partial = true;
        break;
      }

      if (!connection.pageInfo?.hasNextPage) break;
      reviewAfter = connection.pageInfo.endCursor;
    }
  }

  return true;
}

function collectQ2Nodes(store: Store, ingestRunId: number, windowStart: string): Q2Node[] {
  const all: Q2Node[] = [];
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q2") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, ["data", "viewer", "pullRequests", "nodes"]) as
      | Q2Node[]
      | undefined;
    for (const n of nodes ?? []) {
      if (n.updatedAt && isBeforeWindow(n.updatedAt, windowStart)) continue;
      all.push(n);
    }
  }
  return all;
}

function computeHydratePrIds(
  q2Nodes: Q2Node[],
  windowStart: string,
): { hydratePrIds: string[]; skipped: Record<string, string> } {
  const skipped: Record<string, string> = {};
  const merged: Q2Node[] = [];
  const open: Q2Node[] = [];

  for (const pr of q2Nodes) {
    if (isBeforeWindow(pr.updatedAt, windowStart)) continue;
    if (pr.isDraft) {
      skipped[pr.id] = "draft";
      continue;
    }
    if (!pr.merged && pr.state !== "OPEN") {
      skipped[pr.id] = "closed_unmerged";
      continue;
    }
    if (pr.merged) merged.push(pr);
    else open.push(pr);
  }

  merged.sort((a, b) => {
    const ma = a.mergedAt ? new Date(a.mergedAt).getTime() : 0;
    const mb = b.mergedAt ? new Date(b.mergedAt).getTime() : 0;
    if (mb !== ma) return mb - ma;
    return b.number - a.number;
  });

  open.sort((a, b) => {
    const ua = new Date(a.updatedAt).getTime();
    const ub = new Date(b.updatedAt).getTime();
    if (ub !== ua) return ub - ua;
    return b.number - a.number;
  });

  const eligible = [...merged, ...open];
  const hydratePrIds: string[] = [];
  for (const pr of eligible) {
    if (hydratePrIds.length >= HYDRATE_CAP) {
      skipped[pr.id] = "cap";
      continue;
    }
    hydratePrIds.push(pr.id);
  }

  return { hydratePrIds, skipped };
}

function attachHydrateSkippedToQ2Pages(
  store: Store,
  ingestRunId: number,
  skipped: Record<string, string>,
): void {
  if (Object.keys(skipped).length === 0) return;
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q2") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, ["data", "viewer", "pullRequests", "nodes"]) as
      | Q2Node[]
      | undefined;
    const pageSkipped: Record<string, string> = {};
    for (const n of nodes ?? []) {
      if (skipped[n.id]) pageSkipped[n.id] = skipped[n.id];
    }
    if (Object.keys(pageSkipped).length === 0) continue;
    const existing = JSON.parse(resp.metadata || "{}");
    store.updateIngestResponseMetadata(resp.id, {
      ...existing,
      hydrate_skipped: pageSkipped,
    });
  }
}

function q5PageMetadata(payload: unknown): Record<string, unknown> | undefined {
  const nodes = getNested(payload, ["data", "viewer", "issues", "nodes"]) as
    | Array<{ id: string; __typename?: string; url?: string }>
    | undefined;
  const dropped: Record<string, string> = {};
  for (const n of nodes ?? []) {
    if (n.__typename != null && n.__typename !== "Issue") {
      dropped[n.id] = "not_issue";
    } else if (n.url?.includes("/pull/")) {
      dropped[n.id] = "pull_url";
    }
  }
  return Object.keys(dropped).length > 0 ? { index_dropped: dropped } : undefined;
}

function computeQ9PrIds(hydratePrIds: string[], q2Nodes: Q2Node[]): string[] {
  const byId = new Map(q2Nodes.map((n) => [n.id, n]));
  return hydratePrIds.filter((id) => {
    const pr = byId.get(id);
    return pr?.merged && !pr.isDraft;
  });
}

function collectQ4Nodes(store: Store, ingestRunId: number): Q4Node[] {
  const all: Q4Node[] = [];
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q4") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, [
      "data",
      "viewer",
      "contributionsCollection",
      "pullRequestReviewContributions",
      "nodes",
    ]) as Q4Node[] | undefined;
    if (nodes) all.push(...nodes);
  }
  return all;
}

function computeQ13PrIds(q4Nodes: Q4Node[]): string[] {
  const byPr = new Map<string, Q4Node>();
  for (const node of q4Nodes) {
    if (node.isRestricted) continue;
    if (!node.pullRequest?.id) continue;
    const id = node.pullRequest.id;
    const existing = byPr.get(id);
    if (
      !existing ||
      new Date(node.occurredAt).getTime() > new Date(existing.occurredAt).getTime()
    ) {
      byPr.set(id, node);
    }
  }

  const sorted = [...byPr.values()].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  return sorted.slice(0, HYDRATE_CAP).map((n) => n.pullRequest!.id);
}

function collectQ2PrRefs(store: Store, ingestRunId: number): Set<string> {
  const refs = new Set<string>();
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q2") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, ["data", "viewer", "pullRequests", "nodes"]) as
      | Array<{ number: number; repository?: { nameWithOwner?: string } }>
      | undefined;
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

function collectQ12FallbackRefs(
  store: Store,
  ingestRunId: number,
): Array<{ owner: string; name: string; number: number }> {
  const seen = new Set<string>();
  const refs: Array<{ owner: string; name: string; number: number }> = [];

  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q3") continue;
    const payload = JSON.parse(resp.payload);
    const nodes = getNested(payload, ["data", "viewer", "issueComments", "nodes"]) as
      | Q3Node[]
      | undefined;
    for (const n of nodes ?? []) {
      if (n.pullRequest != null) continue;
      const issueUrl = n.issue?.url ?? "";
      if (!issueUrl.includes("/pull/")) continue;
      const repo = n.issue?.repository;
      const number = n.issue?.number;
      if (!repo || number == null) continue;
      let owner = repo.owner?.login;
      let name = repo.name;
      if (!owner || !name) {
        const nwo = repo.nameWithOwner;
        if (nwo) {
          const [splitOwner, splitName] = nwo.split("/");
          if (splitOwner && splitName) {
            owner = splitOwner;
            name = splitName;
          }
        }
      }
      if (!owner || !name) continue;
      const key = prRefKey(owner, name, number);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ owner, name, number });
    }
  }
  return refs;
}

function neededQ12Refs(
  store: Store,
  ingestRunId: number,
): Array<{ owner: string; name: string; number: number }> {
  const q2Refs = collectQ2PrRefs(store, ingestRunId);
  return collectQ12FallbackRefs(store, ingestRunId).filter(
    (ref) => !q2Refs.has(prRefKey(ref.owner, ref.name, ref.number)),
  );
}

function idHasBatchSuccess(
  store: Store,
  ingestRunId: number,
  queryName: string,
  id: string,
): boolean {
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== queryName) continue;
    const vars = JSON.parse(resp.variables) as { ids?: string[] };
    const ids = vars.ids;
    if (!ids?.includes(id)) continue;
    const payload = JSON.parse(resp.payload);
    if (payload?.data == null) continue;
    const nodes = payload.data.nodes as unknown[] | null | undefined;
    if (nodes == null) continue;
    const idx = ids.indexOf(id);
    const meta = JSON.parse(resp.metadata || "{}") as {
      per_id_failed?: Record<string, unknown>;
    };
    if (meta.per_id_failed?.[id]) continue;
    if (nodes[idx] != null) return true;
  }
  return false;
}

function idHasPerIdNodeSuccess(
  store: Store,
  ingestRunId: number,
  queryName: string,
  id: string,
  varKey: "id" | "reviewId" = "id",
): boolean {
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== queryName) continue;
    const vars = JSON.parse(resp.variables) as Record<string, unknown>;
    if (vars[varKey] !== id) continue;
    const meta = JSON.parse(resp.metadata || "{}") as {
      per_id_failed?: Record<string, unknown>;
    };
    if (meta.per_id_failed?.[id]) continue;
    const payload = JSON.parse(resp.payload);
    if (payload?.data?.node != null) return true;
  }
  return false;
}

function idHasHydrateSuccess(
  store: Store,
  ingestRunId: number,
  queryName: string,
  id: string,
): boolean {
  return (
    idHasBatchSuccess(store, ingestRunId, queryName, id) ||
    idHasPerIdNodeSuccess(store, ingestRunId, queryName, id, "id")
  );
}

function idHasQ13Success(store: Store, ingestRunId: number, prId: string): boolean {
  return idHasPerIdNodeSuccess(store, ingestRunId, "Q13", prId, "id");
}

function q12RefHasSuccess(
  store: Store,
  ingestRunId: number,
  ref: { owner: string; name: string; number: number },
): boolean {
  for (const resp of store.getIngestResponses(ingestRunId)) {
    if (resp.query_name !== "Q12") continue;
    const vars = JSON.parse(resp.variables) as {
      owner?: string;
      name?: string;
      number?: number;
    };
    if (
      vars.owner === ref.owner &&
      vars.name === ref.name &&
      vars.number === ref.number
    ) {
      const payload = JSON.parse(resp.payload);
      if (payload?.data == null) return false;
      return payload.data.repository != null;
    }
  }
  return false;
}

function verifyAllSubsetsComplete(
  ctx: IngestContext,
  hydratePrIds: string[],
  q9PrIds: string[],
  q13PrIds: string[],
  q12Needed: Array<{ owner: string; name: string; number: number }>,
): boolean {
  for (const id of hydratePrIds) {
    if (!idHasHydrateSuccess(ctx.store, ctx.ingestRunId, "Q6", id)) return false;
    if (!idHasHydrateSuccess(ctx.store, ctx.ingestRunId, "Q7", id)) return false;
  }
  for (const id of q9PrIds) {
    if (!idHasHydrateSuccess(ctx.store, ctx.ingestRunId, "Q9", id)) return false;
  }
  for (const id of q13PrIds) {
    if (!idHasQ13Success(ctx.store, ctx.ingestRunId, id)) return false;
  }
  for (const ref of q12Needed) {
    if (!q12RefHasSuccess(ctx.store, ctx.ingestRunId, ref)) return false;
  }
  return true;
}

async function executeNodesBatchChunk(
  ctx: IngestContext,
  state: RunState,
  queryName: string,
  query: string,
  batch: string[],
  variablesKey: string,
  metadataForBatch?: (
    payload: unknown,
    ids: string[],
  ) => Record<string, unknown> | undefined,
): Promise<boolean> {
  return executeNodesBatchSlice(
    ctx,
    state,
    queryName,
    query,
    batch,
    variablesKey,
    metadataForBatch,
  );
}

async function executeNodesBatchSlice(
  ctx: IngestContext,
  state: RunState,
  queryName: string,
  query: string,
  slice: string[],
  variablesKey: string,
  metadataForBatch?: (
    payload: unknown,
    ids: string[],
  ) => Record<string, unknown> | undefined,
): Promise<boolean> {
  if (slice.length === 0) return true;

  const variables = { [variablesKey]: slice };
  const outcome = await ctx.client.executeRequest(query, variables, {
    nodesBatch: true,
  });

  if (outcome.classification === "timeout") {
    if (slice.length > 5) {
      const halved = Math.max(5, Math.floor(slice.length / 2));
      const head = slice.slice(0, halved);
      const tail = slice.slice(halved);
      const headOk = await executeNodesBatchSlice(
        ctx,
        state,
        queryName,
        query,
        head,
        variablesKey,
        metadataForBatch,
      );
      if (!headOk) return false;
      if (tail.length === 0) return true;
      return executeNodesBatchSlice(
        ctx,
        state,
        queryName,
        query,
        tail,
        variablesKey,
        metadataForBatch,
      );
    }

    state.partial = true;
    const failedIds = Object.fromEntries(slice.map((id) => [id, "timeout"]));
    persistResponse(
      ctx,
      queryName,
      variables,
      outcome,
      buildOutcomeMetadata(outcome, { per_id_failed: failedIds }),
    );
    return true;
  }

  const action = applyOutcome(state, outcome);
  if (action === "stop_no_persist") return false;

  const extraMeta = metadataForBatch?.(outcome.payload, slice);
  const failedIds = analyzeNodesBatch(outcome.payload, slice);
  const extraFailed =
    (extraMeta?.per_id_failed as Record<string, string> | undefined) ?? {};
  if (Object.keys(failedIds).length > 0 || Object.keys(extraFailed).length > 0) {
    state.partial = true;
  }

  const metadata = buildOutcomeMetadata(outcome, extraMeta, slice);
  persistResponse(ctx, queryName, variables, outcome, metadata);

  if (action === "stop") return false;
  return true;
}

async function batchNodesRequest(
  ctx: IngestContext,
  state: RunState,
  queryName: string,
  query: string,
  ids: string[],
  variablesKey: string,
  metadataForBatch?: (
    payload: unknown,
    ids: string[],
  ) => Record<string, unknown> | undefined,
): Promise<boolean> {
  for (let i = 0; i < ids.length; i += NODES_BATCH_SIZE) {
    if (ctx.client.shouldStopForRemainingFloor()) {
      state.stoppedFloor = true;
      state.partial = true;
      return false;
    }

    const batch = ids.slice(i, i + NODES_BATCH_SIZE);
    const ok = await executeNodesBatchChunk(
      ctx,
      state,
      queryName,
      query,
      batch,
      variablesKey,
      metadataForBatch,
    );
    if (!ok) return false;
  }
  return true;
}

async function runQ7Files(
  ctx: IngestContext,
  state: RunState,
  hydratePrIds: string[],
): Promise<void> {
  let globalExtraPages = Q7_GLOBAL_EXTRA_PAGES;

  const page1Ok = await batchNodesRequest(
    ctx,
    state,
    "Q7",
    Q7_PR_FILES_BATCH,
    hydratePrIds,
    "ids",
    (payload, batchIds) => {
      const nodes = getNested(payload, ["data", "nodes"]) as Array<{
        id?: string;
        changedFiles?: number;
        files?: {
          totalCount?: number;
          pageInfo?: { hasNextPage: boolean };
        };
      } | null> | undefined;
      const perId: Record<string, Record<string, unknown>> = {};
      const perIdFailed: Record<string, string> = {};
      for (let i = 0; i < (nodes?.length ?? 0); i++) {
        const node = nodes?.[i];
        const id = batchIds[i];
        if (!node || !id) continue;
        if (node.files == null) {
          perIdFailed[id] = "files_missing";
          continue;
        }
        const filesMeta: Record<string, unknown> = {};
        if (node.files.pageInfo?.hasNextPage) {
          filesMeta.files_truncated = true;
        }
        if (
          node.files.totalCount != null &&
          node.changedFiles != null &&
          node.files.totalCount < node.changedFiles &&
          !node.files.pageInfo?.hasNextPage
        ) {
          filesMeta.files_truncated = true;
        }
        if (Object.keys(filesMeta).length > 0) perId[id] = filesMeta;
      }
      const result: Record<string, unknown> = {};
      if (Object.keys(perId).length > 0) result.per_id = perId;
      if (Object.keys(perIdFailed).length > 0) result.per_id_failed = perIdFailed;
      return Object.keys(result).length > 0 ? result : undefined;
    },
  );
  if (!page1Ok) return;

  for (const prId of hydratePrIds) {
    if (ctx.client.shouldStopForRemainingFloor()) {
      state.stoppedFloor = true;
      state.partial = true;
      return;
    }

    const page1Resp = ctx.store
      .getIngestResponses(ctx.ingestRunId)
      .filter((r) => r.query_name === "Q7")
      .reverse()
      .find((r) => {
        const vars = JSON.parse(r.variables) as { ids?: string[] };
        return vars.ids?.includes(prId);
      });

    let needsMore = false;
    let after: string | null = null;
    if (page1Resp) {
      const payload = JSON.parse(page1Resp.payload);
      const nodes = getNested(payload, ["data", "nodes"]) as Array<{
        id?: string;
        files?: { pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
      } | null> | undefined;
      const idx = (JSON.parse(page1Resp.variables) as { ids: string[] }).ids.indexOf(
        prId,
      );
      const node = nodes?.[idx];
      needsMore = node?.files?.pageInfo?.hasNextPage ?? false;
      after = node?.files?.pageInfo?.endCursor ?? null;
    }

    if (!needsMore) continue;

    let pages = 1;
    while (pages < Q7_MAX_PAGES_PER_PR && globalExtraPages > 0) {
      if (ctx.client.shouldStopForRemainingFloor()) {
        state.stoppedFloor = true;
        state.partial = true;
        return;
      }

      const variables = { id: prId, after };
      const outcome = await ctx.client.executeRequest(Q7_PR_FILES, variables, {
        connectionField: "files",
      });

      const action = applyOutcome(state, outcome);
      if (action === "stop_no_persist") return;

      if (isPerIdNodeNull(outcome)) {
        state.partial = true;
        persistResponse(
          ctx,
          "Q7",
          variables,
          outcome,
          buildOutcomeMetadata(outcome, { per_id_failed: { [prId]: "node_null" } }),
        );
        break;
      }

      let extraMeta: Record<string, unknown> | undefined;
      const node = getNested(outcome.payload, ["data", "node"]) as {
        changedFiles?: number;
        files?: {
          totalCount?: number;
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;

      if (node != null && node.files == null) {
        state.partial = true;
        persistResponse(
          ctx,
          "Q7",
          variables,
          outcome,
          buildOutcomeMetadata(outcome, {
            per_id_failed: { [prId]: "files_missing" },
          }),
        );
        break;
      }

      if (node?.files) {
        const truncated =
          pages + 1 >= Q7_MAX_PAGES_PER_PR ||
          globalExtraPages <= 1 ||
          (node.files.totalCount != null &&
            node.changedFiles != null &&
            node.files.totalCount < node.changedFiles &&
            !node.files.pageInfo?.hasNextPage);
        if (truncated || node.files.pageInfo?.hasNextPage) {
          extraMeta = { files_truncated: true };
        }
      }

      persistResponse(
        ctx,
        "Q7",
        variables,
        outcome,
        buildOutcomeMetadata(outcome, extraMeta),
      );
      pages++;
      globalExtraPages--;

      if (action === "stop") return;

      const fileNodes = node!.files!;
      if ((fileNodes as { nodes?: unknown[] }).nodes?.length === 0) break;
      if (!fileNodes.pageInfo?.hasNextPage) break;
      if (pages >= Q7_MAX_PAGES_PER_PR || globalExtraPages <= 0) break;
      after = fileNodes.pageInfo.endCursor;
    }
  }
}

async function runQ13ForPr(
  ctx: IngestContext,
  state: RunState,
  prId: string,
): Promise<boolean> {
  let after: string | null = null;
  let reviewPages = 0;

  while (reviewPages < Q13_MAX_REVIEW_PAGES) {
    if (ctx.client.shouldStopForRemainingFloor()) {
      state.stoppedFloor = true;
      state.partial = true;
      return false;
    }

    const variables = { id: prId, login: ctx.viewerLogin, after };
    const outcome = await ctx.client.executeRequest(
      Q13_REVIEWS_BY_AUTHOR,
      variables,
      { connectionField: "reviews" },
    );

    const action = applyOutcome(state, outcome);
    if (action === "stop_no_persist") return false;

    if (isPerIdNodeNull(outcome)) {
      state.partial = true;
      persistResponse(
        ctx,
        "Q13",
        variables,
        outcome,
        buildOutcomeMetadata(outcome, { per_id_failed: { [prId]: "node_null" } }),
      );
      return false;
    }

    const reviewNode = getNested(outcome.payload, ["data", "node"]) as {
      reviews?: {
        pageInfo?: { hasNextPage: boolean };
        nodes?: Array<{
          id: string;
          comments?: { pageInfo?: { hasNextPage: boolean } };
        }>;
      };
    } | null;
    if (reviewNode != null && reviewNode.reviews == null) {
      state.partial = true;
      persistResponse(
        ctx,
        "Q13",
        variables,
        outcome,
        buildOutcomeMetadata(outcome, {
          per_id_failed: { [prId]: "reviews_missing" },
        }),
      );
      return false;
    }

    let extraMeta: Record<string, unknown> | undefined;
    if (reviewPages + 1 >= Q13_MAX_REVIEW_PAGES) {
      if (reviewNode?.reviews?.pageInfo?.hasNextPage) {
        extraMeta = { q13_reviews_truncated: true };
      }
    }

    persistResponse(
      ctx,
      "Q13",
      variables,
      outcome,
      buildOutcomeMetadata(outcome, extraMeta),
    );
    reviewPages++;

    if (action === "stop") return false;

    const reviews = reviewNode?.reviews as {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes?: Array<{
        id: string;
        comments?: { pageInfo?: { hasNextPage: boolean } };
      }>;
    };

    for (const review of reviews?.nodes ?? []) {
      if (!review.comments?.pageInfo?.hasNextPage) continue;
      let commentAfter: string | null = null;
      let commentPages = 0;
      while (commentPages < Q13_MAX_COMMENT_PAGES) {
        if (ctx.client.shouldStopForRemainingFloor()) {
          state.stoppedFloor = true;
          state.partial = true;
          return false;
        }

        const commentVars = { reviewId: review.id, after: commentAfter };
        const commentOutcome = await ctx.client.executeRequest(
          Q13_REVIEW_COMMENTS,
          commentVars,
          { connectionField: "comments" },
        );

        const commentAction = applyOutcome(state, commentOutcome);
        if (commentAction === "stop_no_persist") return false;

        if (isPerIdNodeNull(commentOutcome)) {
          state.partial = true;
          persistResponse(
            ctx,
            "Q13",
            commentVars,
            commentOutcome,
            buildOutcomeMetadata(commentOutcome, {
              per_id_failed: { [review.id]: "node_null" },
            }),
          );
          return false;
        }

        const commentNode = getNested(commentOutcome.payload, ["data", "node"]) as {
          comments?: {
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            nodes?: unknown[];
          };
        } | null;
        if (commentNode != null && commentNode.comments == null) {
          state.partial = true;
          persistResponse(
            ctx,
            "Q13",
            commentVars,
            commentOutcome,
            buildOutcomeMetadata(commentOutcome, {
              per_id_failed: { [review.id]: "comments_missing" },
            }),
          );
          return false;
        }

        let commentExtra: Record<string, unknown> | undefined;
        if (commentPages + 1 >= Q13_MAX_COMMENT_PAGES) {
          if (commentNode?.comments?.pageInfo?.hasNextPage) {
            commentExtra = { q13_review_comments_truncated: true };
          }
        }

        persistResponse(
          ctx,
          "Q13",
          commentVars,
          commentOutcome,
          buildOutcomeMetadata(commentOutcome, commentExtra),
        );
        commentPages++;

        if (commentAction === "stop") return false;

        const comments = commentNode?.comments as {
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          nodes?: unknown[];
        };
        if ((comments?.nodes ?? []).length === 0) break;
        if (!comments?.pageInfo?.hasNextPage) break;
        commentAfter = comments.pageInfo.endCursor;
      }
    }

    const reviewNodes = reviews?.nodes ?? [];
    if (reviewNodes.length === 0) break;
    if (reviewPages >= Q13_MAX_REVIEW_PAGES) break;
    if (!reviews?.pageInfo?.hasNextPage) break;
    after = reviews.pageInfo.endCursor;
  }

  return true;
}

export async function runIngest(
  store: Store,
  client: GitHubClient,
  userId: number,
  tokenScopes: string,
): Promise<number> {
  const startedAt = new Date().toISOString();
  const windowStart = computeWindowStart(startedAt);
  let ingestRunId = 0;
  let pastQ1 = false;
  const state: RunState = {
    partial: false,
    stoppedFloor: false,
    stoppedPrimary: false,
  };

  const run = store.tryBeginIngestRun({
    userId,
    githubUserId: "",
    githubLogin: "",
    tokenScopes,
    startedAt,
  });
  ingestRunId = run.id;
  client.attachIngestRun(store, ingestRunId);
  store.updateIngestRunWindow(ingestRunId, windowStart);

  let hydratePrIds: string[] = [];
  let q9PrIds: string[] = [];
  let q13PrIds: string[] = [];
  let q12Needed: Array<{ owner: string; name: string; number: number }> = [];

  try {
    const q1 = await client.executeRequest(Q1_VIEWER_PROFILE, {}, { isQ1: true });
    persistResponse(
      { store, client, ingestRunId } as IngestContext,
      "Q1",
      {},
      q1,
    );

    if (!q1.success || q1.classification === "primary_rate_limit") {
      store.updateIngestRunStatus(ingestRunId, "failed", new Date().toISOString());
      return ingestRunId;
    }

    pastQ1 = true;
    client.markAfterQ1();

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
      startedAt,
      windowStart,
    };

    store.updateIngestRunProfile(ingestRunId, githubUserId, viewer.login);

    await paginateIndex(ctx, state, {
      queryName: "Q2",
      query: Q2_VIEWER_PULL_REQUESTS,
      connectionPath: ["viewer", "pullRequests"],
      baseVariables: {},
      connectionField: "pullRequests",
      cutoffField: "updatedAt",
      pageCap: 50,
    });
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    await runQ4(ctx, state);
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    await paginateIndex(ctx, state, {
      queryName: "Q5",
      query: Q5_VIEWER_ISSUES,
      connectionPath: ["viewer", "issues"],
      baseVariables: { login: ctx.viewerLogin },
      connectionField: "issues",
      cutoffField: "createdAt",
      pageCap: 10,
      metadataForPage: q5PageMetadata,
    });
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    await paginateIndex(ctx, state, {
      queryName: "Q3",
      query: Q3_VIEWER_ISSUE_COMMENTS,
      connectionPath: ["viewer", "issueComments"],
      baseVariables: {},
      connectionField: "issueComments",
      cutoffField: "updatedAt",
      pageCap: 30,
    });
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    const q2Nodes = collectQ2Nodes(store, ingestRunId, windowStart);
    const { hydratePrIds: computedHydrate, skipped } = computeHydratePrIds(
      q2Nodes,
      windowStart,
    );
    hydratePrIds = computedHydrate;
    q9PrIds = computeQ9PrIds(hydratePrIds, q2Nodes);
    q13PrIds = computeQ13PrIds(collectQ4Nodes(store, ingestRunId));
    q12Needed = neededQ12Refs(store, ingestRunId);

    store.updateIngestRunSubsets(ingestRunId, {
      hydratePrIds,
      q9PrIds,
      q13PrIds,
    });

    attachHydrateSkippedToQ2Pages(store, ingestRunId, skipped);

    if (state.stoppedFloor) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    await batchNodesRequest(
      ctx,
      state,
      "Q6",
      Q6_PR_CORE_BATCH,
      hydratePrIds,
      "ids",
      (payload, batchIds) => {
        const nodes = getNested(payload, ["data", "nodes"]) as Array<{
          labels?: { pageInfo?: { hasNextPage: boolean } };
        } | null> | undefined;
        const perId: Record<string, Record<string, unknown>> = {};
        for (let i = 0; i < (nodes?.length ?? 0); i++) {
          const node = nodes?.[i];
          if (node?.labels?.pageInfo?.hasNextPage) {
            perId[batchIds[i]] = { labels_truncated: true };
          }
        }
        return Object.keys(perId).length > 0 ? { per_id: perId } : undefined;
      },
    );
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    for (const prId of q13PrIds) {
      const ok = await runQ13ForPr(ctx, state, prId);
      if (!ok) state.partial = true;
      if (state.stoppedFloor || state.stoppedPrimary) {
        store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
        return ingestRunId;
      }
    }

    await runQ7Files(ctx, state, hydratePrIds);
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    await batchNodesRequest(
      ctx,
      state,
      "Q9",
      Q9_PR_COMMENTS_BATCH,
      q9PrIds,
      "ids",
      (payload, batchIds) => {
        const nodes = getNested(payload, ["data", "nodes"]) as Array<{
          comments?: { pageInfo?: { hasNextPage: boolean } };
        } | null> | undefined;
        const perId: Record<string, Record<string, unknown>> = {};
        const perIdFailed: Record<string, string> = {};
        for (let i = 0; i < (nodes?.length ?? 0); i++) {
          const node = nodes?.[i];
          const id = batchIds[i];
          if (!node || !id) continue;
          if (node.comments == null) {
            perIdFailed[id] = "comments_missing";
            continue;
          }
          if (node.comments.pageInfo?.hasNextPage) {
            perId[id] = { q9_comments_truncated: true };
          }
        }
        const result: Record<string, unknown> = {};
        if (Object.keys(perId).length > 0) result.per_id = perId;
        if (Object.keys(perIdFailed).length > 0) result.per_id_failed = perIdFailed;
        return Object.keys(result).length > 0 ? result : undefined;
      },
    );
    if (state.stoppedFloor || state.stoppedPrimary) {
      store.updateIngestRunStatus(ingestRunId, "partial", new Date().toISOString());
      return ingestRunId;
    }

    for (const ref of q12Needed) {
      if (ctx.client.shouldStopForRemainingFloor()) {
        state.stoppedFloor = true;
        state.partial = true;
        break;
      }
      if (state.stoppedPrimary) break;

      const outcome = await ctx.client.executeRequest(Q12_ISSUE_OR_PR, {
        owner: ref.owner,
        name: ref.name,
        number: ref.number,
      });

      const action = applyOutcome(state, outcome);
      if (action === "stop_no_persist") break;

      if (isQ12RepositoryNull(outcome)) {
        state.partial = true;
      }

      persistResponse(
        ctx,
        "Q12",
        { owner: ref.owner, name: ref.name, number: ref.number },
        outcome,
        buildOutcomeMetadata(outcome),
      );
      if (action === "stop") break;
    }

    if (
      !state.partial &&
      !state.stoppedFloor &&
      !verifyAllSubsetsComplete(ctx, hydratePrIds, q9PrIds, q13PrIds, q12Needed)
    ) {
      state.partial = true;
    }

    const status: RunStatus =
      state.partial || state.stoppedFloor ? "partial" : "complete";
    store.updateIngestRunStatus(ingestRunId, status, new Date().toISOString());
  } catch (err) {
    const status: RunStatus = pastQ1 ? "partial" : "failed";
    store.updateIngestRunStatus(ingestRunId, status, new Date().toISOString());
    throw err;
  }

  return ingestRunId;
}

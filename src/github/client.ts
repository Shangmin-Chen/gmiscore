import type { Store } from "../db/store.js";

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; [key: string]: unknown }>;
  rateLimit?: { cost: number; remaining: number; resetAt: string };
}

/** Chunk long rate-limit sleeps so ingest heartbeat stays fresh (< zombie cutoff). */
export const RATE_LIMIT_SLEEP_CHUNK_MS = 60_000;

export interface GitHubClientOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  store?: Store;
  ingestRunId?: number;
}

const PAGED_CONNECTION_FIELDS = [
  "pullRequestReviewContributions",
  "history",
  "files",
  "commits",
  "comments",
  "reviews",
  "reviewThreads",
  "pullRequests",
  "issueComments",
  "issues",
] as const;

export function extractConnectionFirst(
  query: string,
  connectionField: string,
): number | undefined {
  const re = new RegExp(`${connectionField}\\([^)]*?first:\\s*(\\d+)`);
  const match = query.match(re);
  return match ? parseInt(match[1], 10) : undefined;
}

export function applyConnectionFirst(
  query: string,
  connectionField: string,
  first: number,
): string {
  const re = new RegExp(`(${connectionField}\\([^)]*?first:\\s*)\\d+`);
  return query.replace(re, `$1${first}`);
}

export function extractFirstFromQuery(
  query: string,
  connectionField?: string,
): number | undefined {
  if (connectionField) {
    const specific = extractConnectionFirst(query, connectionField);
    if (specific !== undefined) return specific;
  }
  for (const field of PAGED_CONNECTION_FIELDS) {
    const first = extractConnectionFirst(query, field);
    if (first !== undefined) return first;
  }
  return undefined;
}

function applyFirstToQuery(
  query: string,
  connectionField: string | undefined,
  first: number,
): string {
  if (connectionField) {
    return applyConnectionFirst(query, connectionField, first);
  }
  for (const field of PAGED_CONNECTION_FIELDS) {
    if (extractConnectionFirst(query, field) !== undefined) {
      return applyConnectionFirst(query, field, first);
    }
  }
  return query;
}

export class GitHubClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private store?: Store;
  private ingestRunId?: number;

  constructor(
    private accessToken: string,
    options: Partial<GitHubClientOptions> = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.store = options.store;
    this.ingestRunId = options.ingestRunId;
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  attachIngestRun(store: Store, ingestRunId: number): void {
    this.store = store;
    this.ingestRunId = ingestRunId;
  }

  private touchHeartbeat(): void {
    if (this.store && this.ingestRunId != null) {
      this.store.touchIngestRunHeartbeat(this.ingestRunId);
    }
  }

  private async chunkedSleep(totalMs: number): Promise<void> {
    if (totalMs <= 0) return;
    let remaining = totalMs;
    while (remaining > 0) {
      const chunk = Math.min(RATE_LIMIT_SLEEP_CHUNK_MS, remaining);
      await this.sleep(chunk);
      remaining -= chunk;
      this.touchHeartbeat();
    }
  }

  delay(ms: number): Promise<void> {
    return this.sleep(ms);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "gmiscore",
    };
  }

  private extractRateLimit(payload: unknown): GraphQLResult["rateLimit"] {
    if (!payload || typeof payload !== "object") return undefined;
    const data = payload as Record<string, unknown>;
    const inner = data.data as Record<string, unknown> | undefined;
    const rl = data.rateLimit ?? inner?.rateLimit;
    if (rl && typeof rl === "object") {
      return rl as { cost: number; remaining: number; resetAt: string };
    }
    return undefined;
  }

  private async waitForRateLimit(remaining: number, resetAt: string): Promise<void> {
    if (remaining >= 100) return;
    const resetMs = new Date(resetAt).getTime();
    const waitMs = Math.max(0, resetMs - Date.now() + 1000);
    await this.chunkedSleep(waitMs);
  }

  private async waitForHttpRateLimit(response: Response): Promise<void> {
    if (response.status !== 403 && response.status !== 429) return;
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!Number.isNaN(seconds)) {
        await this.chunkedSleep(seconds * 1000);
        return;
      }
    }
    const resetHeader = response.headers.get("X-RateLimit-Reset");
    if (resetHeader) {
      const resetSec = parseInt(resetHeader, 10);
      if (!Number.isNaN(resetSec)) {
        const waitMs = Math.max(0, resetSec * 1000 - Date.now() + 1000);
        await this.chunkedSleep(waitMs);
        return;
      }
    }
    await this.chunkedSleep(2000);
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    options: {
      first?: number;
      retried502?: boolean;
      connectionField?: string;
    } = {},
  ): Promise<{ httpStatus: number; body: GraphQLResult & Record<string, unknown> }> {
    const connectionField = options.connectionField;
    const first =
      options.first ??
      extractFirstFromQuery(query, connectionField);
    const effectiveQuery =
      first !== undefined
        ? applyFirstToQuery(query, connectionField, first)
        : query;

    let response = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query: effectiveQuery, variables }),
    });

    if (response.status === 403 || response.status === 429) {
      await this.waitForHttpRateLimit(response);
      response = await this.fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query: effectiveQuery, variables }),
      });
    }

    if (
      (response.status === 502 || response.status === 504) &&
      !options.retried502
    ) {
      await this.sleep(2000);
      return this.graphql(query, variables, {
        first,
        retried502: true,
        connectionField,
      });
    }

    if (
      (response.status === 502 || response.status === 504) &&
      options.retried502 &&
      first !== undefined &&
      first > 10
    ) {
      const halved = Math.max(10, Math.floor(first / 2));
      return this.graphql(query, variables, {
        first: halved,
        retried502: false,
        connectionField,
      });
    }

    const body = (await response.json()) as GraphQLResult & Record<string, unknown>;
    const rateLimit =
      this.extractRateLimit(body) ??
      (body.data
        ? ((body.data as Record<string, unknown>).rateLimit as GraphQLResult["rateLimit"])
        : undefined);
    if (rateLimit) {
      await this.waitForRateLimit(rateLimit.remaining, rateLimit.resetAt);
    }

    return { httpStatus: response.status, body };
  }

  async graphqlWithRetry(
    query: string,
    variables: Record<string, unknown> = {},
    connectionField?: string,
  ): Promise<{
    success: boolean;
    httpStatus: number;
    payload: unknown;
  }> {
    const first = extractFirstFromQuery(query, connectionField);
    let attempt = await this.graphql(query, variables, { first, connectionField });
    const hasErrors =
      Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;

    if (!hasErrors && attempt.httpStatus < 400) {
      return { success: true, httpStatus: attempt.httpStatus, payload: attempt.body };
    }

    await this.sleep(2000);
    attempt = await this.graphql(query, variables, { first, connectionField });
    const secondHasErrors =
      Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;

    if (!secondHasErrors && attempt.httpStatus < 400) {
      return { success: true, httpStatus: attempt.httpStatus, payload: attempt.body };
    }

    return {
      success: false,
      httpStatus: attempt.httpStatus,
      payload: attempt.body,
    };
  }

  async restGet(path: string): Promise<{
    httpStatus: number;
    payload: unknown;
    parseError: boolean;
  }> {
    const url = path.startsWith("https://")
      ? path
      : `https://api.github.com${path.startsWith("/") ? path : `/${path}`}`;

    let response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });

    if (response.status === 403 || response.status === 429) {
      await this.waitForHttpRateLimit(response);
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers(),
      });
    }

    let payload: unknown;
    let parseError = false;
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
      parseError = true;
    }

    return { httpStatus: response.status, payload, parseError };
  }
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export function getNested(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export async function paginateConnection(
  client: GitHubClient,
  store: Store,
  ingestRunId: number,
  queryName: string,
  query: string,
  baseVariables: Record<string, unknown>,
  connectionPath: string[],
  options: {
    notASignal?: boolean;
    metadata?: Record<string, unknown>;
    onPage?: (payload: unknown) => void;
  } = {},
): Promise<{ success: boolean; pages: number }> {
  let after: string | null = null;
  let pages = 0;
  let hasNextPage = true;
  const connectionField = connectionPath[connectionPath.length - 1];
  const first = extractFirstFromQuery(query, connectionField);

  while (hasNextPage) {
    const variables = { ...baseVariables, after };

    let attempt = await client.graphql(query, variables, { first, connectionField });
    store.insertIngestResponse({
      ingestRunId,
      fetchedAt: new Date().toISOString(),
      queryName,
      variables,
      httpStatus: attempt.httpStatus,
      payload: attempt.body,
      notASignal: options.notASignal,
      metadata: options.metadata,
    });
    store.touchIngestRunHeartbeat(ingestRunId);
    pages++;

    let hasErrors =
      Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;

    if (hasErrors || attempt.httpStatus >= 400) {
      await client.delay(2000);
      attempt = await client.graphql(query, variables, { first, connectionField });
      store.insertIngestResponse({
        ingestRunId,
        fetchedAt: new Date().toISOString(),
        queryName,
        variables,
        httpStatus: attempt.httpStatus,
        payload: attempt.body,
        notASignal: options.notASignal,
        metadata: options.metadata,
      });
      store.touchIngestRunHeartbeat(ingestRunId);
      pages++;
      hasErrors =
        Array.isArray(attempt.body.errors) && attempt.body.errors.length > 0;
      if (hasErrors || attempt.httpStatus >= 400) {
        return { success: false, pages };
      }
    }

    options.onPage?.(attempt.body);

    const data = (attempt.body as GraphQLResult).data;
    const parentPath = connectionPath.slice(0, -1);

    if (parentPath.length > 0) {
      const parent = getNested(data, parentPath);
      if (parent == null) {
        return { success: false, pages };
      }
    }

    const connection = getNested(data, connectionPath) as
      | { pageInfo?: PageInfo; nodes?: unknown[] }
      | undefined;

    if (!connection) {
      return { success: false, pages };
    }

    const nodes = connection.nodes ?? [];
    if (nodes.length === 0) break;

    const pageInfo = connection.pageInfo;
    hasNextPage = pageInfo?.hasNextPage ?? false;
    after = pageInfo?.endCursor ?? null;
    if (!hasNextPage) break;
  }

  return { success: true, pages };
}

export function payloadContainsToken(payload: unknown, token: string): boolean {
  const json = JSON.stringify(payload);
  return json.includes(token);
}

export function isRestFailure(result: {
  httpStatus: number;
  parseError: boolean;
}): boolean {
  return result.httpStatus >= 400 || result.parseError;
}

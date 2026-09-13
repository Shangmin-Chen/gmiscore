import type { Store } from "../db/store.js";

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; type?: string; [key: string]: unknown }>;
  rateLimit?: { cost: number; remaining: number; resetAt: string };
}

/** Chunk long secondary-rate-limit sleeps so ingest heartbeat stays fresh. */
export const RATE_LIMIT_SLEEP_CHUNK_MS = 60_000;

export const REMAINING_FLOOR = 200;
export const MAX_IN_FLIGHT = 2;
export const SECONDARY_BACKOFF_MS = [60_000, 120_000, 240_000] as const;

export interface GitHubClientOptions {
  accessToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  store?: Store;
  ingestRunId?: number;
}

const PAGED_CONNECTION_FIELDS = [
  "pullRequestReviewContributions",
  "files",
  "comments",
  "reviews",
  "pullRequests",
  "issueComments",
  "issues",
] as const;

export type ErrorClassification =
  | "success"
  | "primary_rate_limit"
  | "secondary_rate_limit"
  | "validation_1year"
  | "null_data"
  | "partial_data"
  | "http_error"
  | "timeout";

export interface GraphQLAttempt {
  httpStatus: number;
  body: GraphQLResult & Record<string, unknown>;
  headerRemaining: number | undefined;
  retryAfterMs: number | undefined;
  classification: ErrorClassification;
}

export interface RequestOutcome {
  success: boolean;
  httpStatus: number;
  payload: unknown;
  classification: ErrorClassification;
  stoppedRemainingFloor?: boolean;
  secondaryExhausted?: boolean;
}

class Semaphore {
  private inFlight = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.inFlight--;
    const next = this.queue.shift();
    if (next) {
      this.inFlight++;
      next();
    }
  }
}

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

function isSecondaryRateLimitMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("secondary rate limit") ||
    lower.includes("you have exceeded a secondary rate limit") ||
    lower.includes("abuse detection")
  );
}

function hasOneYearValidationError(body: GraphQLResult): boolean {
  if (!Array.isArray(body.errors)) return false;
  return body.errors.some(
    (e) =>
      e.type === "VALIDATION" &&
      e.message.toLowerCase().includes("must not exceed 1 year"),
  );
}

export function isPrimaryRateLimit(
  httpStatus: number,
  body: GraphQLResult,
  headerRemaining: number | undefined,
): boolean {
  if (![200, 403, 429].includes(httpStatus)) return false;
  if (headerRemaining === 0) return true;
  if (!Array.isArray(body.errors)) return false;
  return body.errors.some(
    (e) => e.type === "RATE_LIMITED" || e.type === "RATE_LIMIT",
  );
}

export function isSecondaryRateLimit(
  httpStatus: number,
  body: GraphQLResult,
  headerRemaining: number | undefined,
): boolean {
  if (![200, 403, 429].includes(httpStatus)) return false;
  if (headerRemaining == null || headerRemaining <= 0) return false;
  const messages = (body.errors ?? []).map((e) => e.message).join(" ");
  return isSecondaryRateLimitMessage(messages);
}

function classifyResponse(
  httpStatus: number,
  body: GraphQLResult,
  headerRemaining: number | undefined,
): ErrorClassification {
  if (isPrimaryRateLimit(httpStatus, body, headerRemaining)) {
    return "primary_rate_limit";
  }
  if (hasOneYearValidationError(body)) {
    return "validation_1year";
  }
  if (isSecondaryRateLimit(httpStatus, body, headerRemaining)) {
    return "secondary_rate_limit";
  }
  if (httpStatus === 502 || httpStatus === 504) {
    return "timeout";
  }
  if (httpStatus >= 400) {
    return "http_error";
  }
  if (body.data == null) {
    return "null_data";
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return "partial_data";
  }
  return "success";
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = parseInt(raw, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function nodesFieldIsNull(body: GraphQLResult): boolean {
  const data = body.data;
  if (data == null || typeof data !== "object") return false;
  return (data as Record<string, unknown>).nodes === null;
}

export class GitHubClient {
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private store?: Store;
  private ingestRunId?: number;
  private semaphore = new Semaphore(MAX_IN_FLIGHT);
  lastHeaderRemaining: number | undefined;
  afterQ1 = false;

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

  markAfterQ1(): void {
    this.afterQ1 = true;
  }

  shouldStopForRemainingFloor(): boolean {
    return (
      this.afterQ1 &&
      this.lastHeaderRemaining != null &&
      this.lastHeaderRemaining < REMAINING_FLOOR
    );
  }

  private touchHeartbeat(): void {
    if (this.store && this.ingestRunId != null) {
      this.store.touchIngestRunHeartbeat(this.ingestRunId);
    }
  }

  async chunkedSleep(totalMs: number): Promise<void> {
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

  private parseHeaderRemaining(response: Response): number | undefined {
    const raw = response.headers.get("x-ratelimit-remaining");
    if (raw == null) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  private updateRemaining(headerRemaining: number | undefined, body: GraphQLResult): void {
    if (headerRemaining != null) {
      this.lastHeaderRemaining = headerRemaining;
      return;
    }
    const rl = body.rateLimit ?? (body.data as Record<string, unknown> | undefined)?.rateLimit;
    if (rl && typeof rl === "object" && "remaining" in rl) {
      this.lastHeaderRemaining = (rl as { remaining: number }).remaining;
    }
  }

  async rawGraphql(
    query: string,
    variables: Record<string, unknown> = {},
    options: {
      first?: number;
      retried502?: boolean;
      connectionField?: string;
    } = {},
  ): Promise<GraphQLAttempt> {
    await this.semaphore.acquire();
    try {
      const connectionField = options.connectionField;
      let effectiveQuery = query;
      if (options.first !== undefined && connectionField) {
        effectiveQuery = applyFirstToQuery(query, connectionField, options.first);
      }

      const response = await this.fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query: effectiveQuery, variables }),
      });

      const headerRemaining = this.parseHeaderRemaining(response);
      const retryAfterMs = parseRetryAfterMs(response);
      let body: GraphQLResult & Record<string, unknown>;

      if (response.status === 502 || response.status === 504) {
        body = { data: undefined };
      } else {
        body = (await response.json()) as GraphQLResult & Record<string, unknown>;
      }

      this.updateRemaining(headerRemaining, body);

      return {
        httpStatus: response.status,
        body,
        headerRemaining,
        retryAfterMs,
        classification: classifyResponse(response.status, body, headerRemaining),
      };
    } finally {
      this.semaphore.release();
    }
  }

  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    options: {
      first?: number;
      retried502?: boolean;
      connectionField?: string;
      secondaryAttempt?: number;
    } = {},
  ): Promise<{ httpStatus: number; body: GraphQLResult & Record<string, unknown> }> {
    const connectionField = options.connectionField;
    const first =
      options.first ?? extractFirstFromQuery(query, connectionField);

    let attempt = await this.rawGraphql(query, variables, {
      first,
      retried502: options.retried502,
      connectionField,
    });

    if (attempt.classification === "secondary_rate_limit") {
      const backoffIdx = options.secondaryAttempt ?? 0;
      if (backoffIdx < SECONDARY_BACKOFF_MS.length) {
        await this.chunkedSleep(
          attempt.retryAfterMs ?? SECONDARY_BACKOFF_MS[backoffIdx],
        );
        return this.graphql(query, variables, {
          ...options,
          secondaryAttempt: backoffIdx + 1,
        });
      }
    }

    if (attempt.classification === "timeout" && !options.retried502) {
      await this.sleep(2000);
      return this.graphql(query, variables, {
        first,
        retried502: true,
        connectionField,
        secondaryAttempt: options.secondaryAttempt,
      });
    }

    if (
      attempt.classification === "timeout" &&
      options.retried502 &&
      first !== undefined &&
      first > 10 &&
      connectionField
    ) {
      const halved = Math.max(10, Math.floor(first / 2));
      return this.graphql(query, variables, {
        first: halved,
        retried502: false,
        connectionField,
        secondaryAttempt: options.secondaryAttempt,
      });
    }

    return { httpStatus: attempt.httpStatus, body: attempt.body };
  }

  async executeRequest(
    query: string,
    variables: Record<string, unknown> = {},
    options: {
      connectionField?: string;
      isQ1?: boolean;
      nodesBatch?: boolean;
    } = {},
  ): Promise<RequestOutcome> {
    if (!options.isQ1 && this.shouldStopForRemainingFloor()) {
      return {
        success: false,
        httpStatus: 0,
        payload: null,
        classification: "primary_rate_limit",
        stoppedRemainingFloor: true,
      };
    }

    const connectionField = options.connectionField;
    const first = extractFirstFromQuery(query, connectionField);
    let secondaryAttempt = 0;

    while (true) {
      let attempt = await this.rawGraphql(query, variables, {
        first,
        connectionField,
      });

      if (attempt.classification === "primary_rate_limit") {
        return {
          success: false,
          httpStatus: attempt.httpStatus,
          payload: attempt.body,
          classification: "primary_rate_limit",
        };
      }

      if (attempt.classification === "validation_1year") {
        return {
          success: false,
          httpStatus: attempt.httpStatus,
          payload: attempt.body,
          classification: "validation_1year",
        };
      }

      if (attempt.classification === "secondary_rate_limit") {
        if (secondaryAttempt >= SECONDARY_BACKOFF_MS.length) {
          return {
            success: false,
            httpStatus: attempt.httpStatus,
            payload: attempt.body,
            classification: "secondary_rate_limit",
            secondaryExhausted: true,
          };
        }
        await this.chunkedSleep(
          attempt.retryAfterMs ?? SECONDARY_BACKOFF_MS[secondaryAttempt],
        );
        secondaryAttempt++;
        continue;
      }

      if (attempt.classification === "timeout") {
        await this.sleep(2000);
        attempt = await this.rawGraphql(query, variables, {
          first,
          retried502: true,
          connectionField,
        });

        if (attempt.classification === "timeout") {
          if (first !== undefined && first > 10 && connectionField) {
            const halved = Math.max(10, Math.floor(first / 2));
            attempt = await this.rawGraphql(query, variables, {
              first: halved,
              connectionField,
            });
          }
          if (attempt.classification === "timeout") {
            return {
              success: false,
              httpStatus: attempt.httpStatus,
              payload: attempt.body,
              classification: "timeout",
            };
          }
        }
      }

      const nodesNull =
        options.nodesBatch &&
        (attempt.classification === "null_data" ||
          (attempt.body.data != null && nodesFieldIsNull(attempt.body)));

      if (nodesNull || attempt.classification === "null_data") {
        await this.sleep(2000);
        const retry = await this.rawGraphql(query, variables, {
          first,
          connectionField,
        });
        if (retry.classification === "primary_rate_limit") {
          return {
            success: false,
            httpStatus: retry.httpStatus,
            payload: retry.body,
            classification: "primary_rate_limit",
          };
        }
        if (retry.classification === "validation_1year") {
          return {
            success: false,
            httpStatus: retry.httpStatus,
            payload: retry.body,
            classification: "validation_1year",
          };
        }
        if (retry.classification === "secondary_rate_limit") {
          continue;
        }
        const retryNodesNull =
          options.nodesBatch &&
          (retry.classification === "null_data" ||
            (retry.body.data != null && nodesFieldIsNull(retry.body)));
        if (
          retry.classification === "null_data" ||
          retry.body.data == null ||
          retryNodesNull
        ) {
          return {
            success: false,
            httpStatus: retry.httpStatus,
            payload: retry.body,
            classification: "null_data",
          };
        }
        attempt = retry;
      }

      if (attempt.classification === "secondary_rate_limit") {
        continue;
      }

      if (
        attempt.classification === "partial_data" ||
        attempt.classification === "success"
      ) {
        return {
          success: attempt.classification === "success",
          httpStatus: attempt.httpStatus,
          payload: attempt.body,
          classification: attempt.classification,
        };
      }

      return {
        success: false,
        httpStatus: attempt.httpStatus,
        payload: attempt.body,
        classification: attempt.classification,
      };
    }
  }
}

export function getNested(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function chunkIds<T>(ids: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

export function payloadContainsToken(payload: unknown, token: string): boolean {
  const json = JSON.stringify(payload);
  return json.includes(token);
}

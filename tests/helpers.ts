import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../src/db/schema.js";
import { Store } from "../src/db/store.js";
import { TokenEncryption } from "../src/crypto/token-encryption.js";

export { TokenEncryption };
import { GitHubClient } from "../src/github/client.js";
import { runIngest } from "../src/github/ingest.js";

export interface TestEnv {
  dir: string;
  store: Store;
  encryption: TokenEncryption;
  cleanup: () => void;
}

export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "gmiscore-test-"));
  const db = initDb(join(dir, "test.sqlite"));
  const store = new Store(db);
  const encryption = new TokenEncryption(dir, "test-encryption-key");
  return {
    dir,
    store,
    encryption,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function createTestUser(store: Store, encryption: TokenEncryption) {
  return store.upsertUser({
    githubUserId: "12345",
    githubLogin: "testuser",
    encryptedToken: encryption.encrypt("gho_test_token_secret"),
    encryptedRefreshToken: null,
    tokenExpiresAt: null,
    tokenScopes: "read:user,repo",
    now: new Date().toISOString(),
  });
}

type MockResponse = {
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
};

export function createMockFetch(
  handlers: Array<{
    match: (req: MockResponse) => boolean;
    response: (req: MockResponse) => Response | Promise<Response>;
  }>,
): {
  fetch: typeof fetch;
  calls: MockResponse[];
  order: string[];
  q12Calls: number;
} {
  const calls: MockResponse[] = [];
  const order: string[] = [];
  let q12Calls = 0;

  const mockFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body?.toString();
    const headers = init?.headers as Record<string, string> | undefined;
    const req: MockResponse = { url, method, body, headers };
    calls.push(req);

    if (url.includes("/graphql")) {
      try {
        const parsed = JSON.parse(body ?? "{}") as { query?: string };
        if (parsed.query?.includes("ViewerProfile")) order.push("Q1");
        else if (parsed.query?.includes("ViewerPullRequests")) order.push("Q2");
        else if (parsed.query?.includes("ViewerIssueComments")) order.push("Q3");
        else if (
          parsed.query?.includes("ContributionYears") ||
          parsed.query?.includes("ContribYear")
        )
          order.push("Q4");
        else if (parsed.query?.includes("ViewerIssues")) order.push("Q5");
        else if (parsed.query?.includes("PrCore")) order.push("Q6");
        else if (parsed.query?.includes("IssueOrPr")) {
          order.push("Q12");
          q12Calls++;
        }
        else if (parsed.query?.includes("PrFiles")) order.push("Q7");
        else if (parsed.query?.includes("RepoAuthorHistory")) order.push("Q14");
        else if (parsed.query?.includes("ReviewsByAuthor")) order.push("Q13");
      } catch {
        /* ignore */
      }
    }

    for (const handler of handlers) {
      if (handler.match(req)) {
        return handler.response(req);
      }
    }

    return new Response(
      JSON.stringify({
        data: {},
        rateLimit: {
          cost: 1,
          remaining: 5000,
          resetAt: new Date(Date.now() + 3600000).toISOString(),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  return { fetch: mockFetch, calls, order, q12Calls };
}

export async function runTestIngest(
  store: Store,
  fetchImpl: typeof fetch,
  userId: number,
): Promise<number> {
  const client = new GitHubClient("gho_test_token_secret", {
    fetchImpl,
    sleep: async () => {},
  });
  return runIngest(store, client, userId, "read:user,repo");
}

export const rateLimit = {
  cost: 1,
  remaining: 5000,
  resetAt: new Date(Date.now() + 3600000).toISOString(),
};

export function gqlOk(data: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ data: { ...data, rateLimit } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

export function gqlError(message: string): Response {
  return new Response(
    JSON.stringify({ data: null, errors: [{ message }], rateLimit }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

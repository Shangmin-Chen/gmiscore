import type { DatabaseSync } from "node:sqlite";
import type { RunStatus, IngestRunRow, IngestResponseRow, UserRow } from "./schema.js";
import { ZOMBIE_RUN_MS } from "./schema.js";
import { IngestAlreadyRunningError } from "../errors.js";

export class Store {
  constructor(private db: DatabaseSync) {}

  createOAuthState(state: string, createdAt: string): void {
    this.db
      .prepare("INSERT INTO oauth_states (state, created_at) VALUES (?, ?)")
      .run(state, createdAt);
  }

  getOAuthState(state: string): { state: string; created_at: string } | undefined {
    return this.db
      .prepare("SELECT state, created_at FROM oauth_states WHERE state = ?")
      .get(state) as { state: string; created_at: string } | undefined;
  }

  deleteOAuthState(state: string): void {
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  }

  purgeExpiredOAuthStates(cutoffIso: string): void {
    this.db
      .prepare("DELETE FROM oauth_states WHERE created_at < ?")
      .run(cutoffIso);
  }

  upsertUser(params: {
    githubUserId: string;
    githubLogin: string;
    encryptedToken: string;
    encryptedRefreshToken: string | null;
    tokenExpiresAt: string | null;
    tokenScopes: string;
    now: string;
  }): UserRow {
    const existing = this.db
      .prepare("SELECT * FROM users WHERE github_user_id = ?")
      .get(params.githubUserId) as UserRow | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE users SET github_login = ?, encrypted_token = ?, encrypted_refresh_token = ?,
           token_expires_at = ?, token_scopes = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          params.githubLogin,
          params.encryptedToken,
          params.encryptedRefreshToken,
          params.tokenExpiresAt,
          params.tokenScopes,
          params.now,
          existing.id,
        );
      return this.getUserById(existing.id)!;
    }

    const result = this.db
      .prepare(
        `INSERT INTO users (github_user_id, github_login, encrypted_token, encrypted_refresh_token,
         token_expires_at, token_scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.githubUserId,
        params.githubLogin,
        params.encryptedToken,
        params.encryptedRefreshToken,
        params.tokenExpiresAt,
        params.tokenScopes,
        params.now,
        params.now,
      );
    return this.getUserById(Number(result.lastInsertRowid))!;
  }

  getUserById(id: number): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
  }

  updateUserToken(
    userId: number,
    encryptedToken: string,
    encryptedRefreshToken: string | null,
    tokenExpiresAt: string | null,
    tokenScopes: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE users SET encrypted_token = ?, encrypted_refresh_token = ?,
         token_expires_at = ?, token_scopes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        encryptedToken,
        encryptedRefreshToken,
        tokenExpiresAt,
        tokenScopes,
        now,
        userId,
      );
  }

  createIngestRun(params: {
    userId: number;
    githubUserId: string;
    githubLogin: string;
    tokenScopes: string;
    startedAt: string;
    heartbeatAt?: string;
  }): IngestRunRow {
    const heartbeatAt = params.heartbeatAt ?? params.startedAt;
    const result = this.db
      .prepare(
        `INSERT INTO ingest_runs (user_id, github_user_id, github_login, token_scopes, status, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        params.userId,
        params.githubUserId,
        params.githubLogin,
        params.tokenScopes,
        params.startedAt,
        heartbeatAt,
      );
    return this.getIngestRun(Number(result.lastInsertRowid))!;
  }

  touchIngestRunHeartbeat(ingestRunId: number, heartbeatAt?: string): void {
    this.db
      .prepare("UPDATE ingest_runs SET heartbeat_at = ? WHERE id = ?")
      .run(heartbeatAt ?? new Date().toISOString(), ingestRunId);
  }

  getIngestRun(id: number): IngestRunRow | undefined {
    return this.db.prepare("SELECT * FROM ingest_runs WHERE id = ?").get(id) as
      | IngestRunRow
      | undefined;
  }

  getRunningRunForUser(userId: number): IngestRunRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM ingest_runs WHERE user_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as IngestRunRow | undefined;
  }

  failStaleRunningRuns(cutoffIso: string): number {
    const stale = this.db
      .prepare(
        `SELECT id FROM ingest_runs WHERE status = 'running' AND heartbeat_at < ?`,
      )
      .all(cutoffIso) as Array<{ id: number }>;

    const finishedAt = new Date().toISOString();
    const hasResponse = this.db.prepare(
      `SELECT 1 FROM ingest_responses
       WHERE ingest_run_id = ?
         AND query_name GLOB 'Q[0-9]*'
       LIMIT 1`,
    );
    const update = this.db.prepare(
      `UPDATE ingest_runs SET status = ?, finished_at = ? WHERE id = ?`,
    );

    for (const { id } of stale) {
      const status = hasResponse.get(id) ? "partial" : "failed";
      update.run(status, finishedAt, id);
    }

    return stale.length;
  }

  tryBeginIngestRun(params: {
    userId: number;
    githubUserId: string;
    githubLogin: string;
    tokenScopes: string;
    startedAt: string;
  }): IngestRunRow {
    const cutoff = new Date(Date.now() - ZOMBIE_RUN_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.failStaleRunningRuns(cutoff);
      if (this.getRunningRunForUser(params.userId)) {
        this.db.exec("ROLLBACK");
        throw new IngestAlreadyRunningError();
      }
      const result = this.db
        .prepare(
          `INSERT INTO ingest_runs (user_id, github_user_id, github_login, token_scopes, status, started_at, heartbeat_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          params.userId,
          params.githubUserId,
          params.githubLogin,
          params.tokenScopes,
          params.startedAt,
          params.startedAt,
        );
      const run = this.getIngestRun(Number(result.lastInsertRowid))!;
      this.db.exec("COMMIT");
      return run;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      if (
        err instanceof IngestAlreadyRunningError ||
        (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new IngestAlreadyRunningError();
      }
      throw err;
    }
  }

  updateIngestRunStatus(id: number, status: RunStatus, finishedAt: string | null): void {
    this.db
      .prepare("UPDATE ingest_runs SET status = ?, finished_at = ? WHERE id = ?")
      .run(status, finishedAt, id);
  }

  updateIngestRunProfile(
    id: number,
    githubUserId: string,
    githubLogin: string,
  ): void {
    this.db
      .prepare(
        "UPDATE ingest_runs SET github_user_id = ?, github_login = ? WHERE id = ?",
      )
      .run(githubUserId, githubLogin, id);
  }

  updateIngestRunWindow(id: number, windowStart: string): void {
    this.db
      .prepare("UPDATE ingest_runs SET window_start = ? WHERE id = ?")
      .run(windowStart, id);
  }

  updateIngestRunSubsets(
    id: number,
    subsets: {
      hydratePrIds: string[];
      q9PrIds: string[];
      q13PrIds: string[];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE ingest_runs SET hydrate_pr_ids = ?, q9_pr_ids = ?, q13_pr_ids = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(subsets.hydratePrIds),
        JSON.stringify(subsets.q9PrIds),
        JSON.stringify(subsets.q13PrIds),
        id,
      );
  }

  insertIngestResponse(params: {
    ingestRunId: number;
    fetchedAt: string;
    queryName: string;
    variables: Record<string, unknown>;
    httpStatus: number;
    payload: unknown;
    notASignal?: boolean;
    metadata?: Record<string, unknown>;
  }): IngestResponseRow {
    const result = this.db
      .prepare(
        `INSERT INTO ingest_responses (ingest_run_id, fetched_at, query_name, variables, http_status, payload, not_a_signal, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.ingestRunId,
        params.fetchedAt,
        params.queryName,
        JSON.stringify(params.variables),
        params.httpStatus,
        JSON.stringify(params.payload),
        params.notASignal ? 1 : 0,
        JSON.stringify(params.metadata ?? {}),
      );
    return this.db
      .prepare("SELECT * FROM ingest_responses WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as IngestResponseRow;
  }

  updateIngestResponseMetadata(
    id: number,
    metadata: Record<string, unknown>,
  ): void {
    this.db
      .prepare("UPDATE ingest_responses SET metadata = ? WHERE id = ?")
      .run(JSON.stringify(metadata), id);
  }

  countIngestResponses(ingestRunId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM ingest_responses WHERE ingest_run_id = ?")
      .get(ingestRunId) as { count: number };
    return row.count;
  }

  getIngestResponses(ingestRunId: number): IngestResponseRow[] {
    return this.db
      .prepare("SELECT * FROM ingest_responses WHERE ingest_run_id = ? ORDER BY id")
      .all(ingestRunId) as unknown as IngestResponseRow[];
  }

  getLatestRunForUser(userId: number): IngestRunRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM ingest_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(userId) as IngestRunRow | undefined;
  }
}

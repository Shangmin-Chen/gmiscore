import { DatabaseSync } from "node:sqlite";

export type RunStatus = "running" | "complete" | "partial" | "failed";

export interface UserRow {
  id: number;
  github_user_id: string;
  github_login: string;
  encrypted_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  token_scopes: string;
  created_at: string;
  updated_at: string;
}

export interface IngestRunRow {
  id: number;
  user_id: number;
  github_user_id: string;
  github_login: string;
  token_scopes: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
}

export interface IngestResponseRow {
  id: number;
  ingest_run_id: number;
  fetched_at: string;
  query_name: string;
  variables: string;
  http_status: number;
  payload: string;
  not_a_signal: number;
  metadata: string;
}

function migrateSchema(db: DatabaseSync): void {
  const responseCols = db.prepare("PRAGMA table_info(ingest_responses)").all() as Array<{
    name: string;
  }>;
  if (!responseCols.some((c) => c.name === "metadata")) {
    db.exec(
      `ALTER TABLE ingest_responses ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`,
    );
  }

  const runCols = db.prepare("PRAGMA table_info(ingest_runs)").all() as Array<{
    name: string;
  }>;
  if (!runCols.some((c) => c.name === "heartbeat_at")) {
    db.exec(`ALTER TABLE ingest_runs ADD COLUMN heartbeat_at TEXT`);
    db.exec(`UPDATE ingest_runs SET heartbeat_at = started_at WHERE heartbeat_at IS NULL`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_runs_one_running_per_user
      ON ingest_runs(user_id) WHERE status = 'running'
  `);
}

export const ZOMBIE_RUN_MS = 30 * 60 * 1000;

export function initDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_user_id TEXT UNIQUE NOT NULL,
      github_login TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      encrypted_refresh_token TEXT,
      token_expires_at TEXT,
      token_scopes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      github_user_id TEXT NOT NULL,
      github_login TEXT NOT NULL,
      token_scopes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      heartbeat_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS ingest_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingest_run_id INTEGER NOT NULL REFERENCES ingest_runs(id),
      fetched_at TEXT NOT NULL,
      query_name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      http_status INTEGER NOT NULL,
      payload TEXT NOT NULL,
      not_a_signal INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ingest_responses_run ON ingest_responses(ingest_run_id);
    CREATE INDEX IF NOT EXISTS idx_ingest_runs_user ON ingest_runs(user_id);
  `);
  migrateSchema(db);
  return db;
}

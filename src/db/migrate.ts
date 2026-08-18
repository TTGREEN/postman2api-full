import { db, client } from "./index";
import { sql } from "drizzle-orm";

async function migrate() {
  console.log("[migrate] Creating tables...");

  await db.run(sql`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    enabled INTEGER NOT NULL DEFAULT 1,
    tokens TEXT,
    quota_limit REAL DEFAULT 0,
    quota_remaining REAL DEFAULT 0,
    quota_reset_at INTEGER,
    last_used_at INTEGER,
    last_login_at INTEGER,
    error_message TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER REFERENCES accounts(id),
    model TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    error_message TEXT,
    created_at INTEGER NOT NULL
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS session_states (
    session_id TEXT PRIMARY KEY,
    account_id INTEGER,
    messages TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS automation_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'registration',
    mode TEXT NOT NULL DEFAULT 'upstream',
    target TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    requested INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    retry_limit INTEGER NOT NULL DEFAULT 1,
    input TEXT NOT NULL,
    result TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  )`);

  await db.run(sql`CREATE TABLE IF NOT EXISTS automation_job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES automation_jobs(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    stage TEXT,
    attempt_index INTEGER,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
  )`);

  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs(created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs(status, created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs(account_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS session_states_updated_at_idx ON session_states(updated_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS session_states_account_idx ON session_states(account_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS automation_jobs_status_updated_at_idx ON automation_jobs(status, updated_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS automation_job_events_job_seq_idx ON automation_job_events(job_id, seq)`);

  await db.run(sql`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('admin_key', 'postman2api', ${Date.now()})`);

  console.log("[migrate] Done. Tables created: accounts, request_logs, settings, session_states, automation_jobs, automation_job_events");
  client.close();
}

migrate().catch((err) => {
  console.error("[migrate] Error:", err);
  process.exit(1);
});

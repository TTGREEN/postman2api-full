import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "./schema";
import { config } from "../config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

mkdirSync(dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec(`CREATE TABLE IF NOT EXISTS session_states (
  session_id TEXT PRIMARY KEY,
  account_id INTEGER,
  messages TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`);
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_updated_at_idx ON session_states(updated_at);");
sqlite.exec("CREATE INDEX IF NOT EXISTS session_states_account_idx ON session_states(account_id);");
sqlite.exec(`CREATE TABLE IF NOT EXISTS automation_jobs (
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
);`);
sqlite.exec("CREATE INDEX IF NOT EXISTS automation_jobs_status_updated_at_idx ON automation_jobs(status, updated_at);");
sqlite.exec(`CREATE TABLE IF NOT EXISTS automation_job_events (
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
);`);
sqlite.exec("CREATE INDEX IF NOT EXISTS automation_job_events_job_seq_idx ON automation_job_events(job_id, seq);");

export const db = drizzle(sqlite, { schema });
export { sqlite as client };
export type DB = typeof db;

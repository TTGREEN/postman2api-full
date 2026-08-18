import { sqliteTable, text, real, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  password: text("password").notNull(),
  status: text("status").notNull().default("pending"), // active | exhausted | error | pending | cooling
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  tokens: text("tokens"),
  quotaLimit: real("quota_limit").default(0),
  quotaRemaining: real("quota_remaining").default(0),
  quotaResetAt: integer("quota_reset_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  errorMessage: text("error_message"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("accounts_email_idx").on(table.email),
]);

export const requestLogs = sqliteTable("request_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").references(() => accounts.id),
  model: text("model"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  status: text("status").notNull(), // success | error
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("request_logs_created_at_idx").on(table.createdAt),
  index("request_logs_status_created_at_idx").on(table.status, table.createdAt),
  index("request_logs_account_idx").on(table.accountId),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const sessionStates = sqliteTable("session_states", {
  sessionId: text("session_id").primaryKey(),
  accountId: integer("account_id"),
  messages: text("messages").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("session_states_updated_at_idx").on(table.updatedAt),
  index("session_states_account_idx").on(table.accountId),
]);

export const automationJobs = sqliteTable("automation_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull().default("registration"),
  mode: text("mode").notNull().default("upstream"),
  target: text("target").notNull(),
  status: text("status").notNull().default("queued"),
  requested: integer("requested").notNull(),
  completed: integer("completed").notNull().default(0),
  retryLimit: integer("retry_limit").notNull().default(1),
  input: text("input").notNull(),
  result: text("result"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
}, (table) => [
  index("automation_jobs_status_updated_at_idx").on(table.status, table.updatedAt),
]);

export const automationJobEvents = sqliteTable("automation_job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => automationJobs.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  stage: text("stage"),
  attemptIndex: integer("attempt_index"),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  payload: text("payload"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("automation_job_events_job_seq_idx").on(table.jobId, table.seq),
]);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type SessionState = typeof sessionStates.$inferSelect;
export type AutomationJob = typeof automationJobs.$inferSelect;
export type AutomationJobEvent = typeof automationJobEvents.$inferSelect;

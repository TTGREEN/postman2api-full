import { Hono, type Context } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs } from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../utils/crypto";
import { loginPostmanAccount } from "../auth/bridge";
import { clearSignupConfirmation, confirmSignupCompletion, prepareSignupConfirmation } from "../auth/postman-login";
import { testAccountAvailability } from "../auth/account-test";
import { warmupAccount } from "../auth/warmup";
import { acquireSignupTask, getActiveSignupTask, releaseSignupTask } from "../auth/signup-task";
import {
  tempEmailPreviewSessions,
  type TempEmailPreviewSession,
} from "../auth/temp-email-preview-runtime";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export const accountsRouter = new Hono();

export interface TempEmailPreviewService {
  create: () => Promise<TempEmailPreviewSession>;
  focus: (sessionId: string) => Promise<boolean>;
  close: (sessionId: string) => Promise<boolean>;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizePreviewEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)
    ? email
    : null;
}

export async function handleTempEmailPreviewRequest(
  c: Context,
  service: TempEmailPreviewService = tempEmailPreviewSessions,
) {
  try {
    const session = await service.create();
    const email = normalizePreviewEmail(session.email);
    if (!email) {
      await service.close(session.sessionId).catch(() => undefined);
      return c.json({ error: "临时邮箱页面未返回有效邮箱地址" }, 502);
    }
    return c.json({ success: true, sessionId: session.sessionId, email, expiresAt: session.expiresAt });
  } catch {
    console.warn("[temp-email-preview] Preview worker failed");
    return c.json({ error: "获取测试邮箱失败，请稍后重试" }, 502);
  }
}

accountsRouter.post("/signup/email-preview", (c) => handleTempEmailPreviewRequest(c));

export async function handleOpenTempEmailPreviewRequest(
  c: Context,
  service: TempEmailPreviewService = tempEmailPreviewSessions,
) {
  const sessionId = c.req.param("sessionId") ?? "";
  if (!SESSION_ID_PATTERN.test(sessionId) || !(await service.focus(sessionId))) {
    return c.json({ error: "临时邮箱会话不存在或已过期" }, 404);
  }
  return c.json({ success: true });
}

export async function handleCloseTempEmailPreviewRequest(
  c: Context,
  service: TempEmailPreviewService = tempEmailPreviewSessions,
) {
  const sessionId = c.req.param("sessionId") ?? "";
  if (!SESSION_ID_PATTERN.test(sessionId) || !(await service.close(sessionId))) {
    return c.json({ error: "临时邮箱会话不存在或已过期" }, 404);
  }
  return c.json({ success: true });
}

accountsRouter.post("/signup/email-preview/:sessionId/open", (c) => handleOpenTempEmailPreviewRequest(c));
accountsRouter.delete("/signup/email-preview/:sessionId", (c) => handleCloseTempEmailPreviewRequest(c));

type LoginAccount = typeof loginPostmanAccount;
type WarmupAccount = typeof warmupAccount;

export interface PostmanAccountTokens {
  postman_sid: string;
  user_id: string;
  workspace_id: string;
  workspace_subdomain: string;
}

export interface AccountImportRecord {
  email: string;
  enabled?: boolean;
  tokens: PostmanAccountTokens;
}

export interface AccountImportResult {
  index: number;
  email?: string;
  status: "created" | "updated" | "failed";
  accountId?: number;
  error?: string;
}

const REQUIRED_TOKEN_FIELDS = ["postman_sid", "user_id", "workspace_id", "workspace_subdomain"] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeImportRecord(value: unknown): { record?: AccountImportRecord; error?: string } {
  if (!isRecord(value)) return { error: "Account entry must be an object" };

  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email)) return { error: "A valid email is required" };
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return { error: "enabled must be a boolean" };
  }
  if (!isRecord(value.tokens)) return { error: "tokens must be an object" };

  const tokens = {} as PostmanAccountTokens;
  for (const field of REQUIRED_TOKEN_FIELDS) {
    const token = value.tokens[field];
    if (typeof token !== "string" || !token.trim()) {
      return { error: `tokens.${field} is required` };
    }
    tokens[field] = token.trim();
  }

  return { record: { email, enabled: value.enabled as boolean | undefined, tokens } };
}

export function normalizeAccountImportPayload(payload: unknown): {
  records?: AccountImportRecord[];
  error?: string;
} {
  if (!isRecord(payload)) return { error: "Import JSON must be an object" };

  if ("accounts" in payload) {
    if (payload.version !== 1) return { error: "Import JSON version must be 1" };
    if (!Array.isArray(payload.accounts)) return { error: "accounts must be an array" };
    if (payload.accounts.length === 0) return { error: "accounts must not be empty" };
    if (payload.accounts.length > 500) return { error: "A single import is limited to 500 accounts" };
    return { records: payload.accounts as AccountImportRecord[] };
  }

  return { records: [payload as unknown as AccountImportRecord] };
}

async function upsertImportedAccount(record: AccountImportRecord): Promise<{
  id: number;
  email: string;
  status: "created" | "updated";
}> {
  const [existing] = await db.select().from(accounts).where(eq(accounts.email, record.email)).limit(1);
  const now = new Date();

  if (existing) {
    const [updated] = await db.update(accounts)
      .set({
        tokens: JSON.stringify(record.tokens),
        enabled: record.enabled ?? existing.enabled,
        status: "active",
        lastLoginAt: now,
        updatedAt: now,
        errorMessage: null,
      })
      .where(eq(accounts.id, existing.id))
      .returning();
    pool.invalidate(updated!.id);
    broadcast({ type: "account_updated", data: { id: updated!.id, status: "active" } });
    return { id: updated!.id, email: updated!.email, status: "updated" };
  }

  const [created] = await db.insert(accounts).values({
    email: record.email,
    password: encrypt("manual"),
    enabled: record.enabled ?? true,
    tokens: JSON.stringify(record.tokens),
    status: "active",
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning();

  broadcast({ type: "account_added", data: { id: created!.id, email: created!.email, status: "active" } });
  return { id: created!.id, email: created!.email, status: "created" };
}

export function sanitizeAccount(acc: typeof accounts.$inferSelect) {
  let tokens: any = acc.tokens;
  if (typeof tokens === "string") {
    try { tokens = JSON.parse(tokens); } catch { tokens = {}; }
  }
  return {
    id: acc.id,
    email: acc.email,
    status: acc.status,
    enabled: acc.enabled,
    quotaLimit: acc.quotaLimit,
    quotaRemaining: acc.quotaRemaining,
    lastUsedAt: acc.lastUsedAt,
    lastLoginAt: acc.lastLoginAt,
    errorMessage: acc.errorMessage,
    hasTokens: !!(tokens?.postman_sid),
    workspaceSubdomain: tokens?.workspace_subdomain || null,
    createdAt: acc.createdAt,
    updatedAt: acc.updatedAt,
  };
}

export async function handleAccountLoginRequest(c: Context, loginAccount: LoginAccount = loginPostmanAccount) {
  const body = await c.req.json().catch(() => ({})) as {
    email?: string;
    flow?: "login" | "signup";
    confirmationId?: string;
    signupAutomation?: { username?: string; password?: string };
  };
  if (!body.email?.trim()) {
    return c.json({ error: "Email required" }, 400);
  }
  if (body.flow && body.flow !== "login" && body.flow !== "signup") {
    return c.json({ error: "flow must be 'login' or 'signup'" }, 400);
  }

  const flow = body.flow ?? "login";
  if (flow === "signup" && !body.confirmationId?.trim()) {
    return c.json({ error: "confirmationId required for signup" }, 400);
  }
  if (body.signupAutomation) {
    if (flow !== "signup") return c.json({ error: "signupAutomation is only valid for signup" }, 400);
    if (typeof body.signupAutomation.password !== "string" || body.signupAutomation.password.length < 8) {
      return c.json({ error: "自动化注册密码至少需要 8 个字符" }, 400);
    }
    if (body.signupAutomation.password.length > 256) {
      return c.json({ error: "自动化注册密码不能超过 256 个字符" }, 400);
    }
    if (body.signupAutomation.username !== undefined) {
      if (typeof body.signupAutomation.username !== "string" || body.signupAutomation.username.trim().length > 64) {
        return c.json({ error: "自动化注册用户名不能超过 64 个字符" }, 400);
      }
    }
  }
  const requestedEmail = body.email.trim();
  if (flow === "signup") {
    const confirmationId = body.confirmationId!;
    if (!acquireSignupTask(confirmationId, requestedEmail)) {
      const active = getActiveSignupTask();
      return c.json({
        error: "已有注册任务正在进行，请先完成或等待其结束",
        activeSignup: active ? { email: active.email, startedAt: active.startedAt } : undefined,
      }, 409);
    }
    if (!prepareSignupConfirmation(confirmationId)) {
      releaseSignupTask(confirmationId);
      return c.json({ error: "Invalid confirmationId" }, 400);
    }
  }
  broadcast({
    type: "login_start",
    data: {
      email: requestedEmail,
      manual: !body.signupAutomation,
      automated: Boolean(body.signupAutomation),
      flow,
      confirmationId: body.confirmationId,
    },
  });

  try {
    const result = await loginAccount(
      requestedEmail,
      undefined,
      undefined,
      flow,
      body.confirmationId,
      body.signupAutomation?.password
        ? { username: body.signupAutomation.username, password: body.signupAutomation.password }
        : undefined,
    );
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({ success: true, accountId: result.accountId, imported: true });
  } finally {
    if (flow === "signup") {
      clearSignupConfirmation(body.confirmationId);
      releaseSignupTask(body.confirmationId!);
    }
  }
}

accountsRouter.post("/signup/confirm", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { confirmationId?: string };
  if (!body.confirmationId?.trim()) return c.json({ error: "confirmationId required" }, 400);
  if (!confirmSignupCompletion(body.confirmationId)) {
    return c.json({ error: "No active signup flow found" }, 409);
  }
  broadcast({ type: "signup_confirmed", data: { confirmationId: body.confirmationId } });
  return c.json({ success: true });
});

// List all accounts
accountsRouter.get("/", async (c) => {
  const allAccounts = await db.select().from(accounts);
  const sanitized = allAccounts.map(sanitizeAccount);
  return c.json({ data: sanitized });
});

// Add account via browser login
accountsRouter.post("/login", async (c) => {
  return handleAccountLoginRequest(c);
});

// Add account via manual token paste
accountsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const normalized = normalizeImportRecord(body);
  if (!normalized.record) return c.json({ error: normalized.error || "Invalid account" }, 400);

  const saved = await upsertImportedAccount(normalized.record);
  return c.json({ success: true, account: { id: saved.id, email: saved.email }, status: saved.status });
});

// Import one account object or a versioned batch document.
accountsRouter.post("/import", async (c) => {
  const body = await c.req.json().catch(() => null);
  const payload = normalizeAccountImportPayload(body);
  if (!payload.records) return c.json({ error: payload.error || "Invalid import JSON" }, 400);

  const results: AccountImportResult[] = [];
  const seenEmails = new Set<string>();
  for (const [index, value] of payload.records.entries()) {
    const normalized = normalizeImportRecord(value);
    if (!normalized.record) {
      results.push({
        index,
        email: isRecord(value) && typeof value.email === "string" ? value.email.trim() : undefined,
        status: "failed",
        error: normalized.error || "Invalid account",
      });
      continue;
    }

    if (seenEmails.has(normalized.record.email)) {
      results.push({ index, email: normalized.record.email, status: "failed", error: "Duplicate email in import JSON" });
      continue;
    }
    seenEmails.add(normalized.record.email);

    try {
      const saved = await upsertImportedAccount(normalized.record);
      results.push({ index, email: saved.email, status: saved.status, accountId: saved.id });
    } catch (error) {
      results.push({
        index,
        email: normalized.record.email,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const created = results.filter((result) => result.status === "created").length;
  const updated = results.filter((result) => result.status === "updated").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return c.json({ success: failed === 0, summary: { total: results.length, created, updated, failed }, results });
});

// Delete account
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  // Nullify FK references in request_logs before deleting
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
  await db.delete(accounts).where(eq(accounts.id, id));
  pool.invalidate(id);
  broadcast({ type: "account_deleted", data: { id } });
  return c.json({ success: true });
});

export async function handleAccountWarmupRequest(
  c: Context,
  warmup: WarmupAccount = warmupAccount,
) {
  const id = Number(c.req.param("id"));
  const result = await warmup(id);
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  if (!account) return c.json({ success: false, error: "Account not found" }, 404);
  return c.json(
    { ...result, account: sanitizeAccount(account) },
    result.success ? 200 : 400,
  );
}

// Warmup / health check single account
accountsRouter.post("/:id/warmup", async (c) => {
  return handleAccountWarmupRequest(c);
});

// Send a minimal real Agent request through one specific account and return its trace.
accountsRouter.post("/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await testAccountAvailability(id);
  return c.json(result);
});

// Toggle enabled
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (body.enabled === undefined) {
    return c.json({ error: "Missing 'enabled' field" }, 400);
  }
  const account = await pool.setEnabled(id, body.enabled);
  return c.json({ success: true, account: { id: account?.id, enabled: account?.enabled } });
});

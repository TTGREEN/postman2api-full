import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { PostmanProvider } from "../provider/postman";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export const ACCOUNT_TEST_MODEL = "auto";
export const ACCOUNT_TEST_PROMPT = "请只回复字符串 POSTMAN2API_OK，不要调用工具，不要添加其他内容。";
const EXPECTED_RESPONSE = "POSTMAN2API_OK";
const ACCOUNT_TEST_TIMEOUT_MS = 60_000;

export type AccountTestLogLevel = "info" | "success" | "warn" | "error";

export interface AccountTestLogEntry {
  step: string;
  message: string;
  level: AccountTestLogLevel;
  ts: number;
  elapsedMs: number;
}

export interface AccountTestResult {
  success: boolean;
  available: boolean;
  accountId: number;
  email?: string;
  model: string;
  prompt: string;
  response?: string;
  error?: string;
  durationMs: number;
  matchedExpectedResponse?: boolean;
  logs: AccountTestLogEntry[];
}

const provider = new PostmanProvider();

export async function testAccountAvailability(accountId: number): Promise<AccountTestResult> {
  const startedAt = Date.now();
  const logs: AccountTestLogEntry[] = [];
  let email: string | undefined;
  let tracked = false;
  let leaseId: string | undefined;

  const addLog = (step: string, message: string, level: AccountTestLogLevel = "info") => {
    const now = Date.now();
    logs.push({ step, message, level, ts: now, elapsedMs: now - startedAt });
  };

  const finish = (
    available: boolean,
    details: Pick<AccountTestResult, "response" | "error" | "matchedExpectedResponse"> = {},
  ): AccountTestResult => ({
    success: available,
    available,
    accountId,
    email,
    model: ACCOUNT_TEST_MODEL,
    prompt: ACCOUNT_TEST_PROMPT,
    durationMs: Date.now() - startedAt,
    logs,
    ...details,
  });

  try {
    addLog("开始", `准备测试账号 #${accountId}`);
    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!account) {
      addLog("账号", "账号不存在", "error");
      return finish(false, { error: "Account not found" });
    }
    email = account.email;
    addLog("账号", `${account.email}，当前状态：${account.status}${account.enabled ? "" : "（已禁用）"}`);

    const valid = await provider.validateAccount(account);
    if (!valid) {
      const error = "Postman token 信息不完整或无效";
      addLog("凭据", error, "error");
      await pool.markError(account.id, error);
      return finish(false, { error });
    }
    addLog("凭据", "必要的 Postman token 字段完整", "success");

    const quotaResult = await provider.fetchQuota(account);
    if (quotaResult.success && quotaResult.quota) {
      const quota = quotaResult.quota;
      const overageText = (quota as any).overageAllowed ? "，已允许超额用量" : "";
      addLog("额度", `剩余 ${quota.remaining} / ${quota.limit}${overageText}`, quota.remaining > 0 ? "success" : "warn");
      if (quota.remaining <= 0 && !(quota as any).overageAllowed) {
        const error = "Postman AI 额度已耗尽";
        addLog("结束", "未发送测试问题，避免一次已知会失败的请求", "error");
        await pool.markExhausted(account.id);
        return finish(false, { error });
      }
    } else {
      addLog("额度", quotaResult.error || "额度接口未返回可识别数据，将继续实际问答测试", "warn");
    }

    const agentModeResult = await provider.ensureAiUserAgentMode(account);
    if (agentModeResult.success) {
      addLog("Agent Mode", agentModeResult.cached ? "ai_user_agent_mode 已确认开启（缓存）" : "已开启账号级 ai_user_agent_mode", "success");
    } else {
      addLog("Agent Mode", agentModeResult.error || "ai_user_agent_mode 开启失败，将继续实际问答测试", "warn");
    }

    addLog("问题", ACCOUNT_TEST_PROMPT);
    addLog("请求", `使用模型 ${ACCOUNT_TEST_MODEL} 直连该账号，超时 ${ACCOUNT_TEST_TIMEOUT_MS / 1000} 秒`);
    leaseId = pool.trackRequestStart(account.id);
    tracked = true;

    const result = await provider.chatCompletion(account, {
      model: ACCOUNT_TEST_MODEL,
      messages: [{ role: "user", content: ACCOUNT_TEST_PROMPT }],
      temperature: 0,
      max_tokens: 32,
      signal: AbortSignal.timeout(ACCOUNT_TEST_TIMEOUT_MS),
    });

    pool.trackRequestEnd(account.id, leaseId);
    tracked = false;

    if (!result.success) {
      const error = result.error || "Postman Agent 请求失败";
      addLog("上游", error, "error");
      if (result.quotaExhausted) {
        await pool.markExhausted(account.id);
      } else if (result.rateLimited) {
        await pool.markTransientFailure(account.id, error);
        pool.markCooling(account.id, result.retryAfterMs || 30_000, error);
      } else if (result.retryable) {
        await pool.markTransientFailure(account.id, error);
        pool.markCooling(account.id, 15_000, error);
      } else {
        await pool.markError(account.id, error);
      }
      return finish(false, { error });
    }

    const content = result.response?.choices[0]?.message.content;
    const response = typeof content === "string" ? content.trim() : "";
    if (!response) {
      const error = "Postman Agent 返回了空响应";
      addLog("回复", error, "error");
      await pool.markError(account.id, error);
      return finish(false, { error });
    }

    const matchedExpectedResponse = response.includes(EXPECTED_RESPONSE);
    addLog("回复", response, matchedExpectedResponse ? "success" : "warn");
    addLog(
      "校验",
      matchedExpectedResponse ? "收到预期标记，账号实际问答可用" : "收到有效回复，但没有严格匹配预期标记",
      matchedExpectedResponse ? "success" : "warn",
    );

    const now = new Date();
    await db.update(accounts)
      .set({ status: "active", errorMessage: null, lastUsedAt: now, updatedAt: now })
      .where(eq(accounts.id, account.id));
    pool.markAvailable(account.id);
    broadcast({ type: "account_status", data: { id: account.id, status: "active" } });
    addLog("结束", `测试完成，耗时 ${Date.now() - startedAt} ms`, "success");
    return finish(true, { response, matchedExpectedResponse });
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    addLog("异常", error, "error");
    return finish(false, { error });
  } finally {
    if (tracked) pool.trackRequestEnd(accountId, leaseId);
  }
}

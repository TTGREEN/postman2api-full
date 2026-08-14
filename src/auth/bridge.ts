import { db } from "../db/index";
import { accounts } from "../db/schema";
import { encrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { eq } from "drizzle-orm";
import {
  type LoginLogEntry,
  type PostmanAuthFlow,
  type PostmanLoginOptions,
  type PostmanLoginResult,
  type SignupAutomation,
} from "./postman-login";
import { loginPostmanForRuntime } from "./postman-login-runtime";
import { pool } from "../proxy/pool";
import { warmupAccount } from "./warmup";
import { testAccountAvailability } from "./account-test";

export type { LoginLogEntry, PostmanLoginResult } from "./postman-login";

export interface LoginDependencies {
  login: (email: string | undefined, options: PostmanLoginOptions) => Promise<PostmanLoginResult>;
  warmup?: (accountId: number) => Promise<{ success: boolean; error?: string }>;
  test?: (accountId: number) => Promise<{ available: boolean; error?: string }>;
}

export async function loginPostmanAccount(
  requestedEmail: string | undefined,
  onLog?: (log: LoginLogEntry) => void,
  dependencies: LoginDependencies = {
    login: loginPostmanForRuntime,
    warmup: warmupAccount,
    test: testAccountAvailability,
  },
  flow: PostmanAuthFlow = "login",
  confirmationId?: string,
  signupAutomation?: SignupAutomation,
): Promise<{ success: boolean; accountId?: number; error?: string }> {
  let email = requestedEmail?.trim() || `${flow}-pending@postman.local`;
  const emit = (step: string, msg: string, level = "info") => {
    const entry = { step, msg, level, ts: Date.now() / 1000 };
    onLog?.(entry);
    broadcast({ type: "login_log", data: { email, ...entry } });
  };

  try {
    const result = await dependencies.login(requestedEmail, {
      flow,
      confirmationId,
      signupAutomation,
      onLog: (logEntry) => {
        onLog?.(logEntry);
        broadcast({ type: "login_log", data: { email, ...logEntry } });
      },
    });

    if (result.error) {
      broadcast({ type: "login_done", data: { email, success: false, error: result.error } });
      return { success: false, error: result.error };
    }
    if (!result.postman_sid || !result.workspace_subdomain) {
      const error = "Incomplete tokens from browser login";
      broadcast({ type: "login_done", data: { email, success: false, error } });
      return { success: false, error };
    }

    email = requestedEmail?.trim().toLowerCase() || result.email?.trim().toLowerCase() || `user-${result.user_id}@postman.local`;

    emit("保存账号", "凭据已提取，正在保存账号...");
    const tokensJson = JSON.stringify({
      postman_sid: result.postman_sid,
      user_id: result.user_id,
      workspace_id: result.workspace_id,
      workspace_subdomain: result.workspace_subdomain,
    });
    const encryptedPassword = encrypt("manual-browser-login");
    const existing = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
    let accountId: number;

    if (existing.length > 0) {
      const [updated] = await db.update(accounts).set({
        password: encryptedPassword,
        tokens: tokensJson,
        status: "active",
        lastLoginAt: new Date(),
        updatedAt: new Date(),
        errorMessage: null,
      }).where(eq(accounts.id, existing[0]!.id)).returning({ id: accounts.id });
      accountId = updated!.id;
      pool.invalidate(accountId);
    } else {
      const [created] = await db.insert(accounts).values({
        email,
        password: encryptedPassword,
        tokens: tokensJson,
        status: "active",
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning({ id: accounts.id });
      accountId = created!.id;
    }

    broadcast({ type: "account_added", data: { id: accountId, email, status: "active" } });
    emit("自动导入", `账号已自动导入账号池（ID ${accountId}）。`, "info");

    if (dependencies.warmup) {
      emit("额度检查", "正在读取团队 AI 额度并确认账号状态...");
      const warmup = await dependencies.warmup(accountId);
      const [checked] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (!warmup.success) {
        emit("额度检查", warmup.error || "额度获取失败，请检查套餐与 Team AI 设置。", "warn");
      } else if (checked?.status === "exhausted") {
        emit("额度检查", "账号已保存，但团队 AI 额度已耗尽。", "warn");
      } else if (checked?.quotaLimit && checked.quotaRemaining != null) {
        emit("额度检查", `账号正常，剩余 ${checked.quotaRemaining} / ${checked.quotaLimit} credits。`, "info");
      } else {
        emit("额度检查", "账号已保存；额度暂未返回，可稍后在账号列表刷新。", "warn");
      }
    }

    if (flow === "signup" && dependencies.test) {
      const [checked] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      if (checked?.status === "active") {
        emit("可用性验证", "正在发送最小测试问题，确认 Agent Mode 可返回内容...");
        const test = await dependencies.test(accountId);
        if (test.available) {
          emit("可用性验证", "Agent Mode 已返回有效响应，账号接入完成。", "info");
        } else {
          emit("可用性验证", test.error || "Agent Mode 暂不可用，请检查 Team AI 设置。", "warn");
        }
      }
    }

    broadcast({ type: "login_done", data: { email, success: true } });
    console.log(`[auth:bridge] Account ${email} connected successfully (id=${accountId}, flow=${flow})`);
    return { success: true, accountId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[auth:bridge] Error:", msg);
    broadcast({ type: "login_done", data: { email, success: false, error: msg } });
    return { success: false, error: msg };
  }
}

export async function validatePostmanSession(accountId: number): Promise<boolean> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account?.tokens) return false;
  try {
    const tokens = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
    return !!(tokens?.postman_sid && tokens?.workspace_subdomain);
  } catch {
    return false;
  }
}

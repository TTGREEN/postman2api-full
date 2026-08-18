import type { Browser, BrowserContext } from "playwright";
import { fileURLToPath } from "node:url";
import { CONFIG, createRunPassword } from "../../packages/postman-register/src/config";
import { createPlanTrack, STAGES, type Stage, type StepContext } from "../../packages/postman-register/src/types";
import { launchBrowser, TabManager } from "../../packages/postman-register/src/core/browser";
import { log } from "../../packages/postman-register/src/core/logger";
import { runTempEmail } from "../../packages/postman-register/src/steps/tempEmail";
import { runSignup } from "../../packages/postman-register/src/steps/signup";
import { runVerify } from "../../packages/postman-register/src/steps/verify";
import { runProfile } from "../../packages/postman-register/src/steps/profile";
import { runUpgrade } from "../../packages/postman-register/src/steps/upgrade";
import { runTeam } from "../../packages/postman-register/src/steps/team";
import { runEnableAi } from "../../packages/postman-register/src/steps/enableAi";
import type { AccountToken } from "../../packages/postman-register/src/core/accountToken";

const RUNNERS: Record<Stage, (ctx: StepContext) => Promise<void>> = {
  tempEmail: runTempEmail,
  signup: runSignup,
  verify: runVerify,
  profile: runProfile,
  upgrade: runUpgrade,
  team: runTeam,
  enableAi: runEnableAi,
};

export interface UpstreamRegistrationOptions {
  signal?: AbortSignal;
  onStage?: (stage: Stage) => void;
  onLog?: (entry: { step: string; msg: string; level: "info" | "success" | "warn" | "error" }) => void;
  onToken?: (token: AccountToken) => Promise<void> | void;
  password?: string;
  retryLimit?: number;
}

export interface UpstreamRegistrationResult {
  email: string;
  username: string;
  token: AccountToken;
  retriesUsed: number;
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("注册任务已停止");
    error.name = "AbortError";
    throw error;
  }
}

export class UpstreamRegistrationStageError extends Error {
  constructor(readonly stage: Stage, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`上游 ${stage} 阶段失败：${message}`);
    this.name = "UpstreamRegistrationStageError";
  }
}

export function shouldRetryUpstreamStage(
  stage: Stage,
  error: unknown,
  retriesUsed: number,
  retryLimit: number,
): boolean {
  return stage !== "tempEmail" && !isAbortError(error) && retriesUsed < retryLimit;
}

/**
 * A fresh temporary mailbox is a batch-wide prerequisite. Continuing after a
 * provider quota, rate-limit, or block only creates more rejected mailbox
 * attempts, so the worker must finish the whole batch at this boundary.
 */
export function shouldStopRegistrationBatch(error: unknown): boolean {
  if (error instanceof UpstreamRegistrationStageError) return error.stage === "tempEmail";
  const message = error instanceof Error ? error.message : String(error);
  return /^上游\s+tempEmail\s+阶段失败[：:]/i.test(message);
}

async function restartRegistrationTarget(ctx: StepContext): Promise<void> {
  const page = ctx.plan.postmanTab;
  if (!page || page.isClosed()) {
    ctx.plan.postmanTab = await ctx.tabs.openDedicatedTab("Postman 注册 B（重试）", CONFIG.urls.postmanSignup);
    return;
  }
  await ctx.tabs.bringToFront(page);
  await page.reload({ waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
}

/**
 * Executes the upstream seven-stage browser flow inside the current product.
 * The caller owns persistence and receives the token through onToken; this runner
 * deliberately avoids the upstream token-file side effect.
 */
export async function runUpstreamRegistration(
  options: UpstreamRegistrationOptions = {},
): Promise<UpstreamRegistrationResult> {
  const previousSink = log.sink;
  log.sink = options.onLog;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    throwIfStopped(options.signal);
    browser = await launchBrowser();
    throwIfStopped(options.signal);
    context = await browser.newContext();
    const plan = createPlanTrack(options.password ?? createRunPassword());
    const tabs = new TabManager(context);
    const stepContext: StepContext = { plan, tabs, onToken: options.onToken };
    const retryLimit = Math.max(0, options.retryLimit ?? 0);
    let retriesUsed = 0;

    for (const stage of STAGES) {
      let stageComplete = false;
      while (!stageComplete) {
        throwIfStopped(options.signal);
        plan.stage = stage;
        options.onStage?.(stage);
        try {
          await RUNNERS[stage](stepContext);
          stageComplete = true;
        } catch (error) {
          if (isAbortError(error) || options.signal?.aborted) throw error;
          const stageError = new UpstreamRegistrationStageError(stage, error);
          if (!shouldRetryUpstreamStage(stage, error, retriesUsed, retryLimit)) {
            const message = stage === "tempEmail"
              ? `临时邮箱阶段失败，已停止重试以避免创建新邮箱：${stageError.message}`
              : `上游 ${stage} 阶段失败，重试次数已用尽：${stageError.message}`;
            options.onLog?.({ step: stage, msg: message, level: "error" });
            throw stageError;
          }

          retriesUsed += 1;
          options.onLog?.({
            step: stage,
            level: "warn",
            msg: `${stage} 阶段失败，保留当前临时邮箱，仅重启 Postman 目标页后重试（${retriesUsed}/${retryLimit}）：${stageError.message}`,
          });
          await restartRegistrationTarget(stepContext);
        }
      }
    }

    throwIfStopped(options.signal);
    if (!plan.accountToken || !plan.email || !plan.emailPrefix) {
      throw new Error("上游流程完成但未生成完整账号 Token");
    }
    return { email: plan.email, username: plan.emailPrefix, token: plan.accountToken, retriesUsed };
  } finally {
    log.sink = previousSink;
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function upstreamAutomationEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.ENABLE_EXTERNAL_AUTOMATION ?? "1");
}

/** Runtime-only source identity for Worker crash diagnostics. */
export function upstreamRegistrationRuntimeSource(): string {
  return fileURLToPath(import.meta.url);
}

export function upstreamConfigSummary(): { headless: boolean; tempMailUrl: string; signupUrl: string } {
  return { headless: CONFIG.headless, tempMailUrl: CONFIG.urls.tempMail, signupUrl: CONFIG.urls.postmanSignup };
}

import { sleep } from "bun";
import type { Browser, BrowserContext } from "playwright";
import { CONFIG, createRunPassword } from "./config";
import { createPlanTrack, STAGES, type Stage, type StepContext } from "./types";
import { launchBrowser, TabManager } from "./core/browser";
import { log } from "./core/logger";
import { runTempEmail } from "./steps/tempEmail";
import { runSignup } from "./steps/signup";
import { runVerify } from "./steps/verify";
import { runProfile } from "./steps/profile";
import { runUpgrade } from "./steps/upgrade";
import { runTeam } from "./steps/team";
import { runEnableAi } from "./steps/enableAi";

/** 阶段执行顺序：与需求中的七个阶段一一对应 */
const STAGE_ORDER: Stage[] = [...STAGES];

const RUNNERS: Record<Stage, (ctx: StepContext) => Promise<void>> = {
  tempEmail: runTempEmail,
  signup: runSignup,
  verify: runVerify,
  profile: runProfile,
  upgrade: runUpgrade,
  team: runTeam,
  enableAi: runEnableAi,
};

/** 当前正在运行的浏览器实例：供 Ctrl+C 无论在哪一轮都能关闭并退出 */
let currentBrowser: Browser | null = null;

async function closeCurrentBrowser(): Promise<void> {
  const browser = currentBrowser;
  currentBrowser = null;
  if (!browser) return;
  await browser.close().catch(() => {});
  // Playwright/Camoufox 的 Browser.close() 返回时，底层 Firefox stdio 子进程偶尔仍在
  // 做最后的清理。这里等待进程退出，避免下一轮 launch() 立刻遇到 “Failed to connect”。
  await sleep(1500);
}

/** 批量模式相邻两轮之间的停顿：让上一轮的浏览器进程与连接充分释放，降低下一轮启动失败概率 */
const ROUND_GAP_MS = 4000;

/**
 * 启动 Camoufox 并做有限次重试（带退避）。
 * 批量轮次间频繁启停浏览器时，偶发的启动失败（端口/资源未及时释放）不应中断整批任务。
 */
function isBrowserTransportError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  return /failed to connect|browser (?:has )?closed|target page, context or browser has been closed|econn(reset|refused)|epipe/i.test(message);
}

async function launchBrowserWithRetry(attempts = 5): Promise<Browser> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await launchBrowser();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        // 传输层启动失败通常是上一轮 Firefox 还未完全退出；退避比立即重试可靠。
        const backoff = isBrowserTransportError(err) ? 2000 * i : 3000 * i;
        log.warn(
          `浏览器启动失败（第 ${i}/${attempts} 次）：${err instanceof Error ? err.message : String(err)}；${backoff}ms 后重试`,
        );
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

/**
 * 批量模式复用同一个 Browser，只为每一轮创建隔离的 BrowserContext。
 * 反复 spawn/close Camoufox 是第二轮 “Failed to connect” 的主要触发场景；
 * context 仍然是全新的，因此 Cookie、LocalStorage 和登录状态不会跨账号复用。
 */
async function acquireRoundBrowser(): Promise<Browser> {
  if (currentBrowser?.isConnected()) return currentBrowser;
  await closeCurrentBrowser();
  const browser = await launchBrowserWithRetry();
  currentBrowser = browser;
  return browser;
}

/**
 * 报错后保持进程存活、浏览器不关闭，方便人工分析失败现场。
 * 定时器句柄 + 永不 resolve 的 Promise 共同保证进程不会因事件循环空转而退出。
 */
async function keepBrowserOpen(_browser: Browser): Promise<void> {
  const keepAlive = setInterval(() => {}, 60_000);
  log.warn("浏览器保持打开以便排查，请检查各标签页状态；排查完成后按 Ctrl+C 退出。");
  await new Promise<void>(() => {});
  clearInterval(keepAlive);
  await _browser.close();
}

/**
 * 单独执行一轮完整注册：创建本轮独立 BrowserContext。
 * 批量模式复用 Browser 进程，单轮模式仍在成功后关闭 Browser。
 * 单轮模式（count=1）失败时保留原行为：浏览器保持打开供人工排查。
 */
async function runOnce(iteration: number): Promise<boolean> {
  const label = CONFIG.count > 1 ? `第 ${iteration}/${CONFIG.count} 轮` : "";
  if (label) log.info(`========== 开始 ${label} 账号注册 ==========`);

  const password = createRunPassword();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    // 批量模式复用浏览器进程，只隔离上下文；单轮模式仍按原逻辑启动独立浏览器。
    browser = CONFIG.count > 1 ? await acquireRoundBrowser() : await launchBrowserWithRetry();
    currentBrowser = browser;
    context = await browser.newContext();
    const tabs = new TabManager(context);
    const plan = createPlanTrack(password);

    for (const stage of STAGE_ORDER) {
      plan.stage = stage;
      try {
        await RUNNERS[stage]({ plan, tabs });
      } catch (err) {
        log.error(`流程中断于阶段「${stage}」: ${err instanceof Error ? err.message : String(err)}`);
        for (const [idx, p] of tabs.pages.entries()) {
          log.info(`  标签页 ${idx + 1}: ${p.url()}`);
        }
        // 单轮失败：不关闭浏览器，保持打开供人工排查（走到阶段循环说明浏览器已启动成功）
        if (CONFIG.count === 1) {
          await keepBrowserOpen(browser!);
          return false;
        }
        // 批量模式只关闭当前轮次的 BrowserContext，保留共享 Browser 给下一轮复用。
        // 若是底层连接已断开，则在 catch 中清理失效 Browser，下一轮会重新启动。
        if (isBrowserTransportError(err)) {
          await closeCurrentBrowser();
        }
        log.warn("本轮注册失败，已关闭本轮 BrowserContext，继续下一轮……");
        return false;
      }
    }

    log.ok(`${label ? label + " 注册成功！" : "全流程完成！"}邮箱: ${plan.email}，用户名: ${plan.emailPrefix}`);
    // 批量模式复用共享 Browser；finally 只关闭本轮 Context。
    // Browser 会在所有轮次结束后统一关闭，避免下一轮重新 spawn Camoufox。
    if (CONFIG.count > 1) {
      log.info(`[浏览器] ${label}完成，保留共享 Browser，下一轮复用`);
    } else {
      await closeCurrentBrowser();
    }
    return true;
  } catch (err) {
    log.error(`本轮执行出错（含浏览器启动失败）: ${err instanceof Error ? err.message : String(err)}`);
    if (isBrowserTransportError(err)) {
      // 标记失效实例，下一轮会重新启动；不要把已断开的 Browser 留在全局句柄里。
      await closeCurrentBrowser();
    }
    if (CONFIG.count === 1) {
      if (browser) await keepBrowserOpen(browser);
      else process.exitCode = 1;
      return false;
    }
    return false;
  } finally {
    // 每轮关闭上下文，清理该账号的 Cookie / Storage；批量模式保留 Browser 进程供下一轮复用。
    await context?.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  log.info(`浏览器模式：${CONFIG.headless ? "无界面" : "有界面"}，注册轮数：${CONFIG.count}`);

  // 未捕获的拒绝/异常不再直接杀死整批任务：记录日志后继续。
  // 批量模式复用 Browser 进程，但每轮使用全新的 BrowserContext 隔离账号。
  process.on("unhandledRejection", (reason: unknown) => {
    log.error(`[未处理拒绝] ${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason)}`);
  });
  process.on("uncaughtException", (err: Error) => {
    log.error(`[未捕获异常] ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`);
  });

  // Ctrl+C：先关闭当前浏览器再退出，避免残留浏览器进程
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log.info("收到中断信号，正在关闭浏览器并退出……");
    void closeCurrentBrowser().finally(() => process.exit(130));
  });

  let ok = 0;
  let failed = 0;
  for (let i = 1; i <= CONFIG.count; i++) {
    let success = false;
    try {
      success = await runOnce(i);
    } catch (err) {
      // runOnce 内部已兜底，这里再包一层，保证任何意外都不会中断批量循环
      log.error(`第 ${i} 轮抛出未预期异常: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (success) ok++;
    else failed++;
    if (i < CONFIG.count) {
      log.info(`本轮结束（成功 ${ok} / 失败 ${failed}），准备开始下一轮注册……`);
      // 轮间短暂停顿，让上一轮 Context 完成清理；Browser 进程保持连接供下一轮复用。
      await sleep(ROUND_GAP_MS);
    }
  }

  if (CONFIG.count > 1) {
    await closeCurrentBrowser();
    log.info(`批量注册结束：共 ${CONFIG.count} 轮，成功 ${ok}，失败 ${failed}`);
    if (failed > 0) process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error(`流程启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
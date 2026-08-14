import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { retry, sleep } from "../core/waiters";
import { snapshot } from "../core/snapshot";
import * as tm from "../selectors/tempMail";

/**
 * 第一阶段：获取全新的临时邮箱（标签页 A）
 * 1. 打开 temp-mail.org，等待邮箱地址显示在页面上
 * 2. 若收件箱已有 Postman 邮件 → 该邮箱已被使用，删除并重新生成
 * 3. 复制邮箱地址并写入 plan_track（供后续阶段使用）
 */
export async function runTempEmail(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("tempEmail", "打开临时邮箱页面");

  const tab = await tabs.openDedicatedTab("临时邮箱 A", CONFIG.urls.tempMail);
  plan.emailTab = tab;

  // 1. 有限次数获取地址：短等待失败后刷新并退避；遇到访问控制则立即报告，不尝试绕过。
  let initialEmail = "";
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONFIG.timeouts.emailAcquireAttempts; attempt++) {
    try {
      initialEmail = await tm.waitForEmailDisplayed(tab, CONFIG.timeouts.emailAcquireAttempt);
      break;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (/页面被阻断/.test(message) || attempt === CONFIG.timeouts.emailAcquireAttempts) break;
      const backoff = CONFIG.timeouts.emailAcquireBackoff * attempt;
      log.warn(`临时邮箱地址未就绪（第 ${attempt}/${CONFIG.timeouts.emailAcquireAttempts} 次）：${message}；${backoff}ms 后刷新重试`);
      await sleep(backoff);
      await tab.reload({ waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
    }
  }
  if (!initialEmail) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`临时邮箱地址获取失败（已尝试 ${CONFIG.timeouts.emailAcquireAttempts} 次）：${message}`);
  }
  log.info(`邮箱已显示在页面上: ${initialEmail}`);
  const items = await snapshot(tab);
  log.info(`take_snapshot 发现 ${items.length} 个可见交互元素`);

  // 2. 仅当收件箱残留上一轮的老验证码 / Postman 邮件时才删除并重新生成；
  //    收件箱干净时直接使用当前邮箱，避免无谓的删除点击。
  await tm.waitForInboxLoaded(tab);
  let email: string;
  if (await tm.hasResidualVerification(tab)) {
    log.warn("收件箱残留上一轮的邮件/验证码，删除并重新生成邮箱");
    try {
      email = await tm.regenerateEmail(tab, initialEmail);
      // 确认新邮箱收件箱干净
      await retry(
        async () => {
          await tm.waitForInboxLoaded(tab);
          if (await tm.hasResidualVerification(tab)) throw new Error("新邮箱收件箱仍有残留邮件");
        },
        { attempts: 4, delayMs: 3000 },
      );
      log.ok(`已重新生成全新邮箱（收件箱为空）: ${email}`);
    } catch (err) {
      // 删除失败时回退：改用当前邮箱，但必须确认收件箱没有残留上一轮的 Postman 邮件
      log.warn(`删除并重新生成失败（${err instanceof Error ? err.message : String(err)}），改用当前邮箱并检查残留`);
      await tm.waitForInboxLoaded(tab);
      if (await tm.hasResidualVerification(tab)) {
        throw new Error("当前邮箱收件箱残留上一轮的 Postman 邮件且删除失败，无法保证全新邮箱，请重试");
      }
      email = (await tm.readEmailAddress(tab)) ?? initialEmail;
      log.warn(`使用当前邮箱（收件箱无残留 Postman 邮件）: ${email}`);
    }
  } else {
    email = initialEmail;
    log.ok(`收件箱无残留验证码，直接使用当前邮箱: ${email}`);
  }

  // 3. 复制邮箱：尽力点击站内复制按钮，核心仍是把地址写入 plan_track
  await tm.copyEmailAddress(tab).catch(() => log.warn("未找到站内复制按钮，已直接从页面读取邮箱值"));
  log.info(`已复制邮箱: ${email}`);

  plan.email = email;
  plan.emailPrefix = email.split("@")[0];
  log.info(`邮箱前缀（将用作 Postman 用户名）: ${plan.emailPrefix}`);
}

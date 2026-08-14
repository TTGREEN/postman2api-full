import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { retry } from "../core/waiters";
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
  const initialEmail = await tm.acquireEmailAddress(tab);
  log.info(`邮箱已显示在页面上: ${initialEmail}`);
  const items = await snapshot(tab);
  log.info(`take_snapshot 发现 ${items.length} 个可见交互元素`);

  // 2. 无条件删除并重新生成一次，确保收件箱全新。
  //    temp-mail 会按 IP 沿用上次的地址，不重生的话上一轮的旧邮件会残留，导致验证码取错。
  let email: string;
  try {
    email = await tm.regenerateEmail(tab, initialEmail);
    // 确认新邮箱收件箱干净
    await retry(
      async () => {
        await tm.waitForInboxLoaded(tab);
        if (await tm.hasPostmanEmail(tab)) throw new Error("新邮箱收件箱仍有残留邮件");
      },
      { attempts: 4, delayMs: 3000 },
    );
    log.ok(`已重新生成全新邮箱（收件箱为空）: ${email}`);
  } catch (err) {
    // 删除失败时回退：改用当前邮箱，但必须确认收件箱没有残留上一轮的 Postman 邮件
    log.warn(`删除并重新生成失败（${err instanceof Error ? err.message : String(err)}），改用当前邮箱并检查残留`);
    await tm.waitForInboxLoaded(tab);
    if (await tm.hasPostmanEmail(tab)) {
      throw new Error("当前邮箱收件箱残留上一轮的 Postman 邮件且删除失败，无法保证全新邮箱，请重试");
    }
    email = (await tm.readEmailAddress(tab)) ?? initialEmail;
    log.warn(`使用当前邮箱（收件箱无残留 Postman 邮件）: ${email}`);
  }

  // 3. 复制邮箱：尽力点击站内复制按钮，核心仍是把地址写入 plan_track
  await tm.copyEmailAddress(tab).catch(() => log.warn("未找到站内复制按钮，已直接从页面读取邮箱值"));
  log.info(`已复制邮箱: ${email}`);

  plan.email = email;
  plan.emailPrefix = email.split("@")[0];
  log.info(`邮箱前缀（将用作 Postman 用户名）: ${plan.emailPrefix}`);
}

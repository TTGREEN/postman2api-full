import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { collectAccountToken, saveAccountToken } from "../core/accountToken";
import { log } from "../core/logger";
import { firstVisible, tryNavigate, waitForAnyVisibleText, waitForVisibleText } from "../core/waiters";
import * as ps from "../selectors/postman";

/**
 * 第七阶段：启用 Postman AI
 * 导航到 /settings/team/ai → 点击 Enable → 按钮变为 Disable → 出现访问管理选项。
 */
export async function runEnableAi(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("enableAi", "导航到 AI 设置页");
  const tab = plan.postmanTab;
  if (!tab) throw new Error("Postman 标签页不存在");
  await tabs.bringToFront(tab);

  const navigated = await tryNavigate(tab, `${CONFIG.urls.workspace}/settings/team/ai`);
  if (!navigated) {
    log.info("直接导航失败，改走侧边栏（API Network & Applications → AI）");
    const sidebar = await firstVisible(ps.aiSidebarItems(tab), CONFIG.timeouts.short);
    if (!sidebar) throw new Error("未找到 AI 侧边栏入口");
    await sidebar.click();
  }

  await waitForVisibleText(tab, /^Postman AI$/, CONFIG.timeouts.long);

  const enable = ps.enableButton(tab);
  await enable.waitFor({ state: "visible", timeout: CONFIG.timeouts.long });
  await enable.click({ timeout: CONFIG.timeouts.short });
  log.info("已点击 Enable，等待按钮变为 Disable……");

  await waitForVisibleText(tab, /^Disable$/, CONFIG.timeouts.medium);
  await waitForAnyVisibleText(tab, ["All users", "Selected users"], CONFIG.timeouts.medium);
  log.ok("Postman AI 已启用（All users / Selected users 访问控制可用）");

  // 8. 最后一步：收集账号 Token（postman_sid / user_id / workspace_id / workspace_subdomain）
  //    并保存为独立文件（固定目录，每次运行一个文件），格式见 docs/postman-account-token.md
  const token = await collectAccountToken(tab, plan.email ?? "", plan.password);
  plan.accountToken = token;
  if (ctx.onToken) {
    await ctx.onToken(token);
    log.ok("账号 Token 已交给宿主任务保存（未写入额外文件）");
  } else {
    const file = saveAccountToken(token);
    log.ok(`账号 Token 已保存到 ${file}（可直接用于 postman2api 管理台导入）`);
  }
}

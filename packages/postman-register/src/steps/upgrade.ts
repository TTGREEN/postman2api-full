import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { clickWhenReady, firstVisible, tryNavigate, waitForAnyVisibleText } from "../core/waiters";
import * as ps from "../selectors/postman";

/**
 * 第五阶段：升级至 Enterprise 试用版
 * Upgrade → 弹窗选 Enterprise $49 → Start Enterprise Trial → 校验成功文案 → 关闭弹窗。
 */
async function openUpgradeEntry(tab: NonNullable<StepContext["plan"]["postmanTab"]>): Promise<void> {
  if (await firstVisible(ps.enterpriseOption(tab), 1000)) {
    log.info("检测到升级方案内容已在当前页面，跳过 Upgrade 入口点击");
    return;
  }

  const clickCandidate = async (source: string): Promise<boolean> => {
    const entry = await firstVisible(ps.upgradeEntryCandidates(tab), CONFIG.timeouts.short);
    if (!entry) return false;
    try {
      await clickWhenReady(entry, { timeout: CONFIG.timeouts.short, label: "Upgrade 入口" });
      log.info(`已通过${source}点击 Upgrade 入口`);
      return true;
    } catch (error) {
      log.warn(`${source} 的 Upgrade 入口暂不可点击：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  if (await clickCandidate("工作区")) return;

  log.info("当前工作区未发现 Upgrade 入口，尝试进入计费/团队设置页查找");
  for (const url of ps.upgradeFallbackUrls(CONFIG.urls.workspace)) {
    if (!(await tryNavigate(tab, url))) continue;
    if (await firstVisible(ps.enterpriseOption(tab), 1000)) {
      log.info(`已进入升级/计费页面：${url}`);
      return;
    }
    if (await clickCandidate(`页面 ${url} `)) return;
  }

  const diagnostic = await ps.upgradeEntryDiagnostic(tab);
  throw new Error(`未找到 Upgrade 入口；当前 URL=${tab.url()}；可见操作摘要=${diagnostic}`);
}

export async function runUpgrade(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("upgrade", "找到 Upgrade 按钮并打开升级弹窗");
  const tab = plan.postmanTab;
  if (!tab) throw new Error("Postman 标签页不存在");
  await tabs.bringToFront(tab);

  await openUpgradeEntry(tab);
  await waitForAnyVisibleText(tab, ["Enterprise", "Solo", "Team"], CONFIG.timeouts.medium);
  log.info("升级弹窗已出现，等待方案内容加载……");

  const enterprise = await firstVisible(ps.enterpriseOption(tab), CONFIG.timeouts.medium);
  if (!enterprise) throw new Error("升级弹窗内容加载超时，未找到 Enterprise 方案");
  log.info("升级方案内容已加载，检测到 Enterprise 方案");
  await clickWhenReady(enterprise, { timeout: CONFIG.timeouts.medium, label: "Enterprise 方案" });
  log.info("已点击 Enterprise 方案（label），确认选中状态……");
  await ps.waitForEnterpriseSelected(tab);
  log.info("已选择 Enterprise $49 方案");

  const startTrial = await firstVisible([ps.startEnterpriseTrialButton(tab)], CONFIG.timeouts.medium);
  if (!startTrial) throw new Error("Enterprise 方案已选中，但 Start Enterprise Trial 按钮加载超时");
  await clickWhenReady(startTrial, { timeout: CONFIG.timeouts.medium, label: "Start Enterprise Trial 按钮" });
  log.info("已点击 Start Enterprise Trial，等待处理……");

  await waitForAnyVisibleText(tab, [ps.enterpriseTrialBadge, /Trial ending in/i], CONFIG.timeouts.long);
  log.ok("Enterprise 试用已激活");

  await ps.closeModal(tab).catch(() => log.warn("未找到弹窗关闭按钮，按 Esc 兜底"));
  await tab.keyboard.press("Escape").catch(() => {});
}

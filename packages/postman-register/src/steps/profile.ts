import type { Locator, Page } from "playwright";
import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { firstVisible, waitForAnyVisibleText, waitUntilEnabled } from "../core/waiters";
import * as ps from "../selectors/postman";

async function fillField(page: Page, candidates: Locator[], value: string, label: string): Promise<void> {
  const loc = await firstVisible(candidates, CONFIG.timeouts.short);
  if (!loc) throw new Error(`未找到输入框: ${label}`);
  await loc.fill(value);
  log.info(`已填写 ${label}: ${value}`);
}

function menuOptions(menu: Locator, text: string): Locator[] {
  return [
    menu.locator(`[role="option"]:has-text("${text}")`).first(),
    menu.locator(`[id*="react-select"][id*="-option-"]:has-text("${text}")`).first(),
    menu.locator(`[class*="dropdown__option" i]:has-text("${text}")`).first(),
    menu.getByText(text, { exact: false }).first(),
  ];
}

/** Returns only the menu opened by the painted Aether control. */
async function openedDropdownMenu(page: Page, trigger: Locator): Promise<Locator | null> {
  const menuId = await trigger.locator('[aria-controls]').first().getAttribute('aria-controls').catch(() => null);
  if (menuId) {
    const menu = page.locator(`[id="${menuId.replaceAll('"', '\\"')}"]`);
    if (await menu.isVisible().catch(() => false)) return menu;
  }
  const dropdown = trigger.locator("xpath=ancestor::*[@data-aether-id='aether-dropdown'][1]");
  const containedMenu = dropdown.locator('.aether-dropdown__menu:visible, [role="listbox"]:visible').first();
  if (await containedMenu.isVisible().catch(() => false)) return containedMenu;
  return null;
}

/** Records a small, actionable snapshot when a normal pointer click cannot complete. */
async function diagnoseDropdownInteraction(page: Page, target: Locator, label: string, error: unknown): Promise<void> {
  const targetInfo = await target.evaluate((el) => {
    const rect = (el as HTMLElement).getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role"),
      ariaExpanded: el.getAttribute("aria-expanded"), text: (el.textContent ?? "").trim().slice(0, 160),
      x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, visible: rect.width > 0 && rect.height > 0,
    };
  }).catch(() => null);
  const interception = targetInfo ? await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? {
      tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), ariaLabel: el.getAttribute("aria-label"),
      testId: el.getAttribute("data-testid"), text: (el.textContent ?? "").trim().slice(0, 160),
    } : null;
  }, targetInfo).catch(() => null) : null;
  const domState = await page.evaluate(() => ({
    active: document.activeElement ? { tag: document.activeElement.tagName.toLowerCase(), role: document.activeElement.getAttribute("role") } : null,
    visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length,
  })).catch(() => null);
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  log.warn(`下拉框 ${label} 点击未完成；URL=${page.url()}；target=${JSON.stringify(targetInfo)}；pointer=${JSON.stringify(interception)}；state=${JSON.stringify(domState)}；error=${message}`);
}

/** Retries one ordinary, non-forced pointer click; overlays are reported, never bypassed. */
async function clickDropdownTrigger(page: Page, trigger: Locator, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await trigger.click({ timeout: 2500 });
      return;
    } catch (error) {
      lastError = error;
      await diagnoseDropdownInteraction(page, trigger, `${label}（第 ${attempt}/2 次）`, error);
      if (attempt < 2) await page.waitForTimeout(300);
    }
  }
  throw new Error(`下拉框 ${label} 无法正常点击；请检查 pointer/state 诊断信息。${lastError instanceof Error ? ` 原因: ${lastError.message}` : ""}`);
}

/**
 * Confirms the selected value on the same scoped React Select. The combobox is an
 * input, so its own innerText is normally empty; inspect its value and immediate
 * rendered control ancestors after the menu closes instead.
 */
async function verifyDropdownSelection(trigger: Locator, expected: string, label: string): Promise<void> {
  const deadline = Date.now() + CONFIG.timeouts.short;
  while (Date.now() < deadline) {
    const selected = await trigger.evaluate((el, wanted) => {
      const control = el as HTMLElement;
      const expanded = control.getAttribute("aria-expanded")
        ?? control.querySelector('[aria-expanded]')?.getAttribute("aria-expanded");
      return expanded !== "true" && (control.textContent ?? "").includes(wanted);
    }, expected).catch(() => false);
    if (selected) {
      log.info(`已验证 ${label}: ${expected}`);
      return;
    }
    await trigger.page().waitForTimeout(150);
  }
  throw new Error(`下拉框 ${label} 点击后未显示预期选择: ${expected}`);
}

/** Finds one visible trigger without rejecting an offscreen match before normal scrolling. */
async function findVisibleDropdown(
  candidateGroups: Locator[],
): Promise<{ trigger: Locator | null; found: boolean }> {
  let found = false;
  for (const candidateGroup of candidateGroups) {
    const count = await candidateGroup.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidateGroup.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        found = true;
        return { trigger: candidate, found };
      }
    }
  }
  return { trigger: null, found };
}

/** Prefers the exact inline-label adjacency; fallbacks run only when it has no visible match. */
async function findVisibleOnboardingDropdown(
  page: Page,
  dropdowns: (page: Page) => Locator[],
  label: string,
): Promise<Locator> {
  const deadline = Date.now() + CONFIG.timeouts.short;
  while (Date.now() < deadline) {
    const primary = await findVisibleDropdown(dropdowns(page));
    if (primary.trigger) return primary.trigger;
    await page.waitForTimeout(150);
  }
  throw new Error(`未找到可见下拉框定位器: ${label}`);
}

/** Scrolls through any ancestor scroll panes, then checks basic click preconditions. */
async function scrollAndValidateDropdown(trigger: Locator, label: string): Promise<void> {
  try {
    await trigger.scrollIntoViewIfNeeded();
  } catch (error) {
    throw new Error(`下拉框 ${label} 无法正常滚动到可操作位置。${error instanceof Error ? ` 原因: ${error.message}` : ""}`);
  }
  if (!(await trigger.isVisible().catch(() => false))) {
    throw new Error(`下拉框 ${label} 滚动后不再可见`);
  }
  if (!(await trigger.isEnabled().catch(() => false))) {
    throw new Error(`下拉框 ${label} 滚动后不可用`);
  }
}

async function selectReactSelect(
  page: Page,
  dropdowns: (page: Page) => Locator[],
  optionTexts: string[],
  label: string,
): Promise<void> {
  const trigger = await findVisibleOnboardingDropdown(page, dropdowns, label);
  // Normal scrolling supports nested scroll panes; the ordinary click below performs final actionability checks.
  await scrollAndValidateDropdown(trigger, label);
  const triggerText = await trigger.innerText().catch(() => "");
  if (optionTexts.some((text) => triggerText.trim() === text || triggerText.includes(text))) {
    log.info(`已选择 ${label}: ${triggerText.trim() || optionTexts[0]}（已处于选中状态）`);
    return;
  }

  await clickDropdownTrigger(page, trigger, label);
  log.info(`已打开下拉框 ${label}`);
  const menuDeadline = Date.now() + CONFIG.timeouts.short;
  let menu: Locator | null = null;
  while (Date.now() < menuDeadline && !menu) {
    menu = await openedDropdownMenu(page, trigger);
    if (!menu) await page.waitForTimeout(150);
  }
  if (!menu) throw new Error(`下拉框 ${label} 点击后未找到已打开的菜单`);

  const option = await firstVisible(optionTexts.flatMap((text) => menuOptions(menu!, text)), CONFIG.timeouts.short);
  if (option) {
    const selectedText = (await option.innerText()).trim();
    await option.click();
    await verifyDropdownSelection(trigger, selectedText, label);
    log.info(`已选择 ${label}: ${selectedText}`);
    return;
  }

  const firstOpt = await firstVisible([menu.locator('[role="option"]').first(), menu.locator('[class*="dropdown__option" i]').first()], 2000);
  if (firstOpt) {
    const text = await firstOpt.innerText().catch(() => "(未知)");
    await firstOpt.click();
    await verifyDropdownSelection(trigger, text, label);
    log.info(`已选择 ${label}: 第一个选项「${text}」`);
    return;
  }
  throw new Error(`下拉框 ${label} 中未找到选项: ${optionTexts.join(" / ")}`);
}

async function clickButton(page: Page, candidates: Locator[], label: string): Promise<void> {
  const btn = await firstVisible(candidates, CONFIG.timeouts.short);
  if (!btn) throw new Error(`未找到按钮: ${label}`);
  await btn.click();
  log.info(`已点击 ${label}`);
}

export async function runProfile(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("profile", "完善个人资料");
  const tab = plan.postmanTab;
  if (!tab) throw new Error("Postman 标签页不存在");
  await tabs.bringToFront(tab);
  await fillField(tab, ps.nameInputs(tab), plan.email!, "姓名");
  await selectReactSelect(tab, ps.ilkDropdown, ["build APIs", "Build APIs", "Create APIs"], "I'd like to");
  await selectReactSelect(tab, ps.roleDropdown, ["backend developer", "Backend Developer"], "as a");
  await clickButton(tab, ps.teamSizeButton(tab, "1 member"), "团队规模 1 member");

  // 当前资料页的最后一步不是 AI 文本框，而是底部的
  // “Take me to my Workspace”（data-testid="onboarding-get-started-button"）。
  // 旧逻辑在这里等待 AI 区域，导致填写资料后没有继续点击最终按钮。
  const workspaceButton = await firstVisible(ps.takeMeToWorkspaceButton(tab), CONFIG.timeouts.medium);
  if (!workspaceButton) throw new Error("未找到按钮: Take me to my Workspace");
  await waitUntilEnabled(workspaceButton, CONFIG.timeouts.medium);
  await workspaceButton.click();
  log.info("已点击 Take me to my Workspace");

  await waitForAnyVisibleText(tab, ["Collections", "APIs", "Workspace"], CONFIG.timeouts.long);
  log.ok("已进入 Postman 工作区");
}

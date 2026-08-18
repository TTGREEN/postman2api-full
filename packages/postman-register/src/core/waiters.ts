import type { Locator, Page } from "playwright";
import { CONFIG } from "../config";

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 依次轮询候选定位器，返回第一个可见的；超时返回 null */
export async function firstVisible(candidates: Locator[], timeout = CONFIG.timeouts.short): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await sleep(400);
  }
  return null;
}

/** 等待页面出现指定文本 */
export async function waitForVisibleText(page: Page, text: string | RegExp, timeout = CONFIG.timeouts.long): Promise<void> {
  await page.getByText(text).first().waitFor({ state: "visible", timeout });
}

/** 等待多个文本中的任意一个出现，返回命中的文本 */
export async function waitForAnyVisibleText(
  page: Page,
  texts: (string | RegExp)[],
  timeout = CONFIG.timeouts.long,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const t of texts) {
      if (await page.getByText(t).first().isVisible().catch(() => false)) return String(t);
    }
    await sleep(500);
  }
  throw new Error(`等待文本超时: ${texts.join(" / ")}`);
}

/** 按可见文本点击（按钮 → 链接 → 普通文本），找不到则抛错 */
export async function clickByText(
  page: Page,
  text: string | RegExp,
  opts: { exact?: boolean; timeout?: number } = {},
): Promise<boolean> {
  const { exact = false, timeout = CONFIG.timeouts.medium } = opts;
  const candidates = [
    page.getByRole("button", { name: text, exact }).first(),
    page.getByRole("link", { name: text, exact }).first(),
    page.getByText(text, { exact }).first(),
  ];
  const loc = await firstVisible(candidates, timeout);
  if (!loc) throw new Error(`未找到可点击的文本: ${String(text)}`);
  await loc.click();
  return true;
}

/** 轮询直到定位器可用（如「Get started with AI」在文本区域有内容后才解除禁用） */
export async function waitUntilEnabled(locator: Locator, timeout = CONFIG.timeouts.medium): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await locator.isDisabled().catch(() => true))) return;
    await sleep(300);
  }
  throw new Error(`元素在 ${timeout}ms 内未变为可用`);
}

export interface ClickWhenReadyOptions {
  timeout?: number;
  label?: string;
  retryDelayMs?: number;
}

function isStableBox(
  previous: { x: number; y: number; width: number; height: number } | null,
  current: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (!previous || !current || current.width < 1 || current.height < 1) return false;
  return Math.abs(previous.x - current.x) <= 1
    && Math.abs(previous.y - current.y) <= 1
    && Math.abs(previous.width - current.width) <= 1
    && Math.abs(previous.height - current.height) <= 1;
}

/**
 * Click only after the element has stayed visible, enabled, and geometrically
 * stable for two polls. A short actionability timeout prevents one overlay or
 * animation from consuming Playwright's full default click timeout.
 */
export async function clickWhenReady(
  locator: Locator,
  options: ClickWhenReadyOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? CONFIG.timeouts.medium;
  const label = options.label ?? "元素";
  const retryDelayMs = options.retryDelayMs ?? 250;
  const deadline = Date.now() + timeout;
  let previousBox: { x: number; y: number; width: number; height: number } | null = null;
  let lastError = "";

  while (Date.now() < deadline) {
    if (!(await locator.isVisible().catch(() => false))) {
      previousBox = null;
      await sleep(retryDelayMs);
      continue;
    }
    if (await locator.isDisabled().catch(() => true)) {
      previousBox = null;
      await sleep(retryDelayMs);
      continue;
    }

    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (!isStableBox(previousBox, box)) {
      previousBox = box;
      await sleep(retryDelayMs);
      continue;
    }

    try {
      const remaining = Math.max(500, deadline - Date.now());
      await locator.click({ timeout: Math.min(2_500, remaining) });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`${label} 在 ${timeout}ms 内未达到可点击状态${lastError ? `：${lastError}` : ""}`);
}

/** 带退避重试：fn 抛错则重试，直到成功或达到次数上限 */
export async function retry<T>(fn: () => Promise<T>, opts: { attempts?: number; delayMs?: number } = {}): Promise<T> {
  const { attempts = 3, delayMs = 2000 } = opts;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(delayMs);
    }
  }
  throw lastErr;
}

/** 尝试直接导航到指定 URL；成功返回 true，失败（跳转/超时/被登录页拦截）返回 false */
export async function tryNavigate(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
    await sleep(1500);
    return page.url().includes(new URL(url).pathname);
  } catch {
    return false;
  }
}

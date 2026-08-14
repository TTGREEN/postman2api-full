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

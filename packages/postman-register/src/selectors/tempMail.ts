import { sleep } from "bun";
import type { Locator, Page } from "playwright";
import { CONFIG } from "../config";
import { firstVisible } from "../core/waiters";

/**
 * temp-mail.org 的 DOM 细节全部集中在这里。
 * 站点改版导致定位失败时，只需增删候选定位器，不需要动 steps/。
 */

const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

/** 邮箱地址字段：只保留与临时邮箱 UI 有关的候选，避免误读页面上的其他输入框。 */
export function emailFieldCandidates(page: Page): Locator[] {
  return [
    page.locator("#mail").first(),
    page.locator('[data-testid*="mail" i] input').first(),
    page.locator('[data-testid*="email" i] input').first(),
    page.locator('input[name="mail" i], input[name="email" i]').first(),
    page.locator('input[value*="@" i]').first(),
  ];
}

/**
 * 识别可见页面中无法通过重试解决的状态；仅报告，不尝试绕过验证或访问限制。
 */
export async function getBlockingState(page: Page): Promise<string | null> {
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/captcha|recaptcha|turnstile|verify you are human|checking your browser|安全验证|人机验证/i.test(text)) {
    return "检测到安全验证（CAPTCHA/浏览器验证）；请在浏览器中完成验证后重试";
  }
  if (/too many requests|rate limit|请求过于频繁|访问过于频繁/i.test(text)) {
    return "检测到速率限制；请稍后再试";
  }
  if (/access denied|forbidden|access blocked|denied|拒绝访问|无权访问/i.test(text)) {
    return "检测到访问被拒绝或受限";
  }
  if (/consent|cookie settings|accept cookies|同意.*cookie|隐私.*同意/i.test(text)) {
    return "检测到 Cookie/隐私同意提示；请完成所需同意后重试";
  }
  return null;
}

/** 删除/重新生成按钮 */
export function deleteButtonCandidates(page: Page): Locator[] {
  return [
    page.getByRole("button", { name: /^delete$/i }).first(),
    page.getByTitle(/delete/i).first(),
    page.locator('[aria-label*="delete" i]').first(),
    page.locator('[data-testid*="delete" i]').first(),
    page.locator(".icon-delete, .icon-trash, .trash").first(),
  ];
}

/** 收件箱列表容器的候选选择器（.inbox-dataList 是当前站点的实际容器类名） */
const INBOX_SELECTORS = "#inbox, .inbox, .inbox-list, .email-list, .inbox-dataList";

/** 收件箱是否已有 Postman 相关邮件（说明该邮箱已被使用过） */
export async function hasPostmanEmail(page: Page): Promise<boolean> {
  const scoped = await page.locator(INBOX_SELECTORS).first().innerText().catch(() => "");
  const text = scoped || (await page.locator("body").innerText().catch(() => ""));
  return /postman/i.test(text);
}

/**
 * 收件箱是否残留上一轮的老验证码 / Postman 邮件。
 * 只有残留时才需要删除邮箱重新生成；干净收件箱直接使用当前地址。
 */
export async function hasResidualVerification(page: Page): Promise<boolean> {
  const text = await readInboxListText(page);
  if (!text.trim()) return false;
  const normalized = text.replace(/[\s\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, " ");
  if (/postman/i.test(normalized)) return true;
  return /(?:code|código|验证码|确认码)[^0-9]{0,15}\d{3}/i.test(normalized);
}

/**
 * 等待收件箱区域加载完成（出现邮件列表或空收件箱提示）。
 * 若页面里根本没有收件箱区域，则视为已就绪，避免无谓等待。
 */
export async function waitForInboxLoaded(page: Page, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const inbox = page.locator(INBOX_SELECTORS).first();
    if (!(await inbox.isVisible().catch(() => false))) return;
    const text = await inbox.innerText().catch(() => "");
    if (text.trim().length > 0) return;
    await sleep(500);
  }
}

/**
 * 读取收件箱列表文本：验证码直接出现在邮件摘要里，无需进入邮件详情。
 * 优先 .inbox-dataList（当前站点实际容器），再回退到其他候选，最后整页文本。
 */
export async function readInboxListText(page: Page): Promise<string> {
  const selectors = [".inbox-dataList", "#inbox", ".inbox", ".inbox-list", ".email-list"];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      const text = await loc.innerText().catch(() => "");
      if (text && text.trim()) return text;
    }
  }
  return (await page.locator("body").innerText().catch(() => "")) ?? "";
}

/** 从邮箱字段读取值（input value 或文本内容） */
export async function fieldValue(field: Locator): Promise<string> {
  const value =
    (await field.inputValue().catch(() => null))
    ?? (await field.getAttribute("value"))
    ?? (await field.textContent());
  return (value ?? "").trim();
}

/** 读取当前邮箱地址：校验专用字段的值，并回退到可见正文中的有效地址。 */
export async function readEmailAddress(page: Page): Promise<string | null> {
  for (const field of emailFieldCandidates(page)) {
    if (!(await field.isVisible().catch(() => false))) continue;
    const value = await fieldValue(field);
    const match = value.match(EMAIL_PATTERN);
    if (match) return match[0];
  }
  const body = await page.locator("body").innerText().catch(() => "");
  return body.match(EMAIL_PATTERN)?.[0] ?? null;
}

/**
 * 等待可验证的邮箱地址出现。与后续读取使用同一提取逻辑，并在等待期间报告阻断页面状态。
 */
export async function waitForEmailDisplayed(page: Page, timeout = CONFIG.timeouts.long): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const blocked = await getBlockingState(page);
    if (blocked) throw new Error(`临时邮箱页面被阻断：${blocked}`);
    const email = await readEmailAddress(page);
    if (email) return email;
    await sleep(300);
  }
  const blocked = await getBlockingState(page);
  if (blocked) throw new Error(`临时邮箱页面被阻断：${blocked}`);
  throw new Error(`等待临时邮箱地址超时（${timeout}ms）：未找到有效的可见邮箱地址`);
}

/** 站内“复制邮箱”按钮 */
export function copyButtonCandidates(page: Page): Locator[] {
  return [
    page.locator('[aria-label*="copy" i]').first(),
    page.getByTitle(/copy/i).first(),
    page.locator('[data-testid*="copy" i]').first(),
    page.locator('button[class*="copy" i], .copy-btn, .copy-button').first(),
  ];
}

/** 尽力点击站内复制按钮（失败时由调用方回退为直接读取邮箱值） */
export async function copyEmailAddress(page: Page): Promise<void> {
  const btn = await firstVisible(copyButtonCandidates(page), 3000);
  if (!btn) throw new Error("未找到站内复制按钮");
  await btn.click();
}

/** 删除邮箱并等待新邮箱生成，返回新地址 */
export async function regenerateEmail(page: Page, previous: string | null): Promise<string> {
  const del = await firstVisible(deleteButtonCandidates(page), CONFIG.timeouts.short);
  if (!del) throw new Error("未找到删除按钮，无法重新生成邮箱");
  await del.click();
  await sleep(CONFIG.timeouts.deleteRegenerate);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const email = await readEmailAddress(page);
    if (email && email !== previous) return email;
    await sleep(1000);
  }
  throw new Error("删除后未能生成新邮箱");
}



import { sleep } from "../core/sleep";
import type { Frame, Locator, Page } from "playwright";
import { CONFIG } from "../config";
import { log } from "../core/logger";
import { TurnstileDiagnostics, type TurnstileDiagnosticOutcome, redactDiagnosticUrl } from "../core/turnstileDiagnostics";
import { waitForSignal, type WatchSignal } from "../core/monitor";
import { firstVisible } from "../core/waiters";

const BROWSER_QUERY_TIMEOUT_MS = 500;
const TURNSTILE_INTERACTION_SETTLE_MS = 800;
const CAPTCHA_ABSENCE_GRACE_MS = 1_200;

const CAPTCHA_MARKER_SELECTOR = [
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'input[name*="cf-turnstile" i]',
  'input[name*="cf-chl" i]',
  '.g-recaptcha',
  'iframe[src*="google.com/recaptcha"]',
  'input[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]',
  '[data-sitekey]',
  '[data-callback*="captcha" i]',
].join(", ");

const CAPTCHA_TOKEN_SELECTOR = [
  'input[name*="cf-turnstile" i]',
  'input[name*="cf-chl" i]',
  'input[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]',
].join(", ");

interface TurnstileBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TurnstileWidgetTarget {
  frame: Frame;
  loc: Locator | null;
  box: TurnstileBox | null;
  coordinateFallback: boolean;
}

interface PageFrameSnapshot {
  main: Frame | null;
  frames: Frame[];
  complete: boolean;
}

type TurnstileMarkerState = "present" | "absent" | "unknown";

/** Detached challenge frames must not hold the whole flow at Playwright's default timeout. */
async function boundedQuery<T>(operation: () => Promise<T>, fallback: T, timeoutMs = BROWSER_QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    void operation().then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

async function readPageBody(page: Page): Promise<string> {
  return boundedQuery(
    () => page.locator("body").innerText({ timeout: BROWSER_QUERY_TIMEOUT_MS }),
    "",
  );
}

async function readFrameBody(frame: Frame): Promise<string> {
  return boundedQuery(
    () => frame.locator("body").innerText({ timeout: BROWSER_QUERY_TIMEOUT_MS }),
    "",
  );
}

const frameSnapshotWarningAt = new WeakMap<Page, number>();

function warnFrameSnapshotUnavailable(page: Page, detail: string): void {
  const now = Date.now();
  const lastWarning = frameSnapshotWarningAt.get(page) ?? 0;
  if (now - lastWarning < 1_500) return;
  frameSnapshotWarningAt.set(page, now);
  log.warn(`Turnstile 页面帧暂不可用，保留主页面并在下一轮检测重试：${detail}`);
}

/**
 * Camoufox can briefly expose a Page whose child-frame tree is being rebuilt.
 * Keep the main frame usable in that interval instead of letting Page.frames()
 * terminate the whole registration worker.
 */
function pageFrameSnapshot(page: Page): PageFrameSnapshot {
  let main: Frame | null;
  try {
    main = page.mainFrame() ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnFrameSnapshotUnavailable(page, `主页面帧读取失败（${message}）`);
    return { main: null, frames: [], complete: false };
  }

  if (!main) {
    warnFrameSnapshotUnavailable(page, "主页面帧尚未建立");
    return { main: null, frames: [], complete: false };
  }

  try {
    const childFrames = page.frames();
    return { main, frames: [main, ...childFrames.filter((frame) => frame !== main)], complete: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnFrameSnapshotUnavailable(page, `子页面帧读取失败（${message}）`);
    return { main, frames: [main], complete: false };
  }
}

/**
 * Postman 各页面（注册/验证/引导/升级/设置）的 DOM 细节全部集中在这里。
 * 每个元素都提供多个候选定位器，以"文本 + 角色"为主，站点改版时优先改本文件。
 */

/* ---------- 注册表单 ---------- */

export const emailInputs = (page: Page): Locator[] => [
  page.getByLabel("Work Email").first(),
  page.locator('input[type="email"]').first(),
  page.locator('input[name="email"]').first(),
  page.locator("#email").first(),
];

export const usernameInputs = (page: Page): Locator[] => [
  page.getByLabel("Username").first(),
  page.locator("#username").first(),
  page.locator('input[name="username"]').first(),
];

export const passwordInputs = (page: Page): Locator[] => [
  page.getByLabel("Password").first(),
  page.locator('input[type="password"]').first(),
  page.locator('input[name="password"]').first(),
];

export const createAccountButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Create Free Account", exact: true }).first();

/** 只允许正常的注册提交控件；不使用 force-click。 */
export const registrationSubmitButtons = (page: Page): Locator[] => [
  createAccountButton(page),
  page.getByRole("button", { name: "Register", exact: true }).first(),
];

/* ---------- 邮箱验证 ---------- */

/**
 * 验证码输入框候选：Postman 验证页的 OTP 输入框结构不固定（单输入框 / 6 个格子 / 自定义组件），
 * 按优先级从“最像 OTP”到“普通文本框”排列，第一组命中的候选优先使用。
 */
const otpInputCandidates = (page: Page): Locator[] => [
  page.locator('input[autocomplete="one-time-code"]'),
  page.locator('input[inputmode="numeric"]'),
  page.locator('input[type="tel"]'),
  page.locator('input[maxlength="6"], input[maxLength="6"]'),
  page.locator('input[name*="code" i], input[name*="otp" i], input[name*="verif" i], input[name*="digit" i]'),
  page.locator('input[id*="code" i], input[id*="otp" i], input[id*="verif" i]'),
  page.locator('input[placeholder*="code" i], input[placeholder*="otp" i], input[placeholder*="digit" i], input[placeholder*="6" i]'),
  page.locator('input[aria-label*="code" i], input[aria-label*="otp" i], input[aria-label*="verif" i], input[aria-label*="digit" i]'),
  page.locator('input[data-testid*="code" i], input[data-testid*="otp" i], input[data-testid*="verif" i]'),
  page.locator('input[type="text"]'),
  page.locator('[contenteditable="true"]'),
];

/** 返回当前可见的验证码输入框（取第一组命中的候选，避免同一输入框被多组候选重复收集） */
async function visibleOtpInputs(page: Page): Promise<Locator[]> {
  for (const cand of otpInputCandidates(page)) {
    const count = await cand.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let i = 0; i < count; i++) {
      const one = cand.nth(i);
      if (await one.isVisible().catch(() => false)) visible.push(one);
    }
    if (visible.length > 0) return visible;
  }
  return [];
}

/** Turnstile 组件标记是否出现在页面上（跨所有 frame：容器 / iframe / token 输入框） */
async function getTurnstileMarkerState(page: Page, diagnostics?: TurnstileDiagnostics): Promise<TurnstileMarkerState> {
  const snapshot = pageFrameSnapshot(page);
  for (const frame of snapshot.frames) {
    const n = await frame
      .locator(
        CAPTCHA_MARKER_SELECTOR,
      )
      .count()
      .catch(() => 0);
    if (n > 0) {
      diagnostics?.observeMarker();
      return "present";
    }
  }
  return snapshot.complete ? "absent" : "unknown";
}

/**
 * 跨所有 frame 查找已渲染为可见的 Turnstile 组件（iframe 优先，其次容器）。
 * Postman 验证表单可能在子 iframe 中，组件也可能加载慢，因此必须跨 frame 且每轮重新确认。
 */
async function findTurnstileWidget(page: Page, diagnostics?: TurnstileDiagnostics): Promise<TurnstileWidgetTarget | null> {
  const { main, frames } = pageFrameSnapshot(page);
  for (const frame of frames) {
    const challengeFrame = frame !== main && /challenges\.cloudflare\.com|turnstile/i.test(frame.url());
    const candidates = [
      frame
        .locator('.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
        .first(),
      frame.locator(".cf-turnstile").first(),
      ...((challengeFrame || frame === main)
        ? [
            frame.locator(
              '.cf-turnstile [role="checkbox"], .cf-turnstile input[type="checkbox"], .cf-turnstile [aria-label*="human" i], [aria-label*="verify you are human" i], [title*="verify you are human" i]',
            ).first(),
            frame.getByText(/verify you are human|验证你是人类|验证您是人类/i).first(),
          ]
        : []),
    ];
    for (const loc of candidates) {
      if ((await loc.count().catch(() => 0)) > 0 && (await boundedQuery(() => loc.isVisible({ timeout: BROWSER_QUERY_TIMEOUT_MS }), false))) {
        const box = await loc.boundingBox().catch(() => null);
        diagnostics?.observeVisibleWidget(frame.url(), box);
        return { frame, loc, box, coordinateFallback: false };
      }
    }

    // Turnstile can expose only a cross-origin iframe with a usable compositor
    // box. Its inner checkbox/text is intentionally absent from the locator
    // tree, so a DOM-only search reports widget_not_visible even though a real
    // browser pointer can still reach the control.
    const iframe = frame
      .locator('.cf-turnstile iframe, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
      .first();
    if ((await iframe.count().catch(() => 0)) > 0) {
      const box = await boundedQuery(() => iframe.boundingBox(), null);
      if (box && box.width >= 10 && box.height >= 10) {
        diagnostics?.observeVisibleWidget(frame.url(), box);
        return { frame, loc: iframe, box, coordinateFallback: true };
      }
    }

    // The challenge child frame is the authoritative signal that Turnstile has
    // loaded. Its owner iframe can be present before the parent-side src/title
    // selector is stable, so derive the clickable compositor box from the frame.
    if (!challengeFrame) continue;
    const owner = await boundedQuery(() => frame.frameElement(), null);
    const box = owner ? await boundedQuery(() => owner.boundingBox(), null) : null;
    if (!box || box.width < 10 || box.height < 10) continue;
    diagnostics?.observeVisibleWidget(frame.url(), box);
    return { frame, loc: null, box, coordinateFallback: true };
  }
  return null;
}

/** Turnstile 勾选框点击节流：首次渲染后先等待帧树稳定，再避免高频重复点击。 */
const turnstileClickState = new WeakMap<Page, { clickedAt?: number; key: string; seenAt: number }>();

/**
 * 自动点击交互式 Turnstile 勾选框（首次可见后先稳定 800ms，之后 1.5 秒节流）。
 * invisible 模式没有可见组件时自动跳过；勾选框位于组件左侧，点击 iframe 左中部命中。
 */
export async function clickTurnstileCheckbox(page: Page, diagnostics?: TurnstileDiagnostics): Promise<void> {
  const now = Date.now();
  const widget = await findTurnstileWidget(page, diagnostics);
  if (!widget) {
    diagnostics?.observeWidgetMissing();
    return;
  }
  const box = widget.box ?? await widget.loc?.boundingBox().catch(() => null) ?? null;
  const widgetKey = `${redactDiagnosticUrl(widget.frame.url())}|${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : "no-box"}`;
  const previous = turnstileClickState.get(page);
  if (!previous || previous.key !== widgetKey) {
    turnstileClickState.set(page, { key: widgetKey, seenAt: now });
    return;
  }
  if (now - previous.seenAt < TURNSTILE_INTERACTION_SETTLE_MS) return;
  if (previous.clickedAt !== undefined && now - previous.clickedAt < 1500) {
    diagnostics?.observeClickThrottled();
    return;
  }
  previous.clickedAt = now;
  const position = box ? { x: Math.min(30, box.width / 4), y: box.height / 2 } : undefined;
  diagnostics?.observeClickAttempt(widget.coordinateFallback ? "page_mouse" : "locator");
  log.info(widget.coordinateFallback
    ? "检测到可交互的 Turnstile iframe，使用浏览器坐标点击"
    : "检测到交互式 Turnstile 勾选框，自动点击");
  try {
    if (widget.coordinateFallback && box && position) {
      await page.mouse.click(box.x + position.x, box.y + position.y);
    } else if (widget.loc) {
      await widget.loc.click(position ? { position, timeout: 2500 } : { timeout: 2500 });
    } else {
      throw new Error("Turnstile 组件缺少可点击的定位器或坐标");
    }
    diagnostics?.observeClickCompleted();
  } catch (err) {
    diagnostics?.observeClickFailed();
    log.warn(`Turnstile 勾选框点击未完成：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 收集「Cloudflare 已通过」的多个实时信号（绿色 Success! 可能一闪而过，多信号并行更可靠） */
function cloudflareSuccessSignals(page: Page, diagnostics?: TurnstileDiagnostics): WatchSignal[] {
  // 组件可能在子 frame 里，且通过后会折叠为不可见，因此全部跨 frame 检测
  const frames = (): Frame[] => pageFrameSnapshot(page).frames;
  return [
    {
      name: "Turnstile 组件状态 success/solved",
      check: async () => {
        for (const frame of frames()) {
          const n = await frame
            .locator('[data-status="success"], [data-status="solved"]')
            .count()
            .catch(() => 0);
          if (n > 0) return true;
        }
        return false;
      },
    },
    {
      name: "Turnstile token 已生成（隐藏输入框）",
      check: async () => {
        for (const frame of frames()) {
          const inputs = frame.locator(CAPTCHA_TOKEN_SELECTOR);
          const n = await inputs.count().catch(() => 0);
          for (let i = 0; i < n; i++) {
            const v = await boundedQuery(
              () => inputs.nth(i).inputValue({ timeout: BROWSER_QUERY_TIMEOUT_MS }),
              "",
            );
            if (v && v.length > 10) {
              diagnostics?.observeToken(v.length);
              return true;
            }
          }
        }
        return false;
      },
    },
    {
      name: "组件区域出现 Success 文案",
      check: async () => {
        for (const frame of frames()) {
          const area = frame.locator(".cf-turnstile, [class*='turnstile' i], [id*='turnstile' i]").first();
          if (!(await boundedQuery(() => area.isVisible({ timeout: BROWSER_QUERY_TIMEOUT_MS }), false))) continue;
          if (/success/i.test(await boundedQuery(() => area.innerText({ timeout: BROWSER_QUERY_TIMEOUT_MS }), ""))) return true;
        }
        return false;
      },
    },
    {
      name: "Turnstile iframe 内 Success 文案或勾选标记",
      check: async () => {
        const { main, frames: currentFrames } = pageFrameSnapshot(page);
        for (const frame of currentFrames) {
          if (frame === main) continue;
          if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
          const body = frame.locator("body");
          if (/success/i.test(await readFrameBody(frame))) return true;
          const marks = await body
            .locator('[class*="success" i], [data-status="success"], [aria-label*="success" i], .mark-success')
            .count()
            .catch(() => 0);
          if (marks > 0) return true;
        }
        return false;
      },
    },
  ];
}

/** CAPTCHA 失败会阻止注册继续；必须优先作为终止错误处理。 */
export function isCaptchaFailureText(text: string): boolean {
  return /Unable to verify the captcha\. Please try again\.|captcha[^\n]{0,120}(?:unable to verify|failed|error|try again)|(?:unable to verify|failed)[^\n]{0,120}captcha/i.test(text);
}

export async function throwIfCaptchaFailure(page: Page): Promise<void> {
  const text = await readPageBody(page);
  if (isCaptchaFailureText(text)) {
    throw new Error("CAPTCHA 验证失败：Unable to verify the captcha. Please try again.");
  }
}

/**
 * Turnstile 组件自身的失败/过期状态（跨 frame）：出现即失败，不要继续傻等。
 * 只匹配明确的失败信号（data-status=error/expired、iframe 内 failed/expired 文案），
 * 避免误判正常文案中的 error 字样。
 */
export async function throwIfTurnstileFailure(page: Page): Promise<void> {
  const { main, frames } = pageFrameSnapshot(page);
  for (const frame of frames) {
    const errs = await frame
      .locator('[data-status="error"], [data-status="expired"], [data-state="error"]')
      .count()
      .catch(() => 0);
    if (errs > 0) throw new Error("Cloudflare Turnstile 验证失败（组件进入 error/expired 状态）");
    if (frame === main) continue;
    if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
    const body = await readFrameBody(frame);
    if (/verification failed|challenge failed|expired/i.test(body)) {
      throw new Error(`Cloudflare Turnstile 验证失败：${body.trim().slice(0, 120)}`);
    }
  }
}

/** 邮箱验证码错误/过期文案：出现即失败，不要干等跳转超时 */
export function isOtpFailureText(text: string): boolean {
  return /(?:incorrect|invalid|expired|wrong)[^\n]{0,40}(?:code|verification)|(?:code|verification)[^\n]{0,40}(?:incorrect|invalid|expired|wrong)|验证码[^\n]{0,20}(?:错误|不正确|已过期|失效)/i.test(text);
}

export async function throwIfOtpFailure(page: Page): Promise<void> {
  const text = await readPageBody(page);
  if (isOtpFailureText(text)) {
    const fragment = text.match(/[^\n]{0,80}(?:incorrect|invalid|expired|wrong|错误|过期|失效)[^\n]{0,80}/i)?.[0];
    throw new Error(`邮箱验证码未通过：${fragment ?? "验证码错误或已过期"}`);
  }
}

function diagnosticsOutcomeFor(error: unknown): TurnstileDiagnosticOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (/CAPTCHA 验证失败/.test(message)) return "upstream_rejected";
  if (/Cloudflare Turnstile 验证失败/.test(message)) return "widget_failed";
  if (/邮箱验证码未通过/.test(message)) return "otp_rejected";
  return "error";
}

/**
 * 等待 Cloudflare（Turnstile）验证通过：高频轮询成功/失败信号（200ms），
 * 交互式勾选框会自动点击（节流 3s）；invisible 模式无可见组件时靠 token/状态信号判定。
 * 总超时默认 10 分钟（CONFIG.timeouts.cfWait，可用 POSTMAN_CF_TIMEOUT 覆盖）。
 * 若页面没有组件，调用方必须提供与当前页面相符的可操作状态验证，不能仅凭缺失判定成功。
 */
export async function waitForCloudflareSuccess(
  page: Page,
  timeout = CONFIG.timeouts.cfWait,
  validateCaptchaAbsent?: () => Promise<boolean>,
): Promise<void> {
  const diagnostics = new TurnstileDiagnostics({ flow: "initial_challenge", emit: log.warn });
  diagnostics.start(page);
  let outcome: TurnstileDiagnosticOutcome = "error";
  try {
    const deadline = Date.now() + timeout;
    const absenceGraceDeadline = Date.now() + CAPTCHA_ABSENCE_GRACE_MS;
    while (Date.now() < deadline) {
      await throwIfCaptchaFailure(page);
      await throwIfTurnstileFailure(page);
      const markerState = await getTurnstileMarkerState(page, diagnostics);
      if (markerState === "unknown") {
        await sleep(100);
        continue;
      }
      if (markerState === "absent") {
        if (Date.now() < absenceGraceDeadline) {
          await sleep(Math.min(150, absenceGraceDeadline - Date.now()));
          continue;
        }
        if (!validateCaptchaAbsent) throw new Error("未检测到 CAPTCHA 组件，且没有页面状态验证");
        if (await validateCaptchaAbsent()) {
          log.info("未检测到 CAPTCHA 组件，已通过当前页面状态验证");
          outcome = "page_state_validated";
          return;
        }
        await sleep(500);
        continue;
      }
      const passed = await waitForSignal(cloudflareSuccessSignals(page, diagnostics), {
        timeout: Math.min(CONFIG.timeouts.medium, deadline - Date.now()),
        interval: 200, // 高频检测：绿色 Success! / token 生成都是转瞬即逝的状态
        label: "等待 Cloudflare 验证通过",
        onMiss: async () => {
          await clickTurnstileCheckbox(page, diagnostics);
        },
      }).catch((error) => {
        if (error instanceof Error && /超时/.test(error.message)) return null;
        throw error;
      });
      await throwIfCaptchaFailure(page);
      await throwIfTurnstileFailure(page);
      if (passed) {
        diagnostics.observeSuccess(passed);
        outcome = "success";
        return;
      }
      log.warn("CAPTCHA 尚未通过；继续等待并记录组件可见性/点击诊断……");
    }
    outcome = "timeout";
    await diagnoseCloudflare(page);
    throw new Error(`等待 Cloudflare 验证通过超时（${timeout}ms）`);
  } catch (error) {
    if (outcome !== "timeout") outcome = diagnosticsOutcomeFor(error);
    throw error;
  } finally {
    diagnostics.finish(outcome);
  }
}

/**
 * 提交验证码后可能触发一次新的 Turnstile 挑战（提交前页面上没有组件）。
 * 给一个短暂的宽限窗口等组件出现：出现则自动点击并等待通过（组件消失即放行），
 * 没出现则直接返回。期间检测到验证码错误/CAPTCHA 失败会立即抛错。
 */
export async function waitForPostSubmitChallenge(page: Page, graceMs = 20000): Promise<void> {
  const diagnostics = new TurnstileDiagnostics({ flow: "post_submit_challenge", emit: log.warn });
  diagnostics.start(page);
  let outcome: TurnstileDiagnosticOutcome = "error";
  try {
    const graceDeadline = Date.now() + graceMs;
    let appeared = false;
    while (Date.now() < graceDeadline && !appeared) {
      await throwIfOtpFailure(page);
      const markerState = await getTurnstileMarkerState(page, diagnostics);
      appeared = markerState === "present";
      if (!appeared) await sleep(markerState === "unknown" ? 100 : 400);
    }
    if (!appeared) {
      outcome = "component_not_appeared";
      return;
    }

    log.info("提交后检测到新的 CAPTCHA 挑战，自动点击并等待通过……");
    const deadline = Date.now() + CONFIG.timeouts.cfWait;
    while (Date.now() < deadline) {
      await throwIfCaptchaFailure(page);
      await throwIfTurnstileFailure(page);
      await throwIfOtpFailure(page);
      // 组件消失 = 已放行（通过后组件会被移除）；失败文案已在上方抛错
      const markerState = await getTurnstileMarkerState(page, diagnostics);
      if (markerState === "unknown") {
        await sleep(100);
        continue;
      }
      if (markerState === "absent") {
        diagnostics.observeSuccess("组件已移除");
        outcome = "success";
        return;
      }
      const solved = await waitForSignal(cloudflareSuccessSignals(page, diagnostics), {
        timeout: Math.min(CONFIG.timeouts.medium, deadline - Date.now()),
        interval: 200,
        label: "等待提交后的 CAPTCHA 通过",
        onMiss: async () => {
          await clickTurnstileCheckbox(page, diagnostics);
        },
      }).catch((error) => {
        if (error instanceof Error && /超时/.test(error.message)) return null;
        throw error;
      });
      if (solved) {
        diagnostics.observeSuccess(solved);
        outcome = "success";
        return;
      }
    }
    outcome = "timeout";
    await diagnoseCloudflare(page);
    throw new Error(`提交后的 CAPTCHA 等待超时（${CONFIG.timeouts.cfWait}ms）`);
  } catch (error) {
    if (outcome !== "timeout") outcome = diagnosticsOutcomeFor(error);
    throw error;
  } finally {
    diagnostics.finish(outcome);
  }
}

/** 诊断：超时时输出页面上的 Turnstile 现场信息（跨所有 frame），便于排查为何没检测到 */
async function diagnoseCloudflare(page: Page): Promise<void> {
  log.warn("Cloudflare 检测超时，输出现场信息：");
  const statuses = await boundedQuery(
    () => page.locator("[data-status]").evaluateAll((els) => els.map((el) => el.getAttribute("data-status"))),
    [] as (string | null)[],
  );
  log.warn(`  data-status 属性值: ${JSON.stringify(statuses)}`);
  const { main, frames } = pageFrameSnapshot(page);
  for (const frame of frames) {
    const widgets = await frame
      .locator('.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
      .count()
      .catch(() => 0);
    const token = await boundedQuery(
      () => frame
        .locator(CAPTCHA_TOKEN_SELECTOR)
        .first()
        .inputValue({ timeout: BROWSER_QUERY_TIMEOUT_MS }),
      "",
    );
    if (widgets > 0 || token) {
      log.warn(
        `  frame(${frame === main ? "主" : "子"} ${redactDiagnosticUrl(frame.url())}): 组件 ${widgets} 个, token ${token ? `已生成（${token.length} 字符）` : "未生成"}`,
      );
    }
  }
}

/** 注册页无 CAPTCHA 时的状态验证：正常提交按钮必须可见且可用。 */
export async function registrationFormReady(page: Page): Promise<boolean> {
  await throwIfCaptchaFailure(page);
  for (const button of registrationSubmitButtons(page)) {
    if ((await button.isVisible().catch(() => false)) && !(await button.isDisabled().catch(() => true))) return true;
  }
  return false;
}

/** 验证页无 CAPTCHA 时的状态验证：必须存在可见 OTP 输入框。 */
export async function verificationPageReady(page: Page): Promise<boolean> {
  await throwIfCaptchaFailure(page);
  return (await visibleOtpInputs(page)).length > 0;
}

/** 注册提交被 Postman 拒绝的通用错误文案（包括单独的 “Something went wrong.”） */
export function isSignupFailureText(text: string): boolean {
  // 提交后页面可能只显示 “Something went wrong.”，也可能附带 refresh / try again 提示。
  // 这里不强依赖后半句，否则会把纯通用错误误判成“没有结果”并一直等到超时。
  return /something\s+went\s+wrong(?:[.!]?|[^\n]{0,120}(?:refresh|try again))/i.test(text);
}

/** 确定性失败（重试无意义）：邮箱/用户名被占用、邮箱域名被拒等，出现应立即报错 */
export function isSignupFatalText(text: string): boolean {
  return /already (?:in use|taken|registered)|email (?:domain )?(?:is )?not (?:allowed|supported)|disposable/i.test(text);
}

/** 验证页特征文案：用于区分「真正的 OTP 页」和「注册表单页上的普通文本框」 */
const OTP_PAGE_TEXT =
  /verification code|verify your (email|account)|enter (the|your|a) (code|verification)|check your (inbox|email)|we'?ve sent|we have sent|didn'?t receive|resend/i;

/**
 * 严格的 OTP 页判定：OTP 输入框可见 且 页面带验证文案。
 * 注册表单页的用户名输入框可能命中 OTP 候选里的 input[type="text"] 兜底，
 * 仅用输入框判定会把「提交失败、表单仍在」误判为「已进入验证页」。
 */
async function isOtpPageVisible(page: Page): Promise<boolean> {
  if (!(await verificationPageReady(page))) return false;
  const text = await readPageBody(page);
  return OTP_PAGE_TEXT.test(text);
}

/**
 * 等待提交注册表单后的结果：OTP 验证界面（成功）vs 通用错误文案（可重试）vs 确定性错误（抛错）。
 * 替代单纯的 waitForVerificationUi：提交被拒时页面不会出现 OTP 输入框，
 * 没有错误检测就会干等超时。
 */
export async function waitForSignupOutcome(
  page: Page,
  timeout = CONFIG.timeouts.medium,
): Promise<"otp" | "failed"> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await throwIfCaptchaFailure(page);
    if (await isOtpPageVisible(page)) return "otp";
    const text = await readPageBody(page);
    if (isSignupFatalText(text)) {
      const fragment = text.match(/[^\n]{0,100}(?:already|not allowed|not supported|disposable)[^\n]{0,100}/i)?.[0];
      throw new Error(`注册被 Postman 拒绝（确定性错误，重试无意义）：${fragment ?? "邮箱或用户名不可用"}`);
    }
    if (isSignupFailureText(text)) return "failed";
    await sleep(500);
  }
  await throwIfCaptchaFailure(page);
  throw new Error("提交后未检测到 OTP 验证界面");
}

/** 将验证码填入 OTP 输入框：单输入框填整串，多格子则逐位填入；contenteditable 用键入方式 */
export async function fillOtp(page: Page, code: string, timeout = CONFIG.timeouts.medium): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visible = await visibleOtpInputs(page);
    if (visible.length > 0) {
      const firstTag = await visible[0].evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
      if (firstTag === "input") {
        if (visible.length === 1) {
          await visible[0].fill(code);
        } else {
          for (let i = 0; i < code.length && i < visible.length; i++) {
            await visible[i].fill(code[i]);
          }
        }
      } else {
        // contenteditable：聚焦后用键盘键入
        await visible[0].click();
        await page.keyboard.type(code);
      }
      log.info(`已在验证码输入框中填入 ${code.length} 位验证码（${visible.length} 个输入框）`);
      return;
    }
    await sleep(500);
  }
  await diagnoseOtpInputs(page);
  throw new Error("未找到验证码输入框（详见上方现场信息）");
}

/** 诊断：超时时输出页面上的输入框清单，便于确认实际 DOM 结构 */
async function diagnoseOtpInputs(page: Page): Promise<void> {
  log.warn("未找到验证码输入框，输出现场信息：");
  log.warn(`  当前 URL: ${page.url()}`);
  const inventory = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
        .filter((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 20)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: (el as HTMLInputElement).type ?? "",
          name: (el as HTMLInputElement).name ?? "",
          id: el.id ?? "",
          placeholder: (el as HTMLInputElement).placeholder ?? "",
          ariaLabel: el.getAttribute("aria-label") ?? "",
          maxlength: (el as HTMLInputElement).maxLength ?? "",
          value: (el as HTMLInputElement).value ?? "",
        })),
    )
    .catch(() => []);
  log.warn(`  页面上的可见输入框: ${JSON.stringify(inventory)}`);
}

/* ---------- 新手引导 / 个人资料 ---------- */

/** 姓名输入框：实际 DOM 是 data-testid="onboarding-name-input"，label 为 “What is your name?” */
export const nameInputs = (page: Page): Locator[] => [
  page.locator('[data-testid="onboarding-name-input"]').first(),
  page.getByLabel(/what is your name/i).first(),
  page.locator('input[placeholder*="John" i]').first(),
  page.locator('input[name*="name" i]').first(),
];

/**
 * Finds the painted Aether control in the dropdown immediately following its
 * exact inline label. Do not target React Select's offscreen dummy input.
 */
function onboardingDropdown(page: Page, fieldName: string): Locator[] {
  const fieldLabel = page.getByText(fieldName, { exact: true });
  return [fieldLabel.locator(
    "xpath=following-sibling::*[1][@data-aether-id='aether-dropdown']//div[contains(concat(' ', normalize-space(@class), ' '), ' aether-dropdown__control ')]",
  )];
}

/** “I'd like to” Aether dropdown's painted control. */
export const ilkDropdown = (page: Page): Locator[] => onboardingDropdown(page, "I'd like to");

/** Role Aether dropdown's painted control. */
export const roleDropdown = (page: Page): Locator[] => onboardingDropdown(page, "as a");

/** 团队规模：实际是按钮组（radio 样式），直接点击对应按钮 */
export const teamSizeButton = (page: Page, option = "1 member"): Locator[] => [
  page.locator(`[data-testid*="team-size" i]:has-text("${option}")`).first(),
  page.getByRole("button", { name: option, exact: true }).first(),
];

export const aiTextarea = (page: Page): Locator => page.locator("textarea").first();

export const getStartedWithAiButton = (page: Page): Locator =>
  page.getByRole("button", { name: /Get started with AI/i }).first();

/** 当前个人资料页的最终提交按钮，实际 DOM 为 onboarding-get-started-button。 */
export const takeMeToWorkspaceButton = (page: Page): Locator[] => [
  page.locator('[data-testid="onboarding-get-started-button"]').first(),
  page.getByRole("button", { name: "Take me to my Workspace", exact: true }).first(),
  page.locator('button[aria-label="Take me to my Workspace"]').first(),
  page.getByText("Take me to my Workspace", { exact: true }).first(),
];

export const goForwardButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^Go forward$/i }).first();

export const examplePrompts = (page: Page): Locator[] =>
  ["Send Requests", "Write tests", "Create APIs", "Design APIs", "Fix errors"]
    .map((t) => page.getByText(t, { exact: true }).first());

/**
 * 等待新手引导页面出现。
 * 引导页文案随版本变化，因此用「文案 + 结构」双信号判断：
 * 出现姓名输入框 / 偏好下拉框 / AI 文本区 / 关键文案 任一即认为已进入引导页。
 * 若出现“账号创建成功”等中间页，会自动点击 Continue / Get Started 进入下一步。
 */
export async function waitForOnboarding(page: Page, timeout = CONFIG.timeouts.long): Promise<void> {
  let clicked = false;
  await waitForSignal(
    [
      {
        name: "出现关键文案",
        check: async () => {
          const texts = [
            "Get started with AI",
            "Go forward",
            "Add your name",
            "I'd like to",
            "What would you like to do",
            "build APIs",
            "Team size",
            "Role",
          ];
          for (const t of texts) {
            if (await page.getByText(t, { exact: false }).first().isVisible().catch(() => false)) return true;
          }
          return false;
        },
      },
      {
        name: "出现姓名输入框",
        check: async () => {
          for (const cand of nameInputs(page)) {
            if (await cand.isVisible().catch(() => false)) return true;
          }
          return false;
        },
      },
      {
        name: "出现偏好下拉框或团队规模按钮",
        check: async () => {
          for (const cand of [...ilkDropdown(page), ...roleDropdown(page), ...teamSizeButton(page)]) {
            if (await cand.isVisible().catch(() => false)) return true;
          }
          return false;
        },
      },
      {
        name: "出现 AI 文本区",
        check: async () => await aiTextarea(page).isVisible().catch(() => false),
      },
    ],
    {
      timeout,
      interval: 500,
      label: "等待新手引导页面出现",
      onMiss: async () => {
        // 每轮先检查失败信号：验证码错误 / CAPTCHA 失败要快速失败，而不是干等 10 分钟超时
        await throwIfOtpFailure(page);
        await throwIfCaptchaFailure(page);
        // 提交验证码后可能触发新的 Turnstile 挑战：自动点击勾选框（节流 3s）
        await clickTurnstileCheckbox(page);
        if (clicked) return;
        // 中间页（如“账号创建成功”）可能有 Continue / Get Started 按钮，点一下进入下一步
        for (const label of ["Continue", "Get Started", "Let's go", "Continue to Postman"]) {
          const btn = page.getByRole("button", { name: label, exact: false }).first();
          if (await btn.isVisible().catch(() => false)) {
            log.info(`检测到中间页按钮「${label}」，点击后继续等待引导页`);
            await btn.click().catch(() => {});
            clicked = true;
            return;
          }
        }
      },
    },
  );
}

/**
 * 等待 AI 引导区出现（AI 文本区或 Get started with AI 按钮）。
 * 若中间隔着 Continue / Next 步骤，自动点击一次进入 AI 引导页。
 */
export async function waitForAiSection(page: Page, timeout = CONFIG.timeouts.medium): Promise<void> {
  // 选择团队规模后，当前版本的引导页可能先出现“Go forward”，再切换到 AI 引导区。
  // 旧逻辑只等待 textarea / Get started with AI，因此会在这里静默等待到超时。
  // 把 Go forward 作为可推进的中间状态处理，而不是把它误当成最终的 AI 区域。
  let clickedIntermediate = false;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const signal = await waitForSignal(
      [
        { name: "AI 文本区出现", check: async () => await aiTextarea(page).isVisible().catch(() => false) },
        {
          name: "Get started with AI 出现",
          check: async () => await getStartedWithAiButton(page).isVisible().catch(() => false),
        },
        {
          name: "Go forward 出现",
          check: async () => {
            const button = goForwardButton(page);
            return await button.isVisible().catch(() => false)
              && await button.isEnabled().catch(() => false);
          },
        },
      ],
      {
        timeout: Math.max(1, deadline - Date.now()),
        label: "等待 AI 引导区",
        onMiss: async () => {
          if (clickedIntermediate) return;
          for (const label of ["Continue", "Next", "Let's go"]) {
            const btn = page.getByRole("button", { name: label, exact: false }).first();
            if (await btn.isVisible().catch(() => false)) {
              log.info(`点击「${label}」进入 AI 引导页`);
              await btn.click().catch(() => {});
              clickedIntermediate = true;
              return;
            }
          }
        },
      },
    );

    if (signal !== "Go forward 出现") return;

    const forward = goForwardButton(page);
    await forward.scrollIntoViewIfNeeded().catch(() => {});
    await forward.click();
    log.info("已点击 Go forward，继续进入 AI 引导页");
  }

  throw new Error(`等待 AI 引导区超时（${timeout}ms）`);
}

/* ---------- 升级 Enterprise 试用 ---------- */

export const upgradeButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^upgrade$/i }).first();

export const upgradeEntryCandidates = (page: Page): Locator[] => [
  upgradeButton(page),
  page.getByRole("link", { name: /^upgrade$/i }).first(),
  page.getByRole("button", { name: /upgrade/i }).first(),
  page.getByRole("link", { name: /upgrade/i }).first(),
  page.locator('button:has-text("Upgrade"), a:has-text("Upgrade"), [role="button"]:has-text("Upgrade")').first(),
  page.locator('[data-testid*="upgrade" i], [aria-label*="upgrade" i], [title*="upgrade" i]').first(),
  page.getByRole("button", { name: /view plans|manage plan|change plan/i }).first(),
  page.getByRole("link", { name: /view plans|manage plan|change plan/i }).first(),
];

export const upgradeFallbackUrls = (workspaceUrl: string): string[] => [
  `${workspaceUrl}/billing`,
  `${workspaceUrl}/settings/billing`,
  `${workspaceUrl}/settings/billing/plans`,
  `${workspaceUrl}/settings/team/billing`,
  `${workspaceUrl}/settings/team/ai`,
];

function redactPageSummaryText(value: string): string {
  return value
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "<email>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<opaque>");
}

export async function upgradeEntryDiagnostic(page: Page): Promise<string> {
  const actions = await page
    .evaluate(() => {
      const visible = (el: Element) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      return Array.from(document.querySelectorAll("button, a, [role='button'], [aria-label], [data-testid]"))
        .filter(visible)
        .slice(0, 30)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
          aria: el.getAttribute("aria-label"),
          testId: el.getAttribute("data-testid"),
          href: el instanceof HTMLAnchorElement ? el.href : null,
        }));
    })
    .catch((error) => `诊断失败: ${error instanceof Error ? error.message : String(error)}`);
  return redactPageSummaryText(JSON.stringify(actions)).slice(0, 2000);
}

export const enterpriseOption = (page: Page): Locator[] => [
  // 注意：radio input 上覆盖了一层 .Radio__StyledRadioDummy 装饰元素，直接点 input 会被拦截。
  // 必须点 label（for 关联 radio，浏览器会自动触发选中）或整张卡片。
  page.locator('label[for*="enterprise" i]').first(),
  page.getByText("Enterprise", { exact: false }).first(),
  page.locator('.upgrade-modal-plan-card:has-text("Enterprise")').first(),
  page.getByRole("radio", { name: /enterprise/i }).first(),
  page.locator('[data-testid*="enterprise" i]').first(),
];

/** 确认 Enterprise radio 已被选中（checked 属性或 aria-checked），未选中则再点一次 */
export async function waitForEnterpriseSelected(page: Page, timeout = CONFIG.timeouts.short): Promise<void> {
  const input = page.locator('input[type="radio"][id*="enterprise" i]').first();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await input
      .evaluate((el) => ({
        checked: (el as HTMLInputElement).checked,
        aria: el.getAttribute("aria-checked"),
      }))
      .catch(() => ({ checked: false, aria: null }));
    if (state.checked || state.aria === "true") return;
    await sleep(300);
  }
  log.warn("Enterprise 方案未确认选中，再次尝试点击");
  const again = await firstVisible(enterpriseOption(page), 2000);
  await again?.click().catch(() => {});
}

export const startEnterpriseTrialButton = (page: Page): Locator =>
  page.getByRole("button", { name: /Start .*Enterprise Trial/i }).first();

export const enterpriseTrialBadge = /Enterprise Trial ending in 30 days/i;

/** 关闭弹窗（优先语义化的 Close，找不到则由调用方用 Esc 兜底） */
export async function closeModal(page: Page): Promise<void> {
  const candidates: Locator[] = [
    page.getByRole("button", { name: /^close$/i }).first(),
    page.locator('[aria-label="Close"]').first(),
    page.locator('[data-testid*="close" i]').first(),
  ];
  const loc = await firstVisible(candidates, 3000);
  if (!loc) throw new Error("未找到关闭按钮");
  await loc.click();
}

/* ---------- 团队设置 ---------- */

export const settingsGear = (page: Page): Locator[] => [
  page.locator('button[aria-label*="settings" i]').first(),
  page.locator('a[aria-label*="settings" i]').first(),
  page.locator('[title*="settings" i]').first(),
  page.locator('[data-testid*="settings" i]').first(),
];

/* ---------- 启用 Postman AI ---------- */

export const enableButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^enable$/i }).first();

export const aiSidebarItems = (page: Page): Locator[] => [
  page.locator('a[href*="settings/team/ai"]').first(),
  page.getByText("AI", { exact: true }).first(),
  page.locator('a:has-text("API Network & Applications")').first(),
];

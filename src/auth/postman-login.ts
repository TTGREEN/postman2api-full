import type { Browser, BrowserContext, Page } from "playwright";
import { config } from "../config";
import { launchLoginBrowser } from "./browser-launcher";

export const POSTMAN_LOGIN_URL = "https://identity.getpostman.com/login";
export const POSTMAN_SIGNUP_URL = "https://identity.getpostman.com/signup";
export const POSTMAN_HOME_URL = "https://go.postman.co/home";
export const HANDSHAKE_TOKEN_URL = "https://ra.gw.postman.co/v1/handshake/token?agent=cloud";
export const MANUAL_LOGIN_TIMEOUT_MS = 300_000;
export const MANUAL_SIGNUP_TIMEOUT_MS = 15 * 60 * 1000;
const RESERVED_SUBDOMAINS = new Set(["go", "identity", "id", "www"]);

export type PostmanAuthFlow = "login" | "signup";
export type PostmanSetupStage =
  | "login"
  | "signup"
  | "email_verification"
  | "captcha"
  | "onboarding"
  | "billing"
  | "team_ai"
  | "workspace"
  | "unknown";

export interface PostmanLoginOptions {
  timeoutMs?: number;
  onLog?: LoginLogger;
  flow?: PostmanAuthFlow;
  confirmationId?: string;
  signupAutomation?: SignupAutomation;
}

export interface SignupAutomation {
  username?: string;
  password: string;
}

export interface PostmanLoginResult {
  email?: string;
  postman_sid: string;
  user_id: string;
  workspace_id: string;
  workspace_subdomain: string;
  error?: string;
}

export interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

export type LoginLogger = (entry: LoginLogEntry) => void;

interface SignupAutomationState {
  formSubmitted: boolean;
  formBlockedLogged: boolean;
  formActions: Set<string>;
  onboardingActions: Set<string>;
}

interface SignupConfirmation {
  confirmed: boolean;
  createdAt: number;
}

const signupConfirmations = new Map<string, SignupConfirmation>();
const SIGNUP_CONFIRMATION_TTL_MS = MANUAL_SIGNUP_TIMEOUT_MS + 60_000;

export function prepareSignupConfirmation(confirmationId: string): boolean {
  const normalized = confirmationId.trim();
  if (!normalized || normalized.length > 160) return false;
  cleanupSignupConfirmations();
  signupConfirmations.set(normalized, { confirmed: false, createdAt: Date.now() });
  return true;
}

export function confirmSignupCompletion(confirmationId: string): boolean {
  const confirmation = signupConfirmations.get(confirmationId.trim());
  if (!confirmation) return false;
  confirmation.confirmed = true;
  return true;
}

export function isSignupCompletionConfirmed(confirmationId?: string): boolean {
  if (!confirmationId) return false;
  return signupConfirmations.get(confirmationId.trim())?.confirmed === true;
}

export function clearSignupConfirmation(confirmationId?: string): void {
  if (confirmationId) signupConfirmations.delete(confirmationId.trim());
}

function cleanupSignupConfirmations(): void {
  const now = Date.now();
  for (const [id, confirmation] of signupConfirmations) {
    if (now - confirmation.createdAt > SIGNUP_CONFIRMATION_TTL_MS) signupConfirmations.delete(id);
  }
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const value = JSON.parse(decoded);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function workspaceSubdomainFromUrl(url: string): string | null {
  try {
    const match = new URL(url).hostname.toLowerCase().match(/^([a-z0-9-]+)\.postman\.co$/);
    if (!match || RESERVED_SUBDOMAINS.has(match[1]!)) return null;
    return match[1]!;
  } catch {
    return null;
  }
}

export function authStartUrl(flow: PostmanAuthFlow): string {
  return flow === "signup" ? POSTMAN_SIGNUP_URL : POSTMAN_LOGIN_URL;
}

export function deriveSignupUsername(email: string, preferred?: string): string {
  const source = preferred?.trim() || email.split("@")[0]?.trim() || "postman-user";
  const normalized = source.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 64);
  return normalized || "postman-user";
}

export function shouldCompletePostmanSetup(
  flow: PostmanAuthFlow,
  stage: PostmanSetupStage,
  manuallyConfirmed: boolean,
  hasSession: boolean,
  hasWorkspaceSubdomain: boolean,
): boolean {
  if (!hasSession || !hasWorkspaceSubdomain) return false;
  if (flow === "signup") return manuallyConfirmed;
  return stage === "workspace";
}

function safePageUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<unavailable>";
  }
}

export function classifyPostmanSetupStage(url: string, pageText = ""): PostmanSetupStage {
  const normalizedUrl = url.toLowerCase();
  const text = pageText.toLowerCase();

  if (text.includes("captcha") || text.includes("verify you are human")) return "captcha";
  if (
    normalizedUrl.includes("verify")
    || normalizedUrl.includes("confirmation")
    || text.includes("verification code")
    || text.includes("verify your email")
    || text.includes("check your inbox")
  ) return "email_verification";
  if (
    normalizedUrl.includes("/billing")
    || text.includes("billing overview")
    || text.includes("resource usage")
    || text.includes("team ai usage")
  ) return "billing";
  if (
    (normalizedUrl.includes("settings") && text.includes("ai"))
    || text.includes("team ai access")
    || text.includes("enable team ai")
  ) return "team_ai";
  if (
    normalizedUrl.includes("onboarding")
    || text.includes("set up your workspace")
    || text.includes("what's your role")
    || text.includes("tell us about yourself")
    || text.includes("personalize your experience")
  ) return "onboarding";
  if (normalizedUrl.includes("/signup") || text.includes("create your account")) return "signup";
  if (normalizedUrl.includes("/login") || text.includes("sign in to postman")) return "login";
  if (workspaceSubdomainFromUrl(url)) return "workspace";
  return "unknown";
}

export function extractIdentity(
  handshakeToken: string | undefined,
  userInfo?: Record<string, any>,
): { userId: string; teamId: string } {
  const payload = handshakeToken ? decodeJwtPayload(handshakeToken) : {};
  let userId = payload.userId == null ? "" : String(payload.userId);
  let teamId = payload.teamId == null ? "" : String(payload.teamId);
  if (!userId && userInfo?.id != null) userId = String(userInfo.id);
  const organizations = userInfo?.user_organizations?.organizations;
  if (!teamId && Array.isArray(organizations) && organizations[0]?.id != null) {
    teamId = String(organizations[0].id);
  }
  return { userId: userId || "unknown", teamId: teamId || "unknown" };
}

export function extractAccountEmail(userInfo: Record<string, any> | undefined, userId: string): string {
  const candidates = [
    userInfo?.email,
    userInfo?.primary_email,
    userInfo?.primaryEmail,
    userInfo?.user?.email,
    userInfo?.profile?.email,
  ];
  for (const candidate of candidates) {
    const email = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  }
  return `user-${userId || "unknown"}@postman.local`;
}

function createLogger(onLog?: LoginLogger): LoginLogger {
  return (entry) => {
    console.log(`[auth:login] [${entry.level}] ${entry.step}: ${entry.msg}`);
    onLog?.(entry);
  };
}

function emit(log: LoginLogger, step: string, msg: string, level = "info"): void {
  log({ step, msg, level, ts: Date.now() / 1000 });
}

export function describeAutomationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown browser automation error";
}

export function isTransientBrowserInteractionError(error: unknown): boolean {
  return /execution context was destroyed|because of a navigation|frame was detached|element is not attached to the dom|target page, context or browser has been closed|target closed/i
    .test(describeAutomationError(error));
}

interface BrowserDiagnostics {
  beginExpectedClose(): void;
  detach(): void;
}

function pageUrlForLog(page: Page): string {
  try {
    return safePageUrl(page.url());
  } catch {
    return "<unavailable>";
  }
}

function attachBrowserDiagnostics(browser: Browser, context: BrowserContext, log: LoginLogger): BrowserDiagnostics {
  let expectedClose = false;
  const observedPages = new Set<Page>();
  const pageListeners = new Map<Page, { crash: () => void; close: () => void; pageerror: (error: Error) => void }>();

  const observePage = (page: Page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    const listeners = {
      crash: () => emit(log, "浏览器诊断", `页面进程崩溃：${pageUrlForLog(page)}`, "error"),
      close: () => {
        if (!expectedClose) emit(log, "浏览器诊断", `页面已关闭：${pageUrlForLog(page)}`, "warn");
      },
      pageerror: (error: Error) => emit(log, "浏览器诊断", `页面脚本错误：${describeAutomationError(error)}`, "warn"),
    };
    page.on("crash", listeners.crash);
    page.on("close", listeners.close);
    page.on("pageerror", listeners.pageerror);
    pageListeners.set(page, listeners);
  };

  const onContextPage = (page: Page) => observePage(page);
  const onContextClose = () => {
    if (!expectedClose) emit(log, "浏览器诊断", "浏览器上下文意外关闭。", "error");
  };
  const onBrowserDisconnected = () => {
    if (!expectedClose) emit(log, "浏览器诊断", "浏览器进程连接意外断开。", "error");
  };

  context.on("page", onContextPage);
  context.on("close", onContextClose);
  browser.on("disconnected", onBrowserDisconnected);
  for (const page of context.pages()) observePage(page);

  return {
    beginExpectedClose: () => { expectedClose = true; },
    detach: () => {
      context.off("page", onContextPage);
      context.off("close", onContextClose);
      browser.off("disconnected", onBrowserDisconnected);
      for (const [page, listeners] of pageListeners) {
        page.off("crash", listeners.crash);
        page.off("close", listeners.close);
        page.off("pageerror", listeners.pageerror);
      }
    },
  };
}

async function fillFirstVisible(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!await locator.isVisible().catch(() => false)) continue;
    const current = await locator.inputValue().catch(() => "");
    if (current !== value) await locator.fill(value);
    return true;
  }
  return false;
}

async function fillAllVisible(page: Page, selectors: string[], value: string): Promise<boolean> {
  let filled = false;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const input = locator.nth(index);
      if (!await input.isVisible().catch(() => false)) continue;
      const current = await input.inputValue().catch(() => "");
      if (current !== value) await input.fill(value);
      filled = true;
    }
    if (filled) return true;
  }
  return false;
}

async function clickFirstEnabled(page: Page, names: RegExp[]): Promise<boolean> {
  for (const name of names) {
    const button = page.getByRole("button", { name }).first();
    if (!await button.isVisible().catch(() => false)) continue;
    if (!await button.isEnabled().catch(() => false)) continue;
    await button.click();
    return true;
  }
  return false;
}

async function automateSignupForm(
  page: Page,
  email: string,
  automation: SignupAutomation,
  state: SignupAutomationState,
  log: LoginLogger,
): Promise<void> {
  if (state.formSubmitted) return;

  const username = deriveSignupUsername(email, automation.username);
  const emailFilled = await fillFirstVisible(page, [
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[name*="email" i]',
    'input[placeholder*="email" i]',
  ], email);
  const usernameFilled = await fillFirstVisible(page, [
    'input[autocomplete="username"]',
    'input[name*="username" i]',
    'input[placeholder*="username" i]',
    'input[aria-label*="username" i]',
  ], username);
  const passwordFilled = await fillAllVisible(page, [
    'input[type="password"]',
    'input[autocomplete="new-password"]',
    'input[name*="password" i]',
  ], automation.password);

  const formStep = passwordFilled ? "password" : usernameFilled ? "username" : emailFilled ? "email" : "";
  if (!formStep) return;
  const actionKey = `${formStep}:${safePageUrl(page.url())}`;
  if (state.formActions.has(actionKey)) return;

  const submitted = await clickFirstEnabled(page, [
    /create free account/i,
    /create account/i,
    /^sign up$/i,
    /^continue$/i,
  ]);
  if (submitted) {
    state.formActions.add(actionKey);
    state.formSubmitted = passwordFilled;
    emit(
      log,
      "自动填写",
      passwordFilled
        ? `已填写邮箱、用户名（${username}）和密码，并提交注册表单。`
        : `已填写当前注册步骤（${formStep}），正在进入下一步。`,
    );
  } else if (!state.formBlockedLogged) {
    state.formBlockedLogged = true;
    emit(log, "等待人工操作", "注册字段已自动填写；提交按钮尚不可用，请手动处理页面协议确认或人机验证。", "warn");
  }
}

async function automateOnboarding(
  page: Page,
  email: string,
  automation: SignupAutomation,
  state: SignupAutomationState,
  log: LoginLogger,
): Promise<void> {
  const username = deriveSignupUsername(email, automation.username);
  if (!state.onboardingActions.has("name")) {
    const filled = await fillFirstVisible(page, [
      'input[name="name" i]',
      'input[name*="fullName" i]',
      'input[placeholder*="full name" i]',
      'input[aria-label*="full name" i]',
    ], username);
    if (filled) {
      state.onboardingActions.add("name");
      emit(log, "自动设置", "已填写个人资料名称。", "info");
      return;
    }
  }

  const actions: Array<{ key: string; names: RegExp[]; message: string; repeatByUrl?: boolean }> = [
    { key: "build-apis", names: [/build apis/i], message: "已选择 Build APIs。" },
    { key: "backend-role", names: [/backend developer/i], message: "已选择 Backend Developer。" },
    { key: "team-size", names: [/^1 member$/i, /just me/i], message: "已选择单人团队规模。" },
    { key: "ai-example", names: [/send requests/i, /write tests/i], message: "已选择一个 AI 引导示例。" },
    { key: "continue", names: [/get started with ai/i, /go forward/i, /^continue$/i, /^next$/i], message: "已推进普通首次设置步骤。", repeatByUrl: true },
  ];

  for (const action of actions) {
    const actionKey = action.repeatByUrl ? `${action.key}:${safePageUrl(page.url())}` : action.key;
    if (state.onboardingActions.has(actionKey)) continue;
    if (!await clickFirstEnabled(page, action.names)) continue;
    state.onboardingActions.add(actionKey);
    emit(log, "自动设置", action.message, "info");
    await page.waitForTimeout(500);
    return;
  }
}

async function getPostmanSid(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies();
  const scoped = cookies.find((cookie) =>
    cookie.name === "postman.sid" && cookie.value &&
    (cookie.domain.includes(".postman.co") || cookie.domain === "postman.co"));
  return scoped?.value ?? cookies.find((cookie) => cookie.name === "postman.sid" && cookie.value)?.value ?? null;
}

async function readSetupStage(page: Page): Promise<PostmanSetupStage> {
  let text = "";
  try {
    text = await page.evaluate(() => String((globalThis as any).document?.body?.innerText || "").slice(0, 20_000));
  } catch {
    // Navigation can temporarily make the document unavailable.
  }
  return classifyPostmanSetupStage(page.url(), text);
}

function stageMessage(stage: PostmanSetupStage, automated = false): { step: string; msg: string; level?: string } {
  switch (stage) {
    case "signup":
      return automated
        ? { step: "注册", msg: "正在识别并自动填写注册表单。" }
        : { step: "注册", msg: "请手动填写你有权管理的邮箱并提交注册。" };
    case "login":
      return { step: "登录", msg: "请在浏览器中手动完成登录。" };
    case "email_verification":
      return { step: "邮箱验证", msg: "请手动读取并填写邮箱验证码；程序不会读取邮箱内容。" };
    case "captcha":
      return { step: "人机验证", msg: "请手动完成 CAPTCHA 或其他人机验证。", level: "warn" };
    case "onboarding":
      return automated
        ? { step: "首次设置", msg: "正在自动推进普通个人资料和工作区设置。" }
        : { step: "首次设置", msg: "请手动填写个人信息、角色和工作区设置，直到进入团队工作区。" };
    case "billing":
      return { step: "套餐与额度", msg: "请自行确认套餐、付款与 AI 额度；任何付费操作都必须由你手动确认。" };
    case "team_ai":
      return { step: "Team AI", msg: "请由有权限的用户手动开启 Team AI。完成后返回任一工作区页面。" };
    case "workspace":
      return { step: "工作区", msg: "已检测到 Postman 工作区。" };
    default:
      return { step: "等待", msg: "等待 Postman 页面进入下一阶段。" };
  }
}

async function waitForManualLogin(
  context: BrowserContext,
  initialPage: Page,
  accountEmail: string,
  timeoutMs: number,
  log: LoginLogger,
  flow: PostmanAuthFlow,
  confirmationId?: string,
  signupAutomation?: SignupAutomation,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  let openedHome = false;
  let lastProgressLog = 0;
  let lastStage: PostmanSetupStage | undefined;
  const automationState: SignupAutomationState = {
    formSubmitted: false,
    formBlockedLogged: false,
    formActions: new Set(),
    onboardingActions: new Set(),
  };

  emit(log, signupAutomation ? "自动化注册" : "人工操作", flow === "signup"
    ? signupAutomation
      ? "程序将自动填写普通注册与首次设置页面；验证码、CAPTCHA、套餐和权限步骤需要你手动完成。完成后回到管理台点击“完成确认”。"
      : "请在可见浏览器中完成注册、邮箱验证和全部首次设置；完成后回到管理台点击“完成确认”。"
    : "请在可见浏览器中完成 Postman 登录。");
  emit(log, "安全边界", "验证码、CAPTCHA、付款和权限变更必须由你手动完成；程序只识别阶段和提取登录后的会话。", "warn");

  while (Date.now() < deadline) {
    const pages = context.pages().filter((page) => !page.isClosed());
    if (!pages.length) throw new Error("The login browser was closed before login completed");

    for (const page of [...pages].reverse()) {
      const url = page.url();
      let parsed: URL | undefined;
      try { parsed = new URL(url); } catch { /* Ignore transient non-URL pages. */ }
      if (!parsed?.hostname.endsWith("postman.co") && !parsed?.hostname.endsWith("getpostman.com")) continue;

      const stage = await readSetupStage(page);
      if (stage !== lastStage) {
        const message = stageMessage(stage, Boolean(signupAutomation));
        emit(log, message.step, message.msg, message.level);
        lastStage = stage;
      }

      if (signupAutomation && flow === "signup") {
        try {
          if (stage === "signup") {
            await automateSignupForm(page, accountEmail, signupAutomation, automationState, log);
          } else if (stage === "onboarding") {
            await automateOnboarding(page, accountEmail, signupAutomation, automationState, log);
          }
        } catch (error) {
          if (!isTransientBrowserInteractionError(error)) throw error;
          emit(
            log,
            "自动化注册",
            `页面正在刷新或跳转，已跳过本轮自动填写并将在下一轮重试：${describeAutomationError(error)}`,
            "warn",
          );
        }
      }

      const subdomain = workspaceSubdomainFromUrl(url);
      const sid = await getPostmanSid(context);
      const manuallyConfirmed = flow === "signup" && isSignupCompletionConfirmed(confirmationId);
      if (shouldCompletePostmanSetup(flow, stage, manuallyConfirmed, Boolean(sid), Boolean(subdomain))) {
        if (flow === "signup") emit(log, "完成确认", "已收到手动确认，并检测到有效 Postman 会话。", "info");
        return page;
      }

      if (url && url !== lastUrl) {
        lastUrl = url;
        emit(log, "页面", safePageUrl(url));
      }
    }

    const sid = await getPostmanSid(context);
    const mayResolveWorkspace = lastStage !== "signup"
      && lastStage !== "email_verification"
      && lastStage !== "captcha"
      && lastStage !== "onboarding";
    if (sid && !openedHome && mayResolveWorkspace) {
      openedHome = true;
      const target = pages.at(-1) ?? initialPage;
      try {
        emit(log, "跳转", "已检测到登录会话，正在解析团队工作区...");
        await target.goto(POSTMAN_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await target.waitForTimeout(2_000);
        continue;
      } catch (error) {
        emit(log, "跳转", `暂时无法打开 Postman Home：${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    }

    if (Date.now() - lastProgressLog >= 15_000) {
      const message = flow === "signup"
        ? `等待手动完成确认，剩余约 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒。`
        : `等待用户完成当前步骤，剩余约 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒。`;
      emit(log, "等待", message);
      lastProgressLog = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Manual ${flow} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
}

async function extractCredentials(page: Page, context: BrowserContext, log: LoginLogger): Promise<PostmanLoginResult> {
  const currentUrl = page.url();
  const workspaceSubdomain = workspaceSubdomainFromUrl(currentUrl) ?? "web";
  emit(log, "跳转", `最终页面：${safePageUrl(currentUrl)}`);
  emit(log, "工作区", `团队子域：${workspaceSubdomain}`);

  const postmanSid = await getPostmanSid(context);
  if (!postmanSid) throw new Error("postman.sid cookie not found after manual login");
  emit(log, "会话", "已安全获取 Postman 会话 Cookie。", "info");

  let handshakeToken: string | undefined;
  let userInfo: Record<string, any> | undefined;
  emit(log, "token", "Fetching handshake token...");
  try {
    const handshake = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as { token?: string };
    }, HANDSHAKE_TOKEN_URL);
    handshakeToken = handshake?.token;
  } catch (error) {
    emit(log, "token", `Handshake failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }

  try {
    userInfo = await page.evaluate(async () => {
      const response = await fetch("https://god.postman.co/api/users/me", { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    });
  } catch (error) {
    emit(log, "用户资料", `无法读取邮箱，将使用用户 ID 作为账号标签：${error instanceof Error ? error.message : String(error)}`, "warn");
  }

  const identity = extractIdentity(handshakeToken, userInfo);
  const email = extractAccountEmail(userInfo, identity.userId);
  emit(log, "账号识别", `账号标签：${email}`);
  emit(log, "token", `userId=${identity.userId}, teamId=${identity.teamId}`);

  emit(log, "done", `user_id=${identity.userId} workspace_id=${identity.teamId} subdomain=${workspaceSubdomain}`);
  return {
    email,
    postman_sid: postmanSid,
    user_id: identity.userId,
    workspace_id: identity.teamId,
    workspace_subdomain: workspaceSubdomain,
  };
}

export async function loginPostman(
  accountLabel: string | undefined,
  options: PostmanLoginOptions = {},
): Promise<PostmanLoginResult> {
  const flow = options.flow ?? "login";
  const timeoutMs = options.timeoutMs ?? (flow === "signup" ? MANUAL_SIGNUP_TIMEOUT_MS : MANUAL_LOGIN_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Login timeout must be greater than zero");
  const log = createLogger(options.onLog);
  let browser: Browser | undefined;
  let diagnostics: BrowserDiagnostics | undefined;

  try {
    emit(log, "初始化", `正在以可见模式启动 ${config.loginBrowserBackend}...`);
    if (accountLabel?.trim()) emit(log, "账号", `预设账号标签：${accountLabel.trim()}`);
    emit(log, "浏览器", "正在打开浏览器...");
    browser = await launchLoginBrowser(config.loginBrowserBackend, { headless: false });
    const context = await browser.newContext();
    diagnostics = attachBrowserDiagnostics(browser, context, log);
    const page = await context.newPage();
    page.setDefaultTimeout(120_000);
    const startUrl = authStartUrl(flow);
    emit(log, "打开页面", `正在打开 ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2_000);
    emit(log, "打开页面", flow === "signup" ? "Postman 注册页已加载" : "Postman 登录页已加载");
    const resultPage = await waitForManualLogin(
      context,
      page,
      accountLabel?.trim() || "user@postman.local",
      timeoutMs,
      log,
      flow,
      options.confirmationId,
      options.signupAutomation,
    );
    await resultPage.waitForTimeout(3_000);
    emit(log, "提取凭据", "人工步骤已完成，正在提取账号凭据...");
    return await extractCredentials(resultPage, context, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(log, "error", `Login failed: ${message}`, "error");
    return { postman_sid: "", user_id: "", workspace_id: "", workspace_subdomain: "", error: message };
  } finally {
    if (flow === "signup") clearSignupConfirmation(options.confirmationId);
    diagnostics?.beginExpectedClose();
    await browser?.close().catch(() => undefined);
    diagnostics?.detach();
    emit(log, "cleanup", "Browser closed");
  }
}

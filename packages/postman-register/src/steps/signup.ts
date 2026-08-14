import type { Locator, Page, Response } from "playwright";
import { CONFIG } from "../config";
import type { StepContext } from "../types";
import { log } from "../core/logger";
import { firstVisible, retry, sleep } from "../core/waiters";
import * as ps from "../selectors/postman";

async function fillField(page: Page, candidates: Locator[], value: string, label: string): Promise<void> {
  const loc = await firstVisible(candidates, CONFIG.timeouts.short);
  if (!loc) throw new Error(`未找到输入框: ${label}`);
  await loc.fill(value);
  log.info(`已填写 ${label}: ${value}`);
}

/**
 * 捕获提交注册期间 Postman 接口的 POST 响应（状态码 + 响应体片段）。
 * "Something went wrong" 只是 UI 通用文案，真实拒绝原因（邮箱域名被拦、用户名不合法、
 * CAPTCHA token 无效、IP 风控等）都在接口响应体里。
 */
function captureSignupApiResponses(tab: Page): { done: () => Promise<string[]> } {
  const responses: string[] = [];
  const pending: Promise<void>[] = [];
  const onResponse = (res: Response): void => {
    try {
      if (res.request().method() !== "POST") return;
      if (!/postman/i.test(new URL(res.url()).hostname)) return;
      pending.push(
        res
          .text()
          .then((body) => {
            responses.push(`HTTP ${res.status()} ${res.url()} → ${body.slice(0, 400)}`);
          })
          .catch(() => {
            responses.push(`HTTP ${res.status()} ${res.url()}（响应体读取失败）`);
          }),
      );
    } catch {
      // URL 解析失败等忽略
    }
  };
  tab.on("response", onResponse);
  return {
    done: async () => {
      tab.off("response", onResponse);
      await Promise.allSettled(pending);
      return responses;
    },
  };
}

/**
 * 第二阶段：注册账号（标签页 B）。仅在正常提交注册表单后，且页面出现 OTP
 * 验证证据时，才允许后续阶段访问邮箱。
 * 提交可能被 Postman 拒绝（"Something went wrong, please refresh the page."）：
 * 检测到该错误时刷新页面、重填表单、重新过 CAPTCHA 后重试，最多 3 次。
 */
export async function runSignup(ctx: StepContext): Promise<void> {
  const { plan, tabs } = ctx;
  log.stageStart("signup", "打开 Postman 注册页");
  if (!plan.email) throw new Error("缺少临时邮箱，请先执行第一阶段");

  const tab = await tabs.openDedicatedTab("Postman 注册 B", CONFIG.urls.postmanSignup);
  if (tab === plan.emailTab) throw new Error("内部错误：Postman 注册页与临时邮箱共用了同一标签页");
  plan.postmanTab = tab;

  const MAX_SUBMIT_ATTEMPTS = 3;
  let otpReady = false;
  let lastApiLog = "";
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS && !otpReady; attempt++) {
    if (attempt > 1) {
      log.warn(`注册提交被拒（第 ${attempt - 1} 次），刷新页面重填表单后重试……`);
      await tab.reload({ waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
    }

    await fillField(tab, ps.emailInputs(tab), plan.email, "工作邮箱");
    await fillField(tab, ps.usernameInputs(tab), plan.emailPrefix!, "用户名");
    await fillField(tab, ps.passwordInputs(tab), plan.password, "密码");

    // CAPTCHA 不存在时仍必须验证当前注册页可正常提交；绝不把“组件不存在”当作验证成功。
    await ps.waitForCloudflareSuccess(tab, CONFIG.timeouts.cfWait, () => ps.registrationFormReady(tab));

    const submit = await firstVisible(ps.registrationSubmitButtons(tab), CONFIG.timeouts.short);
    if (!submit) throw new Error("未找到正常的 Register / Create Free Account 提交按钮");
    if (await submit.isDisabled().catch(() => true)) throw new Error("注册提交按钮不可用，未提交注册表单");

    // 点击前挂上接口捕获，提交被拒时能看到真实原因
    const capture = captureSignupApiResponses(tab);
    await submit.click();
    plan.signupSubmitted = true;
    log.info("已正常提交注册表单，等待跳转到验证码界面……");

    // 竞速检测：OTP 界面（成功）vs "Something went wrong"（可刷新重试）vs 确定性错误（立即抛错）。
    // 只有确认跳转到验证码输入界面后，verify 阶段才被允许去邮箱 tab 取码。
    const outcome = await ps.waitForSignupOutcome(tab);
    const apiResponses = await capture.done();
    if (outcome === "otp") {
      otpReady = true;
      plan.verificationReady = true;
      log.ok("已确认跳转到验证码输入界面，可以开始从邮箱提取验证码");
    } else {
      log.warn("页面提示 Something went wrong, please refresh the page.");
      if (apiResponses.length > 0) {
        lastApiLog = apiResponses.join("\n  ");
        log.warn(`注册接口响应（定位拒绝原因）：\n  ${lastApiLog}`);
      } else {
        lastApiLog = "未捕获到注册接口 POST 响应（请求可能未发出，或被浏览器/扩展拦截）";
        log.warn(lastApiLog);
      }
      await sleep(500);
    }
  }
  if (!otpReady) {
    throw new Error(
      `注册提交连续 ${MAX_SUBMIT_ATTEMPTS} 次被拒（Something went wrong）。最后一次接口响应：\n  ${lastApiLog || "无"}\n可根据上方响应体判断是邮箱域名、用户名、CAPTCHA token 还是 IP 风控问题`,
    );
  }

  // 仅在确认 OTP 界面后保存恢复 URL，不能用 URL 参数推断注册成功。
  await retry(
    async () => {
      const url = tab.url();
      if (!url) throw new Error("验证页 URL 为空");
      plan.verifyUrl = url;
    },
    { attempts: 5, delayMs: 1000 },
  ).catch(() => log.warn("未捕获验证页 URL，第三阶段将尝试从当前页面继续"));

  log.info(`当前 URL: ${tab.url()}`);
}

import { describe, expect, spyOn, test } from "bun:test";
import { TurnstileDiagnostics, isCloudflareChallengeUrl, redactDiagnosticUrl } from "../packages/postman-register/src/core/turnstileDiagnostics";
import {
  isCaptchaFailureText,
  isOtpFailureText,
  isSignupFailureText,
  isSignupFatalText,
  throwIfCaptchaFailure,
  clickTurnstileCheckbox,
  waitForCloudflareSuccess,
  upgradeEntryCandidates,
  upgradeFallbackUrls,
} from "../packages/postman-register/src/selectors/postman";
import { extractCodeFromListText } from "../packages/postman-register/src/steps/verify";
import { waitForSignal } from "../packages/postman-register/src/core/monitor";
import { clickWhenReady } from "../packages/postman-register/src/core/waiters";
import { shouldRetryUpstreamStage, shouldStopRegistrationBatch } from "../src/automation-lab/upstream-registration";

describe("Postman registration text parsing", () => {
  test("extracts labeled verification codes with invisible separators", () => {
    expect(extractCodeFromListText("Verification code: 8​5‌3⁠0﻿2­1")).toBe("853021");
    expect(extractCodeFromListText("您的验证码是 123-456")).toBe("123456");
  });

  test("accepts one unlabeled code but rejects ambiguous inbox text", () => {
    expect(extractCodeFromListText("Postman 654321")).toBe("654321");
    expect(extractCodeFromListText("old 123456 new 654321")).toBeNull();
    expect(extractCodeFromListText("order 12345")).toBeNull();
  });

  test("recognizes CAPTCHA failures without matching ordinary CAPTCHA copy", () => {
    expect(isCaptchaFailureText("Unable to verify the captcha. Please try again.")).toBe(true);
    expect(isCaptchaFailureText("Captcha verification failed due to an error")).toBe(true);
    expect(isCaptchaFailureText("Complete the CAPTCHA to continue")).toBe(false);
  });

  test("recognizes expired or invalid OTP messages", () => {
    expect(isOtpFailureText("The verification code is invalid")).toBe(true);
    expect(isOtpFailureText("验证码已过期，请重新获取")).toBe(true);
    expect(isOtpFailureText("We sent a verification code to your email")).toBe(false);
  });

  test("separates retryable signup errors from fatal account errors", () => {
    expect(isSignupFailureText("Something went wrong.")).toBe(true);
    expect(isSignupFailureText("Something went wrong, please refresh and try again")).toBe(true);
    expect(isSignupFailureText("Your account is ready")).toBe(false);

    expect(isSignupFatalText("This email is already registered")).toBe(true);
    expect(isSignupFatalText("Disposable email addresses are not supported")).toBe(true);
    expect(isSignupFatalText("This username is available")).toBe(false);
  });

  test("keeps a temporary mailbox when retrying an upstream target stage", () => {
    expect(shouldRetryUpstreamStage("tempEmail", new Error("mailbox quota reached"), 0, 2)).toBe(false);
    expect(shouldRetryUpstreamStage("signup", new Error("target page failed"), 0, 2)).toBe(true);
    expect(shouldRetryUpstreamStage("signup", new Error("target page failed"), 2, 2)).toBe(false);
  });

  test("stops the whole batch when temporary-mail creation is blocked", () => {
    expect(shouldStopRegistrationBatch(new Error("上游 tempEmail 阶段失败：检测到临时邮箱创建额度限制"))).toBe(true);
    expect(shouldStopRegistrationBatch(new Error("上游 signup 阶段失败：目标页加载超时"))).toBe(false);
  });

  test("looks for upgrade entry across buttons, links, and page metadata", () => {
    const calls: string[] = [];
    const locator = (label: string) => ({ label, first: () => ({ label }) });
    const page = {
      getByRole: (role: string, options: { name: string | RegExp }) => {
        calls.push(`${role}:${String(options.name)}`);
        return locator(`${role}:${String(options.name)}`);
      },
      locator: (selector: string) => {
        calls.push(selector);
        return locator(selector);
      },
    };

    expect(upgradeEntryCandidates(page as never)).toHaveLength(8);
    expect(calls).toContain("button:/^upgrade$/i");
    expect(calls).toContain("link:/^upgrade$/i");
    expect(calls).toContain("button:/upgrade/i");
    expect(calls).toContain("link:/upgrade/i");
    expect(calls.some((call) => call.includes("data-testid") && call.includes("aria-label"))).toBe(true);
    expect(upgradeFallbackUrls("https://go.postman.co")).toContain("https://go.postman.co/settings/team/ai");
  });

  test("bounds a hung browser signal so the interaction hook can keep running", async () => {
    let misses = 0;
    const startedAt = Date.now();

    await expect(waitForSignal([
      { name: "hung browser query", check: () => new Promise<boolean>(() => {}) },
    ], {
      timeout: 80,
      interval: 20,
      onMiss: async () => { misses += 1; },
    })).rejects.toThrow("超时");

    expect(misses).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("does not block on a detached page body while checking CAPTCHA failure text", async () => {
    const page = {
      locator: () => ({ innerText: () => new Promise<string>(() => {}) }),
    };
    const result = await Promise.race([
      throwIfCaptchaFailure(page as never).then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    expect(result).toBe("resolved");
  });

  test("does not treat a missing main frame as an absent CAPTCHA", async () => {
    let mainFrameReads = 0;
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: () => ({ count: async () => 0 }),
    };
    const page = {
      on: () => undefined,
      off: () => undefined,
      locator: () => ({ innerText: async () => "", evaluateAll: async () => [] }),
      mainFrame: () => {
        mainFrameReads += 1;
        return mainFrameReads <= 2 ? undefined : main;
      },
      frames: () => [main],
    };
    let validationCalls = 0;

    await waitForCloudflareSuccess(page as never, 2_000, async () => {
      validationCalls += 1;
      expect(mainFrameReads).toBeGreaterThan(2);
      return true;
    });

    expect(validationCalls).toBe(1);
  });

  test("propagates a failed interaction hook instead of hiding it as a timeout", async () => {
    await expect(waitForSignal([
      { name: "never", check: async () => false },
    ], {
      timeout: 1000,
      interval: 20,
      onMiss: async () => { throw new Error("click hook failed"); },
    })).rejects.toThrow("click hook failed");
  });

  test("retries a click after the button becomes stable and actionable", async () => {
    let visible = false;
    let clicks = 0;
    const locator = {
      isVisible: async () => visible,
      isDisabled: async () => false,
      scrollIntoViewIfNeeded: async () => undefined,
      boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 32 }),
      click: async () => {
        if (!visible || clicks === 0) {
          clicks += 1;
          throw new Error("overlay still settling");
        }
        clicks += 1;
      },
    };
    setTimeout(() => { visible = true; }, 20);

    await clickWhenReady(locator as never, { timeout: 500, label: "测试按钮", retryDelayMs: 20 });

    expect(clicks).toBeGreaterThanOrEqual(2);
  });

  test("keeps a sitekey/callback CAPTCHA marker pending until a token exists", async () => {
    const button = {
      isVisible: async () => true,
      isDisabled: async () => false,
    };
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: (selector: string) => {
        const isMarker = selector.includes(".g-recaptcha") || selector.includes("data-sitekey") || selector.includes("g-recaptcha-response");
        const loc = {
          first: () => loc,
          count: async () => isMarker ? 1 : 0,
          isVisible: async () => false,
          inputValue: async () => "",
        };
        return loc;
      },
      getByRole: () => button,
      getByText: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    };
    const page = {
      on: () => undefined,
      off: () => undefined,
      locator: () => ({ innerText: async () => "", evaluateAll: async () => [] }),
      mainFrame: () => main,
      frames: () => [main],
    };

    await expect(waitForCloudflareSuccess(page as never, 250)).rejects.toThrow("超时");
  });
});

describe("Turnstile timing diagnostics", () => {
  test("uses the visible challenge iframe box when the checkbox DOM is not exposed", async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: (selector: string) => {
        const visibleIframe = selector.includes('iframe[src*="challenges.cloudflare.com"]')
          || selector.includes('iframe[src*="turnstile"]');
        const loc = {
          first: () => loc,
          count: async () => visibleIframe ? 1 : 0,
          isVisible: async () => false,
          boundingBox: async () => visibleIframe ? { x: 120, y: 240, width: 302, height: 65 } : null,
          click: async () => undefined,
        };
        return loc;
      },
      getByText: () => ({ first: () => ({ count: async () => 0 }) }),
    };
    const page = {
      mainFrame: () => main,
      frames: () => [main],
      mouse: { click: async (x: number, y: number) => { clicks.push({ x, y }); } },
    };
    const diagnostics = {
      observeVisibleWidget: () => undefined,
      observeWidgetMissing: () => undefined,
      observeClickAttempt: () => undefined,
      observeClickCompleted: () => undefined,
      observeClickFailed: () => undefined,
      observeClickThrottled: () => undefined,
    };

    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000);
      await clickTurnstileCheckbox(page as never, diagnostics as never);
      expect(clicks).toEqual([]);

      clock.mockReturnValue(1_800);
      await clickTurnstileCheckbox(page as never, diagnostics as never);
      expect(clicks).toEqual([{ x: 150, y: 272.5 }]);
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps the main-page click path alive when child frame enumeration is transient", async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: (selector: string) => {
        const visibleIframe = selector.includes('iframe[src*="challenges.cloudflare.com"]')
          || selector.includes('iframe[src*="turnstile"]');
        const loc = {
          first: () => loc,
          count: async () => visibleIframe ? 1 : 0,
          isVisible: async () => false,
          boundingBox: async () => visibleIframe ? { x: 32, y: 64, width: 302, height: 65 } : null,
          click: async () => undefined,
        };
        return loc;
      },
      getByText: () => ({ first: () => ({ count: async () => 0 }) }),
    };
    const page = {
      mainFrame: () => main,
      frames: () => { throw new TypeError("Cannot read properties of undefined (reading '_getChildFrames')"); },
      mouse: { click: async (x: number, y: number) => { clicks.push({ x, y }); } },
    };

    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000);
      await expect(clickTurnstileCheckbox(page as never)).resolves.toBeUndefined();
      expect(clicks).toEqual([]);

      clock.mockReturnValue(1_800);
      await expect(clickTurnstileCheckbox(page as never)).resolves.toBeUndefined();
      expect(clicks).toEqual([{ x: 62, y: 96.5 }]);
    } finally {
      clock.mockRestore();
    }
  });

  test("waits for a newly visible challenge iframe to settle before clicking", async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: (selector: string) => {
        const visibleIframe = selector.includes('iframe[src*="challenges.cloudflare.com"]')
          || selector.includes('iframe[src*="turnstile"]');
        const loc = {
          first: () => loc,
          count: async () => visibleIframe ? 1 : 0,
          isVisible: async () => false,
          boundingBox: async () => visibleIframe ? { x: 80, y: 160, width: 302, height: 65 } : null,
          click: async () => undefined,
        };
        return loc;
      },
      getByText: () => ({ first: () => ({ count: async () => 0 }) }),
    };
    const page = {
      mainFrame: () => main,
      frames: () => [main],
      mouse: { click: async (x: number, y: number) => { clicks.push({ x, y }); } },
    };
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000);
      await clickTurnstileCheckbox(page as never);
      expect(clicks).toEqual([]);

      clock.mockReturnValue(1_800);
      await clickTurnstileCheckbox(page as never);
      expect(clicks).toEqual([{ x: 110, y: 192.5 }]);
    } finally {
      clock.mockRestore();
    }
  });

  test("uses the Cloudflare child frame owner when the parent iframe selector is not ready", async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const absent = {
      first() { return this; },
      count: async () => 0,
      isVisible: async () => false,
      boundingBox: async () => null,
      click: async () => undefined,
    };
    const owner = {
      boundingBox: async () => ({ x: 48, y: 96, width: 304, height: 66 }),
    };
    const main = {
      url: () => "https://identity.getpostman.com/signup",
      locator: () => absent,
      getByText: () => absent,
    };
    const challenge = {
      url: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/f/av0/opaque",
      locator: () => absent,
      getByText: () => absent,
      frameElement: async () => owner,
    };
    const page = {
      mainFrame: () => main,
      frames: () => [main, challenge],
      mouse: { click: async (x: number, y: number) => { clicks.push({ x, y }); } },
    };
    const diagnostics = {
      observeVisibleWidget: () => undefined,
      observeWidgetMissing: () => undefined,
      observeClickAttempt: () => undefined,
      observeClickCompleted: () => undefined,
      observeClickFailed: () => undefined,
      observeClickThrottled: () => undefined,
    };

    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1_000);
      await clickTurnstileCheckbox(page as never, diagnostics as never);
      expect(clicks).toEqual([]);

      clock.mockReturnValue(1_800);
      await clickTurnstileCheckbox(page as never, diagnostics as never);
      expect(clicks).toEqual([{ x: 78, y: 129 }]);
    } finally {
      clock.mockRestore();
    }
  });

  test("removes query and fragment data from diagnostic URLs", () => {
    expect(redactDiagnosticUrl("https://challenges.cloudflare.com/turnstile/v0/api.js?secret=hidden#fragment")).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
    );
    expect(redactDiagnosticUrl("not a valid url")).toBe("<invalid-url>");
  });

  test("redacts opaque challenge path segments from diagnostic URLs", () => {
    const redacted = redactDiagnosticUrl(
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/fo/3776299777:1786770306:opaque-challenge-token-value-that-must-not-persist",
    );

    expect(redacted).toContain("https://challenges.cloudflare.com/cdn-cgi/challenge-platform");
    expect(redacted).not.toContain("opaque-challenge-token-value-that-must-not-persist");
    expect(redacted.length).toBeLessThan(140);
  });

  test("filters network diagnostics to the Cloudflare challenge host", () => {
    expect(isCloudflareChallengeUrl("https://challenges.cloudflare.com/turnstile/v0/api.js?x=1")).toBe(true);
    expect(isCloudflareChallengeUrl("https://api.postman.com/v1/me")).toBe(false);
    expect(isCloudflareChallengeUrl("not a valid url")).toBe(false);
  });

  test("records component and network timing, then releases page listeners", () => {
    const handlers = new Map<string, Set<(payload: any) => void>>();
    const page = {
      on(event: string, handler: (payload: any) => void) {
        const listeners = handlers.get(event) ?? new Set<(payload: any) => void>();
        listeners.add(handler);
        handlers.set(event, listeners);
        return this;
      },
      off(event: string, handler: (payload: any) => void) {
        handlers.get(event)?.delete(handler);
        return this;
      },
      emit(event: string, payload: any) {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
    };
    const logs: string[] = [];
    let now = 0;
    const diagnostics = new TurnstileDiagnostics({
      flow: "signup",
      now: () => now,
      emit: (message) => logs.push(message),
    });
    diagnostics.start(page as never);

    const request = {
      method: () => "GET",
      url: () => "https://challenges.cloudflare.com/turnstile/v0/api.js?opaque=do-not-log",
    };
    page.emit("request", request);
    now = 18;
    diagnostics.observeMarker();
    diagnostics.observeVisibleWidget("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g?opaque=do-not-log", {
      width: 302.6,
      height: 65.4,
    });
    diagnostics.observeClickAttempt();
    now = 41;
    page.emit("response", { request: () => request, status: () => 200 });
    now = 63;
    diagnostics.observeToken(88);
    diagnostics.observeSuccess("Turnstile token 已生成（隐藏输入框）");
    diagnostics.finish("success");

    const summary = diagnostics.snapshot();
    expect(summary.flow).toBe("signup");
    expect(summary.outcome).toBe("success");
    expect(summary.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "wait_started", atMs: 0 }),
        expect.objectContaining({ event: "network_request", atMs: 0, method: "GET" }),
        expect.objectContaining({ event: "marker_detected", atMs: 18 }),
        expect.objectContaining({ event: "widget_visible", width: 303, height: 65 }),
        expect.objectContaining({ event: "network_response", atMs: 41, status: 200, durationMs: 41 }),
        expect.objectContaining({ event: "token_generated", atMs: 63, tokenLength: 88 }),
      ]),
    );
    expect(JSON.stringify(summary)).not.toContain("opaque=do-not-log");
    expect(logs.length).toBeGreaterThan(1);
    expect(logs.some((entry) => entry.includes('"event":"click_attempted"'))).toBe(true);
    expect(logs.at(-1)).toContain('"outcome":"success"');
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});

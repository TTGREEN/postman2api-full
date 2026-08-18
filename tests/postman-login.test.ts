import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { loginPostmanAccount } from "../src/auth/bridge";
import { handleAccountLoginRequest, handleAccountWarmupRequest } from "../src/api/accounts";
import { parseLoginBrowserBackend } from "../src/auth/browser-launcher";
import { confirmSignup, loginAccount } from "../dashboard/src/lib/api";
import { getActiveSignupTask } from "../src/auth/signup-task";
import {
  authStartUrl,
  classifyPostmanSetupStage,
  clearSignupConfirmation,
  confirmSignupCompletion,
  decodeJwtPayload,
  describeAutomationError,
  deriveSignupUsername,
  extractIdentity,
  isSignupCompletionConfirmed,
  isTransientBrowserInteractionError,
  prepareSignupConfirmation,
  shouldCompletePostmanSetup,
  workspaceSubdomainFromUrl,
} from "../src/auth/postman-login";

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("login browser backend configuration", () => {
  test("defaults to Camoufox and preserves explicit Playwright selection", () => {
    expect(parseLoginBrowserBackend(undefined)).toBe("camoufox");
    expect(parseLoginBrowserBackend("")).toBe("camoufox");
    expect(parseLoginBrowserBackend("playwright")).toBe("playwright");
    expect(parseLoginBrowserBackend("camoufox")).toBe("camoufox");
  });
});

describe("Postman login pure helpers", () => {
  test("decodes handshake identity and workspace subdomains", () => {
    expect(decodeJwtPayload(jwt({ userId: 12, teamId: "team" }))).toEqual({ userId: 12, teamId: "team" });
    expect(workspaceSubdomainFromUrl("https://acme-team.postman.co/workspace/x")).toBe("acme-team");
    expect(workspaceSubdomainFromUrl("https://go.postman.co/home")).toBeNull();
  });

  test("uses users/me only for missing handshake fields", () => {
    expect(extractIdentity(jwt({ userId: "u" }), {
      id: "fallback-user",
      user_organizations: { organizations: [{ id: "fallback-team" }] },
    })).toEqual({ userId: "u", teamId: "fallback-team" });
    expect(extractIdentity(undefined)).toEqual({ userId: "unknown", teamId: "unknown" });
  });

  test("selects login and signup entry points", () => {
    expect(authStartUrl("login")).toBe("https://identity.getpostman.com/login");
    expect(authStartUrl("signup")).toBe("https://identity.getpostman.com/signup");
  });

  test("derives a safe signup username from the preferred value or email", () => {
    expect(deriveSignupUsername("user.name@example.com")).toBe("user.name");
    expect(deriveSignupUsername("user@example.com", " My User 名称 ")).toBe("My-User-");
    expect(deriveSignupUsername("user@example.com", "___")).toBe("___");
  });

  test("recognizes guided signup stages", () => {
    expect(classifyPostmanSetupStage("https://identity.getpostman.com/login", "Sign in to Postman")).toBe("login");
    expect(classifyPostmanSetupStage("https://identity.getpostman.com/signup", "Create your account")).toBe("signup");
    expect(classifyPostmanSetupStage("https://identity.getpostman.com/verify", "Check your inbox")).toBe("email_verification");
    expect(classifyPostmanSetupStage("https://identity.getpostman.com/challenge", "Verify you are human")).toBe("captcha");
    expect(classifyPostmanSetupStage("https://go.postman.co/onboarding", "Set up your workspace")).toBe("onboarding");
    expect(classifyPostmanSetupStage("https://team.postman.co/billing/add-ons/overview", "Team AI Usage")).toBe("billing");
    expect(classifyPostmanSetupStage("https://team.postman.co/settings", "Enable Team AI")).toBe("team_ai");
    expect(classifyPostmanSetupStage("https://team.postman.co/workspace/demo", "")).toBe("workspace");
    expect(classifyPostmanSetupStage("https://go.postman.co/", "Loading")).toBe("unknown");
  });

  test("completes signup only after manual confirmation and a valid workspace session", () => {
    expect(shouldCompletePostmanSetup("login", "workspace", false, true, true)).toBe(true);
    expect(shouldCompletePostmanSetup("signup", "workspace", false, true, true)).toBe(false);
    expect(shouldCompletePostmanSetup("signup", "billing", true, true, true)).toBe(true);
    expect(shouldCompletePostmanSetup("signup", "workspace", true, false, true)).toBe(false);
    expect(shouldCompletePostmanSetup("signup", "workspace", true, true, false)).toBe(false);
    expect(shouldCompletePostmanSetup("signup", "workspace", true, true, true)).toBe(true);
  });

  test("tracks signup completion confirmations by client-generated ID", () => {
    const confirmationId = crypto.randomUUID();
    expect(prepareSignupConfirmation(confirmationId)).toBe(true);
    expect(isSignupCompletionConfirmed(confirmationId)).toBe(false);
    expect(confirmSignupCompletion(confirmationId)).toBe(true);
    expect(isSignupCompletionConfirmed(confirmationId)).toBe(true);
    clearSignupConfirmation(confirmationId);
    expect(isSignupCompletionConfirmed(confirmationId)).toBe(false);
  });

  test("retries only page-transition automation errors and keeps diagnostics compact", () => {
    expect(isTransientBrowserInteractionError(new Error("Execution context was destroyed, most likely because of a navigation"))).toBe(true);
    expect(isTransientBrowserInteractionError(new Error("Target page, context or browser has been closed"))).toBe(true);
    expect(isTransientBrowserInteractionError(new Error("locator.fill: strict mode violation"))).toBe(false);
    expect(describeAutomationError(new Error("  line one\nline two  "))).toBe("line one line two");
  });
});

describe("signup parameter propagation", () => {
  test("passes email and signup confirmation ID into the login bridge", async () => {
    const app = new Hono();
    const confirmationId = crypto.randomUUID();
    let received: { email: string | undefined; flow: string; confirmationId: string | undefined } | undefined;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async (email, _onLog, _dependencies, flow, receivedConfirmationId) => {
      received = { email, flow, confirmationId: receivedConfirmationId };
      return { success: true, accountId: 123 };
    }));

    const response = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " signup@example.com ", flow: "signup", confirmationId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accountId: 123, imported: true });
    expect(received).toEqual({ email: "signup@example.com", flow: "signup", confirmationId });
    expect(getActiveSignupTask()).toBeNull();
  });

  test("passes automated signup credentials only to the signup browser flow", async () => {
    const app = new Hono();
    const confirmationId = crypto.randomUUID();
    let received: any;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async (
      email,
      _onLog,
      _dependencies,
      flow,
      receivedConfirmationId,
      signupAutomation,
    ) => {
      received = { email, flow, confirmationId: receivedConfirmationId, signupAutomation };
      return { success: true, accountId: 321 };
    }));

    const response = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "automated@example.com",
        flow: "signup",
        confirmationId,
        signupAutomation: { username: "automated-user", password: "secret-pass-123" },
      }),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({
      email: "automated@example.com",
      flow: "signup",
      confirmationId,
      signupAutomation: { username: "automated-user", password: "secret-pass-123" },
    });
    expect(getActiveSignupTask()).toBeNull();
  });

  test("rejects invalid automated signup settings before opening a browser", async () => {
    const app = new Hono();
    let called = false;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      called = true;
      return { success: true, accountId: 123 };
    }));

    const shortPassword = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "automated@example.com",
        flow: "signup",
        confirmationId: crypto.randomUUID(),
        signupAutomation: { password: "short" },
      }),
    });
    expect(shortPassword.status).toBe(400);

    const wrongFlow = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "automated@example.com",
        flow: "login",
        signupAutomation: { password: "secret-pass-123" },
      }),
    });
    expect(wrongFlow.status).toBe(400);
    expect(called).toBe(false);
  });

  test("allows only one signup task at a time and releases the lock after success", async () => {
    const app = new Hono();
    let finishFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
    let calls = 0;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      calls += 1;
      if (calls === 1) await firstFinished;
      return { success: true, accountId: calls };
    }));

    const firstConfirmationId = crypto.randomUUID();
    const firstRequest = app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "first@example.com", flow: "signup", confirmationId: firstConfirmationId }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponse = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "second@example.com", flow: "signup", confirmationId: crypto.randomUUID() }),
    });
    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json() as any).error).toContain("已有注册任务正在进行");
    expect(calls).toBe(1);

    finishFirst?.();
    expect((await firstRequest).status).toBe(200);
    expect(getActiveSignupTask()).toBeNull();

    const thirdResponse = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "third@example.com", flow: "signup", confirmationId: crypto.randomUUID() }),
    });
    expect(thirdResponse.status).toBe(200);
    expect(calls).toBe(2);
    expect(getActiveSignupTask()).toBeNull();
  });

  test("releases the signup lock when the registration flow fails", async () => {
    const app = new Hono();
    let calls = 0;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      calls += 1;
      return calls === 1
        ? { success: false, error: "registration failed" }
        : { success: true, accountId: 456 };
    }));

    const failedResponse = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "failed@example.com", flow: "signup", confirmationId: crypto.randomUUID() }),
    });
    expect(failedResponse.status).toBe(400);
    expect(getActiveSignupTask()).toBeNull();

    const retryResponse = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "retry@example.com", flow: "signup", confirmationId: crypto.randomUUID() }),
    });
    expect(retryResponse.status).toBe(200);
    expect(getActiveSignupTask()).toBeNull();
  });

  test("requires email for browser login and signup", async () => {
    const app = new Hono();
    let called = false;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      called = true;
      return { success: true, accountId: 123 };
    }));

    const response = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow: "login" }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("requires a confirmation ID for signup", async () => {
    const app = new Hono();
    let called = false;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      called = true;
      return { success: true, accountId: 123 };
    }));

    const response = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "signup@example.com", flow: "signup" }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects unsupported auth flows before starting login", async () => {
    const app = new Hono();
    let called = false;
    app.post("/api/accounts/login", (c) => handleAccountLoginRequest(c, async () => {
      called = true;
      return { success: true, accountId: 123 };
    }));

    const response = await app.request("/api/accounts/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "signup@example.com", flow: "other" }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("includes email and signup confirmation in the dashboard API request body", async () => {
    const originalFetch = globalThis.fetch;
    const confirmationId = crypto.randomUUID();
    let request: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await loginAccount("signup@example.com", "signup", confirmationId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request).toEqual({
      url: "/api/accounts/login",
      method: "POST",
      body: JSON.stringify({ email: "signup@example.com", flow: "signup", confirmationId }),
    });
  });

  test("includes automated signup settings in the dashboard API request body", async () => {
    const originalFetch = globalThis.fetch;
    const confirmationId = crypto.randomUUID();
    let request: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await loginAccount(
        "automated@example.com",
        "signup",
        confirmationId,
        { username: "automated-user", password: "secret-pass-123" },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request).toEqual({
      url: "/api/accounts/login",
      method: "POST",
      body: JSON.stringify({
        email: "automated@example.com",
        flow: "signup",
        confirmationId,
        signupAutomation: { username: "automated-user", password: "secret-pass-123" },
      }),
    });
  });

  test("posts the client-generated ID when confirming signup", async () => {
    const originalFetch = globalThis.fetch;
    const confirmationId = crypto.randomUUID();
    let request: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await confirmSignup(confirmationId);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request).toEqual({
      url: "/api/accounts/signup/confirm",
      method: "POST",
      body: JSON.stringify({ confirmationId }),
    });
  });
});

describe("single account refresh", () => {
  test("returns only the refreshed account instead of the full account list", async () => {
    const email = `refresh-${crypto.randomUUID()}@example.com`;
    const [created] = await db.insert(accounts).values({
      email,
      password: "unused",
      status: "active",
      enabled: true,
      tokens: JSON.stringify({
        postman_sid: "sid",
        user_id: "user",
        workspace_id: "team",
        workspace_subdomain: "acme",
      }),
      quotaLimit: 800,
      quotaRemaining: 700,
    }).returning();

    const app = new Hono();
    app.post("/api/accounts/:id/warmup", (c) => handleAccountWarmupRequest(c, async (id) => {
      await db.update(accounts).set({ quotaRemaining: 650 }).where(eq(accounts.id, id));
      return { success: true };
    }));

    try {
      const response = await app.request(`/api/accounts/${created!.id}/warmup`, { method: "POST" });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.account.id).toBe(created!.id);
      expect(body.account.email).toBe(email);
      expect(body.account.quotaRemaining).toBe(650);
      expect(body.data).toBeUndefined();
    } finally {
      await db.delete(accounts).where(eq(accounts.id, created!.id));
    }
  });
});

describe("login bridge", () => {
  const emails: string[] = [];
  afterEach(async () => {
    for (const email of emails.splice(0)) await db.delete(accounts).where(eq(accounts.email, email));
  });

  test("persists a mocked TypeScript browser result without launching Chromium", async () => {
    const email = `bridge-${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const logs: string[] = [];
    const result = await loginPostmanAccount(email, (entry) => logs.push(entry.msg), {
      login: async (_email, options) => {
        options.onLog?.({ step: "test", msg: "mock login", level: "info", ts: 1 });
        return { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "acme" };
      },
    });
    expect(result.success).toBe(true);
    expect(logs).toContain("mock login");
    expect(logs.some((message) => message.includes("已自动导入账号池"))).toBe(true);
    const [saved] = await db.select().from(accounts).where(eq(accounts.email, email));
    expect(JSON.parse(saved!.tokens as string)).toEqual({
      postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "acme",
    });
  });

  test("returns a mocked login error", async () => {
    const result = await loginPostmanAccount("failure@example.com", undefined, {
      login: async () => ({ postman_sid: "", user_id: "", workspace_id: "", workspace_subdomain: "", error: "cancelled" }),
    });
    expect(result).toEqual({ success: false, error: "cancelled" });
  });

  test("passes signup mode and verifies quota plus Agent availability", async () => {
    const email = `signup-${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const logs: string[] = [];
    let receivedFlow = "";
    let testedAccountId = 0;

    const result = await loginPostmanAccount(undefined, (entry) => logs.push(entry.msg), {
      login: async (_email, options) => {
        receivedFlow = options.flow || "";
        return { email, postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "acme" };
      },
      warmup: async (accountId) => {
        await db.update(accounts).set({
          status: "active",
          quotaLimit: 800,
          quotaRemaining: 700,
        }).where(eq(accounts.id, accountId));
        return { success: true };
      },
      test: async (accountId) => {
        testedAccountId = accountId;
        return { available: true };
      },
    }, "signup");

    expect(result.success).toBe(true);
    expect(receivedFlow).toBe("signup");
    expect(testedAccountId).toBe(result.accountId);
    expect(logs.some((message) => message.includes("剩余 700 / 800 credits"))).toBe(true);
    expect(logs.some((message) => message.includes("Agent Mode 已返回有效响应"))).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { acquireEmailAddress } from "../packages/postman-register/src/selectors/tempMail";
import { Hono } from "hono";
import {
  handleCloseTempEmailPreviewRequest,
  handleOpenTempEmailPreviewRequest,
  handleTempEmailPreviewRequest,
  type TempEmailPreviewService,
} from "../src/api/accounts";
import {
  createTempEmailPreviewWorker,
  TempEmailPreviewSessionManager,
  type TempEmailPreviewWorkerHandle,
} from "../src/auth/temp-email-preview-runtime";

function fakeWorkerProcess(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  return child;
}

function previewService(overrides: Partial<TempEmailPreviewService> = {}): TempEmailPreviewService {
  return {
    create: async () => ({
      sessionId: "11111111-1111-4111-8111-111111111111",
      email: "Preview.User@Example.COM",
      expiresAt: 1_800_000_000_000,
    }),
    focus: async () => true,
    close: async () => true,
    ...overrides,
  };
}

describe("temporary email preview endpoints", () => {
  test("creates a reusable preview session without starting signup", async () => {
    const app = new Hono();
    let calls = 0;
    app.post("/api/accounts/signup/email-preview", (c) => handleTempEmailPreviewRequest(c, previewService({
      create: async () => {
        calls += 1;
        return {
          sessionId: "11111111-1111-4111-8111-111111111111",
          email: " Preview.User@Example.COM ",
          expiresAt: 1_800_000_000_000,
        };
      },
    })));

    const response = await app.request("/api/accounts/signup/email-preview", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      email: "preview.user@example.com",
      expiresAt: 1_800_000_000_000,
    });
    expect(calls).toBe(1);
  });

  test("closes a session whose worker returned an invalid email", async () => {
    const closed: string[] = [];
    const app = new Hono();
    app.post("/api/accounts/signup/email-preview", (c) => handleTempEmailPreviewRequest(c, previewService({
      create: async () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        email: "not-an-email",
        expiresAt: 1_800_000_000_000,
      }),
      close: async (sessionId) => {
        closed.push(sessionId);
        return true;
      },
    })));

    const response = await app.request("/api/accounts/signup/email-preview", { method: "POST" });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "临时邮箱页面未返回有效邮箱地址" });
    expect(closed).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  test("focuses and closes only a matching UUID session", async () => {
    const focused: string[] = [];
    const closed: string[] = [];
    const service = previewService({
      focus: async (sessionId) => { focused.push(sessionId); return true; },
      close: async (sessionId) => { closed.push(sessionId); return true; },
    });
    const app = new Hono();
    app.post("/api/accounts/signup/email-preview/:sessionId/open", (c) => handleOpenTempEmailPreviewRequest(c, service));
    app.delete("/api/accounts/signup/email-preview/:sessionId", (c) => handleCloseTempEmailPreviewRequest(c, service));

    const sessionId = "33333333-3333-4333-8333-333333333333";
    const openResponse = await app.request(`/api/accounts/signup/email-preview/${sessionId}/open`, { method: "POST" });
    const closeResponse = await app.request(`/api/accounts/signup/email-preview/${sessionId}`, { method: "DELETE" });
    const invalidResponse = await app.request("/api/accounts/signup/email-preview/not-a-session/open", { method: "POST" });

    expect(openResponse.status).toBe(200);
    expect(closeResponse.status).toBe(200);
    expect(invalidResponse.status).toBe(404);
    expect(focused).toEqual([sessionId]);
    expect(closed).toEqual([sessionId]);
  });

  test("returns not found after a preview session expires or closes", async () => {
    const app = new Hono();
    const service = previewService({ focus: async () => false, close: async () => false });
    app.post("/api/accounts/signup/email-preview/:sessionId/open", (c) => handleOpenTempEmailPreviewRequest(c, service));
    app.delete("/api/accounts/signup/email-preview/:sessionId", (c) => handleCloseTempEmailPreviewRequest(c, service));

    const sessionId = "44444444-4444-4444-8444-444444444444";
    expect((await app.request(`/api/accounts/signup/email-preview/${sessionId}/open`, { method: "POST" })).status).toBe(404);
    expect((await app.request(`/api/accounts/signup/email-preview/${sessionId}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("temporary email acquisition", () => {
  test("retries an unready page by reloading and then returns the generated address", async () => {
    let bodyText = "Mailbox loading";
    let reloads = 0;
    const field = {
      isVisible: async () => true,
      inputValue: async () => (reloads > 0 ? "retry@example.com" : ""),
      getAttribute: async () => null,
      textContent: async () => null,
    };
    const page = {
      locator: (selector: string) => selector === "body"
        ? { innerText: async () => bodyText }
        : { first: () => field },
      reload: async () => { reloads += 1; bodyText = "Mailbox ready"; },
    };

    const email = await acquireEmailAddress(page as never, {
      attempts: 2,
      attemptTimeout: 1,
      backoffMs: 0,
      reloadTimeout: 100,
    });

    expect(email).toBe("retry@example.com");
    expect(reloads).toBe(1);
  });

  test("does not reload a page that reports an access block", async () => {
    let reloads = 0;
    const field = {
      isVisible: async () => false,
      inputValue: async () => "",
      getAttribute: async () => null,
      textContent: async () => null,
    };
    const page = {
      locator: (selector: string) => selector === "body"
        ? { innerText: async () => "Too many requests" }
        : { first: () => field },
      reload: async () => { reloads += 1; },
    };

    await expect(acquireEmailAddress(page as never, {
      attempts: 3,
      attemptTimeout: 10,
      backoffMs: 0,
    })).rejects.toThrow("页面被阻断");
    expect(reloads).toBe(0);
  });
});

describe("temporary email preview session manager", () => {
  test("waits for the worker to confirm the preview window is focused", async () => {
    const child = fakeWorkerProcess();
    const worker = createTempEmailPreviewWorker({ spawnWorker: () => child, timeoutMs: 1_000 });
    child.stdout.write('TEMP_EMAIL_PREVIEW {"type":"ready","email":"focus@example.com"}\n');
    await worker.ready;

    let focused = false;
    const focus = worker.focus().then(() => { focused = true; });
    await Promise.resolve();
    expect(focused).toBe(false);

    child.stdout.write('TEMP_EMAIL_PREVIEW {"type":"focused"}\n');
    await focus;
    expect(focused).toBe(true);
    child.emit("exit", 0, null);
  });

  test("reuses one active worker, focuses it, and closes it", async () => {
    let workers = 0;
    let focused = 0;
    let closed = 0;
    let exitHandler: (() => void) | undefined;
    const worker: TempEmailPreviewWorkerHandle = {
      ready: Promise.resolve("one@example.com"),
      focus: async () => { focused += 1; },
      close: async () => { closed += 1; exitHandler?.(); },
      onExit: (handler) => { exitHandler = handler; },
    };
    const manager = new TempEmailPreviewSessionManager({
      createWorker: () => { workers += 1; return worker; },
      ttlMs: 60_000,
    });

    const first = await manager.create();
    const second = await manager.create();
    expect(second).toEqual(first);
    expect(workers).toBe(1);
    expect(await manager.focus(first.sessionId)).toBe(true);
    expect(focused).toBe(1);
    expect(await manager.close(first.sessionId)).toBe(true);
    expect(closed).toBe(1);
    expect(await manager.focus(first.sessionId)).toBe(false);
  });

  test("automatically closes an expired worker", async () => {
    let closed = 0;
    const worker: TempEmailPreviewWorkerHandle = {
      ready: Promise.resolve("expires@example.com"),
      focus: async () => undefined,
      close: async () => { closed += 1; },
      onExit: () => undefined,
    };
    const manager = new TempEmailPreviewSessionManager({ createWorker: () => worker, ttlMs: 10 });

    const session = await manager.create();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(closed).toBe(1);
    expect(await manager.focus(session.sessionId)).toBe(false);
  });

  test("closes the worker and releases state when startup fails", async () => {
    let closed = 0;
    const worker: TempEmailPreviewWorkerHandle = {
      ready: Promise.reject(new Error("external page failed")),
      focus: async () => undefined,
      close: async () => { closed += 1; },
      onExit: () => undefined,
    };
    const manager = new TempEmailPreviewSessionManager({ createWorker: () => worker, ttlMs: 60_000 });

    await expect(manager.create()).rejects.toThrow("external page failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });
});

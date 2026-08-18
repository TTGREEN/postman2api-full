import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { createRegistrationRouter } from "../src/api/registration";
import { redactSensitiveMessage, RegistrationRuntime } from "../src/automation-lab/registration-runtime";
import { db } from "../src/db/index";
import { automationJobEvents, automationJobs } from "../src/db/schema";
import { eq } from "drizzle-orm";

function fakeWorker(onInput: (line: string, child: ChildProcessWithoutNullStreams) => void): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      onInput(line, child);
    }
  });
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
  return child;
}

function emit(child: ChildProcessWithoutNullStreams, runId: string, event: Record<string, unknown>): void {
  child.stdout.write("REGISTRATION_WORKER " + JSON.stringify({ type: "event", runId, event }) + "\n");
}

async function removeTestJob(id: string): Promise<void> {
  await db.delete(automationJobEvents).where(eq(automationJobEvents.jobId, id));
  await db.delete(automationJobs).where(eq(automationJobs.id, id));
}

describe("registration runtime persistence", () => {
  test("keeps diagnostic token length metadata while redacting token values", () => {
    const message = redactSensitiveMessage('[Turnstile诊断事件] {"tokenLength":88,"token":"secret"} password=secret');

    expect(message).toContain('"tokenLength":88');
    expect(message).not.toContain('"token":"secret"');
    expect(message).toContain("password=[REDACTED]");
  });

  test("persists worker log entries that use the register logger's step/msg fields", async () => {
    const child = fakeWorker((line, process) => {
      const message = JSON.parse(line) as { type: string; runId: string };
      if (message.type !== "start") return;
      emit(process, message.runId, { type: "log", index: 0, step: "verify", msg: "widget_not_visible", level: "warn" });
      emit(process, message.runId, { type: "batch", status: "success", message: "全部完成" });
    });
    const runtime = new RegistrationRuntime({ spawnWorker: () => child, now: () => 1_800_000_000_000, broadcast: () => {} });

    const started = await runtime.start({ target: "postman", count: 1, retryLimit: 0, mode: "upstream" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = await runtime.readSnapshot(started.id);

      expect(snapshot.events.some((event) => event.message === "widget_not_visible")).toBe(true);
      expect(snapshot.events.some((event) => event.stage === "verify")).toBe(true);
    } finally {
      await removeTestJob(started.id);
    }
  });

  test("persists and redacts worker standard-error output", async () => {
    const child = fakeWorker((line, process) => {
      const message = JSON.parse(line) as { type: string; runId: string };
      if (message.type !== "start") return;
      process.stderr.write("Error: token=secret worker diagnostic\n");
      emit(process, message.runId, { type: "batch", status: "failed", message: "worker failed" });
    });
    const runtime = new RegistrationRuntime({ spawnWorker: () => child, now: () => 1_800_000_000_000, broadcast: () => {} });

    const started = await runtime.start({ target: "postman", count: 1, retryLimit: 0, mode: "upstream" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = await runtime.readSnapshot(started.id);

      const stderr = snapshot.events.find((event) => event.message.startsWith("[Worker stderr]"));
      expect(stderr?.level).toBe("error");
      expect(stderr?.message).toContain("token=[REDACTED]");
      expect(stderr?.message).not.toContain("token=secret");
    } finally {
      await removeTestJob(started.id);
    }
  });

  test("persists upstream stage events and terminal success", async () => {
    const child = fakeWorker((line, process) => {
      const message = JSON.parse(line) as { type: string; runId: string };
      if (message.type !== "start") return;
      emit(process, message.runId, { type: "stage", stage: "tempEmail", index: 0, message: "执行 tempEmail" });
      emit(process, message.runId, { type: "log", index: 0, message: "验证码: 123456 password=secret", level: "info" });
      emit(process, message.runId, { type: "attempt", status: "success", index: 0, attempts: 1, email: "fixture-1@example.test", message: "完成" });
      emit(process, message.runId, { type: "batch", status: "success", message: "全部完成" });
    });
    const runtime = new RegistrationRuntime({ spawnWorker: () => child, now: () => 1_800_000_000_000, broadcast: () => {} });
    const started = await runtime.start({ target: "postman", count: 1, retryLimit: 1, mode: "upstream" });
    try {
      expect(started.status).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = await runtime.readSnapshot(started.id);
      expect(snapshot.status).toBe("success");
      expect(snapshot.completed).toBe(1);
      expect(snapshot.attempts[0]?.status).toBe("success");
      expect(snapshot.events.some((event) => event.stage === "tempEmail")).toBe(true);
      expect(snapshot.events.some((event) => event.message.includes("123456") || event.message.includes("secret"))).toBe(false);
    } finally {
      await removeTestJob(started.id);
    }
  });

  test("persists a terminal temporary-mail quota failure for the task history", async () => {
    const child = fakeWorker((line, process) => {
      const message = JSON.parse(line) as { type: string; runId: string };
      if (message.type !== "start") return;
      emit(process, message.runId, { type: "stage", stage: "tempEmail", index: 0, message: "执行 tempEmail" });
      emit(process, message.runId, {
        type: "error",
        stage: "tempEmail",
        index: 0,
        level: "error",
        message: "临时邮箱阶段失败，已停止重试以避免创建新邮箱：检测到临时邮箱创建额度限制",
      });
      emit(process, message.runId, { type: "attempt", status: "failed", index: 0, attempts: 1, message: "临时邮箱创建额度限制" });
      emit(process, message.runId, { type: "batch", status: "failed", message: "注册任务已结束：临时邮箱创建额度限制" });
    });
    const runtime = new RegistrationRuntime({ spawnWorker: () => child, now: () => 1_800_000_000_000, broadcast: () => {} });

    const started = await runtime.start({ target: "postman", count: 1, retryLimit: 1, mode: "upstream" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snapshot = await runtime.readSnapshot(started.id);

      expect(snapshot.status).toBe("failed");
      expect(snapshot.error).toContain("临时邮箱创建额度限制");
      expect(snapshot.attempts[0]?.status).toBe("failed");
      expect(snapshot.events.some((event) => event.stage === "tempEmail" && event.level === "error" && event.message.includes("创建额度限制"))).toBe(true);
    } finally {
      await removeTestJob(started.id);
    }
  });

  test("restarts a crashed worker from the first incomplete attempt", async () => {
    let spawned = 0;
    const starts: number[] = [];
    const runtime = new RegistrationRuntime({
      spawnWorker: (_jobId, _input, startIndex = 0) => {
        spawned += 1;
        starts.push(startIndex);
        return fakeWorker((line, process) => {
          const message = JSON.parse(line) as { type: string; runId: string; startIndex?: number };
          if (message.type !== "start") return;
          if (spawned === 1) {
            emit(process, message.runId, { type: "attempt", status: "success", index: 0, attempts: 1, email: "one@example.test", message: "完成" });
            emit(process, message.runId, {
              type: "error",
              index: 1,
              level: "error",
              message: "注册 Worker 崩溃诊断：TypeError: Cannot read properties of undefined (reading '_getChildFrames')",
              payload: { fatal: true, resumeFromIndex: 1 },
            });
            emit(process, message.runId, {
              type: "batch",
              status: "failed",
              message: "注册 Worker 异常，将从未完成项恢复",
              payload: { fatal: true, resumeFromIndex: 1 },
            });
            process.stdout.end();
            process.stderr.end();
            process.emit("close", 1, null);
            return;
          }
          expect(message.startIndex).toBe(1);
          emit(process, message.runId, { type: "attempt", status: "success", index: 1, attempts: 1, email: "two@example.test", message: "完成" });
          emit(process, message.runId, { type: "batch", status: "success", message: "全部完成" });
        });
      },
      now: () => 1_800_000_000_000,
      broadcast: () => {},
    });

    const started = await runtime.start({ target: "postman", count: 2, retryLimit: 0, mode: "upstream" });
    try {
      const deadline = Date.now() + 2_000;
      let snapshot = started;
      while (Date.now() < deadline && snapshot.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await runtime.readSnapshot(started.id);
      }

      expect(spawned).toBe(2);
      expect(starts).toEqual([0, 1]);
      expect(snapshot.status).toBe("success");
      expect(snapshot.completed).toBe(2);
      expect(snapshot.attempts.map((attempt) => attempt.status)).toEqual(["success", "success"]);
    } finally {
      await runtime.shutdown();
      await removeTestJob(started.id);
    }
  });

  test("does not rerun a completed attempt when the worker exits during batch finalization", async () => {
    let spawned = 0;
    const runtime = new RegistrationRuntime({
      spawnWorker: () => {
        spawned += 1;
        return fakeWorker((line, process) => {
          const message = JSON.parse(line) as { type: string; runId: string };
          if (message.type !== "start") return;
          emit(process, message.runId, { type: "attempt", status: "success", index: 0, attempts: 1, email: "one@example.test", message: "完成" });
          emit(process, message.runId, {
            type: "batch",
            status: "failed",
            message: "注册 Worker 异常，将从未完成项恢复",
            payload: { fatal: true, resumeFromIndex: 0 },
          });
          process.stdout.end();
          process.stderr.end();
          process.emit("close", 1, null);
        });
      },
      now: () => 1_800_000_000_000,
      broadcast: () => {},
    });

    const started = await runtime.start({ target: "postman", count: 1, retryLimit: 0, mode: "upstream" });
    try {
      const deadline = Date.now() + 2_000;
      let snapshot = started;
      while (Date.now() < deadline && snapshot.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await runtime.readSnapshot(started.id);
      }

      expect(spawned).toBe(1);
      expect(snapshot.status).toBe("success");
      expect(snapshot.completed).toBe(1);
      expect(snapshot.attempts[0]?.status).toBe("success");
    } finally {
      await runtime.shutdown();
      await removeTestJob(started.id);
    }
  });

  test("allows upstream execution when the runtime flag is unset", async () => {
    const runtime = new RegistrationRuntime({
      spawnWorker: () => fakeWorker((line, child) => {
        const message = JSON.parse(line) as { type: string; runId: string };
        if (message.type === "start") emit(child, message.runId, { type: "batch", status: "success", message: "fixture complete" });
      }),
      broadcast: () => {},
    });
    const previous = process.env.ENABLE_EXTERNAL_AUTOMATION;
    delete process.env.ENABLE_EXTERNAL_AUTOMATION;
    try {
      const started = await runtime.start({ target: "postman", count: 1, retryLimit: 0, mode: "upstream" });
      expect(started.status).toBe("running");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await removeTestJob(started.id);
    } finally {
      if (previous === undefined) delete process.env.ENABLE_EXTERNAL_AUTOMATION;
      else process.env.ENABLE_EXTERNAL_AUTOMATION = previous;
    }
  });

  test("exposes list and detail routes", async () => {
    const runtime = new RegistrationRuntime({ spawnWorker: () => fakeWorker(() => {}), broadcast: () => {} });
    const app = createRegistrationRouter(runtime);
    const list = await app.request("/");
    expect(list.status).toBe(200);
    expect((await list.json() as { data: unknown[] }).data).toBeArray();
  });


  test("keeps active upstream jobs visible when newer history rows exist", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const upstreamId = `refresh-upstream-${suffix}`;
    const historyId = `refresh-history-${suffix}`;
    const oldTime = new Date(1_700_000_000_000);
    const newerHistoryTime = new Date(1_900_000_000_000);
    await db.insert(automationJobs).values({
      id: historyId,
      kind: "registration",
      mode: "upstream",
      target: "postman",
      status: "success",
      requested: 1,
      completed: 1,
      retryLimit: 1,
      input: JSON.stringify({ target: "postman", count: 1, retryLimit: 1, mode: "upstream" }),
      createdAt: newerHistoryTime,
      updatedAt: newerHistoryTime,
      finishedAt: newerHistoryTime,
    });
    await db.insert(automationJobs).values({
      id: upstreamId,
      kind: "registration",
      mode: "upstream",
      target: "postman",
      status: "running",
      requested: 1,
      completed: 0,
      retryLimit: 1,
      input: JSON.stringify({ target: "postman", count: 1, retryLimit: 1, mode: "upstream" }),
      createdAt: oldTime,
      updatedAt: oldTime,
      startedAt: oldTime,
    });
    try {
      const runtime = new RegistrationRuntime({ spawnWorker: () => fakeWorker(() => {}), broadcast: () => {} });
      const app = createRegistrationRouter(runtime);
      const response = await app.request("/?mode=upstream&limit=1");
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string; mode: string; status: string }> };

      expect(body.data.some((job) => job.id === upstreamId && job.status === "running")).toBe(true);
      expect(body.data.every((job) => job.mode === "upstream")).toBe(true);
      expect(body.data.some((job) => job.id === historyId && job.status === "success")).toBe(true);
    } finally {
      await db.delete(automationJobEvents).where(eq(automationJobEvents.jobId, upstreamId));
      await db.delete(automationJobs).where(eq(automationJobs.id, upstreamId));
      await db.delete(automationJobs).where(eq(automationJobs.id, historyId));
    }
  });
  test("converges orphaned queued/running jobs after a process restart", async () => {
    const id = `orphan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date(1_800_000_000_000);
    await db.insert(automationJobs).values({
      id,
      kind: "registration",
      mode: "upstream",
      target: "postman",
      status: "running",
      requested: 1,
      completed: 0,
      retryLimit: 1,
      input: JSON.stringify({ target: "postman", count: 1, retryLimit: 1, mode: "upstream" }),
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    });
    try {
      const runtime = new RegistrationRuntime({ now: () => 1_800_000_010_000, broadcast: () => {} });
      await expect(runtime.recoverOrphanedJobs()).resolves.toBeGreaterThanOrEqual(1);
      const [row] = await db.select().from(automationJobs).where(eq(automationJobs.id, id)).limit(1);
      expect(row?.status).toBe("failed");
      expect(row?.errorMessage).toContain("服务重启");
      expect(row?.finishedAt?.getTime()).toBe(1_800_000_010_000);
    } finally {
      await db.delete(automationJobs).where(eq(automationJobs.id, id));
    }
  });
});

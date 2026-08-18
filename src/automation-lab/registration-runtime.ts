import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { automationJobEvents, automationJobs } from "../db/schema";
import { broadcast } from "../ws";
import { config } from "../config";
import { persistPostmanToken } from "../auth/account-persistence";
import { upstreamAutomationEnabled } from "./upstream-registration";
import {
  parseRegistrationJobInput,
  type RegistrationJobEvent,
  type RegistrationJobInput,
  type RegistrationJobMode,
  type RegistrationJobSnapshot,
  type RegistrationJobStatus,
  type RegistrationJobAttempt,
  type UpstreamRegistrationStage,
} from "./registration-types";

const MARKER = "REGISTRATION_WORKER ";
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const MAX_EVENTS = 400;
const MAX_WORKER_RECOVERIES = 2;

interface WorkerRecoveryRequest {
  resumeFromIndex: number;
  reason: string;
}

export class RegistrationJobBusyError extends Error {
  constructor() {
    super("已有注册自动化任务正在运行");
    this.name = "RegistrationJobBusyError";
  }
}

interface ActiveJob {
  id: string;
  child: ChildProcessWithoutNullStreams;
  lines: ReturnType<typeof createInterface>;
  stderrLines: ReturnType<typeof createInterface>;
  terminal: boolean;
  stopping: boolean;
  childClosed: boolean;
  stdoutClosed: boolean;
  stderrClosed: boolean;
  closeCode: number | null;
  stderrTail: string[];
  stopPromise?: Promise<void>;
  resolveStop?: () => void;
  stopTimer?: ReturnType<typeof setTimeout>;
  eventQueue: Promise<void>;
  input: RegistrationJobInput;
  recoveryAttempts: number;
  recovery?: WorkerRecoveryRequest;
  finalizing: boolean;
}

export interface RegistrationRuntimeDependencies {
  spawnWorker?: (jobId: string, input: RegistrationJobInput, startIndex?: number) => ChildProcessWithoutNullStreams;
  broadcast?: (message: Record<string, unknown>) => void;
  now?: () => number;
  stopTimeoutMs?: number;
}

export interface RegistrationListOptions {
  limit?: number;
  mode?: RegistrationJobMode;
}

function allowedWorkerEnv(input: RegistrationJobInput): NodeJS.ProcessEnv {
  const names = [
    "PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "HOME",
    "CAMOUFOX_INSTALL_DIR", "PLAYWRIGHT_BROWSERS_PATH", "POSTMAN_PROXY", "POSTMAN_GEOIP", "POSTMAN_CF_TIMEOUT",
  ];
  // Camoufox otherwise retries a default uBlock download on every Worker boot.
  // The browser is already provisioned locally; registration must not depend on that add-on host.
  const env: NodeJS.ProcessEnv = { DATABASE_PATH: config.databasePath, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (input.mode === "upstream") env.ENABLE_EXTERNAL_AUTOMATION = "1";
  if (input.headless) env.POSTMAN_HEADLESS = "1";
  return env;
}

function spawnRegistrationWorker(jobId: string, input: RegistrationJobInput, startIndex = 0): ChildProcessWithoutNullStreams {
  const node = process.env.AUTOMATION_LAB_NODE_PATH?.trim() || (typeof Bun === "undefined" ? process.execPath : Bun.which("node")) || "node";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return spawn(node, ["--import", "tsx", path.join(root, "scripts", "workers", "registration-worker.ts")], {
    cwd: root,
    env: allowedWorkerEnv(input),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function initialAttempts(count: number): RegistrationJobAttempt[] {
  return Array.from({ length: count }, (_, index) => ({ index, status: "pending", attempts: 0 }));
}

function parseJson(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

function eventEntry(event: Record<string, unknown>): Record<string, unknown> {
  const nested = event.entry;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
}

export function redactSensitiveMessage(value: string): string {
  return value
    .replace(/\b(password|密码)\b\s*[:=：]?\s*[^\s,，;；]+/gi, "$1=[REDACTED]")
    .replace(/((?:验证码|verification\s*code|otp|code))\s*[:=：]?\s*\d{4,8}/gi, "$1=[REDACTED]")
    .replace(/\b(postman_sid|token|cookie)\b\s*[:=：]?\s*[^\s,，;；]+/gi, "$1=[REDACTED]");
}

function toEvent(row: typeof automationJobEvents.$inferSelect, jobId: string): RegistrationJobEvent {
  const payload = parseJson(row.payload);
  return {
    jobId,
    seq: row.seq,
    type: row.type as RegistrationJobEvent["type"],
    status: typeof payload?.status === "string" ? payload.status as RegistrationJobEvent["status"] : undefined,
    stage: row.stage as UpstreamRegistrationStage | undefined,
    index: row.attemptIndex ?? undefined,
    attemptIndex: row.attemptIndex ?? undefined,
    level: row.level as RegistrationJobEvent["level"],
    message: row.message,
    ts: row.createdAt?.getTime() ?? Date.now(),
    payload,
  };
}

function snapshotFromRow(
  row: typeof automationJobs.$inferSelect,
  events: RegistrationJobEvent[],
): RegistrationJobSnapshot {
  const input = (() => { try { return JSON.parse(row.input) as RegistrationJobInput; } catch { return { target: row.target, count: row.requested, retryLimit: row.retryLimit, mode: row.mode as RegistrationJobInput["mode"] }; } })();
  const attempts = initialAttempts(row.requested);
  for (const event of events) {
    if (event.index == null) continue;
    const attempt = attempts[event.index];
    if (!attempt) continue;
    if (event.type === "stage") {
      attempt.status = "running";
      attempt.stage = event.stage;
    } else if (event.type === "account") {
      const accountId = event.payload?.accountId;
      if (typeof accountId === "number") attempt.accountId = accountId;
      const tokenEmail = event.payload?.email;
      if (typeof tokenEmail === "string") attempt.email = tokenEmail;
    } else if (event.type === "attempt") {
      const status = event.status ?? (event.payload?.status as RegistrationJobAttempt["status"] | undefined);
      if (status === "running" || status === "success" || status === "failed" || status === "stopped") attempt.status = status;
      if (typeof event.payload?.attempts === "number") attempt.attempts = event.payload.attempts;
      if (typeof event.payload?.email === "string") attempt.email = event.payload.email;
      if (typeof event.payload?.accountId === "number") attempt.accountId = event.payload.accountId;
      if (typeof event.payload?.error === "string") attempt.error = event.payload.error;
    }
  }
  return {
    id: row.id,
    kind: "registration",
    target: row.target,
    mode: input.mode,
    status: row.status as RegistrationJobStatus,
    requested: row.requested,
    completed: row.completed,
    retryLimit: row.retryLimit,
    attempts,
    events,
    ...(row.errorMessage ? { error: row.errorMessage } : {}),
    createdAt: row.createdAt?.getTime() ?? Date.now(),
    updatedAt: row.updatedAt?.getTime() ?? Date.now(),
    ...(row.startedAt ? { startedAt: row.startedAt.getTime() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.getTime() } : {}),
  };
}

export class RegistrationRuntime {
  private readonly spawnWorker: typeof spawnRegistrationWorker;
  private readonly publishMessage: (message: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly stopTimeoutMs: number;
  private readonly active = new Map<string, ActiveJob>();

  constructor(dependencies: RegistrationRuntimeDependencies = {}) {
    this.spawnWorker = dependencies.spawnWorker ?? spawnRegistrationWorker;
    this.publishMessage = dependencies.broadcast ?? broadcast;
    this.now = dependencies.now ?? Date.now;
    this.stopTimeoutMs = dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  /**
   * A process restart severs the child-worker handle, so queued/running rows
   * from the previous process cannot make progress or be stopped in memory.
   * Converge those rows to a retryable terminal state while retaining events.
   */
  async recoverOrphanedJobs(): Promise<number> {
    const orphaned = await db
      .select({ id: automationJobs.id })
      .from(automationJobs)
      .where(inArray(automationJobs.status, ["queued", "running"]));
    if (orphaned.length === 0) return 0;

    const now = new Date(this.now());
    const ids = orphaned.map((row) => row.id);
    await db.update(automationJobs).set({
      status: "failed",
      errorMessage: "服务重启，任务未自动恢复，请重试",
      updatedAt: now,
      finishedAt: now,
    }).where(inArray(automationJobs.id, ids));

    for (const id of ids) this.publish(await this.readSnapshot(id));
    return ids.length;
  }

  async list(options: number | RegistrationListOptions = 20): Promise<RegistrationJobSnapshot[]> {
    const limit = typeof options === "number" ? options : options.limit ?? 20;
    const mode = typeof options === "number" ? undefined : options.mode;
    const boundedLimit = Math.min(Math.max(limit, 1), 100);
    const modeFilter = mode ? eq(automationJobs.mode, mode) : undefined;
    const activeFilter = modeFilter
      ? and(modeFilter, inArray(automationJobs.status, ["queued", "running"]))
      : inArray(automationJobs.status, ["queued", "running"]);
    const [activeRows, recentRows] = await Promise.all([
      db.select().from(automationJobs).where(activeFilter).orderBy(desc(automationJobs.updatedAt)).limit(100),
      modeFilter
        ? db.select().from(automationJobs).where(modeFilter).orderBy(desc(automationJobs.updatedAt)).limit(boundedLimit)
        : db.select().from(automationJobs).orderBy(desc(automationJobs.updatedAt)).limit(boundedLimit),
    ]);
    const byId = new Map<string, typeof automationJobs.$inferSelect>();
    for (const row of [...activeRows, ...recentRows]) byId.set(row.id, row);
    const rows = [...byId.values()].sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    return Promise.all(rows.map((row) => this.readSnapshot(row.id)));
  }

  async readSnapshot(id: string): Promise<RegistrationJobSnapshot> {
    const [row] = await db.select().from(automationJobs).where(eq(automationJobs.id, id)).limit(1);
    if (!row) throw new Error("注册任务不存在");
    const events = await db
      .select()
      .from(automationJobEvents)
      .where(eq(automationJobEvents.jobId, id))
      .orderBy(desc(automationJobEvents.seq))
      .limit(MAX_EVENTS);
    return snapshotFromRow(row, events.reverse().map((event) => toEvent(event, id)));
  }

  async start(rawInput: unknown): Promise<RegistrationJobSnapshot> {
    const input = parseRegistrationJobInput(rawInput);
    if (input.mode === "upstream" && !upstreamAutomationEnabled()) {
      throw new Error("真实浏览器注册未启用，请设置 ENABLE_EXTERNAL_AUTOMATION=1 后重试");
    }
    if ([...this.active.values()].some((job) => !job.terminal)) throw new RegistrationJobBusyError();
    const id = randomUUID();
    const now = new Date(this.now());
    await db.insert(automationJobs).values({
      id, kind: "registration", mode: input.mode, target: input.target, status: "queued",
      requested: input.count, completed: 0, retryLimit: input.retryLimit, input: JSON.stringify(input), createdAt: now, updatedAt: now,
    });
    const snapshot = await this.readSnapshot(id);
    this.publish(snapshot);
    let child: ChildProcessWithoutNullStreams;
    try { child = this.spawnWorker(id, input, 0); } catch (error) {
      await this.updateJob(id, "failed", error instanceof Error ? error.message : String(error));
      return this.readSnapshot(id);
    }
    const active: ActiveJob = {
      id,
      child,
      lines: createInterface({ input: child.stdout }),
      stderrLines: createInterface({ input: child.stderr }),
      terminal: false,
      stopping: false,
      childClosed: false,
      stdoutClosed: false,
      stderrClosed: false,
      closeCode: null,
      stderrTail: [],
      eventQueue: Promise.resolve(),
      input,
      recoveryAttempts: 0,
      finalizing: false,
    };
    this.active.set(id, active);
    this.attachWorker(active, child, 0, false);
    await this.updateJob(id, "running");
    return this.readSnapshot(id);
  }

  async retry(id: string): Promise<RegistrationJobSnapshot> {
    const previous = await this.readSnapshot(id);
    if (previous.status === "running" || previous.status === "queued") throw new RegistrationJobBusyError();
    return this.start({ target: previous.target, count: previous.requested, retryLimit: previous.retryLimit, mode: previous.mode });
  }

  async stop(id: string): Promise<RegistrationJobSnapshot> {
    const active = this.active.get(id);
    if (!active || active.terminal) return this.readSnapshot(id);
    if (!active.stopPromise) {
      active.stopping = true;
      active.stopPromise = new Promise<void>((resolve) => { active.resolveStop = resolve; });
      active.stopTimer = setTimeout(() => {
        if (active.terminal) return;
        if (active.child.exitCode === null && active.child.signalCode === null) active.child.kill();
        void this.finish(active, "stopped", "注册任务已停止");
      }, this.stopTimeoutMs);
      try { active.child.stdin.write(JSON.stringify({ type: "stop", runId: id }) + "\n"); } catch { void this.finish(active, "stopped", "注册任务已停止"); }
    }
    await active.stopPromise;
    return this.readSnapshot(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.stop(id).catch(() => undefined)));
  }

  private attachWorker(
    active: ActiveJob,
    child: ChildProcessWithoutNullStreams,
    startIndex: number,
    createStreams = true,
  ): void {
    active.child = child;
    if (createStreams) {
      active.lines = createInterface({ input: child.stdout });
      active.stderrLines = createInterface({ input: child.stderr });
    }
    active.childClosed = false;
    active.stdoutClosed = false;
    active.stderrClosed = false;
    active.closeCode = null;
    active.finalizing = false;
    active.lines.on("line", (line) => this.handleLine(active, line));
    active.lines.once("close", () => {
      active.stdoutClosed = true;
      this.finalizeAfterDrain(active);
    });
    active.stderrLines.on("line", (line) => this.handleStderr(active, line));
    active.stderrLines.once("close", () => {
      active.stderrClosed = true;
      this.finalizeAfterDrain(active);
    });
    child.once("error", () => {
      // The close event is still the single finalization gate; this avoids
      // racing the last stdout protocol frames after a spawn error.
      active.closeCode = 1;
    });
    child.once("close", (code) => {
      active.childClosed = true;
      active.closeCode = code;
      this.finalizeAfterDrain(active);
    });
    try {
      child.stdin.write(JSON.stringify({ type: "start", runId: active.id, input: active.input, startIndex }) + "\n");
    } catch (error) {
      active.closeCode = 1;
      active.stderrTail = [...active.stderrTail, error instanceof Error ? error.message : String(error)].slice(-12);
    }
  }

  private handleLine(active: ActiveJob, line: string): void {
    if (active.terminal || !line.startsWith(MARKER)) return;
    try {
      const message = JSON.parse(line.slice(MARKER.length)) as { type?: string; runId?: string; event?: Record<string, unknown> };
      if (message.type !== "event" || message.runId !== active.id || !message.event) return;
      active.eventQueue = active.eventQueue
        .then(() => this.handleEvent(active, message.event!))
        .catch(() => this.finish(active, "failed", "注册 Worker 事件处理失败"));
    } catch { /* Ignore non-protocol worker output. */ }
  }

  private finalizeAfterDrain(active: ActiveJob): void {
    if (active.terminal || active.finalizing || !active.childClosed || !active.stdoutClosed || !active.stderrClosed) return;
    active.finalizing = true;
    void active.eventQueue.then(() => {
      if (active.terminal) return;
      if (active.stopping) {
        void this.finish(active, "stopped", "注册任务已停止");
        return;
      }
      if (active.recovery) {
        const recovery = active.recovery;
        active.recovery = undefined;
        void this.restartWorker(active, recovery);
        return;
      }
      void this.finish(active, "failed", this.workerExitMessage(active));
    });
  }

  private async firstIncompleteIndex(active: ActiveJob): Promise<number> {
    const events = await db
      .select({ type: automationJobEvents.type, attemptIndex: automationJobEvents.attemptIndex, payload: automationJobEvents.payload })
      .from(automationJobEvents)
      .where(eq(automationJobEvents.jobId, active.id))
      .orderBy(automationJobEvents.seq);
    const completed = new Set<number>();
    for (const event of events) {
      if (event.type !== "attempt" || event.attemptIndex == null) continue;
      const payload = parseJson(event.payload);
      if (payload?.status === "success") completed.add(event.attemptIndex);
    }
    for (let index = 0; index < active.input.count; index += 1) {
      if (!completed.has(index)) return index;
    }
    return active.input.count;
  }

  private async restartWorker(active: ActiveJob, recovery: WorkerRecoveryRequest): Promise<void> {
    if (active.terminal) return;
    if (active.recoveryAttempts >= MAX_WORKER_RECOVERIES) {
      await this.finish(active, "failed", `注册 Worker 连续崩溃，已停止恢复：${recovery.reason}`);
      return;
    }
    const resumeFromIndex = Math.max(0, Math.min(active.input.count - 1, recovery.resumeFromIndex));
    active.recoveryAttempts += 1;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnWorker(active.id, active.input, resumeFromIndex);
    } catch (error) {
      await this.finish(active, "failed", `注册 Worker 恢复启动失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.attachWorker(active, child, resumeFromIndex);
    await this.updateJob(active.id, "running", undefined, active);
    this.publish(await this.readSnapshot(active.id));
  }

  private handleStderr(active: ActiveJob, line: string): void {
    const message = line.trim();
    if (!message) return;
    active.stderrTail = [...active.stderrTail, message].slice(-12);
    active.eventQueue = active.eventQueue
      .then(() => this.handleEvent(active, {
        type: "log",
        stage: "worker",
        level: "error",
        message: `[Worker stderr] ${message}`,
      }))
      .catch(() => this.finish(active, "failed", "注册 Worker 标准错误处理失败"));
  }

  private workerExitMessage(active: ActiveJob): string {
    const suffix = active.stderrTail.at(-1);
    const exit = active.closeCode === null ? "未知" : String(active.closeCode);
    const base = active.closeCode === 0
      ? `注册 Worker 提前结束（退出码 ${exit}）`
      : `注册 Worker 异常退出（退出码 ${exit}）`;
    return suffix ? `${base}：${redactSensitiveMessage(suffix).slice(0, 360)}` : base;
  }

  private async handleEvent(active: ActiveJob, event: Record<string, unknown>): Promise<void> {
    if (active.terminal) return;
    const type = typeof event.type === "string" ? event.type : "log";
    const index = typeof event.index === "number" ? event.index : undefined;
    const entry = eventEntry(event);
    const stageValue = typeof event.stage === "string"
      ? event.stage
      : typeof event.step === "string"
        ? event.step
        : entry.step;
    const stage = typeof stageValue === "string" ? stageValue : undefined;
    const levelValue = event.level ?? entry.level;
    const level = levelValue === "success" || levelValue === "warn" || levelValue === "error" ? levelValue : "info";
    const messageValue = typeof event.message === "string"
      ? event.message
      : typeof event.msg === "string"
        ? event.msg
        : typeof entry.msg === "string"
          ? entry.msg
          : undefined;
    const message = redactSensitiveMessage(messageValue?.slice(0, 500) ?? "注册任务进度更新");
    const rawPayload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : undefined;
    const payload: Record<string, unknown> | undefined = rawPayload ? { ...rawPayload } : undefined;
    if (type === "attempt") {
      const attemptPayload = payload ?? {};
      if (typeof event.status === "string") attemptPayload.status = event.status;
      if (typeof event.attempts === "number") attemptPayload.attempts = event.attempts;
      if (typeof event.email === "string") attemptPayload.email = event.email;
      if (typeof event.error === "string") attemptPayload.error = event.error;
      event.payload = attemptPayload;
    }
    if (type === "account" && payload) {
      const token = payload as any;
      if (typeof token.email === "string" && token.tokens && typeof token.password === "string") {
        try {
          const accountId = await persistPostmanToken(token);
          event.payload = { accountId, email: token.email };
        } catch (error) {
          event.type = "error";
          event.message = error instanceof Error ? error.message : String(error);
          event.level = "error";
          event.payload = { email: token.email };
        }
      }
    }
    const [lastEvent] = await db
      .select({ seq: automationJobEvents.seq })
      .from(automationJobEvents)
      .where(eq(automationJobEvents.jobId, active.id))
      .orderBy(desc(automationJobEvents.seq))
      .limit(1);
    const seq = (lastEvent?.seq ?? 0) + 1;
    if (active.terminal) return;
    const createdAt = new Date(this.now());
    await db.insert(automationJobEvents).values({
      jobId: active.id, seq, type: typeof event.type === "string" ? event.type : "log", stage,
      attemptIndex: index, level: typeof event.level === "string" ? event.level : level, message,
      payload: event.payload ? JSON.stringify(event.payload) : undefined, createdAt,
    });
    if (event.type === "batch" && (event.status === "success" || event.status === "failed" || event.status === "stopped")) {
      const fatal = event.status === "failed" && payload?.fatal === true;
      if (fatal && active.recoveryAttempts < MAX_WORKER_RECOVERIES) {
        const requestedIndex = typeof payload?.resumeFromIndex === "number" ? payload.resumeFromIndex : 0;
        const firstIncomplete = await this.firstIncompleteIndex(active);
        if (firstIncomplete >= active.input.count) {
          // All attempts have already reached durable success. A crash between
          // the final attempt event and the normal batch-success event must not
          // repeat the final registration.
          await this.handleEvent(active, {
            type: "batch",
            status: "success",
            message: "注册任务全部完成（Worker 在收尾阶段退出，未重复执行）",
            payload: { recoveredFromFatalWorker: true },
          });
          return;
        }
        active.recovery = {
          resumeFromIndex: Math.max(firstIncomplete, requestedIndex),
          reason: message,
        };
        await this.updateJob(active.id, "running", undefined, active);
        this.publish(await this.readSnapshot(active.id));
        return;
      }
      await this.finish(active, event.status, event.status === "failed" ? message : undefined);
      return;
    }
    if (active.terminal) return;
    await this.updateJob(active.id, "running", undefined, active);
    if (active.terminal) return;
    this.publish(await this.readSnapshot(active.id));
  }

  private async updateJob(id: string, status: RegistrationJobStatus, errorMessage?: string, active?: ActiveJob): Promise<void> {
    if (status === "running" && active?.terminal) return;
    const events = await db.select().from(automationJobEvents).where(eq(automationJobEvents.jobId, id)).orderBy(automationJobEvents.seq);
    if (status === "running" && active?.terminal) return;
    const completed = events.filter((event) => {
      if (event.type !== "attempt" || !event.payload) return false;
      const payload = parseJson(event.payload);
      return payload?.status === "success";
    }).length;
    const now = new Date(this.now());
    const where = status === "running"
      ? and(eq(automationJobs.id, id), inArray(automationJobs.status, ["queued", "running"]))
      : eq(automationJobs.id, id);
    await db.update(automationJobs).set({ status, completed, updatedAt: now, ...(errorMessage ? { errorMessage } : {}), ...(status === "running" ? { startedAt: now } : {}), ...(status === "success" || status === "failed" || status === "stopped" ? { finishedAt: now } : {}) }).where(where);
  }

  private async finish(active: ActiveJob, status: RegistrationJobStatus, error?: string): Promise<void> {
    if (active.terminal) return;
    active.terminal = true;
    if (active.stopTimer) clearTimeout(active.stopTimer);
    active.lines.close();
    active.stderrLines.close();
    this.active.delete(active.id);
    await this.updateJob(active.id, status, error);
    this.publish(await this.readSnapshot(active.id));
    active.resolveStop?.();
  }

  private publish(snapshot: RegistrationJobSnapshot): void {
    this.publishMessage({ type: "registration_job_update", data: snapshot });
  }
}

export const registrationRuntime = new RegistrationRuntime();

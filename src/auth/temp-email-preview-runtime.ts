import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_MARKER = "TEMP_EMAIL_PREVIEW ";
const WORKER_START_TIMEOUT_MS = 60_000;
const WORKER_FOCUS_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_TTL_MS = 10 * 60_000;

function allowedWorkerEnv(previewUrl?: string): NodeJS.ProcessEnv {
  const names = [
    "PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "HOME",
    "CAMOUFOX_INSTALL_DIR", "PLAYWRIGHT_BROWSERS_PATH",
  ];
  const env: NodeJS.ProcessEnv = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (previewUrl) env.TEMP_EMAIL_PREVIEW_URL = previewUrl;
  return env;
}

function spawnPreviewWorker(headless = false, previewUrl?: string): ChildProcessWithoutNullStreams {
  const nodeExecutable = process.env.CAMOUFOX_NODE_PATH?.trim()
    || (typeof Bun === "undefined" ? process.execPath : Bun.which("node"))
    || "node";
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workerPath = path.join(projectRoot, "scripts", "workers", "temp-email-preview-worker.ts");
  return spawn(nodeExecutable, ["--import", "tsx", workerPath, ...(headless ? ["--headless"] : [])], {
    cwd: projectRoot,
    env: allowedWorkerEnv(previewUrl),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

export interface TempEmailPreviewWorkerHandle {
  ready: Promise<string>;
  focus: () => Promise<void>;
  close: () => Promise<void>;
  onExit: (handler: () => void) => void;
}

export function createTempEmailPreviewWorker(
  options: {
    spawnWorker?: () => ChildProcessWithoutNullStreams;
    timeoutMs?: number;
    headless?: boolean;
    previewUrl?: string;
  } = {},
): TempEmailPreviewWorkerHandle {
  const child = (options.spawnWorker ?? (() => spawnPreviewWorker(options.headless, options.previewUrl)))();
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  let exitHandler: (() => void) | undefined;
  let closed = false;
  let pendingFocus: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });

  const settleFocus = (error?: Error) => {
    if (!pendingFocus) return;
    const operation = pendingFocus;
    pendingFocus = null;
    clearTimeout(operation.timeout);
    if (error) operation.reject(error);
    else operation.resolve();
  };

  const ready = new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Temporary email preview worker timed out")),
      options.timeoutMs ?? WORKER_START_TIMEOUT_MS,
    );
    const finish = (error?: Error, email?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(new Error(`${error.message}${stderr ? `; worker stderr: ${stderr.trim()}` : ""}`));
      else resolve(email!);
    };

    lines.on("line", (line) => {
      if (!line.startsWith(WORKER_MARKER)) return;
      try {
        const message = JSON.parse(line.slice(WORKER_MARKER.length)) as {
          type?: string;
          email?: string;
          error?: string;
        };
        if (message.type === "ready" && message.email) finish(undefined, message.email);
        if (message.type === "error") finish(new Error(message.error || "Temporary email preview failed"));
        if (message.type === "focused") settleFocus();
        if (message.type === "focus_error") {
          settleFocus(new Error(message.error || "Temporary email preview window could not be focused"));
        }
      } catch {
        finish(new Error("Temporary email preview worker returned invalid data"));
      }
    });
    child.once("error", finish);
    child.once("exit", (code) => {
      closed = true;
      lines.close();
      if (!settled) finish(new Error(`Temporary email preview worker exited with code ${code ?? "unknown"}`));
      settleFocus(new Error("Temporary email preview worker exited before focusing the window"));
      exitHandler?.();
    });
  });

  const send = (type: "focus" | "close") => {
    if (closed || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write(`${JSON.stringify({ type })}\n`);
  };

  return {
    ready,
    focus: () => {
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        return Promise.reject(new Error("Temporary email preview worker is not running"));
      }
      if (pendingFocus) return pendingFocus.promise;
      let resolveFocus!: () => void;
      let rejectFocus!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolveFocus = resolve;
        rejectFocus = reject;
      });
      pendingFocus = {
        promise,
        resolve: resolveFocus,
        reject: rejectFocus,
        timeout: setTimeout(
          () => settleFocus(new Error("Temporary email preview window focus timed out")),
          WORKER_FOCUS_TIMEOUT_MS,
        ),
      };
      send("focus");
      return promise;
    },
    close: async () => {
      if (closed) return;
      send("close");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          resolve();
        }, 3_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    onExit: (handler) => {
      exitHandler = handler;
      if (closed) handler();
    },
  };
}

export interface TempEmailPreviewSession {
  sessionId: string;
  email: string;
  expiresAt: number;
}

interface ActiveSession extends TempEmailPreviewSession {
  worker: TempEmailPreviewWorkerHandle;
  expiration: ReturnType<typeof setTimeout>;
}

export interface TempEmailPreviewSessionManagerDependencies {
  createWorker?: () => TempEmailPreviewWorkerHandle;
  ttlMs?: number;
  now?: () => number;
}

export class TempEmailPreviewSessionManager {
  private readonly createWorker: () => TempEmailPreviewWorkerHandle;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private active: ActiveSession | null = null;
  private creating: Promise<TempEmailPreviewSession> | null = null;

  constructor(dependencies: TempEmailPreviewSessionManagerDependencies = {}) {
    this.createWorker = dependencies.createWorker ?? (() => createTempEmailPreviewWorker());
    this.ttlMs = dependencies.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = dependencies.now ?? Date.now;
  }

  create(): Promise<TempEmailPreviewSession> {
    if (this.active) return Promise.resolve(this.publicSession(this.active));
    if (this.creating) return this.creating;
    this.creating = this.startSession().finally(() => { this.creating = null; });
    return this.creating;
  }

  async focus(sessionId: string): Promise<boolean> {
    if (!this.active || this.active.sessionId !== sessionId) return false;
    await this.active.worker.focus();
    return true;
  }

  async close(sessionId: string): Promise<boolean> {
    if (!this.active || this.active.sessionId !== sessionId) return false;
    const session = this.active;
    this.active = null;
    clearTimeout(session.expiration);
    await session.worker.close();
    return true;
  }

  async closeAll(): Promise<void> {
    if (this.active) await this.close(this.active.sessionId);
  }

  private async startSession(): Promise<TempEmailPreviewSession> {
    const worker = this.createWorker();
    try {
      const email = await worker.ready;
      const sessionId = randomUUID();
      const expiresAt = this.now() + this.ttlMs;
      const expiration = setTimeout(() => { void this.close(sessionId); }, this.ttlMs);
      this.active = { sessionId, email, expiresAt, worker, expiration };
      worker.onExit(() => {
        if (this.active?.sessionId !== sessionId) return;
        clearTimeout(this.active.expiration);
        this.active = null;
      });
      return this.publicSession(this.active);
    } catch (error) {
      await worker.close().catch(() => undefined);
      throw error;
    }
  }

  private publicSession(session: ActiveSession): TempEmailPreviewSession {
    return { sessionId: session.sessionId, email: session.email, expiresAt: session.expiresAt };
  }
}

export const tempEmailPreviewSessions = new TempEmailPreviewSessionManager();

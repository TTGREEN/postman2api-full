import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import {
  loginPostman,
  type LoginLogEntry,
  type PostmanLoginOptions,
  type PostmanLoginResult,
  isSignupCompletionConfirmed,
} from "./postman-login";

export interface PostmanLoginRuntimeDependencies {
  runtime?: "bun" | "node";
  backend?: "playwright" | "camoufox";
  directRunner?: (accountLabel: string | undefined, options: PostmanLoginOptions) => Promise<PostmanLoginResult>;
  workerRunner?: (accountLabel: string | undefined, options: PostmanLoginOptions) => Promise<PostmanLoginResult>;
}

export function describeWorkerExit(code: number | null, signal: NodeJS.Signals | null): string {
  const signalDetail = signal ? `, signal ${signal}` : "";
  return `Postman login worker exited with code ${code ?? "unknown"}${signalDetail}`;
}

function detectRuntime(): "bun" | "node" {
  return typeof Bun === "undefined" ? "node" : "bun";
}

function allowedWorkerEnv(): NodeJS.ProcessEnv {
  const names = [
    "PATH", "SystemRoot", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH", "HOME",
    "CAMOUFOX_INSTALL_DIR", "PLAYWRIGHT_BROWSERS_PATH",
  ];
  const env: NodeJS.ProcessEnv = { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function spawnNodeWorker(...args: string[]): ChildProcessWithoutNullStreams {
  const nodeExecutable = process.env.CAMOUFOX_NODE_PATH?.trim()
    || (typeof Bun === "undefined" ? process.execPath : Bun.which("node"))
    || "node";
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const workerPath = path.join(projectRoot, "scripts", "workers", "postman-login-worker.ts");
  return spawn(nodeExecutable, ["--import", "tsx", workerPath, ...args], {
    cwd: projectRoot,
    env: allowedWorkerEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function runDirectly(
  accountLabel: string | undefined,
  options: PostmanLoginOptions,
): Promise<PostmanLoginResult> {
  return loginPostman(accountLabel, options);
}

async function runInNodeWorker(
  accountLabel: string | undefined,
  options: PostmanLoginOptions,
): Promise<PostmanLoginResult> {
  const child = spawnNodeWorker();

  const logs = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const serializableOptions = {
    timeoutMs: options.timeoutMs,
    flow: options.flow,
    confirmationId: options.confirmationId,
    signupAutomation: options.signupAutomation,
  };
  child.stdin.write(`${JSON.stringify({ type: "start", accountLabel, options: serializableOptions })}\n`);

  const confirmationRelay = options.flow === "signup" && options.confirmationId
    ? (() => {
      let relayed = false;
      return setInterval(() => {
        if (relayed || !isSignupCompletionConfirmed(options.confirmationId)) return;
        relayed = true;
        child.stdin.write(`${JSON.stringify({ type: "confirm", confirmationId: options.confirmationId })}\n`);
      }, 500);
    })()
    : undefined;

  try {
    return await readWorkerResult(child, logs, options.onLog, () => stderr, options.timeoutMs);
  } finally {
    if (confirmationRelay) clearInterval(confirmationRelay);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

export async function smokePostmanLoginWorker(): Promise<void> {
  const child = spawnNodeWorker("--smoke");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Postman login worker smoke timed out")), 60_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(new Error(`${error.message}${stderr ? `; stderr: ${stderr.trim()}` : ""}`));
      else resolve();
    };

    lines.on("line", (line) => {
      if (!line.startsWith("POSTMAN_WORKER ")) return;
      try {
        const message = JSON.parse(line.slice("POSTMAN_WORKER ".length)) as { type?: string; ok?: boolean };
        if (message.type === "smoke_result" && message.ok) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Postman login worker smoke exited with code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`));
    });
  });
}

async function readWorkerResult(
  child: ChildProcessWithoutNullStreams,
  lines: ReturnType<typeof createInterface>,
  onLog: PostmanLoginOptions["onLog"],
  readStderr: () => string,
  timeoutMs?: number,
): Promise<PostmanLoginResult> {
  const marker = "POSTMAN_WORKER ";
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Postman login worker timed out")),
      (timeoutMs ?? 15 * 60 * 1000) + 30_000,
    );
    const finish = (error?: Error, value?: PostmanLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      const stderr = readStderr();
      if (error) reject(new Error(`${error.message}${stderr ? `; stderr: ${stderr.trim()}` : ""}`));
      else resolve(value!);
    };

    lines.on("line", (line) => {
      if (!line.startsWith(marker)) return;
      try {
        const message = JSON.parse(line.slice(marker.length)) as { type?: string; entry?: LoginLogEntry; result?: PostmanLoginResult };
        if (message.type === "log" && message.entry) onLog?.(message.entry);
        if (message.type === "result" && message.result) finish(undefined, message.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (settled) return;
      const message = describeWorkerExit(code, signal);
      onLog?.({ step: "浏览器诊断", msg: message, level: "error", ts: Date.now() / 1000 });
      finish(new Error(message));
    });
  });
}

export async function loginPostmanForRuntime(
  accountLabel: string | undefined,
  options: PostmanLoginOptions = {},
  dependencies: PostmanLoginRuntimeDependencies = {},
): Promise<PostmanLoginResult> {
  const runtime = dependencies.runtime ?? detectRuntime();
  const backend = dependencies.backend ?? config.loginBrowserBackend;
  if (runtime === "node" || backend === "playwright") {
    return (dependencies.directRunner ?? runDirectly)(accountLabel, options);
  }
  return (dependencies.workerRunner ?? runInNodeWorker)(accountLabel, options);
}

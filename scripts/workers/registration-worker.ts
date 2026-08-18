import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  UpstreamRegistrationStageError,
  isAbortError,
  runUpstreamRegistration,
  shouldStopRegistrationBatch,
  upstreamRegistrationRuntimeSource,
} from "../../src/automation-lab/upstream-registration.ts";
import {
  parseRegistrationJobInput,
  type RegistrationJobInput,
  type UpstreamRegistrationStage,
} from "../../src/automation-lab/registration-types.ts";

const MARKER = "REGISTRATION_WORKER ";
let activeRunId: string | undefined;
let controller: AbortController | undefined;
let started = false;
let currentStage: UpstreamRegistrationStage | undefined;
let currentAttemptIndex: number | undefined;
let terminalEmitted = false;
let fatalReported = false;

function send(message: unknown): void {
  process.stdout.write(MARKER + JSON.stringify(message) + "\n");
}

function emit(runId: string, event: Record<string, unknown>): void {
  if (typeof event.index === "number") currentAttemptIndex = event.index;
  if (event.type === "stage" && typeof event.stage === "string") {
    currentStage = event.stage as UpstreamRegistrationStage;
  }
  if (
    event.type === "batch"
    && (event.status === "success" || event.status === "failed" || event.status === "stopped")
  ) {
    terminalEmitted = true;
  }
  send({ type: "event", runId, event });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function workerRuntimeIdentity(): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    node: process.version,
    skipBrowserDownload: process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1",
    upstreamRegistrationSource: upstreamRegistrationRuntimeSource(),
    workerSource: fileURLToPath(import.meta.url),
  };
}

function compactErrorStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return error.stack.split(/\r?\n/).slice(1, 6).join("\n").slice(0, 1_200) || undefined;
}

function reportFatalWorkerError(error: unknown): void {
  if (!activeRunId || terminalEmitted || fatalReported) return;
  fatalReported = true;
  const message = errorText(error).slice(0, 500);
  const stack = compactErrorStack(error);
  const resumeFromIndex = currentAttemptIndex ?? 0;
  emit(activeRunId, {
    type: "log",
    stage: "worker",
    level: "error",
    message: `注册 Worker 崩溃诊断：${message}`,
    payload: { ...workerRuntimeIdentity(), ...(stack ? { stack } : {}) },
  });
  emit(activeRunId, {
    type: "error",
    index: resumeFromIndex,
    stage: currentStage,
    level: "error",
    message: `注册 Worker 未捕获异常：${message}`,
    payload: { fatal: true, resumeFromIndex },
  });
  emit(activeRunId, {
    type: "batch",
    status: "failed",
    message: `注册 Worker 异常，将从第 ${resumeFromIndex + 1} 项恢复：${message}`,
    payload: { fatal: true, resumeFromIndex },
  });
}

function parseStartIndex(value: unknown, count: number): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= count) {
    throw new Error("Worker 恢复索引无效");
  }
  return value;
}

async function runJob(runId: string, input: RegistrationJobInput, signal: AbortSignal, startIndex = 0): Promise<void> {
  emit(runId, {
    type: "log",
    stage: "worker",
    level: "info",
    message: "注册 Worker 已启动",
    payload: workerRuntimeIdentity(),
  });
  emit(runId, { type: "batch", status: "running", message: "注册任务已启动" });
  if (startIndex > 0) {
    emit(runId, { type: "log", stage: "worker", level: "warn", message: `注册 Worker 已从第 ${startIndex + 1} 项恢复` });
  }
  let allSucceeded = true;
  let lastFailure = "";
  for (let index = startIndex; index < input.count; index += 1) {
    if (signal.aborted) throw Object.assign(new Error("注册任务已停止"), { name: "AbortError" });
    emit(runId, { type: "attempt", status: "running", index, message: `开始第 ${index + 1} 项` });
    let attempts = 0;
    let success = false;
    let lastError = "";
    let email: string | undefined;
    let stopBatch = false;

    attempts = 1;
    try {
      const result = await runUpstreamRegistration({
        signal,
        retryLimit: input.retryLimit,
        onStage: (stage: UpstreamRegistrationStage) => emit(runId, { type: "stage", stage, index, message: `执行 ${stage}` }),
        onLog: (entry) => emit(runId, {
          type: "log",
          index,
          stage: entry.step,
          message: entry.msg,
          level: entry.level,
        }),
        onToken: (token) => emit(runId, { type: "account", index, message: "收到账号 Token", payload: token }),
      });
      attempts += result.retriesUsed;
      email = result.email;
      success = true;
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      emit(runId, {
        type: "error",
        index,
        stage: error instanceof UpstreamRegistrationStageError ? error.stage : undefined,
        level: "error",
        message: lastError,
      });
      stopBatch = shouldStopRegistrationBatch(error);
    }

    if (!success) {
      allSucceeded = false;
      lastFailure = lastError || `第 ${index + 1} 项失败`;
    }
    emit(runId, {
      type: "attempt",
      status: success ? "success" : "failed",
      index,
      attempts,
      email,
      message: success ? `第 ${index + 1} 项完成` : lastError,
    });
    if (stopBatch) {
      emit(runId, {
        type: "batch",
        status: "failed",
        message: `注册任务已停止：${lastError || "临时邮箱服务不可用"}`,
      });
      return;
    }
  }
  emit(runId, {
    type: "batch",
    status: allSucceeded ? "success" : "failed",
    message: allSucceeded ? "注册任务全部完成" : `注册任务已结束：${lastFailure || "存在失败项"}`,
  });
}

const lines = createInterface({ input: process.stdin });
process.on("uncaughtException", (error) => {
  reportFatalWorkerError(error);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50).unref();
});
process.on("unhandledRejection", (reason) => {
  reportFatalWorkerError(reason);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 50).unref();
});
process.on("exit", (code) => {
  if (code !== 0) reportFatalWorkerError(new Error(`进程以退出码 ${code} 结束`));
});
lines.on("line", (line) => {
  let message: { type?: unknown; runId?: unknown; input?: unknown; startIndex?: unknown };
  try { message = JSON.parse(line) as typeof message; } catch { return; }
  if (message.type === "stop" && typeof message.runId === "string" && message.runId === activeRunId) {
    controller?.abort();
    return;
  }
  if (message.type !== "start" || started || typeof message.runId !== "string") return;
  started = true;
  activeRunId = message.runId;
  const parsed = (() => { try { return { input: parseRegistrationJobInput(message.input) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } })();
  if ("error" in parsed) {
    emit(message.runId, { type: "batch", status: "failed", message: parsed.error });
    process.exitCode = 1;
    lines.close();
    return;
  }
  let startIndex: number;
  try { startIndex = parseStartIndex(message.startIndex, parsed.input.count); } catch (error) {
    emit(message.runId, { type: "batch", status: "failed", message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    lines.close();
    return;
  }
  controller = new AbortController();
  void runJob(message.runId, parsed.input, controller.signal, startIndex).then(() => {
    lines.close();
    process.exitCode = 0;
  }).catch((error) => {
    const stopped = isAbortError(error) || controller?.signal.aborted;
    emit(message.runId!, { type: "batch", status: stopped ? "stopped" : "failed", message: stopped ? "注册任务已停止" : error instanceof Error ? error.message : String(error) });
    lines.close();
    process.exitCode = stopped ? 0 : 1;
  });
});
process.stdin.resume();

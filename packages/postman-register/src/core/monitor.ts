import { sleep } from "./sleep";
import { CONFIG } from "../config";
import { log } from "./logger";

/** 一个可实时检测的信号 */
export interface WatchSignal {
  /** 信号名称，命中与超时日志都会用到 */
  name: string;
  /** 检测函数，返回 true 表示命中 */
  check: () => Promise<boolean>;
}

export interface WaitSignalOptions {
  /** 总超时（毫秒） */
  timeout?: number;
  /** 轮询间隔（毫秒），越小越容易捕捉瞬时状态（如 Turnstile 的绿色 Success!） */
  interval?: number;
  /** 日志前缀 */
  label?: string;
  /** 每次轮询未命中后调用（参数为已耗时毫秒），可用于触发交互，例如点击 Turnstile 复选框 */
  onMiss?: (elapsedMs: number) => Promise<void>;
}

/** A detached browser frame can leave a locator promise pending indefinitely. */
async function boundedSignalCheck(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    void check().then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function boundedMissHook(hook: () => Promise<void>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`等待信号交互钩子超时（${timeoutMs}ms）`));
    }, timeoutMs);
    void hook().then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 实时元素监测工具：以固定间隔连续轮询多个信号，任一命中即返回。
 * 与 waiters 里的一次性等待不同：粒度更细、多信号并行、命中即时打日志，
 * 专门用来捕捉「绿色 Success!」这类转瞬即逝的状态，也用于邮箱字段等常规监测。
 */
export async function waitForSignal(signals: WatchSignal[], opts: WaitSignalOptions = {}): Promise<string> {
  const { timeout = CONFIG.timeouts.long, interval = 300, label = "等待信号" } = opts;
  const start = Date.now();
  // Keep a single slow/detached frame from blocking onMiss (for example the
  // Turnstile click hook) for Playwright's default 30-second locator timeout.
  const checkTimeout = Math.max(50, Math.min(interval, 1000));
  while (Date.now() - start < timeout) {
    for (const s of signals) {
      if (await boundedSignalCheck(s.check, checkTimeout)) {
        log.info(`${label}: 命中信号「${s.name}」`);
        return s.name;
      }
    }
    const remaining = timeout - (Date.now() - start);
    if (remaining <= 0) break;
    if (opts.onMiss) {
      await boundedMissHook(
        () => opts.onMiss!(Date.now() - start),
        Math.max(250, Math.min(2500, remaining)),
      );
    }
    await sleep(interval);
  }
  throw new Error(
    `${label}超时（${timeout}ms），未命中任何信号: ${signals.map((s) => s.name).join(" / ")}`,
  );
}

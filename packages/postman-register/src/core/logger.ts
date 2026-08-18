import type { Stage } from "../types";

const STAGE_NAMES: Record<Stage, string> = {
  tempEmail: "获取临时邮箱",
  signup: "注册账号",
  verify: "邮箱验证",
  profile: "完善资料",
  upgrade: "升级试用",
  team: "团队设置",
  enableAi: "启用 AI",
};

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
};

export const log = {
  sink: undefined as ((entry: { step: string; msg: string; level: "info" | "success" | "warn" | "error" }) => void) | undefined,
  stageStart(stage: Stage, msg: string): void {
    log.sink?.({ step: stage, msg, level: "info" });
    console.log(`\n${c.magenta}[${stage}]${c.reset} ${c.cyan}${STAGE_NAMES[stage]}${c.reset} ${c.dim}— ${msg}${c.reset}`);
  },
  ok(msg: string): void {
    log.sink?.({ step: "任务", msg, level: "success" });
    console.log(`${c.green}[OK]${c.reset} ${msg}`);
  },
  info(msg: string): void {
    log.sink?.({ step: "任务", msg, level: "info" });
    console.log(`${c.cyan}[INFO]${c.reset} ${msg}`);
  },
  warn(msg: string): void {
    log.sink?.({ step: "任务", msg, level: "warn" });
    console.log(`${c.yellow}[WARN]${c.reset} ${msg}`);
  },
  error(msg: string): void {
    log.sink?.({ step: "任务", msg, level: "error" });
    console.log(`${c.red}[ERROR]${c.reset} ${msg}`);
  },
};

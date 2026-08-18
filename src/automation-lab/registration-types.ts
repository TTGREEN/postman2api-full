export const UPSTREAM_REGISTRATION_STAGES = [
  "tempEmail",
  "signup",
  "verify",
  "profile",
  "upgrade",
  "team",
  "enableAi",
] as const;

export type UpstreamRegistrationStage = typeof UPSTREAM_REGISTRATION_STAGES[number];
export type RegistrationJobMode = "upstream";
export type RegistrationJobStatus = "queued" | "running" | "success" | "failed" | "stopped";

export interface RegistrationJobInput {
  target: string;
  count: number;
  retryLimit: number;
  mode: RegistrationJobMode;
  headless?: boolean;
}

export interface RegistrationJobAttempt {
  index: number;
  status: "pending" | "running" | "success" | "failed" | "stopped";
  attempts: number;
  stage?: UpstreamRegistrationStage;
  email?: string;
  accountId?: number;
  error?: string;
}

export interface RegistrationJobSnapshot {
  id: string;
  kind: "registration";
  target: string;
  mode: RegistrationJobMode;
  status: RegistrationJobStatus;
  requested: number;
  completed: number;
  retryLimit: number;
  attempts: RegistrationJobAttempt[];
  events: RegistrationJobEvent[];
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface RegistrationJobEvent {
  jobId: string;
  seq?: number;
  type: "batch" | "attempt" | "stage" | "error" | "log" | "account";
  status?: RegistrationJobStatus | RegistrationJobAttempt["status"];
  index?: number;
  stage?: UpstreamRegistrationStage;
  message: string;
  ts: number;
  level?: "info" | "success" | "warn" | "error";
  attemptIndex?: number;
  payload?: Record<string, unknown>;
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseRegistrationBatchInput(value: unknown): Pick<RegistrationJobInput, "target" | "count" | "retryLimit"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("批量参数必须是 JSON 对象");
  }
  const input = value as Record<string, unknown>;
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target) throw new Error("目标不能为空");
  const count = input.count;
  if (!integerInRange(count, 1, 100)) throw new Error("批量数量必须是 1 到 100 的整数");
  const retryLimit = input.retryLimit ?? 1;
  if (!integerInRange(retryLimit, 0, 5)) throw new Error("重试次数必须是 0 到 5 的整数");
  return { target, count, retryLimit };
}

export function parseRegistrationJobInput(value: unknown): RegistrationJobInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务参数必须是 JSON 对象");
  }
  const input = value as Record<string, unknown>;
  const batch = parseRegistrationBatchInput({
    target: input.target,
    count: input.count,
    retryLimit: input.retryLimit,
  });
  const mode = input.mode ?? "upstream";
  if (mode !== "upstream") throw new Error("本地模拟自动化已下线，仅支持真实上游注册任务");
  if (input.headless !== undefined && typeof input.headless !== "boolean") throw new Error("headless 必须是布尔值");
  return { ...batch, mode, headless: input.headless as boolean | undefined };
}

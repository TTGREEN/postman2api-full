const API_BASE = "";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers || {}),
    },
  });
  const responseText = await res.text();
  let body: unknown;

  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch {
      const contentType = res.headers.get("Content-Type") || "未声明 Content-Type";
      throw new Error(
        `接口 ${path} 返回了非 JSON 响应（HTTP ${res.status}）。响应类型：${contentType}。请确认本地后端已重启并加载当前版本。`,
      );
    }
  }

  if (!res.ok) {
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return body as T;
}

export interface Account {
  id: number;
  email: string;
  status: string;
  enabled: boolean;
  quotaLimit?: number | null;
  quotaRemaining?: number | null;
  lastUsedAt?: string | null;
  lastLoginAt?: string | null;
  errorMessage?: string | null;
  hasTokens: boolean;
  workspaceSubdomain?: string | null;
  createdAt?: string;
}

export interface AccountTestLogEntry {
  step: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  ts: number;
  elapsedMs: number;
}

export interface AccountTestResult {
  success: boolean;
  available: boolean;
  accountId: number;
  email?: string;
  model: string;
  prompt: string;
  response?: string;
  error?: string;
  durationMs: number;
  matchedExpectedResponse?: boolean;
  logs: AccountTestLogEntry[];
}

export interface AccountImportResult {
  index: number;
  email?: string;
  status: "created" | "updated" | "failed";
  accountId?: number;
  error?: string;
}

export interface AccountImportResponse {
  success: boolean;
  summary: {
    total: number;
    created: number;
    updated: number;
    failed: number;
  };
  results: AccountImportResult[];
}

export interface Stats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalAccounts: number;
  activeAccounts: number;
  recentRequests: any[];
}

export async function fetchAccounts(): Promise<{ data: Account[] }> {
  return api("/api/accounts");
}

export type RegistrationJobMode = "upstream";
export type RegistrationJobStatus = "queued" | "running" | "success" | "failed" | "stopped";
export interface RegistrationJobAttempt {
  index: number;
  status: "pending" | "running" | "success" | "failed" | "stopped";
  attempts: number;
  stage?: string;
  email?: string;
  accountId?: number;
  error?: string;
}
export interface RegistrationJobEvent {
  jobId: string;
  seq?: number;
  type: string;
  status?: string;
  index?: number;
  stage?: string;
  message: string;
  level?: "info" | "success" | "warn" | "error";
  ts: number;
  payload?: Record<string, unknown>;
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

export async function fetchRegistrationJobs(options: { mode?: RegistrationJobMode; limit?: number } = {}): Promise<{ data: RegistrationJobSnapshot[] }> {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return api(`/api/registration${query ? `?${query}` : ""}`);
}

export async function fetchRegistrationJob(id: string): Promise<RegistrationJobSnapshot> {
  return api(`/api/registration/${encodeURIComponent(id)}`);
}

export async function startRegistrationJob(input: {
  target: string;
  count: number;
  retryLimit: number;
  mode: RegistrationJobMode;
  headless?: boolean;
}): Promise<RegistrationJobSnapshot> {
  return api("/api/registration", { method: "POST", body: JSON.stringify(input) });
}

export async function stopRegistrationJob(id: string): Promise<RegistrationJobSnapshot> {
  return api(`/api/registration/${encodeURIComponent(id)}/stop`, { method: "POST" });
}

export async function retryRegistrationJob(id: string): Promise<RegistrationJobSnapshot> {
  return api(`/api/registration/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export async function loginAccount(
  email: string,
  flow: "login" | "signup" = "login",
  confirmationId?: string,
  signupAutomation?: { username?: string; password: string },
): Promise<{ success: boolean; accountId?: number; imported?: boolean }> {
  return api("/api/accounts/login", {
    method: "POST",
    body: JSON.stringify({ email, flow, confirmationId, signupAutomation }),
  });
}

export async function confirmSignup(confirmationId: string): Promise<{ success: boolean }> {
  return api("/api/accounts/signup/confirm", {
    method: "POST",
    body: JSON.stringify({ confirmationId }),
  });
}

export async function previewTempEmail(): Promise<{ success: true; sessionId: string; email: string; expiresAt: number }> {
  return api("/api/accounts/signup/email-preview", { method: "POST" });
}

export async function openTempEmailPreview(sessionId: string): Promise<{ success: true }> {
  return api(`/api/accounts/signup/email-preview/${encodeURIComponent(sessionId)}/open`, { method: "POST" });
}

export async function closeTempEmailPreview(sessionId: string): Promise<{ success: true }> {
  return api(`/api/accounts/signup/email-preview/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function addAccountManual(email: string, tokens: any): Promise<{ success: boolean }> {
  return api("/api/accounts", {
    method: "POST",
    body: JSON.stringify({ email, tokens }),
  });
}

export async function importAccounts(payload: unknown): Promise<AccountImportResponse> {
  return api("/api/accounts/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteAccount(id: number): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function warmupAccount(id: number): Promise<{ success: boolean; error?: string; account: Account }> {
  return api(`/api/accounts/${id}/warmup`, { method: "POST" });
}

export async function testAccount(id: number): Promise<AccountTestResult> {
  return api(`/api/accounts/${id}/test`, { method: "POST" });
}

export async function toggleAccount(id: number, enabled: boolean): Promise<{ success: boolean }> {
  return api(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchStats(): Promise<{ data: Stats }> {
  return api("/api/stats");
}

export async function resetStats(): Promise<{ success: boolean; deletedRequestLogs: number }> {
  return api("/api/stats/reset", { method: "POST" });
}

export async function fetchSettings(): Promise<{ data: Record<string, string> }> {
  return api("/api/settings");
}

export async function updateSettings(settings: Record<string, string>): Promise<{ success: boolean }> {
  return api("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

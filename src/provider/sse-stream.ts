export interface PostmanDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
  finish_reason?: string | null;
}

export interface PostmanUsage {
  limit: number;
  usage: number;
  overage: number;
  userType: string;
  usageState: string;
}

export interface PostmanTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const QUOTA_ERROR_PATTERNS = [
  "usage_limit_exceeded",
  "quota_exceeded",
  "monthly ai credit limit",
  "ai credit limit",
  "regain agent mode access",
  "enable pay-as-you-go",
  "enable pay as you go",
];

const AGENT_MODE_ERROR_PATTERNS = [
  "input_validation_error: forbidden",
  "ai_user_agent_mode",
  "agent mode is disabled",
  "agent mode access is disabled",
];

export function isPostmanQuotaExceeded(value: unknown): boolean {
  const text = typeof value === "string" ? value : safeStringify(value);
  const normalized = text.toLowerCase();
  return QUOTA_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function isPostmanAgentModeUnavailable(value: unknown): boolean {
  const text = typeof value === "string" ? value : safeStringify(value);
  const normalized = text.toLowerCase();
  return AGENT_MODE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern))
    || (normalized.includes("input_validation_error") && normalized.includes("forbidden"));
}

export class PostmanStreamReader {
  private finished = false;
  private _quotaExceeded = false;
  private _usage: PostmanUsage | null = null;
  private _tokenUsage: PostmanTokenUsage | null = null;
  private _error: string | null = null;
  private _retryableError = false;
  private _model: string | null = null;
  private _conversationId: string | null = null;
  private _sawEvent = false;
  private _sawToolCall = false;
  private _toolCallIndex = new Map<string, number>();

  get quotaExceeded(): boolean { return this._quotaExceeded; }
  get usage(): PostmanUsage | null { return this._usage; }
  get tokenUsage(): PostmanTokenUsage | null { return this._tokenUsage; }
  get error(): string | null { return this._error; }
  get retryableError(): boolean { return this._retryableError; }
  get actualModel(): string | null { return this._model; }
  get conversationId(): string | null { return this._conversationId; }
  get sawEvent(): boolean { return this._sawEvent; }

  feed(line: string): PostmanDelta[] {
    const trimmed = line.trim();
    const match = /^data:\s*(.+)$/.exec(trimmed);
    if (!match) return [];

    let event: any;
    try {
      event = JSON.parse(match[1]!);
    } catch {
      return [];
    }

    if (!event || typeof event !== "object") return [];
    this._sawEvent = true;

    const eventType = String(event.eventType || event.type || "");
    if (!eventType && typeof event.result === "string") {
      if (/fail|error/i.test(event.result)) return this.handleFailure(event);
      if (typeof event.message === "string" && event.message.length > 0) return [{ content: event.message }];
    }

    switch (eventType) {
      case "usage":
        return this.handleUsage(event.data);
      case "conversation":
        return this.handleConversation(event.data);
      case "textChunk":
        return this.handleTextChunk(event.data);
      case "thinkingChunk":
        return this.handleThinkingChunk(event.data);
      case "planningChunk":
      case "progressUpdate":
        return [];
      case "failure":
        return this.handleFailure(event.data);
      case "error":
        return this.handleFailure(event.data ?? event.error ?? event);
      case "toolCallChunk":
        return this.handleToolCallChunk(event.data);
      case "info":
      case "ping":
      case "streamingFormat":
      case "thinkingComplete":
        return [];
      default:
        if (/fail|error/i.test(eventType) || isPostmanQuotaExceeded(event)) {
          return this.handleFailure(event.data ?? event.error ?? event);
        }
        return [];
    }
  }

  finish(): PostmanDelta[] {
    if (this.finished) return [];
    this.finished = true;
    return [{ finish_reason: this._sawToolCall ? "tool_calls" : "stop" }];
  }

  private handleUsage(data: any): PostmanDelta[] {
    if (!data) return [];
    this._usage = {
      limit: data.limit ?? 0,
      usage: data.usage ?? 0,
      overage: data.overage ?? 0,
      userType: data.userType ?? "",
      usageState: data.usageState ?? "",
    };
    const promptTokens = firstFiniteNumber(
      data.prompt_tokens,
      data.promptTokens,
      data.input_tokens,
      data.inputTokens,
    );
    const completionTokens = firstFiniteNumber(
      data.completion_tokens,
      data.completionTokens,
      data.output_tokens,
      data.outputTokens,
    );
    const totalTokens = firstFiniteNumber(data.total_tokens, data.totalTokens);
    if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
      this._tokenUsage = { promptTokens, completionTokens, totalTokens };
    }
    const usageState = String(data.usageState || "").toUpperCase();
    if (
      usageState === "EXCEEDED"
      || usageState === "UNAVAILABLE"
      || isPostmanQuotaExceeded(data)
    ) {
      this._quotaExceeded = true;
    }
    return [];
  }

  private handleConversation(data: any): PostmanDelta[] {
    if (!data) return [];
    if (typeof data.id === "string") {
      this._conversationId = data.id;
    }
    return [];
  }

  private handleTextChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    if (data.metadata?.model) this._model = data.metadata.model;
    const text = data.textContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ content: text }];
    }
    return [];
  }

  private handleThinkingChunk(data: any): PostmanDelta[] {
    if (!data) return [];
    if (data.metadata?.model) this._model = data.metadata.model;
    const text = data.thinkingContent;
    if (typeof text === "string" && text.length > 0) {
      return [{ reasoning_content: text }];
    }
    return [];
  }

  private handleToolCallChunk(data: any): PostmanDelta[] {
    if (!data?.toolCalls || !Array.isArray(data.toolCalls)) return [];
    if (data.metadata?.model) this._model = data.metadata.model;

    const out: PostmanDelta[] = [];
    for (const tc of data.toolCalls) {
      if (!tc.id) continue;
      this._sawToolCall = true;

      let idx = this._toolCallIndex.get(tc.id);
      const isFirst = idx === undefined;
      if (isFirst) {
        idx = this._toolCallIndex.size;
        this._toolCallIndex.set(tc.id, idx);
      }

      out.push({
        tool_calls: [{
          index: idx!,
          ...(isFirst ? { id: tc.id, type: "function" as const } : {}),
          function: {
            ...(isFirst ? { name: tc.function?.name || "" } : {}),
            arguments: tc.function?.arguments || "",
          },
        }],
      });
    }
    return out;
  }

  private handleFailure(data: any): PostmanDelta[] {
    this._error = extractFailureMessage(data);
    const agentModeUnavailable = isPostmanAgentModeUnavailable(data) || isPostmanAgentModeUnavailable(this._error);
    this._retryableError = this._error === "Unknown Postman error" || agentModeUnavailable;
    if (this._retryableError) {
      this._error = agentModeUnavailable
        ? "Postman Agent Mode is not enabled for this account yet. Enable ai_user_agent_mode and retry shortly."
        : "Postman AI access is not ready for this team yet. Confirm that organization AI access is enabled, then retry shortly.";
    }
    if (isPostmanQuotaExceeded(data) || isPostmanQuotaExceeded(this._error)) {
      this._quotaExceeded = true;
      this._retryableError = false;
    }
    return [];
  }
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function extractFailureMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return "Unknown Postman error";

  const data = value as Record<string, unknown>;
  const code = firstString(data.errorType, data.code, data.name);
  const directMessage = firstString(data.userMessage, data.message, data.detail, data.reason);
  if (code && directMessage && code !== directMessage && code.toUpperCase() === "INPUT_VALIDATION_ERROR") return `${code}: ${directMessage}`;
  if (directMessage) return directMessage;
  for (const key of ["userMessage", "message", "detail", "reason"]) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "data", "cause"]) {
    const candidate = data[key];
    if (candidate && typeof candidate === "object") {
      const nested = extractFailureMessage(candidate);
      if (nested !== "Unknown Postman error") return nested;
    }
  }
  for (const key of ["errorType", "code"]) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Unknown Postman error";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value ?? "");
  }
}

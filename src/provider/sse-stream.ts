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
  "ai_user_agent_mode",
  "ai user agent mode",
  "user agent mode",
  "agent mode is not enabled",
  "agent mode not enabled",
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
  return AGENT_MODE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
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
  private _toolCallGroupId: string | null = null;
  private _sawEvent = false;
  private _sawToolCall = false;
  private _loopApproval: { message: string; reasons: unknown; counters: unknown; thresholds: unknown } | null = null;
  private _toolCallIndex = new Map<string, number>();
  private _generatedToolIds = new Map<number, string>();
  private _namedToolIndexes = new Set<number>();
  private _nextToolCallIndex = 0;

  get quotaExceeded(): boolean { return this._quotaExceeded; }
  get usage(): PostmanUsage | null { return this._usage; }
  get tokenUsage(): PostmanTokenUsage | null { return this._tokenUsage; }
  get error(): string | null { return this._error; }
  get retryableError(): boolean { return this._retryableError; }
  get actualModel(): string | null { return this._model; }
  get conversationId(): string | null { return this._conversationId; }
  get toolCallGroupId(): string | null { return this._toolCallGroupId; }
  get sawEvent(): boolean { return this._sawEvent; }
  get sawToolCall(): boolean { return this._sawToolCall; }
  get loopApproval() { return this._loopApproval; }

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
    this.captureConversationId(event, eventType);
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
      case "loopApprovalChunk":
        return this.handleLoopApproval(event.data);
      case "info":
      case "ping":
      case "todoChunk":
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

  // Postman's agent-mode loop guard. Upstream stops generating and asks the
  // client to approve continuing; without this the turn looks like an empty
  // response.
  private handleLoopApproval(data: any): PostmanDelta[] {
    this._loopApproval = {
      message: typeof data?.message === "string" ? data.message : "",
      reasons: data?.reasons ?? null,
      counters: data?.counters ?? null,
      thresholds: data?.thresholds ?? null,
    };
    return [];
  }

  private handleUsage(data: any): PostmanDelta[] {    if (!data) return [];
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

  private captureConversationId(event: any, eventType: string): void {
    const data = event?.data;
    const candidates = eventType === "conversation"
      ? [
        data?.id,
        data?.conversationId,
        data?.conversation_id,
        data?.conversation?.id,
        data?.conversation?.conversationId,
      ]
      : [
        event?.conversationId,
        event?.conversation_id,
        event?.metadata?.conversationId,
        event?.metadata?.conversation_id,
        data?.conversationId,
        data?.conversation_id,
        data?.conversation?.id,
        data?.conversation?.conversationId,
        data?.metadata?.conversationId,
        data?.metadata?.conversation_id,
      ];
    const conversationId = firstNonEmptyString(...candidates);
    if (conversationId) this._conversationId = conversationId;
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
    const toolCalls = extractToolCallEntries(data);
    if (toolCalls.length === 0) return [];
    if (data.metadata?.model) this._model = data.metadata.model;
    this._toolCallGroupId ||= firstNonEmptyString(
      data.toolCallGroupId,
      data.tool_call_group_id,
      data.groupId,
      data.group_id,
    ) || null;

    const out: PostmanDelta[] = [];
    for (const [position, tc] of toolCalls.entries()) {
      this._sawToolCall = true;
      this._toolCallGroupId ||= firstNonEmptyString(
        tc.toolCallGroupId,
        tc.tool_call_group_id,
        tc.groupId,
        tc.group_id,
      ) || null;

      const explicitIndex = firstFiniteInteger(tc.index, tc.toolCallIndex);
      const suppliedId = firstNonEmptyString(
        tc.id,
        tc.call_id,
        tc.callId,
        tc.tool_call_id,
        tc.toolCallId,
      );
      const positionKey = "position:" + position;
      const idKey = suppliedId ? "id:" + suppliedId : undefined;
      const sourceKey = explicitIndex === undefined
        ? idKey || positionKey
        : "index:" + explicitIndex;

      let idx = this._toolCallIndex.get(sourceKey);
      if (idx === undefined && explicitIndex === undefined && suppliedId) {
        idx = this._toolCallIndex.get(positionKey);
      }
      const isFirst = idx === undefined;
      const toolCallIndex = idx === undefined ? this._nextToolCallIndex++ : idx;
      if (isFirst) this._toolCallIndex.set(sourceKey, toolCallIndex);
      this._toolCallIndex.set(positionKey, toolCallIndex);
      if (idKey) this._toolCallIndex.set(idKey, toolCallIndex);

      const stableId = suppliedId || this.getGeneratedToolId(toolCallIndex);
      const name = firstNonEmptyString(
        tc.function?.name,
        tc.name,
        tc.tool?.name,
      );
      const argumentsText = stringifyToolArguments(
        tc.function?.arguments
        ?? tc.arguments
        ?? tc.input
        ?? tc.input_json,
      );

      // Upstream repeats the full name on every chunk. Emitting it more than once
      // makes clients that concatenate deltas build "get_weatherget_weather".
      const emitName = name !== undefined && !this._namedToolIndexes.has(toolCallIndex);
      if (emitName) this._namedToolIndexes.add(toolCallIndex);

      out.push({
        tool_calls: [{
          index: toolCallIndex,
          ...(isFirst ? { id: stableId, type: "function" as const } : {}),
          function: {
            ...(emitName ? { name } : {}),
            ...(argumentsText ? { arguments: argumentsText } : {}),
          },
        }],
      });
    }
    return out;
  }

  private getGeneratedToolId(index: number): string {
    const existing = this._generatedToolIds.get(index);
    if (existing) return existing;
    const generated = "call_postman_" + index + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this._generatedToolIds.set(index, generated);
    return generated;
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

function extractToolCallEntries(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ["toolCalls", "tool_calls", "calls"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data?.toolCall && typeof data.toolCall === "object") return [data.toolCall];
  if (data?.tool_call && typeof data.tool_call === "object") return [data.tool_call];
  return [];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function firstFiniteInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function stringifyToolArguments(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value);
  }
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

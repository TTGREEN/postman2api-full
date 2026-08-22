import type { ChatMessage } from "./base";
import type { PostmanTokens } from "./transcript";

const DEFAULT_MAX_CONVERSATIONS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DETAIL_CONCURRENCY = 6;
const AMBIGUITY_GAP = 150;

export interface PostmanConversationRecoveryResult {
  recovered: boolean;
  conversationId?: string;
  score?: number;
  reason:
    | "recovered"
    | "no_local_anchor"
    | "no_history"
    | "no_compatible_candidate"
    | "ambiguous"
    | "history_error";
  scanned: number;
  compatible: number;
  error?: string;
}

interface ConversationSummary {
  id: string;
  modelKey?: string | null;
  state?: string | null;
}

interface ConversationDetail extends ConversationSummary {
  interactions?: Array<{
    role?: string | null;
    content?: string | null;
    thinkingContent?: string | null;
    toolCalls?: unknown[] | null;
    tool_calls?: unknown[] | null;
  }> | null;
}

interface LocalToolCall {
  id: string;
  signature: string;
}

interface LocalRecoveryContext {
  toolCalls: LocalToolCall[];
  toolResultIds: Set<string>;
  assistantContents: Set<string>;
}

interface ScoredCandidate {
  conversationId: string;
  score: number;
  toolIdMatches: number;
  toolSignatureMatches: number;
  assistantMatches: number;
}

export function shouldAttemptPostmanConversationRecovery(messages: ChatMessage[]): boolean {
  const tail = messages[messages.length - 1];
  if (!tail) return false;
  if (tail.role === "tool") return true;
  if (containsToolResultBlock(tail)) return true;
  return tail.role === "assistant"
    && Array.isArray(tail.tool_calls)
    && tail.tool_calls.length > 0;
}

export async function recoverPostmanConversation(options: {
  tokens: Pick<PostmanTokens, "postman_sid" | "workspace_subdomain">;
  messages: ChatMessage[];
  expectedModelKey: string | null;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  maxConversations?: number;
  requestTimeoutMs?: number;
}): Promise<PostmanConversationRecoveryResult> {
  const local = buildLocalRecoveryContext(options.messages);
  if (local.toolCalls.length === 0) {
    return { recovered: false, reason: "no_local_anchor", scanned: 0, compatible: 0 };
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const maxConversations = Math.max(1, Math.floor(options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS));
  const requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  const baseUrl = `https://${options.tokens.workspace_subdomain}.postman.co/_gw`;

  try {
    const summaries = await fetchConversationSummaries({
      baseUrl,
      headers: options.headers,
      signal: options.signal,
      fetcher,
      maxConversations,
      requestTimeoutMs,
    });
    if (summaries.length === 0) {
      return { recovered: false, reason: "no_history", scanned: 0, compatible: 0 };
    }

    const compatibleSummaries = summaries.filter((summary) => (
      normalizeState(summary.state) === "WAITING_FOR_TOOL"
      && modelMatches(summary.modelKey, options.expectedModelKey)
    ));
    const details = await mapWithConcurrency(
      compatibleSummaries,
      DETAIL_CONCURRENCY,
      (summary) => fetchConversationDetail({
        baseUrl,
        headers: options.headers,
        signal: options.signal,
        fetcher,
        requestTimeoutMs,
        summary,
      }),
    );
    const candidates = details
      .filter((detail): detail is ConversationDetail => detail !== null)
      .map((detail, index) => scoreConversation(local, detail, index))
      .filter((candidate): candidate is ScoredCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score);

    if (candidates.length === 0) {
      return {
        recovered: false,
        reason: "no_compatible_candidate",
        scanned: details.filter(Boolean).length,
        compatible: 0,
      };
    }

    const top = candidates[0]!;
    const second = candidates[1];
    if (second && top.score - second.score < AMBIGUITY_GAP) {
      return {
        recovered: false,
        reason: "ambiguous",
        scanned: details.filter(Boolean).length,
        compatible: candidates.length,
      };
    }

    return {
      recovered: true,
      conversationId: top.conversationId,
      score: top.score,
      reason: "recovered",
      scanned: details.filter(Boolean).length,
      compatible: candidates.length,
    };
  } catch (error) {
    return {
      recovered: false,
      reason: "history_error",
      scanned: 0,
      compatible: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildLocalRecoveryContext(messages: ChatMessage[]): LocalRecoveryContext {
  const toolCalls: LocalToolCall[] = [];
  const assistantContents = new Set<string>();
  for (const message of messages.slice(-80)) {
    if (message.role !== "assistant") continue;
    const content = normalizeText(renderMessageContent(message.content));
    if (content) assistantContents.add(content);
    if (!Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const definition = toolCall?.function && typeof toolCall.function === "object"
        ? toolCall.function
        : toolCall;
      const name = normalizeText(definition?.name);
      const args = normalizeArguments(
        definition?.arguments ?? definition?.args ?? toolCall?.arguments ?? toolCall?.args,
      );
      if (name || args) {
        toolCalls.push({ id: normalizeText(toolCall?.id), signature: `${name}\n${args}` });
      }
    }
  }

  const toolResultIds = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const id = normalizeText(message.tool_call_id);
      if (id) toolResultIds.add(id);
      continue;
    }
    if (containsToolResultBlock(message)) {
      collectToolResultIds(message.content, toolResultIds);
    }
    break;
  }

  return { toolCalls, toolResultIds, assistantContents };
}

function scoreConversation(
  local: LocalRecoveryContext,
  detail: ConversationDetail,
  listIndex: number,
): ScoredCandidate | null {
  if (normalizeState(detail.state) !== "WAITING_FOR_TOOL") return null;
  const cloudTools: Array<{ id: string; signature: string }> = [];
  const cloudContents = new Set<string>();
  for (const interaction of detail.interactions || []) {
    if (String(interaction?.role || "").toUpperCase() !== "ASSISTANT") continue;
    const content = normalizeText(interaction.content);
    if (content) cloudContents.add(content);
    const rawTools = Array.isArray(interaction.toolCalls)
      ? interaction.toolCalls
      : Array.isArray(interaction.tool_calls)
        ? interaction.tool_calls
        : [];
    for (const rawToolCall of rawTools) {
      const toolCall = rawToolCall && typeof rawToolCall === "object"
        ? rawToolCall as Record<string, any>
        : {};
      const definition = toolCall.function && typeof toolCall.function === "object"
        ? toolCall.function as Record<string, any>
        : toolCall;
      const name = normalizeText(definition.name ?? toolCall.name);
      const args = normalizeArguments(
        definition.arguments ?? definition.args ?? toolCall.arguments ?? toolCall.args,
      );
      cloudTools.push({ id: normalizeText(toolCall.id), signature: `${name}\n${args}` });
    }
  }
  if (cloudTools.length === 0 && cloudContents.size === 0) return null;

  let score = Math.max(0, 30 - listIndex);
  let toolIdMatches = 0;
  let toolSignatureMatches = 0;
  let assistantMatches = 0;
  const matchedCloudTools = new Set<number>();

  for (const localTool of local.toolCalls) {
    let matchedIndex = -1;
    let matchKind: "id" | "signature" | null = null;
    for (let index = 0; index < cloudTools.length; index++) {
      if (matchedCloudTools.has(index)) continue;
      const cloudTool = cloudTools[index]!;
      if (localTool.id && cloudTool.id && localTool.id === cloudTool.id) {
        matchedIndex = index;
        matchKind = "id";
        break;
      }
      if (
        matchKind === null
        && localTool.signature
        && cloudTool.signature
        && localTool.signature === cloudTool.signature
      ) {
        matchedIndex = index;
        matchKind = "signature";
      }
    }
    if (matchedIndex < 0 || !matchKind) continue;
    matchedCloudTools.add(matchedIndex);
    if (matchKind === "id") {
      toolIdMatches++;
      score += 900;
      if (localTool.signature === cloudTools[matchedIndex]!.signature) {
        toolSignatureMatches++;
        score += 260;
      }
    } else {
      toolSignatureMatches++;
      score += 620;
    }
  }

  for (const content of local.assistantContents) {
    if (!cloudContents.has(content)) continue;
    assistantMatches++;
    score += 220 + Math.min(300, content.length * 2);
  }

  const requiredIds = local.toolResultIds;
  if (requiredIds.size > 0 && ![...requiredIds].every((id) => cloudTools.some((tool) => tool.id === id))) {
    return null;
  }
  if (requiredIds.size > 0) score += 420;

  if (toolIdMatches === 0 && toolSignatureMatches === 0) return null;
  return { conversationId: detail.id, score, toolIdMatches, toolSignatureMatches, assistantMatches };
}

async function fetchConversationSummaries(options: {
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher: typeof fetch;
  maxConversations: number;
  requestTimeoutMs: number;
}): Promise<ConversationSummary[]> {
  const summaries: ConversationSummary[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  while (summaries.length < options.maxConversations) {
    const params = new URLSearchParams({ limit: "20" });
    if (cursor) params.set("cursor", cursor);
    const payload = await fetchJson(
      `${options.baseUrl}/conversation?${params}`,
      options.headers,
      options.fetcher,
      options.signal,
      options.requestTimeoutMs,
    );
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      const id = normalizeText(row?.id);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      summaries.push({
        id,
        modelKey: normalizeNullableText(row?.modelKey),
        state: normalizeNullableText(row?.state),
      });
      if (summaries.length >= options.maxConversations) break;
    }
    const nextCursor = normalizeText(payload?.meta?.nextCursor ?? payload?.nextCursor);
    if (!nextCursor || rows.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return summaries;
}

async function fetchConversationDetail(options: {
  baseUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  fetcher: typeof fetch;
  requestTimeoutMs: number;
  summary: ConversationSummary;
}): Promise<ConversationDetail | null> {
  const payload = await fetchJson(
    `${options.baseUrl}/conversation/${encodeURIComponent(options.summary.id)}`,
    options.headers,
    options.fetcher,
    options.signal,
    options.requestTimeoutMs,
  );
  if (!payload?.data || normalizeText(payload.data.id) !== options.summary.id) return null;
  return { ...options.summary, ...payload.data, id: options.summary.id };
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Postman conversation history timeout")), timeoutMs);
  try {
    const response = await fetcher(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Postman conversation history error (${response.status})`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Postman conversation history returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function containsToolResultBlock(message: ChatMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block && typeof block === "object" && block.type === "tool_result");
}

function collectToolResultIds(content: ChatMessage["content"], target: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
    const id = normalizeText(block.tool_use_id ?? block.tool_call_id);
    if (id) target.add(id);
  }
}

function renderMessageContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    return typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      return stableStringify(JSON.parse(trimmed));
    } catch {
      return trimmed.replace(/\r\n/g, "\n");
    }
  }
  return value === undefined || value === null ? "" : stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeState(value: unknown): string | null {
  const normalized = normalizeText(value).toUpperCase();
  return normalized || null;
}

function modelMatches(actual: unknown, expected: string | null): boolean {
  if (!expected) return true;
  const normalizedActual = normalizeText(actual).toUpperCase();
  return !normalizedActual || normalizedActual === expected.toUpperCase();
}

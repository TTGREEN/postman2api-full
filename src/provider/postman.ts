import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
  type StreamFailure,
} from "./base";
import type { Account } from "../db/schema";
import { config } from "../config";
import { POSTMAN_MODEL_MAP, POSTMAN_MODELS, resolvePostmanModel } from "./models";
import {
  isPostmanAgentModeUnavailable,
  isPostmanQuotaExceeded,
  PostmanStreamReader,
  type PostmanDelta,
} from "./sse-stream";
import type { PostmanTokens } from "./transcript";
import { extractTextFromMessage, isAnthropicToolResult } from "./transcript";
import {
  getConversationId,
  getConversationIdForToolCall,
  getToolCallGroupId,
  setConversationId,
  setConversationIdForToolCall,
} from "./conversation-store";
import {
  recoverPostmanConversation,
  shouldAttemptPostmanConversationRecovery,
} from "./postman-conversation-recovery";

const LOOP_APPROVAL_QUERY = "Continue.";
const POSTMAN_APP_VERSION = process.env.POSTMAN_APP_VERSION?.trim();
const POSTMAN_NATIVE_TOOLS_HASH = process.env.POSTMAN_NATIVE_TOOLS_HASH?.trim();
const POSTMAN_NATIVE_TERMS_HASH = process.env.POSTMAN_NATIVE_TERMS_HASH?.trim();
// Keep the client identity used by the last known-good direct-tool payload.
// Postman's gateway validates tool forwarding against this metadata contract.
// Last verified against the Postman Web Agent Mode bundle. Keep this fallback
// current because the public shell does not always expose lazy AI chunks.
const BUNDLED_POSTMAN_APP_VERSION = "12.24.3-260819-0605";
const POSTMAN_CLIENT_APP_VERSION = POSTMAN_APP_VERSION
  || appVersionFromPostmanHash(POSTMAN_NATIVE_TOOLS_HASH)
  || appVersionFromPostmanHash(POSTMAN_NATIVE_TERMS_HASH)
  || BUNDLED_POSTMAN_APP_VERSION;
type PostmanMetadataSource = "configured" | "discovered" | "bundled";
const DEFAULT_POSTMAN_METADATA_SOURCE: PostmanMetadataSource =
  POSTMAN_APP_VERSION || POSTMAN_NATIVE_TOOLS_HASH || POSTMAN_NATIVE_TERMS_HASH
    ? "configured"
    : "bundled";
const POSTMAN_EXCLUDED_TOOLS = [
  "listDatasets", "createDataset", "previewDataset", "queryDatasetView",
  "deleteDataset", "getDatasetSchema", "createDatasetView", "deleteDatasetView",
  "runQuery", "insertDatasetRows", "modifyDatasetView", "refreshDatasource",
  "addDatasetSource", "editDatasetSource", "removeDatasetSource",
  "testDatasourceConnection", "listCloudMocks", "getCloudMock",
  "getCloudMockLogs", "renameCloudMock", "deleteCloudMock",
  "checkMockSlugAvailability", "createCloudMock", "listWorkspaceDocs",
  "getWorkspaceDoc", "createWorkspaceDoc", "updateWorkspaceDoc",
  "deleteWorkspaceDoc", "askUser",
];
interface PostmanClientMetadata {
  appVersion: string;
  nativeToolsHash: string;
  nativeTermsHash: string;
  excludedTools: string[];
  excludedKBTerms: string[];
  source: PostmanMetadataSource;
}
const DEFAULT_POSTMAN_CLIENT_METADATA: PostmanClientMetadata = {
  appVersion: POSTMAN_CLIENT_APP_VERSION,
  nativeToolsHash: POSTMAN_NATIVE_TOOLS_HASH
    || `clienttools-workspace_v12-browser-${BUNDLED_POSTMAN_APP_VERSION}-8e1a98909421`,
  nativeTermsHash: POSTMAN_NATIVE_TERMS_HASH
    || `kbterms-workspace_v12-browser-${BUNDLED_POSTMAN_APP_VERSION}-2e5f1dc41e2f`,
  excludedTools: POSTMAN_EXCLUDED_TOOLS,
  excludedKBTerms: ["DATASETS"],
  source: DEFAULT_POSTMAN_METADATA_SOURCE,
};
const CHAT_ENDPOINT = "/_gw/chat";
const REQUEST_TIMEOUT_MS = 300_000;
const TTFB_TIMEOUT_MS = 45_000;
const AGENT_MODE_SETTING_TIMEOUT_MS = 10_000;
const AGENT_MODE_PROPAGATION_DELAY_MS = 1_500;
const MAX_QUERY_LEN = 9_500;
// Postman rejects any single seedingMessages entry longer than 10_000 chars with
// INPUT_VALIDATION_ERROR: Forbidden, and only accepts exactly one user/assistant pair.
const MAX_CONTEXT_LEN = 9_500;
// Priming segments travel in `input.query`, which rejects anything at or near
// 10_000 chars. Leave headroom for the per-segment wrapper text.
const PRIMING_SEGMENT_LEN = 8_500;
const MAX_POSTMAN_TOOL_DESCRIPTION_LEN = 2_000;
const MAX_COMPACT_POSTMAN_TOOL_DESCRIPTION_LEN = 512;
const MAX_POSTMAN_PARAMETER_NAME_LEN = 64;
const MAX_POSTMAN_SCHEMA_DEPTH = 8;
const MAX_POSTMAN_SCHEMA_PROPERTIES = 128;
const MAX_POSTMAN_ENUM_VALUES = 128;
// Diagnostics use bounded partitions to distinguish a bad individual tool from
// a rejected full list. The real request must stay under one third-party server
// entry because Postman rejects multiple synthetic server groups together.
const MAX_POSTMAN_TOOLS_PER_GROUP = 20;
// Reserve one slot for a dispatcher when the client sends more tools than the
// verified Postman single-group budget. This keeps one third-party group while
// still allowing the model to reach tools outside the directly forwarded set.
const POSTMAN_DISPATCH_DIRECT_TOOL_BUDGET = Math.max(1, MAX_POSTMAN_TOOLS_PER_GROUP - 1);
const POSTMAN_DISPATCH_TOOL_BASE_NAME = "postman_tool_dispatch";
const MAX_MCP_ISOLATION_PROBES = 16;
const MAX_MCP_ISOLATION_CANDIDATES = 4;

const TRANSIENT_ERROR_PATTERNS = [
  "too much data",
  "too large",
  "input too large",
  "context length exceeded",
  "rate limit",
];

interface PostmanMCPTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface PostmanForwardedToolDirectory {
  tools: PostmanMCPTool[];
  dispatcherName?: string;
}

interface PostmanDispatcherInvocation {
  toolName: string;
  argumentsText: string;
}

interface PostmanParameterNameMap {
  properties: Record<string, {
    sourceName: string;
    child?: PostmanParameterNameMap;
  }>;
  items?: PostmanParameterNameMap;
}

interface SanitizedPostmanSchema {
  schema: Record<string, any>;
  nameMap: PostmanParameterNameMap;
}

export interface NormalizedPostmanTool extends PostmanMCPTool {
  sourceName?: string;
}

interface PostmanToolResponse {
  toolCallId: string;
  content: string;
  toolResponseSummary: string;
  toolResponseStatus: "SUCCESS" | "FAILED";
  toolResponseFailureType?: "HANDLED_ERROR";
}

type McpProbeStatus = "pass" | "fail" | "skipped";

interface McpDiagnosticProbeResult {
  status: McpProbeStatus;
  error?: string;
  httpStatus?: number;
  responseKind?: "sse" | "json" | "unknown";
  payloadBytes?: number;
}

interface McpToolPartitionProbe {
  index: number;
  toolCount: number;
  result: McpDiagnosticProbeResult;
}

interface McpToolCountProbe {
  toolCount: number;
  result: McpDiagnosticProbeResult;
}

interface McpToolIsolationProbe {
  partition: number;
  startIndex: number;
  endIndex: number;
  toolCount: number;
  names: string[];
  result: McpDiagnosticProbeResult;
}

interface McpForbiddenDiagnostic {
  original: McpDiagnosticProbeResult;
  pureChat: McpDiagnosticProbeResult;
  noopTool: McpDiagnosticProbeResult;
  partitionProbes: McpToolPartitionProbe[];
  countProbes: McpToolCountProbe[];
  isolatedProbes: McpToolIsolationProbe[];
  originalToolCount: number;
  originalToolGroupCount: number;
  toolShapeSummary: string;
  metadataSource: PostmanMetadataSource;
  fallbackMetadataUsed: boolean;
  conclusion: string;
}

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {},
};

export interface AgentModeSettingResult {
  success: boolean;
  enabled: boolean;
  cached?: boolean;
  error?: string;
}

function appVersionHeader(version = POSTMAN_APP_VERSION): Record<string, string> {
  return version ? { "x-app-version": version } : {};
}

function normalizeThinkingLevel(value: unknown): "low" | "medium" | "high" {
  const normalized = String(value || "high").toLowerCase();
  if (normalized === "low") return "low";
  if (normalized === "medium") return "medium";
  return "high";
}

/**
 * Accepts OpenAI function tools, Anthropic/custom tools, and MCP
 * tools/list namespace shapes, then emits the MCP-like schema expected by
 * Postman Agent Mode's `clientTools.thirdParty["proxy-tools"].tools`.
 */
export function normalizePostmanTools(tools?: unknown[]): NormalizedPostmanTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];

  const normalized: NormalizedPostmanTool[] = [];
  const seenNames = new Set<string>();
  const seenSourceNames = new Set<string>();

  const visit = (tool: any, namespace?: string) => {
    if (!tool || typeof tool !== "object") return;

    const nested = Array.isArray(tool.tools)
      ? tool.tools
      : Array.isArray(tool.functions)
        ? tool.functions
        : undefined;
    if (nested) {
      const nestedNamespace = namespace
        ? `${namespace}.${safeToolName(tool.name)}`
        : safeToolName(tool.name);
      for (const child of nested) visit(child, nestedNamespace || namespace);
      return;
    }

    const functionDefinition = tool.function && typeof tool.function === "object"
      ? tool.function
      : tool;
    const rawName = firstNonEmptyString(
      functionDefinition.name,
      tool.name,
      tool.function_name,
    );
    if (!rawName) return;

    const sourceName = namespace && !rawName.includes(".")
      ? `${namespace}.${rawName}`
      : rawName;
    if (seenSourceNames.has(sourceName)) return;
    seenSourceNames.add(sourceName);
    const name = uniquePostmanToolName(sourceName, seenNames);

    const rawParameters =
      functionDefinition.parameters
      ?? functionDefinition.input_schema
      ?? functionDefinition.inputSchema
      ?? tool.parameters
      ?? tool.input_schema
      ?? tool.inputSchema;
    const parameters = normalizeToolParameters(rawParameters);
    const description = firstNonEmptyStringPreservingWhitespace(
      functionDefinition.description,
      tool.description,
      sourceName,
    ) || sourceName;

    normalized.push({
      name,
      ...(sourceName === name ? {} : { sourceName }),
      description,
      parameters,
    });
  };

  for (const tool of tools) visit(tool);
  return normalized;
}

export class PostmanProvider extends BaseProvider {
  private readonly agentModeSettingCache = new Map<string, number>();
  private readonly clientMetadataCache = new Map<string, PostmanClientMetadata>();
  name = "postman" as const;
  override nativeFormat: "openai" | "anthropic" = "openai";
  supportedModels: ModelInfo[] = POSTMAN_MODELS;

  override ownsModel(model: string): boolean {
    return model.toLowerCase() in POSTMAN_MODEL_MAP;
  }

  private resolveModel(model: string): string | null | undefined {
    return resolvePostmanModel(model);
  }

  private getTokens(account: Account): PostmanTokens | null {
    try {
      const tokens =
        typeof account.tokens === "string"
          ? JSON.parse(account.tokens)
          : account.tokens;
      if (!tokens || typeof tokens !== "object") return null;
      const { postman_sid, user_id, workspace_id, workspace_subdomain } = tokens;
      if (!postman_sid || !user_id || !workspace_id || !workspace_subdomain) return null;
      return {
        postman_sid: String(postman_sid),
        user_id: String(user_id),
        workspace_id: String(workspace_id),
        workspace_subdomain: String(workspace_subdomain),
        user_name: tokens.user_name ? String(tokens.user_name) : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildHeaders(tokens: PostmanTokens, metadata = DEFAULT_POSTMAN_CLIENT_METADATA): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(metadata.source === "bundled" ? {} : appVersionHeader(metadata.appVersion)),
      "x-pstmn-req-service": "agent-mode-service",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/`,
    };
  }

  private buildUsageHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...appVersionHeader(),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/billing/add-ons/overview`,
    };
  }

  private buildSettingsHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...appVersionHeader(),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/`,
    };
  }

  private buildClientMetadataHeaders(tokens: PostmanTokens): Record<string, string> {
    const subdomain = tokens.workspace_subdomain;
    return {
      Cookie: `postman.sid=${tokens.postman_sid}`,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...appVersionHeader(),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Origin: `https://${subdomain}.postman.co`,
      Referer: `https://${subdomain}.postman.co/`,
    };
  }

  private async resolveClientMetadata(tokens: PostmanTokens, signal?: AbortSignal): Promise<PostmanClientMetadata> {
    const cacheKey = `${tokens.workspace_subdomain}:${tokens.workspace_id}`;
    const cached = this.clientMetadataCache.get(cacheKey);
    if (cached) return cached;

    let metadata = DEFAULT_POSTMAN_CLIENT_METADATA;
    const needsDiscovery = !POSTMAN_NATIVE_TOOLS_HASH || !POSTMAN_NATIVE_TERMS_HASH;
    if (needsDiscovery) {
      try {
        const rootUrl = `https://${tokens.workspace_subdomain}.postman.co/`;
        const response = await fetch(rootUrl, {
          method: "GET",
          headers: this.buildClientMetadataHeaders(tokens),
          signal: signal ?? AbortSignal.timeout(AGENT_MODE_SETTING_TIMEOUT_MS),
        });
        if (response.ok) {
          const html = await response.text();
          metadata = mergePostmanClientMetadata(metadata, extractPostmanClientMetadata(html));

          if (!signal?.aborted && (!POSTMAN_NATIVE_TOOLS_HASH || !POSTMAN_NATIVE_TERMS_HASH)) {
            const assetUrls = extractPostmanAssetUrls(html, rootUrl);
            for (const assetUrl of assetUrls) {
              if (signal?.aborted) break;
              try {
                const assetResponse = await fetch(assetUrl, {
                  method: "GET",
                  headers: this.buildClientMetadataHeaders(tokens),
                  signal: signal ?? AbortSignal.timeout(AGENT_MODE_SETTING_TIMEOUT_MS),
                });
                if (!assetResponse.ok) continue;
                const assetText = await assetResponse.text();
                metadata = mergePostmanClientMetadata(metadata, extractPostmanClientMetadata(assetText));
                if (metadata.source === "discovered"
                  && metadata.nativeToolsHash !== DEFAULT_POSTMAN_CLIENT_METADATA.nativeToolsHash
                  && metadata.nativeTermsHash !== DEFAULT_POSTMAN_CLIENT_METADATA.nativeTermsHash) {
                  break;
                }
              } catch {
                // One stale or unavailable chunk must not hide hashes in later chunks.
              }
            }
          }
        }
      } catch {
        // The bundled hashes remain usable when the public shell is unavailable.
      }
    }

    this.clientMetadataCache.set(cacheKey, metadata);
    return metadata;
  }

  private buildThirdPartyTools(
    tools?: any[],
    compact = false,
  ): Record<string, { tools: PostmanMCPTool[] }> {
    const mcpTools = buildPostmanForwardedToolDirectory(tools, compact).tools;
    if (mcpTools.length === 0) return {};
    return { "proxy-tools": { tools: mcpTools } };
  }

  private async recoverConversationForToolContinuation(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
  ): Promise<void> {
    if (!request._sessionId || !shouldAttemptPostmanConversationRecovery(request.messages)) return;

    const candidateToolResponses = collectTrailingToolResponses(request.messages);
    const existingConversationId = getConversationId(account.id, request._sessionId)
      ?? candidateToolResponses
        .map((toolResponse) => getConversationIdForToolCall(account.id, toolResponse.toolCallId))
        .find((candidate): candidate is string => Boolean(candidate));
    if (existingConversationId) return;

    const recovery = await recoverPostmanConversation({
      tokens,
      messages: request.messages,
      expectedModelKey: postmanModel,
      headers: {
        ...this.buildHeaders(tokens),
        Accept: "application/json",
      },
      signal: request.signal,
    });
    if (recovery.recovered && recovery.conversationId) {
      setConversationId(account.id, request._sessionId, recovery.conversationId);
    }
  }

  private findNormalizedPostmanTool(
    request: ChatCompletionRequest,
    postmanToolName: string,
  ): NormalizedPostmanTool | undefined {
    const normalized = normalizePostmanTools(request.tools);
    const candidates = new Set<string>([postmanToolName]);
    const withoutGroupPrefix = postmanToolName.replace(/^proxy-tools(?:-\d+)?[.:/]/, "");
    if (withoutGroupPrefix !== postmanToolName) candidates.add(withoutGroupPrefix);

    for (const candidateName of candidates) {
      const direct = normalized.find((tool) =>
        tool.name === candidateName || tool.sourceName === candidateName,
      );
      if (direct) return direct;
    }
    return undefined;
  }

  private restoreClientToolName(request: ChatCompletionRequest, postmanToolName: string): string {
    const tool = this.findNormalizedPostmanTool(request, postmanToolName);
    return tool?.sourceName || tool?.name || postmanToolName;
  }

  private restoreClientToolArguments(
    request: ChatCompletionRequest,
    postmanToolName: string,
    argumentsText: string,
  ): string {
    if (!argumentsText) return argumentsText;
    const tool = this.findNormalizedPostmanTool(request, postmanToolName);
    if (!tool) return argumentsText;

    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsText);
    } catch {
      return argumentsText;
    }

    const restored = restorePostmanParameterNames(
      parsed,
      createSanitizedPostmanSchema(tool.parameters).nameMap,
    );
    return JSON.stringify(restored);
  }

  private restoreClientToolCall(
    request: ChatCompletionRequest,
    postmanToolName: string,
    argumentsText: string,
  ): { name: string; arguments: string } {
    const directory = buildPostmanForwardedToolDirectory(request.tools);
    const normalizedPostmanName = stripPostmanToolGroupPrefix(postmanToolName);
    if (directory.dispatcherName && normalizedPostmanName === directory.dispatcherName) {
      const invocation = parsePostmanDispatcherInvocation(argumentsText);
      if (invocation) {
        const target = this.findNormalizedPostmanTool(request, invocation.toolName);
        if (target) {
          return {
            name: target.sourceName || target.name,
            arguments: this.restoreClientToolArguments(request, target.name, invocation.argumentsText),
          };
        }
      }
    }

    return {
      name: this.restoreClientToolName(request, postmanToolName),
      arguments: this.restoreClientToolArguments(request, postmanToolName, argumentsText),
    };
  }

  private restoreStreamingToolDelta(
    request: ChatCompletionRequest,
    delta: PostmanDelta,
    dispatcherIndexes = new Set<number>(),
  ): PostmanDelta | null {
    if (!delta.tool_calls?.length) return delta;
    const directory = buildPostmanForwardedToolDirectory(request.tools);
    const toolCalls = delta.tool_calls.filter((toolCall) => {
      const postmanName = toolCall.function?.name;
      const isDispatcher = dispatcherIndexes.has(toolCall.index)
        || Boolean(
          postmanName
          && directory.dispatcherName
          && stripPostmanToolGroupPrefix(postmanName) === directory.dispatcherName,
        );
      if (isDispatcher) dispatcherIndexes.add(toolCall.index);
      return !isDispatcher;
    }).map((toolCall) => ({
      ...toolCall,
      function: toolCall.function
        ? {
          ...toolCall.function,
          ...(toolCall.function.name
            ? { name: this.restoreClientToolName(request, toolCall.function.name) }
            : {}),
        }
        : toolCall.function,
    }));

    if (toolCalls.length > 0) return { ...delta, tool_calls: toolCalls };
    const { tool_calls: _toolCalls, ...withoutToolCalls } = delta;
    return Object.keys(withoutToolCalls).length > 0 ? withoutToolCalls : null;
  }

  private buildRestoredDispatcherToolDelta(
    request: ChatCompletionRequest,
    toolCalls: Map<string, { id: string; name: string; postmanName: string; args: string }>,
  ): PostmanDelta | null {
    const directory = buildPostmanForwardedToolDirectory(request.tools);
    if (!directory.dispatcherName) return null;

    const restoredToolCalls = Array.from(toolCalls.entries())
      .filter(([, toolCall]) =>
        stripPostmanToolGroupPrefix(toolCall.postmanName || toolCall.name) === directory.dispatcherName,
      )
      .map(([index, toolCall], fallbackIndex) => {
        const restored = this.restoreClientToolCall(
          request,
          toolCall.postmanName || toolCall.name,
          toolCall.args,
        );
        const numericIndex = Number(index);
        return {
          index: Number.isFinite(numericIndex) ? numericIndex : fallbackIndex,
          id: toolCall.id,
          type: "function" as const,
          function: { name: restored.name, arguments: restored.arguments },
        };
      });

    return restoredToolCalls.length > 0 ? { tool_calls: restoredToolCalls } : null;
  }


  private splitMessages(
    messages: ChatMessage[],
    conversationId: string | null,
    accountId?: number | string,
  ): {
    query: string;
    seedingMessages: [{ role: "user"; content: string }, { role: "assistant"; content: string }] | null;
    toolResponses: PostmanToolResponse[];
  } {
    const lastMsg = messages[messages.length - 1];
    const isToolResultTail = lastMsg?.role === "tool" || isAnthropicToolResult(lastMsg);
    const hasConversationId = Boolean(conversationId);
    const toolResponses = isToolResultTail ? collectTrailingToolResponses(messages, accountId) : [];

    let query: string;
    let queryMsgIdx: number;

    if (isToolResultTail) {
      const resultsBlock = renderTrailingToolResults(messages);

      if (hasConversationId && toolResponses.length > 0) {
        return { query: "", seedingMessages: null, toolResponses };
      }

      query = resultsBlock
        ? `${resultsBlock}\n\nProcess these tool results and continue.`
        : "Continue the conversation.";
      queryMsgIdx = -1;
    } else {
      const idx = findLastIndex(messages, (m) => m.role === "user");
      queryMsgIdx = idx;
      const raw = idx >= 0 ? extractTextFromMessage(messages[idx]!.content) : "";
      query = raw.length > MAX_QUERY_LEN ? raw.slice(-MAX_QUERY_LEN) : raw;
    }

    if (hasConversationId) {
      return { query, seedingMessages: null, toolResponses: [] };
    }

    const contextParts = renderContextParts(messages, queryMsgIdx);
    if (contextParts.length === 0) return { query, seedingMessages: null, toolResponses: [] };

    const { content, dropped } = buildSeedingContext(contextParts);
    if (!content) return { query, seedingMessages: null, toolResponses: [] };
    if (dropped > 0) {
      warnContextTruncated({
        droppedChars: dropped,
        keptChars: content.length,
        limit: MAX_CONTEXT_LEN,
        priming: config.postmanContextPriming ? "failed-or-skipped" : "disabled",
      });
    }

    return {
      query,
      seedingMessages: [
        { role: "user" as const, content },
        { role: "assistant" as const, content: "I have the full conversation history above and will continue from where we left off." },
      ],
      toolResponses: [],
    };
  }

  /**
   * Postman caps a single request at ~10k chars per field, but not the conversation
   * as a whole. So instead of slicing a long history down to fit one seeding
   * message, push it upstream as several sequential turns on one conversationId
   * and let the real question land on a fully-primed conversation.
   */
  private async ensurePrimedConversation(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
  ): Promise<void> {
    if (!config.postmanContextPriming) return;
    if (request._primedConversationId) return;
    if (getConversationId(String(account.id), request._sessionId)) return;

    const primed = await this.primeConversation(request, tokens, postmanModel);
    if (!primed) return;

    request._primedConversationId = primed;
    if (request._sessionId) setConversationId(account.id, request._sessionId, primed);
  }

  private async primeConversation(
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
  ): Promise<string | null> {
    const messages = request.messages;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "tool" || isAnthropicToolResult(lastMsg)) return null;

    const queryMsgIdx = findLastIndex(messages, (m) => m.role === "user");
    const parts = renderContextParts(messages, queryMsgIdx);
    if (parts.length === 0) return null;

    const totalLen = parts.reduce((sum, part) => sum + part.text.length + 2, 0);
    if (totalLen <= MAX_CONTEXT_LEN) return null;

    const segments = splitContextForPriming(parts.map(relabelForPriming));
    if (segments.length === 0) return null;
    if (segments.length > config.postmanContextPrimingMaxSegments) {
      warnContextTruncated({
        reason: "priming-segment-cap-exceeded",
        segments: segments.length,
        maxSegments: config.postmanContextPrimingMaxSegments,
        totalChars: totalLen,
      });
      return null;
    }

    let conversationId: string | null = null;
    for (const [i, segment] of segments.entries()) {
      const label = `part ${i + 1} of ${segments.length}`;
      const query = primingWrapper(label, segment);
      const id = await this.sendPrimingSegment(tokens, postmanModel, query, conversationId, request.signal);
      if (!id) {
        warnContextTruncated({
          reason: "priming-aborted",
          failedSegment: label,
          totalChars: totalLen,
        });
        return null;
      }
      conversationId = id;
    }
    return conversationId;
  }

  private async sendPrimingSegment(
    tokens: PostmanTokens,
    postmanModel: string | null,
    query: string,
    conversationId: string | null,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const body = {
      input: {
        chatType: "USER_QUERY",
        query,
        toolResponse: "",
        useCase: null,
        conversationId,
        agent: null,
        product: "workspace_v12",
        startedFrom: "CHAT_INPUT",
      },
      platform: "WEB",
      clientTools: { native: [] },
      clientKBTerms: { native: [] },
      mandatoryContext: { workspaceId: tokens.workspace_id },
      selectedContext: [],
      backgroundContext: [],
      userSettings: { ai_user_agent_mode: true },
      devModeOptions: {
        selectedModel: postmanModel,
        isParallelToolCallingSupported: false,
        autoRun: false,
        supportsAskUser: false,
        supportsActionRecommendations: false,
        useThinkingModeIfAvailable: false,
        isLoopApprovalEnabled: true,
        enableWebAccess: true,
        agentMode: true,
        agentModeEnabled: true,
        ai_user_agent_mode: true,
      },
    };

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        {
          method: "POST",
          headers: this.buildHeaders(tokens, DEFAULT_POSTMAN_CLIENT_METADATA),
          body: JSON.stringify(body),
        },
        REQUEST_TIMEOUT_MS, TTFB_TIMEOUT_MS, signal,
        { verbose: config.postmanFetchVerbose, context: "Postman context priming" },
      );
      if (!response.ok) return null;

      const reader = new PostmanStreamReader();
      const responseText = await response.text();
      for (const line of responseText.split("\n")) {
        if (line.trim()) reader.feed(line);
      }
      if (reader.error || reader.quotaExceeded) return null;
      return reader.conversationId ?? conversationId;
    } catch {
      return null;
    }
  }


  private buildRequestBody(
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    accountId: string,
    metadata = DEFAULT_POSTMAN_CLIENT_METADATA,
  ): any {
    const candidateToolResponses = collectTrailingToolResponses(request.messages);
    const conversationId = request._primedConversationId
      ?? getConversationId(accountId, request._sessionId)
      ?? candidateToolResponses
        .map((toolResponse) => getConversationIdForToolCall(accountId, toolResponse.toolCallId))
        .find((candidate): candidate is string => Boolean(candidate))
      ?? null;
    const { query, seedingMessages, toolResponses } = this.splitMessages(request.messages, conversationId, accountId);
    const thirdParty = this.buildThirdPartyTools(
      request.tools,
      Boolean((request as any)._postmanCompactToolRetry),
    );
    const hasTools = Object.keys(thirdParty).length > 0;
    const isToolResponse = toolResponses.length > 0;
    const useToolContext = hasTools || isToolResponse;
    // A bundled hash is only a compatibility fallback. Sending it as if it
    // were the current Postman client contract can make tool validation fail
    // after Postman updates. Keep the original direct-tool envelope until the
    // current client metadata has been discovered or explicitly configured.
    const useLegacyToolEnvelope = metadata.source === "bundled";
    const useLegacyAgentModeFlags = !useToolContext || useLegacyToolEnvelope;
    const thinkingLevel = normalizeThinkingLevel(request.reasoning_effort ?? (request.thinking as any)?.effort);

    const input: any = {
      chatType: isToolResponse ? "TOOL_RESPONSE" : "USER_QUERY",
      query,
      toolResponse: "",
      useCase: null,
      conversationId,
      agent: null,
      product: "workspace_v12",
      startedFrom: "CHAT_INPUT",
    };

    if (!conversationId && seedingMessages) {
      input.seedingMessages = seedingMessages;
    }
    if (conversationId && (request as any)._postmanLoopApproval) {
      // Upstream gated the auto-run loop. Re-enter the same conversation as a
      // plain query so generation resumes instead of returning an empty turn.
      input.chatType = "USER_QUERY";
      input.query = LOOP_APPROVAL_QUERY;
      input.toolResponse = "";
    } else if (conversationId && toolResponses.length >= 1) {
      // Upstream rejects an `input.toolResponses` array with a bare
      // INPUT_VALIDATION_ERROR, so parallel results are merged into the single
      // flat field keyed by tool call id.
      const [primary] = toolResponses;
      input.toolCallId = primary!.toolCallId;
      input.toolResponse = toolResponses.length === 1
        ? primary!.content
        : JSON.stringify(toolResponses.map((entry) => ({
          toolCallId: entry.toolCallId,
          status: entry.toolResponseStatus,
          content: entry.content,
        })));
      input.toolResponseSummary = toolResponses.length === 1
        ? primary!.toolResponseSummary
        : `${toolResponses.length} tool calls completed`;
      input.toolResponseStatus = toolResponses.some((entry) => entry.toolResponseStatus === "FAILED")
        ? "FAILED"
        : "SUCCESS";
      const failureType = toolResponses.find((entry) => entry.toolResponseFailureType)?.toolResponseFailureType;
      if (failureType) input.toolResponseFailureType = failureType;
      const toolCallGroupId = resolveToolCallGroupId(request.messages, toolResponses, accountId);
      if (toolCallGroupId) input.toolCallGroupId = toolCallGroupId;
    }

    const body: any = {
      input,
      platform: "WEB",
      clientTools: useToolContext
        ? useLegacyToolEnvelope
          ? {
            native: [],
            ...(hasTools ? { thirdParty } : {}),
          }
          : {
            nativeToolsHash: metadata.nativeToolsHash,
            excludedTools: metadata.excludedTools,
            ...(hasTools ? { thirdParty } : {}),
          }
        : {
          native: [],
        },
      clientKBTerms: useToolContext
        ? useLegacyToolEnvelope
          ? { native: [] }
          : {
            nativeTermsHash: metadata.nativeTermsHash,
            excludedKBTerms: metadata.excludedKBTerms,
          }
        : {
          native: [],
        },
      mandatoryContext: {
        workspaceId: tokens.workspace_id,
      },
      selectedContext: [],
      backgroundContext: [],
      ...(useLegacyAgentModeFlags ? {
        userSettings: {
          ai_user_agent_mode: true,
        },
      } : {}),
      devModeOptions: {
        selectedModel: postmanModel,
        // Must stay false. With parallel tool calling advertised, upstream expects
        // the whole tool-call group answered via `input.toolResponses`, which this
        // route rejects with INPUT_VALIDATION_ERROR: Forbidden. A single flat
        // `input.toolResponse` then leaves the group unfulfilled and the model is
        // told the call was rejected, so it re-issues the same call forever.
        isParallelToolCallingSupported: false,
        autoRun: hasTools && !isToolChoiceNone(request.tool_choice),
        supportsAskUser: false,
        supportsActionRecommendations: useToolContext,
        useThinkingModeIfAvailable: true,
        thinkingLevel,
        ...(useLegacyAgentModeFlags ? {
          isLoopApprovalEnabled: true,
          enableWebAccess: true,
        } : {}),
        ...(useLegacyAgentModeFlags ? {
          agentMode: true,
          agentModeEnabled: true,
          ai_user_agent_mode: true,
        } : {}),
      },
      ...(useToolContext ? { availableSkills: [] } : {}),
    };

    return body;
  }

  private buildMcpDiagnosticRequest(
    request: ChatCompletionRequest,
    kind: "pure-chat" | "noop-tool",
  ): ChatCompletionRequest {
    const diagnosticRequest = this.buildMcpDiagnosticBaseRequest(request, kind);

    if (kind === "pure-chat") {
      delete (diagnosticRequest as any).tools;
    } else {
      (diagnosticRequest as any).tools = [{
        type: "function",
        function: {
          name: "noop",
          description: "No-op diagnostic tool",
          parameters: { ...EMPTY_TOOL_PARAMETERS },
        },
      }];
    }

    return diagnosticRequest;
  }

  private buildMcpToolPartitionRequest(
    request: ChatCompletionRequest,
    tools: PostmanMCPTool[],
    index: string | number,
  ): ChatCompletionRequest {
    return {
      ...this.buildMcpDiagnosticBaseRequest(request, `partition-${index}`),
      tools,
    } as ChatCompletionRequest;
  }

  private buildMcpToolCountRequest(
    request: ChatCompletionRequest,
    tools: PostmanMCPTool[],
    count: number,
  ): ChatCompletionRequest {
    return this.buildMcpToolPartitionRequest(
      request,
      tools.slice(0, count),
      `count-${count}`,
    );
  }

  private async isolateRejectedTools(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    metadata: PostmanClientMetadata,
    partition: number,
    globalOffset: number,
    tools: PostmanMCPTool[],
    rootResult: McpDiagnosticProbeResult,
  ): Promise<McpToolIsolationProbe[]> {
    const candidates: McpToolIsolationProbe[] = [];
    let probesRemaining = MAX_MCP_ISOLATION_PROBES;

    const visit = async (
      subset: PostmanMCPTool[],
      subsetOffset: number,
      parentResult: McpDiagnosticProbeResult,
    ): Promise<void> => {
      if (candidates.length >= MAX_MCP_ISOLATION_CANDIDATES) return;
      if (subset.length <= 1) {
        const index = subsetOffset + 1;
        candidates.push({
          partition,
          startIndex: index,
          endIndex: index,
          toolCount: subset.length,
          names: subset.map((tool) => tool.name),
          result: parentResult,
        });
        return;
      }

      const midpoint = Math.ceil(subset.length / 2);
      const halves = [
        { tools: subset.slice(0, midpoint), offset: subsetOffset },
        { tools: subset.slice(midpoint), offset: subsetOffset + midpoint },
      ];
      let failedHalf = false;

      for (const [halfIndex, half] of halves.entries()) {
        if (probesRemaining <= 0 || candidates.length >= MAX_MCP_ISOLATION_CANDIDATES) break;
        probesRemaining -= 1;
        const result = await this.runMcpDiagnosticProbe(
          account,
          this.buildMcpToolPartitionRequest(request, half.tools, `${partition}-bisect-${halfIndex}`),
          tokens,
          postmanModel,
          metadata,
        );
        if (result.status !== "fail") continue;
        failedHalf = true;
        await visit(half.tools, half.offset, result);
      }

      if (!failedHalf && candidates.length < MAX_MCP_ISOLATION_CANDIDATES) {
        candidates.push({
          partition,
          startIndex: globalOffset + 1,
          endIndex: globalOffset + subset.length,
          toolCount: subset.length,
          names: [subset[0]!.name, subset[subset.length - 1]!.name],
          result: parentResult,
        });
      }
    };

    await visit(tools, globalOffset, rootResult);
    return candidates;
  }

  private buildMcpDiagnosticBaseRequest(
    request: ChatCompletionRequest,
    kind: string,
  ): ChatCompletionRequest {
    return {
      ...request,
      stream: false,
      messages: [{ role: "user", content: "Reply with OK." }],
      _sessionId: `diagnostic:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      tool_choice: undefined,
    } as ChatCompletionRequest;
  }

  private async runMcpDiagnosticProbe(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    metadata: PostmanClientMetadata,
  ): Promise<McpDiagnosticProbeResult> {
    try {
      // The original request may already be cancelled after the client sees the
      // first upstream delta. Diagnostics still need a bounded chance to explain
      // the rejection instead of being rewritten as "Client disconnected".
      const diagnosticSignal = AbortSignal.timeout(30_000);
      const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id), metadata);
      const serializedBody = JSON.stringify(body);
      const payloadBytes = new TextEncoder().encode(serializedBody).byteLength;
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens, metadata), body: serializedBody },
        30_000, 15_000, diagnosticSignal,
        { verbose: config.postmanFetchVerbose, context: "Postman MCP diagnostic" },
      );

      const statusResult = this.checkResponseStatus(response);
      const responseKind = responseKindFromContentType(response.headers.get("content-type"));
      if (statusResult) {
        return {
          status: "fail",
          error: statusResult.error,
          httpStatus: response.status,
          responseKind,
          payloadBytes,
        };
      }

      const text = await response.text();
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return {
          status: "fail",
          error: extractUpstreamError(text),
          httpStatus: response.status,
          responseKind: "json",
          payloadBytes,
        };
      }

      const reader = new PostmanStreamReader();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        reader.feed(line);
      }
      if (reader.quotaExceeded) {
        return {
          status: "fail",
          error: reader.error || "Postman AI quota exceeded",
          httpStatus: response.status,
          responseKind: "sse",
          payloadBytes,
        };
      }
      if (reader.error) {
        return {
          status: "fail",
          error: reader.error,
          httpStatus: response.status,
          responseKind: "sse",
          payloadBytes,
        };
      }
      if (!reader.sawEvent) {
        return {
          status: "fail",
          error: extractUpstreamError(text),
          httpStatus: response.status,
          responseKind: "sse",
          payloadBytes,
        };
      }
      return { status: "pass", httpStatus: response.status, responseKind: "sse", payloadBytes };
    } catch (error) {
      return {
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async diagnoseMcpForbidden(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    metadata: PostmanClientMetadata,
    original: McpDiagnosticProbeResult = { status: "fail", error: "original_request_failed" },
  ): Promise<McpForbiddenDiagnostic> {
    const pureChat = await this.runMcpDiagnosticProbe(
      account,
      this.buildMcpDiagnosticRequest(request, "pure-chat"),
      tokens,
      postmanModel,
      metadata,
    );

    const noopTool = pureChat.status === "pass"
      ? await this.runMcpDiagnosticProbe(
        account,
        this.buildMcpDiagnosticRequest(request, "noop-tool"),
        tokens,
        postmanModel,
        metadata,
      )
      : { status: "skipped", error: "pure_chat_failed" } satisfies McpDiagnosticProbeResult;

    const partitionTools = partitionPostmanTools(
      normalizePostmanTools(request.tools).map((tool) => preparePostmanToolForForwarding(tool)),
    );
    const normalizedTools = normalizePostmanTools(request.tools)
      .map((tool) => preparePostmanToolForForwarding(tool));
    const originalToolGroupCount = Object.keys(this.buildThirdPartyTools(request.tools)).length;
    const partitionProbes: McpToolPartitionProbe[] = [];
    const countProbes: McpToolCountProbe[] = [];
    const isolatedProbes: McpToolIsolationProbe[] = [];
    if (noopTool.status === "pass") {
      for (const [offset, toolsInPartition] of partitionTools.entries()) {
        const index = offset + 1;
        const result = await this.runMcpDiagnosticProbe(
          account,
          this.buildMcpToolPartitionRequest(request, toolsInPartition, index),
          tokens,
          postmanModel,
          metadata,
        );
        partitionProbes.push({ index, toolCount: toolsInPartition.length, result });
        if (result.status === "fail") {
          isolatedProbes.push(...await this.isolateRejectedTools(
            account,
            request,
            tokens,
            postmanModel,
            metadata,
            index,
            offset * MAX_POSTMAN_TOOLS_PER_GROUP,
            toolsInPartition,
            result,
          ));
        }
      }

      // Each partition passes independently in the real failure. Probe a
      // monotonic count ladder to distinguish a total-list limit from a bad
      // schema/name combination that only appears when tools are combined.
      const failedPartition = partitionProbes.some((probe) => probe.result.status === "fail");
      if (!failedPartition && normalizedTools.length > MAX_POSTMAN_TOOLS_PER_GROUP) {
        const probeCounts = [21, 25, 30, normalizedTools.length]
          .filter((count, index, values) => count <= normalizedTools.length && values.indexOf(count) === index);
        for (const toolCount of probeCounts) {
          const result = await this.runMcpDiagnosticProbe(
            account,
            this.buildMcpToolCountRequest(request, normalizedTools, toolCount),
            tokens,
            postmanModel,
            metadata,
          );
          countProbes.push({ toolCount, result });
        }
      }
    }

    const diagnostic: McpForbiddenDiagnostic = {
      original,
      pureChat,
      noopTool,
      partitionProbes,
      countProbes,
      isolatedProbes,
      originalToolCount: normalizePostmanTools(request.tools).length,
      originalToolGroupCount,
      toolShapeSummary: summarizePostmanToolShape(request.tools),
      metadataSource: postmanMetadataSource(metadata),
      fallbackMetadataUsed: usesFallbackPostmanMetadata(metadata),
      conclusion: "",
    };
    diagnostic.conclusion = buildMcpForbiddenConclusion(diagnostic);
    return diagnostic;
  }

  private async decorateMcpForbiddenResult(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    metadata: PostmanClientMetadata,
    error: string,
    original?: McpDiagnosticProbeResult,
  ): Promise<ProviderResult> {
    const diagnostic = await this.diagnoseMcpForbidden(
      account,
      request,
      tokens,
      postmanModel,
      metadata,
      original || { status: "fail", error },
    );
    return {
      success: false,
      error: `${error}\n${formatMcpForbiddenDiagnostic(diagnostic)}`,
      requestRejected: true,
      mcpRejected: true,
      ...(diagnostic.fallbackMetadataUsed ? { mcpFallbackUsed: true } : {}),
    };
  }

  private async decorateMcpForbiddenError(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    postmanModel: string | null,
    metadata: PostmanClientMetadata,
    error: string,
    original?: McpDiagnosticProbeResult,
  ): Promise<string> {
    const diagnostic = await this.diagnoseMcpForbidden(
      account,
      request,
      tokens,
      postmanModel,
      metadata,
      original || { status: "fail", error },
    );
    return `${error}\n${formatMcpForbiddenDiagnostic(diagnostic)}`;
  }

  async ensureAiUserAgentMode(account: Account): Promise<AgentModeSettingResult> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, enabled: false, error: "Invalid or missing Postman tokens" };

    const cacheKey = `${tokens.workspace_subdomain}:${tokens.user_id}`;
    if (this.agentModeSettingCache.has(cacheKey)) return { success: true, enabled: true, cached: true };

    try {
      const response = await fetch(
        `https://${tokens.workspace_subdomain}.postman.co/_api/user/settings/ai_user_agent_mode`,
        {
          method: "PUT",
          headers: this.buildSettingsHeaders(tokens),
          body: JSON.stringify({ value: true }),
          signal: AbortSignal.timeout(AGENT_MODE_SETTING_TIMEOUT_MS),
        },
      );

      if (response.ok) {
        this.agentModeSettingCache.set(cacheKey, Date.now());
        return { success: true, enabled: true };
      }

      if (response.status === 404 || response.status === 405) {
        // Some Postman tenants/versions do not expose this UI settings endpoint.
        // Do not block the real chat request: the Agent Mode payload below still
        // carries ai_user_agent_mode=true, and upstream chat will return the
        // authoritative account/tool error if the account is truly not enabled.
        this.agentModeSettingCache.set(cacheKey, Date.now());
        return { success: true, enabled: false, cached: true };
      }

      const text = await response.text().catch(() => "");
      const detail = extractUpstreamError(text);
      return {
        success: false,
        enabled: false,
        error: `Agent Mode setting failed (${response.status})${detail ? `: ${detail}` : ""}`,
      };
    } catch (error) {
      return {
        success: false,
        enabled: false,
        error: `Agent Mode setting failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async ensureAiUserAgentModeBeforeChat(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult | null> {
    const result = await this.ensureAiUserAgentMode(account);
    if (!result.success) {
      return {
        success: false,
        error: result.error || "Postman Agent Mode is not enabled for this account yet.",
        retryable: true,
      };
    }

    if (!result.cached) {
      await sleep(AGENT_MODE_PROPAGATION_DELAY_MS, request.signal);
    }
    return null;
  }

  private clearAgentModeSettingCache(tokens: PostmanTokens): void {
    this.agentModeSettingCache.delete(`${tokens.workspace_subdomain}:${tokens.user_id}`);
  }

  private async retryAfterAgentModeUnavailable(
    account: Account,
    request: ChatCompletionRequest,
    tokens: PostmanTokens,
    error: string,
    stream: boolean,
  ): Promise<ProviderResult | null> {
    if ((request as any)._agentModeRetryAttempted || !isPostmanAgentModeUnavailable(error)) return null;

    this.clearAgentModeSettingCache(tokens);
    const retryRequest = { ...request, _agentModeRetryAttempted: true } as ChatCompletionRequest;
    return stream
      ? this.chatCompletionStream(account, retryRequest)
      : this.chatCompletion(account, retryRequest);
  }

  private buildCompactToolRetryRequest(request: ChatCompletionRequest): ChatCompletionRequest | null {
    if ((request as any)._postmanCompactToolRetry) return null;
    const normalized = normalizePostmanTools(request.tools);
    if (normalized.length <= MAX_POSTMAN_TOOLS_PER_GROUP) return null;

    return {
      ...request,
      tools: normalized.map((tool) => ({
        type: "function",
        function: {
          name: tool.sourceName || tool.name,
          description: compactPostmanToolDescription(tool.description, tool.name),
          parameters: compactPostmanSchema(tool.parameters),
        },
      })),
      _postmanCompactToolRetry: true,
    } as ChatCompletionRequest;
  }

  private buildLoopApprovalRetryRequest(request: ChatCompletionRequest): ChatCompletionRequest | null {
    if ((request as any)._postmanLoopApproval) return null;
    return { ...request, _postmanLoopApproval: true } as ChatCompletionRequest;
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === undefined) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const agentModeReadiness = await this.ensureAiUserAgentModeBeforeChat(account, request);
    if (agentModeReadiness) return agentModeReadiness;

    const completionId = this.generateId();
    await this.recoverConversationForToolContinuation(account, request, tokens, postmanModel);
    const requestUsesToolForwarding = normalizePostmanTools(request.tools).length > 0;
    const clientMetadata = requestUsesToolForwarding
      ? await this.resolveClientMetadata(tokens, request.signal)
      : DEFAULT_POSTMAN_CLIENT_METADATA;
    await this.ensurePrimedConversation(account, request, tokens, postmanModel);
    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id), clientMetadata);
    logPostmanRequestShape(String(account.id), body);

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens, clientMetadata), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS, TTFB_TIMEOUT_MS, request.signal,
        { verbose: config.postmanFetchVerbose, context: "Postman chat" },
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;

      const responseText = await response.text();
      logPostmanResponseShape(responseText);
      const reader = new PostmanStreamReader();
      const deltas: PostmanDelta[] = [];

      for (const line of responseText.split("\n")) {
        if (!line.trim()) continue;
        deltas.push(...reader.feed(line));
      }

      if (reader.quotaExceeded) {
        return {
          success: false,
          error: reader.error || "Postman AI quota exceeded",
          quotaExhausted: true,
        };
      }
      if (reader.error) {
        const retryResult = await this.retryAfterAgentModeUnavailable(account, request, tokens, reader.error, false);
        if (retryResult) return retryResult;
        if (requestUsesToolForwarding && isPostmanInputValidationForbidden(reader.error)) {
          const compactRequest = this.buildCompactToolRetryRequest(request);
          if (compactRequest) return this.chatCompletion(account, compactRequest);
          return this.decorateMcpForbiddenResult(
            account,
            request,
            tokens,
            postmanModel,
            clientMetadata,
            reader.error,
            {
              status: "fail",
              error: reader.error,
              httpStatus: response.status,
              responseKind: responseKindFromContentType(response.headers.get("content-type")),
            },
          );
        }
        return {
          success: false,
          error: reader.error,
          ...(isPostmanInputValidationForbidden(reader.error) ? { requestRejected: true } : {}),
          ...(reader.retryableError ? { retryable: true } : {}),
        };
      }
      deltas.push(...reader.finish());

      if (reader.loopApproval && !reader.sawToolCall) {
        const approvalRetry = this.buildLoopApprovalRetryRequest(request);
        if (approvalRetry) return this.chatCompletion(account, approvalRetry);
      }

      let content = "";
      let reasoningContent = "";
      const toolCallAccum = new Map<string, { id: string; name: string; postmanName: string; args: string }>();

      for (const delta of deltas) {
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const key = String(tc.index);
            if (tc.id && !toolCallAccum.has(key)) {
              toolCallAccum.set(key, { id: tc.id, name: "", postmanName: "", args: "" });
            }
            const entry = toolCallAccum.get(key);
            if (entry) {
              if (tc.function?.name) {
                entry.postmanName = tc.function.name;
                entry.name = this.restoreClientToolName(request, tc.function.name);
              }
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
        }
      }

      const toolCalls = Array.from(toolCallAccum.values()).map((tc) => {
        const restored = this.restoreClientToolCall(request, tc.postmanName || tc.name, tc.args);
        return {
          id: tc.id,
          type: "function" as const,
          function: restored,
        };
      });

      if (!content && toolCalls.length === 0 && reader.loopApproval) {
        content = reader.loopApproval.message
          || "Postman agent mode paused this tool loop and asked for approval to continue.";
      }

      const message: any = { role: "assistant", content: content || null };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      if (reader.conversationId) {
        rememberConversationForToolCalls(
          account.id,
          request._sessionId,
          reader.conversationId,
          toolCalls,
          reader.toolCallGroupId,
        );
      }

      const upstreamTokens = reader.tokenUsage;
      const promptTokens = upstreamTokens?.promptTokens ?? this.estimateMessagesTokens(request.messages);
      const completionTokens = upstreamTokens?.completionTokens
        ?? this.estimateTokens(content + reasoningContent);
      const totalTokens = upstreamTokens?.totalTokens ?? promptTokens + completionTokens;

      const completionResponse: ChatCompletionResponse = {
        id: completionId, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : content ? "stop" : null }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      };

      return { success: true, response: completionResponse, promptTokens: completionResponse.usage.prompt_tokens, completionTokens: completionResponse.usage.completion_tokens, tokensUsed: completionResponse.usage.total_tokens, creditSource: "fixed", creditsUsed: 0 };
    } catch (error) {
      return { success: false, error: `Postman request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const postmanModel = this.resolveModel(request.model);
    if (postmanModel === undefined) return { success: false, error: `Invalid model: ${request.model}` };

    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Invalid or missing Postman tokens" };

    const agentModeReadiness = await this.ensureAiUserAgentModeBeforeChat(account, request);
    if (agentModeReadiness) return agentModeReadiness;

    const requestUsesToolForwarding = normalizePostmanTools(request.tools).length > 0;
    await this.recoverConversationForToolContinuation(account, request, tokens, postmanModel);
    const clientMetadata = requestUsesToolForwarding
      ? await this.resolveClientMetadata(tokens, request.signal)
      : DEFAULT_POSTMAN_CLIENT_METADATA;
    await this.ensurePrimedConversation(account, request, tokens, postmanModel);
    const body = this.buildRequestBody(request, tokens, postmanModel, String(account.id), clientMetadata);
    logPostmanRequestShape(String(account.id), body);

    try {
      const response = await this.fetchWithTimeout(
        `https://${tokens.workspace_subdomain}.postman.co${CHAT_ENDPOINT}`,
        { method: "POST", headers: this.buildHeaders(tokens, clientMetadata), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS, TTFB_TIMEOUT_MS, request.signal,
        { verbose: config.postmanFetchVerbose, context: "Postman chat" },
      );

      const statusResult = this.checkResponseStatus(response);
      if (statusResult) return statusResult;
      if (!response.body) return { success: false, error: "Postman returned no response body" };

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const text = await response.text();
        const error = extractUpstreamError(text);
        const retryResult = await this.retryAfterAgentModeUnavailable(account, request, tokens, error, true);
        if (retryResult) return retryResult;
        if (requestUsesToolForwarding && isPostmanInputValidationForbidden(error)) {
          return this.decorateMcpForbiddenResult(
            account,
            request,
            tokens,
            postmanModel,
            clientMetadata,
            error,
            { status: "fail", error, httpStatus: response.status, responseKind: "json" },
          );
        }
        return {
          success: false,
          error,
          ...(isPostmanInputValidationForbidden(error) ? { requestRejected: true } : {}),
          ...(isPostmanQuotaExceeded(text) || isPostmanQuotaExceeded(error)
            ? { quotaExhausted: true }
            : {}),
          ...(isPostmanAgentModeUnavailable(text) || isPostmanAgentModeUnavailable(error)
            ? { retryable: true }
            : {}),
        };
      }

      const completionId = this.generateId();
      const pmReader = new PostmanStreamReader();
      const upstreamReader = response.body.getReader();
      const decoder = new TextDecoder();
      let ndjsonBuffer = "";
      let rawPrefix = "";
      let upstreamDone = false;
      const initialDeltas: PostmanDelta[] = [];

      const feedLines = (lines: string[], output: PostmanDelta[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          output.push(...pmReader.feed(line));
        }
      };

      while (!upstreamDone && !initialDeltas.some(isMeaningfulDelta)) {
        const { done, value } = await upstreamReader.read();
        if (done) {
          upstreamDone = true;
          ndjsonBuffer += decoder.decode(new Uint8Array(0), { stream: false });
          feedLines(ndjsonBuffer.split("\n"), initialDeltas);
          break;
        }

        const decoded = decoder.decode(value, { stream: true });
        rawPrefix = (rawPrefix + decoded).slice(-65_536);
        ndjsonBuffer += decoded;
        const lines = ndjsonBuffer.split("\n");
        ndjsonBuffer = lines.pop() || "";
        feedLines(lines, initialDeltas);

        if (pmReader.quotaExceeded || pmReader.error) break;
      }

      if (pmReader.quotaExceeded) {
        await cancelReader(upstreamReader, "quota exhausted");
        return {
          success: false,
          error: pmReader.error || "Postman AI quota exceeded",
          quotaExhausted: true,
        };
      }
      if (pmReader.error) {
        await cancelReader(upstreamReader, pmReader.error);
        const retryResult = await this.retryAfterAgentModeUnavailable(account, request, tokens, pmReader.error, true);
        if (retryResult) return retryResult;
        if (requestUsesToolForwarding && isPostmanInputValidationForbidden(pmReader.error)) {
          const compactRequest = this.buildCompactToolRetryRequest(request);
          if (compactRequest) return this.chatCompletionStream(account, compactRequest);
          return this.decorateMcpForbiddenResult(
            account,
            request,
            tokens,
            postmanModel,
            clientMetadata,
            pmReader.error,
            { status: "fail", error: pmReader.error, httpStatus: response.status, responseKind: "sse" },
          );
        }
        return {
          success: false,
          error: pmReader.error,
          ...(isPostmanInputValidationForbidden(pmReader.error) ? { requestRejected: true } : {}),
          ...(pmReader.retryableError ? { retryable: true } : {}),
        };
      }
      if (upstreamDone && !pmReader.sawEvent) {
        upstreamReader.releaseLock();
        return { success: false, error: extractUpstreamError(rawPrefix || ndjsonBuffer) };
      }
      if (pmReader.loopApproval && !pmReader.sawToolCall) {
        const approvalRetry = this.buildLoopApprovalRetryRequest(request);
        if (approvalRetry) {
          if (pmReader.conversationId) {
            setConversationId(account.id, request._sessionId, pmReader.conversationId);
          }
          await cancelReader(upstreamReader, "loop approval gate");
          return this.chatCompletionStream(account, approvalRetry);
        }
      }
      if (pmReader.conversationId) {
        setConversationId(account.id, request._sessionId, pmReader.conversationId);
      }

      let cancelled = false;
      let closed = false;
      let released = false;
      let streamFailureHandler: ((failure: StreamFailure) => void | Promise<void>) | undefined;
      let pendingStreamFailure: StreamFailure | undefined;
      let lastStreamFailure: StreamFailure | undefined;
      let streamFailureReported = false;
      let streamContent = "";
      let streamReasoningContent = "";
      const streamToolCalls = new Map<string, { id: string; name: string; postmanName: string; args: string }>();

      const captureDelta = (delta: PostmanDelta) => {
        if (delta.content) streamContent += delta.content;
        if (delta.reasoning_content) streamReasoningContent += delta.reasoning_content;
        for (const toolCall of delta.tool_calls || []) {
          const key = String(toolCall.index);
          if (toolCall.id && !streamToolCalls.has(key)) {
            streamToolCalls.set(key, { id: toolCall.id, name: "", postmanName: "", args: "" });
          }
          const entry = streamToolCalls.get(key);
          if (!entry) continue;
          if (toolCall.function?.name) {
            entry.postmanName = toolCall.function.name;
            entry.name = this.restoreClientToolName(request, toolCall.function.name);
          }
          if (toolCall.function?.arguments) entry.args += toolCall.function.arguments;
        }
        if (pmReader.conversationId) {
          rememberConversationForToolCalls(
            account.id,
            request._sessionId,
            pmReader.conversationId,
            Array.from(streamToolCalls.values()),
            pmReader.toolCallGroupId,
          );
        }
      };

      const getStreamMessage = (): ChatMessage | undefined => {
        const toolCalls = Array.from(streamToolCalls.values()).map((toolCall) => ({
          id: toolCall.id,
          type: "function" as const,
          function: this.restoreClientToolCall(
            request,
            toolCall.postmanName || toolCall.name,
            toolCall.args,
          ),
        }));
        if (!streamContent && !streamReasoningContent && toolCalls.length === 0) return undefined;
        const message: any = { role: "assistant", content: streamContent || null };
        if (streamReasoningContent) message.reasoning_content = streamReasoningContent;
        if (toolCalls.length > 0) message.tool_calls = toolCalls;
        return message;
      };

      const getStreamTokenUsage = () => {
        const upstreamTokens = pmReader.tokenUsage;
        const promptTokens = upstreamTokens?.promptTokens ?? this.estimateMessagesTokens(request.messages);
        const toolArguments = Array.from(streamToolCalls.values())
          .map((toolCall) => toolCall.args)
          .join("");
        const completionTokens = upstreamTokens?.completionTokens
          ?? this.estimateTokens(streamContent + streamReasoningContent + toolArguments);
        return {
          promptTokens,
          completionTokens,
          totalTokens: upstreamTokens?.totalTokens ?? promptTokens + completionTokens,
        };
      };

      const decorateStreamError = async (message: string): Promise<string> => {
        if (!requestUsesToolForwarding || !isPostmanInputValidationForbidden(message)) {
          return message;
        }
        return this.decorateMcpForbiddenError(
          account,
          request,
          tokens,
          postmanModel,
          clientMetadata,
          message,
        );
      };

      const failStream = async (kind: StreamFailure["kind"], message: string): Promise<Error> => {
        const error = new Error(message);
        const failure = { kind, error };
        lastStreamFailure = failure;
        streamFailureReported = true;
        if (streamFailureHandler) {
          await streamFailureHandler(failure);
        } else {
          pendingStreamFailure = failure;
        }
        return error;
      };

      const releaseUpstreamReader = () => {
        if (released) return;
        try {
          upstreamReader.releaseLock();
          released = true;
        } catch {
          // A pending read may retain the lock; retry after cancellation settles.
        }
      };

      const provider = this;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          let dispatcherToolCallsEmitted = false;
          const dispatcherToolCallIndexes = new Set<number>();
          const emitRestoredDispatcherToolCalls = () => {
            if (dispatcherToolCallsEmitted || cancelled || closed) return;
            dispatcherToolCallsEmitted = true;
            const delta = provider.buildRestoredDispatcherToolDelta(request, streamToolCalls);
            if (delta) controller.enqueue(encoder.encode(buildSSEChunk(delta, completionId, request.model)));
          };
          const emit = (delta: PostmanDelta) => {
            if (!cancelled && !closed) {
              captureDelta(delta);
              const clientDelta = provider.restoreStreamingToolDelta(
                request,
                delta,
                dispatcherToolCallIndexes,
              );
              if (clientDelta) {
                controller.enqueue(encoder.encode(buildSSEChunk(clientDelta, completionId, request.model)));
              }
            }
          };
          try {
            for (const delta of initialDeltas) emit(delta);

            if (upstreamDone) {
              emitRestoredDispatcherToolCalls();
              for (const delta of pmReader.finish()) emit(delta);
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              closed = true;
              controller.close();
              return;
            }

            while (!cancelled && !closed) {
              const { done, value } = await upstreamReader.read();
              if (cancelled || closed) break;
              if (done) {
                ndjsonBuffer += decoder.decode(new Uint8Array(0), { stream: false });
                for (const line of ndjsonBuffer.split("\n")) {
                  if (!line.trim()) continue;
                  for (const delta of pmReader.feed(line)) emit(delta);
                }
                if (pmReader.quotaExceeded) {
                  throw await failStream(
                    "quota_exhausted",
                    pmReader.error || "Postman AI quota exceeded",
                  );
                }
                if (pmReader.error) {
                  throw await failStream("upstream_error", await decorateStreamError(pmReader.error));
                }
                if (pmReader.conversationId) {
                  rememberConversationForToolCalls(
                    account.id,
                    request._sessionId,
                    pmReader.conversationId,
                    Array.from(streamToolCalls.values()),
                    pmReader.toolCallGroupId,
                  );
                }
                emitRestoredDispatcherToolCalls();
                for (const delta of pmReader.finish()) emit(delta);
                if (!cancelled) {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  closed = true;
                  controller.close();
                }
                break;
              }
              ndjsonBuffer += decoder.decode(value, { stream: true });
              const lines = ndjsonBuffer.split("\n");
              ndjsonBuffer = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                for (const delta of pmReader.feed(line)) emit(delta);
              }
              if (pmReader.quotaExceeded) {
                throw await failStream(
                  "quota_exhausted",
                  pmReader.error || "Postman AI quota exceeded",
                );
              }
              if (pmReader.error) {
                throw await failStream("upstream_error", await decorateStreamError(pmReader.error));
              }
              if (pmReader.conversationId) {
                rememberConversationForToolCalls(
                  account.id,
                  request._sessionId,
                  pmReader.conversationId,
                  Array.from(streamToolCalls.values()),
                  pmReader.toolCallGroupId,
                );
              }
            }
          } catch (error) {
            if (!cancelled && !closed) {
              if (!streamFailureReported) {
                const message = error instanceof Error ? error.message : String(error);
                await failStream("upstream_error", message);
              }
              closed = true;
              controller.error(error);
            }
          } finally {
            releaseUpstreamReader();
          }
        },
        async cancel(reason) {
          if (cancelled || closed) return;
          cancelled = true;
          try {
            await upstreamReader.cancel(reason);
          } catch {
            // Cancellation is best-effort; never leave a rejected promise unhandled.
          } finally {
            releaseUpstreamReader();
          }
        },
      });

      return {
        success: true,
        stream,
        getStreamMessage,
        getStreamTokenUsage,
        getStreamFailure: () => lastStreamFailure,
        setStreamFailureHandler: (handler) => {
          streamFailureHandler = handler;
          if (pendingStreamFailure) {
            const failure = pendingStreamFailure;
            pendingStreamFailure = undefined;
            return handler(failure);
          }
        },
      };
    } catch (error) {
      return { success: false, error: `Postman stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private checkResponseStatus(response: Response): ProviderResult | null {
    if (response.status === 401 || response.status === 403) return { success: false, error: `Postman auth failed (${response.status})` };
    if (response.status === 429) {
      return {
        success: false,
        error: "Postman rate limited",
        rateLimited: true,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }
    if (response.status >= 500) return { success: false, error: `Postman server error (${response.status})` };
    if (!response.ok) return { success: false, error: `Postman API error (${response.status})` };
    return null;
  }

  async refreshToken(_account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Postman sessions require manual re-login in the browser." };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return this.getTokens(account) !== null;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: {
      limit: number;
      remaining: number;
      used: number;
      resetAt?: Date | string | null;
      overageAllowed?: boolean;
    };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) return { success: false, error: "Missing tokens" };

    try {
      const body = JSON.stringify({
        service: "usage",
        method: "get",
        path: `/teams/${tokens.workspace_id}/operations/ai_millicredits/usage`,
      });

      const response = await fetch(
        `https://${tokens.workspace_subdomain}.postman.co/_api/ws/proxy`,
        {
          method: "POST",
          // The usage proxy rejects the chat-only x-pstmn-req-service header.
          headers: this.buildUsageHeaders(tokens),
          body,
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          success: false,
          error: `Quota API error: ${response.status}${extractQuotaApiError(text) ? ` - ${extractQuotaApiError(text)}` : ""}`,
        };
      }

      const data = (await response.json()) as any;
      const blocks = Array.isArray(data?.data) ? data.data : [];
      const teamBlock = blocks.find((block: any) => block?.entity_type === "team");
      const entity = teamBlock?.entities?.[0] ?? data?.data?.entity ?? data?.data;
      if (!entity) return { success: false, error: "No team quota entity found" };

      const rawLimit = firstFiniteNumber(
        entity.limit,
        entity.quota,
        entity.total_limit,
        entity.credit_limit,
      );
      const rawUsage = firstFiniteNumber(
        entity.usage,
        entity.used,
        entity.consumed,
        entity.total_usage,
      );
      const rawSpillage = firstFiniteNumber(
        entity.spillage,
        entity.overage_usage,
        entity.excess_usage,
      ) ?? 0;
      const rawRemaining = firstFiniteNumber(
        entity.remaining,
        entity.remaining_credits,
        entity.credits_remaining,
        entity.quota_remaining,
      );
      const unitDivisor = String(entity.name || "").toLowerCase() === "ai_millicredits" ? 1000 : 1;
      const limitValue = rawLimit === undefined ? undefined : rawLimit / unitDivisor;
      const usageValue = rawUsage === undefined ? undefined : rawUsage / unitDivisor;
      const spillageValue = rawSpillage / unitDivisor;
      const remainingValue = rawRemaining === undefined ? undefined : rawRemaining / unitDivisor;
      const effectiveUsage = usageValue === undefined ? undefined : usageValue + spillageValue;
      const remaining = remainingValue ?? (
        limitValue !== undefined && effectiveUsage !== undefined
          ? Math.max(0, limitValue - effectiveUsage)
          : undefined
      );
      if (remaining === undefined) {
        return { success: false, error: "Quota response did not contain a remaining balance" };
      }

      const used = effectiveUsage ?? Math.max(0, (limitValue ?? remaining) - remaining);
      const limit = limitValue ?? used + remaining;
      const overageAllowed = firstBoolean(
        entity.allowOverage,
        entity.overage_allowed,
        entity.overages_enabled,
        entity.overage_enabled,
        entity.payg_enabled,
        entity.pay_as_you_go_enabled,
        entity.allow_overage,
      ) ?? false;

      return {
        success: true,
        quota: {
          limit,
          remaining: Math.max(0, remaining),
          used,
          overageAllowed,
          resetAt: entity.reset_at ?? entity.resetAt ?? entity.billing_period_end ?? null,
        },
      };
    } catch (error) {
      return { success: false, error: `Quota fetch failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) return { kind: "missing_tokens", success: false, error: "Postman token blob incomplete or invalid" };

    const quotaResult = await this.fetchQuota(account);
    if (!quotaResult.success || !quotaResult.quota) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: quotaResult.error || "Postman quota is temporarily unavailable",
      };
    }

    const q = quotaResult.quota;
    return {
      kind: q.remaining <= 0 && !q.overageAllowed ? "exhausted" : "healthy",
      success: true,
      quota: { ...q, source: "postman.dynamic" } as any,
    };
  }
}

function mergePostmanClientMetadata(
  base: PostmanClientMetadata,
  discovered: Partial<PostmanClientMetadata>,
): PostmanClientMetadata {
  const nativeToolsHash = POSTMAN_NATIVE_TOOLS_HASH || discovered.nativeToolsHash || base.nativeToolsHash;
  const nativeTermsHash = POSTMAN_NATIVE_TERMS_HASH || discovered.nativeTermsHash || base.nativeTermsHash;
  return {
    appVersion: POSTMAN_APP_VERSION
      || discovered.appVersion
      || appVersionFromPostmanHash(nativeToolsHash)
      || appVersionFromPostmanHash(nativeTermsHash)
      || base.appVersion,
    nativeToolsHash,
    nativeTermsHash,
    excludedTools: discovered.excludedTools || base.excludedTools,
    excludedKBTerms: discovered.excludedKBTerms || base.excludedKBTerms,
    source: POSTMAN_NATIVE_TOOLS_HASH || POSTMAN_NATIVE_TERMS_HASH
      ? "configured"
      : discovered.nativeToolsHash || discovered.nativeTermsHash
        ? "discovered"
        : base.source,
  };
}

function extractPostmanClientMetadata(text: string): Partial<PostmanClientMetadata> {
  const nativeToolsHash = firstRegex(text, /clienttools-workspace_v12-browser-[A-Za-z0-9._-]+-[a-f0-9]{8,}/i);
  const nativeTermsHash = firstRegex(text, /kbterms-workspace_v12-browser-[A-Za-z0-9._-]+-[a-f0-9]{8,}/i);
  const appVersion = POSTMAN_APP_VERSION
    || firstRegex(text, /(?:x-app-version|APP_VERSION|app_version|appVersion)["']?\s*[:=]\s*["']?([0-9]+\.[0-9]+\.[0-9]+-[0-9]+-[0-9]+)/i)
    || appVersionFromPostmanHash(nativeToolsHash)
    || appVersionFromPostmanHash(nativeTermsHash);
  return {
    ...(appVersion ? { appVersion } : {}),
    ...(nativeToolsHash ? { nativeToolsHash } : {}),
    ...(nativeTermsHash ? { nativeTermsHash } : {}),
  };
}

function extractPostmanAssetUrls(html: string, rootUrl: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /(?:src|href|data-src|data-href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi,
    /["']([^"']+\.js(?:\?[^"']*)?)["']/gi,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      try {
        urls.add(new URL(match[1]!, rootUrl).toString());
      } catch {
        // Ignore malformed asset URLs.
      }
    }
  }
  return [...urls];
}

function isToolChoiceNone(value: unknown): boolean {
  if (value === "none") return true;
  return Boolean(
    value
    && typeof value === "object"
    && String((value as Record<string, unknown>).type || "").toLowerCase() === "none",
  );
}

function postmanMetadataSource(metadata: PostmanClientMetadata): PostmanMetadataSource {
  if (metadata.source) return metadata.source;
  return usesFallbackPostmanMetadata(metadata) ? "bundled" : "discovered";
}

function usesFallbackPostmanMetadata(metadata: PostmanClientMetadata): boolean {
  return postmanMetadataSourceWithoutRecursion(metadata) === "bundled";
}

function postmanMetadataSourceWithoutRecursion(metadata: PostmanClientMetadata): PostmanMetadataSource {
  if (metadata.source) return metadata.source;
  return metadata.nativeToolsHash === DEFAULT_POSTMAN_CLIENT_METADATA.nativeToolsHash
    || metadata.nativeTermsHash === DEFAULT_POSTMAN_CLIENT_METADATA.nativeTermsHash
    ? "bundled"
    : "discovered";
}

function appVersionFromPostmanHash(hash?: string): string | undefined {
  if (!hash) return undefined;
  const match = /(?:clienttools|kbterms)-workspace_v12-browser-(.+)-[a-f0-9]{8,}$/i.exec(hash);
  return match?.[1];
}

export interface ContextPart {
  kind: "system" | "history";
  text: string;
}

function renderContextParts(messages: ChatMessage[], skipIdx: number): ContextPart[] {
  const parts: ContextPart[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (i === skipIdx) continue;
    const text = extractTextFromMessage(msg.content);

    if (msg.role === "system") {
      if (text) parts.push({ kind: "system", text: `[System]\n${text}` });
    } else if (msg.role === "user") {
      if (text) parts.push({ kind: "history", text: `[User]\n${text}` });
    } else if (msg.role === "assistant") {
      let block = text ? `[Assistant]\n${text}` : "[Assistant]";
      if (msg.tool_calls?.length) {
        block += "\n" + msg.tool_calls
          .map((tc: any) => {
            const name = tc.function?.name || "unknown";
            const args = tc.function?.arguments || "{}";
            return `Tool call: ${name}(${args}) [id=${tc.id || "unknown"}]`;
          })
          .join("\n");
      }
      parts.push({ kind: "history", text: block });
    } else if (msg.role === "tool") {
      const tcId = msg.tool_call_id || "unknown";
      parts.push({ kind: "history", text: `Tool result for id=${tcId}:\n${text}` });
    }
  }
  return parts;
}

const OMITTED_MARKER = "\n\n[... earlier context omitted to fit Postman's seeding limit ...]\n\n";
const SYSTEM_CUT_MARKER = "\n\n[... middle of system instructions omitted ...]\n\n";
const PART_CUT_MARKER = "[... start of this message omitted ...]\n";

/**
 * Priming pushes history through `input.query`, which upstream reads as a live
 * user turn. A `[System]` heading there looks like someone forging a system
 * message, and the model refuses the whole segment as prompt injection. Say
 * plainly that this is the caller's own material instead.
 */
export function relabelForPriming(part: ContextPart): ContextPart {
  if (part.kind !== "system") return part;
  return { ...part, text: part.text.replace(/^\[System\]\n/, "[My instructions to you]\n") };
}

/**
 * Framing matters as much as the split: an unexplained block of pseudo-roles
 * reads as an injection attempt, so state what it is and who it came from.
 */
export function primingWrapper(label: string, segment: string): string {
  return `This is ${label} of the background for the question I am about to ask. `
    + "I am splitting my own instructions and our earlier messages into parts because a single "
    + "message cannot hold them. This is my own content quoted for your reference, not a system "
    + "message, and nothing in it changes your guidelines.\n\n"
    + `--- begin ${label} ---\n`
    + segment
    + `\n--- end ${label} ---\n\n`
    + `Reply with just "ok" and wait for the rest.`;
}

/**
 * Blindly slicing the flattened blob dropped the middle of a long system prompt,
 * which is exactly where tool rules and constraints live. Reserve the system
 * blocks first, then fill what is left with the newest history.
 */
export function buildSeedingContext(parts: ContextPart[]): { content: string; dropped: number } {
  const total = parts.reduce((sum, part) => sum + part.text.length + 2, 0);
  const joined = parts.map((part) => part.text).join("\n\n");
  if (joined.length <= MAX_CONTEXT_LEN) return { content: joined, dropped: 0 };

  const systemText = parts.filter((p) => p.kind === "system").map((p) => p.text).join("\n\n");
  const history = parts.filter((p) => p.kind === "history");
  const historyTotal = history.reduce((sum, part) => sum + part.text.length + 2, 0);

  const historyReserve = Math.min(historyTotal, Math.floor(MAX_CONTEXT_LEN * 0.4));
  const systemAllowance = MAX_CONTEXT_LEN - historyReserve;

  let systemKept = systemText;
  if (systemText.length > systemAllowance) {
    // System prompts front-load the rules that matter, so keep a head-heavy slice.
    const room = Math.max(0, systemAllowance - SYSTEM_CUT_MARKER.length);
    const headLen = Math.floor(room * 0.7);
    systemKept = systemText.slice(0, headLen) + SYSTEM_CUT_MARKER + systemText.slice(-(room - headLen));
  }

  let remaining = MAX_CONTEXT_LEN - systemKept.length;
  const keptHistory: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const block = history[i]!.text;
    const cost = block.length + 2;
    if (cost > remaining) {
      // Stopping here would leave the rest of the budget unused, which for a single
      // huge message means throwing away thousands of chars of the newest turn.
      // Salvage its tail, which is the part closest to the live question.
      const room = remaining - PART_CUT_MARKER.length - 2;
      if (room > 200) {
        keptHistory.unshift(PART_CUT_MARKER + block.slice(-room));
        remaining = 0;
      }
      break;
    }
    keptHistory.unshift(block);
    remaining -= cost;
  }

  const segments = [systemKept];
  if (keptHistory.length < history.length) segments.push(OMITTED_MARKER.trim());
  segments.push(...keptHistory);
  const content = segments.filter(Boolean).join("\n\n").slice(0, MAX_CONTEXT_LEN);
  return { content, dropped: Math.max(0, total - content.length) };
}

/** Split context into chunks that each fit in a single upstream `query` field. */
export function splitContextForPriming(parts: ContextPart[]): string[] {
  const segments: string[] = [];
  let current = "";
  const flush = () => {
    if (current) segments.push(current);
    current = "";
  };
  for (const part of parts) {
    let text = part.text;
    while (text.length > PRIMING_SEGMENT_LEN) {
      flush();
      segments.push(text.slice(0, PRIMING_SEGMENT_LEN));
      text = text.slice(PRIMING_SEGMENT_LEN);
    }
    if (!text) continue;
    if (current.length + text.length + 2 > PRIMING_SEGMENT_LEN) flush();
    current = current ? `${current}\n\n${text}` : text;
  }
  flush();
  return segments;
}

function warnContextTruncated(details: Record<string, unknown>): void {
  // Deliberately not gated behind POSTMAN_FETCH_VERBOSE: dropping context changes
  // the answer, so it must never be a silent 200.
  console.warn("[proxy] context-truncated", details);
}

function firstRegex(text: string, re: RegExp): string | undefined {
  const match = re.exec(text);
  return match?.[1] || match?.[0];
}

function collectTrailingToolResponses(
  messages: ChatMessage[],
  _accountId?: number | string,
): PostmanToolResponse[] {
  const responses: PostmanToolResponse[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const toolCallId = firstNonEmptyString(message.tool_call_id);
      if (!toolCallId) break;
      const isError = Boolean((message as any).is_error || (message as any).isError);
      responses.unshift(buildPostmanToolResponse(
        toolCallId,
        renderMessageContent(message.content),
        isError,
      ));
      continue;
    }

    if (isAnthropicToolResult(message) && Array.isArray(message.content)) {
      const blocks = message.content.filter((block: any) => block?.type === "tool_result");
      for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
        const block = blocks[blockIndex];
        const toolCallId = firstNonEmptyString(block?.tool_use_id, block?.tool_call_id);
        if (!toolCallId) continue;
        const isError = Boolean(block?.is_error || block?.isError);
        responses.unshift(buildPostmanToolResponse(
          toolCallId,
          renderUnknownValue(block?.content),
          isError,
        ));
      }
    }
    break;
  }
  return responses;
}

function resolveToolCallGroupId(
  messages: ChatMessage[],
  toolResponses: PostmanToolResponse[],
  accountId: number | string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: any = messages[index];
    const direct = firstNonEmptyString(
      message?.toolCallGroupId,
      message?.tool_call_group_id,
      message?.groupId,
      message?.group_id,
    );
    if (direct) return direct;

    if (!Array.isArray(message?.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const groupId = firstNonEmptyString(
        toolCall?.toolCallGroupId,
        toolCall?.tool_call_group_id,
        toolCall?.groupId,
        toolCall?.group_id,
      );
      if (groupId) return groupId;
    }
  }

  for (const toolResponse of toolResponses) {
    const groupId = getToolCallGroupId(accountId, toolResponse.toolCallId);
    if (groupId) return groupId;
  }
  return undefined;
}

function rememberConversationForToolCalls(
  accountId: number | string,
  sessionId: string | undefined,
  conversationId: string,
  toolCalls: Array<{ id?: unknown }>,
  toolCallGroupId?: string | null,
): void {
  if (sessionId) setConversationId(accountId, sessionId, conversationId);
  for (const toolCall of toolCalls) {
    if (typeof toolCall.id === "string" && toolCall.id.trim()) {
      setConversationIdForToolCall(accountId, toolCall.id, conversationId, toolCallGroupId || undefined);
    }
  }
}

function buildPostmanToolResponse(
  toolCallId: string,
  content: string,
  isError: boolean,
): PostmanToolResponse {
  return {
    toolCallId,
    content,
    toolResponseSummary: isError ? "Tool call failed" : "Tool call completed",
    toolResponseStatus: isError ? "FAILED" : "SUCCESS",
    ...(isError ? { toolResponseFailureType: "HANDLED_ERROR" as const } : {}),
  };
}

function renderTrailingToolResults(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "tool") {
      const label = (message as any).is_error || (message as any).isError
        ? "Tool Error"
        : "Tool Result";
      parts.unshift(`[${label} id=${message.tool_call_id || ""}]\n${renderMessageContent(message.content)}`);
      continue;
    }
    if (isAnthropicToolResult(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "tool_result") continue;
        const label = block.is_error || block.isError ? "Tool Error" : "Tool Result";
        parts.unshift(
          `[${label} id=${block.tool_use_id || block.tool_call_id || ""}]\n${renderUnknownValue(block.content)}`,
        );
      }
      continue;
    }
    break;
  }
  return parts.join("\n\n");
}

function renderMessageContent(content: ChatMessage["content"] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : renderUnknownValue(content);

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      parts.push(renderUnknownValue(block));
      continue;
    }
    if (
      ["text", "input_text", "output_text"].includes(String(block.type))
      && typeof block.text === "string"
    ) {
      parts.push(block.text);
      continue;
    }
    if (block.type === "tool_result") {
      const label = block.is_error || block.isError ? "Tool Error" : "Tool Result";
      parts.push(
        `[${label} id=${block.tool_use_id || block.tool_call_id || ""}]\n`
        + renderUnknownValue(block.content),
      );
      continue;
    }
    parts.push(renderUnknownValue(block));
  }
  return parts.join("\n");
}

function renderUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function buildSSEChunk(delta: PostmanDelta, completionId: string, model: string): string {
  const chunk: StreamChunk = {
    id: completionId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: delta as any, finish_reason: delta.finish_reason ?? null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function uniquePostmanToolName(sourceName: string, seenNames: Set<string>): string {
  const base = sanitizePostmanToolName(sourceName);
  let name = base;
  let suffix = 2;
  while (seenNames.has(name)) {
    const tail = `_${suffix++}`;
    name = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`;
  }
  seenNames.add(name);
  return name;
}

function sanitizePostmanToolName(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const limited = sanitized.slice(0, 64);
  return limited || "tool";
}

function sanitizePostmanToolDescription(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, MAX_POSTMAN_TOOL_DESCRIPTION_LEN);
  return normalized || fallback;
}

function compactPostmanToolDescription(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, MAX_COMPACT_POSTMAN_TOOL_DESCRIPTION_LEN);
  return normalized || fallback;
}

function compactPostmanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactPostmanSchema);
  if (!value || typeof value !== "object") return value;

  const compacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "description") continue;
    compacted[key] = compactPostmanSchema(child);
  }
  return compacted;
}

function preparePostmanToolForForwarding(
  tool: NormalizedPostmanTool,
  compact = false,
): PostmanMCPTool {
  const { sourceName: _sourceName, ...forwarded } = tool;
  return {
    ...forwarded,
    description: compact
      ? compactPostmanToolDescription(tool.description, tool.name)
      : sanitizePostmanToolDescription(tool.description, tool.name),
    parameters: compact
      ? compactPostmanSchema(sanitizePostmanToolParameters(tool.parameters)) as Record<string, unknown>
      : sanitizePostmanToolParameters(tool.parameters),
  };
}

function buildPostmanForwardedToolDirectory(
  tools?: unknown[],
  compact = false,
): PostmanForwardedToolDirectory {
  const normalized = normalizePostmanTools(tools);
  if (normalized.length === 0) return { tools: [] };

  if (normalized.length <= MAX_POSTMAN_TOOLS_PER_GROUP) {
    return { tools: normalized.map((tool) => preparePostmanToolForForwarding(tool, compact)) };
  }

  const directTools = normalized
    .slice(0, POSTMAN_DISPATCH_DIRECT_TOOL_BUDGET)
    .map((tool) => preparePostmanToolForForwarding(tool, compact));
  const hiddenTools = normalized
    .slice(POSTMAN_DISPATCH_DIRECT_TOOL_BUDGET)
    .map((tool) => preparePostmanToolForForwarding(tool, compact));
  const usedNames = new Set(normalized.map((tool) => tool.name));
  const dispatcherName = uniquePostmanToolName(POSTMAN_DISPATCH_TOOL_BASE_NAME, usedNames);

  return {
    tools: [
      ...directTools,
      buildPostmanDispatcherTool(dispatcherName, hiddenTools, compact),
    ],
    dispatcherName,
  };
}

function buildPostmanDispatcherTool(
  dispatcherName: string,
  hiddenTools: PostmanMCPTool[],
  compact = false,
): PostmanMCPTool {
  const catalog = hiddenTools.map((tool) => {
    const schema = JSON.stringify(compactPostmanSchema(tool.parameters));
    return `${tool.name}: ${compactPostmanToolDescription(tool.description, tool.name)} args=${schema}`;
  }).join("; ");
  const rawDescription = `Dispatch one additional tool by exact name. Pass arguments as a JSON object string. Available tools: ${catalog}`;
  const description = compact
    ? compactPostmanToolDescription(rawDescription, "Dispatch an additional tool by name and JSON arguments.")
    : sanitizePostmanToolDescription(rawDescription, "Dispatch an additional tool by name and JSON arguments.");
  const dispatcherParameters = {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description: "Exact forwarded tool name from the available tools catalog.",
      },
      arguments: {
        type: "string",
        description: "JSON object containing the selected tool arguments. Use {} when there are no arguments.",
      },
    },
    required: ["tool_name", "arguments"],
    additionalProperties: false,
  };

  return {
    name: dispatcherName,
    description,
    parameters: compact
      ? compactPostmanSchema(dispatcherParameters) as Record<string, unknown>
      : dispatcherParameters,
  };
}

function parsePostmanDispatcherInvocation(argumentsText: string): PostmanDispatcherInvocation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText || "{}");
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const value = parsed as Record<string, unknown>;
  const rawToolName = value.tool_name ?? value.toolName ?? value.name;
  if (typeof rawToolName !== "string" || !rawToolName.trim()) return null;

  const rawArguments = value.arguments ?? value.args ?? value.input ?? {};
  const normalizedArguments = typeof rawArguments === "string"
    ? rawArguments
    : JSON.stringify(rawArguments) || "{}";
  return { toolName: rawToolName.trim(), argumentsText: normalizedArguments };
}

function stripPostmanToolGroupPrefix(value: string): string {
  return value.replace(/^proxy-tools(?:-\d+)?[.:/]/, "");
}

function partitionPostmanTools(tools: PostmanMCPTool[]): PostmanMCPTool[][] {
  const partitions: PostmanMCPTool[][] = [];
  for (let offset = 0; offset < tools.length; offset += MAX_POSTMAN_TOOLS_PER_GROUP) {
    partitions.push(tools.slice(offset, offset + MAX_POSTMAN_TOOLS_PER_GROUP));
  }
  return partitions;
}

function requiresPostmanToolCompatibility(tool: NormalizedPostmanTool): boolean {
  return tool.description.length > MAX_POSTMAN_TOOL_DESCRIPTION_LEN
    || hasUnsupportedPostmanSchema(tool.parameters);
}

function hasUnsupportedPostmanSchema(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (depth >= MAX_POSTMAN_SCHEMA_DEPTH) return true;
  if (Array.isArray(value)) return value.some((child) => hasUnsupportedPostmanSchema(child, depth + 1, seen));

  const node = value as Record<string, unknown>;
  if (["$ref", "$defs", "definitions", "anyOf", "oneOf", "allOf"].some((key) => key in node)) {
    return true;
  }
  if (typeof node.description === "string" && node.description.length > MAX_POSTMAN_TOOL_DESCRIPTION_LEN) {
    return true;
  }
  if (Array.isArray(node.enum)) {
    if (node.enum.length > MAX_POSTMAN_ENUM_VALUES) return true;
    if (node.enum.some((item) => !["string", "number", "boolean"].includes(typeof item))) return true;
  }

  if (Array.isArray(node.type)) return true;
  if (typeof node.type === "string" && !["string", "number", "integer", "boolean", "object", "array"].includes(node.type)) {
    return true;
  }

  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    const properties = node.properties as Record<string, unknown>;
    if (Object.keys(properties).length > MAX_POSTMAN_SCHEMA_PROPERTIES) return true;
    for (const name of Object.keys(properties)) {
      if (
        name.trim() !== name
        || !name
        || name.length > MAX_POSTMAN_PARAMETER_NAME_LEN
        || !/^[A-Za-z0-9_-]+$/.test(name)
        || isForbiddenPostmanPropertyName(name)
      ) {
        return true;
      }
    }

    if (Array.isArray(node.required)) {
      const propertyNames = new Set(Object.keys(properties));
      if (node.required.some((name) => typeof name !== "string" || !propertyNames.has(name))) return true;
    }
  }

  return Object.entries(node).some(([key, child]) => key !== "enum" && hasUnsupportedPostmanSchema(child, depth + 1, seen));
}

function summarizePostmanToolShape(tools?: unknown[]): string {
  const normalized = normalizePostmanTools(tools);
  const forwarded = normalized.map((tool) => preparePostmanToolForForwarding(tool));
  const rawMetrics = summarizeSchemaMetrics(normalized.map((tool) => tool.parameters));
  const forwardedMetrics = summarizeSchemaMetrics(forwarded.map((tool) => tool.parameters));
  const inputCount = Array.isArray(tools) ? tools.length : 0;
  const renamedCount = normalized.filter((tool) => tool.sourceName && tool.sourceName !== tool.name).length;
  const rawNameMax = normalized.reduce(
    (max, tool) => Math.max(max, (tool.sourceName || tool.name).length),
    0,
  );
  const forwardedNameMax = forwarded.reduce((max, tool) => Math.max(max, tool.name.length), 0);
  const rawDescriptionMax = normalized.reduce((max, tool) => Math.max(max, tool.description.length), 0);
  const forwardedDescriptionMax = forwarded.reduce((max, tool) => Math.max(max, tool.description.length), 0);

  return [
    `input:${inputCount}`,
    `normalized:${normalized.length}`,
    `forwarded:${forwarded.length}`,
    `renamed:${renamedCount}`,
    `raw_name_max:${rawNameMax}`,
    `name_max:${forwardedNameMax}`,
    `raw_desc_max:${rawDescriptionMax}`,
    `desc_max:${forwardedDescriptionMax}`,
    `raw_depth_max:${rawMetrics.maxDepth}`,
    `depth_max:${forwardedMetrics.maxDepth}`,
    `raw_props_max:${rawMetrics.maxProperties}`,
    `props_max:${forwardedMetrics.maxProperties}`,
    `raw_enum_max:${rawMetrics.maxEnumValues}`,
    `enum_max:${forwardedMetrics.maxEnumValues}`,
    `complex:${rawMetrics.complexNodes}`,
    `forwarded_complex:${forwardedMetrics.complexNodes}`,
  ].join(";");
}

interface PostmanSchemaMetrics {
  maxDepth: number;
  maxProperties: number;
  maxEnumValues: number;
  complexNodes: number;
}

function summarizeSchemaMetrics(values: unknown[]): PostmanSchemaMetrics {
  const metrics: PostmanSchemaMetrics = {
    maxDepth: 0,
    maxProperties: 0,
    maxEnumValues: 0,
    complexNodes: 0,
  };
  const seen = new WeakSet<object>();
  for (const value of values) walkSchemaMetrics(value, 0, metrics, seen);
  return metrics;
}

function walkSchemaMetrics(
  value: unknown,
  depth: number,
  metrics: PostmanSchemaMetrics,
  seen: WeakSet<object>,
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  metrics.maxDepth = Math.max(metrics.maxDepth, depth);

  if (Array.isArray(value)) {
    for (const child of value) walkSchemaMetrics(child, depth + 1, metrics, seen);
    return;
  }

  const node = value as Record<string, unknown>;
  if (Array.isArray(node.enum)) metrics.maxEnumValues = Math.max(metrics.maxEnumValues, node.enum.length);
  if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
    metrics.maxProperties = Math.max(metrics.maxProperties, Object.keys(node.properties).length);
  }
  if ("$ref" in node || "$defs" in node || "definitions" in node || "anyOf" in node || "oneOf" in node || "allOf" in node) {
    metrics.complexNodes += 1;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "enum") continue;
    walkSchemaMetrics(child, depth + 1, metrics, seen);
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function firstNonEmptyStringPreservingWhitespace(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    return value;
  }
  return undefined;
}

function safeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolParameters(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...EMPTY_TOOL_PARAMETERS };
  }

  const schema = { ...(parsed as Record<string, unknown>) };
  if (!schema.type) schema.type = "object";
  if (schema.type === "object" && (!schema.properties || typeof schema.properties !== "object")) {
    schema.properties = {};
  }
  return schema;
}

function sanitizePostmanToolParameters(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = createSanitizedPostmanSchema(value).schema;
  if (sanitized.type !== "object") {
    return { ...EMPTY_TOOL_PARAMETERS };
  }
  if (!sanitized.properties || typeof sanitized.properties !== "object") {
    sanitized.properties = {};
  }
  sanitized.additionalProperties = false;
  return sanitized;
}

function createSanitizedPostmanSchema(value: Record<string, unknown>): SanitizedPostmanSchema {
  const sanitized = sanitizePostmanSchemaNode(value, 0);
  if (sanitized.schema.type !== "object") {
    return {
      schema: { ...EMPTY_TOOL_PARAMETERS },
      nameMap: { properties: {} },
    };
  }
  sanitized.schema.additionalProperties = false;
  if (!sanitized.schema.properties || typeof sanitized.schema.properties !== "object") {
    sanitized.schema.properties = {};
  }
  return sanitized;
}

function sanitizePostmanSchemaNode(value: unknown, depth = 0): SanitizedPostmanSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { schema: { type: "string" }, nameMap: { properties: {} } };
  }

  const schema = value as Record<string, unknown>;
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  const type = typeof rawType === "string" && ["string", "number", "integer", "boolean", "object", "array"].includes(rawType)
    ? rawType
    : schema.properties && typeof schema.properties === "object" ? "object" : "string";
  const result: Record<string, any> = { type };
  const nameMap: PostmanParameterNameMap = { properties: {} };

  if (depth >= MAX_POSTMAN_SCHEMA_DEPTH) {
    if (type === "object") {
      result.properties = {};
      result.additionalProperties = false;
    } else if (type === "array") {
      result.items = { type: "string" };
    }
    return { schema: result, nameMap };
  }

  if (typeof schema.description === "string" && schema.description.trim()) {
    result.description = schema.description.replace(/\s+/g, " ").trim().slice(0, MAX_POSTMAN_TOOL_DESCRIPTION_LEN);
  }
  if (Array.isArray(schema.enum) && schema.enum.length <= MAX_POSTMAN_ENUM_VALUES) {
    const enumValues = schema.enum.filter((item) => ["string", "number", "boolean"].includes(typeof item));
    if (enumValues.length > 0) result.enum = enumValues;
  }

  if (type === "object") {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    const sanitizedProperties: Record<string, unknown> = {};
    const usedNames = new Set<string>();
    const sourceToPostmanName = new Map<string, string>();
    for (const [index, [name, child]] of Object.entries(properties).entries()) {
      if (index >= MAX_POSTMAN_SCHEMA_PROPERTIES) break;
      const trimmedName = name.trim();
      if (!trimmedName || isForbiddenPostmanPropertyName(trimmedName)) continue;
      const postmanName = safePostmanParameterName(trimmedName, index, usedNames);
      const sanitizedChild = sanitizePostmanSchemaNode(child, depth + 1);
      sanitizedProperties[postmanName] = sanitizedChild.schema;
      nameMap.properties[postmanName] = {
        sourceName: trimmedName,
        child: sanitizedChild.nameMap,
      };
      sourceToPostmanName.set(trimmedName, postmanName);
    }
    result.properties = sanitizedProperties;
    result.additionalProperties = false;
    if (Array.isArray(schema.required)) {
      const required = schema.required
        .filter((name): name is string => typeof name === "string")
        .map((name) => sourceToPostmanName.get(name.trim()))
        .filter((name): name is string => Boolean(name));
      if (required.length > 0) result.required = Array.from(new Set(required));
    }
  } else if (type === "array") {
    const sanitizedItems = sanitizePostmanSchemaNode(schema.items, depth + 1);
    result.items = sanitizedItems.schema;
    nameMap.items = sanitizedItems.nameMap;
  }

  return { schema: result, nameMap };
}

function safePostmanParameterName(sourceName: string, index: number, usedNames: Set<string>): string {
  if (
    sourceName.length <= MAX_POSTMAN_PARAMETER_NAME_LEN
    && /^[A-Za-z0-9_-]+$/.test(sourceName)
    && !usedNames.has(sourceName)
  ) {
    usedNames.add(sourceName);
    return sourceName;
  }

  const base = `param_${index + 1}`;
  let candidate = base.slice(0, MAX_POSTMAN_PARAMETER_NAME_LEN);
  let suffix = 2;
  while (usedNames.has(candidate)) {
    const tail = `_${suffix++}`;
    candidate = `${base.slice(0, MAX_POSTMAN_PARAMETER_NAME_LEN - tail.length)}${tail}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function isForbiddenPostmanPropertyName(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function restorePostmanParameterNames(value: unknown, nameMap: PostmanParameterNameMap): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => restorePostmanParameterNames(item, nameMap.items || { properties: {} }));
  }
  if (!value || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const restored: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(source)) {
    const mapping = nameMap.properties[key];
    const sourceName = mapping?.sourceName || key;
    restored[sourceName] = mapping?.child
      ? restorePostmanParameterNames(childValue, mapping.child)
      : childValue;
  }
  return restored;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "enabled", "1"].includes(normalized)) return true;
      if (["false", "no", "disabled", "0"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function extractQuotaApiError(text: string): string {
  if (!text.trim()) return "";
  try {
    const data = JSON.parse(text) as any;
    return String(data?.error?.message || data?.error?.details || data?.message || "").trim();
  } catch {
    return text.trim().slice(0, 300);
  }
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 30_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1000);
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) return Math.max(1_000, retryAt - Date.now());
  return 30_000;
}

function isMeaningfulDelta(delta: PostmanDelta): boolean {
  return Boolean(delta.content || delta.reasoning_content || delta.tool_calls?.length);
}

function logPostmanRequestShape(accountId: string, body: any): void {
  if (!config.postmanFetchVerbose) return;
  const input = body?.input;
  const toolResponses = Array.isArray(input?.toolResponses) ? input.toolResponses : [];
  const thirdParty = body?.clientTools?.thirdParty;
  const groups = thirdParty && typeof thirdParty === "object"
    ? Object.entries(thirdParty).map(([name, value]: [string, any]) => ({
      name,
      count: Array.isArray(value?.tools) ? value.tools.length : 0,
    }))
    : [];
  const forwardedToolCount = groups.reduce((total, group) => total + group.count, 0);
  console.error("[postman] request-shape", {
    accountId,
    chatType: input?.chatType || null,
    hasConversationId: Boolean(input?.conversationId),
    hasToolCallId: Boolean(input?.toolCallId),
    hasToolCallGroupId: Boolean(input?.toolCallGroupId),
    toolResponseStatus: input?.toolResponseStatus || null,
    toolResponseCount: toolResponses.length || (input?.toolResponse ? 1 : 0),
    forwardedToolCount,
    thirdPartyGroups: groups.map((group) => `${group.name}:${group.count}`).join("|"),
    hasAgent: input?.agent === null,
    hasStartedFrom: input?.startedFrom === "CHAT_INPUT",
  });
}

function logPostmanResponseShape(text: string): void {
  if (!config.postmanFetchVerbose) return;
  const events = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      try {
        const event = JSON.parse(line.slice(5).trim());
        const data = event?.data;
        return [{
          eventType: event?.eventType || event?.type || null,
          dataType: Array.isArray(data) ? "array" : typeof data,
          dataKeys: data && typeof data === "object" && !Array.isArray(data)
            ? Object.keys(data).sort()
            : [],
          eventKeys: Object.keys(event || {}).sort(),
          ...(String(event?.eventType || event?.type || "").toLowerCase() === "conversation"
            ? {
              conversation: {
                id: diagnosticValue(data?.id),
                conversationId: diagnosticValue(data?.conversationId),
                state: diagnosticValue(data?.state),
              },
            }
            : {}),
          ...(String(event?.eventType || event?.type || "").toLowerCase() === "toolcallchunk"
            ? {
              toolCalls: Array.isArray(data?.toolCalls)
                ? data.toolCalls.map((toolCall: any) => ({
                  keys: Object.keys(toolCall || {}).sort(),
                  id: diagnosticValue(toolCall?.id),
                  callId: diagnosticValue(toolCall?.callId),
                  toolCallId: diagnosticValue(toolCall?.toolCallId),
                  functionKeys: toolCall?.function && typeof toolCall.function === "object"
                    ? Object.keys(toolCall.function).sort()
                    : [],
                }))
                : [],
            }
            : {}),
          ...(String(event?.eventType || event?.type || "").toLowerCase() === "failure"
            ? {
              failure: {
                errorType: typeof data?.errorType === "string" ? data.errorType : null,
                message: typeof data?.message === "string" ? data.message.slice(0, 240) : null,
                userMessage: typeof data?.userMessage === "string" ? data.userMessage.slice(0, 240) : null,
              },
            }
            : {}),
        }];
      } catch {
        return [];
      }
    });
  console.error("[postman] response-shape", JSON.stringify(events));
}

function diagnosticValue(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return `${value.slice(0, 18)}…(${value.length})`;
}

function isPostmanInputValidationForbidden(error: string | null | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return normalized.includes("input_validation_error") && normalized.includes("forbidden");
}

function buildMcpForbiddenConclusion(diagnostic: McpForbiddenDiagnostic): string {
  if (diagnostic.pureChat.status === "fail") {
    return "pure_chat_failed: account Agent Mode, team AI access, quota, or generic upstream chat access is failing before MCP tools are involved.";
  }
  if (diagnostic.noopTool.status === "fail") {
    return "third_party_tool_forwarding_rejected: pure chat works, but Postman rejects even one minimal third-party tool; the failing layer is upstream MCP/tool-forwarding permission or validation.";
  }
  const failedPartitions = diagnostic.partitionProbes.filter((probe) => probe.result.status === "fail");
  if (failedPartitions.length > 0) {
    const labels = failedPartitions.map((probe) => `${probe.index}(${probe.toolCount})`).join(",");
    return `tool_partition_rejected: pure chat and a minimal tool work; Postman rejects partition(s) ${labels}, so the failing payload is inside those tool schemas or names.`;
  }
  const failedCountProbes = diagnostic.countProbes.filter((probe) => probe.result.status === "fail");
  if (failedCountProbes.length > 0) {
    const labels = diagnostic.countProbes
      .map((probe) => `${probe.toolCount}:${probe.result.status}`)
      .join("|");
    return `tool_count_or_combination_rejected: partition probes pass, but count ladder ${labels} contains a failure; Postman rejects the combined tool list above a count or combination boundary.`;
  }
  if (diagnostic.partitionProbes.length > 1 && diagnostic.originalToolGroupCount > 1) {
    return "combined_tool_groups_rejected: pure chat, a minimal tool, and every single forwarded tool partition pass; Postman rejects the original multi-group tool list at input validation.";
  }
  if (diagnostic.noopTool.status === "pass") {
    return "original_tool_schema_or_list_rejected: pure chat and a minimal tool work; the failing layer is the original client tool name/schema/count payload.";
  }
  return "diagnostic_incomplete: pure chat did not pass, so the tool probe was skipped.";
}

function formatMcpForbiddenDiagnostic(diagnostic: McpForbiddenDiagnostic): string {
  const partitions = diagnostic.partitionProbes.length > 0
    ? diagnostic.partitionProbes
      .map((probe) => `${probe.index}:${probe.toolCount}:${formatMcpProbe(probe.result)}`)
      .join("|")
    : "none";
  const isolated = diagnostic.isolatedProbes.length > 0
    ? diagnostic.isolatedProbes
      .map((probe) => {
        const label = probe.startIndex === probe.endIndex
          ? `${probe.startIndex}:${probe.endIndex}`
          : `${probe.startIndex}:${probe.endIndex}`;
        const names = probe.names.join("..") || "unknown";
        return `${probe.partition}[${label}]=${names}:${formatMcpProbe(probe.result)}`;
      })
      .join("|")
    : "none";
  const counts = diagnostic.countProbes.length > 0
    ? diagnostic.countProbes
      .map((probe) => {
        const bytes = probe.result.payloadBytes === undefined
          ? ""
          : `,bytes=${probe.result.payloadBytes}`;
        return `${probe.toolCount}:${formatMcpProbe(probe.result)}${bytes}`;
      })
      .join("|")
    : "none";
  return [
    `original_request=${formatMcpProbe(diagnostic.original)}`,
    `MCP diagnostic: pure_chat=${formatMcpProbe(diagnostic.pureChat)}`,
    `noop_tool=${formatMcpProbe(diagnostic.noopTool)}`,
    `partitions=${partitions}`,
    `count_probes=${counts}`,
    `isolated=${isolated}`,
    `original_tools=${diagnostic.originalToolCount}`,
    `original_groups=${diagnostic.originalToolGroupCount}`,
    `tool_shape=${diagnostic.toolShapeSummary}`,
    `metadata=${diagnostic.metadataSource}`,
    `conclusion=${diagnostic.conclusion}`,
  ].join(", ");
}

function formatMcpProbe(probe: McpDiagnosticProbeResult): string {
  const transport = [
    probe.httpStatus === undefined ? "" : `http=${probe.httpStatus}`,
    probe.responseKind || "",
  ].filter(Boolean).join(",");
  const suffix = transport ? `[${transport}]` : "";
  if (!probe.error) return `${probe.status}${suffix}`;
  return `${probe.status}(${sanitizeDiagnosticError(probe.error)})${suffix}`;
}

function responseKindFromContentType(contentType: string | null): "sse" | "json" | "unknown" {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("text/event-stream")) return "sse";
  if (normalized.includes("json")) return "json";
  return "unknown";
}

function sanitizeDiagnosticError(error: string): string {
  return error
    .replace(/\s+/g, " ")
    .replace(/postman\.sid=[^;\s]+/gi, "postman.sid=<redacted>")
    .slice(0, 180);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Client disconnected"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelReader(
  reader: {
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  },
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    // Best-effort cancellation.
  }
  try {
    reader.releaseLock();
  } catch {
    // The stream may already have released its lock.
  }
}

function extractUpstreamError(text: string): string {
  const fallback = "Postman returned an invalid streaming response";
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return String(
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.message ||
      parsed?.detail ||
      fallback,
    );
  } catch {
    return trimmed.length <= 500 ? trimmed : fallback;
  }
}

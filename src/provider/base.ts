import type { Account } from "../db/schema";
import { config } from "../config";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | any[];
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: any[];
  tool_choice?: any;
  reasoning_effort?: string;
  thinking?: { type: string; budget_tokens?: number; display?: string; effort?: string; summary?: string };
  signal?: AbortSignal;
  _originalModel?: string;
  _sessionId?: string;
  /** Upstream conversation created by context priming; short-circuits cold-start seeding. */
  _primedConversationId?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage & { tool_calls?: any[]; reasoning_content?: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage> & { tool_calls?: any[]; reasoning_content?: string };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type CreditUnit = "token" | "request" | "image" | "credit";
export type CreditSource = "upstream" | "quota_delta" | "estimated" | "fixed";

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window: number;
  max_output?: number;
  thinking?: boolean;
  vision?: boolean;
  creditRate?: number;
  creditUnit?: CreditUnit;
}

export type StreamFailureKind = "quota_exhausted" | "upstream_error";

export interface StreamFailure {
  kind: StreamFailureKind;
  error: Error;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderResult {
  success: boolean;
  response?: ChatCompletionResponse;
  stream?: ReadableStream<Uint8Array>;
  getStreamMessage?: () => ChatMessage | undefined;
  getStreamTokenUsage?: () => TokenUsage;
  getStreamFailure?: () => StreamFailure | undefined;
  setStreamFailureHandler?: (
    handler: (failure: StreamFailure) => void | Promise<void>,
  ) => void | Promise<void>;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  creditsUsed?: number;
  creditSource?: CreditSource;
  error?: string;
  quotaExhausted?: boolean;
  rateLimited?: boolean;
  retryAfterMs?: number;
  retryable?: boolean;
  requestRejected?: boolean;
  mcpRejected?: boolean;
  mcpFallbackUsed?: boolean;
  tokens?: unknown;
}

export interface ProviderHealthResult {
  kind: "healthy" | "exhausted" | "missing_tokens" | "transient_error" | "unsupported";
  success: boolean;
  retryable?: boolean;
  error?: string;
  quota?: {
    limit: number;
    remaining: number;
    used: number;
    resetAt?: Date | string | null;
    source?: string;
    overageAllowed?: boolean;
  };
}

export abstract class BaseProvider {
  abstract name: string;
  abstract supportedModels: ModelInfo[];
  nativeFormat: "openai" | "anthropic" = "openai";

  getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    return this.supportedModels.find((item) => item.id.toLowerCase() === normalized);
  }

  getModels(): ModelInfo[] {
    return this.supportedModels;
  }

  ownsModel(model: string): boolean {
    return this.getModelInfo(model) !== undefined;
  }

  protected generateId(): string {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  }

  protected createSSEChunk(chunk: StreamChunk): string {
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  protected createSSEDone(): string {
    return "data: [DONE]\n\n";
  }

  protected estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  protected estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
      return total + this.estimateTokens(content) + 4;
    }, 0);
  }

  async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { kind: "missing_tokens", success: false, error: "No valid tokens available" };
    }
    return { kind: "healthy", success: true };
  }

  abstract chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult>;
  abstract chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult>;
  abstract refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }>;
  abstract validateAccount(account: Account): Promise<boolean>;
  abstract fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }>;

  protected async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = config.providerRequestTimeoutMs,
    ttfbTimeoutMs?: number,
    clientSignal?: AbortSignal,
    options: { verbose?: boolean; context?: string } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const connectTimeoutMs = Math.min(timeoutMs, ttfbTimeoutMs ?? timeoutMs);
    const connectTimer = setTimeout(
      () => controller.abort(new Error(`Upstream connect timeout after ${connectTimeoutMs}ms`)),
      connectTimeoutMs,
    );

    let clientAbortHandler: (() => void) | undefined;
    const cleanupClientSignal = () => {
      if (clientAbortHandler && clientSignal) {
        clientSignal.removeEventListener("abort", clientAbortHandler);
        clientAbortHandler = undefined;
      }
    };
    if (clientSignal && !clientSignal.aborted) {
      clientAbortHandler = () => controller.abort(new Error("Client disconnected"));
      clientSignal.addEventListener("abort", clientAbortHandler, { once: true });
    } else if (clientSignal?.aborted) {
      controller.abort(new Error("Client already disconnected"));
    }

    const context = options.context || "Upstream request";
    const startedAt = Date.now();
    const diagnosticUrl = safeDiagnosticUrl(url);
    const logVerbose = (phase: string, details: string) => {
      if (!options.verbose) return;
      // Deliberately do not use Bun's native fetch `verbose`: it prints Cookie and
      // Authorization headers. This diagnostic contains no headers, query, or body.
      console.error(`[fetch] ${context} ${phase}: ${init.method || "GET"} ${diagnosticUrl} ${details}`);
    };

    let response: Response;
    try {
      logVerbose("start", `connectTimeoutMs=${connectTimeoutMs}`);
      response = await fetch(url, { ...init, signal: controller.signal } as any);
      logVerbose("headers", `status=${response.status} elapsedMs=${Date.now() - startedAt}`);
    } catch (error) {
      clearTimeout(connectTimer);
      cleanupClientSignal();
      const contextualError = upstreamFetchError(context, "before response headers", error, controller.signal);
      logVerbose("error", `elapsedMs=${Date.now() - startedAt} error=${contextualError.message}`);
      throw contextualError;
    }
    clearTimeout(connectTimer);

    if (!response.body) {
      cleanupClientSignal();
      return response;
    }

    // fetch() resolves when headers arrive. Keep cancellation wired for the full
    // response lifecycle and apply an inactivity timeout to every body read.
    const reader = response.body.getReader();
    let finished = false;
    let bytesRead = 0;
    let chunksRead = 0;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      cleanupClientSignal();
      try {
        reader.releaseLock();
      } catch {
        // A pending read owns the lock until abort/cancel settles.
      }
    };

    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          readTimer = setTimeout(() => {
            controller.abort(new Error(`Upstream stream idle timeout after ${config.streamReadTimeoutMs}ms`));
          }, config.streamReadTimeoutMs);
          const { done, value } = await reader.read();
          if (done) {
            logVerbose("complete", `elapsedMs=${Date.now() - startedAt} chunks=${chunksRead} bytes=${bytesRead}`);
            cleanup();
            streamController.close();
          } else {
            chunksRead++;
            bytesRead += value.byteLength;
            streamController.enqueue(value);
          }
        } catch (error) {
          const contextualError = upstreamFetchError(
            context,
            `while reading response body after ${chunksRead} chunk(s) / ${bytesRead} byte(s)`,
            error,
            controller.signal,
          );
          logVerbose("error", `elapsedMs=${Date.now() - startedAt} error=${contextualError.message}`);
          cleanup();
          streamController.error(contextualError);
        } finally {
          if (readTimer) clearTimeout(readTimer);
        }
      },
      async cancel(reason) {
        try {
          const cancelError = reason instanceof Error ? reason : new Error(String(reason ?? "Response cancelled"));
          logVerbose("cancel", `elapsedMs=${Date.now() - startedAt} reason=${cancelError.message}`);
          controller.abort(cancelError);
          await reader.cancel(reason);
        } catch {
          // Cancellation is best-effort.
        } finally {
          cleanup();
        }
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

function safeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

function upstreamFetchError(
  context: string,
  phase: string,
  error: unknown,
  signal: AbortSignal,
): Error {
  const cause = signal.aborted ? signal.reason : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${context} ${phase}: ${message}`, { cause: error });
}

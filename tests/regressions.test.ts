import { afterEach, describe, expect, test } from "bun:test";
import { acceptsApiKey } from "../src/auth/api-key";
import {
  ACCOUNT_TEST_PROMPT,
  testAccountAvailability,
} from "../src/auth/account-test";
import { resolveClientSessionId } from "../src/api/client-session";
import { resolveWarmupStatus } from "../src/auth/health-status";
import {
  scheduleProvisioningWarmup,
  stopWarmupScheduler,
  warmupAccount,
} from "../src/auth/warmup";
import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { config } from "../src/config";
import {
  clearConversations,
  getConversationId,
  setConversationId,
} from "../src/provider/conversation-store";
import { PostmanProvider } from "../src/provider/postman";
import { PostmanStreamReader } from "../src/provider/sse-stream";
import { pool } from "../src/proxy/pool";
import { provider, routeRequest } from "../src/proxy/router";

const account = {
  id: 7,
  email: "test@example.com",
  password: "unused",
  status: "active",
  enabled: true,
  tokens: JSON.stringify({
    postman_sid: "sid",
    user_id: "user",
    workspace_id: "team",
    workspace_subdomain: "example",
  }),
  quotaLimit: null,
  quotaRemaining: null,
  quotaResetAt: null,
  lastUsedAt: null,
  lastLoginAt: null,
  errorMessage: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

const request = {
  model: "auto",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
} as any;

const monthlyCreditError = "Your team has exceeded its monthly AI credit limit by 16%. You'll regain Agent Mode access in 30 days. To continue using Agent Mode without interruption, enable pay-as-you-go";

afterEach(() => {
  clearConversations();
  pool.clearRuntimeState();
  stopWarmupScheduler();
});

describe("API authentication", () => {
  test("accepts Bearer auth and keeps x-api-key compatibility", () => {
    expect(acceptsApiKey("secret", "Bearer secret")).toBe(true);
    expect(acceptsApiKey("secret", undefined, "secret")).toBe(true);
    expect(acceptsApiKey("secret", "Bearer wrong", "wrong")).toBe(false);
  });
});

describe("conversation isolation", () => {
  test("scopes conversations by account and namespaced client session", () => {
    setConversationId(1, "codex:client-a", "conversation-a");
    setConversationId(1, "claude-code:client-a", "conversation-b");
    setConversationId(2, "codex:client-a", "conversation-c");

    expect(getConversationId(1, "codex:client-a")).toBe("conversation-a");
    expect(getConversationId(1, "claude-code:client-a")).toBe("conversation-b");
    expect(getConversationId(2, "codex:client-a")).toBe("conversation-c");
    expect(getConversationId(1)).toBeNull();
  });

  test("recognizes native Codex and Claude Code session IDs", () => {
    const rawId = "019feece-25c0-70c0-bcea-1d8d54215c31";
    expect(resolveClientSessionId(new Headers({ session_id: rawId }), {}, "openai"))
      .toBe(`codex:${rawId}`);
    expect(resolveClientSessionId(
      new Headers({ "x-claude-code-session-id": rawId }),
      {},
      "anthropic",
    ))
      .toBe(`claude-code:${rawId}`);
  });

  test("namespaces metadata session IDs by client protocol", () => {
    const rawId = "019feece-25c0-70c0-bcea-1d8d54215c31";
    const body = { metadata: { session_id: rawId } };
    expect(resolveClientSessionId(new Headers(), body, "openai"))
      .toBe(`codex:${rawId}`);
    expect(resolveClientSessionId(new Headers(), body, "anthropic"))
      .toBe(`claude-code:${rawId}`);
  });

  test("extracts Claude Code session UUID from metadata without using a bare user ID", () => {
    const rawId = "19a11dd7-7aec-4778-9899-848602992762";
    expect(resolveClientSessionId(new Headers(), {
      metadata: { user_id: `user_example_account_123_session_${rawId}` },
    }, "anthropic")).toBe(`claude-code:${rawId}`);
    expect(resolveClientSessionId(new Headers(), {
      metadata: { user_id: "shared-account-user" },
    }, "anthropic")).toBeUndefined();
  });

  test("lets an explicit session override native IDs", () => {
    const headers = new Headers({
      "x-session-id": "tenant-a/task-42",
      "x-claude-code-session-id": "19a11dd7-7aec-4778-9899-848602992762",
    });
    expect(resolveClientSessionId(headers, { metadata: { session_id: "codex-session" } }, "openai"))
      .toBe("explicit:tenant-a/task-42");
  });

  test("keeps requests stateless when no reliable session ID exists", () => {
    expect(resolveClientSessionId(new Headers({ "x-interaction-id": "request-only" }), {
      prompt_cache_key: "shared-cache-route",
      metadata: { user_id: "shared-user" },
    }, "openai")).toBeUndefined();
  });
});

describe("sticky account routing", () => {
  const secondAccount = { ...account, id: 8, email: "second@example.com" } as any;

  test("keeps the same client session on its original active account", async () => {
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    try {
      poolAny.getActiveAccounts = async () => [account, secondAccount];
      const first = await pool.getNextAccount("codex:session-a");
      const second = await pool.getNextAccount("codex:session-a");
      expect(second?.id).toBe(first?.id);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("switches a failed session to another account and drops the old conversation", async () => {
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    try {
      poolAny.getActiveAccounts = async () => [account, secondAccount];
      const sessionId = "codex:session-b";
      const first = await pool.getNextAccount(sessionId);
      setConversationId(first!.id, sessionId, "old-conversation");

      pool.releaseSession(sessionId, first!.id);
      const replacement = await pool.getNextAccount(sessionId, new Set([first!.id]));
      const repeated = await pool.getNextAccount(sessionId);

      expect(replacement?.id).not.toBe(first?.id);
      expect(repeated?.id).toBe(replacement?.id);
      expect(getConversationId(first!.id, sessionId)).toBeNull();
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("keeps stateless requests load-balanced instead of binding them", async () => {
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    try {
      poolAny.getActiveAccounts = async () => [account, secondAccount];
      const first = await pool.getNextAccount();
      const second = await pool.getNextAccount();
      expect(second?.id).not.toBe(first?.id);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });
});

describe("stream error detection", () => {
  test("recognizes quota exhaustion as a control signal", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "usage",
      data: { limit: 100, usage: 100, usageState: "EXCEEDED" },
    })}`);
    expect(reader.quotaExceeded).toBe(true);
  });

  test("recognizes the real monthly credit error even without the expected error type", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "error",
      data: { error: { message: monthlyCreditError }, code: "FORBIDDEN" },
    })}`);
    expect(reader.quotaExceeded).toBe(true);
    expect(reader.error).toBe(monthlyCreditError);
  });

  test("classifies Postman Agent Mode input-validation Forbidden as retryable setup state", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "error",
      data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" },
    })}`);
    expect(reader.retryableError).toBe(true);
    expect(reader.error).toContain("Agent Mode");
  });

  test("classifies an empty failure event as temporary AI provisioning", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({ eventType: "failure", data: {} })}`);
    expect(reader.retryableError).toBe(true);
    expect(reader.error).toContain("AI access is not ready");
  });

  test("surfaces Postman top-level failure events instead of treating them as empty output", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({ result: "failure", message: "Cannot read properties of undefined (reading 'native')" })}`);
    expect(reader.error).toBe("Cannot read properties of undefined (reading 'native')");
    expect(reader.retryableError).toBe(false);
  });

  test("does not expose an empty failure event as a successful stream", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({ eventType: "failure", data: {} })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await postman.chatCompletionStream(account, request);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("AI access is not ready");
    expect(result.stream).toBeUndefined();
  });

  test("returns the real monthly credit error before exposing an HTTP 200 stream", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({
        eventType: "failure",
        data: { userMessage: monthlyCreditError, errorType: "FORBIDDEN" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await postman.chatCompletionStream(account, request);
    expect(result.success).toBe(false);
    expect(result.quotaExhausted).toBe(true);
    expect(result.error).toBe(monthlyCreditError);
    expect(result.stream).toBeUndefined();
  });

  test("builds a pure-chat Agent Mode request without stale native hashes, MCP metadata, or xhigh thinking", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = false;
      const body = (new PostmanProvider() as any).buildRequestBody(
        { ...request, reasoning_effort: "xhigh", tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
      );

      expect(body.clientTools.native).toEqual([]);
      expect(body.clientTools.thirdParty).toBeUndefined();
      expect(body.clientKBTerms.native).toEqual([]);
      expect(body.availableSkills).toBeUndefined();
      expect(body.devModeOptions.autoRun).toBe(false);
      expect(body.devModeOptions.supportsActionRecommendations).toBe(false);
      expect(body.devModeOptions.thinkingLevel).toBe("high");
      expect(body.devModeOptions.ai_user_agent_mode).toBe(true);
      expect(body.devModeOptions.agentMode).toBe(true);
      expect(body.userSettings.ai_user_agent_mode).toBe(true);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("sends client tool metadata only when official Postman MCP is explicitly enabled", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = true;
      const body = (new PostmanProvider() as any).buildRequestBody(
        { ...request, tools: [{ type: "function", function: { name: "lookup", description: "Lookup data", parameters: { type: "object" } } }] },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
      );

      expect(body.clientTools.native).toEqual([]);
      expect(body.clientTools.thirdParty["proxy-tools"].tools[0].name).toBe("lookup");
      expect(body.clientKBTerms.native).toEqual([]);
      expect(body.availableSkills).toEqual([]);
      expect(body.devModeOptions.autoRun).toBe(true);
      expect(body.devModeOptions.supportsActionRecommendations).toBe(true);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("keeps Agent Mode request metadata current", () => {
    const body = (new PostmanProvider() as any).buildRequestBody(
      { ...request, reasoning_effort: "xhigh" },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    expect(body.devModeOptions.thinkingLevel).toBe("high");
    expect(body.devModeOptions.ai_user_agent_mode).toBe(true);
    expect(body.devModeOptions.agentMode).toBe(true);
    expect(body.userSettings.ai_user_agent_mode).toBe(true);
  });

  test("enables the account-level ai_user_agent_mode setting through the workspace API", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    try {
      globalThis.fetch = (async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      const result = await new PostmanProvider().ensureAiUserAgentMode(account);
      const body = JSON.parse(String(requestInit?.body));

      expect(result.success).toBe(true);
      expect(requestUrl).toBe("https://example.postman.co/_api/user/settings/ai_user_agent_mode");
      expect(requestInit?.method).toBe("PUT");
      expect(body).toEqual({ value: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns quotaExhausted before exposing an HTTP 200 stream", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({
        eventType: "usage",
        data: { limit: 100, usage: 100, usageState: "EXCEEDED" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await postman.chatCompletionStream(account, request);
    expect(result.success).toBe(false);
    expect(result.quotaExhausted).toBe(true);
    expect(result.stream).toBeUndefined();
  });

  test("does not wrap a JSON upstream error as an empty stream", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchWithTimeout = async () => new Response(
      JSON.stringify({ error: { message: "upstream failed" } }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await postman.chatCompletionStream(account, request);
    expect(result.success).toBe(false);
    expect(result.error).toBe("upstream failed");
    expect(result.stream).toBeUndefined();
  });

  test("classifies quota received after a delta and errors the exposed stream", async () => {
    const postman = new PostmanProvider() as any;
    const encoder = new TextEncoder();
    const delta = `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "hello" } })}\n`;
    const quota = `data: ${JSON.stringify({
      eventType: "usage",
      data: { limit: 100, usage: 100, usageState: "EXCEEDED" },
    })}\n`;
    postman.fetchWithTimeout = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(delta));
        queueMicrotask(() => {
          controller.enqueue(encoder.encode(quota));
          controller.close();
        });
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const result = await postman.chatCompletionStream(account, request);
    const failures: any[] = [];
    result.setStreamFailureHandler?.((failure) => { failures.push(failure); });
    const reader = result.stream!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
    await expect(reader.read()).rejects.toThrow("Postman AI quota exceeded");
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("quota_exhausted");
  });

  test("propagates a socket failure after the first delta and reports stream failure once", async () => {
    const postman = new PostmanProvider() as any;
    const encoder = new TextEncoder();
    const delta = `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "hello" } })}\n`;
    let failUpstream!: () => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta));
        failUpstream = () => controller.error(new Error(
          "Postman chat while reading response body after 1 chunk(s) / 72 byte(s): The socket connection was closed unexpectedly",
        ));
      },
    });
    postman.fetchWithTimeout = async () => new Response(upstream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await postman.chatCompletionStream(account, request);
    const failures: any[] = [];
    result.setStreamFailureHandler?.((failure) => { failures.push(failure); });
    const reader = result.stream!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
    failUpstream();
    await expect(reader.read()).rejects.toThrow("socket connection was closed unexpectedly");
    expect(failures).toHaveLength(1);
    expect(failures[0].kind).toBe("upstream_error");
    expect(failures[0].error.message).toContain("after 1 chunk(s)");
    expect(upstream.locked).toBe(false);
  });
});

describe("quota health", () => {
  test("uses the usage proxy without chat headers and converts millicredits", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    try {
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({
          data: [{
            entity_type: "team",
            entities: [{
              type: "cumulative",
              usage: 304000,
              overage: 0,
              disabled: false,
              allowOverage: false,
              unlimited: false,
              spillage: 0,
              entityType: "team",
              entityId: 32284935,
              limit: 800000,
              name: "ai_millicredits",
              team: 32284935,
            }],
            metadata: {},
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;

      const result = await new PostmanProvider().fetchQuota(account);
      const headers = new Headers(requestInit?.headers);
      const body = JSON.parse(String(requestInit?.body));

      expect(requestUrl).toBe("https://example.postman.co/_api/ws/proxy");
      expect(headers.get("x-pstmn-req-service")).toBeNull();
      expect(headers.get("accept")).toBe("application/json");
      expect(body).toEqual({
        service: "usage",
        method: "get",
        path: "/teams/team/operations/ai_millicredits/usage",
      });
      expect(result).toEqual({
        success: true,
        quota: {
          limit: 800,
          remaining: 496,
          used: 304,
          overageAllowed: false,
          resetAt: null,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("counts spillage as usage and detects exhausted credits", async () => {
    const postman = new PostmanProvider() as any;
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [{
          entity_type: "team",
          entities: [{
            usage: 800000,
            spillage: 212819,
            allowOverage: false,
            limit: 800000,
            name: "ai_millicredits",
          }],
        }],
      }), { status: 200 })) as typeof fetch;

      const quota = await postman.fetchQuota(account);
      expect(quota.quota.limit).toBe(800);
      expect(quota.quota.remaining).toBe(0);
      expect(quota.quota.used).toBeCloseTo(1012.819, 3);
      expect((await postman.healthCheck(account)).kind).toBe("exhausted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports quota lookup failure instead of treating it as healthy", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchQuota = async () => ({ success: false, error: "Quota API error: 503" });

    expect(await postman.healthCheck(account)).toEqual({
      kind: "transient_error",
      success: false,
      retryable: true,
      error: "Quota API error: 503",
    });
  });

  test("warmup preserves the current state when quota lookup is transiently unavailable", async () => {
    const email = `warmup-quota-error-${crypto.randomUUID()}@example.com`;
    const [created] = await db.insert(accounts).values({
      email,
      password: "unused",
      status: "active",
      enabled: true,
      tokens: account.tokens,
      quotaLimit: 800,
      quotaRemaining: 400,
    }).returning();
    const originalHealthCheck = (PostmanProvider.prototype as any).healthCheck;

    try {
      (PostmanProvider.prototype as any).healthCheck = async () => ({
        kind: "transient_error",
        success: false,
        retryable: true,
        error: "Quota API error: 503",
      });

      const result = await warmupAccount(created!.id);
      const [current] = await db.select().from(accounts).where(eq(accounts.id, created!.id));

      expect(result).toEqual({ success: false, error: "Quota API error: 503" });
      expect(current!.status).toBe("active");
      expect(current!.quotaLimit).toBe(800);
      expect(current!.quotaRemaining).toBe(400);
      expect(current!.errorMessage).toBe("Quota API error: 503");
    } finally {
      (PostmanProvider.prototype as any).healthCheck = originalHealthCheck;
      await db.delete(accounts).where(eq(accounts.id, created!.id));
    }
  });

  test("warmup cannot overwrite an exhausted transition with stale positive quota", async () => {
    const email = `warmup-race-${crypto.randomUUID()}@example.com`;
    const [created] = await db.insert(accounts).values({
      email,
      password: "unused",
      status: "active",
      enabled: true,
      tokens: account.tokens,
      quotaLimit: 100,
      quotaRemaining: 50,
      updatedAt: new Date(1_000),
    }).returning();
    const originalHealthCheck = (PostmanProvider.prototype as any).healthCheck;
    let releaseHealth!: () => void;
    const healthBlocked = new Promise<void>((resolve) => { releaseHealth = resolve; });

    try {
      (PostmanProvider.prototype as any).healthCheck = async () => {
        await healthBlocked;
        return {
          kind: "healthy",
          success: true,
          quota: { limit: 100, used: 25, remaining: 75 },
        };
      };
      const warming = warmupAccount(created!.id);
      await Bun.sleep(0);
      await db.update(accounts).set({
        status: "exhausted",
        quotaRemaining: 0,
        updatedAt: new Date(2_000),
      }).where(eq(accounts.id, created!.id));
      releaseHealth();
      await warming;

      const [current] = await db.select().from(accounts).where(eq(accounts.id, created!.id));
      expect(current!.status).toBe("exhausted");
      expect(current!.quotaRemaining).toBe(0);
    } finally {
      (PostmanProvider.prototype as any).healthCheck = originalHealthCheck;
      await db.delete(accounts).where(eq(accounts.id, created!.id));
    }
  });

  test("keeps zero remaining active only when overage is allowed", async () => {
    const postman = new PostmanProvider() as any;
    postman.fetchQuota = async () => ({
      success: true,
      quota: { limit: 100, used: 100, remaining: 0, overageAllowed: true },
    });
    expect((await postman.healthCheck(account)).kind).toBe("healthy");

    postman.fetchQuota = async () => ({
      success: true,
      quota: { limit: 100, used: 100, remaining: 0, overageAllowed: false },
    });
    expect((await postman.healthCheck(account)).kind).toBe("exhausted");
  });

  test("does not reactivate an exhausted account when quota is unknown", () => {
    expect(resolveWarmupStatus("exhausted", { kind: "healthy", success: true })).toBe("exhausted");
    expect(resolveWarmupStatus("exhausted", {
      kind: "healthy",
      success: true,
      quota: { limit: 100, used: 50, remaining: 50 },
    })).toBe("active");
  });
});

describe("account availability test", () => {
  test("sends the documented probe and releases account load", async () => {
    const email = `account-test-${crypto.randomUUID()}@example.com`;
    const [created] = await db.insert(accounts).values({
      email,
      password: "unused",
      status: "active",
      enabled: true,
      tokens: account.tokens,
    }).returning();
    const providerPrototype = PostmanProvider.prototype as any;
    const originals = {
      validateAccount: providerPrototype.validateAccount,
      fetchQuota: providerPrototype.fetchQuota,
      ensureAiUserAgentMode: providerPrototype.ensureAiUserAgentMode,
      chatCompletion: providerPrototype.chatCompletion,
    };
    let receivedRequest: any;

    try {
      providerPrototype.validateAccount = async () => true;
      providerPrototype.fetchQuota = async () => ({
        success: true,
        quota: { limit: 100, used: 10, remaining: 90, overageAllowed: false },
      });
      providerPrototype.ensureAiUserAgentMode = async () => ({ success: true, enabled: true });
      providerPrototype.chatCompletion = async (_account: any, request: any) => {
        receivedRequest = request;
        return {
          success: true,
          response: {
            id: "test",
            object: "chat.completion",
            created: 0,
            model: request.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "POSTMAN2API_OK" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      };

      const result = await testAccountAvailability(created!.id);

      expect(result.available).toBe(true);
      expect(result.prompt).toBe(ACCOUNT_TEST_PROMPT);
      expect(receivedRequest.messages).toEqual([{ role: "user", content: ACCOUNT_TEST_PROMPT }]);
      expect(result.logs.some((entry) => entry.step === "Agent Mode" && entry.level === "success")).toBe(true);
      expect(result.logs.some((entry) => entry.step === "回复" && entry.message === "POSTMAN2API_OK")).toBe(true);
      expect((pool as any).getInFlightCount(created!.id)).toBe(0);
    } finally {
      providerPrototype.validateAccount = originals.validateAccount;
      providerPrototype.fetchQuota = originals.fetchQuota;
      providerPrototype.ensureAiUserAgentMode = originals.ensureAiUserAgentMode;
      providerPrototype.chatCompletion = originals.chatCompletion;
      await db.delete(accounts).where(eq(accounts.id, created!.id));
    }
  });
});

describe("request load tracking", () => {
  test("keeps a provisioning account active instead of permanently disabling it", async () => {
    const poolAny = pool as any;
    const providerAny = provider as any;
    const events: string[] = [];
    const originals = {
      acquireNextAccount: poolAny.acquireNextAccount,
      trackRequestEnd: poolAny.trackRequestEnd,
      markTransientFailure: poolAny.markTransientFailure,
      markError: poolAny.markError,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    let selected = false;

    try {
      poolAny.acquireNextAccount = async () => {
        if (selected) return null;
        selected = true;
        events.push("start");
        return { account, leaseId: "lease" };
      };
      poolAny.trackRequestEnd = () => events.push("end");
      poolAny.markTransientFailure = async () => events.push("transient");
      poolAny.markError = async () => events.push("error");
      providerAny.chatCompletionStream = async () => ({
        success: false,
        retryable: true,
        error: "Postman AI access is not ready for this team yet.",
      });

      await expect(routeRequest(request, true)).rejects.toThrow("AI access is not ready");
      expect(events).toEqual(["start", "end", "transient"]);
      expect(events).not.toContain("error");
    } finally {
      Object.assign(poolAny, {
        acquireNextAccount: originals.acquireNextAccount,
        trackRequestEnd: originals.trackRequestEnd,
        markTransientFailure: originals.markTransientFailure,
        markError: originals.markError,
      });
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });

  test("deduplicates provisioning warmup retries for the same account", () => {
    expect(scheduleProvisioningWarmup(account.id)).toBe(true);
    expect(scheduleProvisioningWarmup(account.id)).toBe(false);
  });

  test("tries every available account after the real monthly credit error", async () => {
    const accountsForTest = [
      account,
      { ...account, id: 8, email: "second@example.com" },
      { ...account, id: 9, email: "third@example.com" },
      { ...account, id: 10, email: "fourth@example.com" },
    ] as any[];
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    const originalChatCompletionStream = providerAny.chatCompletionStream;
    const originalMarkExhausted = poolAny.markExhausted;
    const originalMarkUsed = poolAny.markUsed;
    const attemptedAccountIds: number[] = [];

    try {
      poolAny.getActiveAccounts = async () => accountsForTest;
      poolAny.markExhausted = async (accountId: number) => {
        pool.releaseAccountBindings(accountId);
      };
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attemptedAccountIds.push(selectedAccount.id);
        if (attemptedAccountIds.length < accountsForTest.length) {
          return {
            success: false,
            quotaExhausted: true,
            error: monthlyCreditError,
          };
        }
        return {
          success: true,
          stream: new ReadableStream({ start(controller) { controller.close(); } }),
        };
      };

      const routed = await routeRequest({
        ...request,
        _sessionId: "codex:monthly-credit-failover",
      }, true);

      expect(attemptedAccountIds).toHaveLength(accountsForTest.length);
      expect(new Set(attemptedAccountIds).size).toBe(accountsForTest.length);
      expect(routed.account.id).toBe(attemptedAccountIds.at(-1));
      pool.trackRequestEnd(routed.account.id, routed.leaseId);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
      poolAny.markExhausted = originalMarkExhausted;
      poolAny.markUsed = originalMarkUsed;
      providerAny.chatCompletionStream = originalChatCompletionStream;
    }
  });

  test("returns the original monthly credit error when every account is exhausted", async () => {
    const accountsForTest = [
      account,
      { ...account, id: 8, email: "second@example.com" },
    ] as any[];
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    const originalChatCompletionStream = providerAny.chatCompletionStream;
    const originalMarkExhausted = poolAny.markExhausted;
    const attemptedAccountIds: number[] = [];

    try {
      poolAny.getActiveAccounts = async () => accountsForTest;
      poolAny.markExhausted = async (accountId: number) => {
        pool.releaseAccountBindings(accountId);
      };
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attemptedAccountIds.push(selectedAccount.id);
        return {
          success: false,
          quotaExhausted: true,
          error: monthlyCreditError,
        };
      };

      await expect(routeRequest({
        ...request,
        _sessionId: "codex:all-monthly-credit-exhausted",
      }, true)).rejects.toThrow(monthlyCreditError);
      expect(attemptedAccountIds).toHaveLength(accountsForTest.length);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
      poolAny.markExhausted = originalMarkExhausted;
      providerAny.chatCompletionStream = originalChatCompletionStream;
    }
  });

  test("moves a sticky session to another account after pre-stream quota exhaustion", async () => {
    const secondAccount = { ...account, id: 8, email: "second@example.com" } as any;
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;
    const originalChatCompletion = providerAny.chatCompletion;
    const originalMarkExhausted = poolAny.markExhausted;
    const originalMarkUsed = poolAny.markUsed;
    const attemptedAccountIds: number[] = [];
    const sessionId = "codex:route-failover";
    let exhaustedAccountId: number | undefined;

    try {
      poolAny.getActiveAccounts = async () => [account, secondAccount];
      poolAny.markExhausted = async (accountId: number) => {
        exhaustedAccountId = accountId;
        pool.releaseAccountBindings(accountId);
      };
      poolAny.markUsed = async () => {};
      providerAny.chatCompletion = async (selectedAccount: any) => {
        attemptedAccountIds.push(selectedAccount.id);
        if (attemptedAccountIds.length === 1) {
          setConversationId(selectedAccount.id, sessionId, "stale-conversation");
          return { success: false, quotaExhausted: true, error: "Quota exhausted" };
        }
        return {
          success: true,
          response: {
            id: "id",
            object: "chat.completion",
            created: 0,
            model: "auto",
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
        };
      };

      const routed = await routeRequest({
        ...request,
        stream: false,
        _sessionId: sessionId,
      }, false);

      expect(attemptedAccountIds).toHaveLength(2);
      expect(attemptedAccountIds[1]).not.toBe(attemptedAccountIds[0]);
      expect(exhaustedAccountId).toBe(attemptedAccountIds[0]);
      expect(routed.account.id).toBe(attemptedAccountIds[1]);
      expect(getConversationId(attemptedAccountIds[0]!, sessionId)).toBeNull();
      expect((await pool.getNextAccount(sessionId))?.id).toBe(routed.account.id);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
      poolAny.markExhausted = originalMarkExhausted;
      poolAny.markUsed = originalMarkUsed;
      providerAny.chatCompletion = originalChatCompletion;
    }
  });

  test("marks a post-delta quota failure exhausted and leaves stream release to its lifecycle", async () => {
    const poolAny = pool as any;
    const providerAny = provider as any;
    const events: string[] = [];
    let failureHandler: ((failure: any) => Promise<void> | void) | undefined;
    const originals = {
      acquireNextAccount: poolAny.acquireNextAccount,
      trackRequestEnd: poolAny.trackRequestEnd,
      markExhausted: poolAny.markExhausted,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };

    try {
      poolAny.acquireNextAccount = async () => {
        events.push("start");
        return { account, leaseId: "lease" };
      };
      poolAny.trackRequestEnd = () => events.push("end");
      poolAny.markExhausted = async () => events.push("exhausted");
      poolAny.markUsed = async () => events.push("used");
      providerAny.chatCompletionStream = async () => ({
        success: true,
        stream: new ReadableStream(),
        setStreamFailureHandler(handler: typeof failureHandler) { failureHandler = handler; },
      });

      await routeRequest(request, true);
      await failureHandler?.({ kind: "quota_exhausted", error: new Error("quota") });
      expect(events).toEqual(["start", "used", "exhausted"]);
      expect(events).not.toContain("end");
    } finally {
      Object.assign(poolAny, {
        acquireNextAccount: originals.acquireNextAccount,
        trackRequestEnd: originals.trackRequestEnd,
        markExhausted: originals.markExhausted,
        markUsed: originals.markUsed,
      });
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });

  test("does not blindly replay an ambiguous ECONNRESET from the chat POST", async () => {
    const events: string[] = [];
    const poolAny = pool as any;
    const providerAny = provider as any;
    let providerCalls = 0;
    const originals = {
      acquireNextAccount: poolAny.acquireNextAccount,
      trackRequestEnd: poolAny.trackRequestEnd,
      markTransientFailure: poolAny.markTransientFailure,
      chatCompletion: providerAny.chatCompletion,
    };

    try {
      poolAny.acquireNextAccount = async () => {
        events.push("start");
        return { account, leaseId: "lease" };
      };
      poolAny.trackRequestEnd = () => events.push("end");
      poolAny.markTransientFailure = async () => events.push("transient");
      providerAny.chatCompletion = async () => {
        providerCalls++;
        return { success: false, error: "Postman request failed: ECONNRESET" };
      };

      const routed = await routeRequest({ ...request, stream: false }, false);
      expect(routed.result.success).toBe(false);
      expect(providerCalls).toBe(1);
      expect(events).toEqual(["start", "end", "transient"]);
    } finally {
      Object.assign(poolAny, {
        acquireNextAccount: originals.acquireNextAccount,
        trackRequestEnd: originals.trackRequestEnd,
        markTransientFailure: originals.markTransientFailure,
      });
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

  test("ends non-streaming load before account bookkeeping", async () => {
    const events: string[] = [];
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      acquireNextAccount: poolAny.acquireNextAccount,
      trackRequestEnd: poolAny.trackRequestEnd,
      updateTokens: poolAny.updateTokens,
      markUsed: poolAny.markUsed,
      chatCompletion: providerAny.chatCompletion,
    };

    try {
      poolAny.acquireNextAccount = async () => {
        events.push("start");
        return { account, leaseId: "lease" };
      };
      poolAny.trackRequestEnd = () => events.push("end");
      poolAny.updateTokens = async () => events.push("tokens");
      poolAny.markUsed = async () => events.push("used");
      providerAny.chatCompletion = async () => {
        events.push("provider");
        return {
          success: true,
          response: {
            id: "id",
            object: "chat.completion",
            created: 0,
            model: "auto",
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
        };
      };

      await routeRequest({ ...request, stream: false }, false);
      expect(events).toEqual(["start", "provider", "end", "used"]);
    } finally {
      Object.assign(poolAny, {
        acquireNextAccount: originals.acquireNextAccount,
        trackRequestEnd: originals.trackRequestEnd,
        updateTokens: originals.updateTokens,
        markUsed: originals.markUsed,
      });
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });
});

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
import { PostmanProvider, normalizePostmanTools } from "../src/provider/postman";
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

function stubAgentModeReady(postman: any) {
  postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
}

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

  test("surfaces Postman input-validation Forbidden as request-payload rejection", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "error",
      data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" },
    })}`);
    expect(reader.retryableError).toBe(false);
    expect(reader.error).toBe("INPUT_VALIDATION_ERROR: Forbidden");
  });

  test("classifies direct Agent Mode not-enabled text as retryable setup state", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "failure",
      data: { message: "Postman Agent Mode is not enabled for this account yet. Enable ai user agent mode and retry shortly." },
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
    stubAgentModeReady(postman);
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
    stubAgentModeReady(postman);
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
        { ...request, reasoning_effort: "xhigh" },
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

  test("uses the legacy direct-tool envelope when Postman metadata is only bundled fallback", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        ...request,
        stream: false,
        tools: [{
          name: "execute_command",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        }],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
      {
        appVersion: "12.24.3-260819-0605",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.24.3-260819-0605-8e1a98909421",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.24.3-260819-0605-2e5f1dc41e2f",
        excludedTools: ["askUser"],
        excludedKBTerms: ["DATASETS"],
        source: "bundled",
      },
    );

    expect(body.clientTools.native).toEqual([]);
    expect(body.clientTools.nativeToolsHash).toBeUndefined();
    expect(body.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(1);
    expect(body.clientKBTerms.native).toEqual([]);
    expect(body.clientKBTerms.nativeTermsHash).toBeUndefined();
    expect(body.userSettings.ai_user_agent_mode).toBe(true);
    expect(body.devModeOptions.agentMode).toBe(true);
    expect(body.devModeOptions.agentModeEnabled).toBe(true);
    expect(body.devModeOptions.ai_user_agent_mode).toBe(true);
  });

  test("normalizes OpenAI, custom, and MCP namespace tool schemas for Postman", () => {
    expect(normalizePostmanTools([
      {
        type: "function",
        function: {
          name: "shell",
          description: "Run a shell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
      {
        type: "custom",
        name: "apply_patch",
        input_schema: { type: "object", properties: { patch: { type: "string" } } },
      },
      {
        type: "namespace",
        name: "filesystem",
        tools: [
          { name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        ],
      },
      {
        type: "function",
        function: { name: "shell", parameters: {} },
      },
    ])).toEqual([
      {
        name: "shell",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
      {
        name: "apply_patch",
        description: "apply_patch",
        parameters: { type: "object", properties: { patch: { type: "string" } } },
      },
      {
        name: "filesystem_read_file",
        sourceName: "filesystem.read_file",
        description: "filesystem.read_file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("forwards Codex MCP tools without an official Postman MCP setting", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = false;
      const body = (new PostmanProvider() as any).buildRequestBody(
        {
          ...request,
          tools: [
            { name: "execute_command", description: "Run", inputSchema: { type: "object" } },
            { type: "custom", name: "apply_patch", input_schema: { type: "object" } },
            { type: "namespace", name: "filesystem", tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
          ],
        },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
      );

      expect(body.clientTools.native).toEqual([]);
      expect(body.clientTools.nativeToolsHash).toBeUndefined();
      expect(body.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(3);
      expect(body.clientKBTerms.native).toEqual([]);
      expect(body.clientKBTerms.nativeTermsHash).toBeUndefined();
      expect(body.availableSkills).toEqual([]);
      expect(body.devModeOptions.autoRun).toBe(true);
      expect(body.devModeOptions.supportsActionRecommendations).toBe(true);
      expect(body.devModeOptions.agentMode).toBe(true);
      expect(body.devModeOptions.agentModeEnabled).toBe(true);
      expect(body.devModeOptions.ai_user_agent_mode).toBe(true);
      expect(body.userSettings.ai_user_agent_mode).toBe(true);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("forwards Codex MCP tools through the local port", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = true;
      const body = (new PostmanProvider() as any).buildRequestBody(
        {
          ...request,
          tools: [
            { name: "execute_command", description: "Run command", inputSchema: { type: "object", properties: { cmd: { type: "string" } } } },
            { type: "custom", name: "apply_patch", input_schema: { type: "object", properties: { patch: { type: "string" } } } },
            { type: "namespace", name: "filesystem", tools: [{ name: "read_file", inputSchema: { type: "object" } }] },
          ],
        },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
        {
          appVersion: "12.24.4-260820-0232",
          nativeToolsHash: "clienttools-workspace_v12-browser-12.24.4-260820-0232-deadbeef0011",
          nativeTermsHash: "kbterms-workspace_v12-browser-12.24.4-260820-0232-feedface0022",
          excludedTools: ["askUser"],
          excludedKBTerms: ["DATASETS"],
          source: "discovered",
        },
      );

      expect(body.clientTools.native).toBeUndefined();
      expect(body.clientTools.nativeToolsHash).toContain("clienttools-workspace_v12-browser-");
      expect(body.clientTools.excludedTools).toContain("askUser");
      expect(body.clientTools.thirdParty["proxy-tools"].tools).toEqual([
        {
          name: "execute_command",
          description: "Run command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          name: "apply_patch",
          description: "apply_patch",
          parameters: {
            type: "object",
            properties: { patch: { type: "string" } },
            additionalProperties: false,
          },
        },
        {
          name: "filesystem_read_file",
          description: "filesystem.read_file",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ]);
      expect(body.clientKBTerms.native).toBeUndefined();
      expect(body.clientKBTerms.nativeTermsHash).toContain("kbterms-workspace_v12-browser-");
      expect(body.clientKBTerms.excludedKBTerms).toEqual(["DATASETS"]);
      expect(body.availableSkills).toEqual([]);
      expect(body.userSettings).toBeUndefined();
      expect(body.devModeOptions.autoRun).toBe(true);
      expect(body.devModeOptions.supportsActionRecommendations).toBe(true);
      expect(body.devModeOptions.agentMode).toBeUndefined();
      expect(body.devModeOptions.agentModeEnabled).toBeUndefined();
      expect(body.devModeOptions.ai_user_agent_mode).toBeUndefined();
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("canonicalizes simple client tool schemas when forwarding through the local port", () => {
    const provider = new PostmanProvider() as any;
    const schema = {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: true,
    };

    const body = provider.buildRequestBody(
      {
        ...request,
        tools: [{
          name: "execute_command",
          description: "Run a command",
          inputSchema: schema,
        }],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    expect(body.clientTools.thirdParty["proxy-tools"].tools).toEqual([{
      name: "execute_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    }]);
  });

  test("clamps oversized seeding context to Postman's per-entry limit", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        model: "gpt-5",
        messages: [
          { role: "system", content: "S".repeat(60_000) },
          { role: "user", content: "H".repeat(40_000) },
          { role: "assistant", content: "earlier reply" },
          { role: "user", content: "continue" },
        ],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    const seeding = body.input.seedingMessages;
    expect(seeding).toHaveLength(2);
    for (const message of seeding) {
      expect(message.content.length).toBeLessThanOrEqual(10_000);
    }
    // The head of the system prompt carries the tool rules, so it must survive, and
    // every omission must be marked so the model is told context is missing.
    expect(seeding[0].content.startsWith("[System]\nSSS")).toBe(true);
    expect(seeding[0].content).toContain("middle of system instructions omitted");
    expect(seeding[0].content).toContain("start of this message omitted");
    // Budget must be spent, not abandoned when a history block cannot fit whole.
    expect(seeding[0].content.length).toBe(9_500);
    expect(seeding[0].content.endsWith("earlier reply")).toBe(true);
  });

  test("canonicalizes every forwarded tool schema for Postman strict validation", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        ...request,
        tools: [
          {
            name: "execute_command",
            description: "Run a command",
            inputSchema: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  default: "pwd",
                  format: "shell-command",
                  pattern: ".*",
                },
                options: {
                  type: "object",
                  properties: { cwd: { type: "string" } },
                  additionalProperties: true,
                },
              },
              required: ["command"],
              additionalProperties: true,
            },
          },
          {
            name: "plain_tool",
            description: "A plain tool",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
            },
          },
        ],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    const forwarded = body.clientTools.thirdParty["proxy-tools"].tools;
    expect(forwarded[0]!.parameters).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        options: {
          type: "object",
          properties: { cwd: { type: "string" } },
          additionalProperties: false,
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    expect(forwarded[1]!.parameters).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    });
  });

  test("adapts only Postman-incompatible client tool schemas", () => {
    const provider = new PostmanProvider() as any;
    const body = provider.buildRequestBody(
      {
        ...request,
        tools: [{
          name: "execute_command",
          description: `Run a command ${"with details ".repeat(300)}`,
          inputSchema: {
            type: "object",
            properties: {
              command: {
                anyOf: [{ type: "string" }, { type: "null" }],
              },
            },
            required: ["command"],
            additionalProperties: true,
            $defs: { command: { type: "string" } },
          },
        }],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    const forwarded = body.clientTools.thirdParty["proxy-tools"].tools[0];
    expect(forwarded.description.length).toBe(2_000);
    expect(forwarded.parameters).toEqual({
      type: "object",
      properties: { command: { type: "string" } },
      additionalProperties: false,
      required: ["command"],
    });
  });

  test("honors tool_choice none when forwarding tools to Postman", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = true;
      const body = (new PostmanProvider() as any).buildRequestBody(
        {
          ...request,
          tool_choice: "none",
          tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
        },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
      );

      expect(body.clientTools.native).toEqual([]);
      expect(body.clientTools.nativeToolsHash).toBeUndefined();
      expect(body.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(1);
      expect(body.devModeOptions.autoRun).toBe(false);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("sends tool results back through the bound Postman conversation", () => {
    setConversationId(account.id, "codex:mcp-session", "postman-conversation-1");
    const body = (new PostmanProvider() as any).buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:mcp-session",
        messages: [
          { role: "user", content: "run pwd" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "postman-tool-call-1",
              toolCallGroupId: "postman-tool-group-1",
              type: "function",
              function: { name: "execute_command", arguments: "{\"cmd\":\"pwd\"}" },
            }],
          },
          { role: "tool", tool_call_id: "postman-tool-call-1", content: "/workspace/project" },
        ],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      String(account.id),
    );

    expect(body.input.conversationId).toBe("postman-conversation-1");
    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.query).toBe("");
    expect(body.input.toolCallId).toBe("postman-tool-call-1");
    expect(body.input.toolCallGroupId).toBe("postman-tool-group-1");
    expect(body.input.toolResponse).toBe("/workspace/project");
    expect(body.input.toolResponseSummary).toBe("Tool call completed");
    expect(body.input.toolResponse).toBe("/workspace/project");
    expect(body.input.agent).toBeNull();
    expect(body.input.startedFrom).toBe("CHAT_INPUT");
    expect(body.clientTools.native).toEqual([]);
    expect(body.clientTools.nativeToolsHash).toBeUndefined();
    expect(body.clientKBTerms.native).toEqual([]);
    expect(body.clientKBTerms.nativeTermsHash).toBeUndefined();
  });

  test("keeps the legacy direct-tool envelope on a tool continuation without tools", () => {
    setConversationId(account.id, "codex:metadata-session", "postman-conversation-metadata");
    const body = (new PostmanProvider() as any).buildRequestBody(
      {
        model: "auto",
        _sessionId: "codex:metadata-session",
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "call-metadata", function: { name: "probe", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call-metadata", content: "ok" },
        ],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      String(account.id),
    );

    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.clientTools).toEqual({ native: [] });
    expect(body.clientKBTerms).toEqual({ native: [] });
  });

  test("uses discovered Postman client hashes and preserves a ten-tool list on the first request", () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    try {
      (config as any).postmanOfficialMcpEnabled = false;
      const body = (new PostmanProvider() as any).buildRequestBody(
        {
          ...request,
          tools: Array.from({ length: 10 }, (_, index) => ({
            type: "function",
            function: {
              name: `tool_${index}`,
              description: `Tool ${index}`,
              parameters: {
                type: "object",
                properties: {
                  value: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["value"],
                additionalProperties: true,
                $defs: { value: { type: "string" } },
              },
            },
          })),
        },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        "7",
        {
          appVersion: "12.24.4-260820-0232",
          nativeToolsHash: "clienttools-workspace_v12-browser-12.24.4-260820-0232-deadbeef0011",
          nativeTermsHash: "kbterms-workspace_v12-browser-12.24.4-260820-0232-feedface0022",
          excludedTools: ["askUser"],
          excludedKBTerms: ["DATASETS"],
          source: "discovered",
        },
      );

      expect(body.clientTools.nativeToolsHash)
        .toBe("clienttools-workspace_v12-browser-12.24.4-260820-0232-deadbeef0011");
      expect(body.clientKBTerms.nativeTermsHash)
        .toBe("kbterms-workspace_v12-browser-12.24.4-260820-0232-feedface0022");
      expect(body.clientTools.thirdParty["proxy-tools"].tools).toHaveLength(10);
      expect(body.devModeOptions.autoRun).toBe(true);

      for (const tool of body.clientTools.thirdParty["proxy-tools"].tools) {
        expect(tool.parameters.additionalProperties).toBe(false);
        expect(tool.parameters.$defs).toBeUndefined();
        expect(tool.parameters.properties.value).toEqual({ type: "string" });
      }
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("keeps a large third-party tool list in one Postman MCP server with a dispatcher", () => {
    const postman = new PostmanProvider() as any;
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    const body = postman.buildRequestBody(
      { ...request, stream: false, tools },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    const groups = Object.entries(body.clientTools.thirdParty)
      .map(([name, value]: [string, any]) => ({ name, count: value.tools.length }));

    expect(groups).toEqual([{ name: "proxy-tools", count: 20 }]);
    const forwardedNames = body.clientTools.thirdParty["proxy-tools"].tools.map((tool: any) => tool.name);
    expect(forwardedNames.slice(0, 19)).toEqual(tools.slice(0, 19).map((tool) => tool.function.name));
    expect(forwardedNames[19]).toBe("postman_tool_dispatch");
    expect(body.clientTools.thirdParty["proxy-tools"].tools[19].description).toContain("tool_19");
    expect(body.clientTools.thirdParty["proxy-tools"].tools[19].description).toContain("tool_30");
  });

  test("restores a hidden tool call returned through the Postman dispatcher", async () => {
    const postman = new PostmanProvider() as any;
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    }));

    stubAgentModeReady(postman);
    postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const dispatcher = body.clientTools.thirdParty["proxy-tools"].tools.at(-1);
      return new Response(
        `data: ${JSON.stringify({ eventType: "toolCallChunk", data: {
          toolCalls: [{
            id: "call-dispatcher",
            function: {
              name: dispatcher.name,
              arguments: JSON.stringify({
                tool_name: "tool_20",
                arguments: JSON.stringify({ value: "from-dispatcher" }),
              }),
            },
          }],
        } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const result = await postman.chatCompletion(account, {
      ...request,
      stream: false,
      tools,
    });

    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: "call-dispatcher",
      function: {
        name: "tool_20",
        arguments: JSON.stringify({ value: "from-dispatcher" }),
      },
    });
  });

  test("does not expose the internal Postman dispatcher in a streaming tool call", async () => {
    const postman = new PostmanProvider() as any;
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
    }));

    stubAgentModeReady(postman);
    postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const dispatcher = body.clientTools.thirdParty["proxy-tools"].tools.at(-1);
      return new Response(
        `data: ${JSON.stringify({ eventType: "toolCallChunk", data: {
          toolCalls: [{
            id: "call-stream-dispatcher",
            function: {
              name: dispatcher.name,
              arguments: JSON.stringify({
                tool_name: "tool_20",
                arguments: JSON.stringify({ value: "streamed" }),
              }),
            },
          }],
        } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const result = await postman.chatCompletionStream(account, {
      ...request,
      stream: true,
      tools,
    });
    expect(result.success).toBe(true);
    const reader = result.stream!.getReader();
    const chunks: string[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(new TextDecoder().decode(next.value));
    }

    const output = chunks.join("");
    expect(output).not.toContain("postman_tool_dispatch");
    expect(output).toContain("tool_20");
    const firstChunk = JSON.parse(output.split("\n\n")[0]!.replace(/^data:\s*/, ""));
    expect(firstChunk.choices[0].delta.tool_calls[0].function.arguments)
      .toBe(JSON.stringify({ value: "streamed" }));
    expect(result.getStreamMessage?.()?.tool_calls?.[0]?.function?.name).toBe("tool_20");
  });

  test("retries a rejected large tool list with compact schemas", async () => {
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index} ${"details ".repeat(120)}`,
        parameters: {
          type: "object",
          properties: {
            value: {
              type: "string",
              description: "parameter details ".repeat(80),
            },
          },
        },
      },
    }));

    try {
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        capturedBodies.push(body);
        const forwarded = body.clientTools?.thirdParty?.["proxy-tools"]?.tools || [];
        const compact = forwarded.every((tool: any) =>
          tool.description.length <= 512
          && !JSON.stringify(tool.parameters).includes('"description"'),
        );
        const event = capturedBodies.length === 1 && !compact
          ? { eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } }
          : { eventType: "textChunk", data: { textContent: "COMPACT_OK" } };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools,
      });

      expect(result.success).toBe(true);
      expect(result.response?.choices[0]?.message.content).toBe("COMPACT_OK");
      expect(capturedBodies).toHaveLength(2);
      expect(capturedBodies[1].clientTools.thirdParty["proxy-tools"].tools).toHaveLength(20);
      expect(Math.max(...capturedBodies[1].clientTools.thirdParty["proxy-tools"].tools
        .map((tool: any) => tool.description.length))).toBeLessThanOrEqual(512);
      expect(JSON.stringify(capturedBodies[1].clientTools.thirdParty["proxy-tools"].tools
        .map((tool: any) => tool.parameters))).not.toContain('"description"');
    } finally {
      postman.fetchWithTimeout = undefined;
    }
  });

  test("restores a tool name when Postman prefixes the partition server name", async () => {
    const postman = new PostmanProvider() as any;
    const tools = Array.from({ length: 21 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
    postman.resolveClientMetadata = async () => ({
      appVersion: "12.99.1-260818-1234",
      nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
      nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
      excludedTools: [],
      excludedKBTerms: ["DATASETS"],
    });
    postman.fetchWithTimeout = async () => new Response(
      `data: ${JSON.stringify({ eventType: "toolCallChunk", data: { toolCalls: [{ id: "call-partitioned", function: { name: "proxy-tools-2.tool_20", arguments: "{}" } }] } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await postman.chatCompletion(account, {
      ...request,
      stream: false,
      tools,
    });

    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("tool_20");
  });

  test("preserves nested parameter names and descriptions for Postman", async () => {
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const tool = {
      type: "function",
      function: {
        name: "filesystem.read",
        description: `Read a file\n${"details ".repeat(400)}`,
        parameters: {
          type: "object",
          properties: {
            "file path": {
              type: "object",
              properties: {
                "line.range": {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      "start line": { type: "integer" },
                    },
                    required: ["missing", "start line"],
                  },
                },
              },
              required: ["line.range"],
            },
            mode: { type: "string", enum: [null, { invalid: true }] },
          },
          required: ["file path", "unknown"],
        },
      },
    };

    try {
      (config as any).postmanOfficialMcpEnabled = false;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        capturedBodies.push(body);
        const forwarded = body.clientTools.thirdParty["proxy-tools"].tools[0];
        const outerName = Object.keys(forwarded.parameters.properties)[0];
        const nestedName = Object.keys(forwarded.parameters.properties[outerName].properties)[0];
        const itemName = Object.keys(forwarded.parameters.properties[outerName].properties[nestedName].items.properties)[0];
        return new Response([
          `data: ${JSON.stringify({ eventType: "toolCallChunk", data: { conversationId: "conversation-safe-args", toolCalls: [{ id: "call-safe-args", function: { name: forwarded.name, arguments: JSON.stringify({ [outerName]: { [nestedName]: [{ [itemName]: 7 }] } }) } }] } })}`,
          `data: ${JSON.stringify({ eventType: "done", data: {} })}`,
          "",
        ].join("\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [tool],
      });

      expect(result.success).toBe(true);
      const forwarded = capturedBodies[0].clientTools.thirdParty["proxy-tools"].tools[0];
      expect(forwarded.description.length).toBe(2_000);
      expect(forwarded.description).not.toContain("\n");
      expect(forwarded.parameters.required).toEqual(["param_1"]);
      expect(forwarded.parameters.properties.mode.enum).toBeUndefined();
      expect(result.response?.choices[0]?.message.tool_calls?.[0]?.function.arguments)
        .toBe(JSON.stringify({ "file path": { "line.range": [{ "start line": 7 }] } }));
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("keeps a sessionless tool continuation on the Postman conversation", async () => {
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    let fetchCalls = 0;
    const tools = [{
      type: "function",
      function: {
        name: "execute_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    }];

    stubAgentModeReady(postman);
    postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init.body)));
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response([
          `data: ${JSON.stringify({ eventType: "conversation", data: { id: "postman-conversation-1" } })}`,
          `data: ${JSON.stringify({
            eventType: "toolCallChunk",
            data: { toolCalls: [{ id: "postman-tool-call-1", function: { name: "execute_command", arguments: JSON.stringify({ cmd: "pwd" }) } }] },
          })}`,
        ].join("\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "done" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const first = await postman.chatCompletion(account, {
      model: "auto",
      messages: [{ role: "user", content: "run pwd" }],
      stream: false,
      tools,
    });
    expect(first.success).toBe(true);

    const toolCall = first.response?.choices[0]?.message.tool_calls?.[0];
    expect(toolCall?.id).toBe("postman-tool-call-1");

    const second = await postman.chatCompletion(account, {
      model: "auto",
      messages: [
        { role: "user", content: "run pwd" },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall?.id, content: "/workspace/project" },
      ],
      stream: false,
      tools,
    });

    expect(second.success).toBe(true);
    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1].input.chatType).toBe("TOOL_RESPONSE");
    expect(capturedBodies[1].input.conversationId).toBe("postman-conversation-1");
    expect(capturedBodies[1].input.toolCallId).toBe("postman-tool-call-1");
    expect(capturedBodies[1].input.toolResponse).toBe("/workspace/project");
  });

  test("recovers a missing Postman conversation before sending tool results", async () => {
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    const originalFetch = globalThis.fetch;
    let chatFetchCalls = 0;
    const tools = [{
      type: "function",
      function: {
        name: "execute_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } } },
      },
    }];

    try {
      stubAgentModeReady(postman);
      postman.resolveClientMetadata = async () => undefined;
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(String(init.body)));
        chatFetchCalls += 1;
        if (chatFetchCalls === 1) {
          return new Response(
            `data: ${JSON.stringify({
              eventType: "toolCallChunk",
              data: {
                toolCalls: [{
                  id: "postman-tool-call-recover-1",
                  function: {
                    name: "execute_command",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                  },
                }],
              },
            })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "recovered" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/_gw/conversation?")) {
          return new Response(JSON.stringify({
            meta: { nextCursor: null },
            data: [{ id: "recovered-postman-conversation", state: "WAITING_FOR_TOOL", modelKey: null }],
          }), { status: 200 });
        }
        if (url.endsWith("/_gw/conversation/recovered-postman-conversation")) {
          return new Response(JSON.stringify({
            data: {
              id: "recovered-postman-conversation",
              state: "WAITING_FOR_TOOL",
              modelKey: null,
              interactions: [{
                role: "ASSISTANT",
                toolCalls: [{
                  id: "postman-tool-call-recover-1",
                  name: "execute_command",
                  args: JSON.stringify({ cmd: "pwd" }),
                }],
              }],
            },
          }), { status: 200 });
        }
        throw new Error(`Unexpected recovery URL: ${url}`);
      }) as typeof fetch;

      const first = await postman.chatCompletion(account, {
        model: "auto",
        _sessionId: "codex:recover-session",
        messages: [{ role: "user", content: "run pwd" }],
        stream: false,
        tools,
      });
      expect(first.success).toBe(true);

      const toolCall = first.response?.choices[0]?.message.tool_calls?.[0];
      expect(toolCall?.id).toBe("postman-tool-call-recover-1");

      const second = await postman.chatCompletion(account, {
        model: "auto",
        _sessionId: "codex:recover-session",
        messages: [
          { role: "user", content: "run pwd" },
          { role: "assistant", content: null, tool_calls: [toolCall] },
          { role: "tool", tool_call_id: toolCall?.id, content: "/workspace/project" },
        ],
        stream: false,
        tools,
      });

      expect(second.success).toBe(true);
      expect(capturedBodies[1].input.chatType).toBe("TOOL_RESPONSE");
      expect(capturedBodies[1].input.conversationId).toBe("recovered-postman-conversation");
      expect(capturedBodies[1].input.toolCallId).toBe("postman-tool-call-recover-1");
      expect(capturedBodies[1].input.toolResponse).toBe("/workspace/project");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves tool calls when Postman uses alternate fields or omits the id", () => {
    const reader = new PostmanStreamReader();
    const first = reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: { tool_calls: [{ index: 0, name: "execute_command", arguments: { cmd: "pwd" } }] },
    })}`);
    const second = reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: { calls: [{ index: 0, function: { arguments: JSON.stringify({ cwd: true }) } }] },
    })}`);

    expect(first[0]?.tool_calls?.[0]?.id).toMatch(/^call_postman_0_/);
    expect(first[0]?.tool_calls?.[0]?.function?.name).toBe("execute_command");
    expect(second[0]?.tool_calls?.[0]?.index).toBe(0);
    expect(reader.finish()[0]?.finish_reason).toBe("tool_calls");
  });

  test("captures the Postman tool call group id for parallel tool calls", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: {
        toolCalls: [
          { id: "tool-call-a", toolCallGroupId: "tool-group-1", name: "first", arguments: "{}" },
          { id: "tool-call-b", toolCallGroupId: "tool-group-1", name: "second", arguments: "{}" },
        ],
      },
    })}`);

    expect(reader.toolCallGroupId).toBe("tool-group-1");
  });

  test("captures a conversation id when Postman nests it in a tool event", () => {
    const reader = new PostmanStreamReader();
    reader.feed(`data: ${JSON.stringify({
      eventType: "toolCallChunk",
      data: {
        conversationId: "nested-postman-conversation",
        toolCalls: [{ id: "tool-call-1", name: "execute_command", arguments: "{}" }],
      },
    })}`);

    expect(reader.conversationId).toBe("nested-postman-conversation");
  });

  test("sends the captured Postman tool call group id with parallel tool results", async () => {
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    let fetchCalls = 0;
    const tools = [
      { type: "function", function: { name: "first", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "second", parameters: { type: "object", properties: {} } } },
    ];

    stubAgentModeReady(postman);
    postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init.body)));
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response([
          `data: ${JSON.stringify({ eventType: "conversation", data: { id: "parallel-postman-conversation" } })}`,
          `data: ${JSON.stringify({
            eventType: "toolCallChunk",
            data: {
              toolCalls: [
                { id: "postman-tool-call-a", toolCallGroupId: "postman-tool-group-1", function: { name: "first", arguments: "{}" } },
                { id: "postman-tool-call-b", toolCallGroupId: "postman-tool-group-1", function: { name: "second", arguments: "{}" } },
              ],
            },
          })}`,
        ].join("\n") + "\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "continued" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const first = await postman.chatCompletion(account, {
      model: "auto",
      _sessionId: "codex:parallel-group",
      messages: [{ role: "user", content: "run both" }],
      stream: false,
      tools,
    });
    expect(first.success).toBe(true);

    const assistantMessage = first.response?.choices[0]?.message;
    const second = await postman.chatCompletion(account, {
      model: "auto",
      _sessionId: "codex:parallel-group",
      messages: [
        { role: "user", content: "run both" },
        assistantMessage,
        { role: "tool", tool_call_id: "postman-tool-call-a", content: "result a" },
        { role: "tool", tool_call_id: "postman-tool-call-b", content: "result b" },
      ],
      stream: false,
      tools,
    });

    expect(second.success).toBe(true);
    expect(capturedBodies[1].input.toolCallGroupId).toBe("postman-tool-group-1");
    // Upstream rejects an `input.toolResponses` array, so parallel results are merged
    // into the single flat field keyed by tool call id.
    expect(capturedBodies[1].input.toolResponses).toBeUndefined();
    expect(capturedBodies[1].input.toolCallId).toBe("postman-tool-call-a");
    expect(JSON.parse(capturedBodies[1].input.toolResponse)).toEqual([
      { toolCallId: "postman-tool-call-a", status: "SUCCESS", content: "result a" },
      { toolCallId: "postman-tool-call-b", status: "SUCCESS", content: "result b" },
    ]);
  });

  test("preserves parallel Anthropic tool-result order and failed tool status", () => {
    setConversationId(account.id, "claude:mcp-session", "postman-conversation-2");
    const body = (new PostmanProvider() as any).buildRequestBody(
      {
        model: "auto",
        _sessionId: "claude:mcp-session",
        messages: [
          { role: "user", content: "inspect resources" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-call-a", content: "resource a" },
              { type: "tool_result", tool_use_id: "tool-call-b", content: [{ type: "text", text: "permission denied" }], is_error: true },
            ],
          },
        ],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      String(account.id),
    );

    expect(body.input.chatType).toBe("TOOL_RESPONSE");
    expect(body.input.query).toBe("");
    // Merged into the flat field because upstream rejects `input.toolResponses`.
    expect(body.input.toolResponses).toBeUndefined();
    expect(body.input.toolCallId).toBe("tool-call-a");
    expect(JSON.parse(body.input.toolResponse)).toEqual([
      { toolCallId: "tool-call-a", status: "SUCCESS", content: "resource a" },
      {
        toolCallId: "tool-call-b",
        status: "FAILED",
        content: JSON.stringify([{ type: "text", text: "permission denied" }]),
      },
    ]);
    // A single failed result must fail the whole group, and carry the failure type.
    expect(body.input.toolResponseStatus).toBe("FAILED");
    expect(body.input.toolResponseFailureType).toBe("HANDLED_ERROR");
    expect(body.input.toolResponseSummary).toBe("2 tool calls completed");
  });


  test("omits the app version header when using bundled fallback metadata", () => {
    const headers = (new PostmanProvider() as any).buildHeaders({
      postman_sid: "sid",
      user_id: "user",
      workspace_id: "team",
      workspace_subdomain: "example",
    });
    expect(headers["x-app-version"]).toBeUndefined();
  });

  test("uses discovered Postman client hashes for MCP forwarding", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const originalFetch = globalThis.fetch;
    const discoveredToolsHash = "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011";
    const discoveredTermsHash = "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022";
    const postman = new PostmanProvider() as any;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: any;

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      globalThis.fetch = (async () => new Response(
        `<html><script>${discoveredToolsHash} ${discoveredTermsHash}</script></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      )) as typeof fetch;
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(String(init.body));
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "POSTMAN2API_OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
      });

      expect(result.success).toBe(true);
      expect(capturedHeaders?.["x-app-version"]).toBe("12.99.1-260818-1234");
      expect(capturedBody.clientTools.nativeToolsHash).toBe(discoveredToolsHash);
      expect(capturedBody.clientKBTerms.nativeTermsHash).toBe(discoveredTermsHash);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
      globalThis.fetch = originalFetch;
    }
  });

  test("discovers Postman hashes from a later dynamic chunk instead of truncating the asset scan", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const originalFetch = globalThis.fetch;
    const postman = new PostmanProvider() as any;
    const discoveredToolsHash = "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011";
    const discoveredTermsHash = "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022";
    let capturedBody: any;

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      const scripts = Array.from({ length: 13 }, (_, index) => `<script src="/assets/chunk-${index}.js"></script>`).join("");
      globalThis.fetch = (async (url: string | URL) => {
        const value = String(url);
        if (value.endsWith("/")) {
          return new Response(`<html>${scripts}</html>`, { status: 200 });
        }
        const body = value.endsWith("chunk-12.js")
          ? `${discoveredToolsHash} ${discoveredTermsHash}`
          : "unrelated chunk";
        return new Response(body, { status: 200 });
      }) as typeof fetch;
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body));
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "DISCOVERED_LATE" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
      });

      expect(result.success).toBe(true);
      expect(capturedBody.clientTools.nativeToolsHash).toBe(discoveredToolsHash);
      expect(capturedBody.clientKBTerms.nativeTermsHash).toBe(discoveredTermsHash);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
      globalThis.fetch = originalFetch;
    }
  });

  test("maps sanitized Postman tool call names back to client tool names", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async () => new Response(
        `data: ${JSON.stringify({ eventType: "toolCallChunk", data: { toolCalls: [{ id: "call-1", function: { name: "filesystem_read_file", arguments: "{}" } }] } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{ type: "namespace", name: "filesystem", tools: [{ name: "read_file", inputSchema: { type: "object" } }] }],
      });

      expect(result.success).toBe(true);
      expect(result.response?.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("filesystem.read_file");
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("diagnoses MCP Forbidden as third-party tool forwarding rejection when noop tool also fails", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        capturedBodies.push(JSON.parse(String(init.body)));
        if (capturedBodies.length === 2) {
          return new Response(
            `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "OK" } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
      });

      expect(result.success).toBe(false);
      expect(result.requestRejected).toBe(true);
      expect(result.mcpRejected).toBe(true);
      expect(result.mcpFallbackUsed).toBeUndefined();
      expect(result.error).toContain("pure_chat=pass");
      expect(result.error).toContain("noop_tool=fail(INPUT_VALIDATION_ERROR: Forbidden)");
      expect(result.error).toContain("third_party_tool_forwarding_rejected");
      expect(capturedBodies).toHaveLength(3);
      expect(capturedBodies[1].clientTools).toEqual({ native: [] });
      expect(capturedBodies[2].clientTools.thirdParty["proxy-tools"].tools[0].name).toBe("noop");
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("diagnoses MCP Forbidden as original tool schema rejection when noop tool passes", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    let fetchCalls = 0;

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response(
            `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{ name: "bad.schema", inputSchema: { type: "object" } }],
      });

      expect(result.success).toBe(false);
      expect(result.mcpRejected).toBe(true);
      expect(result.error).toContain("pure_chat=pass");
      expect(result.error).toContain("noop_tool=pass");
      expect(result.error).toContain("tool_shape=input:1;normalized:1;forwarded:1;");
      expect(result.error).toContain("metadata=discovered");
      expect(result.error).toContain("original_tool_schema_or_list_rejected");
      expect(fetchCalls).toBe(4);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("probes each forwarded MCP tool partition after the original request is forbidden", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        capturedBodies.push(body);
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const diagnostic = await postman.diagnoseMcpForbidden(
        account,
        { ...request, tools },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        {
          appVersion: "12.99.1-260818-1234",
          nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
          nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
          excludedTools: [],
          excludedKBTerms: ["DATASETS"],
        },
      );

      expect(diagnostic.partitionProbes).toEqual([
        {
          index: 1,
          toolCount: 20,
          result: expect.objectContaining({ status: "pass", httpStatus: 200, responseKind: "sse" }),
        },
        {
          index: 2,
          toolCount: 11,
          result: expect.objectContaining({ status: "pass", httpStatus: 200, responseKind: "sse" }),
        },
      ]);
      expect(diagnostic.countProbes.map((probe: any) => probe.toolCount)).toEqual([21, 25, 30, 31]);
      expect(diagnostic.countProbes.every((probe: any) => probe.result.status === "pass")).toBe(true);
      expect(diagnostic.countProbes.every((probe: any) => probe.result.payloadBytes > 0)).toBe(true);
      expect(capturedBodies).toHaveLength(8);
      expect(Object.keys(capturedBodies[2].clientTools.thirdParty)).toEqual(["proxy-tools"]);
      expect(capturedBodies[2].clientTools.thirdParty["proxy-tools"].tools).toHaveLength(20);
      expect(capturedBodies[3].clientTools.thirdParty["proxy-tools"].tools).toHaveLength(11);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("avoids the forbidden single-group boundary with the dispatcher", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        capturedBodies.push(body);
        const groups = body.clientTools?.thirdParty || {};
        const toolCount = Object.values(groups)
          .reduce((total: number, group: any) => total + (Array.isArray(group?.tools) ? group.tools.length : 0), 0);
        const event = toolCount === 31
          ? { eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } }
          : { eventType: "textChunk", data: { textContent: "OK" } };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools,
      });

      expect(result.success).toBe(true);
      expect(result.response?.choices[0]?.message.content).toBe("OK");
      expect(capturedBodies).toHaveLength(1);
      expect(capturedBodies[0].clientTools.thirdParty["proxy-tools"].tools).toHaveLength(20);
      expect(capturedBodies[0].clientTools.thirdParty["proxy-tools"].tools.at(-1).name)
        .toBe("postman_tool_dispatch");
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("isolates a rejected tool inside a failing partition", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const tools = Array.from({ length: 31 }, (_, index) => ({
      type: "function",
      function: {
        name: `tool_${index}`,
        description: `Tool ${index}`,
        parameters: { type: "object", properties: {} },
      },
    }));

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const forwarded = Object.values(body.clientTools?.thirdParty || {})
          .flatMap((group: any) => Array.isArray(group?.tools) ? group.tools : []);
        const rejects = forwarded.some((tool: any) => tool.name === "tool_7");
        const event = rejects
          ? { eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } }
          : { eventType: "textChunk", data: { textContent: "OK" } };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("tool_partition_rejected");
      expect(result.error).toContain("isolated=1[8:8]=tool_7:fail(INPUT_VALIDATION_ERROR: Forbidden)[http=200,sse]");
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("keeps MCP diagnostics usable after the client request is cancelled", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const clientAbort = new AbortController();
    clientAbort.abort(new Error("Client already disconnected"));
    const diagnosticSignals: AbortSignal[] = [];

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.fetchWithTimeout = async (
        _url: string,
        _init: RequestInit,
        _timeoutMs: number,
        _ttfbTimeoutMs: number,
        signal?: AbortSignal,
      ) => {
        if (signal) diagnosticSignals.push(signal);
        if (signal?.aborted) throw new Error("Client already disconnected");
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const diagnostic = await postman.diagnoseMcpForbidden(
        account,
        {
          ...request,
          signal: clientAbort.signal,
          tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
        },
        { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
        "gpt-5",
        {
          appVersion: "12.99.1-260818-1234",
          nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
          nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
          excludedTools: [],
          excludedKBTerms: ["DATASETS"],
        },
      );

      expect(diagnostic.pureChat.status).toBe("pass");
      expect(diagnostic.noopTool.status).toBe("pass");
      expect(diagnosticSignals).toHaveLength(3);
      expect(diagnosticSignals.every((signal) => signal !== clientAbort.signal)).toBe(true);
      expect(diagnosticSignals.every((signal) => !signal.aborted)).toBe(true);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("sends a Postman-compatible MCP schema before diagnosing Forbidden", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const capturedBodies: any[] = [];

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        capturedBodies.push(body);
        if (capturedBodies.length === 1) {
          return new Response(
            `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "SANITIZED_OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, {
        ...request,
        stream: false,
        tools: [{
          name: "execute_command",
          inputSchema: {
            type: "object",
            properties: {
              cmd: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["cmd"],
            $defs: { command: { type: "string" } },
          },
        }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("original_tool_schema_or_list_rejected");
      expect(capturedBodies).toHaveLength(4);
      const firstParameters = capturedBodies[0].clientTools.thirdParty["proxy-tools"].tools[0].parameters;
      expect(firstParameters).toEqual({
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      });
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("adapts streaming MCP tools before diagnosing Forbidden", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    let fetchCalls = 0;
    const capturedBodies: any[] = [];

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
        fetchCalls += 1;
        capturedBodies.push(JSON.parse(String(init.body)));
        if (fetchCalls === 1) {
          return new Response(
            `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "SANITIZED_STREAM_OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletionStream(account, {
        ...request,
        stream: true,
        tools: [{
          name: "execute_command",
          inputSchema: {
            type: "object",
            properties: { cmd: { anyOf: [{ type: "string" }, { type: "null" }] } },
            $defs: { command: { type: "string" } },
          },
        }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("original_tool_schema_or_list_rejected");
      expect(capturedBodies[0].clientTools.thirdParty["proxy-tools"].tools[0].parameters)
        .toEqual({
          type: "object",
          properties: { cmd: { type: "string" } },
          additionalProperties: false,
        });
      expect(fetchCalls).toBe(4);
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

  test("keeps the known-good direct-tool request envelope", () => {
    const body = (new PostmanProvider() as any).buildRequestBody(
      {
        ...request,
        tools: [{
          type: "function",
          function: {
            name: "execute_command",
            description: "Execute a command",
            parameters: { type: "object", properties: {} },
          },
        }],
      },
      { postman_sid: "sid", user_id: "user", workspace_id: "team", workspace_subdomain: "example" },
      "gpt-5",
      "7",
    );

    expect(body.availableSkills).toEqual([]);
    expect(body.devModeOptions.autoRun).toBe(true);
    expect(body.devModeOptions.supportsActionRecommendations).toBe(true);
    expect(body.devModeOptions.isLoopApprovalEnabled).toBe(true);
    expect(body.devModeOptions.enableWebAccess).toBe(true);
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

  test("does not block chat when the Agent Mode setting endpoint is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    const postman = new PostmanProvider() as any;
    let chatCalled = false;

    try {
      globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
      postman.fetchWithTimeout = async () => {
        chatCalled = true;
        return new Response(
          `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "POSTMAN2API_OK" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletion(account, { ...request, stream: false });
      expect(result.success).toBe(true);
      expect(result.response?.choices[0]?.message.content).toBe("POSTMAN2API_OK");
      expect(chatCalled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });


  test("ensures account-level Agent Mode before non-streaming chat", async () => {
    const postman = new PostmanProvider() as any;
    let ensured = false;
    postman.ensureAiUserAgentMode = async () => {
      ensured = true;
      return { success: true, enabled: true, cached: true };
    };
    postman.fetchWithTimeout = async () => {
      expect(ensured).toBe(true);
      return new Response(
        `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "POSTMAN2API_OK" } })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const result = await postman.chatCompletion(account, { ...request, stream: false });
    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.content).toBe("POSTMAN2API_OK");
  });

  test("re-enables Agent Mode and retries once after an upstream not-enabled failure", async () => {
    const postman = new PostmanProvider() as any;
    let ensureCalls = 0;
    let fetchCalls = 0;
    postman.ensureAiUserAgentMode = async () => {
      ensureCalls += 1;
      return { success: true, enabled: true, cached: true };
    };
    postman.fetchWithTimeout = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(
          `data: ${JSON.stringify({ eventType: "failure", data: { message: "Postman Agent Mode is not enabled for this account yet. Enable ai user agent mode and retry shortly." } })}

`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "POSTMAN2API_OK" } })}

`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const result = await postman.chatCompletion(account, { ...request, stream: false });
    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.content).toBe("POSTMAN2API_OK");
    expect(ensureCalls).toBe(2);
    expect(fetchCalls).toBe(2);
  });

  test("re-enables Agent Mode and retries once for streaming requests", async () => {
    const postman = new PostmanProvider() as any;
    let ensureCalls = 0;
    let fetchCalls = 0;
    postman.ensureAiUserAgentMode = async () => {
      ensureCalls += 1;
      return { success: true, enabled: true, cached: true };
    };
    postman.fetchWithTimeout = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(
          `data: ${JSON.stringify({ eventType: "failure", data: { message: "Postman Agent Mode is not enabled for this account yet. Enable ai user agent mode and retry shortly." } })}

`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "POSTMAN2API_OK" } })}

`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const result = await postman.chatCompletionStream(account, { ...request, stream: true });
    expect(result.success).toBe(true);
    expect(result.stream).toBeDefined();
    const reader = result.stream!.getReader();
    while (!(await reader.read()).done) {}
    expect(ensureCalls).toBe(2);
    expect(fetchCalls).toBe(2);
  });

  test("returns quotaExhausted before exposing an HTTP 200 stream", async () => {
    const postman = new PostmanProvider() as any;
    stubAgentModeReady(postman);
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
    stubAgentModeReady(postman);
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
    stubAgentModeReady(postman);
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

  test("diagnoses MCP Forbidden received after the first stream delta", async () => {
    const originalMcpFlag = (config as any).postmanOfficialMcpEnabled;
    const postman = new PostmanProvider() as any;
    const encoder = new TextEncoder();
    let fetchCalls = 0;

    try {
      (config as any).postmanOfficialMcpEnabled = true;
      stubAgentModeReady(postman);
      postman.resolveClientMetadata = async () => ({
        appVersion: "12.99.1-260818-1234",
        nativeToolsHash: "clienttools-workspace_v12-browser-12.99.1-260818-1234-deadbeef0011",
        nativeTermsHash: "kbterms-workspace_v12-browser-12.99.1-260818-1234-feedface0022",
        excludedTools: [],
        excludedKBTerms: ["DATASETS"],
      });
      postman.fetchWithTimeout = async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "hello" } })}\n`,
              ));
              queueMicrotask(() => {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n`,
                ));
                controller.close();
              });
            },
          }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (fetchCalls === 2) {
          return new Response(
            `data: ${JSON.stringify({ eventType: "textChunk", data: { textContent: "OK" } })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          `data: ${JSON.stringify({ eventType: "failure", data: { errorType: "INPUT_VALIDATION_ERROR", message: "Forbidden" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      };

      const result = await postman.chatCompletionStream(account, {
        ...request,
        tools: [{ name: "execute_command", inputSchema: { type: "object" } }],
      });
      const failures: any[] = [];
      result.setStreamFailureHandler?.((failure) => { failures.push(failure); });
      const reader = result.stream!.getReader();

      expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
      await expect(reader.read()).rejects.toThrow("MCP diagnostic: pure_chat=pass");
      expect(failures).toHaveLength(1);
      expect(failures[0].error.message).toContain("noop_tool=fail(INPUT_VALIDATION_ERROR: Forbidden)");
      expect(fetchCalls).toBe(3);
    } finally {
      (config as any).postmanOfficialMcpEnabled = originalMcpFlag;
    }
  });

  test("propagates a socket failure after the first delta and reports stream failure once", async () => {
    const postman = new PostmanProvider() as any;
    stubAgentModeReady(postman);
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
  test("does not poison an account when Postman rejects the forwarded request", async () => {
    const poolAny = pool as any;
    const providerAny = provider as any;
    const events: string[] = [];
    const originals = {
      acquireNextAccount: poolAny.acquireNextAccount,
      trackRequestEnd: poolAny.trackRequestEnd,
      markError: poolAny.markError,
      chatCompletion: providerAny.chatCompletion,
    };

    try {
      poolAny.acquireNextAccount = async () => {
        events.push("start");
        return { account, leaseId: "lease" };
      };
      poolAny.trackRequestEnd = () => events.push("end");
      poolAny.markError = async () => events.push("error");
      providerAny.chatCompletion = async () => {
        events.push("provider");
        return {
          success: false,
          requestRejected: true,
          mcpRejected: true,
          error: "INPUT_VALIDATION_ERROR: Forbidden",
        };
      };

      const routed = await routeRequest({ ...request, stream: false }, false);

      expect(routed.result.requestRejected).toBe(true);
      expect(events).toEqual(["start", "provider", "end"]);
    } finally {
      Object.assign(poolAny, {
        acquireNextAccount: originals.acquireNextAccount,
        trackRequestEnd: originals.trackRequestEnd,
        markError: originals.markError,
      });
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

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

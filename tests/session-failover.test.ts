import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index";
import { accounts, requestLogs, sessionStates } from "../src/db/schema";
import { handleChatCompletion } from "../src/proxy/index";
import { pool } from "../src/proxy/pool";
import { provider } from "../src/proxy/router";
import { acquireSessionLock, clearSessionLocks } from "../src/proxy/session-lock";
import {
  commitSession,
  deleteSessionState,
  getSessionMessages,
  prepareSession,
} from "../src/provider/session-state";

const sessions = new Set<string>();
const accountIds = new Set<number>();

function sessionId(label: string): string {
  const id = `codex:test-${label}-${crypto.randomUUID()}`;
  sessions.add(id);
  return id;
}

async function createAccount(label: string) {
  const [created] = await db.insert(accounts).values({
    email: `${label}-${crypto.randomUUID()}@example.com`,
    password: "unused",
    status: "active",
    enabled: true,
    tokens: JSON.stringify({
      postman_sid: `sid-${label}`,
      user_id: `user-${label}`,
      workspace_id: `workspace-${label}`,
      workspace_subdomain: `workspace-${label}`,
    }),
  }).returning();
  accountIds.add(created!.id);
  return created!;
}

afterEach(async () => {
  clearSessionLocks();
  pool.clearRuntimeState();
  for (const id of sessions) await deleteSessionState(id);
  sessions.clear();
  for (const id of accountIds) {
    await db.delete(requestLogs).where(eq(requestLogs.accountId, id));
    await db.delete(accounts).where(eq(accounts.id, id));
  }
  accountIds.clear();
});

describe("persistent session state", () => {
  test("returns a client validation error when Postman rejects forwarded tools", async () => {
    const selected = await createAccount("request-rejected");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      chatCompletion: providerAny.chatCompletion,
    };

    try {
      poolAny.getActiveAccounts = async () => [selected];
      providerAny.chatCompletion = async () => ({
        success: false,
        requestRejected: true,
        mcpRejected: true,
        error: "INPUT_VALIDATION_ERROR: Forbidden",
      });

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "trigger validation rejection" }],
        stream: false,
      });
      const payload = await response.json() as any;

      expect(response.status).toBe(400);
      expect(payload.error.type).toBe("invalid_request");
      expect(payload.error.message).toContain("INPUT_VALIDATION_ERROR: Forbidden");
      expect((await db.select().from(accounts).where(eq(accounts.id, selected.id)))[0]?.status)
        .toBe("active");
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

  test("restores stable history when the client sends only the next turn", async () => {
    const id = sessionId("restore");
    await commitSession(
      id,
      [{ role: "user", content: "first question" }],
      { role: "assistant", content: "first answer" },
      101,
    );

    const prepared = await prepareSession(id, [{ role: "user", content: "second question" }]);

    expect(prepared.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]);
  });

  test("persists the replacement account after a successful failover", async () => {
    const id = sessionId("failover");
    const first = await createAccount("first");
    const second = await createAccount("second");
    await commitSession(
      id,
      [{ role: "user", content: "remember this" }],
      { role: "assistant", content: "remembered" },
      first.id,
    );

    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markExhausted: poolAny.markExhausted,
      markUsed: poolAny.markUsed,
      chatCompletion: providerAny.chatCompletion,
    };
    const attempts: Array<{ accountId: number; messages: unknown[] }> = [];

    try {
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markExhausted = async (accountId: number) => {
        pool.releaseAccountBindings(accountId);
      };
      poolAny.markUsed = async () => {};
      providerAny.chatCompletion = async (selectedAccount: any, request: any) => {
        attempts.push({ accountId: selectedAccount.id, messages: request.messages });
        if (attempts.length === 1) {
          return { success: false, quotaExhausted: true, error: "Quota exhausted" };
        }
        return {
          success: true,
          response: {
            id: "response",
            object: "chat.completion",
            created: 0,
            model: request.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "continued on replacement" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        };
      };

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "continue" }],
        stream: false,
        _sessionId: id,
      });

      expect(response.status).toBe(200);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.accountId).not.toBe(attempts[0]!.accountId);
      expect(attempts[0]!.messages).toEqual(attempts[1]!.messages);
      expect(attempts[1]!.messages).toEqual([
        { role: "user", content: "remember this" },
        { role: "assistant", content: "remembered" },
        { role: "user", content: "continue" },
      ]);
      expect(await getSessionMessages(id)).toEqual([
        ...attempts[1]!.messages,
        { role: "assistant", content: "continued on replacement" },
      ]);
      const [state] = await db.select().from(sessionStates)
        .where(eq(sessionStates.sessionId, id)).limit(1);
      expect(state?.accountId).toBe(attempts[1]!.accountId);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markExhausted = originals.markExhausted;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletion = originals.chatCompletion;
    }
  });

  test("restores the persisted account binding after runtime state is cleared", async () => {
    const id = sessionId("restart-binding");
    const first = await createAccount("restart-first");
    const second = await createAccount("restart-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      await commitSession(
        id,
        [{ role: "user", content: "remember account" }],
        { role: "assistant", content: "remembered" },
        first.id,
      );
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];

      expect((await pool.getNextAccount(id))?.id).toBe(first.id);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("hides partial output and replays the stream after quota exhaustion", async () => {
    const id = sessionId("stream-failover");
    const first = await createAccount("stream-first");
    const second = await createAccount("stream-second");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    const attemptedAccountIds: number[] = [];
    const encoder = new TextEncoder();

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attemptedAccountIds.push(selectedAccount.id);
        if (attemptedAccountIds.length === 1) {
          let failureHandler: ((failure: any) => void | Promise<void>) | undefined;
          let streamFailure: any;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: partial-from-exhausted-account\n\n"));
            },
            async pull(controller) {
              streamFailure = {
                kind: "quota_exhausted",
                error: new Error("Quota exhausted after partial output"),
              };
              await failureHandler?.(streamFailure);
              controller.error(streamFailure.error);
            },
          });
          return {
            success: true,
            stream,
            getStreamMessage: () => ({
              role: "assistant",
              content: "partial-from-exhausted-account",
            }),
            getStreamFailure: () => streamFailure,
            setStreamFailureHandler(handler: typeof failureHandler) {
              failureHandler = handler;
            },
          };
        }

        return {
          success: true,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode("data: replacement-complete\n\n"));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          getStreamMessage: () => ({
            role: "assistant",
            content: "replacement-complete",
          }),
        };
      };

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "continue safely" }],
        stream: true,
        _sessionId: id,
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(attemptedAccountIds).toHaveLength(2);
      expect(attemptedAccountIds[1]).not.toBe(attemptedAccountIds[0]);
      expect(text).not.toContain("partial-from-exhausted-account");
      expect(text).toContain("replacement-complete");
      expect(text).toContain("[DONE]");

      const [exhausted] = await db.select().from(accounts)
        .where(eq(accounts.id, attemptedAccountIds[0]!)).limit(1);
      expect(exhausted?.status).toBe("exhausted");
      const [state] = await db.select().from(sessionStates)
        .where(eq(sessionStates.sessionId, id)).limit(1);
      expect(state?.accountId).toBe(attemptedAccountIds[1]);
      expect(await getSessionMessages(id)).toEqual([
        { role: "user", content: "continue safely" },
        { role: "assistant", content: "replacement-complete" },
      ]);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });

  test("exposes a post-delta upstream error as an OpenAI-compatible SSE event", async () => {
    const id = sessionId("stream-error-visible");
    const account = await createAccount("stream-error-visible");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    const encoder = new TextEncoder();
    const diagnostic = "MCP diagnostic: pure_chat=pass; noop_tool=fail(INPUT_VALIDATION_ERROR: Forbidden)";

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [account];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async () => ({
        success: true,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("data: partial-before-error\n\n"));
          },
          pull(controller) {
            controller.error(new Error(diagnostic));
          },
        }),
      });

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "trigger upstream error" }],
        stream: true,
        _sessionId: id,
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("partial-before-error");
      expect(text).toContain(JSON.stringify({
        error: {
          message: diagnostic,
          type: "upstream_error",
        },
      }));
      expect(text).toContain("data: [DONE]");
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });

  test("cancels the active upstream and releases the lease when the client disconnects", async () => {
    const id = sessionId("stream-cancel");
    const account = await createAccount("cancel-account");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    let sourceCancelCount = 0;

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [account];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async () => ({
        success: true,
        stream: new ReadableStream<Uint8Array>({
          cancel() {
            sourceCancelCount++;
          },
        }),
      });

      const response = await handleChatCompletion({
        model: "auto",
        messages: [{ role: "user", content: "wait" }],
        stream: true,
        _sessionId: id,
      });
      await Bun.sleep(0);
      await response.body!.cancel("client disconnected");

      expect(sourceCancelCount).toBe(1);
      expect(poolAny.getInFlightCount(account.id)).toBe(0);
      const release = await acquireSessionLock(id);
      release();
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });
});

describe("session execution order", () => {
  test("serializes the same session while allowing another session through", async () => {
    const firstRelease = await acquireSessionLock("same-session");
    const order: string[] = [];

    const second = acquireSessionLock("same-session").then((release) => {
      order.push("same");
      release();
    });
    const other = acquireSessionLock("other-session").then((release) => {
      order.push("other");
      release();
    });

    await other;
    expect(order).toEqual(["other"]);
    firstRelease();
    await second;
    expect(order).toEqual(["other", "same"]);
  });
});

describe("account leasing", () => {
  test("balances concurrent sessions and releases only the matching lease", async () => {
    const first = await createAccount("lease-first");
    const second = await createAccount("lease-second");
    const poolAny = pool as any;
    const originalGetActiveAccounts = poolAny.getActiveAccounts;

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      const leases = await Promise.all([
        pool.acquireNextAccount("session-1"),
        pool.acquireNextAccount("session-2"),
        pool.acquireNextAccount("session-3"),
        pool.acquireNextAccount("session-4"),
      ]);
      const assigned = leases.map((lease) => lease!.account.id);

      expect(assigned.filter((id) => id === first.id)).toHaveLength(2);
      expect(assigned.filter((id) => id === second.id)).toHaveLength(2);
      expect(poolAny.getInFlightCount(first.id)).toBe(2);
      expect(poolAny.getInFlightCount(second.id)).toBe(2);

      for (const lease of leases) {
        pool.trackRequestEnd(lease!.account.id, lease!.leaseId);
      }
      expect(poolAny.getInFlightCount(first.id)).toBe(0);
      expect(poolAny.getInFlightCount(second.id)).toBe(0);
    } finally {
      poolAny.getActiveAccounts = originalGetActiveAccounts;
    }
  });

  test("does not let an old request release a newer lease", () => {
    const poolAny = pool as any;
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;

    try {
      pool.clearRuntimeState();
      const oldLease = pool.trackRequestStart(999_001);
      now += 10 * 60 * 1000 + 1;
      expect(poolAny.getInFlightCount(999_001)).toBe(0);

      const freshLease = pool.trackRequestStart(999_001);
      pool.trackRequestEnd(999_001, oldLease);
      expect(poolAny.getInFlightCount(999_001)).toBe(1);

      pool.trackRequestEnd(999_001, freshLease);
      expect(poolAny.getInFlightCount(999_001)).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  test("switches immediately after rate limiting and cools the failed account", async () => {
    const first = await createAccount("rate-first");
    const second = await createAccount("rate-second");
    const poolAny = pool as any;
    const providerAny = provider as any;
    const originals = {
      getActiveAccounts: poolAny.getActiveAccounts,
      markUsed: poolAny.markUsed,
      chatCompletionStream: providerAny.chatCompletionStream,
    };
    const attempts: number[] = [];

    try {
      pool.clearRuntimeState();
      poolAny.getActiveAccounts = async () => [first, second];
      poolAny.markUsed = async () => {};
      providerAny.chatCompletionStream = async (selectedAccount: any) => {
        attempts.push(selectedAccount.id);
        if (attempts.length === 1) {
          return {
            success: false,
            rateLimited: true,
            retryAfterMs: 60_000,
            error: "Postman rate limited",
          };
        }
        return {
          success: true,
          stream: new ReadableStream({ start(controller) { controller.close(); } }),
        };
      };

      const startedAt = performance.now();
      const routed = await (await import("../src/proxy/router")).routeRequest({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        _sessionId: "rate-limit-session",
      }, true);

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(attempts).toEqual([first.id, second.id]);
      expect((await pool.getNextAccount("new-session"))?.id).toBe(second.id);
      pool.trackRequestEnd(routed.account.id, routed.leaseId);
    } finally {
      poolAny.getActiveAccounts = originals.getActiveAccounts;
      poolAny.markUsed = originals.markUsed;
      providerAny.chatCompletionStream = originals.chatCompletionStream;
    }
  });
});

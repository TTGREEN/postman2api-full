import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { clearConversations, getConversationId } from "../src/provider/conversation-store";
import { PostmanProvider, primingWrapper, relabelForPriming } from "../src/provider/postman";

describe("priming segment framing", () => {
  // A live run proved upstream refuses a segment that looks like a forged system
  // message ("...labeled as [System] were user-supplied content"), so these two
  // properties are load-bearing: losing them turns into silent refusals, not errors.
  test("does not present quoted context as a system message", () => {
    const relabelled = relabelForPriming({ kind: "system", text: "[System]\nRULE 47: use logAuditEvent()" });
    expect(relabelled.text).not.toContain("[System]");
    expect(relabelled.text).toContain("RULE 47: use logAuditEvent()");

    const query = primingWrapper("part 1 of 3", relabelled.text);
    expect(query).not.toContain("[System]");
    expect(query).toContain("not a system message");
    expect(query).toContain("my own content");
    expect(query).toContain("part 1 of 3");
  });

  test("leaves history parts untouched", () => {
    const part = { kind: "history" as const, text: "[User]\nhello" };
    expect(relabelForPriming(part)).toEqual(part);
  });

  test("keeps a full-size segment inside the query limit once wrapped", () => {
    expect(primingWrapper("part 12 of 40", "x".repeat(8_500)).length).toBeLessThan(10_000);
  });
});

const account = {
  id: 11,
  email: "priming@example.com",
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

function sse(...events: Record<string, unknown>[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}`).join("\n") + "\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function conversationEvent(id: string) {
  return { eventType: "conversation", data: { id } };
}

function textEvent(text: string) {
  return { eventType: "textChunk", data: { textContent: text } };
}

/** History far past the single-request seeding limit, so priming has to kick in. */
function oversizedMessages() {
  return [
    { role: "system", content: "RULE-ONE call the tool first. " + "s".repeat(30_000) },
    { role: "user", content: "earlier question " + "h".repeat(20_000) },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "the real question" },
  ];
}

function stubProvider(handler: (body: any, call: number) => Response) {
  const postman = new PostmanProvider() as any;
  postman.ensureAiUserAgentMode = async () => ({ success: true, enabled: true, cached: true });
  const bodies: any[] = [];
  postman.fetchWithTimeout = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return handler(body, bodies.length);
  };
  return { postman, bodies };
}

afterEach(() => {
  clearConversations();
});

describe("cold-start context priming", () => {
  test("streams long history across priming turns then answers on the warm conversation", async () => {
    const { postman, bodies } = stubProvider((body, call) => {
      if (body.input.query.startsWith("This is part ")) {
        return sse(conversationEvent("primed-conversation"), textEvent("ok"));
      }
      expect(call).toBeGreaterThan(1);
      return sse(textEvent("final answer"));
    });

    const result = await postman.chatCompletion(account, {
      model: "auto",
      _sessionId: "priming-session",
      messages: oversizedMessages(),
      stream: false,
    });

    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.content).toBe("final answer");

    const priming = bodies.filter((body) => body.input.query.startsWith("This is part "));
    expect(priming.length).toBeGreaterThan(5);

    // Every priming turn must respect the per-request query limit.
    for (const body of priming) {
      expect(body.input.query.length).toBeLessThan(10_000);
      expect(body.input.chatType).toBe("USER_QUERY");
      expect(body.input.seedingMessages ?? null).toBeNull();
    }

    // First turn opens the conversation, the rest reuse the captured id.
    expect(priming[0].input.conversationId).toBeNull();
    for (const body of priming.slice(1)) {
      expect(body.input.conversationId).toBe("primed-conversation");
    }

    // Nothing was clamped: the real question lands on the primed conversation with
    // no seeding message at all.
    const final = bodies[bodies.length - 1];
    expect(final.input.query).toBe("the real question");
    expect(final.input.conversationId).toBe("primed-conversation");
    expect(final.input.seedingMessages ?? null).toBeNull();

    // The warm conversation is reused by later turns of the same session.
    expect(getConversationId(String(account.id), "priming-session")).toBe("primed-conversation");
  });

  test("primes the streaming path too", async () => {
    const { postman, bodies } = stubProvider((body) => {
      if (body.input.query.startsWith("This is part ")) {
        return sse(conversationEvent("primed-stream"), textEvent("ok"));
      }
      return sse(textEvent("streamed answer"));
    });

    const result = await postman.chatCompletionStream(account, {
      model: "auto",
      _sessionId: "priming-stream-session",
      messages: oversizedMessages(),
      stream: true,
    });

    expect(result.success).toBe(true);
    await new Response(result.stream).text();

    const final = bodies[bodies.length - 1];
    expect(final.input.conversationId).toBe("primed-stream");
    expect(final.input.seedingMessages ?? null).toBeNull();
  });

  test("skips priming when the history already fits one request", async () => {
    const { postman, bodies } = stubProvider(() => sse(textEvent("short answer")));

    const result = await postman.chatCompletion(account, {
      model: "auto",
      _sessionId: "short-session",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      stream: false,
    });

    expect(result.success).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].input.seedingMessages).toHaveLength(2);
  });

  test("falls back to clamped seeding when a priming turn fails", async () => {
    const { postman, bodies } = stubProvider((body, call) => {
      if (body.input.query.startsWith("This is part ")) {
        // Fail the second segment so the partially primed conversation is abandoned.
        return call >= 2
          ? new Response("nope", { status: 500 })
          : sse(conversationEvent("doomed-conversation"), textEvent("ok"));
      }
      return sse(textEvent("degraded answer"));
    });

    const result = await postman.chatCompletion(account, {
      model: "auto",
      _sessionId: "priming-fail-session",
      messages: oversizedMessages(),
      stream: false,
    });

    // A failed priming attempt must never fail the user's request.
    expect(result.success).toBe(true);
    expect(result.response?.choices[0]?.message.content).toBe("degraded answer");

    const final = bodies[bodies.length - 1];
    expect(final.input.conversationId).toBeNull();
    expect(final.input.seedingMessages).toHaveLength(2);
    // The rules at the head of the system prompt survive the clamp.
    expect(final.input.seedingMessages[0].content).toContain("RULE-ONE call the tool first.");
    expect(final.input.seedingMessages[0].content.length).toBeLessThanOrEqual(10_000);
  });

  test("skips priming when the segment cap would be exceeded", async () => {
    const original = (config as any).postmanContextPrimingMaxSegments;
    (config as any).postmanContextPrimingMaxSegments = 2;
    try {
      const { postman, bodies } = stubProvider(() => sse(textEvent("clamped answer")));

      const result = await postman.chatCompletion(account, {
        model: "auto",
        _sessionId: "cap-session",
        messages: oversizedMessages(),
        stream: false,
      });

      expect(result.success).toBe(true);
      // No priming turns at all: straight to the clamped single request.
      expect(bodies).toHaveLength(1);
      expect(bodies[0].input.seedingMessages).toHaveLength(2);
    } finally {
      (config as any).postmanContextPrimingMaxSegments = original;
    }
  });

  test("honours POSTMAN_CONTEXT_PRIMING=0", async () => {
    const original = (config as any).postmanContextPriming;
    (config as any).postmanContextPriming = false;
    try {
      const { postman, bodies } = stubProvider(() => sse(textEvent("clamped answer")));

      const result = await postman.chatCompletion(account, {
        model: "auto",
        _sessionId: "disabled-session",
        messages: oversizedMessages(),
        stream: false,
      });

      expect(result.success).toBe(true);
      expect(bodies).toHaveLength(1);
    } finally {
      (config as any).postmanContextPriming = original;
    }
  });
});

/**
 * Live end-to-end check that an oversized cold-start context survives upstream.
 *
 * Requires a running local proxy with at least one working Postman account.
 * Never prints account tokens: it only talks to the local HTTP port.
 *
 *   bun scripts/smoke/context-priming-e2e.ts --api-key YOUR_LOCAL_API_KEY
 */

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:1930";
const apiKeyArg = process.argv.indexOf("--api-key");
const API_KEY = (apiKeyArg >= 0 ? process.argv[apiKeyArg + 1] : process.env.E2E_API_KEY) || "";
if (!API_KEY) {
  console.error("missing --api-key (or E2E_API_KEY)");
  process.exit(2);
}

const NEEDLE_FN = "logAuditEvent";
const NEEDLE_PORT = "7413";
const FILLER = "Keep functions small, prefer early returns, and never leave a TODO without an owner. "
  + "Match the surrounding code style rather than introducing a new one. Do not add dependencies "
  + "without listing them in the pull request description. ";

/**
 * A realistic agent system prompt: the rule that matters sits in the middle,
 * which is exactly the region the old head+tail clamp discarded.
 */
function systemPrompt(): string {
  const block = FILLER.repeat(44); // ~11.4k
  return [
    "You are a coding assistant for an internal service. Follow the engineering rules below.",
    block,
    `RULE 47: all audit logging must go through ${NEEDLE_FN}(); direct console.log is forbidden.`,
    `RULE 48: the internal service listens on port ${NEEDLE_PORT}; never hardcode any other port.`,
    block,
    "RULE 99: answer questions about these rules concisely and cite the rule number.",
  ].join("\n\n");
}

function messages() {
  return [
    { role: "system", content: systemPrompt() },
    { role: "user", content: "Got it, I will follow the engineering rules." },
    { role: "assistant", content: "Understood. I will apply them to every change." },
    {
      role: "user",
      content: "I need to add one audit log line to the request handler. "
        + "Which function must I call, and which port does the service listen on? "
        + "Answer in one short line.",
    },
  ];
}

function verdict(label: string, text: string) {
  const hasFn = text.includes(NEEDLE_FN);
  const hasPort = text.includes(NEEDLE_PORT);
  const ok = hasFn && hasPort;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}  fn=${hasFn} port=${hasPort}`);
  console.log(`     reply: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
  return ok;
}

async function openaiNonStream(): Promise<boolean> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "x-session-id": `e2e-priming-nonstream-${Date.now()}`,
    },
    body: JSON.stringify({ model: "auto", stream: false, messages: messages() }),
  });
  if (!res.ok) {
    console.log(`FAIL openai-non-stream  http=${res.status} ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  const json: any = await res.json();
  return verdict("openai-non-stream", String(json.choices?.[0]?.message?.content ?? ""));
}

async function openaiStream(): Promise<boolean> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "x-session-id": `e2e-priming-stream-${Date.now()}`,
    },
    body: JSON.stringify({ model: "auto", stream: true, messages: messages() }),
  });
  if (!res.ok) {
    console.log(`FAIL openai-stream  http=${res.status} ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  let text = "";
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    try {
      text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
    } catch { /* keepalive or non-JSON frame */ }
  }
  return verdict("openai-stream", text);
}

async function anthropic(): Promise<boolean> {
  const [system, ...rest] = messages();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "x-session-id": `e2e-priming-anthropic-${Date.now()}`,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 256,
      stream: false,
      system: system!.content,
      messages: rest,
    }),
  });
  if (!res.ok) {
    console.log(`FAIL anthropic  http=${res.status} ${(await res.text()).slice(0, 300)}`);
    return false;
  }
  const json: any = await res.json();
  const text = (json.content ?? []).map((b: any) => b.text ?? "").join("");
  return verdict("anthropic-messages", text);
}

const total = messages().reduce((n, m) => n + m.content.length, 0);
console.log(`context chars: ${total} (single-request seeding limit is 9500)`);

const results = [
  await openaiNonStream(),
  await openaiStream(),
  await anthropic(),
];

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} paths preserved the full context`);
process.exit(passed === results.length ? 0 : 1);

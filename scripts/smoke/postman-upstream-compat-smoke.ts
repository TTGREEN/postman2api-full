interface Args {
  baseUrl: string;
  apiKey?: string;
  chat: boolean;
  model: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseUrl: process.env.POSTMAN2API_BASE_URL || "http://127.0.0.1:1930",
    apiKey: process.env.POSTMAN2API_API_KEY,
    chat: false,
    model: process.env.POSTMAN2API_MODEL || "auto",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] || args.baseUrl;
    else if (arg === "--api-key") args.apiKey = argv[++i] || args.apiKey;
    else if (arg === "--model") args.model = argv[++i] || args.model;
    else if (arg === "--chat") args.chat = true;
    else if (arg === "--help") {
      console.log(`Usage: bun run smoke:upstream -- --api-key KEY [--base-url http://127.0.0.1:1930] [--chat] [--model auto]

Checks local service health and model discovery. Add --chat to run a minimal upstream Agent Mode request through the configured account pool.`);
      process.exit(0);
    }
  }
  return args;
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; text: string; json?: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
  return { status: response.status, text, json };
}

function classifyFailure(text: string): string {
  const normalized = text.toLowerCase();
  if (normalized.includes("agent mode") || normalized.includes("ai_user_agent_mode") || normalized.includes("user agent mode")) {
    return "AGENT_MODE_NOT_READY: run account test/warmup or confirm Postman Agent Mode is enabled for the account.";
  }
  if (normalized.includes("quota") || normalized.includes("monthly ai credit") || normalized.includes("pay-as-you-go")) {
    return "QUOTA_EXHAUSTED_OR_DISABLED: check Postman team AI credits and pay-as-you-go settings.";
  }
  if (normalized.includes("no active accounts") || normalized.includes("add a postman account")) {
    return "NO_ACTIVE_ACCOUNT: add or enable at least one valid Postman account.";
  }
  if (normalized.includes("401") || normalized.includes("invalid api key")) {
    return "LOCAL_API_AUTH_FAILED: check POSTMAN2API_API_KEY or the configured API key.";
  }
  return "UNKNOWN_UPSTREAM_COMPATIBILITY_FAILURE";
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl.replace(/\/$/, "");
console.log(`[upstream-smoke] baseUrl=${baseUrl}`);

const health = await requestJson(`${baseUrl}/health`);
console.log(`[upstream-smoke] health status=${health.status}`);
if (health.status !== 200) throw new Error(`health check failed: ${health.status} ${health.text}`);

if (!args.apiKey) {
  console.log("[upstream-smoke] skipped /v1 checks because --api-key or POSTMAN2API_API_KEY was not provided.");
  process.exit(0);
}

const auth = { Authorization: `Bearer ${args.apiKey}` };
const models = await requestJson(`${baseUrl}/v1/models`, { headers: auth });
console.log(`[upstream-smoke] models status=${models.status}`);
if (models.status !== 200) throw new Error(`${classifyFailure(models.text)}: ${models.text}`);

if (!args.chat) {
  console.log("[upstream-smoke] model discovery OK. Add --chat to test a live upstream Agent Mode call.");
  process.exit(0);
}

const chat = await requestJson(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: args.model,
    stream: false,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with POSTMAN2API_OK only." }],
  }),
});
console.log(`[upstream-smoke] chat status=${chat.status}`);
if (chat.status !== 200) throw new Error(`${classifyFailure(chat.text)}: ${chat.text}`);
const content = chat.json?.choices?.[0]?.message?.content;
if (typeof content !== "string" || content.length === 0) throw new Error(`chat returned empty content: ${chat.text}`);
console.log(`[upstream-smoke] chat OK content=${JSON.stringify(content.slice(0, 80))}`);

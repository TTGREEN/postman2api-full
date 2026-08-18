import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { HumanVerificationFlow } from "../../src/security/human-verification-flow";
import { InMemoryVerificationGrantStore, verifyTurnstile, type VerificationBinding } from "../../src/security/turnstile";

const TEST_SECRET = "1x0000000000000000000000000000000AA";
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const artifactRoot = ".test-state/artifacts/turnstile-interaction-lab";
const browserPaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = browserPaths.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error("No supported local Chrome or Edge executable was found");

const binding: VerificationBinding = {
  sessionId: "interaction-lab-session",
  action: "signup",
  payloadHash: createHash("sha256").update("interaction-lab-payload").digest("hex"),
};
const trace: string[] = [];

function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const grants = new InMemoryVerificationGrantStore();
const flow = new HumanVerificationFlow({
  grants,
  verify: async (token) => withTimeout(verifyTurnstile({ token, secret: TEST_SECRET }), "Turnstile test verification"),
});

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function pageHtml(): string {
  return `<!doctype html>
<html><body>
  <h1>受控人机交互实验室</h1>
  <p data-testid="stage">awaiting_interaction</p>
  <button type="button" id="verify">Verify you are human</button>
  <button type="button" id="submit" disabled>提交受保护操作</button>
  <p data-testid="result"></p>
  <script>
    let grantId = '';
    const stage = document.querySelector('[data-testid="stage"]');
    const result = document.querySelector('[data-testid="result"]');
    const verify = document.querySelector('#verify');
    const submit = document.querySelector('#submit');
    verify.addEventListener('click', async () => {
      await fetch('/api/interaction', { method: 'POST' });
      const verified = await fetch('/api/verify', { method: 'POST' }).then((r) => r.json());
      stage.textContent = verified.stage;
      if (verified.grantId) { grantId = verified.grantId; submit.disabled = false; result.textContent = 'server_verified'; }
      else result.textContent = 'verification_rejected';
    });
    submit.addEventListener('click', async () => {
      const response = await fetch('/api/submit', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({grantId}) }).then((r) => r.json());
      stage.textContent = response.stage;
      result.textContent = response.ok ? 'business_action_accepted' : response.code;
    });
  </script>
</body></html>`;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/interaction") {
      const state = flow.recordInteraction();
      trace.push(`interaction:${state.stage}`);
      sendJson(response, state);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/verify") {
      const state = await flow.verify(TEST_TOKEN, binding);
      trace.push(`server_verification:${state.stage}`);
      sendJson(response, state, state.stage === "verified" ? 200 : 403);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/submit") {
      const body = await readJson(request);
      const consumed = flow.consumeSubmission(typeof body.grantId === "string" ? body.grantId : "", binding);
      trace.push(`business_submit:${consumed.ok ? "accepted" : consumed.code}`);
      sendJson(response, { ...consumed, stage: flow.snapshot().stage }, consumed.ok ? 200 : 403);
      return;
    }
    response.writeHead(404).end("Not found");
  })().catch((error) => {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Local interaction lab did not obtain a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;

await mkdir(artifactRoot, { recursive: true });
console.log(`[lab] server=${baseUrl}`);
console.log(`[lab] browser-launch=${executablePath}`);
const browser = await chromium.launch({ headless: true, executablePath });
console.log("[lab] browser-launched");
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.setDefaultTimeout(15_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  console.log("[lab] page-loaded");
  await page.getByRole("button", { name: "Verify you are human" }).click();
  console.log("[lab] interaction-clicked");
  await page.waitForFunction(() => document.querySelector("[data-testid='stage']")?.textContent === "verified", undefined, { timeout: 15_000 });
  console.log("[lab] server-verified");
  await page.getByRole("button", { name: "提交受保护操作" }).click();
  await page.waitForFunction(() => document.querySelector("[data-testid='result']")?.textContent === "business_action_accepted", undefined, { timeout: 15_000 });
  console.log("[lab] business-action-accepted");
  await page.screenshot({ path: `${artifactRoot}/interaction-flow.png`, fullPage: true });

  if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(" | ")}`);
  console.log(JSON.stringify({ baseUrl, trace, final: flow.snapshot(), screenshot: `${artifactRoot}/interaction-flow.png` }));
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

import { createInterface } from "node:readline";
import {
  confirmSignupCompletion,
  loginPostman,
  prepareSignupConfirmation,
  type PostmanLoginOptions,
} from "../../src/auth/postman-login.ts";
import { launchLoginBrowser } from "../../src/auth/browser-launcher.ts";

type StartMessage = { type: "start"; accountLabel?: string; options: PostmanLoginOptions };
type ConfirmMessage = { type: "confirm"; confirmationId: string };
let started = false;

function send(message: unknown): void {
  process.stdout.write(`POSTMAN_WORKER ${JSON.stringify(message)}\n`);
}

async function runSmoke(): Promise<void> {
  const browser = await launchLoginBrowser("camoufox", { headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
  } finally {
    await browser.close();
  }
  send({ type: "smoke_result", ok: true });
}

if (process.argv.includes("--smoke")) {
  await runSmoke();
} else {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message: StartMessage | ConfirmMessage;
    try { message = JSON.parse(line) as StartMessage | ConfirmMessage; } catch { return; }
    if (message.type === "confirm" && message.confirmationId) {
      confirmSignupCompletion(message.confirmationId);
      return;
    }
    if (message.type !== "start" || started) return;
    started = true;
    const options = message.options ?? {};
    if (options.flow === "signup" && options.confirmationId) {
      prepareSignupConfirmation(options.confirmationId);
    }
    void loginPostman(message.accountLabel, {
      ...options,
      onLog: (entry) => send({ type: "log", entry }),
    }).then((result) => {
      send({ type: "result", result });
      input.close();
      process.exitCode = result.error ? 1 : 0;
    }).catch((error) => {
      send({ type: "result", result: {
        postman_sid: "", user_id: "", workspace_id: "", workspace_subdomain: "",
        error: error instanceof Error ? error.message : String(error),
      }});
      input.close();
      process.exitCode = 1;
    });
  });
  process.stdin.resume();
}

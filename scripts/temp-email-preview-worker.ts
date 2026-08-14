import { createInterface } from "node:readline";
import { CONFIG } from "../packages/postman-register/src/config.ts";
import { launchBrowser } from "../packages/postman-register/src/core/browser.ts";
import {
  acquireEmailAddress,
  getBlockingState,
} from "../packages/postman-register/src/selectors/tempMail.ts";

function send(message: unknown): void {
  process.stdout.write(`TEMP_EMAIL_PREVIEW ${JSON.stringify(message)}\n`);
}

const browser = await launchBrowser();
let closing = false;
try {
  const page = await browser.newPage();
  const previewUrl = process.env.TEMP_EMAIL_PREVIEW_URL?.trim() || CONFIG.urls.tempMail;
  await page.goto(previewUrl, {
    waitUntil: "domcontentloaded",
    timeout: CONFIG.timeouts.pageLoad,
  });
  const blocked = await getBlockingState(page);
  if (blocked) throw new Error(blocked);
  const email = await acquireEmailAddress(page);
  await page.bringToFront();
  send({ type: "ready", email });

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message: { type?: string };
    try { message = JSON.parse(line) as { type?: string }; } catch { return; }
    if (message.type === "focus") {
      void page.bringToFront()
        .then(() => send({ type: "focused" }))
        .catch((error) => send({
          type: "focus_error",
          error: error instanceof Error ? error.message : "Temporary email preview window could not be focused",
        }));
    }
    if (message.type === "close" && !closing) {
      closing = true;
      input.close();
      void browser.close().finally(() => process.exit(0));
    }
  });
  process.stdin.resume();
  await new Promise<void>((resolve) => input.once("close", resolve));
} catch (error) {
  send({
    type: "error",
    error: error instanceof Error ? error.message : "Temporary email preview failed",
  });
  process.exitCode = 1;
} finally {
  if (!closing) await browser.close().catch(() => undefined);
}

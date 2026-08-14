import { launchLoginBrowser } from "../src/auth/browser-launcher.ts";
import { smokePostmanLoginWorker } from "../src/auth/postman-login-runtime.ts";

const publicLoginPage = process.argv.includes("--postman-login");
if (typeof Bun !== "undefined" && !publicLoginPage) {
  await smokePostmanLoginWorker();
  console.log("Camoufox smoke: Bun launched the Node worker, opened about:blank, and cleaned up");
  process.exit(0);
}

const browser = await launchLoginBrowser("camoufox", { headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  console.log("Camoufox smoke: module import, launch, about:blank, and close succeeded");
  if (publicLoginPage) {
    await page.goto("https://identity.getpostman.com/login", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    console.log(`Camoufox smoke: public Postman login page loaded (${page.url()})`);
  }
} finally {
  await browser.close();
}

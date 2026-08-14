import { launchBrowser } from "./core/browser";
import { CONFIG } from "./config";
import { getBlockingState } from "./selectors/tempMail";

await import("./steps/tempEmail");

const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(CONFIG.urls.tempMail, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const blocked = await getBlockingState(page);
  const mailFieldVisible = await page.locator("#mail").isVisible().catch(() => false);
  if (blocked) throw new Error(`Temp Mail page blocked: ${blocked}`);
  if (!mailFieldVisible) throw new Error("Temp Mail selector #mail is not visible");
  console.log("Postman register smoke: Camoufox opened Temp Mail and found the visible mail field");
} finally {
  await browser.close();
}

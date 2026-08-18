import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const baseUrl = process.env.TEMP_EMAIL_E2E_BASE_URL || "http://127.0.0.1:1933";
const artifactRoot = ".test-state/artifacts/temp-email-preview-e2e";
const browserPaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const executablePath = browserPaths.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error("No supported local Chrome or Edge executable was found");

await mkdir(artifactRoot, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const requests: Array<{ method: string; path: string }> = [];

await page.route("**/api/accounts/signup/email-preview**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && path === "/api/accounts/signup/email-preview") {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        sessionId: "11111111-1111-4111-8111-111111111111",
        email: "preview.user@example.com",
        expiresAt: Date.now() + 10 * 60_000,
      }),
    });
    return;
  }
  if (request.method() === "POST" && path.endsWith("/open")) {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });
    return;
  }
  if (request.method() === "DELETE") {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true }) });
    return;
  }
  await route.abort();
});

page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/accounts/")) {
    requests.push({ method: request.method(), path: url.pathname });
  }
});

function signupRequestCount(): number {
  return requests.filter(({ path }) =>
    !path.includes("/signup/email-preview")
    && (path.includes("/signup") || path.includes("/login")),
  ).length;
}

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "添加账号" }).click();
  await page.getByRole("button", { name: "自动化注册" }).click();
  await page.getByRole("button", { name: "获取测试邮箱" }).click();

  const emailInput = page.getByPlaceholder("user@example.com");
  await page.getByRole("button", { name: "打开收件箱" }).waitFor({ state: "visible", timeout: 90_000 });
  const email = await emailInput.inputValue();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Email was not filled");
  if (signupRequestCount() !== 0) throw new Error("Signup endpoint was called during email preview");

  await page.screenshot({ path: `${artifactRoot}/desktop.png`, fullPage: true });
  const createRequests = requests.filter(({ method, path }) =>
    method === "POST" && path === "/api/accounts/signup/email-preview",
  ).length;
  if (createRequests !== 1) throw new Error(`Expected one preview create request, got ${createRequests}`);

  await page.getByRole("button", { name: "打开收件箱" }).click();
  const openRequests = requests.filter(({ method, path }) =>
    method === "POST" && path.endsWith("/open") && path.includes("/signup/email-preview/"),
  ).length;
  if (openRequests !== 1) throw new Error(`Expected one preview open request, got ${openRequests}`);
  if (signupRequestCount() !== 0) throw new Error("Signup endpoint was called while opening inbox");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifactRoot}/mobile.png`, fullPage: true });
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth) {
    throw new Error(`Mobile horizontal overflow: ${dimensions.scrollWidth}/${dimensions.clientWidth}`);
  }

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "获取测试邮箱" }).waitFor({ state: "visible", timeout: 10_000 });
  const deleteRequests = requests.filter(({ method, path }) =>
    method === "DELETE" && path.includes("/signup/email-preview/"),
  ).length;
  if (deleteRequests !== 1) throw new Error(`Expected one preview delete request, got ${deleteRequests}`);
  if (signupRequestCount() !== 0) throw new Error("Signup endpoint was called during preview cleanup");

  console.log(JSON.stringify({
    desktop: { width: 1280, height: 900 },
    mobile: { width: 390, height: 844, ...dimensions },
    emailFilled: true,
    createRequests,
    openRequests,
    deleteRequests,
    signupRequests: signupRequestCount(),
  }));
} finally {
  await browser.close();
}

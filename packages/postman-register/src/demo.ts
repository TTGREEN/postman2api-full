import { sleep } from "./core/sleep";
import { Camoufox } from "camoufox-js";
import type { Browser, Page } from "playwright";

const headless = process.argv.includes("--headless");
const chineseFonts = [
  "Source Han Sans SC",
  "Hiragino Sans GB",
  "Heiti SC",
  "Arial Unicode MS",
];
const chineseFontFamily = chineseFonts.map((font) => `"${font}"`).join(", ") + ", sans-serif";

/**
 * 创建一个只在本机监听的演示网站。
 * 这样示例不依赖第三方网站，断网时也可以稳定演示输入、点击和多标签页操作。
 */
function startDemoServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/tab") {
        const title = url.searchParams.get("title") ?? "未命名标签页";
        return new Response(createTabHtml(title), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-language": "zh-CN",
          },
        });
      }

      return new Response(createHomeHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-language": "zh-CN",
        },
      });
    },
  });
}

/** 等待新标签页创建，并点击会触发 window.open 的按钮。 */
async function openNewTab(currentPage: Page, buttonName: string): Promise<Page> {
  const context = currentPage.context();
  const [newPage] = await Promise.all([
    context.waitForEvent("page"),
    currentPage.getByRole("button", { name: buttonName }).click(),
  ]);

  await newPage.waitForLoadState("domcontentloaded");
  return newPage;
}

/** 切换到指定标签页，并读取页面标题用于确认切换结果。 */
async function switchToTab(page: Page, label: string): Promise<void> {
  await page.bringToFront();
  const heading = await page.getByRole("heading", { level: 1 }).textContent();
  console.log(`[切换标签页] ${label}: ${heading}`);
}

const server = startDemoServer();
const demoUrl = `http://${server.hostname}:${server.port}`;
let browser: Browser | undefined;

try {
  console.log(`演示页面已启动：${demoUrl}`);
  console.log(`浏览器模式：${headless ? "无界面" : "有界面"}`);

  // Camoufox 返回标准的 Playwright Browser，因此后续操作都使用 Playwright API。
  // 固定为当前运行环境的 macOS 指纹，并显式开放中文字体，避免中文显示为乱码或方框。
  const launchedBrowser = await Camoufox({
    headless,
    os: "macos",
    locale: "zh-CN",
    fonts: chineseFonts,
  });
  browser = launchedBrowser;
  const context = await launchedBrowser.newContext();
  const mainPage = await context.newPage();

  // 1. 打开首页，并在输入框中填写内容。
  await mainPage.goto(demoUrl, { waitUntil: "domcontentloaded" });
  await mainPage.getByLabel("你的名字").fill("Camoufox 用户");
  console.log("[输入] 已在姓名输入框中填写：Camoufox 用户");

  // 2. 点击按钮，然后读取页面动态生成的结果。
  await mainPage.getByRole("button", { name: "生成问候语" }).click();
  const greeting = mainPage.locator("#greeting");
  await greeting.waitFor({ state: "visible" });
  console.log(`[点击] 页面结果：${await greeting.textContent()}`);

  // 3. 点击两个按钮，分别打开两个新的浏览器标签页。
  const firstTab = await openNewTab(mainPage, "打开第一个标签页");
  await mainPage.bringToFront();
  const secondTab = await openNewTab(mainPage, "打开第二个标签页");
  console.log(`[多标签页] 当前共有 ${context.pages().length} 个标签页`);

  // 4. 使用 bringToFront 在多个标签页之间来回切换。
  await switchToTab(firstTab, "第一个标签页");
  await sleep(5000)
  await switchToTab(secondTab, "第二个标签页");
  await sleep(5000)
  await switchToTab(mainPage, "返回主标签页");

  // 5. 回到首页后再次确认之前的输入与点击结果仍然存在。
  const inputValue = await mainPage.getByLabel("你的名字").inputValue();
  const finalGreeting = await greeting.textContent();
  if (inputValue !== "Camoufox 用户" || finalGreeting !== "你好，Camoufox 用户！") {
    throw new Error("主标签页状态校验失败");
  }

  console.log("[完成] 输入、点击、打开标签页、切换标签页和状态校验全部成功");
} finally {
  // 无论执行成功还是失败，都关闭浏览器和本地服务，避免残留进程。
  await browser?.close();
  server.stop(true);
}

function createHomeHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Camoufox 自动化演示</title>
    <style>
      body { max-width: 680px; margin: 48px auto; padding: 0 24px; font-family: ${chineseFontFamily}; line-height: 1.6; }
      label, input { display: block; }
      input { width: 100%; box-sizing: border-box; padding: 10px; margin: 6px 0 16px; }
      button { padding: 10px 14px; margin: 0 8px 8px 0; cursor: pointer; }
      #greeting { min-height: 24px; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Camoufox 浏览器自动化演示</h1>
    <label for="name">你的名字</label>
    <input id="name" type="text" placeholder="请输入名字" />
    <button id="greet" type="button">生成问候语</button>
    <p id="greeting"></p>
    <hr />
    <button id="open-first" type="button">打开第一个标签页</button>
    <button id="open-second" type="button">打开第二个标签页</button>
    <script>
      document.querySelector("#greet").addEventListener("click", () => {
        const name = document.querySelector("#name").value;
        document.querySelector("#greeting").textContent = \`你好，\${name}！\`;
      });
      document.querySelector("#open-first").addEventListener("click", () => {
        window.open("/tab?title=" + encodeURIComponent("第一个标签页"), "_blank");
      });
      document.querySelector("#open-second").addEventListener("click", () => {
        window.open("/tab?title=" + encodeURIComponent("第二个标签页"), "_blank");
      });
    </script>
  </body>
</html>`;
}

function createTabHtml(title: string): string {
  const safeTitle = Bun.escapeHTML(title);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${safeTitle}</title>
  </head>
  <body style="font-family: ${chineseFontFamily}; padding: 48px;">
    <h1>${safeTitle}</h1>
    <p>这是由主页面按钮打开的新标签页。</p>
  </body>
</html>`;
}

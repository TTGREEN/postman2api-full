import { Camoufox } from "camoufox-js";
import type { Browser, BrowserContext, Page } from "playwright";
import { CONFIG } from "../config";
import { log } from "./logger";

/** 启动 Camoufox（伪装浏览器），返回标准 Playwright Browser */
export async function launchBrowser(): Promise<Browser> {
  return Camoufox({
    headless: CONFIG.headless,
    os: CONFIG.browser.os,
    locale: CONFIG.browser.locale,
    fonts: CONFIG.browser.fonts,
    // 配置了代理时走代理出口（换 IP 解决限流）；geoip 由库原生支持：通过代理查询出口 IP 并同步 WebRTC/地理位置
    ...(CONFIG.proxy ? { proxy: CONFIG.proxy, ...(CONFIG.geoip ? { geoip: true } : {}) } : {}),
  });
}

/**
 * 标签页管理：对应流程描述中的 new_page / select_page / navigate_page。
 * 关键页面（临时邮箱、Postman 注册页）各自有专属标签页，互不共用；
 * 标签页句柄可能失效（页面被关闭），提供按 URL 重新查找的能力。
 */
export class TabManager {
  constructor(private readonly context: BrowserContext) {}

  /**
   * 打开一个专属的新标签页并导航（new_page），与已有标签页互不共用。
   * 注意：camoufox 基于 Firefox，`context.newPage()` 会新开一个浏览器窗口；
   * 因此从第二个标签页起改用 `window.open` 在同一个窗口内开新标签页。
   */
  async openDedicatedTab(label: string, url: string): Promise<Page> {
    const existing = this.context.pages().find((p) => !p.isClosed());

    // 已有页面时：用 window.open 在同一个窗口内开新标签页（camoufox/Firefox 下 newPage 会开新窗口）
    if (existing) {
      try {
        log.info(`[标签页] 在现有窗口内打开新标签页「${label}」`);
        const [newPage] = await Promise.all([
          this.context.waitForEvent("page"),
          existing.evaluate((u) => {
            window.open(u, "_blank");
          }, url),
        ]);
        await newPage.waitForLoadState("domcontentloaded").catch(() => {});
        log.info(`[标签页] 当前共 ${this.context.pages().length} 个标签页`);
        return newPage;
      } catch (err) {
        log.warn(`[标签页] window.open 开标签页失败（${err instanceof Error ? err.message : String(err)}），回退到 newPage`);
      }
    }

    // 第一个标签页或回退路径：直接新建
    log.info(`[标签页] 打开新标签页「${label}」`);
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
    log.info(`[标签页] 当前共 ${this.context.pages().length} 个标签页`);
    return page;
  }

  /** 切换到指定标签页（select_page） */
  async bringToFront(page: Page): Promise<void> {
    await page.bringToFront();
  }

  /** 重新导航当前标签页（navigate_page / reload） */
  async navigate(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.timeouts.pageLoad });
  }

  /** 按 URL 片段在现有标签页中查找（标签页丢失后的恢复手段） */
  findPage(urlFragment: string): Page | undefined {
    return this.context.pages().find((p) => p.url().includes(urlFragment));
  }

  get pages(): Page[] {
    return this.context.pages();
  }
}

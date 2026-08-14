import { describe, expect, test } from "bun:test";
import { launchLoginBrowser, parseLoginBrowserBackend } from "../src/auth/browser-launcher";

describe("login browser configuration", () => {
  test("defaults to Camoufox and accepts explicit backends", () => {
    expect(parseLoginBrowserBackend(undefined)).toBe("camoufox");
    expect(parseLoginBrowserBackend("")).toBe("camoufox");
    expect(parseLoginBrowserBackend(" PLAYWRIGHT ")).toBe("playwright");
    expect(parseLoginBrowserBackend("camoufox")).toBe("camoufox");
  });

  test("rejects unknown backends", () => {
    expect(() => parseLoginBrowserBackend("auto")).toThrow("expected");
  });
});

describe("login browser launcher without real browsers", () => {
  test("uses the injected Playwright launcher", async () => {
    const fakeBrowser = { close: async () => undefined } as any;
    let received: unknown;
    expect(await launchLoginBrowser("playwright", {
      headless: true,
      playwrightLauncher: async (options) => { received = options; return fakeBrowser; },
    })).toBe(fakeBrowser);
    expect(received).toEqual({ headless: true });
  });

  test("dynamically imports Camoufox and does not silently fall back", async () => {
    const fakeBrowser = { close: async () => undefined } as any;
    expect(await launchLoginBrowser("camoufox", {
      camoufoxImporter: async () => ({ Camoufox: async () => fakeBrowser }) as any,
    })).toBe(fakeBrowser);

    await expect(launchLoginBrowser("camoufox", {
      camoufoxImporter: async () => { throw new Error("native module unavailable"); },
    })).rejects.toThrow("Automatic fallback is disabled");
  });

  test("uses the injected Camoufox launcher", async () => {
    const fakeBrowser = { close: async () => undefined } as any;
    let received: unknown;

    expect(await launchLoginBrowser("camoufox", {
      headless: true,
      camoufoxLauncher: async (options) => {
        received = options;
        return fakeBrowser;
      },
    })).toBe(fakeBrowser);
    expect(received).toEqual({ headless: true });
  });
});

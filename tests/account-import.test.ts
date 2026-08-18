import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { accountsRouter, normalizeAccountImportPayload } from "../src/api/accounts";
import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";
import { fetchRegistrationJobs, importAccounts } from "../dashboard/src/lib/api";

const emails: string[] = [];

function account(email: string, suffix = "one") {
  return {
    email,
    enabled: true,
    tokens: {
      postman_sid: `sid-${suffix}`,
      user_id: `user-${suffix}`,
      workspace_id: `team-${suffix}`,
      workspace_subdomain: `workspace-${suffix}`,
    },
  };
}

afterEach(async () => {
  for (const email of emails.splice(0)) {
    await db.delete(accounts).where(eq(accounts.email, email));
  }
});

describe("account JSON import", () => {
  test("accepts a single object and a versioned batch envelope", () => {
    const single = account("single@example.com");
    expect(normalizeAccountImportPayload(single).records).toEqual([single]);
    expect(normalizeAccountImportPayload({ version: 1, accounts: [single] }).records).toEqual([single]);
    expect(normalizeAccountImportPayload({ version: 2, accounts: [single] }).error).toBe("Import JSON version must be 1");
    expect(normalizeAccountImportPayload({ version: 1, accounts: [] }).error).toBe("accounts must not be empty");
  });

  test("imports valid entries, reports invalid entries, and updates matching email", async () => {
    const app = new Hono().route("/api/accounts", accountsRouter);
    const email = `import-${crypto.randomUUID()}@example.com`;
    emails.push(email);

    const firstResponse = await app.request("/api/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        accounts: [
          account(email),
          { email: "broken@example.com", tokens: { postman_sid: "sid" } },
          account(email, "duplicate"),
        ],
      }),
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as any;
    expect(firstBody.summary).toEqual({ total: 3, created: 1, updated: 0, failed: 2 });
    expect(firstBody.results.map((result: any) => result.status)).toEqual(["created", "failed", "failed"]);
    expect(firstBody.results[1].error).toBe("tokens.user_id is required");
    expect(firstBody.results[2].error).toBe("Duplicate email in import JSON");

    const secondResponse = await app.request("/api/accounts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...account(email, "updated"), enabled: false }),
    });
    const secondBody = await secondResponse.json() as any;
    expect(secondBody.summary).toEqual({ total: 1, created: 0, updated: 1, failed: 0 });

    const [saved] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
    expect(saved?.enabled).toBe(false);
    expect(JSON.parse(saved?.tokens || "{}")).toEqual(account(email, "updated").tokens);
  });

  test("posts the original JSON document from the dashboard client", async () => {
    const originalFetch = globalThis.fetch;
    const payload = { version: 1, accounts: [account("client@example.com")] };
    let request: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), method: init?.method, body: String(init?.body) };
      return new Response(JSON.stringify({
        success: true,
        summary: { total: 1, created: 1, updated: 0, failed: 0 },
        results: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    try {
      await importAccounts(payload);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request).toEqual({
      url: "/api/accounts/import",
      method: "POST",
      body: JSON.stringify(payload),
    });
  });

  test("explains an HTML API response instead of leaking a JSON parser error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as typeof fetch;

    try {
      await expect(fetchRegistrationJobs()).rejects.toThrow(
        "接口 /api/registration 返回了非 JSON 响应（HTTP 200）",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

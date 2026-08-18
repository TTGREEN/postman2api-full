import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { statsRouter } from "../src/api/stats";
import { db } from "../src/db/index";
import { accounts, requestLogs } from "../src/db/schema";

describe("stats reset", () => {
  test("clears request statistics without deleting accounts", async () => {
    const email = `stats-reset-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
    const now = new Date(1_800_000_000_000);
    const [account] = await db.insert(accounts).values({
      email,
      password: "fixture",
      status: "active",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).returning();
    if (!account) throw new Error("fixture account was not created");

    await db.insert(requestLogs).values([
      {
        accountId: account.id,
        model: "fixture-model",
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        status: "success",
        durationMs: 12,
        createdAt: now,
      },
      {
        accountId: account.id,
        model: "fixture-model",
        promptTokens: 2,
        completionTokens: 4,
        totalTokens: 6,
        status: "error",
        durationMs: 15,
        errorMessage: "fixture",
        createdAt: now,
      },
    ]);

    try {
      const app = new Hono().route("/api/stats", statsRouter);
      const reset = await app.request("/api/stats/reset", { method: "POST" });
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ success: true, deletedRequestLogs: 2 });

      const list = await app.request("/api/stats");
      const body = await list.json() as { data: { totalRequests: number; totalTokens: number; recentRequests: unknown[]; totalAccounts: number } };
      expect(body.data.totalRequests).toBe(0);
      expect(body.data.totalTokens).toBe(0);
      expect(body.data.recentRequests).toEqual([]);

      const [stillThere] = await db.select().from(accounts).where(eq(accounts.id, account.id)).limit(1);
      expect(stillThere?.email).toBe(email);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.accountId, account.id));
      await db.delete(accounts).where(eq(accounts.id, account.id));
    }
  });
});

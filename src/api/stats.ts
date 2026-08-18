import { Hono } from "hono";
import { db } from "../db/index";
import { requestLogs, accounts } from "../db/schema";
import { sql } from "drizzle-orm";

export const statsRouter = new Hono();

statsRouter.get("/", async (c) => {
  const [totalResult] = await db.select({ count: sql<number>`count(*)` }).from(requestLogs);
  const [successResult] = await db.select({ count: sql<number>`count(*)` })
    .from(requestLogs).where(sql`status = 'success'`);
  const [errorResult] = await db.select({ count: sql<number>`count(*)` })
    .from(requestLogs).where(sql`status = 'error'`);
  const [tokenResult] = await db.select({
    prompt: sql<number>`COALESCE(SUM(prompt_tokens), 0)`,
    completion: sql<number>`COALESCE(SUM(completion_tokens), 0)`,
    total: sql<number>`COALESCE(SUM(total_tokens), 0)`,
  }).from(requestLogs);

  const [accountCount] = await db.select({ count: sql<number>`count(*)` }).from(accounts);
  const [activeCount] = await db.select({ count: sql<number>`count(*)` })
    .from(accounts).where(sql`status = 'active' AND enabled = 1`);

  // Recent requests (last 50)
  const recent = await db.select().from(requestLogs).orderBy(sql`created_at DESC`).limit(50);

  return c.json({
    data: {
      totalRequests: totalResult?.count || 0,
      successRequests: successResult?.count || 0,
      errorRequests: errorResult?.count || 0,
      totalPromptTokens: tokenResult?.prompt || 0,
      totalCompletionTokens: tokenResult?.completion || 0,
      totalTokens: tokenResult?.total || 0,
      totalAccounts: accountCount?.count || 0,
      activeAccounts: activeCount?.count || 0,
      recentRequests: recent,
    },
  });
});

statsRouter.post("/reset", async (c) => {
  const [before] = await db.select({ count: sql<number>`count(*)` }).from(requestLogs);
  await db.delete(requestLogs);

  return c.json({
    success: true,
    deletedRequestLogs: before?.count || 0,
  });
});

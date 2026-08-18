import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { encrypt } from "../utils/crypto";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export interface PersistedPostmanToken {
  email: string;
  password: string;
  tokens: {
    postman_sid: string;
    user_id: string;
    workspace_id: string;
    workspace_subdomain: string;
  };
}

export async function persistPostmanToken(value: PersistedPostmanToken): Promise<number> {
  const email = value.email.trim().toLowerCase();
  if (!email || !value.tokens.postman_sid || !value.tokens.workspace_subdomain) {
    throw new Error("账号 Token 字段不完整，未写入账号池");
  }
  const now = new Date();
  const password = encrypt(value.password || "automation-generated");
  const tokens = JSON.stringify(value.tokens);
  const [existing] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);
  if (existing) {
    const [updated] = await db.update(accounts).set({
      password,
      tokens,
      status: "active",
      enabled: true,
      lastLoginAt: now,
      updatedAt: now,
      errorMessage: null,
    }).where(eq(accounts.id, existing.id)).returning({ id: accounts.id });
    pool.invalidate(updated!.id);
    broadcast({ type: "account_updated", data: { id: updated!.id, email, status: "active" } });
    return updated!.id;
  }

  const [created] = await db.insert(accounts).values({
    email,
    password,
    tokens,
    status: "active",
    enabled: true,
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: accounts.id });
  broadcast({ type: "account_added", data: { id: created!.id, email, status: "active" } });
  return created!.id;
}

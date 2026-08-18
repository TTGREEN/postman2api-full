import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { CONFIG } from "../config";
import { log } from "./logger";

/**
 * postman2api 账号导入所需的四个字段（格式见仓库根 docs/postman-account-token.md）：
 *  - postman_sid：postman.co 域下 postman.sid Cookie 的值
 *  - user_id：handshake JWT 载荷中的 userId
 *  - workspace_id：handshake JWT 载荷中的 teamId
 *  - workspace_subdomain：<前缀>.postman.co 中的域名前缀
 */
export interface AccountToken {
  email: string;
  /** 注册时使用的密码（每次运行随机生成），方便后续登录；置于 email 下方 */
  password: string;
  tokens: {
    postman_sid: string;
    user_id: string;
    workspace_id: string;
    workspace_subdomain: string;
  };
}

/** 保留域名前缀，不能当作 workspace_subdomain（见文档说明） */
const RESERVED_SUBDOMAINS = new Set([
  "go",
  "www",
  "identity",
  "app",
  "api",
  "blog",
  "learning",
  "support",
  "docs",
  "community",
  "web",
  "staging",
  "dev",
  "getpostman",
  "login",
]);

/** 在 handshake JWT 载荷中递归查找子域名信息（键名含 subdomain，或值形如 <前缀>.postman.co） */
function findSubdomainInPayload(value: unknown, keyHint = ""): string | null {
  if (typeof value === "string") {
    const m = value.match(/^([a-z0-9-]+)\.postman\.co$/i);
    if (m && !RESERVED_SUBDOMAINS.has(m[1].toLowerCase())) return m[1];
    if (/subdomain/i.test(keyHint) && /^[a-z0-9-]+$/i.test(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = findSubdomainInPayload(item, keyHint);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const r = findSubdomainInPayload(v, k);
      if (r) return r;
    }
  }
  return null;
}

/** 从当前登录页面的 URL 提取团队子域名前缀（<前缀>.postman.co） */
function subdomainFromUrl(page: Page): string | null {
  try {
    const host = new URL(page.url()).hostname;
    const m = host.match(/^([a-z0-9-]+)\.postman\.co$/i);
    if (m && !RESERVED_SUBDOMAINS.has(m[1].toLowerCase())) return m[1];
  } catch {
    /* 忽略 URL 解析失败 */
  }
  return null;
}

/**
 * 从已登录的 Postman 页面收集账号 Token 四字段。
 * postman_sid 通过 context.cookies 读取（HttpOnly Cookie，document.cookie 读不到）；
 * user_id / workspace_id / workspace_subdomain 通过 handshake JWT 获取（与文档中的控制台脚本一致）。
 */
export async function collectAccountToken(page: Page, email: string, password: string): Promise<AccountToken> {
  log.info("正在收集账号 Token（postman_sid / user_id / workspace_id / workspace_subdomain）……");

  // 1. postman_sid：postman.co 域下的 postman.sid Cookie
  const cookies = await page.context().cookies([
    "https://postman.co",
    "https://go.postman.co",
    "https://identity.getpostman.com",
  ]);
  const sid = cookies.find((c) => c.name === "postman.sid");
  if (!sid?.value) throw new Error("未找到 postman.sid Cookie（可能未登录或会话已过期）");
  log.info(`postman_sid: 已获取（${sid.value.length} 字符）`);

  // 2. handshake JWT：解码载荷取 userId / teamId，并顺带找子域名信息
  const handshake = await page
    .evaluate(async () => {
      const res = await fetch("https://ra.gw.postman.co/v1/handshake/token?agent=cloud", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Handshake HTTP ${res.status}`);
      const data = await res.json() as { token?: string };
      if (!data.token) throw new Error("Handshake response did not include token");
      const part = data.token
        .split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = part.padEnd(Math.ceil(part.length / 4) * 4, "=");
      const json = decodeURIComponent(
        atob(padded)
          .split("")
          .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
          .join(""),
      );
      return JSON.parse(json);
    })
    .catch((err) => {
      log.warn(`handshake 获取失败: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

  const userId = handshake?.userId ?? null;
  const teamId = handshake?.teamId ?? null;
  const subdomain = (handshake ? findSubdomainInPayload(handshake) : null) ?? subdomainFromUrl(page);

  log.info(`user_id: ${userId ?? "未获取"}`);
  log.info(`workspace_id: ${teamId ?? "未获取"}`);
  log.info(`workspace_subdomain: ${subdomain ?? "未获取"}`);

  if (!userId || !teamId || !subdomain) {
    throw new Error(
      `Token 字段不完整（user_id=${userId ?? "空"}, workspace_id=${teamId ?? "空"}, workspace_subdomain=${subdomain ?? "空"}）`,
    );
  }

  return {
    email,
    password,
    tokens: {
      postman_sid: sid.value,
      user_id: String(userId),
      workspace_id: String(teamId),
      workspace_subdomain: subdomain,
    },
  };
}

/** 保存到固定目录，每次运行生成一个独立文件（时间戳命名），返回文件路径 */
export function saveAccountToken(token: AccountToken): string {
  const dir = path.resolve(CONFIG.tokensDir);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const name = `postman-token-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}.json`;
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(token, null, 2) + "\n", "utf-8");
  return file;
}

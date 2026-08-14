/**
 * 生成随机密码：12 位大小写字母 + 数字，保证至少 1 个字母和 1 个数字（满足 Postman 密码要求），
 * 并打乱顺序。每个账号独立生成一个，避免所有账号共用固定密码。
 */
function randomPassword(length = 12): string {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const all = letters + digits;
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** 固定密码（设置了 POSTMAN_PASSWORD 生效，否则每轮独立随机）；空字符串视为未设置 */
const FIXED_PASSWORD = process.env.POSTMAN_PASSWORD || undefined;

/** 默认创建随机密码；设置 POSTMAN_PASSWORD 后则一律使用固定密码 */
export function createRunPassword(): string {
  return FIXED_PASSWORD ?? randomPassword();
}

/** 批量注册轮数：优先 `--count N` 命令行参数，其次 POSTMAN_COUNT 环境变量，默认 1 */
function resolveRegisterCount(): number {
  const idx = process.argv.indexOf("--count");
  const argvValue = idx >= 0 ? Number(process.argv[idx + 1]) : NaN;
  const value = Number.isFinite(argvValue) ? argvValue : Number(process.env.POSTMAN_COUNT);
  if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  return 1;
}

/**
 * 规范化代理配置：修正常见笔误（缺 //、只写 host:port），无法解析时退回直连并告警。
 * 支持 http:// https:// socks5://，可带 user:pass@ 凭据。
 */
function normalizeProxy(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let fixed = value;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(fixed)) {
    // 缺 //（如 https:127.0.0.1:7897，只修已知 scheme）或缺 scheme（如 127.0.0.1:7897、user:pass@host:port）
    fixed = fixed.replace(/^(https?|socks[45]):(?!\/\/)/i, "$1://");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(fixed)) fixed = `http://${fixed}`;
    console.warn(`[config] POSTMAN_PROXY 格式不规范（${value}），已自动修正为 ${fixed.replace(/\/\/[^/@]*@/, "//***@")}`);
  }
  try {
    new URL(fixed);
  } catch {
    console.warn(`[config] POSTMAN_PROXY 无法解析（${value}），本轮将使用直连`);
    return undefined;
  }
  return fixed;
}

/**
 * 全局配置：URL、轮数、超时与浏览器选项。
 * 站点改版时优先改 selectors/ 目录，这里只放不变的业务配置。
 */
export const CONFIG = {
  urls: {
    /** 临时邮箱（标签页 A） */
    tempMail: "https://temp-mail.org/zh/",
    /** Postman 注册页（标签页 B） */
    postmanSignup: "https://identity.getpostman.com/signup",
    /** 工作区地址前缀，后续阶段直接导航用 */
    workspace: "https://go.postman.co",
  },
  /** 批量注册轮数：`--count N` 或 POSTMAN_COUNT，默认 1（保持单次注册行为） */
  count: resolveRegisterCount(),
  /** 账号 Token 保存目录（固定文件夹，可用 POSTMAN_TOKENS_DIR 覆盖）；每轮注册生成一个独立文件 */
  tokensDir: process.env.POSTMAN_TOKENS_DIR ?? "tokens",
  headless: process.argv.includes("--headless"),
  /** 可选代理（POSTMAN_PROXY，如 "http://user:pass@host:port"）：被按 IP 限流（如 temp-mail「创建了太多的邮箱」）时换出口 IP */
  proxy: normalizeProxy(process.env.POSTMAN_PROXY),
  /** 是否让 camoufox 通过代理查询出口 IP 并同步 WebRTC/地理位置（POSTMAN_GEOIP=1；库内原生支持，无需额外扩展） */
  geoip: process.env.POSTMAN_GEOIP === "1",
  timeouts: {
    /**
     * 两级超时设计：
     * - 10 分钟级（网络敏感）：long（跨阶段跳转）、pageLoad（页面加载）、cfWait（Cloudflare 验证）。
     *   网络不好时这些等待可能极慢，宁可多等也不要误中断（如「等待新手引导页面出现超时（30000ms）」）。
     * - 秒/分钟级（元素级）：short、medium、emailAcquireAttempt 用于页面内元素查找与交互，
     *   必须快速失败，否则元素缺失或页面结构变化时会白白挂很久（此前统一放宽到 10 分钟曾导致
     *   regenerateEmail 找不到删除按钮时挂死 10 分钟）。
     */
    /** 单次临时邮箱地址获取等待（1 分钟）；失败后会执行有限次数的刷新重试 */
    emailAcquireAttempt: 60000,
    /** 临时邮箱地址获取的总尝试次数（包含首次） */
    emailAcquireAttempts: 3,
    /** 临时邮箱地址获取重试前的基础退避时间 */
    emailAcquireBackoff: 1500,
    /** 邮箱页面初始生成等待（本地渲染，非网络等待） */
    emailGenerate: 3000,
    /** 删除邮箱后重新生成等待（本地渲染，非网络等待） */
    deleteRegenerate: 4000,
    /** 短等待（元素轮询基准）：快速失败，避免元素缺失时长时间挂起 */
    short: 5000,
    /** 中等等待（页面内容出现）：1 分钟 */
    medium: 60000,
    /** 长等待（跨阶段跳转）：10 分钟 */
    long: 600000,
    /** Cloudflare 验证循环等待总超时（默认 10 分钟，可用 POSTMAN_CF_TIMEOUT 覆盖） */
    cfWait: Number(process.env.POSTMAN_CF_TIMEOUT) || 600000,
    /** 页面加载：10 分钟 */
    pageLoad: 600000,
  },
  browser: {
    os: "macos" as const,
    locale: "zh-CN",
    fonts: ["Source Han Sans SC", "Hiragino Sans GB", "Heiti SC", "Arial Unicode MS"],
  },
};

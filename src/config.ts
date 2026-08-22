import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLoginBrowserBackend } from "./auth/browser-launcher";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveFromRoot(value: string | undefined, fallback: string): string {
  const raw = value && value.length > 0 ? value : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const streamReadTimeoutMs = positiveNumber(process.env.STREAM_READ_TIMEOUT_MS, 300_000);
const providerRequestTimeoutMs = positiveNumber(process.env.PROVIDER_REQUEST_TIMEOUT_MS, 120_000);
const quotaSafeStreamBufferBytes = positiveNumber(
  process.env.QUOTA_SAFE_STREAM_BUFFER_BYTES,
  16 * 1024 * 1024,
);
const streamKeepaliveIntervalMs = positiveNumber(process.env.STREAM_KEEPALIVE_INTERVAL_MS, 10_000);
const postmanFetchVerbose = /^(1|true|yes)$/i.test(process.env.POSTMAN_FETCH_VERBOSE || "");
// Postman caps a single request at ~10k chars per field, so a long history has to
// be streamed into the conversation across several priming turns instead of being
// silently truncated. Each turn is a real upstream generation.
const postmanContextPriming = !/^(0|false|no|off)$/i.test(process.env.POSTMAN_CONTEXT_PRIMING || "");
const postmanContextPrimingMaxSegments = positiveNumber(
  process.env.POSTMAN_CONTEXT_PRIMING_MAX_SEGMENTS,
  40,
);

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "postman2api-secret-key",
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, "data/postman2api.db"),
  encryptionKey: process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  streamReadTimeoutMs,
  providerRequestTimeoutMs,
  quotaSafeStreamBufferBytes,
  streamKeepaliveIntervalMs,
  postmanFetchVerbose,
  postmanContextPriming,
  postmanContextPrimingMaxSegments,
  loginBrowserBackend: parseLoginBrowserBackend(process.env.LOGIN_BROWSER_BACKEND),
  // Bun.serve expects seconds and supports at most 255. Prefer the longer
  // provider/stream timeout, capped to Bun's supported range.
  serverIdleTimeoutSeconds: Math.min(
    255,
    Math.max(1, Math.ceil(Math.max(streamReadTimeoutMs, providerRequestTimeoutMs) / 1000)),
  ),
  ttfbTimeoutMs: Number(process.env.TTFB_TIMEOUT_MS) || 45_000,
} as const;

export type Config = typeof config;

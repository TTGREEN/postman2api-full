import type { ChatCompletionRequest, ProviderResult } from "../provider/base";
import { PostmanProvider } from "../provider/postman";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import { scheduleProvisioningWarmup } from "../auth/warmup";

const provider = new PostmanProvider();

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  durationMs: number;
  leaseId: string;
}

function isClientDisconnect(error: string): boolean {
  return error.includes("Client disconnected") || error.includes("aborted");
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("timeout")
    || lower.includes("econnreset")
    || lower.includes("fetch failed")
    || lower.includes("network")
    || lower.includes("server error (5");
}

function isAuthenticationError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("invalid or missing postman tokens")
    || lower.includes("account disabled")
    || lower.includes("session expired")
    || lower.includes("expired")
    || lower.includes("401")
    || lower.includes("403");
}

export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean,
): Promise<RouteResult> {
  if (!provider.ownsModel(request.model)) {
    throw new Error(`Invalid model: ${request.model}`);
  }

  let lastError = "";
  const excludedAccountIds = new Set<number>();

  while (true) {
    const lease = await pool.acquireNextAccount(request._sessionId, excludedAccountIds);
    if (!lease) {
      if (excludedAccountIds.size > 0) break;
      throw new Error("No active accounts available. Add a Postman account first.");
    }
    const { account, leaseId } = lease;

    const startTime = Date.now();
    let tracked = true;

    try {
      const result = stream
        ? await provider.chatCompletionStream(account, request)
        : await provider.chatCompletion(account, request);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // A completed non-streaming provider call no longer contributes load.
        // Release it before any database bookkeeping, which can be slower.
        if (!result.stream) {
          pool.trackRequestEnd(account.id, leaseId);
          tracked = false;
        } else {
          await result.setStreamFailureHandler?.(async (failure) => {
            if (failure.kind === "quota_exhausted") {
              pool.releaseSession(request._sessionId, account.id);
              await pool.markExhausted(account.id);
            }
          });
        }
        if (result.tokens) await pool.updateTokens(account.id, result.tokens);
        await pool.markUsed(account.id);
        // Streaming requests stay in-flight until their body completes or is cancelled.
        return { result, account, durationMs, leaseId };
      }

      pool.trackRequestEnd(account.id, leaseId);
      tracked = false;

      if (isClientDisconnect(result.error || "")) {
        throw new Error("Client disconnected");
      }

      // A tool/schema rejection is deterministic for this request payload. Do
      // not treat it as an account failure or retry it on another account.
      if (result.requestRejected) {
        return { result, account, durationMs, leaseId };
      }

      if (result.rateLimited) {
        pool.releaseSession(request._sessionId, account.id);
        excludedAccountIds.add(account.id);
        lastError = result.error || "Rate limited";
        pool.markCooling(account.id, result.retryAfterMs || 30_000, lastError);
        continue;
      }

      if (result.quotaExhausted) {
        pool.releaseSession(request._sessionId, account.id);
        await pool.markExhausted(account.id);
        excludedAccountIds.add(account.id);
        lastError = result.error || "Quota exhausted";
        continue;
      }

      if (result.retryable) {
        pool.releaseSession(request._sessionId, account.id);
        excludedAccountIds.add(account.id);
        await pool.markTransientFailure(account.id, result.error || "Postman AI is not ready yet");
        pool.markCooling(account.id, 15_000, result.error || "Postman AI is not ready yet");
        scheduleProvisioningWarmup(account.id);
        lastError = result.error || "Postman AI is not ready yet";
        continue;
      }

      if (result.error?.includes("402")) {
        pool.releaseSession(request._sessionId, account.id);
        await pool.markExhausted(account.id);
        excludedAccountIds.add(account.id);
        lastError = result.error || "Payment required";
        continue;
      }

      if (isAuthenticationError(result.error || "")) {
        pool.releaseSession(request._sessionId, account.id);
        excludedAccountIds.add(account.id);
        await pool.markError(account.id, result.error || "Authentication failed");
        lastError = result.error || "Authentication failed";
        continue;
      }

      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
        // The upstream chat endpoint is a state-changing POST. A reset/timeout can
        // happen after Postman accepted it, so replaying it could duplicate a turn.
        // Only explicit rejection responses handled above (429/auth/quota) retry.
        return { result, account, durationMs, leaseId };
      }

      await pool.markError(account.id, result.error || "Unknown error");
      return { result, account, durationMs, leaseId };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id, leaseId);
        tracked = false;
      }
      if (isClientDisconnect(errMsg)) throw error;
      lastError = errMsg;
      // Unknown exceptions may happen after the state-changing POST was accepted.
      // Do not replay the same turn on another account without an explicit safe signal.
      break;
    }
  }

  throw new Error(`All accounts failed. Last error: ${lastError}`);
}

export { provider };

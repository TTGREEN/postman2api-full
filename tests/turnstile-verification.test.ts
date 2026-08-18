import { describe, expect, test } from "bun:test";
import {
  InMemoryVerificationGrantStore,
  verifyTurnstile,
  type VerificationBinding,
} from "../src/security/turnstile";

const binding: VerificationBinding = {
  sessionId: "session-42",
  action: "signup",
  payloadHash: "payload-sha256",
};

function providerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Turnstile server verification", () => {
  test("accepts a provider success only when hostname and action match", async () => {
    const result = await verifyTurnstile({
      token: "token-123",
      secret: "test-secret",
      expectedHostname: "app.example.test",
      expectedAction: "signup",
      fetchImpl: async () => providerResponse({
        success: true,
        hostname: "app.example.test",
        action: "signup",
      }),
    });

    expect(result).toEqual({ ok: true });
  });

  test("fails closed when the provider result is missing, rejected, or mismatched", async () => {
    const missing = await verifyTurnstile({ token: "", secret: "test-secret" });
    expect(missing).toEqual({ ok: false, code: "missing_token" });

    const rejected = await verifyTurnstile({
      token: "token-123",
      secret: "test-secret",
      fetchImpl: async () => providerResponse({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    expect(rejected).toEqual({ ok: false, code: "provider_rejected" });

    const mismatched = await verifyTurnstile({
      token: "token-123",
      secret: "test-secret",
      expectedHostname: "app.example.test",
      expectedAction: "signup",
      fetchImpl: async () => providerResponse({ success: true, hostname: "other.example.test", action: "login" }),
    });
    expect(mismatched).toEqual({ ok: false, code: "hostname_mismatch" });
  });

  test("fails closed when the provider is unavailable", async () => {
    const result = await verifyTurnstile({
      token: "token-123",
      secret: "test-secret",
      fetchImpl: async () => { throw new Error("network unavailable"); },
    });

    expect(result).toEqual({ ok: false, code: "provider_unavailable" });
  });
});

describe("one-time verification grants", () => {
  test("binds the grant to the request and consumes it exactly once", () => {
    let now = 1_000;
    const grants = new InMemoryVerificationGrantStore({ now: () => now, id: () => "grant-1" });
    const grant = grants.issue(binding, 60_000);

    expect(grants.consume(grant.id, { ...binding, action: "login" })).toEqual({ ok: false, code: "binding_mismatch" });
    expect(grants.consume(grant.id, binding)).toEqual({ ok: true });
    expect(grants.consume(grant.id, binding)).toEqual({ ok: false, code: "already_consumed" });

    const expiringGrant = grants.issue({ ...binding, sessionId: "session-43" }, 500);
    now += 501;
    expect(grants.consume(expiringGrant.id, { ...binding, sessionId: "session-43" })).toEqual({ ok: false, code: "expired" });
  });
});

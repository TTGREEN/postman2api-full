import { describe, expect, test } from "bun:test";
import { HumanVerificationFlow } from "../src/security/human-verification-flow";
import { InMemoryVerificationGrantStore, type TurnstileVerificationResult, type VerificationBinding } from "../src/security/turnstile";

const binding: VerificationBinding = {
  sessionId: "browser-session",
  action: "signup",
  payloadHash: "request-body-sha256",
};

describe("human-verification interaction flow", () => {
  test("does not issue a business grant from a browser click alone", async () => {
    const flow = new HumanVerificationFlow({
      grants: new InMemoryVerificationGrantStore({ id: () => "grant-1" }),
      verify: async (): Promise<TurnstileVerificationResult> => ({ ok: true }),
    });

    expect(flow.snapshot().stage).toBe("awaiting_interaction");
    flow.recordInteraction();
    expect(flow.snapshot()).toEqual({ stage: "interaction_recorded", grantId: undefined });
    expect(flow.consumeSubmission("grant-1", binding)).toEqual({ ok: false, code: "not_verified" });
  });

  test("issues a bound one-time grant only after server verification", async () => {
    const flow = new HumanVerificationFlow({
      grants: new InMemoryVerificationGrantStore({ id: () => "grant-2" }),
      verify: async (): Promise<TurnstileVerificationResult> => ({ ok: true }),
    });

    flow.recordInteraction();
    await flow.verify("provider-token", binding);
    expect(flow.snapshot()).toEqual({ stage: "verified", grantId: "grant-2" });
    expect(flow.consumeSubmission("grant-2", binding)).toEqual({ ok: true });
    expect(flow.consumeSubmission("grant-2", binding)).toEqual({ ok: false, code: "already_consumed" });
  });

  test("records rejection without creating a usable grant", async () => {
    const flow = new HumanVerificationFlow({
      grants: new InMemoryVerificationGrantStore({ id: () => "grant-3" }),
      verify: async (): Promise<TurnstileVerificationResult> => ({ ok: false, code: "provider_rejected" }),
    });

    flow.recordInteraction();
    await flow.verify("bad-token", binding);
    expect(flow.snapshot()).toEqual({ stage: "rejected", grantId: undefined });
    expect(flow.consumeSubmission("grant-3", binding)).toEqual({ ok: false, code: "not_verified" });
  });
});

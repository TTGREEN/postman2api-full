import {
  InMemoryVerificationGrantStore,
  type TurnstileVerificationResult,
  type VerificationBinding,
  type VerificationGrantConsumeResult,
} from "./turnstile";

export type HumanVerificationStage =
  | "awaiting_interaction"
  | "interaction_recorded"
  | "verified"
  | "rejected"
  | "submitted";

export interface HumanVerificationSnapshot {
  stage: HumanVerificationStage;
  grantId?: string;
}

export interface HumanVerificationFlowOptions {
  grants: InMemoryVerificationGrantStore;
  verify: (token: string, binding: VerificationBinding) => Promise<TurnstileVerificationResult>;
  grantTtlMs?: number;
}

export type HumanVerificationSubmitResult = VerificationGrantConsumeResult | { ok: false; code: "not_verified" };

/**
 * Own-site interaction state machine: browser interaction is only evidence that a
 * challenge was attempted. A usable grant appears only after server verification.
 */
export class HumanVerificationFlow {
  private stage: HumanVerificationStage = "awaiting_interaction";
  private grantId: string | undefined;

  constructor(private readonly options: HumanVerificationFlowOptions) {}

  recordInteraction(): HumanVerificationSnapshot {
    if (this.stage === "awaiting_interaction") this.stage = "interaction_recorded";
    return this.snapshot();
  }

  async verify(token: string, binding: VerificationBinding): Promise<HumanVerificationSnapshot> {
    if (this.stage !== "interaction_recorded") return this.snapshot();

    const result = await this.options.verify(token, binding);
    if (!result.ok) {
      this.stage = "rejected";
      return this.snapshot();
    }

    const grant = this.options.grants.issue(binding, this.options.grantTtlMs);
    this.grantId = grant.id;
    this.stage = "verified";
    return this.snapshot();
  }

  consumeSubmission(grantId: string, binding: VerificationBinding): HumanVerificationSubmitResult {
    if (!this.grantId || grantId !== this.grantId || (this.stage !== "verified" && this.stage !== "submitted")) {
      return { ok: false, code: "not_verified" };
    }

    const result = this.options.grants.consume(grantId, binding);
    if (result.ok) this.stage = "submitted";
    return result;
  }

  snapshot(): HumanVerificationSnapshot {
    return this.grantId ? { stage: this.stage, grantId: this.grantId } : { stage: this.stage, grantId: undefined };
  }
}

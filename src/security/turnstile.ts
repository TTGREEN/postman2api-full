export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerificationCode =
  | "missing_token"
  | "missing_secret"
  | "provider_unavailable"
  | "provider_rejected"
  | "hostname_mismatch"
  | "action_mismatch";

export type TurnstileVerificationResult =
  | { ok: true }
  | { ok: false; code: TurnstileVerificationCode };

export interface VerifyTurnstileInput {
  token: string;
  secret: string;
  expectedHostname?: string;
  expectedAction?: string;
  remoteIp?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

interface TurnstileProviderResult {
  success?: boolean;
  hostname?: string;
  action?: string;
}

/**
 * Validates a Turnstile token at the provider boundary.
 * Client-side widget state is intentionally never accepted as proof.
 */
export async function verifyTurnstile(input: VerifyTurnstileInput): Promise<TurnstileVerificationResult> {
  const token = input.token.trim();
  if (!token) return { ok: false, code: "missing_token" };

  const secret = input.secret.trim();
  if (!secret) return { ok: false, code: "missing_secret" };

  const body = new URLSearchParams({ secret, response: token });
  if (input.remoteIp?.trim()) body.set("remoteip", input.remoteIp.trim());

  let payload: TurnstileProviderResult;
  try {
    const response = await (input.fetchImpl ?? fetch)(input.endpoint ?? TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
    });
    if (!response.ok) return { ok: false, code: "provider_unavailable" };
    payload = await response.json() as TurnstileProviderResult;
  } catch {
    return { ok: false, code: "provider_unavailable" };
  }

  if (payload.success !== true) return { ok: false, code: "provider_rejected" };
  if (input.expectedHostname && payload.hostname !== input.expectedHostname) {
    return { ok: false, code: "hostname_mismatch" };
  }
  if (input.expectedAction && payload.action !== input.expectedAction) {
    return { ok: false, code: "action_mismatch" };
  }
  return { ok: true };
}

export interface VerificationBinding {
  sessionId: string;
  action: string;
  payloadHash: string;
}

export interface VerificationGrant {
  id: string;
  expiresAt: number;
}

export type VerificationGrantConsumeResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "expired" | "already_consumed" | "binding_mismatch" };

interface StoredVerificationGrant extends VerificationGrant {
  binding: VerificationBinding;
  consumed: boolean;
}

export interface InMemoryVerificationGrantStoreOptions {
  now?: () => number;
  id?: () => string;
}

/**
 * A short-lived, single-use server-side authorization after provider validation.
 * Persist an equivalent record in the application's transaction store for multi-node deployments.
 */
export class InMemoryVerificationGrantStore {
  private readonly grants = new Map<string, StoredVerificationGrant>();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(options: InMemoryVerificationGrantStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.id = options.id ?? (() => crypto.randomUUID());
  }

  issue(binding: VerificationBinding, ttlMs = 60_000): VerificationGrant {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error("Verification grant TTL must be a positive integer");
    const grant: StoredVerificationGrant = {
      id: this.id(),
      expiresAt: this.now() + ttlMs,
      binding: { ...binding },
      consumed: false,
    };
    this.grants.set(grant.id, grant);
    return { id: grant.id, expiresAt: grant.expiresAt };
  }

  consume(id: string, binding: VerificationBinding): VerificationGrantConsumeResult {
    const grant = this.grants.get(id);
    if (!grant) return { ok: false, code: "not_found" };
    if (grant.consumed) return { ok: false, code: "already_consumed" };
    if (grant.expiresAt < this.now()) return { ok: false, code: "expired" };
    if (!sameBinding(grant.binding, binding)) return { ok: false, code: "binding_mismatch" };

    grant.consumed = true;
    return { ok: true };
  }
}

function sameBinding(left: VerificationBinding, right: VerificationBinding): boolean {
  return left.sessionId === right.sessionId
    && left.action === right.action
    && left.payloadHash === right.payloadHash;
}

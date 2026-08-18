import type { Page, Request, Response } from "playwright";

export type TurnstileDiagnosticOutcome =
  | "success"
  | "page_state_validated"
  | "component_not_appeared"
  | "timeout"
  | "upstream_rejected"
  | "widget_failed"
  | "otp_rejected"
  | "error";

export interface TurnstileDiagnosticEvent {
  atMs: number;
  attempt?: number;
  count?: number;
  event: string;
  durationMs?: number;
  height?: number;
  method?: string;
  signal?: string;
  status?: number;
  tokenLength?: number;
  url?: string;
  width?: number;
}

export interface TurnstileDiagnosticSummary {
  events: TurnstileDiagnosticEvent[];
  flow: string;
  outcome: TurnstileDiagnosticOutcome | null;
}

export interface TurnstileDiagnosticsOptions {
  emit?: (message: string) => void;
  flow: string;
  now?: () => number;
}

const MAX_NETWORK_EVENTS = 16;

/** 诊断中只保留 origin + pathname，永不写入 query、fragment、header、body 或 token。 */
export function redactDiagnosticUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname
      .split("/")
      .map((segment) => {
        if (!segment) return segment;
        // Cloudflare challenge paths contain opaque, single-use values. Keep
        // stable route names for diagnosis but never persist those segments.
        if (segment.length >= 24 || /[:=]/.test(segment) || /^[A-Za-z0-9_-]{20,}$/.test(segment)) return "<opaque>";
        return segment;
      })
      .join("/");
    return `${url.origin}${pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

export function isCloudflareChallengeUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === "challenges.cloudflare.com";
  } catch {
    return false;
  }
}

function rounded(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * 单次 Turnstile 等待的脱敏时序记录器。
 * 只观察组件和挑战域名的网络事件；不会修改页面、请求、响应或点击策略。
 */
export class TurnstileDiagnostics {
  private attachedPage: Page | null = null;
  private readonly clock: () => number;
  private readonly emit: (message: string) => void;
  private readonly events: TurnstileDiagnosticEvent[] = [];
  private clickAttemptCount = 0;
  private firstClickThrottleRecorded = false;
  private firstMarkerRecorded = false;
  private firstTokenRecorded = false;
  private firstVisibleWidgetRecorded = false;
  private firstWidgetMissingRecorded = false;
  private networkEventCount = 0;
  private networkTruncationRecorded = false;
  private outcome: TurnstileDiagnosticOutcome | null = null;
  private readonly requestStartedAt = new WeakMap<Request, number>();
  private readonly startedAt: number;

  constructor(private readonly options: TurnstileDiagnosticsOptions) {
    this.clock = options.now ?? Date.now;
    this.emit = options.emit ?? console.warn;
    this.startedAt = this.clock();
  }

  start(page: Page): void {
    if (this.attachedPage) return;
    this.attachedPage = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
    this.record({ event: "wait_started" });
  }

  observeMarker(): void {
    if (this.firstMarkerRecorded) return;
    this.firstMarkerRecorded = true;
    this.record({ event: "marker_detected" });
  }

  observeVisibleWidget(frameUrl: string, box: { width: number; height: number } | null): void {
    if (this.firstVisibleWidgetRecorded) return;
    this.firstVisibleWidgetRecorded = true;
    this.record({
      event: "widget_visible",
      ...(box ? { height: rounded(box.height), width: rounded(box.width) } : {}),
      url: redactDiagnosticUrl(frameUrl),
    });
  }

  observeClickAttempt(method = "locator"): void {
    this.clickAttemptCount += 1;
    this.record({ attempt: this.clickAttemptCount, event: "click_attempted", method });
  }

  observeClickThrottled(): void {
    if (this.firstClickThrottleRecorded) return;
    this.firstClickThrottleRecorded = true;
    this.record({ event: "click_throttled" });
  }

  observeWidgetMissing(): void {
    if (this.firstWidgetMissingRecorded) return;
    this.firstWidgetMissingRecorded = true;
    this.record({ event: "widget_not_visible" });
  }

  observeClickCompleted(): void {
    this.record({ event: "click_completed" });
  }

  observeClickFailed(): void {
    this.record({ event: "click_failed" });
  }

  observeToken(tokenLength: number): void {
    if (this.firstTokenRecorded) return;
    this.firstTokenRecorded = true;
    this.record({ event: "token_generated", tokenLength: rounded(tokenLength) });
  }

  observeSuccess(signal: string): void {
    this.record({ event: "success_signal", signal });
  }

  finish(outcome: TurnstileDiagnosticOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    if (this.attachedPage) {
      this.attachedPage.off("request", this.onRequest);
      this.attachedPage.off("response", this.onResponse);
      this.attachedPage.off("requestfailed", this.onRequestFailed);
      this.attachedPage = null;
    }
    this.record({ event: "wait_finished" });
    this.emit(`[Turnstile诊断] ${JSON.stringify(this.snapshot())}`);
  }

  snapshot(): TurnstileDiagnosticSummary {
    return {
      events: this.events.map((event) => ({ ...event })),
      flow: this.options.flow,
      outcome: this.outcome,
    };
  }

  private atMs(): number {
    return Math.max(0, this.clock() - this.startedAt);
  }

  private record(event: Omit<TurnstileDiagnosticEvent, "atMs">): void {
    const recorded = { atMs: this.atMs(), ...event };
    this.events.push(recorded);
    try {
      this.emit(`[Turnstile诊断事件] ${JSON.stringify({ flow: this.options.flow, ...recorded })}`);
    } catch {
      // Diagnostics must never interrupt the browser flow when log sinks fail.
    }
  }

  private recordNetwork(event: Omit<TurnstileDiagnosticEvent, "atMs">): void {
    if (this.networkEventCount >= MAX_NETWORK_EVENTS) {
      if (!this.networkTruncationRecorded) {
        this.networkTruncationRecorded = true;
        this.record({ event: "network_events_truncated" });
      }
      return;
    }
    this.networkEventCount += 1;
    this.record(event);
  }

  private readonly onRequest = (request: Request): void => {
    if (!isCloudflareChallengeUrl(request.url())) return;
    const atMs = this.atMs();
    this.requestStartedAt.set(request, atMs);
    this.recordNetwork({ event: "network_request", method: request.method(), url: redactDiagnosticUrl(request.url()) });
  };

  private readonly onResponse = (response: Response): void => {
    const request = response.request();
    if (!isCloudflareChallengeUrl(request.url())) return;
    const atMs = this.atMs();
    const startedAt = this.requestStartedAt.get(request);
    this.recordNetwork({
      durationMs: startedAt === undefined ? undefined : Math.max(0, atMs - startedAt),
      event: "network_response",
      method: request.method(),
      status: response.status(),
      url: redactDiagnosticUrl(request.url()),
    });
  };

  private readonly onRequestFailed = (request: Request): void => {
    if (!isCloudflareChallengeUrl(request.url())) return;
    const atMs = this.atMs();
    const startedAt = this.requestStartedAt.get(request);
    this.recordNetwork({
      durationMs: startedAt === undefined ? undefined : Math.max(0, atMs - startedAt),
      event: "network_failed",
      method: request.method(),
      url: redactDiagnosticUrl(request.url()),
    });
  };
}

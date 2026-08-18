import { describe, expect, test } from "bun:test";
import type { RegistrationJobSnapshot, RegistrationJobStatus } from "../dashboard/src/lib/api";
import {
  buildRegistrationJobView,
  mergeRegistrationJobSnapshot,
  mergeRegistrationJobSnapshots,
} from "../dashboard/src/lib/registration-jobs";

function job(
  id: string,
  status: RegistrationJobStatus,
  updatedAt: number,
): RegistrationJobSnapshot {
  return {
    id,
    kind: "registration",
    target: `target-${id}`,
    mode: "upstream",
    status,
    requested: 1,
    completed: status === "success" ? 1 : 0,
    retryLimit: 1,
    attempts: [],
    events: [{ jobId: id, type: "stage", stage: "signup", message: `event-${id}`, level: "info", ts: updatedAt }],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("registration job dashboard view", () => {
  test("separates active jobs and retains only the five newest terminal jobs", () => {
    const jobs = [
      job("running", "running", 80),
      job("queued", "queued", 79),
      job("history-1", "success", 78),
      job("history-2", "failed", 77),
      job("history-3", "stopped", 76),
      job("history-4", "success", 75),
      job("history-5", "failed", 74),
      job("history-6", "success", 73),
    ];

    const view = buildRegistrationJobView(jobs);

    expect(view.active.map((item) => item.id)).toEqual(["running", "queued"]);
    expect(view.history.map((item) => item.id)).toEqual(["history-1", "history-2", "history-3", "history-4", "history-5"]);
  });

  test("keeps active jobs while a realtime terminal-job update replaces the oldest history entry", () => {
    const current = [
      job("running", "running", 80),
      job("history-1", "success", 78),
      job("history-2", "failed", 77),
      job("history-3", "stopped", 76),
      job("history-4", "success", 75),
      job("history-5", "failed", 74),
    ];

    const merged = mergeRegistrationJobSnapshot(current, job("history-new", "success", 81));

    expect(merged.map((item) => item.id)).toEqual([
      "running",
      "history-new",
      "history-1",
      "history-2",
      "history-3",
      "history-4",
    ]);
  });

  test("does not let an older REST snapshot replace a newer realtime log", () => {
    const current = job("running", "running", 200);
    current.events.push({
      jobId: current.id,
      type: "log",
      stage: "verify",
      message: "new realtime event",
      level: "info",
      ts: 200,
    });
    const staleRestSnapshot = job("running", "running", 100);

    const merged = mergeRegistrationJobSnapshot([current], staleRestSnapshot);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.updatedAt).toBe(200);
    expect(merged[0]?.events.at(-1)?.message).toBe("new realtime event");
  });

  test("keeps the five newest jobs when REST returns rows in descending order", () => {
    const incoming = Array.from({ length: 7 }, (_, index) =>
      job(`history-${index + 1}`, "success", 700 - index),
    );

    const merged = mergeRegistrationJobSnapshots([], incoming);

    expect(merged.map((item) => item.id)).toEqual([
      "history-1",
      "history-2",
      "history-3",
      "history-4",
      "history-5",
    ]);
  });

  test("does not let a stale REST list evict a newer terminal WebSocket job", () => {
    const current = [job("live-terminal", "success", 900)];
    const staleRest = Array.from({ length: 7 }, (_, index) =>
      job(`old-${index + 1}`, "success", 800 - index),
    );

    const merged = mergeRegistrationJobSnapshots(current, staleRest);

    expect(merged.map((item) => item.id)).toEqual([
      "live-terminal",
      "old-1",
      "old-2",
      "old-3",
      "old-4",
    ]);
  });
});

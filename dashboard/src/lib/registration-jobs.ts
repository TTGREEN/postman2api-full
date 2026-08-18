import type { RegistrationJobSnapshot } from "./api";

export const REGISTRATION_HISTORY_LIMIT = 5;

function isActive(job: RegistrationJobSnapshot): boolean {
  return job.status === "queued" || job.status === "running";
}

function isRealUpstreamJob(job: RegistrationJobSnapshot): boolean {
  return job.mode === "upstream";
}

function statusFreshness(status: RegistrationJobSnapshot["status"]): number {
  return status === "queued" ? 0 : status === "running" ? 1 : 2;
}

/** Keep every view deterministic even when several updates share a timestamp. */
function compareJobs(next: RegistrationJobSnapshot, current: RegistrationJobSnapshot): number {
  if (next.updatedAt !== current.updatedAt) return current.updatedAt - next.updatedAt;
  if (next.createdAt !== current.createdAt) return current.createdAt - next.createdAt;
  if ((next.finishedAt ?? 0) !== (current.finishedAt ?? 0)) return (current.finishedAt ?? 0) - (next.finishedAt ?? 0);
  if (next.events.length !== current.events.length) return current.events.length - next.events.length;
  return next.id.localeCompare(current.id);
}

/**
 * REST snapshots can be older than a WebSocket event that arrived moments
 * earlier.  Treat the snapshot as a replacement only when it carries newer
 * persisted state, otherwise the already-rendered live log wins.
 */
function isNewerSnapshot(next: RegistrationJobSnapshot, current: RegistrationJobSnapshot): boolean {
  if (next.updatedAt !== current.updatedAt) return next.updatedAt > current.updatedAt;
  if (next.events.length !== current.events.length) return next.events.length > current.events.length;
  if (next.completed !== current.completed) return next.completed > current.completed;
  if (statusFreshness(next.status) !== statusFreshness(current.status)) {
    return statusFreshness(next.status) > statusFreshness(current.status);
  }
  if ((next.finishedAt ?? 0) !== (current.finishedAt ?? 0)) return (next.finishedAt ?? 0) > (current.finishedAt ?? 0);
  return false;
}

export interface RegistrationJobView {
  active: RegistrationJobSnapshot[];
  history: RegistrationJobSnapshot[];
}

/** Keep active work visible while retaining only the newest terminal-job history. */
export function buildRegistrationJobView(jobs: RegistrationJobSnapshot[]): RegistrationJobView {
  const ordered = jobs.filter(isRealUpstreamJob).sort(compareJobs);
  return {
    active: ordered.filter(isActive),
    history: ordered.filter((job) => !isActive(job)).slice(0, REGISTRATION_HISTORY_LIMIT),
  };
}

export function compactRegistrationJobs(jobs: RegistrationJobSnapshot[]): RegistrationJobSnapshot[] {
  const view = buildRegistrationJobView(jobs);
  return [...view.active, ...view.history];
}

export function mergeRegistrationJobSnapshot(
  current: RegistrationJobSnapshot[],
  next: RegistrationJobSnapshot,
): RegistrationJobSnapshot[] {
  return mergeRegistrationJobSnapshots(current, [next]);
}

/** Merge a REST list without allowing any older row to erase live state. */
export function mergeRegistrationJobSnapshots(
  current: RegistrationJobSnapshot[],
  incoming: RegistrationJobSnapshot[],
): RegistrationJobSnapshot[] {
  const byId = new Map<string, RegistrationJobSnapshot>();
  for (const job of current) byId.set(job.id, job);
  for (const job of incoming) {
    const existing = byId.get(job.id);
    if (!existing || isNewerSnapshot(job, existing)) byId.set(job.id, job);
  }
  return compactRegistrationJobs([...byId.values()]);
}

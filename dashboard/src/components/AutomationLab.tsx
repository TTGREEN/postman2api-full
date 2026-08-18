import { useCallback, useEffect, useState } from "react";
import {
  fetchRegistrationJobs,
  retryRegistrationJob,
  startRegistrationJob,
  stopRegistrationJob,
  type RegistrationJobSnapshot,
} from "../lib/api";
import {
  buildRegistrationJobView,
  compactRegistrationJobs,
  mergeRegistrationJobSnapshot,
  mergeRegistrationJobSnapshots,
} from "../lib/registration-jobs";

const REGISTRATION_STATUS_LABELS: Record<RegistrationJobSnapshot["status"], string> = {
  queued: "排队中",
  running: "运行中",
  success: "已完成",
  failed: "失败",
  stopped: "已停止",
};

function clampIntegerInput(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isIntegerInputDraft(value: string): boolean {
  return /^\d*$/.test(value);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function RegistrationJobRow({ job, busy, onRetry }: {
  job: RegistrationJobSnapshot;
  busy: boolean;
  onRetry: (id: string) => void;
}) {
  return (
    <article className="registration-job-row" key={job.id}>
      <div className="registration-job-row-main"><strong>{job.target}</strong><span>真实上游 · {job.completed}/{job.requested}</span><span className={`registration-job-status is-${job.status}`}>{REGISTRATION_STATUS_LABELS[job.status]}</span></div>
      <div className="registration-job-row-meta">{new Date(job.updatedAt).toLocaleString("zh-CN")} · {job.attempts.filter((item) => item.status === "success").length} 个成功账号</div>
      {job.error && <div className="registration-job-error">{job.error}</div>}
      <div className="registration-job-row-actions">{job.status === "failed" || job.status === "stopped" ? <button className="page-action-btn" onClick={() => onRetry(job.id)} disabled={busy}>重试</button> : null}<span className="registration-job-stage">{job.events.filter((event) => event.type === "stage").slice(-1)[0]?.stage ?? "等待阶段"}</span></div>
    </article>
  );
}

function RegistrationJobsPanel() {
  const [jobs, setJobs] = useState<RegistrationJobSnapshot[]>([]);
  const [target, setTarget] = useState("postman");
  const [countInput, setCountInput] = useState("1");
  const [retryLimitInput, setRetryLimitInput] = useState("1");
  const [headless, setHeadless] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const incoming = compactRegistrationJobs((await fetchRegistrationJobs({ mode: "upstream", limit: 20 })).data);
      setJobs((current) => mergeRegistrationJobSnapshots(current, incoming));
      setError(null);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取注册任务失败"); }
  }, []);

  useEffect(() => {
    void load();
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
      ws = new WebSocket(wsProtocol + "//" + location.host + "/ws");
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; data?: RegistrationJobSnapshot };
          if (message.type !== "registration_job_update" || !message.data) return;
          setJobs((current) => mergeRegistrationJobSnapshot(current, message.data!));
        } catch { /* Ignore unrelated server-push messages. */ }
      };
      const scheduleReconnect = () => {
        if (disposed || reconnectTimer) return;
        ws = null;
        void load();
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 1000);
      };
      ws.onerror = scheduleReconnect;
      ws.onclose = scheduleReconnect;
    };
    connect();
    const timer = setInterval(() => {
      if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) {
        void load();
        connect();
      }
    }, 2500);
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      clearInterval(timer);
    };
  }, [load]);

  const { active: activeJobs, history } = buildRegistrationJobView(jobs);
  const active = activeJobs[0];
  const activeEvents = active?.events ?? [];
  const run = async () => {
    setBusy(true);
    try {
      const requestedCount = clampIntegerInput(countInput, 1, 100, 1);
      const requestedRetryLimit = clampIntegerInput(retryLimitInput, 0, 5, 0);
      setCountInput(String(requestedCount));
      setRetryLimitInput(String(requestedRetryLimit));
      const job = await startRegistrationJob({ target, count: requestedCount, retryLimit: requestedRetryLimit, mode: "upstream", headless });
      setJobs((current) => mergeRegistrationJobSnapshot(current, job));
      setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "启动注册任务失败"); }
    finally { setBusy(false); }
  };

  const stop = async (id: string) => {
    setBusy(true);
    try { const job = await stopRegistrationJob(id); setJobs((current) => mergeRegistrationJobSnapshot(current, job)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "停止注册任务失败"); }
    finally { setBusy(false); }
  };

  const retry = async (id: string) => {
    setBusy(true);
    try { const job = await retryRegistrationJob(id); setJobs((current) => mergeRegistrationJobSnapshot(current, job)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "重试注册任务失败"); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-hd">
        <div>
          <h1 className="page-title">上游注册任务</h1>
          <p className="page-sub">进行中任务和任务日志会实时刷新；历史仅保留最近 5 条。</p>
        </div>
      </div>
      <section className="registration-jobs-card" aria-labelledby="registration-jobs-title">
        <div className="section-head automation-lab-section-head">
          <h2 id="registration-jobs-title" className="section-title">任务配置</h2>
          <span className="section-meta">七阶段 · 持久化 · 可停止/重试</span>
        </div>
        <div className="automation-lab-notice">真实上游模式会打开浏览器并访问配置中的站点；任务历史只显示真实任务日志产生的记录。</div>
        <div className="automation-lab-fields registration-jobs-fields">
          <div className="automation-lab-field"><label htmlFor="registration-target">目标标签</label><input id="registration-target" className="input" value={target} maxLength={64} onChange={(e) => setTarget(e.target.value)} disabled={busy || Boolean(active)} /></div>
          <div className="automation-lab-field"><label htmlFor="registration-count">批量数量</label><input id="registration-count" className="input" type="number" inputMode="numeric" min={1} max={100} value={countInput} onChange={(e) => { if (isIntegerInputDraft(e.target.value)) setCountInput(e.target.value); }} onBlur={() => setCountInput(String(clampIntegerInput(countInput, 1, 100, 1)))} disabled={busy || Boolean(active)} /></div>
          <div className="automation-lab-field"><label htmlFor="registration-retry">失败重试</label><input id="registration-retry" className="input" type="number" inputMode="numeric" min={0} max={5} value={retryLimitInput} onChange={(e) => { if (isIntegerInputDraft(e.target.value)) setRetryLimitInput(e.target.value); }} onBlur={() => setRetryLimitInput(String(clampIntegerInput(retryLimitInput, 0, 5, 0)))} disabled={busy || Boolean(active)} /></div>
          <label className="registration-jobs-toggle"><input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} disabled={busy || Boolean(active)} /><span>无界面浏览器</span></label>
        </div>
        <div className="automation-lab-actions">
          <button className="page-action-btn page-action-btn-primary" onClick={() => void run()} disabled={busy || Boolean(active) || !target.trim() || !countInput.trim() || !retryLimitInput.trim()}>启动注册任务</button>
          {active && <button className="page-action-btn" onClick={() => void stop(active.id)} disabled={busy}>停止当前任务</button>}
        </div>
        {error && <p className="automation-lab-error" role="alert">{error}</p>}

        {activeJobs.length > 0 && <section className="registration-jobs-history" aria-label="正在进行的任务">
          <div className="registration-jobs-history-head"><strong>正在进行的任务</strong><span>{activeJobs.length} 条</span></div>
          {activeJobs.map((job) => <RegistrationJobRow key={job.id} job={job} busy={busy} onRetry={(id) => void retry(id)} />)}
        </section>}

        {activeEvents.length > 0 && <section className="registration-jobs-events" aria-label="注册任务阶段日志">
          <div className="registration-jobs-history-head"><strong>任务日志</strong><span>{activeEvents.length} 条</span></div>
          {activeEvents.slice(-18).map((event) => <div key={`${event.jobId}-${event.seq ?? `${event.ts}-${event.type}-${event.message}`}`} className={`automation-lab-log-line is-${event.level ?? "info"}`}><time className="automation-lab-log-time">{formatTime(event.ts)}</time><span className="automation-lab-log-step">{event.stage ?? event.type}</span><span className="automation-lab-log-message">{event.message}</span></div>)}
        </section>}

        <section className="registration-jobs-history" aria-label="任务历史">
          <div className="registration-jobs-history-head"><strong>任务历史</strong><span>{history.length} / 5 条</span></div>
          {history.length === 0 ? <p className="automation-lab-empty">还没有已完成的注册任务。</p> : history.map((job) => <RegistrationJobRow key={job.id} job={job} busy={busy} onRetry={(id) => void retry(id)} />)}
        </section>
      </section>
    </>
  );
}

export function AutomationLab() {
  return <RegistrationJobsPanel />;
}

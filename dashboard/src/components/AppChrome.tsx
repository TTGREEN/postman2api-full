import { useEffect, useRef } from "react";
import type { AccountTestResult } from "../lib/api";

export type Tab = "accounts" | "stats" | "settings" | "automation-lab";

export interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

export function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <header className="admin-header">
      <div className="admin-header-inner">
        <div className="admin-brand-wrap">
          <span className="admin-brand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            postman2api
          </span>
        </div>
        <nav className="admin-nav">
          {(["accounts", "stats", "settings", "automation-lab"] as Tab[]).map((t) => (
            <button key={t} className={`admin-nav-link ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "accounts" ? "账号" : t === "stats" ? "统计" : t === "settings" ? "设置" : "自动化实验室"}
            </button>
          ))}
        </nav>
        <div className="admin-header-right">
          <span className="admin-header-version">v1.0</span>
        </div>
      </div>
    </header>
  );
}

export function Toast({ msg, type }: { msg: string; type: "success" | "error" | "info" }) {
  const icon =
    type === "success" ? (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : type === "error" ? (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    ) : (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>
    );
  return (
    <div className="toast-container">
      <div className={`toast toast-${type}`}>
        <div className="toast-icon">{icon}</div>
        <div className="toast-content">{msg}</div>
      </div>
    </div>
  );
}

export function LoginLogPanel({ logs, onClose }: { logs: LoginLogEntry[]; onClose: () => void }) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  return (
    <div className="login-log-overlay">
      <div className="login-log-panel">
        <div className="login-log-header">
          <div className="login-log-title">
            <span className="live-dot">账号接入进度</span>
          </div>
          <button className="login-log-close" onClick={onClose} title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="login-log-body">
          {logs.map((log, i) => (
            <div key={i} className={`login-log-line login-log-${log.level}`}>
              <span className="login-log-time">{new Date(log.ts * 1000).toLocaleTimeString("zh-CN")}</span>
              <span className="login-log-step">[{log.step}]</span>
              <span className="login-log-msg">{log.msg}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}

export function AccountTestLogPanel({ result, onClose }: { result: AccountTestResult; onClose: () => void }) {
  return (
    <div className="login-log-overlay account-test-log-overlay">
      <div className="login-log-panel">
        <div className="login-log-header">
          <div className="login-log-title">
            <span>账号测试日志</span>
            <span className={`test-log-status ${result.available ? "is-success" : "is-error"}`}>
              {result.available ? "可用" : "不可用"}
            </span>
          </div>
          <button className="login-log-close" onClick={onClose} title="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="test-log-summary">
          <div><span>账号</span><strong>{result.email || `#${result.accountId}`}</strong></div>
          <div><span>模型</span><strong>{result.model}</strong></div>
          <div><span>耗时</span><strong>{result.durationMs} ms</strong></div>
          <div className="test-log-prompt"><span>测试问题</span><code>{result.prompt}</code></div>
          <div className="test-log-notice">该测试会向 Postman Agent 发送一次真实请求，并消耗少量额度。</div>
        </div>
        <div className="login-log-body test-log-body">
          {result.logs.map((log, i) => (
            <div key={`${log.ts}-${i}`} className={`login-log-line login-log-${log.level}`}>
              <span className="login-log-time">+{log.elapsedMs}ms</span>
              <span className="login-log-step">[{log.step}]</span>
              <span className="login-log-msg">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

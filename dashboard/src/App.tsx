import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchAccounts,
  fetchStats,
  fetchSettings,
  loginAccount,
  confirmSignup,
  deleteAccount,
  testAccount,
  warmupAccount,
  toggleAccount,
  updateSettings,
  importAccounts,
  type Account,
  type AccountImportResponse,
  type AccountTestResult,
  type Stats,
} from "./lib/api";

type Tab = "accounts" | "stats" | "settings";

interface LoginLogEntry {
  step: string;
  msg: string;
  level: string;
  ts: number;
}

const STATUS_LABEL: Record<string, string> = {
  active: "正常",
  exhausted: "耗尽",
  error: "错误",
  cooling: "请求受限",
  disabled: "禁用",
};

function getAccountDisplayStatus(a: Account): { status: string; label: string } {
  if (!a.enabled) return { status: "disabled", label: STATUS_LABEL.disabled };
  if (a.status === "exhausted") return { status: "exhausted", label: STATUS_LABEL.exhausted };
  return { status: "active", label: STATUS_LABEL.active };
}

export default function App() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);
  const [loginLogs, setLoginLogs] = useState<LoginLogEntry[] | null>(null);

  const showToast = useCallback((msg: string, type: "success" | "error" | "info" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const onLoginStart = useCallback(() => {
    setLoginLogs([]);
  }, []);
  const onLoginLog = useCallback((entry: LoginLogEntry) => {
    setLoginLogs((prev) => (prev === null ? null : [...prev, entry]));
  }, []);
  const onLoginEnd = useCallback(() => {
    setLoginLogs((prev) => (prev === null ? null : [...prev, { step: "完成", msg: "账号接入流程已完成", level: "info", ts: Date.now() / 1000 }]));
  }, []);

  return (
    <>
      <Header tab={tab} setTab={setTab} />
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      {loginLogs && <LoginLogPanel logs={loginLogs} onClose={() => setLoginLogs(null)} />}
      <main className="admin-main">
        {tab === "accounts" && (
          <AccountsTab
            showToast={showToast}
            onLoginStart={onLoginStart}
            onLoginLog={onLoginLog}
            onLoginEnd={onLoginEnd}
          />
        )}
        {tab === "stats" && <StatsTab />}
        {tab === "settings" && <SettingsTab showToast={showToast} />}
      </main>
    </>
  );
}

function Header({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
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
          {(["accounts", "stats", "settings"] as Tab[]).map((t) => (
            <button key={t} className={`admin-nav-link ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "accounts" ? "账号" : t === "stats" ? "统计" : "设置"}
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

function Toast({ msg, type }: { msg: string; type: "success" | "error" | "info" }) {
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

function LoginLogPanel({ logs, onClose }: { logs: LoginLogEntry[]; onClose: () => void }) {
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

function AccountTestLogPanel({ result, onClose }: { result: AccountTestResult; onClose: () => void }) {
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

function AccountsTab({
  showToast,
  onLoginStart,
  onLoginLog,
  onLoginEnd,
}: {
  showToast: (msg: string, type?: "success" | "error" | "info") => void;
  onLoginStart: () => void;
  onLoginLog: (entry: LoginLogEntry) => void;
  onLoginEnd: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<"login" | "signup" | "automated" | "import">("login");
  const [filter, setFilter] = useState("all");
  const [confirm, setConfirm] = useState<{ msg: string; action: () => void } | null>(null);
  const [warming, setWarming] = useState<Set<number>>(new Set());
  const [testing, setTesting] = useState<Set<number>>(new Set());
  const [testResults, setTestResults] = useState<Record<number, AccountTestResult>>({});
  const [testLogResult, setTestLogResult] = useState<AccountTestResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(
    async (silent?: boolean) => {
      try {
        const res = await fetchAccounts();
        setAccounts(res.data);
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const ids = new Set(res.data.map((account) => account.id));
          const next = new Set([...prev].filter((id) => ids.has(id)));
          return next.size === prev.size ? prev : next;
        });
      } catch (e: any) {
        if (!silent) showToast("加载失败：" + e.message, "error");
      } finally {
        setLoading(false);
      }
    },
    [showToast],
  );

  useEffect(() => {
    load();
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === "login_log") {
        onLoginLog({ step: data.data.step, msg: data.data.msg, level: data.data.level, ts: data.data.ts });
      } else if (data.type === "login_done") {
        if (data.data.success) onLoginEnd();
      } else if (data.type === "account_status") {
        setAccounts((current) => current.map((account) => {
          if (account.id !== data.data.id) return account;
          const errorMessage = data.data.error ?? data.data.warning
            ?? (data.data.status === "active" ? null : account.errorMessage);
          return {
            ...account,
            ...(data.data.status !== undefined ? { status: data.data.status } : {}),
            ...(data.data.enabled !== undefined ? { enabled: data.data.enabled } : {}),
            ...(data.data.quotaLimit !== undefined ? { quotaLimit: data.data.quotaLimit } : {}),
            ...(data.data.quotaRemaining !== undefined ? { quotaRemaining: data.data.quotaRemaining } : {}),
            errorMessage,
          };
        }));
      } else if (data.type === "login_start" || data.type === "account_added" || data.type === "account_updated" || data.type === "account_deleted") {
        load(true);
      } else {
        load(true);
      }
    };
    wsRef.current = ws;
    // Poll only as a fallback when the real-time channel is unavailable.
    const poll = setInterval(() => {
      if (!document.hidden && ws.readyState !== WebSocket.OPEN) load(true);
    }, 30000);
    return () => {
      ws.close();
      clearInterval(poll);
    };
  }, [load, onLoginLog, onLoginEnd]);

  const counts: Record<string, number> = { all: accounts.length };
  accounts.forEach((a) => {
    counts[a.status] = (counts[a.status] || 0) + 1;
  });
  const filtered = filter === "all" ? accounts : accounts.filter((a) => a.status === filter);
  const activeCount = accounts.filter((a) => a.status === "active").length;
  const exhaustedCount = accounts.filter((a) => a.status === "exhausted").length;
  const errorCount = accounts.filter((a) => a.status === "error").length;
  const accountsWithKnownQuota = accounts.filter(
    (a) =>
      a.quotaLimit != null &&
      a.quotaRemaining != null &&
      !(a.quotaLimit === 800000 && a.quotaRemaining === 800000),
  );
  const totalQuotaRemaining = accountsWithKnownQuota.reduce((s, a) => s + a.quotaRemaining!, 0);
  const isTotalQuotaKnown = accounts.length > 0 && accountsWithKnownQuota.length === accounts.length;

  const doDelete = async (id: number) => {
    try {
      await deleteAccount(id);
      showToast("已删除", "success");
      load();
    } catch (e: any) {
      showToast("删除失败：" + e.message, "error");
    }
  };

  const doWarmup = async (id: number) => {
    if (warming.has(id) || testing.has(id)) return;
    setWarming((s) => new Set(s).add(id));
    try {
      const res = await warmupAccount(id);
      setAccounts((current) => current.map((account) => account.id === id ? res.account : account));
      if (res.success) showToast("额度刷新成功", "success");
      else showToast(res.error || "额度刷新失败", "error");
    } catch (e: any) {
      showToast("额度刷新失败：" + e.message, "error");
    } finally {
      setWarming((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const doTestAccount = async (id: number) => {
    if (warming.has(id) || testing.has(id)) return;
    setTesting((s) => new Set(s).add(id));
    setTestResults((results) => {
      const next = { ...results };
      delete next[id];
      return next;
    });

    try {
      const result = await testAccount(id);
      const latest = await fetchAccounts();
      setAccounts(latest.data);
      const tested = latest.data.find((candidate) => candidate.id === id);
      setTestResults((results) => ({ ...results, [id]: result }));
      setTestLogResult(result);
      const message = result.available
        ? tested?.enabled === false ? "账号可用，当前已禁用" : "账号实际问答可用"
        : `账号不可用：${result.error || "测试失败"}`;
      showToast(message, result.available ? "success" : "error");
    } catch (e: any) {
      const message = `账号不可用：${e.message}`;
      showToast(message, "error");
      await load(true);
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const doToggle = async (id: number, enable: boolean) => {
    try {
      await toggleAccount(id, enable);
      load();
    } catch (e: any) {
      showToast("切换状态失败：" + e.message, "error");
    }
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (prev.size === filtered.length && filtered.length > 0) return new Set<number>();
      return new Set(filtered.map((a) => a.id));
    });
  };

  const isAllSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id));
  const batchBusy = selected.size > 0 && [...selected].some((id) => warming.has(id) || testing.has(id));

  const doBatchWarmup = async () => {
    const ids = [...selected].filter((id) => !warming.has(id) && !testing.has(id));
    if (ids.length === 0) return;
    setWarming((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.add(id));
      return n;
    });
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await warmupAccount(id);
        setAccounts((current) => current.map((account) => account.id === id ? res.account : account));
        if (res.success) ok++;
        else failed++;
      } catch {
        failed++;
      }
    }
    setWarming((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.delete(id));
      return n;
    });
    showToast(ids.length === 1
      ? (failed === 0 ? "额度刷新成功" : "额度刷新失败")
      : `批量刷新完成：成功 ${ok}，失败 ${failed}`, failed === 0 ? "success" : "error");
  };

  const doBatchTest = async () => {
    const ids = [...selected].filter((id) => !warming.has(id) && !testing.has(id));
    if (ids.length === 0) return;
    setTesting((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.add(id));
      return n;
    });
    let ok = 0;
    let failed = 0;
    setTestLogResult(null);
    for (const id of ids) {
      try {
        const result = await testAccount(id);
        setTestResults((results) => ({ ...results, [id]: result }));
        if (result.available) ok++;
        else failed++;
      } catch {
        failed++;
      }
    }
    const latest = await fetchAccounts();
    setAccounts(latest.data);
    setTesting((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.delete(id));
      return n;
    });
    showToast(ids.length === 1
      ? (failed === 0 ? "账号实际问答可用" : "账号不可用")
      : `批量测试完成：可用 ${ok}，不可用 ${failed}`, failed === 0 ? "success" : "error");
  };

  const doBatchDelete = async () => {
    const ids = [...selected];
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteAccount(id);
        ok++;
      } catch {
        failed++;
      }
    }
    setSelected(new Set());
    showToast(ids.length === 1
      ? (failed === 0 ? "已删除" : "删除失败")
      : `批量删除完成：成功 ${ok}，失败 ${failed}`, failed === 0 ? "success" : "error");
    load();
  };

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">账号池</div>
          <div className="page-sub">
            多账号轮询 · 额度耗尽时自动切换 · 实时用量监控
          </div>
        </div>
        <div className="page-actions">
          <span className="live-dot">实时监控</span>
          <button className="page-action-btn" onClick={() => { accounts.forEach(a => warmupAccount(a.id)); setTimeout(() => load(), 3000); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.6"/><path d="M20 20v-5h-5"/></svg>
            刷新额度
          </button>
          <button className="page-action-btn page-action-btn-primary" onClick={() => setShowAdd(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            添加账号
          </button>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">账号概览</div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">账号总数</div>
            <span className="stat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8">
                <path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4" />
                <circle cx="12" cy="8" r="4" />
              </svg>
            </span>
          </div>
          <div className="stat-num">{accounts.length}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">正常</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9">
                <circle cx="12" cy="12" r="8" />
                <path d="m8.5 12 2.4 2.4 4.8-4.8" />
              </svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{activeCount}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">额度耗尽</div>
            <span className="stat-icon" style={{ color: "#8d6bbd" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8">
                <path d="M6 19h12" />
                <path d="M12 16V9" />
              </svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#8d6bbd" }}>{exhaustedCount}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">剩余额度总计</div>
            <span className="stat-icon" style={{ color: "#4c9168" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#4c9168" }}>
            {isTotalQuotaKnown ? fmtQuota(totalQuotaRemaining) : "未知"}
          </div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">错误</div>
            <span className="stat-icon" style={{ color: "#b66a63" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#b66a63" }}>{errorCount}</div>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">
          账号详情 <span className="section-count-badge">{filtered.length}</span>
        </div>
      </div>

      <div className="filter-bar">
        {[
          ["all", "全部"],
          ["active", "正常"],
          ["exhausted", "额度耗尽"],
          ["error", "错误"],
        ].map(([k, l]) => (
          <button key={k} className={`filter-chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {l}
            <span className="filter-chip-count">{counts[k] || 0}</span>
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="batch-bar">
          <span className="batch-bar-info">
            已选 <span className="batch-bar-count">{selected.size}</span> 个账号
          </span>
          <div className="batch-bar-actions">
            <button className="batch-bar-btn" disabled={batchBusy} onClick={doBatchWarmup}>
              <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none"><path d="M20 11a8 8 0 0 0-14.6-4.6" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.6 4.6" /><path d="M20 20v-5h-5" /></svg>
              批量刷新额度
            </button>
            <button className="batch-bar-btn" disabled={batchBusy} onClick={doBatchTest}>
              <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none"><path d="M5 12.5 9.2 17 19 7" /></svg>
              批量测试
            </button>
            <button
              className="batch-bar-btn batch-bar-btn-danger"
              disabled={batchBusy}
              onClick={() => setConfirm({
                msg: `确定删除选中的 ${selected.size} 个账号吗？此操作无法撤销。`,
                action: doBatchDelete,
              })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M5 7h14" /><path d="M9 7V4h6v3" /><path d="M8 10v7" /><path d="M12 10v7" /><path d="M16 10v7" /><path d="M7 7l1 13h8l1-13" />
              </svg>
              批量删除
            </button>
          </div>
        </div>
      )}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 44 }}>
                <label className="checkbox-label">
                  <input type="checkbox" className="checkbox-input" checked={isAllSelected} onChange={toggleSelectAll} />
                  <span className="checkbox-box" />
                </label>
              </th>
              <th>邮箱</th>
              <th className="table-center" style={{ width: 80 }}>状态</th>
              <th style={{ minWidth: 200 }}>额度</th>
              <th style={{ width: 120 }}>最近使用</th>
              <th style={{ width: 220 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="empty-state">加载中...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="empty-state">暂无账号，请点击右上角“添加账号”。</td></tr>
            ) : (
              filtered.map((a) => {
                const displayStatus = getAccountDisplayStatus(a);
                const isWarming = warming.has(a.id);
                const isTesting = testing.has(a.id);
                const testResult = testResults[a.id];
                return (
                  <tr key={a.id}>
                    <td>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          className="checkbox-input"
                          checked={selected.has(a.id)}
                          onChange={() => toggleSelect(a.id)}
                        />
                        <span className="checkbox-box" />
                      </label>
                    </td>
                    <td>
                      <span className="tok">{a.email}</span>
                      {a.errorMessage && (
                        <div style={{ fontSize: 11, color: "#b66a63", marginTop: 2 }}>{a.errorMessage}</div>
                      )}
                    </td>
                    <td className="table-center">
                      <span className={`badge badge-${displayStatus.status}`}>
                        {displayStatus.label}
                      </span>
                    </td>
                    <td>{quotaCell(a)}</td>
                    <td style={{ fontSize: 12, color: "#9a9a9a" }}>{fmtDate(a.lastUsedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className={`row-test-btn ${testResult ? (testResult.available ? "is-success" : "is-error") : ""}`}
                          title={testResult ? (testResult.available ? "上次测试可用，点击重新测试" : testResult.error || "上次测试不可用，点击重新测试") : "发送真实问题测试账号是否可用"}
                          disabled={isWarming || isTesting}
                          onClick={() => doTestAccount(a.id)}
                        >
                          {isTesting ? (
                            <span className="row-test-spinner" aria-hidden="true" />
                          ) : (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M5 12.5 9.2 17 19 7" />
                            </svg>
                          )}
                          {isTesting ? "测试中" : testResult ? (testResult.available ? "可用" : "不可用") : "测试"}
                        </button>
                        <button
                          className="row-icon-btn"
                          title={testResult ? "查看最近一次测试日志" : "尚无测试日志"}
                          disabled={!testResult}
                          onClick={() => testResult && setTestLogResult(testResult)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 5h14" /><path d="M5 12h14" /><path d="M5 19h14" />
                          </svg>
                        </button>
                        <button
                          className={`row-icon-btn ${isWarming ? "is-loading" : ""}`}
                          title="刷新额度"
                          disabled={isWarming || isTesting}
                          onClick={() => doWarmup(a.id)}
                        >
                          <svg viewBox="0 0 24 24">
                            <path d="M20 11a8 8 0 0 0-14.6-4.6" />
                            <path d="M4 4v5h5" />
                            <path d="M4 13a8 8 0 0 0 14.6 4.6" />
                            <path d="M20 20v-5h-5" />
                          </svg>
                        </button>
                        <button className="row-icon-btn" title={isDisabled ? "启用" : "禁用"} onClick={() => doToggle(a.id, isDisabled)}>
                          {isDisabled ? (
                            <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.708" /><path d="M3 4v5h5" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M8.5 8.5 15.5 15.5" /></svg>
                          )}
                        </button>
                        <button className="row-icon-btn row-icon-danger" title="删除"
                          onClick={() => setConfirm({ msg: `确定删除账号“${a.email}”吗？此操作无法撤销。`, action: () => doDelete(a.id) })}>
                          <svg viewBox="0 0 24 24">
                            <path d="M5 7h14" /><path d="M9 7V4h6v3" /><path d="M8 10v7" />
                            <path d="M12 10v7" /><path d="M16 10v7" /><path d="M7 7l1 13h8l1-13" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddAccountModal
          mode={addMode}
          setMode={setAddMode}
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); load(); }}
          onRefresh={() => load()}
          showToast={showToast}
          onLoginStart={onLoginStart}
        />
      )}

      {confirm && (
        <ConfirmModal
          title="确认操作"
          body={confirm.msg}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { await confirm.action(); setConfirm(null); }}
        />
      )}

      {testLogResult && (
        <AccountTestLogPanel result={testLogResult} onClose={() => setTestLogResult(null)} />
      )}
    </>
  );
}

function AddAccountModal({
  mode,
  setMode,
  onClose,
  onDone,
  onRefresh,
  showToast,
  onLoginStart,
}: {
  mode: "login" | "signup" | "automated" | "import";
  setMode: (m: "login" | "signup" | "automated" | "import") => void;
  onClose: () => void;
  onDone: () => void;
  onRefresh: () => void;
  showToast: (msg: string, type?: "success" | "error" | "info") => void;
  onLoginStart: (confirmationId?: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tokens, setTokens] = useState("");
  const [loading, setLoading] = useState(false);
  const [importResult, setImportResult] = useState<AccountImportResponse | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [confirmationState, setConfirmationState] = useState<"idle" | "sending" | "sent">("idle");

  const handleFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setSelectedFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      const merged = [...prev];
      for (const f of picked) {
        if (!names.has(f.name)) {
          merged.push(f);
          names.add(f.name);
        }
      }
      return merged;
    });
    setImportResult(null);
    e.target.value = "";
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setImportResult(null);
  };

  const confirmRegistration = async () => {
    if (!confirmationId || confirmationState !== "idle") return;
    setConfirmationState("sending");
    try {
      await confirmSignup(confirmationId);
      setConfirmationState("sent");
      showToast("完成确认已提交，正在校验并保存账号", "info");
    } catch (e: any) {
      setConfirmationState("idle");
      showToast("完成确认失败：" + e.message, "error");
    }
  };

  const readTokenFiles = async (): Promise<unknown[]> => {
    const records: unknown[] = [];
    for (const file of selectedFiles) {
      let text: string;
      try {
        text = await file.text();
      } catch (e: any) {
        throw new Error(`读取文件 ${file.name} 失败：${e.message}`);
      }
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`文件 ${file.name} 不是合法的 JSON`);
      }
      if (parsed && Array.isArray(parsed.accounts)) records.push(...parsed.accounts);
      else if (parsed && typeof parsed === "object") records.push(parsed);
      else throw new Error(`文件 ${file.name} 内容格式不正确`);
    }
    return records;
  };

  const submit = async () => {
    setLoading(true);
    try {
      if (mode !== "import") {
        const isSignup = mode === "signup" || mode === "automated";
        const nextConfirmationId = isSignup ? crypto.randomUUID() : undefined;
        setConfirmationId(nextConfirmationId || null);
        setConfirmationState("idle");
        onLoginStart();
        await loginAccount(
          email.trim(),
          isSignup ? "signup" : "login",
          nextConfirmationId,
          mode === "automated" ? { username: username.trim() || undefined, password } : undefined,
        );
        showToast(isSignup ? "注册完成，账号已自动导入账号池" : "浏览器登录完成，账号已添加", "success");
      } else {
        let payload: unknown;
        if (selectedFiles.length > 0) {
          payload = { version: 1, accounts: await readTokenFiles() };
        } else {
          try {
            payload = JSON.parse(tokens);
          } catch {
            showToast("粘贴内容不是合法的 JSON", "error");
            return;
          }
        }
        const result = await importAccounts(payload);
        setImportResult(result);
        onRefresh();
        const summary = `创建 ${result.summary.created}，更新 ${result.summary.updated}，失败 ${result.summary.failed}`;
        showToast(`导入完成：${summary}`, result.summary.failed ? "error" : "success");
        return;
      }
      onDone();
    } catch (e: any) {
      showToast(e.message, "error");
    } finally {
      setLoading(false);
      setConfirmationId(null);
      setConfirmationState("idle");
    }
  };

  return (
    <div className="modal-overlay open" onClick={() => { if (!loading) onClose(); }}>
      <div className={`modal ${mode === "import" ? "import-modal" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">添加 Postman 账号</div>
        <div className="filter-bar" style={{ marginBottom: 16 }}>
          <button className={`filter-chip ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
            已有账号
          </button>
          <button className={`filter-chip ${mode === "signup" ? "active" : ""}`} onClick={() => setMode("signup")}>
            注册与首次设置
          </button>
          <button className={`filter-chip ${mode === "automated" ? "active" : ""}`} onClick={() => setMode("automated")}>
            自动化注册
          </button>
          <button className={`filter-chip ${mode === "import" ? "active" : ""}`} onClick={() => { setMode("import"); setImportResult(null); }}>
            JSON 导入
          </button>
        </div>
        <div className="dialog-body">
          {mode !== "import" && (
            <div className="dialog-field">
              <span className="dialog-label">邮箱</span>
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
            </div>
          )}
          {mode === "automated" && (
            <>
              <div className="dialog-field">
                <span className="dialog-label">用户名</span>
                <input
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="可选，默认使用邮箱前缀"
                  autoComplete="username"
                />
              </div>
              <div className="dialog-field">
                <span className="dialog-label">密码</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 8 个字符"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}
          {mode === "login" ? (
            <div className="dialog-help">
              将直接打开可见的 Postman 登录页。完成登录后，系统会从会话中识别账号并保存；本应用不会读取或存储你的密码。
            </div>
          ) : mode === "signup" ? (
            <div className="signup-guide">
              <div className="dialog-help">Camoufox 会保持打开。请完成全部步骤，然后回到此弹窗点击“完成确认”：</div>
              <ol className="signup-steps">
                <li>填写注册信息，并完成邮箱验证码与 CAPTCHA。</li>
                <li>填写个人资料、角色和工作区信息，直到进入团队工作区。</li>
                <li>确认套餐与 AI credits；付费必须由你亲自确认。</li>
                <li>由有权限的用户开启 Team AI。</li>
              </ol>
              <div className="signup-warning">不提供临时邮箱轮换、验证码抓取、批量领取试用、自动付款或自动变更团队权限。</div>
            </div>
          ) : mode === "automated" ? (
            <div className="signup-guide">
              <div className="dialog-help">Camoufox 会自动填写注册表单并推进普通首次设置。遇到以下步骤时会暂停，完成后回到此弹窗点击“完成确认”：</div>
              <ol className="signup-steps">
                <li>手动完成邮箱验证码和 CAPTCHA。</li>
                <li>手动确认任何协议、套餐、试用或付费操作。</li>
                <li>由有权限的用户手动开启 Team AI。</li>
              </ol>
              <div className="signup-warning">密码仅用于当前浏览器注册，不会写入数据库、日志或 WebSocket 消息。一次只允许一个注册任务。</div>
            </div>
          ) : (
            <div className="import-section">
              <div className="import-files-wrap">
                <label className="import-file-picker">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  选择 Token 文件（可多选）
                  <input
                    type="file"
                    accept=".json,application/json"
                    multiple
                    className="import-file-input"
                    onChange={handleFilesChange}
                  />
                </label>
                {selectedFiles.length > 0 && (
                  <div className="import-file-list">
                    {selectedFiles.map((file, i) => (
                      <span className="import-file-chip" key={`${file.name}-${i}`}>
                        <span>{file.name}</span>
                        <button type="button" className="import-file-remove" onClick={() => removeFile(i)} title="移除">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="dialog-help">
                粘贴版本化账号 JSON，或选择多个 Token 文件批量导入。相同邮箱会更新 Token，不会重复创建。
              </div>
              <textarea
                className="input import-textarea"
                value={tokens}
                onChange={(e) => { setTokens(e.target.value); setImportResult(null); }}
                spellCheck={false}
                placeholder={'{\n  "version": 1,\n  "accounts": [\n    {\n      "email": "user@example.com",\n      "enabled": true,\n      "tokens": {\n        "postman_sid": "...",\n        "user_id": "...",\n        "workspace_id": "...",\n        "workspace_subdomain": "team-name"\n      }\n    }\n  ]\n}'}
              />
              <a className="import-doc-link" href="/docs/postman-account-token.md" target="_blank" rel="noreferrer">
                查看 Token 获取与 JSON 格式说明
              </a>
              {importResult && (
                <div className="import-result" aria-live="polite">
                  <div className="import-result-summary">
                    共 {importResult.summary.total} 条 · 创建 {importResult.summary.created} · 更新 {importResult.summary.updated} · 失败 {importResult.summary.failed}
                  </div>
                  <div className="import-result-list">
                    {importResult.results.map((result) => (
                      <div className={`import-result-row is-${result.status}`} key={`${result.index}-${result.email || "unknown"}`}>
                        <span>{result.index + 1}. {result.email || "未识别邮箱"}</span>
                        <span>{result.status === "created" ? "已创建" : result.status === "updated" ? "已更新" : result.error || "导入失败"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {(mode === "signup" || mode === "automated") && loading && confirmationId && (
          <div className="signup-confirm-row">
            <span>确认注册、资料、套餐与 Team AI 均已完成。</span>
            <button
              className="dialog-btn signup-confirm-btn"
              disabled={confirmationState !== "idle"}
              onClick={confirmRegistration}
            >
              {confirmationState === "sending" ? "提交中..." : confirmationState === "sent" ? "已确认" : "完成确认"}
            </button>
          </div>
        )}
        <div className="dialog-actions">
          <button className="dialog-btn" disabled={loading} onClick={onClose}>{mode === "import" && importResult ? "完成" : "取消"}</button>
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={loading || (mode === "import" ? (!tokens.trim() && selectedFiles.length === 0) : !email.trim()) || (mode === "automated" && password.length < 8)}
            onClick={submit}
          >
            {loading
              ? (mode === "import" ? "导入中..." : mode === "signup" || mode === "automated" ? "等待注册设置..." : "等待登录...")
              : mode === "import" ? "导入账号" : mode === "automated" ? "开始自动化注册" : mode === "signup" ? "打开注册浏览器" : "打开登录浏览器"}
          </button>
        </div>
      </div>
    </div>
  );
}

function quotaCell(a: Account) {
  const limit = a.quotaLimit || 0;
  const remaining = a.quotaRemaining || 0;
  const pct = limit > 0 ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : 0;
  const color = pct <= 0 ? "#c9c9cf" : pct < 15 ? "#b0632a" : "#4c9168";

  if (!limit) return <span className="quota-empty">尚未获取</span>;

  return (
    <div className="quota-rows">
      <div className="quota-row">
        <span className="quota-row-name">AI 点数</span>
        <span className="quota-row-track"><span className="quota-row-fill" style={{ width: `${pct}%`, background: color }}></span></span>
        <span className="quota-row-val">{fmtQuota(remaining)} / {fmtQuota(limit)}</span>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay open" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="dialog-help">{body}</div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={onCancel}>取消</button>
          <button className="dialog-btn dialog-btn-danger" onClick={onConfirm}>确认</button>
        </div>
      </div>
    </div>
  );
}

function StatsTab() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const get = () => fetchStats().then((r) => setStats(r.data));
    get();
    const interval = setInterval(get, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!stats) return <div className="empty-state">加载中...</div>;

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">请求统计</div>
          <div className="page-sub">实时请求监控 · Token 用量追踪</div>
        </div>
        <div className="page-actions">
          <span className="live-dot">每 5 秒自动刷新</span>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">概览</div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">请求总数</div>
            <span className="stat-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
            </span>
          </div>
          <div className="stat-num">{stats.totalRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">成功</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.4 2.4 4.8-4.8" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{stats.successRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">错误数</div>
            <span className="stat-icon" style={{ color: "#b66a63" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#b66a63" }}>{stats.errorRequests}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">Token 总数</div>
            <span className="stat-icon" style={{ color: "#4c76b2" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M4 19a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4" /><circle cx="12" cy="8" r="4" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#4c76b2" }}>{fmt(stats.totalTokens)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">提示词 Token</div>
            <span className="stat-icon" style={{ color: "#8a8a8a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></svg>
            </span>
          </div>
          <div className="stat-num">{fmt(stats.totalPromptTokens)}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">补全 Token</div>
            <span className="stat-icon" style={{ color: "#8a8a8a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8"><path d="M3 6h18" /><path d="M3 12h12" /><path d="M3 18h18" /></svg>
            </span>
          </div>
          <div className="stat-num">{fmt(stats.totalCompletionTokens)}</div>
        </div>
      </div>

      <div className="section-head">
        <div className="section-title">
          账号 <span className="section-count-badge">{stats.totalAccounts}</span>
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat-cell">
          <div className="stat-top"><div className="stat-label">账号总数</div></div>
          <div className="stat-num">{stats.totalAccounts}</div>
        </div>
        <div className="stat-cell">
          <div className="stat-top">
            <div className="stat-label">正常账号</div>
            <span className="stat-icon" style={{ color: "#16a34a" }}>
              <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9"><circle cx="12" cy="12" r="8" /><path d="m8.5 12 2.4 2.4 4.8-4.8" /></svg>
            </span>
          </div>
          <div className="stat-num" style={{ color: "#16a34a" }}>{stats.activeAccounts}</div>
        </div>
      </div>

      {stats.recentRequests.length > 0 && (
        <>
          <div className="section-head">
            <div className="section-title">
              最近请求 <span className="section-count-badge">{stats.recentRequests.length}</span>
            </div>
          </div>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th className="table-center" style={{ width: 80 }}>状态</th>
                  <th className="table-center" style={{ width: 80 }}>Token 数</th>
                  <th className="table-center" style={{ width: 100 }}>耗时</th>
                  <th style={{ width: 160 }}>时间</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentRequests.slice(0, 20).map((r: any) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: "ui-monospace,monospace", fontSize: 12 }}>{r.model || "—"}</td>
                    <td className="table-center">
                      <span className={`badge ${r.status === "success" ? "badge-active" : "badge-error"}`}>
                        {r.status === "success" ? "成功" : r.status === "error" ? "错误" : STATUS_LABEL[r.status] || "未知"}
                      </span>
                    </td>
                    <td className="table-center">{r.totalTokens || 0}</td>
                    <td className="table-center">{r.durationMs ? `${r.durationMs}ms` : "—"}</td>
                    <td style={{ fontSize: 12, color: "#9a9a9a" }}>{r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function SettingsTab({ showToast }: { showToast: (msg: string, type?: "success" | "error" | "info") => void }) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings().then((r) => setSettings(r.data));
  }, []);

  return (
    <>
      <div className="page-hd">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">网关访问控制与配置</div>
        </div>
      </div>

      <div className="settings-card">
        <div className="section-title" style={{ marginBottom: 16 }}>API 配置</div>
        <div className="settings-row">
          <label>API Key（用于 /v1/* 端点）</label>
          <div className="hint">
            调用 <code>/v1/chat/completions</code> 时必须包含 <code>Authorization: Bearer &lt;key&gt;</code>。
            留空则使用默认值。
          </div>
          <input
            className="input"
            value={settings.api_key || ""}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            style={{ fontFamily: "ui-monospace,monospace" }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button
            className="dialog-btn dialog-btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await updateSettings(settings);
                showToast("已保存", "success");
              } catch (e: any) {
                showToast("保存失败：" + e.message, "error");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="section-title" style={{ marginBottom: 12 }}>使用说明</div>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          · 在“账号”页通过浏览器登录或手动粘贴 Token 添加 Postman 账号。
          <br />
          · 请求采用轮询方式分配；账号额度耗尽后会自动切换到下一个账号。
          <br />
          · “账号”页会实时显示账号额度和状态。
          <br />· 对话端点：{" "}
          <code id="endpoint">{location.origin}/v1/chat/completions</code>（兼容 OpenAI API 协议）。
        </div>
      </div>
    </>
  );
}

function fmt(n: number): string {
  n = Number(n) || 0;
  return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function fmtQuota(n: number): string {
  return (Number(n) || 0).toFixed(2);
}

function fmtDate(d?: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime())
    ? "—"
    : dt.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

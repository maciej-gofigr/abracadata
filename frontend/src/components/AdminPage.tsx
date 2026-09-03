import { useEffect, useState } from "react";
import { adminCosts, adminFlags, adminSetLlm, adminSetBudget, adminStats, adminUsage, type AdminCosts, type AdminFlags, type AdminStats, type AdminUsage } from "../lib/api";

/**
 * Admin controls. The kill switch exists for a cost/abuse spike, so it is the
 * first thing on the page and takes effect immediately (the flag lives in the
 * database, not in config).
 */
export function AdminPage({ onHome }: { onHome: () => void }) {
  const [flags, setFlags] = useState<AdminFlags | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [costs, setCosts] = useState<AdminCosts | null>(null);
  const [llm, setLlm] = useState<AdminUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [f, s, u] = await Promise.all([adminFlags(), adminStats(), adminUsage()]);
        setFlags(f);
        setStats(s);
        setLlm(u);
      } catch {
        setErr("Couldn't load admin data — are you still signed in as an admin?");
      }
      try {
        setCosts(await adminCosts());
      } catch {
        /* costs are best-effort; the panel shows its own message */
      }
    })();
  }, []);

  async function toggleLlm(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      setFlags(await adminSetLlm(next));
    } catch {
      setErr("Couldn't change the setting. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveBudget() {
    const v = Number(budgetDraft);
    if (!Number.isFinite(v) || v < 0) return;
    setBusy(true);
    try {
      setLlm(await adminSetBudget(v));
      setBudgetDraft("");
    } catch {
      setErr("Couldn't change the budget.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshCosts() {
    setRefreshing(true);
    try {
      setCosts(await adminCosts(true));
    } catch {
      /* the panel keeps showing whatever it had */
    } finally {
      setRefreshing(false);
    }
  }

  const llmOn = flags?.llm_enabled ?? true;

  return (
    <section className="admin">
      <button className="linklike legal-back" onClick={onHome}>← Back to Abracadata</button>
      <h1 className="admin-title">Admin</h1>
      {err && <div className="error" style={{ marginBottom: 16 }}>{err}</div>}

      <div className={`card section admin-kill ${llmOn ? "" : "is-off"}`}>
        <div className="card-header">
          <h2>AI generation</h2>
          <span className="count">{llmOn ? "running normally" : "paused — no Bedrock calls"}</span>
        </div>
        <div className="card-body">
          <p className="admin-help">
            Turns off every billable model call — recipe generation and prompt suggestions —
            immediately, for everyone. Use it if traffic or spend spikes. Saved recipes keep
            working: they run in the browser and don't touch the AI. Visitors see a notice
            that the service is having trouble.
          </p>
          <div className="admin-actions">
            <button
              className={`btn ${llmOn ? "danger" : "primary"}`}
              disabled={busy || !flags}
              onClick={() => toggleLlm(!llmOn)}
            >
              {busy ? "Saving…" : llmOn ? "Pause AI generation" : "Resume AI generation"}
            </button>
            <span className={`admin-state ${llmOn ? "on" : "off"}`}>
              {llmOn ? "Enabled" : "Paused"}
            </span>
          </div>
          {flags?.updated_at && (
            <p className="admin-meta">
              Last changed {new Date(flags.updated_at).toLocaleString()}
              {flags.updated_by ? ` by ${flags.updated_by}` : ""}.
            </p>
          )}
        </div>
      </div>

      {llm && (
        <div className="card section">
          <div className="card-header">
            <h2>AI usage today</h2>
            <span className="count">resets 00:00 UTC</span>
          </div>
          <div className="card-body">
            <div className="admin-total">
              ${llm.estimated_cost.toFixed(2)}
              <span className="admin-total-label">of ${llm.budget.toFixed(2)} budget · {llm.pct_of_budget}%</span>
            </div>
            <div className="budget-bar" aria-hidden="true">
              <div className={`budget-fill ${llm.pct_of_budget >= 60 ? "warn" : ""}`}
                style={{ width: `${Math.min(100, llm.pct_of_budget)}%` }} />
            </div>
            <table className="admin-costs">
              <tbody>
                <tr><td>Model calls</td><td className="num">{llm.calls}</td></tr>
                <tr><td>Input tokens</td><td className="num">{llm.input_tokens.toLocaleString()}</td></tr>
                <tr><td>Output tokens</td><td className="num">{llm.output_tokens.toLocaleString()}</td></tr>
              </tbody>
            </table>
            <div className="admin-actions" style={{ marginTop: 14 }}>
              <input className="field" style={{ maxWidth: 130 }} type="number" min="0" step="1"
                placeholder={`${llm.budget}`} value={budgetDraft}
                onChange={(e) => setBudgetDraft(e.target.value)} aria-label="Daily budget in USD" />
              <button className="btn" disabled={busy || budgetDraft === ""} onClick={saveBudget}>
                Set daily budget
              </button>
            </div>
            <p className="admin-meta">
              Estimated from token counts, so it's visible immediately — AWS billing lags hours behind.
              Generation pauses automatically at 100% and emails admins.
              <strong> After an automatic pause, raise the budget first</strong> — resuming alone
              is undone by the next request's budget check.
            </p>
          </div>
        </div>
      )}

      <div className="card section">
        <div className="card-header">
          <h2>AWS spend</h2>
          <span className="count">{costs?.month ?? "month to date"}</span>
          <button className="btn ghost" disabled={refreshing} onClick={refreshCosts}
            title="Fetch fresh figures from AWS (each lookup costs about a cent)">
            {refreshing ? <><span className="spinner" aria-hidden="true" />Refreshing…</> : "Refresh"}
          </button>
        </div>
        <div className="card-body">
          {!costs ? (
            <p className="admin-help">Loading…</p>
          ) : costs.error ? (
            <p className="admin-help">{costs.error}</p>
          ) : (
            <>
              <div className="admin-total">
                {costs.currency === "USD" ? "$" : ""}{costs.total.toFixed(2)}
                <span className="admin-total-label">month to date</span>
              </div>
              <table className="admin-costs">
                <tbody>
                  {costs.by_service.map((s) => (
                    <tr key={s.service}>
                      <td>{s.service}</td>
                      <td className="num">{costs.currency === "USD" ? "$" : ""}{s.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="admin-meta">
                Cached for an hour; <strong>Refresh</strong> fetches now (AWS bills about a
                cent per lookup). Read {new Date(costs.cached_at).toLocaleString()}. AWS
                usage data itself can lag several hours behind real time.
              </p>
            </>
          )}
        </div>
      </div>

      {stats && (
        <div className="card section">
          <div className="card-header"><h2>Usage</h2></div>
          <div className="card-body">
            <table className="admin-costs">
              <tbody>
                <tr><td>Accounts</td><td className="num">{stats.users}</td></tr>
                <tr><td>Saved recipes</td><td className="num">{stats.recipes}</td></tr>
                <tr><td>Sign-in codes (last hour)</td><td className="num">{stats.codes_last_hour}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

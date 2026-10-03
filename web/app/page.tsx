"use client";
import React, { useEffect, useState } from "react";
import { api, CaseSummary } from "./api-client";
import CaseList from "./components/CaseList";
import CaseDetail from "./components/CaseDetail";
import NewAlertForm from "./components/NewAlertForm";

export default function Page() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [auditStatus, setAuditStatus] = useState<{ valid: boolean; detail: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [demoMode, setDemoMode] = useState<boolean | null>(null);
  const sidebarRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "dark") { setIsDark(true); document.documentElement.classList.add("dark"); }
    fetch("/api/config").then(r => r.json()).then(c => setDemoMode(!!c.demo_mode)).catch(() => {});
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const refresh = () => {
    api.listCases().then((r) => setCases(r.cases)).catch(() => {});
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const runVerify = async () => {
    setVerifying(true);
    setAuditStatus({ valid: true, detail: "Verifying…" });
    try {
      const res = await api.verifyAuditChain();
      setAuditStatus(
        res.valid
          ? { valid: true, detail: `${res.entries_checked} entries verified` }
          : { valid: false, detail: `Tamper at seq ${res.broken_at_seq}` }
      );
    } catch (e: any) {
      setAuditStatus({ valid: false, detail: e.message });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {demoMode && (
        <div style={{
          background: "#fef3c7", color: "#78350f",
          borderBottom: "1px solid #fcd34d",
          padding: "8px 24px", fontSize: "12px",
          display: "flex", alignItems: "center", justifyContent: "center", gap: "10px",
          flexShrink: 0, fontWeight: 500,
        }}>
          <span style={{ fontSize: "14px" }}>⚠️</span>
          <span>
            <strong>DEMO MODE</strong> — <code>GROQ_API_KEY</code> not configured on this deployment.
            Every agent returns deterministic mock output; no real LLM calls are made.
            Add the key to see live model reasoning.
          </span>
        </div>
      )}
      {/* Top Nav */}
      <header style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "0 24px",
        height: "56px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          {/* Logo mark */}
          <div style={{
            width: "32px", height: "32px", borderRadius: "8px",
            background: "linear-gradient(135deg, #f59e0b, #d97706)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 700, fontSize: "14px", color: "#000", fontFamily: "JetBrains Mono, monospace",
            flexShrink: 0,
          }}>HM</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "15px", letterSpacing: "-0.01em", color: "var(--text)" }}>
              Harshad Mehta <span style={{ color: "var(--accent)" }}>AI</span>
            </div>
            <div style={{ fontSize: "11px", color: "var(--muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Fraud Investigation Platform
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* Live indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px",
            padding: "4px 10px", borderRadius: "20px",
            background: "#d1fae5", border: "1px solid #a7f3d0",
          }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981" }} />
            <span style={{ fontSize: "11px", color: "#065f46", fontWeight: 500 }}>LIVE</span>
          </div>

          <div style={{ width: "1px", height: "20px", background: "var(--border)" }} />

          {auditStatus && (
            <span style={{
              fontSize: "12px",
              color: auditStatus.valid ? "var(--success)" : "var(--danger)",
              display: "flex", alignItems: "center", gap: "4px",
            }}>
              {auditStatus.valid ? "✓" : "✗"} {auditStatus.detail}
            </span>
          )}

          <button
            onClick={runVerify}
            disabled={verifying}
            style={{
              fontSize: "12px", padding: "6px 14px",
              border: "1px solid var(--border)", borderRadius: "6px",
              background: "var(--surface-2)", color: "var(--muted)", cursor: "pointer",
              transition: "all 0.15s", fontWeight: 500,
              opacity: verifying ? 0.5 : 1,
            }}
            onMouseEnter={e => { (e.currentTarget.style.borderColor = "var(--accent)"); (e.currentTarget.style.color = "var(--text)"); }}
            onMouseLeave={e => { (e.currentTarget.style.borderColor = "var(--border)"); (e.currentTarget.style.color = "var(--muted)"); }}
          >
            {verifying ? "Verifying…" : "Verify Audit Chain"}
          </button>

          <button
            onClick={toggleTheme}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            style={{
              width: "34px", height: "34px", borderRadius: "8px",
              border: "1px solid var(--border)", background: "var(--surface-2)",
              cursor: "pointer", fontSize: "16px", display: "flex",
              alignItems: "center", justifyContent: "center",
              transition: "all 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--accent)")}
            onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
          >
            {isDark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Sidebar */}
        <aside style={{
          width: "360px", flexShrink: 0,
          borderRight: "1px solid var(--border)",
          background: "var(--surface-2)",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* New Alert section */}
          <div style={{ padding: "16px", borderBottom: "1px solid var(--border-dim)", flexShrink: 0 }}>
            <NewAlertForm onSubmitted={(caseId) => { refresh(); setSelectedCaseId(caseId); }} />
          </div>

          {/* Case list header */}
          <div style={{
            padding: "10px 16px 8px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
              Active Cases
            </span>
            <span style={{
              fontSize: "11px", fontWeight: 600,
              background: "var(--surface-3)", color: "var(--accent)",
              padding: "2px 8px", borderRadius: "10px",
            }}>
              {cases.length}
            </span>
          </div>

          {/* Cases */}
          <div ref={sidebarRef} style={{ flex: 1, overflowY: "auto" }}>
            <CaseList cases={cases} onSelect={setSelectedCaseId} selectedCaseId={selectedCaseId} />
          </div>
        </aside>

        {/* Main content */}
        <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {selectedCaseId ? (
            <CaseDetail caseId={selectedCaseId} onResolved={() => {
              refresh();
              setSelectedCaseId(null);
              sidebarRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            }} />
          ) : (
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: "16px", padding: "40px",
            }}>
              <div style={{
                width: "64px", height: "64px", borderRadius: "16px",
                background: "var(--surface-2)", border: "1px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "28px",
              }}>🔍</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "15px", fontWeight: 500, color: "var(--text)", marginBottom: "6px" }}>
                  No case selected
                </div>
                <div style={{ fontSize: "13px", color: "var(--muted)", maxWidth: "320px" }}>
                  Pick a case from the list or submit a new flagged transaction alert to start an AI investigation.
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

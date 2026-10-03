"use client";
import React, { useEffect, useState } from "react";
import { CaseDetail as CaseDetailType, api } from "../api-client";
import StatusBadge from "./StatusBadge";

function riskLabel(p: number) {
  if (p >= 75) return { label: "CRITICAL", color: "#ef4444", bg: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.3)" };
  if (p >= 50) return { label: "HIGH", color: "#f97316", bg: "rgba(249,115,22,0.1)", border: "rgba(249,115,22,0.3)" };
  if (p >= 25) return { label: "MEDIUM", color: "#f59e0b", bg: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.3)" };
  return { label: "LOW", color: "#10b981", bg: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.3)" };
}

const ACTION_COLORS: Record<string, { color: string; bg: string }> = {
  ESCALATE_SAR: { color: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  CONFIRM_FRAUD: { color: "#f97316", bg: "rgba(249,115,22,0.08)" },
  MANUAL_REVIEW: { color: "#f59e0b", bg: "rgba(245,158,11,0.08)" },
  CLEAR_FALSE_POSITIVE: { color: "#10b981", bg: "rgba(16,185,129,0.08)" },
};

export default function CaseDetail({ caseId, onResolved }: { caseId: string; onResolved: () => void }) {
  const [detail, setDetail] = useState<CaseDetailType | null>(null);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    api.getCase(caseId).then(setDetail).catch(() => setDetail(null));
  };

  useEffect(() => {
    setNotes("");
    setDetail(null);
    load();
    let interval: ReturnType<typeof setInterval> | null = null;
    // Poll only while a report is still being built AND the tab is visible.
    // Stops once the case has a report or the analyst resolves it; resumes
    // when the tab is refocused. Prevents idle tabs from burning serverless
    // invocations + Postgres queries indefinitely.
    const tick = () => {
      setDetail((d) => {
        const done = d && (d.report_json || d.analyst_verdict);
        if (done || document.hidden) {
          if (interval) { clearInterval(interval); interval = null; }
        }
        return d;
      });
      load();
    };
    interval = setInterval(tick, 3000);
    const onVis = () => {
      if (document.hidden) {
        if (interval) { clearInterval(interval); interval = null; }
      } else if (!interval) {
        interval = setInterval(tick, 3000);
        load();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (interval) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const submitVerdict = async (verdict: string) => {
    setSubmitting(true);
    try {
      await api.submitVerdict(caseId, {
        verdict, notes,
        fraud_type: detail?.report_json?.recommended_action === "ESCALATE_SAR" ? "MULE_ACCOUNT" : undefined,
      });
      load(); // reload this case to get analyst_verdict set → shows completion screen
    } finally {
      setSubmitting(false);
    }
  };

  if (!detail) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: "10px", color: "var(--muted)", fontSize: "13px",
        }}>
          <span style={{
            display: "inline-block", width: "16px", height: "16px",
            border: "2px solid var(--border)", borderTopColor: "var(--accent)",
            borderRadius: "50%", animation: "spin 0.7s linear infinite",
          }} />
          Loading investigation…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const report = detail.report_json;
  const canDecide = detail.status === "PENDING_REVIEW";
  const risk = report ? riskLabel(report.fraud_probability) : null;
  const actionStyle = report ? (ACTION_COLORS[report.recommended_action] || { color: "var(--muted-2)", bg: "transparent" }) : null;
  const isFraud = detail.analyst_verdict === "CONFIRMED_FRAUD";
  const isResolved = !!detail.analyst_verdict;

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
      {/* Case header */}
      <div style={{
        padding: "20px 24px 16px",
        borderBottom: "1px solid var(--border-dim)",
        background: "var(--surface)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{
              fontFamily: "JetBrains Mono, monospace", fontSize: "13px",
              color: "var(--accent)", fontWeight: 500,
            }}>{detail.case_id}</span>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>·</span>
            <span style={{ fontSize: "12px", color: "var(--muted-2)" }}>{detail.customer_id}</span>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>·</span>
            <span style={{ fontSize: "12px", color: "var(--muted-2)" }}>{detail.account_id}</span>
          </div>
          <StatusBadge status={detail.status} />
        </div>

        {/* Agent pipeline indicator */}
        <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
          {["KYC Retriever", "Txn Analyzer", "Case Search", "Report Generator"].map((agent, i) => (
            <React.Fragment key={agent}>
              <div style={{
                display: "flex", alignItems: "center", gap: "5px",
                padding: "4px 10px", borderRadius: "4px",
                background: report ? "rgba(16,185,129,0.1)" : (i === 0 && !report) ? "rgba(245,158,11,0.15)" : "var(--surface-2)",
                border: `1px solid ${report ? "rgba(16,185,129,0.2)" : (i === 0 && !report) ? "rgba(245,158,11,0.3)" : "var(--border-dim)"}`,
              }}>
                <span style={{ fontSize: "9px", color: report ? "var(--success)" : i === 0 ? "var(--accent)" : "var(--muted)" }}>
                  {report ? "✓" : i === 0 ? "◉" : "○"}
                </span>
                <span style={{ fontSize: "10px", color: report ? "var(--success)" : "var(--muted)", whiteSpace: "nowrap" }}>
                  {agent}
                </span>
              </div>
              {i < 3 && (
                <div style={{ width: "16px", height: "1px", background: report ? "var(--success)" : "var(--border)", flexShrink: 0 }} />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>

        {!report && (
          <div style={{
            padding: "16px", borderRadius: "10px",
            border: "1px solid rgba(245,158,11,0.3)",
            background: "rgba(245,158,11,0.06)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <span style={{
                display: "inline-block", width: "14px", height: "14px",
                border: "2px solid var(--accent)", borderTopColor: "transparent",
                borderRadius: "50%", animation: "spin 0.7s linear infinite", flexShrink: 0,
              }} />
              <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--accent)" }}>
                Investigation in progress
              </span>
            </div>
            <p style={{ fontSize: "12px", color: "var(--muted-2)", lineHeight: "1.6", margin: 0 }}>
              4 AI agents are running concurrently — KYC Retrieval, Transaction Analysis, Fraud Case Search, and
              Report Generation. This panel refreshes every 3 seconds.
            </p>
          </div>
        )}

        {report && (
          <>
            {/* Top metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
              {/* Fraud probability — the hero metric */}
              <div style={{
                padding: "16px", borderRadius: "10px",
                border: `1px solid ${risk!.border}`,
                background: risk!.bg,
                gridColumn: "1",
              }}>
                <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Fraud Probability
                </div>
                <div style={{
                  fontSize: "40px", fontWeight: 700, lineHeight: 1,
                  color: risk!.color, fontFamily: "JetBrains Mono, monospace",
                  marginBottom: "4px",
                }}>
                  {report.fraud_probability}<span style={{ fontSize: "18px" }}>%</span>
                </div>
                {/* Bar */}
                <div style={{ height: "4px", background: "var(--surface-3)", borderRadius: "2px", marginTop: "8px", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${report.fraud_probability}%`,
                    background: risk!.color, borderRadius: "2px",
                  }} />
                </div>
                <div style={{
                  marginTop: "6px", fontSize: "10px", fontWeight: 700,
                  letterSpacing: "0.1em", color: risk!.color,
                }}>{risk!.label} RISK</div>
              </div>

              {/* Recommended action */}
              <div style={{
                padding: "16px", borderRadius: "10px",
                border: "1px solid var(--border-dim)",
                background: actionStyle!.bg,
                display: "flex", flexDirection: "column",
              }}>
                <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Recommended Action
                </div>
                <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
                  <div style={{
                    fontSize: "13px", fontWeight: 600, color: actionStyle!.color,
                    lineHeight: "1.3",
                  }}>
                    {report.recommended_action.replace(/_/g, " ")}
                  </div>
                </div>
              </div>

              {/* Confidence */}
              <div style={{
                padding: "16px", borderRadius: "10px",
                border: "1px solid var(--border-dim)", background: "var(--surface-2)",
              }}>
                <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  AI Confidence
                </div>
                <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--text)", fontFamily: "JetBrains Mono, monospace" }}>
                  {report.confidence}
                </div>
                <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>
                  {detail.account_id}
                </div>
              </div>
            </div>

            {/* Narrative */}
            <div style={{
              padding: "16px", borderRadius: "10px",
              border: "1px solid var(--border-dim)", background: "var(--surface-2)",
            }}>
              <div style={{
                fontSize: "11px", color: "var(--muted)", marginBottom: "10px",
                textTransform: "uppercase", letterSpacing: "0.06em",
                display: "flex", alignItems: "center", gap: "6px",
              }}>
                <span style={{
                  display: "inline-block", width: "6px", height: "6px",
                  borderRadius: "50%", background: "var(--accent)",
                }} />
                AI Investigation Narrative
              </div>
              <div style={{ fontSize: "13px", color: "var(--text)", lineHeight: "1.7" }}>
                {report.narrative.split("\n").map((line: string, i: number) =>
                  line.startsWith("•") ? (
                    <div key={i} style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                      <span style={{ color: "var(--accent)", flexShrink: 0 }}>•</span>
                      <span>{line.slice(1).trim()}</span>
                    </div>
                  ) : (
                    <p key={i} style={{ margin: i === 0 ? 0 : "8px 0 0" }}>{line}</p>
                  )
                )}
              </div>
            </div>

            {/* Evidence */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{
                  fontSize: "11px", color: "var(--muted)",
                  textTransform: "uppercase", letterSpacing: "0.06em",
                  display: "flex", alignItems: "center", gap: "6px",
                }}>
                  <span style={{
                    display: "inline-block", width: "6px", height: "6px",
                    borderRadius: "50%", background: "var(--info)",
                  }} />
                  Evidence Citations ({report.evidence_citations.length})
                </div>
              </div>

              <div
                style={{
                  maxHeight: "200px", overflowY: "auto",
                  borderRadius: "10px", border: "1px solid var(--border-dim)",
                  background: "var(--surface-2)",
                }}
              >
                {report.evidence_citations.map((e: any, i: number) => {
                  const id = typeof e === "string" ? e : (e.evidence_id ?? e.id ?? JSON.stringify(e));
                  const src = typeof e === "object" ? e.source : null;
                  const det = typeof e === "object" ? e.detail : null;
                  return (
                    <div key={i} style={{
                      padding: "10px 14px",
                      borderBottom: i < report.evidence_citations.length - 1 ? "1px solid var(--border-dim)" : "none",
                      display: "flex", alignItems: "flex-start", gap: "10px",
                    }}>
                      <span style={{
                        fontFamily: "JetBrains Mono, monospace", fontSize: "11px",
                        color: "var(--info)", flexShrink: 0, paddingTop: "1px",
                        minWidth: "120px",
                      }}>{id}</span>
                      <div style={{ flex: 1 }}>
                        {src && <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "2px" }}>{src}</div>}
                        {det && <div style={{ fontSize: "12px", color: "var(--text)" }}>{det}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Verdict / Completion */}
            {isResolved ? (
              <div style={{
                padding: "24px", borderRadius: "12px",
                border: `1px solid ${isFraud ? "rgba(239,68,68,0.3)" : "rgba(16,185,129,0.3)"}`,
                background: isFraud ? "rgba(239,68,68,0.06)" : "rgba(16,185,129,0.06)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: "16px", textAlign: "center",
              }}>
                <div style={{
                  width: "56px", height: "56px", borderRadius: "50%",
                  background: isFraud ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)",
                  border: `2px solid ${isFraud ? "#ef4444" : "#10b981"}`,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px",
                }}>
                  {isFraud ? "🚨" : "✅"}
                </div>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 700, color: isFraud ? "#ef4444" : "#10b981", marginBottom: "4px" }}>
                    {isFraud ? "Confirmed Fraud" : "Cleared — False Positive"}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                    {detail.case_id} · {detail.customer_id} · Risk score {report?.fraud_probability}%
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", width: "100%" }}>
                  {[
                    { label: "Audit Logged", icon: "🔒", desc: "Hash-chained entry added" },
                    { label: "Qdrant Updated", icon: "🧠", desc: "Case written to memory" },
                    { label: "AI Trained", icon: "⚡", desc: "Used for future searches" },
                  ].map((item) => (
                    <div key={item.label} style={{
                      padding: "10px 8px", borderRadius: "8px",
                      background: "var(--surface)", border: "1px solid var(--border)",
                    }}>
                      <div style={{ fontSize: "18px", marginBottom: "4px" }}>{item.icon}</div>
                      <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text)", marginBottom: "2px" }}>{item.label}</div>
                      <div style={{ fontSize: "10px", color: "var(--muted)" }}>{item.desc}</div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={onResolved}
                  style={{
                    padding: "10px 24px", borderRadius: "8px",
                    border: "1px solid var(--border)", background: "var(--surface)",
                    color: "var(--text)", fontWeight: 600, fontSize: "13px",
                    cursor: "pointer", transition: "all 0.15s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--accent)")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--border)")}
                >
                  ← Back to Cases
                </button>
              </div>
            ) : (
              <div style={{
                padding: "16px", borderRadius: "10px",
                border: "1px solid var(--border-dim)", background: "var(--surface-2)",
                display: "flex", flexDirection: "column", gap: "12px",
              }}>
                <div style={{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Analyst Decision
                </div>
                <textarea
                  style={{
                    width: "100%", boxSizing: "border-box",
                    background: "var(--surface)", border: "1px solid var(--border-dim)",
                    borderRadius: "8px", padding: "10px 12px",
                    fontSize: "13px", color: "var(--text)", resize: "none",
                    fontFamily: "Inter, sans-serif", lineHeight: "1.5",
                  }}
                  rows={2}
                  placeholder="Analyst notes (optional)…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={!canDecide}
                />
                <div style={{ display: "flex", gap: "10px" }}>
                  <button
                    disabled={!canDecide || submitting}
                    onClick={() => submitVerdict("CONFIRMED_FRAUD")}
                    style={{
                      flex: 1, padding: "11px", borderRadius: "8px",
                      border: "1px solid rgba(239,68,68,0.35)",
                      background: canDecide ? "rgba(239,68,68,0.12)" : "var(--surface-2)",
                      color: canDecide ? "#ef4444" : "var(--muted)",
                      fontWeight: 600, fontSize: "13px",
                      cursor: canDecide ? "pointer" : "not-allowed", transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { if (canDecide) (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.22)"; }}
                    onMouseLeave={e => { if (canDecide) (e.currentTarget as HTMLElement).style.background = "rgba(239,68,68,0.12)"; }}
                  >
                    {submitting ? "Processing…" : "✕ Confirm Fraud"}
                  </button>
                  <button
                    disabled={!canDecide || submitting}
                    onClick={() => submitVerdict("FALSE_POSITIVE")}
                    style={{
                      flex: 1, padding: "11px", borderRadius: "8px",
                      border: "1px solid rgba(16,185,129,0.35)",
                      background: canDecide ? "rgba(16,185,129,0.12)" : "var(--surface-2)",
                      color: canDecide ? "#10b981" : "var(--muted)",
                      fontWeight: 600, fontSize: "13px",
                      cursor: canDecide ? "pointer" : "not-allowed", transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { if (canDecide) (e.currentTarget as HTMLElement).style.background = "rgba(16,185,129,0.22)"; }}
                    onMouseLeave={e => { if (canDecide) (e.currentTarget as HTMLElement).style.background = "rgba(16,185,129,0.12)"; }}
                  >
                    {submitting ? "Processing…" : "✓ False Positive"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

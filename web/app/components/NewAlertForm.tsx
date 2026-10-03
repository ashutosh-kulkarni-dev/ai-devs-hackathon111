"use client";
import React, { useState } from "react";
import { api } from "../api-client";

const DEMO_CUSTOMERS = [
  {
    customer_id: "CUST-1000", account_id: "ACC-5000", flagged_transaction_id: "TXN-000451",
    narrative: "High-value wire to an offshore holding entity in a high-risk geography, first occurrence in this account's 12-month history.",
    tag: "Offshore Wire", tagColor: "#ef4444",
  },
  {
    customer_id: "CUST-1004", account_id: "ACC-5004", flagged_transaction_id: "TXN-000452",
    narrative: "Three transfers just under the $10,000 reporting threshold within 48 hours, consistent with structuring to evade CTR filing.",
    tag: "Structuring", tagColor: "#f97316",
  },
  {
    customer_id: "CUST-1009", account_id: "ACC-5009", flagged_transaction_id: "TXN-000453",
    narrative: "Sudden high-value P2P transfer to a brand-new, unknown payee, deviating sharply from established spending pattern.",
    tag: "Unknown Payee", tagColor: "#f59e0b",
  },
  {
    customer_id: "CUST-1005", account_id: "ACC-5005", flagged_transaction_id: "TXN-000461",
    narrative: "Login from unrecognized device in a foreign country followed immediately by a $47,000 outbound wire. Customer has never transacted internationally before.",
    tag: "Account Takeover", tagColor: "#dc2626",
  },
  {
    customer_id: "CUST-1006", account_id: "ACC-5006", flagged_transaction_id: "TXN-000468",
    narrative: "Account received 14 inbound transfers from 9 different senders totalling $82,000 over 3 days, then forwarded the full balance to a single beneficiary within hours — classic money mule behavior.",
    tag: "Money Mule", tagColor: "#7c3aed",
  },
  {
    customer_id: "CUST-1008", account_id: "ACC-5008", flagged_transaction_id: "TXN-000489",
    narrative: "Finance team wired $138,000 to a vendor bank account added 48 hours prior following a spoofed CEO email requesting urgent payment. The beneficiary account was opened 6 days ago.",
    tag: "BEC Fraud", tagColor: "#be123c",
  },
  {
    customer_id: "CUST-1010", account_id: "ACC-5010", flagged_transaction_id: "TXN-000501",
    narrative: "Elderly customer (82) made seven ATM cash withdrawals totalling $34,000 over 10 days following contact with an individual claiming to be a lottery official demanding taxes be paid upfront.",
    tag: "Elder Fraud", tagColor: "#b45309",
  },
];

export default function NewAlertForm({ onSubmitted }: { onSubmitted: (caseId: string) => void }) {
  const [selected, setSelected] = useState(DEMO_CUSTOMERS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.submitAlert(selected);
      onSubmitted(res.case_id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <div style={{ width: "8px", height: "8px", borderRadius: "2px", background: "var(--accent)", flexShrink: 0 }} />
        <span style={{ fontSize: "12px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted-2)" }}>
          New Alert
        </span>
      </div>

      {/* Scenario selector — scrollable */}
      <div style={{ display: "flex", flexDirection: "column", gap: "5px", maxHeight: "240px", overflowY: "auto", paddingRight: "2px" }}>
        {DEMO_CUSTOMERS.map((d) => {
          const active = selected.customer_id === d.customer_id;
          return (
            <button
              key={d.customer_id}
              onClick={() => setSelected(d)}
              style={{
                padding: "8px 10px",
                borderRadius: "8px",
                border: `1px solid ${active ? d.tagColor + "80" : "var(--border-dim)"}`,
                background: active ? d.tagColor + "12" : "var(--surface-2)",
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.12s",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "3px" }}>
                <span style={{ fontSize: "10px", fontFamily: "JetBrains Mono, monospace", color: "var(--muted-2)" }}>
                  {d.customer_id}
                </span>
                <span style={{
                  fontSize: "9px", padding: "1px 6px", borderRadius: "4px",
                  background: d.tagColor + "20", color: d.tagColor,
                  fontWeight: 600, border: `1px solid ${d.tagColor}40`,
                }}>{d.tag}</span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--muted)", lineHeight: "1.4" }}>
                {d.narrative.slice(0, 68)}…
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected preview */}
      <div style={{
        padding: "8px 10px", borderRadius: "8px",
        background: "var(--surface-2)", border: "1px solid var(--border-dim)",
        fontSize: "11px", color: "var(--muted-2)", lineHeight: "1.5",
      }}>
        <span style={{ color: selected.tagColor, fontWeight: 600 }}>{selected.tag}: </span>
        {selected.narrative}
      </div>

      {error && (
        <div style={{ fontSize: "12px", color: "var(--danger)", padding: "8px 12px", background: "rgba(239,68,68,0.1)", borderRadius: "6px", border: "1px solid rgba(239,68,68,0.3)" }}>
          {error}
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting}
        style={{
          width: "100%", padding: "10px",
          borderRadius: "8px", border: "none",
          background: submitting ? "var(--surface-3)" : "var(--accent)",
          color: submitting ? "var(--muted)" : "#000",
          fontWeight: 600, fontSize: "13px", cursor: submitting ? "not-allowed" : "pointer",
          transition: "all 0.15s",
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
        }}
      >
        {submitting ? (
          <>
            <span style={{
              display: "inline-block", width: "12px", height: "12px",
              border: "2px solid var(--muted)", borderTopColor: "transparent",
              borderRadius: "50%", animation: "spin 0.7s linear infinite",
            }} />
            Running 4 AI agents…
          </>
        ) : (
          "▶ Start Investigation"
        )}
      </button>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

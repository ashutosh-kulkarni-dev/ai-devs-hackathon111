"use client";

// Same-origin fetches are authorized by lib/auth.ts via the Origin header;
// no API key is shipped in the browser bundle. External callers (curl, etc.)
// present X-API-Key: $API_GATEWAY_KEY against the server.
async function request(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

export interface CaseSummary {
  case_id: string;
  customer_id: string;
  account_id: string;
  status: string;
  fraud_probability: number | null;
  analyst_verdict: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface EvidenceRef {
  evidence_id: string;
  source: string;
  detail: string;
}

export interface InvestigationReport {
  case_id: string;
  fraud_probability: number;
  recommended_action: string;
  narrative: string;
  evidence_citations: EvidenceRef[];
  confidence: string;
}

export interface CaseDetail extends CaseSummary {
  report_json: InvestigationReport | null;
  analyst_notes: string | null;
}

export const api = {
  listCases: (): Promise<{ cases: CaseSummary[] }> => request("/api/cases"),
  getCase: (caseId: string): Promise<CaseDetail> => request(`/api/cases/${caseId}`),
  verifyAuditChain: () => request("/api/audit/verify"),
  submitAlert: (payload: {
    customer_id: string;
    account_id: string;
    flagged_transaction_id?: string;
    narrative?: string;
    metadata_filter?: Record<string, string>;
  }) => request("/api/alerts", { method: "POST", body: JSON.stringify(payload) }),
  submitVerdict: (
    caseId: string,
    payload: { verdict: string; notes: string; fraud_type?: string; channel?: string; geography?: string }
  ) => request(`/api/cases/${caseId}/verdict`, { method: "POST", body: JSON.stringify(payload) }),
};

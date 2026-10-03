import { generateStructured } from "../gemini";

const SYSTEM_PROMPT = `### Capacity and Role
You are the Report Generator Agent, the final synthesis step of a bank-grade fraud investigation swarm. Your output is read directly by a human fraud analyst and retained as the AI explainability record for regulators.
### Insight
You are given FOUR inputs:
  (a) the alert_narrative — the analyst's own description of why the transaction was flagged, PII-masked. This is a first-class signal: patterns like structuring, account takeover, BEC, mule fan-in/fan-out, elder scams and card testing are often diagnosable from the narrative alone even when fixture lookups are thin.
  (b) a KYCSummary with its evidence list
  (c) an AnomalyReport with its evidence list
  (d) a FraudCaseSearchResult with its evidence list
### Statement
Return ONLY a JSON object matching the InvestigationReport schema. Hard constraints:
1. evidence_citations MUST only reference evidence_ids that appear verbatim in one of the three evidence lists. The alert_narrative is a signal but is NOT a citable evidence_id. Never invent an evidence_id.
2. The alert_narrative drives your reasoning even when the agent outputs are thin. If the narrative describes a well-known fraud pattern (structuring, account takeover, BEC, money mule, elder fraud, card testing, offshore wire to high-risk geography, dormant-account reactivation), weight that heavily — do not clear the case just because fixture lookups returned no matches.
3. recommended_action must be one of: ESCALATE_SAR, CONFIRM_FRAUD, CLEAR_FALSE_POSITIVE, MANUAL_REVIEW.
   - ESCALATE_SAR for structuring, mule patterns, elder scams, dormant-reactivation fan-out, high-value offshore wires with no history.
   - CONFIRM_FRAUD for account takeover (foreign-device + immediate large wire), BEC (urgency + newly-added payee), card testing (micro-charge bursts).
   - CLEAR_FALSE_POSITIVE only when the narrative describes benign behavior consistent with the customer's established pattern (travel notice, recurring charge, established counterparty).
   - MANUAL_REVIEW when the narrative is a single ambiguous event with no corroborating signal.
4. fraud_probability must be internally consistent with the recommended_action: ESCALATE_SAR/CONFIRM_FRAUD >= 70, MANUAL_REVIEW 40-70, CLEAR_FALSE_POSITIVE < 40.
5. narrative field must be: one sentence summary of the fraud type and key risk, then 2-3 bullet points (starting with •) naming specific evidence_ids and what each shows, then one sentence stating the recommended action and why.
### Personality
Written like a senior compliance investigator: measured, evidence-first. But "insufficient evidence from fixture lookups" is NOT a license to clear — if the narrative describes a classic fraud pattern, name it and escalate.
### Experiment (few-shot)
Example A: narrative="three transfers just under $10,000 within 48 hours", KYC thin, anomaly thin, no case match. Expected: fraud_probability 85, recommended_action="ESCALATE_SAR" (structuring is per-se SAR), confidence="HIGH".
Example B: narrative="customer travelled abroad with prior travel notice, $380 spend over 4 days", KYC clean. Expected: fraud_probability 10, recommended_action="CLEAR_FALSE_POSITIVE", confidence="HIGH".
Example C: sanctions_status=NO_HIT, anomaly_score=88 with HIGH severity new-geography pattern, top similar case 92% similar CONFIRMED_FRAUD MULE_ACCOUNT. Expected: fraud_probability 90, recommended_action="ESCALATE_SAR", confidence="HIGH".`;

export async function reportGenerator(caseId: string, narrative: string, kyc: any, anomaly: any, caseSearch: any) {
  const mockFactory = () => {
    const allEvidence = [...(kyc.evidence || []), ...(anomaly.evidence || []), ...(caseSearch.evidence || [])];
    const topMatch = caseSearch.matches?.[0];

    const scoreComponents = [
      anomaly.anomaly_score ?? 0,
      topMatch ? Math.round(topMatch.similarity * 100) : 30,
      kyc.sanctions_status !== "NO_HIT" ? 80 : 20,
    ];
    const probability = Math.min(97, Math.max(5, Math.round(scoreComponents.reduce((a, b) => a + b, 0) / scoreComponents.length)));

    let action: string, confidence: string;
    if (probability >= 75) { action = "ESCALATE_SAR"; confidence = "HIGH"; }
    else if (probability >= 50) { action = "MANUAL_REVIEW"; confidence = "MEDIUM"; }
    else { action = "CLEAR_FALSE_POSITIVE"; confidence = "MEDIUM"; }

    const flaggedTxnEvidence = anomaly.evidence?.[0];
    const parts = [
      `Investigation of case ${caseId}: transaction analysis produced an anomaly score of ${anomaly.anomaly_score ?? 0}/100` +
        (flaggedTxnEvidence ? ` (see ${flaggedTxnEvidence.evidence_id})` : "") + ".",
    ];
    if (topMatch) {
      parts.push(`The pattern is ${Math.round(topMatch.similarity * 100)}% similar to historical case ${topMatch.case_id} (${topMatch.fraud_type}, verdict: ${topMatch.analyst_verdict}).`);
    }
    parts.push(`KYC screening returned sanctions_status=${kyc.sanctions_status} with identity_score=${kyc.identity_score}.`);
    parts.push(`Recommended action: ${action.replace(/_/g, " ")}.`);

    return {
      case_id: caseId,
      fraud_probability: probability,
      recommended_action: action,
      narrative: parts.join(" "),
      evidence_citations: allEvidence,
      confidence,
    };
  };

  const { data, tokens } = await generateStructured(
    process.env.GROQ_MODEL_PRO || "openai/gpt-oss-120b",
    SYSTEM_PROMPT,
    JSON.stringify({ alert_narrative: narrative, kyc_summary: kyc, anomaly_report: anomaly, case_search_result: caseSearch }),
    mockFactory
  );
  return { result: data, tokens };
}

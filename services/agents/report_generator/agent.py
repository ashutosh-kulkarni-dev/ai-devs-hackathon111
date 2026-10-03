"""
Report Generator Agent (Google ADK-style worker, Groq openai/gpt-oss-120b).

Subscribes to report-generator-tasks. This message arrives only after the
orchestrator has collected all three worker agents' results for a case
(see services/orchestrator). Synthesizes the final, schema-enforced
InvestigationReport -- the single highest-stakes output in the system,
since this is what the analyst reads and what gets logged as the
explainability record for regulators.

Every evidence_citation must reference an evidence_id that appeared in one
of the three upstream agent outputs; the prompt explicitly forbids
inventing new ones (see docs/prompts/report_generator.md for the full
CRISPE spec this implements).
"""
import json
import os
import sys

import psycopg2

sys.path.insert(0, "/app/common")
from audit import log_event  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from pubsub_client import publish_json, run_worker_loop  # noqa: E402
from schemas import InvestigationReport  # noqa: E402
from tracing import traced  # noqa: E402

DB_CONF = dict(
    host=os.environ.get("POSTGRES_HOST", "localhost"),
    port=int(os.environ.get("POSTGRES_PORT", 5432)),
    dbname=os.environ.get("POSTGRES_DB", "fraud_investigator"),
    user=os.environ.get("POSTGRES_USER", "fraud_admin"),
    password=os.environ.get("POSTGRES_PASSWORD", "changeme_local_dev"),
)

llm = LLMClient(model=os.environ.get("GROQ_MODEL_PRO", "openai/gpt-oss-120b"))

SYSTEM_PROMPT = """\
### Capacity and Role
You are the Report Generator Agent, the final synthesis step of a
bank-grade fraud investigation swarm. Your output is read directly by a
human fraud analyst and is retained as the AI explainability record for
bank regulators.

### Insight
You are given three structured findings: a KYCSummary, an AnomalyReport,
and a FraudCaseSearchResult, each with its own `evidence` list.

### Statement
Return ONLY a JSON object matching the InvestigationReport schema.
Hard constraints:
1. `evidence_citations` MUST only reference evidence_ids that appear
   verbatim in one of the three input evidence lists. Never invent one.
2. `fraud_probability` must be internally consistent with the cited
   evidence -- do not assign a high probability without HIGH-severity or
   HIGH-similarity evidence to support it.
3. `recommended_action` must be one of: ESCALATE_SAR, CONFIRM_FRAUD,
   CLEAR_FALSE_POSITIVE, MANUAL_REVIEW.
4. `narrative` must be a plain-language paragraph an analyst can read in
   under 60 seconds, explicitly referencing evidence_ids inline, e.g.
   "...consistent with a mule account pattern (see TXN-000231, CASE-812)."

### Personality
Written like a senior compliance investigator: measured, evidence-first,
willing to say "insufficient evidence" rather than overstate confidence.

### Experiment (few-shot)
Example: sanctions_status=NO_HIT, anomaly_score=88 with a HIGH severity
new-geography pattern, top similar case 92% similar CONFIRMED_FRAUD
MULE_ACCOUNT. Expected: fraud_probability in 80-95 range,
recommended_action="ESCALATE_SAR", confidence="HIGH", narrative citing the
flagged transaction_id and the CASE-xxx precedent.
"""


def _mock_report(case_id: str, kyc: dict, anomaly: dict, case_search: dict) -> dict:
    all_evidence = kyc["evidence"] + anomaly["evidence"] + case_search["evidence"]
    top_match = case_search["matches"][0] if case_search["matches"] else None

    score_components = [
        anomaly["anomaly_score"],
        int(top_match["similarity"] * 100) if top_match else 30,
        80 if kyc["sanctions_status"] != "NO_HIT" else 20,
    ]
    probability = min(97, max(5, sum(score_components) // len(score_components)))

    if probability >= 75:
        action, confidence = "ESCALATE_SAR", "HIGH"
    elif probability >= 50:
        action, confidence = "MANUAL_REVIEW", "MEDIUM"
    else:
        action, confidence = "CLEAR_FALSE_POSITIVE", "MEDIUM"

    flagged_txn_evidence = next((e for e in anomaly["evidence"]), None)
    narrative_parts = [
        f"Investigation of case {case_id}: transaction analysis produced an anomaly score of "
        f"{anomaly['anomaly_score']}/100"
        + (f" (see {flagged_txn_evidence['evidence_id']})" if flagged_txn_evidence else "") + "."
    ]
    if top_match:
        narrative_parts.append(
            f"The pattern is {int(top_match['similarity']*100)}% similar to historical case "
            f"{top_match['case_id']} ({top_match['fraud_type']}, verdict: {top_match['analyst_verdict']})."
        )
    narrative_parts.append(
        f"KYC screening returned sanctions_status={kyc['sanctions_status']} with identity_score={kyc['identity_score']}."
    )
    narrative_parts.append(f"Recommended action: {action.replace('_', ' ').title()}.")

    return {
        "case_id": case_id,
        "fraud_probability": probability,
        "recommended_action": action,
        "narrative": " ".join(narrative_parts),
        "evidence_citations": all_evidence,
        "confidence": confidence,
    }


TERMINAL_STATUSES = ("CONFIRMED_FRAUD", "FALSE_POSITIVE")


def _persist_case(case_id: str, customer_id: str, account_id: str, report: dict):
    """Insert or update the case with this report.

    Guarded so a reprocessed report-generator task (now possible under
    Phase 1 retries/redelivery) can never regress an already-resolved case
    back to PENDING_REVIEW and silently discard an analyst's verdict: the
    UPDATE branch only fires when the existing row is not already in a
    terminal state. Reprocessing a resolved case becomes a no-op.
    """
    conn = psycopg2.connect(**DB_CONF)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO investigation_cases (case_id, customer_id, account_id, status, fraud_probability, report_json)
                VALUES (%s, %s, %s, 'PENDING_REVIEW', %s, %s)
                ON CONFLICT (case_id) DO UPDATE
                SET status = 'PENDING_REVIEW', fraud_probability = EXCLUDED.fraud_probability,
                    report_json = EXCLUDED.report_json
                WHERE investigation_cases.status NOT IN %s
                """,
                (case_id, customer_id, account_id, report["fraud_probability"], json.dumps(report),
                 TERMINAL_STATUSES),
            )
        conn.commit()
    finally:
        conn.close()


@traced("report_generator.process_case")
def process_task(message: dict, correlation_id: str = None):
    case_id = message["case_id"]
    correlation_id = message.get("correlation_id", case_id)
    kyc = message["kyc_summary"]
    anomaly = message["anomaly_report"]
    case_search = message["case_search_result"]

    report, tokens = llm.generate_structured(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=json.dumps({"kyc_summary": kyc, "anomaly_report": anomaly, "case_search_result": case_search}),
        output_schema=InvestigationReport,
        mock_factory=lambda: _mock_report(case_id, kyc, anomaly, case_search),
    )

    _persist_case(case_id, message.get("customer_id", "unknown"), message.get("account_id", "unknown"), report.model_dump())

    log_event(correlation_id, "report_generator_agent", "AGENT_CALL", {
        "case_id": case_id, "output": report.model_dump(), "token_usage": tokens,
    })
    log_event(correlation_id, "report_generator_agent", "REPORT_FINALIZED", {
        "case_id": case_id, "fraud_probability": report.fraud_probability,
        "recommended_action": report.recommended_action,
    })

    publish_json("report-generator-results", {
        "case_id": case_id, "correlation_id": correlation_id,
        "result": report.model_dump(),
    })
    return {"_otel_tokens": tokens}


def handler(message: dict):
    process_task(message, correlation_id=message.get("correlation_id", message.get("case_id")))


if __name__ == "__main__":
    run_worker_loop("report-generator-tasks", handler)

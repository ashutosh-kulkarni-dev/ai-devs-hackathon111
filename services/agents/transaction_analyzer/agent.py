"""
Transaction Analyzer Agent (Google ADK-style worker).

Subscribes to transaction-analyzer-tasks, pulls 12-month transaction history
for the account from Postgres (Cloud Spanner substitute), computes objective
behavioral statistics, then asks Groq (openai/gpt-oss-20b) to reason over
those statistics (never over raw free text) to produce a schema-enforced
AnomalyReport.
"""
import json
import os
import statistics
import sys

import psycopg2
import psycopg2.extras

sys.path.insert(0, "/app/common")
from audit import log_event  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from pubsub_client import publish_json, run_worker_loop  # noqa: E402
from schemas import AnomalyReport  # noqa: E402
from tracing import traced  # noqa: E402

DB_CONF = dict(
    host=os.environ.get("POSTGRES_HOST", "localhost"),
    port=int(os.environ.get("POSTGRES_PORT", 5432)),
    dbname=os.environ.get("POSTGRES_DB", "fraud_investigator"),
    user=os.environ.get("POSTGRES_USER", "fraud_admin"),
    password=os.environ.get("POSTGRES_PASSWORD", "changeme_local_dev"),
)

llm = LLMClient(model=os.environ.get("GROQ_MODEL_FLASH", "openai/gpt-oss-20b"))

SYSTEM_PROMPT = """\
### Capacity and Role
You are the Transaction Analyzer Agent. You reason over pre-computed
behavioral statistics for one account -- never over raw PII.

### Insight
Identify deviations from the account's own historical baseline: amount
z-score, new counterparty/geography/channel, rapid succession of
near-threshold transfers (structuring).

### Statement
Return ONLY a JSON object matching the AnomalyReport schema. Every pattern
must cite the specific transaction_id evidence that supports it.

### Personality
Quantitative, skeptical of coincidence, calibrated -- do not call something
HIGH severity unless it deviates sharply (>2 std dev, or a brand-new
high-risk geography/counterparty combination).

### Experiment (few-shot)
Example: flagged txn amount = 15x the account's median txn amount, to a
brand-new counterparty and geography never seen in the account's history.
Expected: anomaly_score high (>=80), pattern_type="AMOUNT_DEVIATION" and
"NEW_HIGH_RISK_COUNTERPARTY", severity HIGH, citing the flagged transaction_id.
"""


def _fetch_transactions(account_id: str):
    conn = psycopg2.connect(**DB_CONF)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM transactions WHERE account_id = %s ORDER BY transaction_ts ASC",
                (account_id,),
            )
            return cur.fetchall()
    finally:
        conn.close()


def _compute_stats(transactions: list[dict], flagged_txn_id: str | None):
    amounts = [float(t["amount"]) for t in transactions if not t["flagged"]]
    mean = statistics.mean(amounts) if amounts else 0
    stdev = statistics.pstdev(amounts) if len(amounts) > 1 else 1
    known_geos = {t["geography"] for t in transactions if not t["flagged"]}
    known_counterparties = {t["counterparty"] for t in transactions if not t["flagged"]}
    known_channels = {t["channel"] for t in transactions if not t["flagged"]}

    flagged = next((t for t in transactions if t["transaction_id"] == flagged_txn_id), None)
    if flagged is None:
        flagged = next((t for t in transactions if t["flagged"]), None)

    z_score = None
    if flagged and stdev > 0:
        z_score = (float(flagged["amount"]) - mean) / stdev

    return {
        "baseline_mean_amount": round(mean, 2),
        "baseline_stdev_amount": round(stdev, 2),
        "flagged_transaction": flagged,
        "z_score": round(z_score, 2) if z_score is not None else None,
        "is_new_geography": bool(flagged and flagged["geography"] not in known_geos),
        "is_new_counterparty": bool(flagged and flagged["counterparty"] not in known_counterparties),
        "is_new_channel": bool(flagged and flagged["channel"] not in known_channels),
        "total_historical_txns": len(transactions),
    }


def _mock_anomaly_report(account_id: str, stats: dict) -> dict:
    flagged = stats["flagged_transaction"]
    z = stats["z_score"] or 0
    severity = "HIGH" if abs(z) > 3 or stats["is_new_geography"] else ("MEDIUM" if abs(z) > 1.5 else "LOW")
    score = min(100, max(10, int(50 + z * 10)))

    patterns = []
    if flagged:
        patterns.append({
            "pattern_type": "AMOUNT_DEVIATION",
            "description": f"Transaction amount is {z:+.1f} std deviations from account baseline (mean=${stats['baseline_mean_amount']}).",
            "severity": severity,
        })
        if stats["is_new_geography"]:
            patterns.append({
                "pattern_type": "NEW_GEOGRAPHY",
                "description": f"Destination geography '{flagged['geography']}' never seen in this account's history.",
                "severity": "HIGH",
            })
        if stats["is_new_counterparty"]:
            patterns.append({
                "pattern_type": "NEW_COUNTERPARTY",
                "description": f"Counterparty '{flagged['counterparty']}' never seen in this account's history.",
                "severity": "MEDIUM",
            })

    evidence = [{"evidence_id": flagged["transaction_id"], "source": "Transaction History DB",
                 "detail": flagged.get("flag_reason") or "Flagged transaction under review"}] if flagged else []

    return {
        "account_id": account_id,
        "anomaly_score": score,
        "patterns": patterns or [{"pattern_type": "NONE", "description": "No significant deviation found.", "severity": "LOW"}],
        "evidence": evidence,
        "notes": f"Analyzed {stats['total_historical_txns']} historical transactions.",
    }


@traced("transaction_analyzer.process_case")
def process_task(message: dict, correlation_id: str = None):
    case_id = message["case_id"]
    account_id = message["account_id"]
    flagged_txn_id = message.get("flagged_transaction_id")
    correlation_id = message.get("correlation_id", case_id)

    transactions = _fetch_transactions(account_id)
    stats = _compute_stats(transactions, flagged_txn_id)

    report, tokens = llm.generate_structured(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=json.dumps(stats, default=str),
        output_schema=AnomalyReport,
        mock_factory=lambda: _mock_anomaly_report(account_id, stats),
    )

    log_event(correlation_id, "transaction_analyzer_agent", "AGENT_CALL", {
        "case_id": case_id, "output": report.model_dump(), "token_usage": tokens,
    })

    publish_json("transaction-analyzer-results", {
        "case_id": case_id, "correlation_id": correlation_id,
        "result": report.model_dump(),
    })
    return {"_otel_tokens": tokens}


def handler(message: dict):
    process_task(message, correlation_id=message.get("correlation_id", message.get("case_id")))


if __name__ == "__main__":
    run_worker_loop("transaction-analyzer-tasks", handler)

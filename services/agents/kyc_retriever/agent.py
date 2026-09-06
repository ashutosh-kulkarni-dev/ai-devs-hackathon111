"""
KYC Retriever Agent (Google ADK-style worker).

Subscribes to kyc-retriever-tasks, pulls the customer's KYC record + runs a
Sanctions/PEP screen, synthesizes a schema-enforced KYCSummary via Groq
(openai/gpt-oss-20b), publishes to kyc-retriever-results, and writes an
audit log entry.

Input record must already be PII-masked by the API Gateway before it
reaches this agent -- this worker never receives raw customer PII.
"""
import json
import os
import sys

import requests

sys.path.insert(0, "/app/common")
from audit import log_event  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from pubsub_client import publish_json, run_worker_loop  # noqa: E402
from schemas import KYCSummary  # noqa: E402
from tracing import traced  # noqa: E402

SANCTIONS_API_URL = os.environ.get("SANCTIONS_API_URL", "http://localhost:8010")
KYC_DOCS_PATH = "/app/fixtures/kyc_docs.json"

with open(KYC_DOCS_PATH) as f:
    KYC_DOCS = {d["customer_id"]: d for d in json.load(f)}

llm = LLMClient(model=os.environ.get("GROQ_MODEL_FLASH", "openai/gpt-oss-20b"))

SYSTEM_PROMPT = """\
### Capacity and Role
You are the KYC Retriever Agent inside a bank-grade fraud investigation system.
You never see raw PII -- all customer data has already been masked upstream.

### Insight
Given a masked KYC record and a sanctions/PEP screening result, determine
identity consistency and screening risk.

### Statement
Return ONLY a JSON object matching the KYCSummary schema. Cite every claim
with an evidence_id drawn from the KYC record ID or watchlist IDs provided.
Never invent an evidence_id that was not given to you.

### Personality
Precise, conservative, regulator-friendly. Prefer MEDIUM/HIGH risk ratings
when evidence is ambiguous rather than defaulting to LOW.

### Experiment (few-shot)
Example input: KYC record fully verified, no sanctions hits.
Example output: identity_score=95, kyc_risk_rating="LOW", sanctions_status="NO_HIT".
"""


def _mock_kyc_summary(customer_id: str, kyc_record: dict, screening: dict) -> dict:
    sanctions_status = screening["status"]
    matches = [m["watchlist_id"] for m in screening["matches"]]
    risk = kyc_record["kyc_risk_rating"]
    if sanctions_status == "HIT":
        risk = "HIGH"
    return {
        "customer_id": customer_id,
        "identity_score": 92 if sanctions_status == "NO_HIT" else 55,
        "kyc_risk_rating": risk,
        "sanctions_status": sanctions_status,
        "sanctions_matches": matches,
        "evidence": [
            {"evidence_id": f"KYC-{customer_id}", "source": "KYC Document Store",
             "detail": f"Document status: {kyc_record['document_status']}, ID type: {kyc_record['id_type']}"},
            *[{"evidence_id": wid, "source": "Sanctions & PEP API", "detail": f"Screening match: {sanctions_status}"}
              for wid in matches],
        ],
        "notes": f"Automated screen: {sanctions_status}. KYC risk rating from onboarding: {kyc_record['kyc_risk_rating']}.",
    }


@traced("kyc_retriever.process_case")
def process_task(message: dict, correlation_id: str = None):
    case_id = message["case_id"]
    customer_id = message["customer_id"]
    correlation_id = message.get("correlation_id", case_id)

    kyc_record = KYC_DOCS.get(customer_id)
    if kyc_record is None:
        raise ValueError(f"No KYC record for {customer_id}")

    screening = requests.post(
        f"{SANCTIONS_API_URL}/screen",
        json={"name": kyc_record["full_name"], "dob": kyc_record["dob"]},
        timeout=10,
    ).json()

    summary, tokens = llm.generate_structured(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=json.dumps({"kyc_record": kyc_record, "screening": screening}),
        output_schema=KYCSummary,
        mock_factory=lambda: _mock_kyc_summary(customer_id, kyc_record, screening),
    )

    log_event(correlation_id, "kyc_retriever_agent", "AGENT_CALL", {
        "case_id": case_id, "output": summary.model_dump(), "token_usage": tokens,
    })

    publish_json("kyc-retriever-results", {
        "case_id": case_id, "correlation_id": correlation_id,
        "result": summary.model_dump(),
    })
    return {"_otel_tokens": tokens}


def handler(message: dict):
    process_task(message, correlation_id=message.get("correlation_id", message.get("case_id")))


if __name__ == "__main__":
    run_worker_loop("kyc-retriever-tasks", handler)

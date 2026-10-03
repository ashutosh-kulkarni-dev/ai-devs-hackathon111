"""
Fraud Case Search Agent (Google ADK-style worker).

Subscribes to fraud-case-search-tasks, embeds the current case narrative,
runs a hybrid Qdrant search (vector similarity + metadata filters on
fraud_type/amount_bracket/channel/geography), and asks Groq
(openai/gpt-oss-20b) to summarize the matches into a schema-enforced
FraudCaseSearchResult.

This is the "Self-Improving Memory" retrieval half of the continuous
learning loop described in PRD section 6; the write-back half lives in
the Analyst Dashboard's feedback endpoint (see services/api_gateway).
"""
import json
import os
import sys

from qdrant_client import QdrantClient
from qdrant_client.models import FieldCondition, Filter, MatchValue

sys.path.insert(0, "/app/common")
from audit import log_event  # noqa: E402
from embeddings import embed  # noqa: E402
from llm_client import LLMClient  # noqa: E402
from pubsub_client import publish_json, run_worker_loop  # noqa: E402
from schemas import FraudCaseSearchResult  # noqa: E402
from tracing import traced  # noqa: E402

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "fraud_case_memory")

client = QdrantClient(url=QDRANT_URL)
llm = LLMClient(model=os.environ.get("GROQ_MODEL_FLASH", "openai/gpt-oss-20b"))

SYSTEM_PROMPT = """\
### Capacity and Role
You are the Fraud Case Search Agent. You are given the current case's
narrative plus a list of semantically/metadata-matched historical cases
retrieved from Qdrant.

### Insight
Summarize which historical cases are most relevant and why, and what their
resolved verdicts imply for the current investigation.

### Statement
Return ONLY a JSON object matching the FraudCaseSearchResult schema. Every
match must be one of the case_ids actually provided to you -- never invent one.

### Personality
Analytical librarian: precise about degree of similarity, honest when
matches are weak.

### Experiment (few-shot)
Example: 3 historical cases returned with similarity 0.92, 0.81, 0.60 for
fraud_type=MULE_ACCOUNT, all CONFIRMED_FRAUD. Expected: matches sorted by
similarity descending, notes mention the highest-similarity confirmed
precedent by case_id.
"""


def _search(narrative: str, metadata_filter: dict | None):
    vector = embed(narrative)
    qfilter = None
    if metadata_filter:
        conditions = [FieldCondition(key=k, match=MatchValue(value=v)) for k, v in metadata_filter.items() if v]
        if conditions:
            qfilter = Filter(must=conditions)

    hits = client.search(collection_name=COLLECTION, query_vector=vector, query_filter=qfilter, limit=5)
    return [
        {
            "case_id": h.payload["case_id"],
            "similarity": round(h.score, 3),
            "fraud_type": h.payload["fraud_type"],
            "analyst_verdict": h.payload["analyst_verdict"],
            "resolution_date": h.payload["resolution_date"],
        }
        for h in hits
    ]


def _mock_search_result(query_case_id: str, hits: list[dict]) -> dict:
    evidence = [{"evidence_id": h["case_id"], "source": "Qdrant Fraud Case Memory",
                 "detail": f"{h['fraud_type']} case, {int(h['similarity']*100)}% similar, verdict={h['analyst_verdict']}"}
                for h in hits]
    top = hits[0] if hits else None
    notes = (f"Most similar precedent: {top['case_id']} ({int(top['similarity']*100)}% similar, {top['fraud_type']})."
             if top else "No sufficiently similar historical cases found.")
    return {"query_case_id": query_case_id, "matches": hits, "evidence": evidence, "notes": notes}


@traced("fraud_case_search.process_case")
def process_task(message: dict, correlation_id: str = None):
    case_id = message["case_id"]
    narrative = message["narrative"]
    metadata_filter = message.get("metadata_filter", {})
    correlation_id = message.get("correlation_id", case_id)

    hits = _search(narrative, metadata_filter)

    result, tokens = llm.generate_structured(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=json.dumps({"query_case_id": case_id, "narrative": narrative, "hits": hits}),
        output_schema=FraudCaseSearchResult,
        mock_factory=lambda: _mock_search_result(case_id, hits),
    )

    log_event(correlation_id, "fraud_case_search_agent", "AGENT_CALL", {
        "case_id": case_id, "output": result.model_dump(), "token_usage": tokens,
    })

    publish_json("fraud-case-search-results", {
        "case_id": case_id, "correlation_id": correlation_id,
        "result": result.model_dump(),
    })
    return {"_otel_tokens": tokens}


def handler(message: dict):
    process_task(message, correlation_id=message.get("correlation_id", message.get("case_id")))


if __name__ == "__main__":
    run_worker_loop("fraud-case-search-tasks", handler)

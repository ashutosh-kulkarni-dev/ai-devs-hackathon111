"""
Continuous Learning Feedback Loop write-back (PRD section 6).

When an analyst submits a final verdict, this embeds the resolved case
narrative and writes it into the same Qdrant collection the Fraud Case
Search Agent reads from, tagged with the metadata schema the PRD specifies:
fraud_type, amount_bracket, channel, geography, resolution_date.
"""
import datetime
import os
import uuid

from embeddings import DIM, embed
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "fraud_case_memory")

_client = QdrantClient(url=QDRANT_URL)


def _amount_bracket(amount: float | None) -> str:
    if amount is None:
        return "UNKNOWN"
    if amount < 1000:
        return "UNDER_1K"
    if amount < 10000:
        return "1K_10K"
    if amount < 50000:
        return "10K_50K"
    return "OVER_50K"


def ensure_collection():
    collections = [c.name for c in _client.get_collections().collections]
    if COLLECTION not in collections:
        _client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
        )


def write_back_resolved_case(case_id: str, narrative: str, fraud_type: str,
                              amount: float | None, channel: str, geography: str,
                              analyst_verdict: str) -> str:
    ensure_collection()
    vector = embed(narrative)
    point_id = str(uuid.uuid4())
    _client.upsert(
        collection_name=COLLECTION,
        points=[
            PointStruct(
                id=point_id,
                vector=vector,
                payload={
                    "case_id": case_id,
                    "narrative": narrative,
                    "fraud_type": fraud_type,
                    "amount_bracket": _amount_bracket(amount),
                    "channel": channel,
                    "geography": geography,
                    "resolution_date": datetime.date.today().isoformat(),
                    "analyst_verdict": analyst_verdict,
                },
            )
        ],
    )
    return point_id

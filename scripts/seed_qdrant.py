#!/usr/bin/env python3
"""
Seeds Qdrant with the historical fraud case memory (PRD section 6 schema:
fraud_type, amount_bracket, channel, geography, resolution_date), so the
Fraud Case Search Agent has real precedent cases to retrieve against.

Run from the repo root, against the docker-compose-exposed Qdrant port:
    pip install -r scripts/requirements.txt
    python scripts/seed_qdrant.py
"""
import hashlib
import json
import os
import re

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
COLLECTION = os.environ.get("QDRANT_COLLECTION", "fraud_case_memory")
DIM = 128

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def embed(text: str):
    vec = np.zeros(DIM, dtype=np.float32)
    for word in re.findall(r"[a-zA-Z]+", text.lower()):
        idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM
        vec[idx] += 1.0
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec.tolist()


def amount_bracket(amount: float) -> str:
    if amount < 1000:
        return "UNDER_1K"
    if amount < 10000:
        return "1K_10K"
    if amount < 50000:
        return "10K_50K"
    return "OVER_50K"


def main():
    with open(os.path.join(HERE, "fixtures", "historical_fraud_cases.json")) as f:
        cases = json.load(f)

    client = QdrantClient(url=QDRANT_URL)
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION not in collections:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
        )

    points = []
    for i, case in enumerate(cases):
        vector = embed(case["narrative"])
        points.append(
            PointStruct(
                id=i + 1,
                vector=vector,
                payload={
                    "case_id": case["case_id"],
                    "narrative": case["narrative"],
                    "fraud_type": case["fraud_type"],
                    "amount_bracket": amount_bracket(case["amount"]),
                    "channel": case["channel"],
                    "geography": case["geography"],
                    "resolution_date": case["resolution_date"],
                    "analyst_verdict": case["analyst_verdict"],
                },
            )
        )

    client.upsert(collection_name=COLLECTION, points=points)
    print(f"Seeded {len(points)} historical fraud cases into Qdrant collection '{COLLECTION}'.")


if __name__ == "__main__":
    main()

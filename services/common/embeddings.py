"""
Embedding helper for the Fraud Case Search Agent / Qdrant.

Uses a deterministic hashed bag-of-words embedding (128-dim). This is
intentionally simple (no heavy ML dependency, no external call) but still
gives meaningful cosine similarity for keyword-overlapping fraud narratives,
which is enough to demo the hybrid semantic + metadata search pattern.
"""
import hashlib
import os
import re

import numpy as np

DEMO_MODE = os.environ.get("DEMO_MODE", "true").lower() == "true" or not os.environ.get("GROQ_API_KEY")

DIM = 128


def _hashed_bow_embedding(text: str) -> list[float]:
    vec = np.zeros(DIM, dtype=np.float32)
    for word in re.findall(r"[a-zA-Z]+", text.lower()):
        idx = int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM
        vec[idx] += 1.0
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec.tolist()


def embed(text: str) -> list[float]:
    return _hashed_bow_embedding(text)

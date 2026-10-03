"""
Strict output schemas for every agent. These are the enforcement mechanism
behind the CRISPE prompt appendix in docs/prompts/ -- every agent calls Groq
(see llm_client.py) in JSON mode and validates the response against one of
these Pydantic models, so the model cannot return anything that doesn't
match, and every downstream consumer (Report Generator, dashboard, audit
log) can rely on the shape.
"""
from typing import List

from pydantic import BaseModel, Field


class EvidenceRef(BaseModel):
    evidence_id: str = Field(description="ID of the source record, e.g. TXN-000123, WL-0042, CASE-812")
    source: str = Field(description="Which system the evidence came from")
    detail: str = Field(description="One-line description of what this evidence shows")


class KYCSummary(BaseModel):
    customer_id: str
    identity_score: int = Field(ge=0, le=100, description="0-100 confidence identity is verified & consistent")
    kyc_risk_rating: str = Field(description="LOW | MEDIUM | HIGH")
    sanctions_status: str = Field(description="NO_HIT | PARTIAL_HIT | HIT")
    sanctions_matches: List[str] = Field(default_factory=list, description="watchlist_ids of any matches")
    evidence: List[EvidenceRef]
    notes: str


class AnomalyPattern(BaseModel):
    pattern_type: str
    description: str
    severity: str = Field(description="LOW | MEDIUM | HIGH")


class AnomalyReport(BaseModel):
    account_id: str
    anomaly_score: int = Field(ge=0, le=100)
    patterns: List[AnomalyPattern]
    evidence: List[EvidenceRef]
    notes: str


class SimilarCase(BaseModel):
    case_id: str
    similarity: float = Field(ge=0, le=1)
    fraud_type: str
    analyst_verdict: str
    resolution_date: str


class FraudCaseSearchResult(BaseModel):
    query_case_id: str
    matches: List[SimilarCase]
    evidence: List[EvidenceRef]
    notes: str


class InvestigationReport(BaseModel):
    case_id: str
    fraud_probability: int = Field(ge=0, le=100)
    recommended_action: str = Field(description="ESCALATE_SAR | CONFIRM_FRAUD | CLEAR_FALSE_POSITIVE | MANUAL_REVIEW")
    narrative: str
    evidence_citations: List[EvidenceRef]
    confidence: str = Field(description="LOW | MEDIUM | HIGH")

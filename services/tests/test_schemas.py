"""Smoke test: every schemas.py model imports cleanly and round-trips one
instance through model_dump()/model_validate(). This is the "proof the
harness actually runs" test for Phase 0 -- it changes no runtime behaviour,
it just gives CI something that can fail.
"""
from schemas import (
    AnomalyPattern,
    AnomalyReport,
    EvidenceRef,
    FraudCaseSearchResult,
    InvestigationReport,
    KYCSummary,
    SimilarCase,
)


def _round_trip(model_cls, **kwargs):
    instance = model_cls(**kwargs)
    dumped = instance.model_dump()
    rebuilt = model_cls.model_validate(dumped)
    assert rebuilt == instance
    return instance


def test_evidence_ref_round_trips():
    _round_trip(
        EvidenceRef,
        evidence_id="TXN-000123",
        source="transaction_analyzer",
        detail="Large transfer to a new payee",
    )


def test_kyc_summary_round_trips():
    _round_trip(
        KYCSummary,
        customer_id="CUST-1",
        identity_score=80,
        kyc_risk_rating="LOW",
        sanctions_status="NO_HIT",
        sanctions_matches=[],
        evidence=[],
        notes="ok",
    )


def test_anomaly_report_round_trips():
    _round_trip(
        AnomalyReport,
        account_id="ACC-1",
        anomaly_score=42,
        patterns=[
            AnomalyPattern(
                pattern_type="NEW_GEOGRAPHY",
                description="First transaction from this country",
                severity="MEDIUM",
            )
        ],
        evidence=[],
        notes="ok",
    )


def test_fraud_case_search_result_round_trips():
    _round_trip(
        FraudCaseSearchResult,
        query_case_id="CASE-1",
        matches=[
            SimilarCase(
                case_id="CASE-812",
                similarity=0.92,
                fraud_type="MULE_ACCOUNT",
                analyst_verdict="CONFIRMED_FRAUD",
                resolution_date="2024-01-01",
            )
        ],
        evidence=[],
        notes="ok",
    )


def test_investigation_report_round_trips():
    _round_trip(
        InvestigationReport,
        case_id="CASE-1",
        fraud_probability=88,
        recommended_action="ESCALATE_SAR",
        narrative="Consistent with a mule account pattern (see TXN-000231).",
        evidence_citations=[],
        confidence="HIGH",
    )

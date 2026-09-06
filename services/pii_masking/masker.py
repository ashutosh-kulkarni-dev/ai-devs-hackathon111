"""
PII Masking Service.

Every field that could reach an LLM prompt passes through here first.
Uses Microsoft Presidio for entity detection + anonymization. In production,
this stage is paired with Google Cloud DLP for a second, independent pass
(defense-in-depth against a single detector's false negatives) — noted in
docs/PRD.md security section. For the hackathon build, Presidio alone runs
for real, since that's what's demonstrable without a GCP project.
"""
from fastapi import FastAPI
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from pydantic import BaseModel

app = FastAPI(title="PII Masking Service", version="1.0.0")

analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

ENTITIES = [
    "PERSON", "PHONE_NUMBER", "EMAIL_ADDRESS", "CREDIT_CARD",
    "US_SSN", "US_BANK_NUMBER", "IBAN_CODE", "LOCATION", "DATE_TIME",
]


class MaskRequest(BaseModel):
    text: str
    language: str = "en"


class MaskResponse(BaseModel):
    masked_text: str
    entities_found: list


@app.post("/mask", response_model=MaskResponse)
def mask(req: MaskRequest):
    results = analyzer.analyze(text=req.text, language=req.language, entities=ENTITIES)
    anonymized = anonymizer.anonymize(text=req.text, analyzer_results=results)
    entities_found = [
        {"entity_type": r.entity_type, "start": r.start, "end": r.end, "score": round(r.score, 2)}
        for r in results
    ]
    return MaskResponse(masked_text=anonymized.text, entities_found=entities_found)


@app.post("/leak_test")
def leak_test(req: MaskRequest):
    """CI/leak-test hook: fails if any high-confidence PII entity survives masking.
    Mirrors the PRD's stated mitigation: 'regular automated leak tests in CI/CD.'
    """
    masked = mask(req)
    residual = analyzer.analyze(text=masked.masked_text, language=req.language, entities=ENTITIES)
    high_conf_leaks = [r for r in residual if r.score >= 0.6]
    return {"passed": len(high_conf_leaks) == 0, "residual_entities": len(high_conf_leaks)}


@app.get("/healthz")
def health():
    return {"status": "ok"}

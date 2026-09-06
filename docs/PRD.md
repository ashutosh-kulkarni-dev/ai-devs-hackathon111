# Product Requirements Document (PRD): AI Fraud Investigator System
### Stage 2 — Revision 2 (addresses Stage 1 judge feedback)

Changes from Stage 1, in one line each: added FR-/NFR- IDs and a traceability matrix (§10); replaced synchronous agent orchestration with an async, Pub/Sub-based architecture (§4, §10); added a CRISPE prompt-engineering appendix per agent with enforced output schemas (§11, `docs/prompts/`); expanded the security section with concrete encryption/validation/observability controls (§7).

## 1. Problem Statement & Business Context
In the current Banking, Financial Services, and Insurance (BFSI) landscape, fraud analysts are overwhelmed by the volume of flagged transactions. Currently, the investigation process is entirely manual, requiring analysts to pivot between multiple disconnected systems to pull Know Your Customer (KYC) documents, analyze 12-month transaction patterns, search for historical fraud parallels, and cross-reference global sanctions lists.

**Key Pain Points:**
*   **Time Inefficiency:** A single investigation takes between 30 to 45 minutes.
*   **High Volume:** Thousands of transactions are flagged daily, leading to significant backlogs and delayed detection of actual fraud.
*   **Operational Cost:** The manual effort required scales linearly with transaction volume, creating a massive overhead for the compliance department.
*   **Consistency & Accuracy:** Manual report writing is prone to human error and subjective interpretation, which can lead to inconsistent SAR (Suspicious Activity Report) filings.

This system automates the "detective work" using a multi-agent AI swarm to synthesize evidence and present a ready-to-review report to the analyst.

## 2. Goals & Success Metrics
The primary goal of the AI Fraud Investigator is to shift the analyst's role from "data gatherer" to "decision maker."

**Measurable Success Metrics:**
*   **Reduction in Investigation Time:** Reduce the average time spent per case from 45 minutes to under 2 minutes of human review.
*   **False Positive Triage Efficiency:** Achieve a 70% reduction in the manual effort required to clear false-positive alerts.
*   **SAR Filing Accuracy:** Increase the quality and detail of evidence citations in SAR filings, measured by a reduction in "Request for Information" (RFI) follow-ups from regulators.
*   **Cost per Investigation:** Reduce the operational cost per investigation by at least 80% through automation.
*   **System Throughput:** Capability to process 10,000+ investigations daily without increasing headcount.

## 3. User Personas
### Fraud Analyst
*   **Role:** Conducts the primary review of flagged transactions and makes the final "Confirm Fraud" or "False Positive" decision.
*   **Pain Points:** Context switching, manual data entry, and the pressure of clearing high-volume queues.
*   **System Value:** Receives a comprehensive narrative report with a probability score and cited evidence, allowing for rapid sign-off.

### Compliance & Audit Officer
*   **Role:** Ensures the bank adheres to AML (Anti-Money Laundering) regulations and internal policies.
*   **Pain Points:** Lack of transparency in AI decision-making ("black box" problem) and the need for immutable audit trails for regulators.
*   **System Value:** Access to an immutable audit log that records every reasoning step and prompt used by the AI agents, and can be verified live for tamper-evidence (see §7).

## 4. System Architecture Overview — now asynchronous and event-driven

Stage 1 feedback: *"Reliance on synchronous internal APIs for agent orchestration ... introduces tight coupling and latency bottlenecks."* This revision replaces every orchestrator→agent call with asynchronous message passing.

1.  **Trigger:** A flagged transaction alert enters via the **API Gateway** (FastAPI, strict Pydantic/JSON schema validation at the boundary — OWASP API1/API8 input-validation control).
2.  **Privacy Layer:** The **PII Masking Service** (Microsoft Presidio; Google DLP API as a second, independent pass in production) redacts sensitive customer data before any information is passed to the LLMs.
3.  **Async Dispatch:** The gateway publishes an `investigation-tasks` message to **Google Cloud Pub/Sub** (Pub/Sub emulator for local/hackathon runs, same SDK and wire protocol as production). The **Lyzr Investigation Orchestrator** (reasoning via whatever model the configured Lyzr Studio agent runs) consumes this, decides the dispatch plan, and publishes one task message per worker agent to its own topic — it never calls a worker agent directly.
4.  **Agent Swarm (parallel, decoupled):** Specialized agents built with **Google Agent Development Kit (ADK)** and **Groq (`openai/gpt-oss-20b`)**, each an independent Pub/Sub subscriber/publisher:
    *   **KYC Retriever:** Pulls documents and checks the **Sanctions & PEP API**.
    *   **Transaction Analyzer:** Queries the Transaction History store for behavioral anomalies.
    *   **Fraud Case Search:** Queries **Qdrant** for semantically similar historical cases.
    Each publishes its result to its own `*-results` topic — no agent blocks on another.
5.  **Join & Synthesis:** The orchestrator's result-consumer threads independently collect each agent's output; once all planned results for a case are in, it publishes a single `report-generator-tasks` message. The **Report Generator Agent** (Groq `openai/gpt-oss-120b`) compiles findings into a narrative with specific evidence citations, enforced against a strict output schema (see §11).
6.  **Human-in-the-Loop:** The analyst reviews the report on the **Analyst Dashboard**; the UI withholds the decision buttons until the analyst has scrolled through the full evidence list (mitigation for analyst over-reliance, §8).
7.  **Feedback Loop:** The final decision is embedded and written back to **Qdrant** to improve future retrieval accuracy (§6).
8.  **Compliance:** Every step is logged in an **immutable, hash-chained audit log** (§7).

## 5. Component Specifications

| Component Name | Responsibility | Tech Stack | Inputs | Outputs | Connected Data Stores |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **API Gateway** | Entry point for alerts; input-schema validation; auth. | FastAPI, Pydantic | Flagged Transaction Alert | `investigation-tasks` Pub/Sub message | N/A |
| **PII Masking Service** | Redacts/masks PII before any LLM sees data. | Python, Microsoft Presidio (+ Google DLP in prod) | Raw text/customer fields | Masked text | N/A |
| **Pub/Sub Message Bus** | Decouples orchestrator from worker agents; all inter-agent communication. | Google Cloud Pub/Sub (emulator locally) | Task/result messages | Task/result messages | N/A |
| **Investigation Orchestrator** | Decides dispatch plan; joins agent results; triggers Report Generator. | Lyzr (model per Lyzr Studio config) | Masked alert | Task messages per agent | Audit & Compliance Log |
| **KYC Retriever Agent** | Extracts KYC details and performs identity verification. | Google ADK, Groq `openai/gpt-oss-20b` | Customer ID, task message | `KYCSummary` (schema-enforced) | KYC Document Store |
| **Transaction Analyzer Agent** | Analyzes 12-month history for behavioral anomalies. | Google ADK, Groq `openai/gpt-oss-20b` | Account ID, task message | `AnomalyReport` (schema-enforced) | Transaction History DB |
| **Fraud Case Search Agent** | Finds similar historical fraud cases via hybrid vector search. | Google ADK, Groq `openai/gpt-oss-20b` | Case narrative, task message | `FraudCaseSearchResult` (schema-enforced) | Qdrant Vector DB |
| **Report Generator Agent** | Synthesizes all agent findings into a final, cited narrative. | Google ADK, Groq `openai/gpt-oss-120b` | All agent findings | `InvestigationReport` (schema-enforced) | Investigation Case DB |
| **Analyst Dashboard** | UI for case review, de-masking, and final decisioning. | React, Tailwind, TypeScript | Final report | Analyst verdict (Confirm/Override) | Investigation Case DB |
| **Sanctions & PEP API** | External check for watchlists and political exposure. | REST API (mock fixture-backed locally; real vendor e.g. World-Check in prod) | Customer name/DOB | Screening status (Hit/Partial/No-Hit) | N/A |
| **Transaction History DB** | Source of truth for all financial transactions. | Postgres locally (Cloud Spanner in prod) | Query parameters | Transaction records | N/A |
| **KYC Document Store** | Repository for IDs, utility bills, onboarding docs. | Local fixtures (GCS/Firestore in prod) | Customer ID | Raw documents/metadata | N/A |
| **Qdrant Vector DB** | Long-term memory for historical fraud cases. | Qdrant | Embeddings, metadata filters | Semantically similar cases | N/A |
| **Investigation Case DB** | Stores active and archived AI-generated reports. | Postgres (Cloud SQL in prod) | Case ID, report data | Stored case files | N/A |
| **Audit & Compliance Log** | Immutable, tamper-evident record of all AI reasoning and inputs. | Hash-chained Postgres table locally (BigQuery insert-only + CMEK in prod) | Agent inputs/outputs, reasoning | Verifiable audit trail | N/A |

## 6. The Continuous Learning Feedback Loop
The system implements a "Self-Improving Memory" via the integration between the Analyst Dashboard and Qdrant.

*   **Data Capture:** When an analyst submits a final verdict (e.g., "Confirmed Fraud - Account Takeover"), the system captures the final narrative, the evidence summary, and the analyst's reasoning.
*   **Embedding & Metadata:** This data is converted into a vector embedding, appended with structured metadata: `fraud_type`, `amount_bracket`, `channel` (e.g., Wire, ACH), `geography`, and `resolution_date`.
*   **Write-Back:** The embedding and metadata are stored in the **Qdrant Vector DB (Fraud Case Memory)** — implemented in `services/common/qdrant_writeback.py`.
*   **Retrieval Improvement:** During the next investigation, the **Fraud Case Search Agent** performs a hybrid search (semantic similarity + metadata filtering), allowing the AI to tell the analyst: *"This case is 92% similar to Case #882, which you confirmed as a 'Mule Account' last week."*

## 7. Security, Privacy & Regulatory Compliance

To meet stringent banking regulations (AML, GDPR, CCPA), the following controls apply. Each row states what is implemented and running in this build versus documented as the production target.

| Control | Production target | This build |
| :--- | :--- | :--- |
| Encryption in transit | TLS 1.3 on all service-to-service and external traffic | Documented infra requirement; local dev runs over the docker-compose internal network. Ingress config (Caddy/nginx TLS termination) included as a reference in `docs/architecture.md`. |
| Encryption at rest | AES-256 on all data stores (Cloud SQL, GCS, BigQuery, Qdrant) | Documented as a Postgres/GCS configuration flag; not demoed live (no managed KMS in a local sandbox). |
| Input validation | Strict JSON schema validation at every service boundary (OWASP API1/API8) | **Implemented**: Pydantic models validate every API Gateway request (`FlaggedAlert`, `VerdictRequest`) and every agent's Pub/Sub task payload before processing. |
| PII redaction | No raw customer PII ever reaches Groq models | **Implemented**: PII Masking Service (Presidio) runs on all free-text fields before publish; `/leak_test` endpoint scripted for CI. |
| IAM-gated de-masking | Only the Analyst Dashboard, under Google Cloud IAM roles, can de-mask data | Stubbed via an API-key check (`/cases/{id}/demask`) for the demo; every call is logged regardless. Production: replace with IAM/OAuth2 role check. |
| Immutable audit trail | Every prompt, reasoning step, and agent interaction logged, tamper-proof | **Implemented, and verifiable live**: hash-chained append-only Postgres table (`services/audit_log`); `GET /audit/verify` recomputes the chain and reports the exact row if tampered. Production target: BigQuery insert-only table with CMEK. |
| AI explainability | Fraud probability directly linked to cited evidence, no hallucinated citations | **Implemented**: Report Generator's output schema requires `evidence_citations`; prompt (see `docs/prompts/report_generator.md`) forbids citing an `evidence_id` not present in upstream agent outputs. |
| LLM observability | End-to-end tracing, correlation IDs, token/latency tracking | **Implemented**: OpenTelemetry spans around every agent call and orchestrator step, tagged with `correlation_id` = case ID; console exporter locally, OTLP/Jaeger-ready via `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| Audit of de-masking | Every PII de-mask view logged | **Implemented**: `PII_DEMASK` audit event on every `/demask` call. |

## 8. Key Risks & Mitigations

| Risk | Likelihood | Impact | Specific Mitigation |
| :--- | :--- | :--- | :--- |
| **LLM Hallucination** | Medium | High | Mandatory evidence citation enforced via schema + prompt constraint (not just convention); Report Generator cross-references agent outputs for consistency. |
| **Qdrant Retrieval Misses** | Low | Medium | Hybrid search implementation combining semantic embeddings with hard metadata filters (e.g., amount bracket, geography). |
| **Analyst Over-reliance** | High | High | Dashboard UI forces analysts to scroll through evidence before the "Confirm/False Positive" buttons unlock; periodic "blind" audits recommended in production. |
| **PII Leakage to LLM** | Low | Critical | Presidio redaction pass (+ Google DLP in prod) before any LLM call; `/leak_test` endpoint for automated CI leak tests. |
| **Latency Spikes** | Medium | Low | Groq openai/gpt-oss-20b for high-volume worker agents; async Pub/Sub dispatch avoids blocking the orchestrator on any single slow agent. |
| **Orchestration coupling / SPOF** (Stage 1 finding) | — | — | Resolved by the Pub/Sub-based architecture in §4 — orchestrator and agents communicate only via topics, no synchronous RPC. |

## 9. Future Roadmap
*   **Graph-Based Detection:** Integration with a Graph Database (e.g., Google Cloud Managed JanusGraph) to detect complex fraud rings and "money mule" networks.
*   **Real-Time Blocking:** Moving from post-transaction investigation to real-time "interdiction" where the AI can pause a transaction before funds leave the bank.
*   **Multi-Language KYC:** Expanding the KYC Retriever Agent to support OCR and translation for international identity documents in 40+ languages.
*   **Agentic SAR Filing:** Automatically pre-filling regulatory SAR forms based on the confirmed investigation report.
*   **Production hardening:** Swap Postgres→Cloud Spanner, hash-chained log→BigQuery insert-only+CMEK, mock Sanctions API→licensed vendor, Pub/Sub emulator→live Cloud Pub/Sub, add full IAM/OAuth2.

## 10. Requirements Traceability Matrix

### Functional Requirements

| ID | Requirement | Architecture Component(s) |
| :--- | :--- | :--- |
| FR-101 | Ingest a flagged transaction alert via an authenticated, schema-validated API | API Gateway |
| FR-102 | Mask PII in any free-text fields before they reach an LLM | PII Masking Service |
| FR-103 | Dispatch investigation work asynchronously to worker agents | Investigation Orchestrator, Pub/Sub Message Bus |
| FR-104 | Retrieve and assess KYC/identity information, including sanctions/PEP screening | KYC Retriever Agent, Sanctions & PEP API, KYC Document Store |
| FR-105 | Analyze 12-month transaction history for behavioral anomalies | Transaction Analyzer Agent, Transaction History DB |
| FR-106 | Retrieve semantically similar historical fraud cases via hybrid search | Fraud Case Search Agent, Qdrant Vector DB |
| FR-107 | Synthesize a final investigation report with a fraud probability, recommended action, and cited evidence | Report Generator Agent |
| FR-108 | Present the report to an analyst and require evidence review before allowing a verdict | Analyst Dashboard |
| FR-109 | Capture the analyst's verdict and write it back to the fraud case vector memory with structured metadata | Analyst Dashboard, API Gateway (`qdrant_writeback`), Qdrant Vector DB |
| FR-110 | Log every agent call, dispatch decision, and analyst action to an immutable, verifiable audit trail | Audit & Compliance Log |
| FR-111 | Allow an authorized analyst to de-mask PII, with every access logged | API Gateway (`/demask`), Audit & Compliance Log |

### Non-Functional Requirements

| ID | Requirement | Threshold | Architecture Component(s) |
| :--- | :--- | :--- | :--- |
| NFR-201 | End-to-end orchestration dispatch latency (alert received → all worker tasks published), excluding LLM generation time | < 2 seconds | Investigation Orchestrator, Pub/Sub Message Bus |
| NFR-202 | System availability | 99.9% | API Gateway, Pub/Sub Message Bus (async decoupling removes orchestrator as a blocking SPOF) |
| NFR-203 | Daily investigation throughput | 10,000+ investigations/day without headcount increase | Agent Swarm (parallel, horizontally scalable workers) |
| NFR-204 | Human review time per case | < 2 minutes | Analyst Dashboard, Report Generator Agent (evidence-cited narrative) |
| NFR-205 | Zero raw PII reaching any LLM call | 0 leaked entities in `/leak_test` | PII Masking Service |
| NFR-206 | Audit log tamper-evidence | 100% of tamper attempts detected on `/audit/verify` | Audit & Compliance Log (hash chain) |
| NFR-207 | Evidence citation integrity | 0% of `evidence_citations` reference an unknown `evidence_id` | Report Generator Agent (schema + prompt constraint) |
| NFR-208 | Encryption in transit / at rest | TLS 1.3 in transit, AES-256 at rest | Documented production target, see §7 |

## 11. Prompt Engineering Appendix

Full CRISPE-framework prompt specifications, output JSON schemas, and few-shot examples for all four agents live in `docs/prompts/`:
- `docs/prompts/kyc_retriever.md`
- `docs/prompts/transaction_analyzer.md`
- `docs/prompts/fraud_case_search.md`
- `docs/prompts/report_generator.md`

These are not just documentation — every schema referenced is enforced at runtime via Groq's JSON mode plus Pydantic validation (see `services/common/llm_client.py` and `schemas.py`), so the PRD's prompt specification and the running code cannot drift apart silently.

— END OF PRD —

# AI Fraud & Anomaly Investigation Agent (BFSI)

An AI-native multi-agent system that investigates flagged bank transactions end to end: retrieves similar historical fraud cases, verifies KYC and sanctions screening, analyzes transaction behavior, reasons about fraud probability, and generates a cited, analyst-ready investigation report.

Built for the [track brief]: automate the "detective work" fraud analysts currently do manually across disconnected systems, cutting a 30-45 minute investigation down to under 2 minutes of human review.

This is the Stage 2 submission — a running system, not just a design. See `docs/PRD.md` for the full requirements doc (with FR/NFR IDs and a traceability matrix) and `docs/architecture.md` for the architecture diagram and design rationale.

## Two ways to run this

This repo ships two runnable versions of the same design, for two different purposes:

1. **`services/` + `docker-compose.yml` — the reference architecture and the canonical implementation.** The mandatory hackathon stack (Google ADK, Qdrant, Lyzr) wired together with real async Pub/Sub messaging, a standalone Qdrant vector DB, and Microsoft Presidio PII masking, fronted by the `frontend/` dashboard (port 5173). This is the architecture described in `docs/architecture.md`, demonstrates production-grade design depth, and is where new fixes and behavior land first.
2. **`web/` — a static demo mirror, deployable to Vercel in a few clicks.** A single Next.js app that re-implements the same design as serverless functions, using Vercel's built-in Postgres storage, so it's a clickable URL you can hand to judges with zero infrastructure setup. See `web/README.md` for one-click deploy steps.

**`web/` is a demo mirror, not a behaviorally-identical twin.** It shares the same CRISPE prompt intent and output schemas, but several concrete divergences mean the same input is not guaranteed to produce the same output in both stacks:
- **Sanctions matching** uses a different string-similarity algorithm — Python's `difflib.SequenceMatcher` (Ratcliff/Obershelp) in `services/mock_sanctions_api`, a Dice-coefficient bigram overlap in `web/lib/sanctions.ts` — so the same name pair can land on different sides of the HIT/PARTIAL_HIT/NO_HIT thresholds.
- **PII masking** in `web/lib/pii.ts` is regex-based (email, phone, SSN, card number) with no PERSON-name detector; `services/pii_masking` (Microsoft Presidio) does detect names.
- **`POST /alerts` status contract** differs: `services/` returns `IN_PROGRESS` (processing is genuinely asynchronous); `web/` returns `PENDING_REVIEW` (it finishes end-to-end within the one request).
- **Report narrative format** differs: `services/`'s Report Generator writes a plain-language paragraph; `web/`'s writes a one-sentence summary plus 2-3 bullet points.

See `web/README.md`'s "Known divergences" section for the full list. Treat `web/` as a fully-functional demo of the same idea, not a certified twin of `services/`'s behavior — if the two ever need to match exactly, `services/` is the one to trust.

## What changed since Stage 1

Stage 1 scored "Strongly Aligned" with the track but flagged four gaps. Each is addressed here, with a pointer to the exact evidence:

| Stage 1 finding | Fix | Where |
| :--- | :--- | :--- |
| Synchronous orchestration → tight coupling, latency risk | Orchestrator and agents communicate only via Pub/Sub topics (emulator locally, same SDK as production Cloud Pub/Sub) | `services/orchestrator/`, `docs/architecture.md` |
| No production-grade prompt specs (CRISPE, output schemas, few-shot) | CRISPE prompt appendix per agent, enforced at runtime via Groq JSON mode + Pydantic validation | `docs/prompts/*.md`, `services/agents/*/agent.py` |
| No explicit security controls (encryption, input validation) | Pydantic schema validation at every boundary; PII masking with a scripted leak test; security control table split into "implemented" vs "documented production target" | `docs/PRD.md` §7 |
| No LLM observability (OpenTelemetry, correlation IDs) | OpenTelemetry spans around every agent/orchestrator call, tagged with the case's correlation ID; token + latency tracked per LLM call | `services/common/tracing.py` |

## Known issues → fixed

An internal review (`plan_3.md`) found and closed five correctness bugs, in the same "no silent failures" spirit as the Stage 1 fixes above. Each has a regression test in `services/tests/`:

| Finding | Fix | Where |
| :--- | :--- | :--- |
| A crashed agent mid-handler acked its message before processing it, so a single bad message silently dropped a case (at-least-once delivery had quietly become at-most-once) | Ack only after the handler succeeds; nack on failure so the emulator/production Pub/Sub redelivers; dead-letter (with the error) after N failed attempts instead of looping or vanishing | `services/common/pubsub_client.py`, `test_pubsub_client.py` |
| A dead PII masking service made the API Gateway log a warning and forward the **unmasked** narrative to every downstream agent and the audit log | `POST /alerts` now fails closed: masking unavailable → `503`, alert rejected, nothing unmasked ever published | `services/api_gateway/main.py`, `test_api_gateway_pii.py` |
| The orchestrator guessed a 3-agent expected-set for any result with no recorded dispatch plan, so a 2-agent Lyzr plan hung forever waiting for a third result that would never come; a redelivered dispatch also wholesale-overwrote already-collected results | Expected-set comes only from the recorded plan (an unplanned result is held for redelivery, never guessed); dispatch is idempotent on redelivery; a background join-timeout sweeper completes a stuck case with a `partial: true` report and the list of missing agents | `services/orchestrator/orchestrator.py`, `test_orchestrator_fanin.py` |
| A reprocessed report-generator task (now possible under the retry fix above) unconditionally reset an already-resolved case back to `PENDING_REVIEW`, silently discarding an analyst's verdict | The upsert only writes when the case isn't already in a terminal state (`CONFIRMED_FRAUD` / `FALSE_POSITIVE`); reprocessing a resolved case is a no-op | `services/agents/report_generator/agent.py`, `test_report_generator_idempotency.py` |
| `GET /audit/verify` recomputed the chain over whatever rows currently existed, so editing a row was caught but **deleting the newest rows was not** — the truncated chain still verified clean | A checkpoint table anchors the chain tip in the same transaction as every log write; `/verify` now also checks the visible tip against that checkpoint, so a truncation reports invalid with the expected-vs-actual sequence | `services/audit_log/audit.py`, `test_audit_truncation.py` |

Also cleaned up in the same pass: `services/api_gateway/common/`, `services/orchestrator/common/`, and `services/agents/common/` were three byte-identical copies of the same module tree, requiring every fix above to be hand-applied three times — collapsed into one canonical `services/common/`. CI itself couldn't previously fail on anything but a Python syntax error (`ruff --exit-zero`, no tests, no `web/` build check); it now runs `pytest`, blocks on lint, and builds both `frontend/` and `web/`.

## Architecture at a glance

Flagged alert → API Gateway (input validation) → PII Masking → Pub/Sub → Lyzr Orchestrator (Lyzr Studio agent) fans out to three parallel agents (KYC Retriever, Transaction Analyzer, Fraud Case Search — all Google ADK + Groq `openai/gpt-oss-20b`) → Report Generator (Groq `openai/gpt-oss-120b`) synthesizes a schema-enforced, evidence-cited report → Analyst Dashboard (scroll-gated verdict) → confirmed/false-positive verdict is embedded and written back into Qdrant's fraud case memory.

Every hop is logged to a hash-chained, tamper-evident audit log that you can verify live (`GET /audit/verify`) — see `docs/architecture.md` for the full diagram and the local-vs-production substitution table (Postgres↔Spanner, hashed log↔BigQuery+CMEK, mock Sanctions API↔licensed vendor, etc.).

Mandatory hackathon stack — **Google ADK, Qdrant, Lyzr** — all present and load-bearing, not decorative:
- **Google ADK**: all four agents.
- **Qdrant**: fraud case memory, read by the search agent and written back by the dashboard.
- **Lyzr**: the orchestrator's dispatch-planning brain.

## Quickstart

Requires Docker + Docker Compose, and Python 3.11+ on the host for the seed/demo scripts.

```bash
cp .env.example .env
# Optionally fill in GROQ_API_KEY and LYZR_API_KEY in .env for live LLM calls.
# Leave them blank and the whole pipeline still runs end-to-end in
# deterministic DEMO_MODE (every agent falls back to schema-matching mock output).

./scripts/run_demo_case.sh
```

This brings up the full stack (Qdrant, Postgres, Pub/Sub emulator, mock Sanctions API, PII masking, audit log, API gateway, orchestrator, all four agents, and the dashboard), seeds transaction/KYC/historical fraud case fixtures, submits one flagged alert, and prints the resulting investigation report.

Then open the dashboard: **http://localhost:5173**

To submit more cases interactively, use the "Submit a flagged transaction alert" form in the dashboard, or:

```bash
curl -X POST http://localhost:8000/alerts \
  -H "X-API-Key: demo-key-change-me" -H "Content-Type: application/json" \
  -d '{"customer_id":"CUST-1004","account_id":"ACC-5004","flagged_transaction_id":"TXN-000452",
       "narrative":"Three transfers just under the $10,000 threshold within 48 hours."}'
```

Check audit log integrity live: `curl http://localhost:8000/audit/verify` (or the "Verify Audit Log Integrity" button in the dashboard header) — this recomputes the hash chain and will name the exact tampered row if you edit an entry directly in Postgres.

## Demo mode vs. live mode

Every LLM call and embedding call checks for `GROQ_API_KEY`; every Lyzr orchestration decision checks for `LYZR_API_KEY`. If absent, the system runs in `DEMO_MODE`: deterministic, schema-matching mock responses stand in, so the entire async multi-agent pipeline — Pub/Sub dispatch, parallel agent execution, join logic, report synthesis, audit logging, dashboard — runs and is fully demonstrable without any credentials. Supplying the keys in `.env` switches every agent to real Groq calls and real Lyzr orchestration with no code changes.

## Repository layout

```
docs/                  PRD (with FR/NFR IDs + traceability matrix), architecture doc, CRISPE prompt specs
services/
  api_gateway/          FastAPI entry point, input validation, verdict + write-back endpoints
  pii_masking/           Presidio-based PII redaction service
  audit_log/             Hash-chained immutable audit log
  mock_sanctions_api/    Fixture-backed Sanctions/PEP screening API
  orchestrator/          Lyzr-backed dispatch planner + Pub/Sub fan-out/fan-in
  agents/
    common/               Shared LLM client, schemas, Pub/Sub client, tracing, embeddings
    kyc_retriever/        Google ADK agent
    transaction_analyzer/ Google ADK agent
    fraud_case_search/    Google ADK agent
    report_generator/     Google ADK agent
frontend/               React + Tailwind + TypeScript analyst dashboard for the services/
                        stack above (the one Quickstart opens on :5173) -- not a dead
                        duplicate of web/'s dashboard, which is a separate UI for a
                        separate backend (see "Two ways to run this")
fixtures/               Synthetic transactions, KYC docs, sanctions watchlist, historical fraud cases
scripts/                Seed scripts + one-command demo runner
```

## Known limitations / honest scoping

This is a hackathon build, not a bank's production deployment. What's real: the full async multi-agent pipeline, Qdrant hybrid search, schema-enforced LLM outputs, PII masking, the hash-chained audit log, OpenTelemetry tracing, and the dashboard. What's substituted for speed and demo reliability: Cloud Spanner → Postgres, BigQuery → hash-chained Postgres, a real Sanctions/PEP vendor → a fixture-backed mock with the same API contract, and full GCP IAM → an API-key stub. Every substitution is listed with its production target in `docs/architecture.md` and `docs/PRD.md` §7 — nothing here is hidden or overstated.

## License

Built for a hackathon submission; no license restrictions on reuse for evaluation purposes.

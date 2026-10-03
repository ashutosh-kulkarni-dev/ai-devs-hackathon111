# AI Fraud & Anomaly Investigation Agent

A multi-agent LLM system that triages flagged bank transactions end-to-end — KYC & sanctions screening, transaction-pattern analysis, historical-case retrieval, and a cited, analyst-ready investigation report — then hands an analyst a one-click confirm / clear decision.

Turns the 30–45 minute manual investigation an analyst does across disconnected systems into **under 2 minutes of human review**.

> **[→ Live demo](https://ai-devs-hackathon111.vercel.app)** · deployed on Vercel, no setup needed. Runs in `DEMO_MODE` with deterministic mock agent output if LLM keys aren't configured.

---

## What it does

1. Receives a flagged transaction alert (`POST /api/alerts`).
2. Masks PII, then fans out to **four agents in parallel**:
   - **KYC Retriever** — identity + sanctions/PEP screen.
   - **Transaction Analyzer** — anomaly detection against account history.
   - **Fraud Case Search** — semantic search over past resolved cases (Qdrant).
   - **Report Generator** — synthesizes the three above into a schema-enforced report with evidence citations and a fraud probability.
3. Writes every hop to a **hash-chained audit log** you can verify live (tampering any row names the exact seq that broke).
4. Serves a dashboard where the analyst reviews the report, picks `CONFIRMED_FRAUD` or `FALSE_POSITIVE`, and the resolution is embedded + written back to Qdrant so future similar cases match it.

## Stack

- **Next.js 14** (App Router) + React 18 + TypeScript — deployed on Vercel.
- **Groq** (`openai/gpt-oss-20b` for agents, `openai/gpt-oss-120b` for the synthesizer) with JSON-mode + Zod validation on every LLM output.
- **Lyzr** — orchestrator's dispatch-planning brain (which agents to run per alert).
- **Qdrant** — vector store for fraud-case memory.
- **Vercel Postgres (Neon)** — cases, audit log, resolved-case metadata. In-memory fallback for local `next dev`.

A parallel **`services/` + `docker-compose.yml` reference stack** implements the same design with real async Pub/Sub, Google ADK agents, and Microsoft Presidio PII masking. See [`services/README.md`](services/README.md).

## Try it in 60 seconds

**Live:** click the demo link above and submit a flagged alert.

**Locally (the Vercel app):**
```bash
cd web
cp .env.example .env.local      # leave keys blank for DEMO_MODE
npm install
npm run dev                      # http://localhost:3000
```

**Locally (full reference stack with Pub/Sub, Qdrant, Presidio):**
```bash
cp .env.example .env             # optionally add GROQ_API_KEY / LYZR_API_KEY
./scripts/run_demo_case.sh       # brings up the whole compose stack, seeds, submits a demo alert
```
Dashboard at <http://localhost:5173>, API at <http://localhost:8000>.

## Repository layout

```
web/            Next.js app deployed to Vercel (the live demo)
  app/api/        Serverless routes: /alerts, /cases, /audit/verify
  lib/            Agents, DB, Qdrant client, PII masking, auth
  app/components/ Analyst dashboard UI
services/       Reference stack: FastAPI + Pub/Sub + Google ADK agents
docker-compose.yml  Brings up services/ + Qdrant + Postgres + Presidio
frontend/       Vite/React dashboard for the services/ stack
docs/           PRD (FR/NFR traceability), architecture doc, CRISPE prompts
fixtures/       Synthetic transactions, KYC docs, sanctions watchlist, past cases
scripts/        Seed + one-command demo runner
```

## Security & honest scoping

This is a hackathon project; some things are stubbed for demo purposes:

- **Auth** on write endpoints is same-origin check + optional `X-API-Key` for external callers. If `API_GATEWAY_KEY` is unset, external access is closed by default. For production, replace with OAuth2 / IAM.
- **PII masking** in `web/` is regex-based (email, phone, SSN, card). The `services/` stack uses Presidio and additionally catches person names.
- **Sanctions matching** is backed by a fixture file, not a licensed vendor feed.
- **In-memory rate limiter** per serverless instance (not cluster-wide). For production use a shared store (Upstash/Redis).
- **Vercel Postgres** was recently deprecated in favour of Neon; the `@vercel/postgres` client still works but new deploys should use `@neondatabase/serverless`.

Everything that's substituted is listed with its production target in [`docs/architecture.md`](docs/architecture.md) and [`docs/PRD.md`](docs/PRD.md) §7.

## Known divergences between `web/` and `services/`

The two stacks share prompt intent and output schemas, but are not bit-identical twins:

| | `services/` | `web/` |
|---|---|---|
| Transport | Google Cloud Pub/Sub (async) | `Promise.all` in one request |
| PII masking | Presidio (incl. names) | regex (email/phone/SSN/card) |
| Sanctions similarity | Ratcliff/Obershelp (`difflib`) | Dice-coefficient bigram overlap |
| `POST /alerts` returns | `IN_PROGRESS` (truly async) | `PENDING_REVIEW` (finishes in-request) |
| Report narrative | prose paragraph | one-sentence summary + bullets |

If the two ever need to match exactly, `services/` is canonical.

## License

MIT — see [LICENSE](LICENSE).

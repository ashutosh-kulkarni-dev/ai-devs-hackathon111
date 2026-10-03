# AI Fraud Investigation — Hackathon Prototype

A hackathon-built prototype exploring whether an LLM-orchestrated multi-agent pipeline can replicate the "detective work" a bank fraud analyst does across KYC, sanctions, transaction patterns, and historical cases — turning a 30–45 min manual investigation into **under 2 minutes of human review**.

> **[→ Live demo](https://ai-devs-hackathon111.vercel.app)** · click a preset alert, watch 4 agents run, read the synthesized report. Runs in **DEMO MODE** (deterministic mock agent output) unless `GROQ_API_KEY` is configured — the UI shows a banner so visitors know which they're seeing.

<!-- TODO(ashutosh): drop a 10–15s GIF here showing: pick alert → 4 agents run → report → verdict.
     Record with ScreenToGif / Kap, keep <2MB, commit to docs/demo.gif, then:
     ![demo](docs/demo.gif) -->

---

## What this is (and isn't)

**It is:** a working end-to-end prototype that demonstrates multi-service orchestration, structured LLM output under schema validation, vector search, a tamper-detectable change log, and a dashboard UX for an analyst-in-the-loop workflow. Shipped live on Vercel.

**It isn't:** a production BFSI system. Fraud scores are not statistically calibrated. PII masking is regex-based. Sanctions screening uses a fixture file, not a licensed vendor feed. The "tamper-evident audit log" is a hash chain that's integrity-checkable from the same process that writes it — real tamper-evidence needs external anchoring (which would be a one-afternoon add via a daily hash to a public gist, and is tracked as a TODO).

Treat it as a portfolio-grade demonstration of design judgement + plumbing, not a bank-ready product.

## How it works

1. Analyst submits a flagged alert (`POST /api/alerts`) or clicks a preset in the sidebar.
2. PII is masked, then **four agents run** (3 in parallel, then a synthesizer):
   - **KYC Retriever** — identity + sanctions/PEP screen.
   - **Transaction Analyzer** — anomaly detection against account history.
   - **Fraud Case Search** — semantic search over past resolved cases (Qdrant).
   - **Report Generator** — synthesizes the three into a schema-enforced report with evidence citations and a risk tier.
3. Every hop is written to a hash-chained log; `GET /api/audit/verify` recomputes the chain and names the exact `seq` of any tampered row.
4. Analyst confirms `CONFIRMED_FRAUD` or clears as `FALSE_POSITIVE`. The resolution is embedded + written back to Qdrant so future similar alerts match it.

## Stack

- **Next.js 14** (App Router) + React 18 + TypeScript — deployed on Vercel.
- **Groq** (`openai/gpt-oss-20b` for agents, `openai/gpt-oss-120b` for synthesizer) with JSON mode + Zod validation.
- **Lyzr** — orchestrator's dispatch-planning brain (optional; local fallback invokes all agents).
- **Qdrant** — vector store for the fraud-case memory.
- **Neon Postgres** (`@neondatabase/serverless`) — cases + audit log + resolved-case metadata. In-memory fallback for local dev.
- **Vitest** — unit + integration tests for auth, DB lifecycle, and audit chain.

A parallel `services/` + `docker-compose.yml` reference stack explores the same design with real async Pub/Sub, Google ADK agents, and Microsoft Presidio PII masking. It's not what's deployed — think of it as the "full async architecture" exploration that fed into the Vercel build.

## Quickstart

### Run the Vercel app locally

```bash
cd web
cp .env.example .env.local      # leave keys blank for DEMO MODE
npm install
npm run dev                      # http://localhost:3000
```

Add `GROQ_API_KEY` (from https://console.groq.com) to `.env.local` for live LLM calls; everything else is optional.

### Run the evaluation harness

With `npm run dev` running in another terminal:

```bash
cd web
npm run eval                     # 15 ground-truth cases, prints a confusion matrix
# BASE_URL=https://ai-devs-hackathon111.vercel.app npm run eval  # evaluate the live site
```

Fixtures live in [`web/eval/fixtures.json`](web/eval/fixtures.json). Each case has an `expected_action` labelled by hand with the rationale an analyst would use. The runner scores each as `match` / `close` (same escalation group) / `miss` and exits non-zero below 70% accuracy, so it can gate CI.

### Run the tests

```bash
cd web
npm test                         # 10 vitest tests: auth, rate limit, terminal-state guard, audit chain
```

### Run the full reference stack (optional)

```bash
cp .env.example .env             # optional: GROQ_API_KEY / LYZR_API_KEY
./scripts/run_demo_case.sh       # brings up docker-compose, seeds fixtures, submits a demo alert
```
Dashboard at <http://localhost:5173>, API at <http://localhost:8000>.

## Repository layout

```
web/                 Next.js app deployed to Vercel (the live demo — primary deliverable)
  app/api/             Serverless routes: /alerts, /cases, /audit/verify, /config
  app/components/      Analyst dashboard UI
  lib/                 Agents, DB (Neon + in-memory fallback), Qdrant, PII mask, auth
  eval/                Ground-truth fixtures + evaluation runner
  tests/               Vitest tests
services/            Reference stack (FastAPI + Pub/Sub + Google ADK) — not deployed
docker-compose.yml   Brings up services/ + Qdrant + Postgres + Presidio
frontend/            Vite/React dashboard for the services/ stack
docs/                PRD (FR/NFR traceability), architecture doc, CRISPE prompts
fixtures/            Synthetic customers, transactions, KYC docs, past fraud cases
```

## Evaluation results

The eval harness ran all 15 ground-truth cases through the live pipeline (Groq `gpt-oss-120b` for synthesis, `gpt-oss-20b` for agents). Three iterations:

| Prompt version | Strict (exact match) | Lenient (match + close group) | Dominant failure mode |
|---|---|---|---|
| Original — narrative dropped at synthesizer | 46.7% | 53.3% | Under-escalation when fixtures didn't match customer_id |
| **+ pass narrative to synthesizer + fraud-pattern cues** (locked in) | **46.7%** | **66.7%** | Over-escalates some benign cases |
| + explicit CLEAR cues (reverted) | 60.0% | 60.0% | Over-corrected; started missing real fraud |

What this surfaced:
- A real design bug — the Report Generator never saw the raw alert narrative, only the three agents' structured outputs. When fixtures returned thin data, "insufficient evidence → clear" fired on obvious fraud. **Fixed** by passing the masked narrative through.
- Classic prompt-tuning whack-a-mole on 15 cases — "fix one failure mode, create another." The eval set is too small to tune to without overfitting; the next step is a 100+ case set with a validation holdout.
- The pipeline is still **better at catching fraud than at clearing benign activity**. Operationally that's the preferred asymmetry (missing fraud is worse than extra analyst review), but it's a measured limitation, not an unmeasured one.

Run it yourself: `npm run eval` from `web/` (needs the dev server running and a `GROQ_API_KEY` in `.env.local`). Pacing (`EVAL_SLEEP_MS`) stays under Groq's free-tier 8000 TPM; daily 200K TPD is a harder ceiling.

## Honest scoping

| Area | What's real | What's substituted / limited |
|---|---|---|
| Agents | Real parallel fan-out, schema-enforced outputs | Fixtures stand in for a real transaction store / KYC vault |
| Fraud score | Risk tier (LOW/MED/HIGH/CRITICAL) is directly actionable | Numeric probability is model-reported, **not calibrated** — labelled as such in the UI |
| PII masking (web/) | Regex: email, phone, SSN, card | Doesn't catch names (services/ stack uses Presidio) |
| Sanctions screening | Dice-coefficient name matching with HIT/PARTIAL/NO_HIT thresholds | Fixture watchlist, not a licensed vendor feed |
| Audit log | Hash-chained, verifiable, `/verify` names any tampered row | Verify endpoint runs in the same trust boundary as writes; real tamper-evidence needs external anchoring (planned) |
| Auth | Same-origin check + optional X-API-Key for external callers, per-IP rate limit | Not OAuth/IAM; closed by default when `API_GATEWAY_KEY` is unset |
| Persistence | Neon Postgres on live; in-memory for local | — |

## Follow-ups (not done in this pass)

- **Larger eval set** — 15 cases is a diagnostic, not a benchmark. The next step is 100+ cases with an explicit train / validation / test split so prompt tuning stops being overfitting.
- **"Stability signal" extractor** — a small pre-processing step that pulls established-pattern cues ("18 months", "54 prior", "notified in advance") out of the narrative into a structured field, so the synthesizer stops relying on free-text pattern-matching for the single thing it's weakest at.
- **External anchoring for the audit chain** (daily hash → public gist) to make tamper-evidence hold outside the write-path's trust boundary.
- **Replace inline styles in `web/app/components/*` with Tailwind** — Tailwind is already configured; the dashboard components still use inline styles for historical reasons.
- **Prompt-injection hardening** — narrative flows into prompts after only regex masking; needs instruction-boundary wrapping.

## License

MIT — see [LICENSE](LICENSE).

# Vercel-deployable version

This is a single Next.js app that collapses the reference architecture's API Gateway, PII masking, orchestrator, and four agents into one deployable project, so it runs on Vercel with essentially zero infrastructure setup. It's the "click a link and it just works" version for judges; the `docker-compose` stack at the repo root remains the canonical reference architecture demonstrating the mandatory stack (Google ADK, Qdrant, Lyzr) and a true async Pub/Sub design.

**This is a demo mirror, not a certified twin of the reference build's behavior.** It shares the same design and intent, but it is a separate hand-written implementation, and a few concrete divergences exist (see "Known divergences" below) beyond the deliberate infrastructure substitutions this doc otherwise documents. If the two stacks ever need to agree exactly on an output, the `services/` build is the one to trust.

## Why this exists alongside the docker-compose stack

Vercel serverless functions are stateless and time-limited -- they cannot host long-running Pub/Sub subscribers, a standalone Qdrant container, or a stateful orchestrator process. Rather than fake that architecture badly, this deployment is honest about the substitution:

| Reference build (repo root) | This Vercel deployment | Why |
| :--- | :--- | :--- |
| Orchestrator + Pub/Sub topics, agents as separate subscriber processes | Agents called as concurrent `Promise.all` functions inside one API route | A serverless function can't host a subscriber; concurrent promises still express "parallel, non-blocking fan-out," just within one invocation instead of across processes. |
| Qdrant vector DB | Cosine similarity computed at request time over a bundled fixture + a small Postgres-backed "memory" table | The corpus is ~30 historical cases; a full vector DB is overkill and adds a signup step. Documented explicitly as a substitution, not hidden. |
| Postgres in a container | Vercel Postgres (Storage tab, powered by Neon) or in-memory fallback for local dev | Vercel's own first-party storage integration -- zero extra signup, env vars auto-injected. |
| Microsoft Presidio PII masking | Regex-based PII masking (`lib/pii.ts`) | Presidio's Python/NLP dependencies don't fit a lean serverless bundle. Narrower coverage, same purpose, clearly labeled. |
| Lyzr + Google ADK agent structure, CRISPE prompts | Same prompts, same schemas, same mock-fallback contract, ported to TypeScript | The intelligence design didn't change -- only the runtime/transport did. |

Every agent's system prompt, output schema, and mock-mode fallback logic is ported from the Python reference implementation in `services/agents/`, following the same CRISPE specs (`../docs/prompts/`) -- but "ported" means hand-translated to TypeScript, not code-shared, so drift is possible and the divergences below are the ones currently known.

## Known divergences from `services/` (not just the substitutions above)

These are behavioral differences on top of the deliberate infrastructure substitutions above -- the same input can produce a different result in this deployment than in the reference build:

| Area | `services/` (reference) | `web/` (this deployment) |
| :--- | :--- | :--- |
| Sanctions name matching | Python `difflib.SequenceMatcher` (Ratcliff/Obershelp) in `services/mock_sanctions_api` | Dice-coefficient bigram overlap in `lib/sanctions.ts` -- same 0.85/0.65 thresholds, different metric, so a given name pair can land on a different side of the HIT/PARTIAL_HIT/NO_HIT line |
| PII masking coverage | Microsoft Presidio (`services/pii_masking`), includes a PERSON-name NLP detector | Regex only (`lib/pii.ts`): email, phone, SSN, card number -- **no PERSON-name detection** |
| `POST /alerts` response | `status: "IN_PROGRESS"` (dispatch is genuinely async; the case isn't done yet) | `status: "PENDING_REVIEW"` (the whole pipeline already ran synchronously within the request) |
| Report narrative format | One plain-language paragraph (`services/agents/report_generator`) | One summary sentence + 2-3 bullet points (`lib/agents/reportGenerator.ts`) |

None of these are hidden bugs so much as two independently-written implementations of the same design drifting apart -- listed here so a judge (or a future contributor) doesn't assume byte-for-byte parity that doesn't exist. If you need the two to agree, the `services/` behavior is the intended one; treat a difference here as a bug in `web/` to fix, not the other way round.

## Deploy to Vercel

1. Push this repo to GitHub.
2. In Vercel: **New Project** → import the repo → set **Root Directory** to `web`.
3. (Recommended) In the project's **Storage** tab: **Create Database** → **Postgres**. This auto-injects `POSTGRES_URL` and related env vars — no manual connection-string wrangling.
4. (Optional) Add `GROQ_API_KEY` in **Settings → Environment Variables** to switch every agent from deterministic `DEMO_MODE` mock output to live Groq calls. Leave it unset and the full pipeline still runs end-to-end.
5. (Optional) Add `LYZR_API_KEY`, `LYZR_API_BASE`, `LYZR_ORCHESTRATOR_AGENT_ID` to route dispatch-planning through a real Lyzr Studio agent.
6. Change `API_GATEWAY_KEY` from the default placeholder before sharing the URL publicly, and set the matching `NEXT_PUBLIC_API_GATEWAY_KEY` so the dashboard can call the API.
7. Deploy. Open the generated `*.vercel.app` URL — the dashboard loads directly, no separate setup step.

## Local development

```bash
cd web
npm install
cp .env.example .env.local   # optionally fill in POSTGRES_URL / GROQ_API_KEY
npm run dev
```

Without `POSTGRES_URL` set, storage falls back to an in-memory store scoped to the running `next dev` process — fine for a quick local click-through, but it won't persist across serverless invocations in an actual Vercel deployment. Configure Vercel Postgres before sharing a public demo link.

## What's real here

Every prompt, schema, dispatch-planning call, hash-chained audit log, PII masking pass, and the scroll-gated dashboard verdict flow are fully implemented and functional -- this is not a static mockup. What's scoped down for the serverless constraint, and where this deployment's actual behavior diverges from the reference build, are both documented in the tables above.

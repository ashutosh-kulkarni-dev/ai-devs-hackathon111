# Remediation Plan — AI Fraud Investigation Agent

**Purpose.** Fix the correctness bugs, eliminate silent failures, and reduce structural
duplication in this repo **without rewriting the core**. Every phase below is designed to be
a **separately reviewable, separately mergeable** change with a narrow blast radius. You can
stop after any phase and still have a system that is strictly better than before it.

**Three non-negotiables that shape the whole plan:**

1. **No silent failures.** Every `except` that currently swallows-and-continues either
   re-raises, routes to a dead-letter path, or records an explicit degraded-state marker that
   a human can see. "Logged a print and carried on" is treated as a bug, not a mitigation.
2. **Separability over cleverness.** Phases touch disjoint file sets wherever possible. Where
   two phases must touch the same file, the plan says so and orders them to avoid merge pain.
3. **No new spaghetti.** We do not add abstraction layers to "fix" duplication until the
   behavioural bugs are gone. Deduplication (Phase 6) comes *after* the code is correct, so we
   are collapsing correct code into one place, not freezing a bug into a shared module.

**Sequencing logic.** Phase 1 hardens the messaging spine that every service sits on, because
a fix to any agent is worthless if the transport can still drop the message. Phases 2–5 are
independent correctness fixes that each touch one subsystem. Phase 6+ are structural and
cosmetic, safe to do last. Phases 2, 3, 4, 5 have **no dependency on each other** and can be
done in any order or in parallel by different people once Phase 1 lands.

**Working discipline for every phase:** branch off `main`, one phase per PR, PR description
links back to the finding it closes, CI must pass (CI itself is fixed in Phase 0 so "pass"
means something), no phase merges without the test it adds.

---

## Phase 0 — Safety net first (no behaviour change)

**Why first:** You currently have **zero test files** and a CI pipeline that cannot fail on
anything except a hard Python syntax error (`ruff --exit-zero`, `web/` never type-checked).
Refactoring correctness bugs without a test harness is how you *introduce* the next bug. This
phase adds the harness and makes CI able to say "no" — it changes no runtime behaviour, so it
is the safest possible thing to merge first.

**Changes**
- Add `pytest` to `services/agents/common/requirements.txt` (dev section) and create
  `services/tests/` with a `conftest.py` that puts `common/` on the path.
- Add one trivial smoke test (`test_schemas.py`) that imports every `schemas.py` model and
  round-trips one instance — proves the harness runs in CI.
- `.github/workflows/ci.yml`: (a) drop `--exit-zero` on ruff so lint failures block; (b) add a
  `pytest` step; (c) add a `web/` job that runs `npm ci && npm run typecheck && npm run build`.
- Add `web/` typecheck to CI (currently only the legacy `frontend/` Vite app is checked).

**Separability:** touches only `ci.yml`, `requirements.txt`, and a new `tests/` dir. No service
code. Cannot break runtime.

**Done when:** CI runs pytest and a `web/` build on every PR, and a deliberately broken lint or
type error fails the pipeline (verify by pushing a throwaway broken commit to a branch).

---

## Phase 1 — Make the messaging core trustworthy (the spine)

**This is the highest-priority correctness work.** Everything else depends on it.

**The bug (confirmed, `services/agents/common/pubsub_client.py`):**
- `pull_one()` calls `subscriber.acknowledge(...)` **immediately after pulling, before the
  handler runs.** If the handler then crashes, the message is already acked and gone. This
  silently converts at-least-once delivery into at-most-once, and a crashed agent drops the
  case with no retry.
- `run_worker_loop()` wraps the handler in `try/except Exception` and just `print()`s. Combined
  with the eager ack above, **a single bad message silently destroys a case** — the exact class
  of failure you said is unacceptable.

**Changes (one file, `pubsub_client.py`, plus a new topic):**
1. **Ack only after the handler returns successfully.** Move `acknowledge(...)` out of
   `pull_one` and into `run_worker_loop`, after `handler(message)` succeeds. Add a `nack`
   (modify-ack-deadline to 0) on failure so the emulator redelivers.
2. **Dead-letter after N failed attempts.** Add a `*-dead-letter` topic. On the Nth handler
   failure for a message (track a delivery-attempt count), publish the raw message plus the
   exception string to the dead-letter topic and ack the original so it stops looping. This is
   the "fail loud, don't lose data" contract: a message either succeeds, retries, or lands
   visibly in the dead-letter queue — never disappears.
3. **Remove the bare `print` swallow.** The except now re-raises after nack/dead-letter
   bookkeeping, or logs at error level to the audit log with an explicit `HANDLER_FAILED`
   event so the failure is queryable, not just a stdout line.

**Separability:** all changes are inside `pubsub_client.py` and one new topic name. Because the
three `common/` trees are currently byte-identical (see Phase 6), apply the change to
`services/agents/common/pubsub_client.py` and copy verbatim to the api_gateway and orchestrator
copies **in this same PR** — do not let them drift. (Phase 6 later removes the copies entirely.)

**Tests (new, Phase 0 harness):** a fake in-memory subscriber that (a) proves a handler
exception does NOT ack, (b) proves redelivery happens, (c) proves the Nth failure dead-letters
and acks. These are pure-Python, no emulator needed.

**Done when:** killing an agent mid-handler causes redelivery on restart (manual test with the
emulator), and a permanently-poisoned message ends up in `*-dead-letter` rather than looping or
vanishing.

---

## Phase 2 — PII masking fails closed (independent)

**The bug (`services/api_gateway/main.py`, `submit_alert`):** if the PII masking service call
throws, the except block prints a warning and forwards the **unmasked** narrative to Pub/Sub,
the LLM agents, and the audit log. For a project whose headline is "PII masking with a leak
test," a masking outage silently leaking raw customer PII into LLM prompts is the worst-case
failure.

**Design decision — fail closed, but stay demonstrable.** Two acceptable behaviours; pick one
and document it:
- **(A) Reject:** return HTTP 503 and do not admit the alert if masking is unavailable. Cleanest
  for a compliance story.
- **(B) Quarantine:** admit the alert but tag the case `MASKING_DEGRADED`, write an explicit
  audit event, refuse to forward the narrative text (send an empty/redacted placeholder), and
  surface the degraded badge in the dashboard so a human knows masking didn't run.

Recommended: **(A) for the narrative path** — it's a fraud system; refusing to process beats
leaking. Keep it simple.

**Changes:** `services/api_gateway/main.py` only (and the `web/` equivalent in Phase 7). Replace
the swallow with a hard failure or explicit quarantine marker. Add the `MASKING_DEGRADED` /
rejection audit event.

**Separability:** single file, single endpoint. No messaging or agent changes.

**Test:** point `PII_MASKING_URL` at a dead port, submit an alert, assert the narrative never
appears unmasked downstream (assert 503, or assert the quarantine marker + no raw text in the
published message).

---

## Phase 3 — Orchestrator fan-in correctness (independent)

**The bugs (`services/orchestrator/orchestrator.py`):**
- **Wrong expected-set on early results.** In `_make_result_handler`, if a result arrives before
  `dispatch_investigation` created the case state, `setdefault` assumes **all three** agents
  were dispatched. If the Lyzr plan dispatched only two, the case waits forever for a third
  result that never comes. No timeout exists anywhere.
- **State clobber on task redelivery.** With Phase 1's ack-after-handle, `investigation-tasks`
  can now legitimately redeliver. `dispatch_investigation` overwrites `_case_state[case_id]`
  wholesale, wiping any results already collected → permanent hang.
- **In-memory state, single process.** `_case_state` is a process-local dict. Any orchestrator
  restart loses all in-flight joins.

**Changes (orchestrator only):**
1. **Persist the dispatch plan before publishing tasks**, and make the result handler read
   `expected_state_keys` from the stored plan rather than guessing. If a result arrives with no
   known plan, hold it (or nack it via Phase 1) instead of inventing a 3-agent expectation.
2. **Make dispatch idempotent.** On redelivery, merge into existing state, never overwrite.
   Key on `case_id`; if state exists, no-op the re-dispatch.
3. **Add a join timeout.** A background sweeper (or a per-case deadline checked on each result)
   that, after T seconds, publishes a `report-generator-tasks` message with the results
   collected so far plus a `partial: true` / `INCOMPLETE` flag and the list of missing agents.
   The case completes visibly-incomplete rather than hanging silently.
4. Optional but recommended for the "no in-memory single point" story: back `_case_state` with a
   Postgres table so an orchestrator restart resumes joins. Can be deferred to a follow-up if
   time-boxed — the timeout in (3) already removes the *silent* hang.

**Separability:** orchestrator process only. Depends on Phase 1 conceptually (redelivery is now
real) but the code changes don't overlap Phase 1's file.

**Test:** simulate a 2-agent plan and assert the case still completes (via timeout → partial
report) instead of hanging; simulate a redelivered dispatch and assert collected results
survive.

---

## Phase 4 — Report generator idempotency (independent, small)

**The bug (`services/agents/report_generator/agent.py`, `_persist_case`):**
`INSERT ... ON CONFLICT (case_id) DO UPDATE SET status='PENDING_REVIEW'` unconditionally. If the
report task is ever reprocessed (now possible under Phase 1 retries), it **resets an
already-resolved case back to PENDING_REVIEW**, silently discarding an analyst's submitted
verdict.

**Change (one SQL statement):** guard the update so it only writes when the case is not already
in a terminal state — e.g. `... DO UPDATE SET ... WHERE investigation_cases.status = 'PENDING_REVIEW'`
(or `NOT IN ('CONFIRMED_FRAUD','FALSE_POSITIVE')`). Reprocessing a resolved case becomes a
no-op, not a regression.

**Separability:** one file, one query. Genuinely isolated.

**Test:** insert a resolved case, replay the report task, assert status and verdict unchanged.

---

## Phase 5 — Audit chain detects truncation (independent)

**The bug (`services/audit_log/audit.py` `/verify`, mirrored in `web/lib/db.ts`):** `/verify`
recomputes the chain over whatever rows currently exist. Editing a row is caught; **deleting the
newest N rows is not** — the remaining chain still verifies clean, giving false integrity
confidence on the more realistic attack.

**Change:** anchor the chain tip. Maintain an external high-water mark — simplest robust option
is a separate single-row `audit_checkpoint` table (or append-only file) updated on each `/log`
with `latest_seq` and `latest_hash`. `/verify` then also asserts the current tail matches the
recorded checkpoint; a mismatch (fewer rows, or tip hash changed) reports truncation with the
expected-vs-actual seq. Keep the checkpoint write in the same transaction as the log insert.

**Separability:** audit service only (+ `web/lib/db.ts` in Phase 7). No other service knows.

**Test:** log 5 entries, delete the last 2 directly, assert `/verify` now reports invalid with a
truncation reason (today it wrongly returns valid).

---

## Phase 6 — Collapse the triplicated core (structural, after correctness)

**The problem:** `services/api_gateway/common/`, `services/orchestrator/common/`, and
`services/agents/common/` are **byte-identical copies** of the same module tree. Phase 1 already
forced you to edit the same file three times — that's the tax, and it's how the web/services
divergence (Phase 7) originally happened.

**Change:** make one canonical `common/` and have the others consume it. Two low-risk options:
- **(A) Single package, installed:** move to `services/common/`, add a minimal `pyproject.toml`,
  and `pip install -e ./services/common` in each Dockerfile. Cleanest.
- **(B) Build-context share:** point every Dockerfile's build context at repo root and COPY the
  one `common/` in. Less clean but zero packaging.

Do this **only after** Phases 1–5, so you are collapsing *correct* code into one place. Deleting
two of the three copies is the actual win — one source of truth going forward.

**Separability:** pure move + Dockerfile/import-path edits. No logic change. CI (Phase 0) and the
demo run are the regression check. This is the one phase that touches many files at once, which
is exactly why it comes after the behavioural fixes are locked in and tested.

**Also here:** the four dashboard components exist twice (`frontend/src/components/*` and
`web/app/components/*`). Decide `frontend/`'s fate in Phase 7; if it's dead, its duplication
disappears for free.

---

## Phase 7 — Reconcile the "two identical implementations" claim

**The problem:** the README claims `web/` and `services/` "run the identical CRISPE prompts,
output schemas, and agent logic." They don't:
- Sanctions matching uses different similarity algorithms (Dice vs. Ratcliff/Obershelp) → same
  input can be HIT in one stack, NO_HIT in the other.
- `web/lib/pii.ts` has no PERSON-name detection; the Presidio service does.
- `/alerts` returns different status contracts (`IN_PROGRESS` vs `PENDING_REVIEW`).
- Report narrative format differs (bullets vs paragraph).
- `frontend/` (Vite) appears to be a superseded duplicate of `web/`'s dashboard, yet
  docker-compose still builds it.

**Uncomfortable recommendation (stated plainly):** stop maintaining two hand-written
implementations that are supposed to be identical — that is a standing source of the exact
divergence bugs above, and every future fix has to be done twice by hand. Pick a canonical:
- `services/` is the one that demonstrates the mandatory stack (ADK, Qdrant, Lyzr, Pub/Sub) and
  is the stronger engineering artifact.
- Either (a) demote `web/` to an explicitly-labelled "static demo mirror — not guaranteed
  behaviourally identical," and soften the README claim to match reality, or (b) invest to make
  the divergent pieces match (port PERSON-name masking, unify the sanctions algorithm and
  threshold, align the status contract). (a) is honest and cheap; (b) is more work but preserves
  the "one design, two runtimes" story.

**Changes:** confined to `web/lib/*` and README wording (option a), or the specific divergent
files (option b). Delete `frontend/` and drop its docker-compose service if it's dead, or
document why it exists.

**Separability:** entirely within `web/` + docs + the `frontend/` decision. Does not touch
`services/` runtime.

---

## Phase 8 — Truth-in-docs and CV polish (cosmetic, last)

**Changes (no runtime risk):**
- **Naming honesty:** docstrings and `docs/` say "Gemini 2.5 Pro/Flash" everywhere; the code
  calls Groq `openai/gpt-oss-20b/120b`. Fix the docs to match the code (or vice versa). A
  technical reader spots this in minutes and it undercuts the whole "production-grade" framing.
- **Add a "Known issues → fixed" section** to the README documenting the bugs this plan closed,
  mirroring the existing Stage 1→Stage 2 table. Self-awareness reads as senior; hidden bugs read
  as sloppy.
- **Architecture diagram note** on delivery guarantees (at-least-once, dead-letter, join
  timeout) now that Phase 1/3 make them real — this is a strong thing to be able to talk about in
  an interview.

---

## Dependency map (what blocks what)

```
Phase 0 (tests + CI)  ──────────────► enables safe verification of ALL later phases
        │
        ▼
Phase 1 (messaging spine) ──► makes retries real, so:
        ├──► Phase 3 (orchestrator) assumes redelivery exists
        └──► Phase 4 (report idempotency) assumes reprocessing exists

Phase 2 (PII fail-closed)    ─┐
Phase 3 (orchestrator join)  ─┤  mutually independent — any order, or parallel,
Phase 4 (report idempotency) ─┤  once Phase 1 has landed
Phase 5 (audit truncation)   ─┘

Phase 6 (dedupe common/)  ──► after 1–5 so correct code gets collapsed, not buggy code
Phase 7 (web vs services) ──► independent of services/ runtime; do anytime after Phase 0
Phase 8 (docs)            ──► last; no code risk
```

## Suggested merge order (single-threaded)

0 → 1 → 2 → 4 → 5 → 3 → 6 → 7 → 8

(Phase 3 is placed after the small isolated fixes because it's the largest behavioural change and
benefits most from the harness and the messaging spine being proven first. If two people are
working, one takes 2/4/5 while the other takes 3 in parallel.)

## Definition of "done" for the whole effort

- No `except` in the codebase swallows an error without re-raising, dead-lettering, or writing an
  explicit degraded-state audit event.
- A killed agent, a dead PII service, a 2-agent dispatch plan, a redelivered message, and a
  deleted audit row each produce a **visible, queryable** outcome — never a silently lost or
  silently regressed case.
- CI fails on lint errors, type errors, a broken `web/` build, and a failing test.
- One canonical `common/`; the web/services divergence is either fixed or honestly labelled.

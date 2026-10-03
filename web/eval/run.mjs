#!/usr/bin/env node
/**
 * Pipeline evaluation harness.
 *
 * Submits each ground-truth alert in fixtures.json against a running
 * instance of the API, waits for the report, and scores the model's
 * recommended_action against the human-labelled expected_action.
 *
 * Usage (in another terminal: `npm run dev`):
 *   node web/eval/run.mjs                              # default: http://localhost:3000
 *   BASE_URL=https://your.vercel.app node web/eval/run.mjs
 *
 * Exit code 0 if accuracy >= 70%, 1 otherwise -- so this can gate CI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_GATEWAY_KEY;
const PASS_THRESHOLD = Number(process.env.EVAL_THRESHOLD || 0.7);
// Pause between cases so a free-tier LLM key (e.g. Groq's 8000 TPM) does
// not get hammered into 429s and silently fall back to mock output.
const INTER_CASE_MS = Number(process.env.EVAL_SLEEP_MS || 15_000);

const ESCALATION = new Set(["ESCALATE_SAR", "CONFIRM_FRAUD", "MANUAL_REVIEW"]);
const CLEAR = new Set(["CLEAR_FALSE_POSITIVE"]);

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "fixtures.json"), "utf8"));

async function submitAlert(alert) {
  const headers = { "Content-Type": "application/json", Origin: BASE_URL, Host: new URL(BASE_URL).host };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(`${BASE_URL}/api/alerts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      customer_id: alert.customer_id,
      account_id: alert.account_id,
      flagged_transaction_id: alert.flagged_transaction_id,
      narrative: alert.narrative,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function getCase(caseId) {
  const res = await fetch(`${BASE_URL}/api/cases/${caseId}`);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

function score(expected, actual) {
  if (expected === actual) return "match";
  const expGroup = ESCALATION.has(expected) ? "esc" : "clear";
  const actGroup = ESCALATION.has(actual) ? "esc" : CLEAR.has(actual) ? "clear" : "other";
  if (expGroup === actGroup) return "close";
  return "miss";
}

const pad = (s, n) => String(s).padEnd(n);

console.log(`\nEvaluating ${fixtures.cases.length} ground-truth cases against ${BASE_URL}\n`);
console.log(pad("ID", 10), pad("expected", 22), pad("actual", 22), "verdict");
console.log("-".repeat(80));

const results = [];
for (let i = 0; i < fixtures.cases.length; i++) {
  const c = fixtures.cases[i];
  try {
    const { case_id } = await submitAlert(c);
    const detail = await getCase(case_id);
    const actual = detail?.report_json?.recommended_action || "NO_REPORT";
    const verdict = score(c.expected_action, actual);
    results.push({ id: c.id, expected: c.expected_action, actual, verdict });
    const colour = verdict === "match" ? "\x1b[32m" : verdict === "close" ? "\x1b[33m" : "\x1b[31m";
    console.log(pad(c.id, 10), pad(c.expected_action, 22), pad(actual, 22), `${colour}${verdict}\x1b[0m`);
  } catch (e) {
    results.push({ id: c.id, expected: c.expected_action, actual: "ERROR", verdict: "miss", error: String(e) });
    console.log(pad(c.id, 10), pad(c.expected_action, 22), pad("ERROR", 22), `\x1b[31mmiss\x1b[0m  ${e}`);
  }
  if (i < fixtures.cases.length - 1 && INTER_CASE_MS > 0) {
    await new Promise((r) => setTimeout(r, INTER_CASE_MS));
  }
}

const matches = results.filter(r => r.verdict === "match").length;
const close = results.filter(r => r.verdict === "close").length;
const misses = results.filter(r => r.verdict === "miss").length;
const accuracy = (matches + close) / results.length;

console.log("-".repeat(80));
console.log(`\nmatch: ${matches}   close: ${close}   miss: ${misses}`);
console.log(`strict accuracy (match only):   ${(matches / results.length * 100).toFixed(1)}%`);
console.log(`lenient accuracy (match+close): ${(accuracy * 100).toFixed(1)}%`);
console.log(`threshold:                      ${(PASS_THRESHOLD * 100).toFixed(0)}%\n`);

process.exit(accuracy >= PASS_THRESHOLD ? 0 : 1);

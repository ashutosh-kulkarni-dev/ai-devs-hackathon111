/**
 * POST /api/alerts -- entry point for a flagged transaction alert.
 *
 * This is the Vercel-deployable equivalent of the reference build's
 * API Gateway -> Pub/Sub -> Orchestrator -> Agent Swarm -> Report Generator
 * chain (see ../../../../docs/architecture.md at the repo root). Because a
 * Vercel serverless function is stateless and cannot host long-running
 * Pub/Sub subscribers, the "async fan-out" here is implemented as
 * concurrent Promises within a single function invocation instead of
 * separate message-queue workers. The dispatch-planning decision (which
 * agents to run) and every agent's prompt/schema/logic are unchanged from
 * the reference build -- only the transport between them differs.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Groq + Lyzr fan-out can exceed the default 10s serverless timeout. Pro+
// Vercel plans allow up to 60s; hobby ignores this and keeps 10s.
export const maxDuration = 60;
import { checkApiKey } from "@/lib/auth";
import { maskText } from "@/lib/pii";
import { getDispatchPlan } from "@/lib/lyzr";
import { insertCase, updateCaseReport, appendAudit } from "@/lib/db";
import { kycRetriever } from "@/lib/agents/kycRetriever";
import { transactionAnalyzer } from "@/lib/agents/transactionAnalyzer";
import { fraudCaseSearch } from "@/lib/agents/fraudCaseSearch";
import { reportGenerator } from "@/lib/agents/reportGenerator";

const AlertSchema = z.object({
  customer_id: z.string().min(1).max(64),
  account_id: z.string().min(1).max(64),
  flagged_transaction_id: z.string().max(64).optional(),
  narrative: z.string().max(2000).default(""),
  metadata_filter: z.record(z.string()).default({}),
});

export async function POST(req: NextRequest) {
  const authError = checkApiKey(req);
  if (authError) return authError;

  let body;
  try {
    body = AlertSchema.parse(await req.json());
  } catch (e: any) {
    return NextResponse.json({ detail: "invalid request body", errors: e.errors || String(e) }, { status: 422 });
  }

  const caseId = `CASE-NEW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const correlationId = caseId;

  const { maskedText } = (() => {
    const r = maskText(body.narrative || "");
    return { maskedText: r.maskedText };
  })();

  await insertCase(caseId, body.customer_id, body.account_id);
  await appendAudit(correlationId, "api_gateway", "ALERT_RECEIVED", { case_id: caseId, customer_id: body.customer_id, account_id: body.account_id });

  const plan = await getDispatchPlan(body);
  await appendAudit(correlationId, "orchestrator", "DISPATCH_PLAN", { case_id: caseId, plan });

  const tasks: Promise<any>[] = [];
  const dispatch = new Set(plan.dispatch);

  const results: { kyc_summary?: any; anomaly_report?: any; case_search_result?: any } = {};

  if (dispatch.has("kyc_retriever")) {
    tasks.push(
      kycRetriever(body.customer_id).then(async ({ result, tokens }) => {
        results.kyc_summary = result;
        await appendAudit(correlationId, "kyc_retriever_agent", "AGENT_CALL", { case_id: caseId, output: result, token_usage: tokens });
      })
    );
  }
  if (dispatch.has("transaction_analyzer")) {
    tasks.push(
      transactionAnalyzer(body.account_id, body.flagged_transaction_id).then(async ({ result, tokens }) => {
        results.anomaly_report = result;
        await appendAudit(correlationId, "transaction_analyzer_agent", "AGENT_CALL", { case_id: caseId, output: result, token_usage: tokens });
      })
    );
  }
  if (dispatch.has("fraud_case_search")) {
    tasks.push(
      fraudCaseSearch(caseId, maskedText, body.metadata_filter).then(async ({ result, tokens }) => {
        results.case_search_result = result;
        await appendAudit(correlationId, "fraud_case_search_agent", "AGENT_CALL", { case_id: caseId, output: result, token_usage: tokens });
      })
    );
  }

  // Parallel fan-out (the "swarm"), joined here -- same join semantics as
  // the orchestrator's result-consumer threads in the reference build.
  await Promise.all(tasks);
  await appendAudit(correlationId, "orchestrator", "ALL_AGENTS_COMPLETE", { case_id: caseId });

  const stubKyc = { evidence: [], sanctions_status: "NO_HIT", identity_score: 50, customer_id: body.customer_id, kyc_risk_rating: "MEDIUM", sanctions_matches: [], notes: "not run" };
  const stubAnomaly = { evidence: [], anomaly_score: 0, account_id: body.account_id, patterns: [], notes: "not run" };
  const stubSearch = { evidence: [], matches: [], query_case_id: caseId, notes: "not run" };

  const { result: report, tokens: reportTokens } = await reportGenerator(
    caseId,
    results.kyc_summary || stubKyc,
    results.anomaly_report || stubAnomaly,
    results.case_search_result || stubSearch
  );

  await updateCaseReport(caseId, report);
  await appendAudit(correlationId, "report_generator_agent", "AGENT_CALL", { case_id: caseId, output: report, token_usage: reportTokens });
  await appendAudit(correlationId, "report_generator_agent", "REPORT_FINALIZED", { case_id: caseId, fraud_probability: (report as any).fraud_probability, recommended_action: (report as any).recommended_action });
  await appendAudit(correlationId, "orchestrator", "INVESTIGATION_COMPLETE", { case_id: caseId });

  return NextResponse.json({ case_id: caseId, status: "PENDING_REVIEW" });
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkApiKey } from "@/lib/auth";
import { getCase, updateCaseVerdict, appendAudit, writeBackResolvedCase } from "@/lib/db";
import { embed } from "@/lib/embeddings";

const VerdictSchema = z.object({
  verdict: z.string().min(1).max(32),
  notes: z.string().max(2000).default(""),
  fraud_type: z.string().max(64).optional(),
  amount_bracket: z.string().max(32).optional(),
  channel: z.string().max(32).optional(),
  geography: z.string().max(32).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authError = checkApiKey(req);
  if (authError) return authError;

  let body;
  try {
    body = VerdictSchema.parse(await req.json());
  } catch (e: any) {
    return NextResponse.json({ detail: "invalid request body", errors: e.errors || String(e) }, { status: 422 });
  }

  const caseId = params.id;
  const existing = await getCase(caseId);
  if (!existing) return NextResponse.json({ detail: "case not found" }, { status: 404 });

  const applied = await updateCaseVerdict(caseId, body.verdict, body.notes);
  if (!applied) {
    return NextResponse.json(
      { detail: "case already resolved", case_id: caseId, status: existing.status },
      { status: 409 }
    );
  }

  const report = existing.report_json || {};
  const narrative = (typeof report === "object" && report?.narrative) || body.notes || caseId;
  const vector = await embed(narrative);

  await writeBackResolvedCase({
    case_id: caseId,
    narrative,
    embedding: vector,
    fraud_type: body.fraud_type || "UNSPECIFIED",
    amount_bracket: body.amount_bracket || "UNKNOWN",
    channel: body.channel || "UNKNOWN",
    geography: body.geography || "UNKNOWN",
    resolution_date: new Date().toISOString().slice(0, 10),
    analyst_verdict: body.verdict,
  });

  await appendAudit(caseId, "api_gateway", "ANALYST_VERDICT", { case_id: caseId, verdict: body.verdict, notes: body.notes });

  return NextResponse.json({ case_id: caseId, status: "resolved" });
}

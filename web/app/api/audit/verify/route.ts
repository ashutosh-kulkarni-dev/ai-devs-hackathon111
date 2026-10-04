import { NextResponse } from "next/server";
import { verifyAuditChain } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await verifyAuditChain();
  return NextResponse.json(result);
}

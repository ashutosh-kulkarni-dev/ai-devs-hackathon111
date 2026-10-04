import { NextResponse } from "next/server";
import { listCases } from "@/lib/db";

// Next.js would otherwise prerender this GET at build time (when the DB is
// empty) and serve that same empty JSON forever. force-dynamic opts out.
export const dynamic = "force-dynamic";

export async function GET() {
  const cases = await listCases();
  return NextResponse.json({ cases });
}

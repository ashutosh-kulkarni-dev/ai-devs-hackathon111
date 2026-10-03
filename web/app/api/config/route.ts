import { NextResponse } from "next/server";

/**
 * Reports which capabilities are configured in this deployment.
 * The dashboard uses this to decide whether to show the "DEMO MODE" banner:
 * when GROQ_API_KEY is absent, every agent falls back to deterministic
 * mock output and visitors should know they're not seeing real LLM calls.
 */
export async function GET() {
  return NextResponse.json({
    demo_mode: !process.env.GROQ_API_KEY,
    has_lyzr: !!process.env.LYZR_API_KEY,
    has_postgres: !!process.env.POSTGRES_URL,
    has_qdrant: !!process.env.QDRANT_URL,
  });
}

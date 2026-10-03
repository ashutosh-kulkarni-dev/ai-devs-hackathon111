import { NextRequest, NextResponse } from "next/server";

// Simple per-IP token bucket (per serverless instance — not a cluster-wide
// limit, but enough to blunt casual abuse of the LLM-fanout endpoints on a
// public URL). For production use a shared store (Upstash, Redis).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
declare global { var _fi_rate: Map<string, { count: number; resetAt: number }>; }
if (!global._fi_rate) global._fi_rate = new Map();
const rateBuckets = global._fi_rate;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin") || req.headers.get("referer") || "";
  const host = req.headers.get("host") || "";
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Authorize a write request.
 *
 * - Same-origin browser calls from the dashboard are allowed (no secret
 *   needs to ride in the browser bundle — the previous NEXT_PUBLIC_* key
 *   was security theater, since anyone could read it in devtools).
 * - External callers (curl, scripts, other services) must present
 *   `x-api-key: $API_GATEWAY_KEY`. If `API_GATEWAY_KEY` is unset, external
 *   access is refused outright — we never fall back to a published default.
 * - Per-IP rate limit protects LLM-fanout endpoints from cost amplification.
 */
export function checkApiKey(req: NextRequest): NextResponse | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ detail: "rate limit exceeded" }, { status: 429 });
  }

  if (sameOrigin(req)) return null;

  const expected = process.env.API_GATEWAY_KEY;
  if (!expected) {
    return NextResponse.json(
      { detail: "external API access disabled: API_GATEWAY_KEY not configured" },
      { status: 401 }
    );
  }
  const provided = req.headers.get("x-api-key");
  if (provided !== expected) {
    return NextResponse.json({ detail: "invalid or missing X-API-Key" }, { status: 401 });
  }
  return null;
}

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { checkApiKey } from "@/lib/auth";

function mkReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://example.com/api/alerts", {
    method: "POST",
    headers: new Headers(headers),
  });
}

describe("checkApiKey", () => {
  beforeEach(() => {
    delete process.env.API_GATEWAY_KEY;
    // reset the rate bucket between tests
    (globalThis as any)._fi_rate = new Map();
  });

  it("allows same-origin browser call with no API key configured", () => {
    const req = mkReq({ origin: "http://example.com", host: "example.com" });
    expect(checkApiKey(req)).toBeNull();
  });

  it("rejects cross-origin call when API_GATEWAY_KEY is unset", async () => {
    const req = mkReq({ origin: "http://attacker.com", host: "example.com" });
    const res = checkApiKey(req);
    expect(res?.status).toBe(401);
    const body = await res!.json();
    expect(body.detail).toMatch(/API_GATEWAY_KEY not configured/);
  });

  it("accepts cross-origin call with matching X-API-Key", () => {
    process.env.API_GATEWAY_KEY = "secret-123";
    const req = mkReq({ origin: "http://script.local", host: "example.com", "x-api-key": "secret-123" });
    expect(checkApiKey(req)).toBeNull();
  });

  it("rejects cross-origin call with wrong X-API-Key", () => {
    process.env.API_GATEWAY_KEY = "secret-123";
    const req = mkReq({ origin: "http://script.local", host: "example.com", "x-api-key": "wrong" });
    expect(checkApiKey(req)?.status).toBe(401);
  });

  it("rate limits after 20 requests in a minute", () => {
    const headers = { origin: "http://example.com", host: "example.com", "x-forwarded-for": "1.2.3.4" };
    for (let i = 0; i < 20; i++) expect(checkApiKey(mkReq(headers))).toBeNull();
    expect(checkApiKey(mkReq(headers))?.status).toBe(429);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  insertCase, updateCaseReport, updateCaseVerdict, getCase,
  appendAudit, getAuditForCase, verifyAuditChain,
} from "@/lib/db";

describe("case lifecycle (in-memory)", () => {
  beforeEach(() => {
    (globalThis as any)._fi_cases = new Map();
    (globalThis as any)._fi_audit = [];
    (globalThis as any)._fi_memory = [];
  });

  it("inserts a case in IN_PROGRESS and lets a report move it to PENDING_REVIEW", async () => {
    await insertCase("C1", "CUST-1", "ACC-1");
    const applied = await updateCaseReport("C1", { fraud_probability: 60 });
    expect(applied).toBe(true);
    const c = await getCase("C1");
    expect(c.status).toBe("PENDING_REVIEW");
    expect(c.fraud_probability).toBe(60);
  });

  it("rejects a verdict on an already-resolved case (terminal-state guard)", async () => {
    await insertCase("C2", "CUST-2", "ACC-2");
    await updateCaseReport("C2", { fraud_probability: 70 });
    const first = await updateCaseVerdict("C2", "CONFIRMED_FRAUD", "clear case");
    const second = await updateCaseVerdict("C2", "FALSE_POSITIVE", "oops");
    expect(first).toBe(true);
    expect(second).toBe(false);
    const c = await getCase("C2");
    expect(c.status).toBe("CONFIRMED_FRAUD");
    expect(c.analyst_notes).toBe("clear case");
  });

  it("does not overwrite a resolved case with a reprocessed report", async () => {
    await insertCase("C3", "CUST-3", "ACC-3");
    await updateCaseReport("C3", { fraud_probability: 70 });
    await updateCaseVerdict("C3", "FALSE_POSITIVE", "cleared");
    const reapplied = await updateCaseReport("C3", { fraud_probability: 95 });
    expect(reapplied).toBe(false);
    const c = await getCase("C3");
    expect(c.status).toBe("FALSE_POSITIVE");
  });
});

describe("audit chain", () => {
  beforeEach(() => {
    (globalThis as any)._fi_audit = [];
  });

  it("produces a verifiable hash chain for sequential appends", async () => {
    await appendAudit("CORR-1", "api", "A", { v: 1 });
    await appendAudit("CORR-1", "api", "B", { v: 2 });
    await appendAudit("CORR-1", "api", "C", { v: 3 });
    const chain = await verifyAuditChain();
    expect(chain.valid).toBe(true);
    expect(chain.entries_checked).toBe(3);
  });

  it("detects tampering: mutating a payload breaks the chain", async () => {
    await appendAudit("CORR-2", "api", "A", { v: 1 });
    await appendAudit("CORR-2", "api", "B", { v: 2 });
    const rows = await getAuditForCase("CORR-2");
    rows[0].payload = { v: 999 };
    const chain = await verifyAuditChain();
    expect(chain.valid).toBe(false);
    expect(chain.broken_at_seq).toBeDefined();
  });
});

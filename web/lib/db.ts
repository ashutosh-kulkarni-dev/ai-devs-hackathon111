/**
 * Storage layer for the Vercel deployment.
 *
 * Uses @neondatabase/serverless (the current client — the older
 * @vercel/postgres package was deprecated in favour of a direct Neon
 * integration). Set POSTGRES_URL (or DATABASE_URL) from the Vercel
 * dashboard: Storage tab -> Create Database -> Neon.
 *
 * If no connection string is present (e.g. local `next dev` without
 * configuring storage), falls back to a per-process in-memory store.
 * That's fine for a quick local click-through but will NOT persist
 * across serverless invocations in a real Vercel deployment -- configure
 * Neon before sharing a public demo link.
 */
import { neon } from "@neondatabase/serverless";

const CONN = process.env.POSTGRES_URL || process.env.DATABASE_URL;
export const HAS_POSTGRES = !!CONN;

// `fullResults: true` makes queries resolve to `{ rows, rowCount, ... }`,
// matching the deprecated @vercel/postgres shape so existing call sites
// (`.rows`, `.rowCount`) keep working.
// Lazy so an unconfigured deployment doesn't crash at module load.
let _sql: ReturnType<typeof neon> | null = null;
function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<any> {
  if (!_sql) {
    if (!CONN) throw new Error("POSTGRES_URL / DATABASE_URL not set");
    _sql = neon(CONN, { fullResults: true });
  }
  return (_sql as any)(strings, ...values);
}

// ---- in-memory fallback (dev only, single-process) ----
// Stored on globalThis so all Next.js route-handler module instances share
// the same Map — module-level vars get separate instances per route bundle.
type MemCase = Record<string, any>;
declare global { var _fi_cases: Map<string, MemCase>; var _fi_audit: MemCase[]; var _fi_memory: MemCase[]; }
if (!global._fi_cases)  global._fi_cases  = new Map<string, MemCase>();
if (!global._fi_audit)  global._fi_audit  = [];
if (!global._fi_memory) global._fi_memory = [];
const memCases  = global._fi_cases;
const memAudit  = global._fi_audit;
const memMemory = global._fi_memory;


let initialized = false;

export async function ensureSchema() {
  if (!HAS_POSTGRES || initialized) return;
  await sql`
    CREATE TABLE IF NOT EXISTS investigation_cases (
      case_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      fraud_probability INTEGER,
      report_json JSONB,
      analyst_verdict TEXT,
      analyst_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      seq BIGSERIAL PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS fraud_case_memory (
      id SERIAL PRIMARY KEY,
      case_id TEXT NOT NULL,
      narrative TEXT NOT NULL,
      embedding JSONB NOT NULL,
      fraud_type TEXT NOT NULL,
      amount_bracket TEXT NOT NULL,
      channel TEXT NOT NULL,
      geography TEXT NOT NULL,
      resolution_date TEXT NOT NULL,
      analyst_verdict TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  initialized = true;
}

export async function insertCase(caseId: string, customerId: string, accountId: string) {
  if (HAS_POSTGRES) {
    await ensureSchema();
    await sql`
      INSERT INTO investigation_cases (case_id, customer_id, account_id, status)
      VALUES (${caseId}, ${customerId}, ${accountId}, 'IN_PROGRESS')
      ON CONFLICT (case_id) DO NOTHING;
    `;
  } else {
    memCases.set(caseId, {
      case_id: caseId, customer_id: customerId, account_id: accountId,
      status: "IN_PROGRESS", fraud_probability: null, report_json: null,
      analyst_verdict: null, analyst_notes: null, created_at: new Date().toISOString(),
      resolved_at: null,
    });
  }
}

const TERMINAL = new Set(["CONFIRMED_FRAUD", "FALSE_POSITIVE"]);

// Terminal-state guard: a reprocessed report (e.g. from a retried request)
// must not overwrite an analyst's resolution. Matches services/ semantics.
export async function updateCaseReport(caseId: string, report: any): Promise<boolean> {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rowCount } = await sql`
      UPDATE investigation_cases
      SET status = 'PENDING_REVIEW', fraud_probability = ${report.fraud_probability}, report_json = ${JSON.stringify(report)}
      WHERE case_id = ${caseId} AND status NOT IN ('CONFIRMED_FRAUD', 'FALSE_POSITIVE');
    `;
    return (rowCount ?? 0) > 0;
  }
  const c = memCases.get(caseId);
  if (!c || TERMINAL.has(c.status)) return false;
  c.status = "PENDING_REVIEW";
  c.fraud_probability = report.fraud_probability;
  c.report_json = report;
  return true;
}

export async function updateCaseVerdict(caseId: string, verdict: string, notes: string): Promise<boolean> {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rowCount } = await sql`
      UPDATE investigation_cases
      SET status = ${verdict}, analyst_verdict = ${verdict}, analyst_notes = ${notes}, resolved_at = now()
      WHERE case_id = ${caseId} AND status NOT IN ('CONFIRMED_FRAUD', 'FALSE_POSITIVE');
    `;
    return (rowCount ?? 0) > 0;
  }
  const c = memCases.get(caseId);
  if (!c || TERMINAL.has(c.status)) return false;
  c.status = verdict;
  c.analyst_verdict = verdict;
  c.analyst_notes = notes;
  c.resolved_at = new Date().toISOString();
  return true;
}

export async function listCases() {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rows } = await sql`
      SELECT case_id, customer_id, account_id, status, fraud_probability, analyst_verdict, created_at, resolved_at
      FROM investigation_cases ORDER BY created_at DESC LIMIT 200;
    `;
    return rows;
  }
  return [...memCases.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map(({ report_json, analyst_notes, ...rest }) => rest);
}

export async function getCase(caseId: string) {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rows } = await sql`SELECT * FROM investigation_cases WHERE case_id = ${caseId};`;
    return rows[0] || null;
  }
  return memCases.get(caseId) || null;
}

export async function appendAudit(correlationId: string, actor: string, eventType: string, payload: any) {
  const crypto = await import("node:crypto");
  const hashRow = (prevHash: string, createdAt: string) =>
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ prevHash, correlationId, actor, eventType, payload, createdAt }))
      .digest("hex");

  const createdAt = new Date().toISOString();

  if (HAS_POSTGRES) {
    await ensureSchema();
    // Serialize chain-tip read + insert with a session-level advisory lock so
    // concurrent serverless invocations can't both read the same prev_hash
    // and produce a broken chain that verifyAuditChain() would then flag as
    // tampered. 0xA0D17 is an arbitrary namespace constant for this chain.
    await sql`SELECT pg_advisory_lock(658199);`;
    try {
      const { rows } = await sql`SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1;`;
      const prevHash = rows[0]?.entry_hash || "0".repeat(64);
      const entryHash = hashRow(prevHash, createdAt);
      await sql`
        INSERT INTO audit_log (correlation_id, actor, event_type, payload, prev_hash, entry_hash, created_at)
        VALUES (${correlationId}, ${actor}, ${eventType}, ${JSON.stringify(payload)}, ${prevHash}, ${entryHash}, ${createdAt});
      `;
      return entryHash;
    } finally {
      await sql`SELECT pg_advisory_unlock(658199);`;
    }
  }
  const prevHash = memAudit.length ? memAudit[memAudit.length - 1].entry_hash : "0".repeat(64);
  const entryHash = hashRow(prevHash, createdAt);
  memAudit.push({ correlation_id: correlationId, actor, event_type: eventType, payload, prev_hash: prevHash, entry_hash: entryHash, created_at: createdAt, seq: memAudit.length + 1 });
  return entryHash;
}

export async function getAuditForCase(correlationId: string) {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rows } = await sql`SELECT * FROM audit_log WHERE correlation_id = ${correlationId} ORDER BY seq ASC;`;
    return rows;
  }
  return memAudit.filter((r) => r.correlation_id === correlationId);
}

export async function verifyAuditChain() {
  const crypto = await import("node:crypto");
  const hashRow = (prevHash: string, correlationId: string, actor: string, eventType: string, payload: any, createdAt: string) =>
    crypto
      .createHash("sha256")
      .update(JSON.stringify({ prevHash, correlationId, actor, eventType, payload, createdAt }))
      .digest("hex");

  let rows: any[];
  if (HAS_POSTGRES) {
    await ensureSchema();
    rows = (await sql`SELECT * FROM audit_log ORDER BY seq ASC;`).rows;
  } else {
    rows = memAudit;
  }

  let prevHash = "0".repeat(64);
  for (const row of rows) {
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    const expected = hashRow(prevHash, row.correlation_id, row.actor, row.event_type, row.payload, createdAt);
    if (row.prev_hash !== prevHash || row.entry_hash !== expected) {
      return { valid: false, broken_at_seq: row.seq, reason: "hash mismatch: row payload or chain link has been altered" };
    }
    prevHash = row.entry_hash;
  }
  return { valid: true, entries_checked: rows.length };
}

export async function writeBackResolvedCase(entry: {
  case_id: string; narrative: string; embedding: number[]; fraud_type: string;
  amount_bracket: string; channel: string; geography: string; resolution_date: string; analyst_verdict: string;
}) {
  // Always write to Qdrant when available (primary vector store)
  const { upsertCase, HAS_QDRANT } = await import("./qdrant");
  if (HAS_QDRANT) await upsertCase(entry);

  if (HAS_POSTGRES) {
    await ensureSchema();
    await sql`
      INSERT INTO fraud_case_memory (case_id, narrative, embedding, fraud_type, amount_bracket, channel, geography, resolution_date, analyst_verdict)
      VALUES (${entry.case_id}, ${entry.narrative}, ${JSON.stringify(entry.embedding)}, ${entry.fraud_type},
              ${entry.amount_bracket}, ${entry.channel}, ${entry.geography}, ${entry.resolution_date}, ${entry.analyst_verdict});
    `;
  } else if (!HAS_QDRANT) {
    memMemory.push({ ...entry, id: memMemory.length + 1 });
  }
}

export async function listMemoryCases() {
  if (HAS_POSTGRES) {
    await ensureSchema();
    const { rows } = await sql`SELECT * FROM fraud_case_memory ORDER BY id ASC;`;
    return rows;
  }
  return memMemory;
}

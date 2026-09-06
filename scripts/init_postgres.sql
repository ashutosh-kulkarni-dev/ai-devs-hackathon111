-- Transaction History DB (Cloud Spanner substitute for local dev)
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id      TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL,
    customer_id         TEXT NOT NULL,
    amount              NUMERIC(18,2) NOT NULL,
    currency             TEXT NOT NULL DEFAULT 'USD',
    channel             TEXT NOT NULL,          -- Wire, ACH, Card, UPI, etc.
    counterparty        TEXT,
    geography           TEXT,
    transaction_ts       TIMESTAMPTZ NOT NULL,
    flagged             BOOLEAN NOT NULL DEFAULT FALSE,
    flag_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);

-- Investigation Case DB
CREATE TABLE IF NOT EXISTS investigation_cases (
    case_id             TEXT PRIMARY KEY,
    customer_id         TEXT NOT NULL,
    account_id          TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- IN_PROGRESS, PENDING_REVIEW, CONFIRMED_FRAUD, FALSE_POSITIVE
    fraud_probability    NUMERIC(5,2),
    report_json         JSONB,
    analyst_verdict      TEXT,
    analyst_notes        TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at          TIMESTAMPTZ
);

-- Immutable, hash-chained Audit & Compliance Log
-- (local substitute for a BigQuery insert-only table with CMEK in production)
CREATE TABLE IF NOT EXISTS audit_log (
    seq                 BIGSERIAL PRIMARY KEY,
    correlation_id      TEXT NOT NULL,
    actor               TEXT NOT NULL,          -- agent/service name
    event_type          TEXT NOT NULL,          -- e.g. AGENT_CALL, PII_DEMASK, VERDICT
    payload             JSONB NOT NULL,
    prev_hash           TEXT NOT NULL,
    entry_hash          TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No UPDATE/DELETE grants issued to application roles by design;
-- application only ever INSERTs into audit_log.

-- Single-row high-water mark for the audit chain tip (Phase 5, plan_3.md).
-- Updated in the same transaction as every audit_log insert. /verify
-- compares this against whatever rows are actually visible, so deleting
-- the newest N audit_log rows is detected even though the remaining chain
-- still links up cleanly on its own.
CREATE TABLE IF NOT EXISTS audit_checkpoint (
    id          BOOLEAN PRIMARY KEY DEFAULT true,
    latest_seq  BIGINT NOT NULL DEFAULT 0,
    latest_hash TEXT NOT NULL DEFAULT repeat('0', 64),
    CONSTRAINT audit_checkpoint_singleton CHECK (id)
);
INSERT INTO audit_checkpoint (id, latest_seq, latest_hash)
VALUES (true, 0, repeat('0', 64))
ON CONFLICT (id) DO NOTHING;

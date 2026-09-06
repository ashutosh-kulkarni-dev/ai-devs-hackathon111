"""
Immutable Audit & Compliance Log service.

Production target: BigQuery insert-only table, CMEK-encrypted, with
Cloud Audit Logs covering access. For the hackathon build we implement
a hash-chained, append-only Postgres table: every row embeds the SHA-256
hash of the previous row plus its own payload, so any historical tampering
breaks the chain and is detectable with GET /verify.

This gives judges something they can literally break and watch fail,
rather than a claim that "BigQuery is configured as immutable."
"""
import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="Audit & Compliance Log", version="1.0.0")

DB_CONF = dict(
    host=os.environ.get("POSTGRES_HOST", "localhost"),
    port=int(os.environ.get("POSTGRES_PORT", 5432)),
    dbname=os.environ.get("POSTGRES_DB", "fraud_investigator"),
    user=os.environ.get("POSTGRES_USER", "fraud_admin"),
    password=os.environ.get("POSTGRES_PASSWORD", "changeme_local_dev"),
)

GENESIS_HASH = "0" * 64


def get_conn():
    return psycopg2.connect(**DB_CONF)


class AuditEntry(BaseModel):
    correlation_id: str
    actor: str
    event_type: str
    payload: dict


def _hash_row(prev_hash: str, correlation_id: str, actor: str, event_type: str,
              payload: dict, created_at: str) -> str:
    material = json.dumps(
        {
            "prev_hash": prev_hash,
            "correlation_id": correlation_id,
            "actor": actor,
            "event_type": event_type,
            "payload": payload,
            "created_at": created_at,
        },
        sort_keys=True,
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


@app.post("/log")
def append_entry(entry: AuditEntry):
    created_at = datetime.now(timezone.utc).isoformat()
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
            row = cur.fetchone()
            prev_hash = row[0] if row else GENESIS_HASH

            entry_hash = _hash_row(
                prev_hash, entry.correlation_id, entry.actor, entry.event_type,
                entry.payload, created_at,
            )

            cur.execute(
                """
                INSERT INTO audit_log
                    (correlation_id, actor, event_type, payload, prev_hash, entry_hash, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING seq
                """,
                (entry.correlation_id, entry.actor, entry.event_type,
                 psycopg2.extras.Json(entry.payload), prev_hash, entry_hash, created_at),
            )
            seq = cur.fetchone()[0]

            # Anchor the chain tip in the same transaction as the row insert
            # (Phase 5, plan_3.md): /verify checks this checkpoint against
            # whatever rows are actually visible, so deleting the newest N
            # rows is detected even though the remaining chain still links
            # up cleanly on its own.
            cur.execute(
                """
                INSERT INTO audit_checkpoint (id, latest_seq, latest_hash)
                VALUES (true, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET latest_seq = EXCLUDED.latest_seq, latest_hash = EXCLUDED.latest_hash
                """,
                (seq, entry_hash),
            )
        conn.commit()
        return {"seq": seq, "entry_hash": entry_hash, "prev_hash": prev_hash}
    finally:
        conn.close()


@app.get("/log/{correlation_id}")
def get_case_log(correlation_id: str):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM audit_log WHERE correlation_id = %s ORDER BY seq ASC",
                (correlation_id,),
            )
            return {"entries": cur.fetchall()}
    finally:
        conn.close()


@app.get("/verify")
def verify_chain(limit: Optional[int] = 10000):
    """Recomputes the hash chain from genesis and reports the first break, if any.

    This is the "live proof" of immutability judges can run in the demo:
    tamper a payload directly in Postgres, call /verify, watch it fail at
    the exact tampered row.

    Recomputing over whatever rows currently exist catches edits, but not
    deleting the newest N rows (the remaining chain still links up cleanly).
    So this also checks the recorded `audit_checkpoint` high-water mark
    (written in the same transaction as every /log insert) against the tip
    of what's actually visible -- a mismatch means rows were deleted after
    being logged.
    """
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM audit_log ORDER BY seq ASC LIMIT %s", (limit,))
            rows = cur.fetchall()
            cur.execute("SELECT latest_seq, latest_hash FROM audit_checkpoint WHERE id = true")
            checkpoint = cur.fetchone()

        prev_hash = GENESIS_HASH
        for row in rows:
            expected = _hash_row(
                prev_hash, row["correlation_id"], row["actor"], row["event_type"],
                row["payload"], row["created_at"].isoformat(),
            )
            if row["prev_hash"] != prev_hash or row["entry_hash"] != expected:
                return {
                    "valid": False,
                    "broken_at_seq": row["seq"],
                    "reason": "hash mismatch: row payload or chain link has been altered",
                }
            prev_hash = row["entry_hash"]

        checkpoint_seq = checkpoint["latest_seq"] if checkpoint else 0
        checkpoint_hash = checkpoint["latest_hash"] if checkpoint else GENESIS_HASH
        visible_tip_seq = rows[-1]["seq"] if rows else 0
        visible_tip_hash = rows[-1]["entry_hash"] if rows else GENESIS_HASH

        # Only trustworthy when we actually saw every row up to the tip --
        # if `limit` capped the fetch, we can't tell truncation from paging.
        if len(rows) < limit and (visible_tip_seq != checkpoint_seq or visible_tip_hash != checkpoint_hash):
            return {
                "valid": False,
                "reason": "chain truncated: the recorded checkpoint tip is newer than the "
                          "newest row currently visible (rows were deleted after being logged)",
                "expected_seq": checkpoint_seq,
                "visible_tip_seq": visible_tip_seq,
            }

        return {"valid": True, "entries_checked": len(rows), "checkpoint_seq": checkpoint_seq}
    finally:
        conn.close()


@app.get("/healthz")
def health():
    return {"status": "ok"}

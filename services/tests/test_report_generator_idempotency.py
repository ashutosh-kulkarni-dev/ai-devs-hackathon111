"""Phase 4 test (plan_3.md): report generator's persisted status can't
regress a resolved case.

Runs `_persist_case` unmodified against a real SQLite database (its
`INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` upsert-guard SQL behaves
identically on SQLite and Postgres) via a thin psycopg2-call-shape shim, so
this is a genuine behavioural test of the guard, not just a check that the
right substring is in the query text.
"""
import json
import sqlite3

import pytest
from load_service import load_module


class _SqliteCursorShim:
    """Translates the one psycopg2-style call `_persist_case` makes
    (`%s` placeholders, a trailing tuple param for `NOT IN %s`) onto sqlite3."""

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query: str, params=()):
        sqlite_query = query.replace("%s", "?")
        if params and isinstance(params[-1], tuple):
            *head, tail_tuple = params
            placeholders = ", ".join("?" for _ in tail_tuple)
            sqlite_query = sqlite_query.replace("NOT IN ?", f"NOT IN ({placeholders})")
            params = tuple(head) + tail_tuple
        self._conn.execute(sqlite_query, params)


class _SqliteConnShim:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def cursor(self):
        return _SqliteCursorShim(self._conn)

    def commit(self):
        self._conn.commit()

    def close(self):
        pass  # the fixture owns the real sqlite3 connection's lifecycle


@pytest.fixture
def report_generator_agent(monkeypatch):
    module = load_module("report_generator_agent", "agents/report_generator/agent.py")

    sqlite_conn = sqlite3.connect(":memory:")
    sqlite_conn.execute("""
        CREATE TABLE investigation_cases (
            case_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
            fraud_probability REAL,
            report_json TEXT,
            analyst_verdict TEXT,
            analyst_notes TEXT
        )
    """)

    monkeypatch.setattr(module.psycopg2, "connect", lambda **kwargs: _SqliteConnShim(sqlite_conn))
    module._test_sqlite_conn = sqlite_conn
    return module


def _row(conn, case_id):
    cur = conn.execute(
        "SELECT status, fraud_probability, report_json, analyst_verdict FROM investigation_cases WHERE case_id = ?",
        (case_id,),
    )
    return cur.fetchone()


def test_replaying_report_task_for_resolved_case_is_a_noop(report_generator_agent):
    conn = report_generator_agent._test_sqlite_conn
    conn.execute(
        "INSERT INTO investigation_cases (case_id, customer_id, account_id, status, fraud_probability, "
        "report_json, analyst_verdict) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("CASE-1", "CUST-1", "ACC-1", "CONFIRMED_FRAUD", 92.0, json.dumps({"old": "report"}), "CONFIRMED_FRAUD"),
    )
    conn.commit()

    # Reprocessing the same report task after the analyst already resolved the case.
    report_generator_agent._persist_case(
        "CASE-1", "CUST-1", "ACC-1",
        {"fraud_probability": 10, "narrative": "reprocessed, would have said low risk"},
    )

    status, fraud_probability, report_json, analyst_verdict = _row(conn, "CASE-1")
    assert status == "CONFIRMED_FRAUD"
    assert analyst_verdict == "CONFIRMED_FRAUD"
    assert fraud_probability == 92.0
    assert json.loads(report_json) == {"old": "report"}


def test_replaying_report_task_for_false_positive_case_is_a_noop(report_generator_agent):
    conn = report_generator_agent._test_sqlite_conn
    conn.execute(
        "INSERT INTO investigation_cases (case_id, customer_id, account_id, status, fraud_probability, "
        "report_json, analyst_verdict) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("CASE-2", "CUST-1", "ACC-1", "FALSE_POSITIVE", 5.0, json.dumps({"old": "report"}), "FALSE_POSITIVE"),
    )
    conn.commit()

    report_generator_agent._persist_case(
        "CASE-2", "CUST-1", "ACC-1", {"fraud_probability": 88, "narrative": "reprocessed"},
    )

    status, fraud_probability, _, analyst_verdict = _row(conn, "CASE-2")
    assert status == "FALSE_POSITIVE"
    assert analyst_verdict == "FALSE_POSITIVE"
    assert fraud_probability == 5.0


def test_persist_still_updates_a_non_terminal_case(report_generator_agent):
    conn = report_generator_agent._test_sqlite_conn
    conn.execute(
        "INSERT INTO investigation_cases (case_id, customer_id, account_id, status, fraud_probability) "
        "VALUES (?, ?, ?, ?, ?)",
        ("CASE-3", "CUST-1", "ACC-1", "IN_PROGRESS", None),
    )
    conn.commit()

    report_generator_agent._persist_case(
        "CASE-3", "CUST-1", "ACC-1", {"fraud_probability": 77, "narrative": "first report"},
    )

    status, fraud_probability, report_json, _ = _row(conn, "CASE-3")
    assert status == "PENDING_REVIEW"
    assert fraud_probability == 77.0
    assert json.loads(report_json)["fraud_probability"] == 77


def test_persist_inserts_a_brand_new_case(report_generator_agent):
    conn = report_generator_agent._test_sqlite_conn

    report_generator_agent._persist_case(
        "CASE-NEW", "CUST-1", "ACC-1", {"fraud_probability": 55, "narrative": "first report"},
    )

    status, fraud_probability, _, _ = _row(conn, "CASE-NEW")
    assert status == "PENDING_REVIEW"
    assert fraud_probability == 55.0

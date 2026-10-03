"""Phase 5 test (plan_3.md): /verify detects truncation (deleted newest
rows), not just edited-row tampering.

Exercises the real `verify_chain` function with a fake DB cursor returning
canned rows/checkpoint, built with the module's own `_hash_row` so the
chain-linkage math is genuine -- only the DB round trip is faked.
"""
from datetime import datetime, timezone

import pytest
from load_service import load_module


@pytest.fixture
def audit_module():
    return load_module("audit_log_service", "audit_log/audit.py")


class _FakeCursor:
    def __init__(self, results_queue):
        self._results_queue = list(results_queue)
        self._last = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        self._last = self._results_queue.pop(0)

    def fetchall(self):
        return self._last

    def fetchone(self):
        return self._last


class _FakeConn:
    def __init__(self, results_queue):
        self._results_queue = results_queue

    def cursor(self, cursor_factory=None):
        return _FakeCursor(self._results_queue)

    def close(self):
        pass


def _build_chain(audit_module, n: int):
    """Build n genuinely-linked rows the same way append_entry would."""
    rows = []
    prev_hash = audit_module.GENESIS_HASH
    for i in range(1, n + 1):
        created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        correlation_id, actor, event_type, payload = f"CASE-{i}", "svc", "EVENT", {"i": i}
        entry_hash = audit_module._hash_row(
            prev_hash, correlation_id, actor, event_type, payload, created_at.isoformat(),
        )
        rows.append({
            "seq": i, "correlation_id": correlation_id, "actor": actor, "event_type": event_type,
            "payload": payload, "prev_hash": prev_hash, "entry_hash": entry_hash, "created_at": created_at,
        })
        prev_hash = entry_hash
    return rows


def test_verify_valid_when_checkpoint_matches_visible_tip(audit_module, monkeypatch):
    rows = _build_chain(audit_module, 5)
    checkpoint = {"latest_seq": 5, "latest_hash": rows[-1]["entry_hash"]}
    monkeypatch.setattr(audit_module, "get_conn", lambda: _FakeConn([rows, checkpoint]))

    result = audit_module.verify_chain(limit=10000)

    assert result["valid"] is True
    assert result["entries_checked"] == 5


def test_verify_detects_truncation_of_newest_rows(audit_module, monkeypatch):
    """The exact scenario the old /verify missed: delete the newest 2 rows
    directly in Postgres. The remaining 3-row chain still links up cleanly
    on its own -- only the checkpoint comparison catches this."""
    full_chain = _build_chain(audit_module, 5)
    checkpoint = {"latest_seq": 5, "latest_hash": full_chain[-1]["entry_hash"]}
    truncated_rows = full_chain[:3]  # newest 2 rows deleted
    monkeypatch.setattr(audit_module, "get_conn", lambda: _FakeConn([truncated_rows, checkpoint]))

    result = audit_module.verify_chain(limit=10000)

    assert result["valid"] is False
    assert "truncat" in result["reason"].lower()
    assert result["expected_seq"] == 5
    assert result["visible_tip_seq"] == 3


def test_verify_detects_deleting_all_rows(audit_module, monkeypatch):
    full_chain = _build_chain(audit_module, 3)
    checkpoint = {"latest_seq": 3, "latest_hash": full_chain[-1]["entry_hash"]}
    monkeypatch.setattr(audit_module, "get_conn", lambda: _FakeConn([[], checkpoint]))

    result = audit_module.verify_chain(limit=10000)

    assert result["valid"] is False
    assert result["visible_tip_seq"] == 0


def test_verify_still_detects_edited_row_tampering(audit_module, monkeypatch):
    rows = _build_chain(audit_module, 3)
    tampered = [dict(r) for r in rows]
    tampered[1]["payload"] = {"tampered": True}  # edit without recomputing the hash
    checkpoint = {"latest_seq": 3, "latest_hash": rows[-1]["entry_hash"]}
    monkeypatch.setattr(audit_module, "get_conn", lambda: _FakeConn([tampered, checkpoint]))

    result = audit_module.verify_chain(limit=10000)

    assert result["valid"] is False
    assert result["broken_at_seq"] == 2

"""Phase 2 tests (plan_3.md): PII masking fails closed.

`submit_alert` must reject the alert (503) rather than forward an unmasked
narrative when the PII masking service is unreachable -- and must never
call publish_json / touch Postgres on that path.
"""
import pytest
from fastapi.testclient import TestClient
from load_service import load_module


@pytest.fixture
def api_gateway(monkeypatch):
    module = load_module("api_gateway_main", "api_gateway/main.py")

    events = []
    monkeypatch.setattr(module, "log_event", lambda *a, **k: events.append((a, k)))
    module._test_events = events

    published = []
    monkeypatch.setattr(module, "publish_json", lambda topic, payload: published.append((topic, payload)))
    module._test_published = published

    return module


def _headers(module):
    return {"X-API-Key": module.API_KEY}


def test_masking_unavailable_rejects_with_503(api_gateway, monkeypatch):
    def dead_post(*args, **kwargs):
        raise ConnectionError("connection refused")

    monkeypatch.setattr(api_gateway.requests, "post", dead_post)
    client = TestClient(api_gateway.app)

    resp = client.post(
        "/alerts",
        headers=_headers(api_gateway),
        json={
            "customer_id": "CUST-1",
            "account_id": "ACC-1",
            "narrative": "Sensitive PII narrative that must never leak.",
        },
    )

    assert resp.status_code == 503
    # The narrative was never forwarded anywhere -- neither published to
    # Pub/Sub nor mentioned unmasked in any downstream call.
    assert api_gateway._test_published == []
    body = str(resp.json())
    assert "Sensitive PII narrative" not in body


def test_masking_unavailable_writes_audit_event(api_gateway, monkeypatch):
    monkeypatch.setattr(api_gateway.requests, "post",
                         lambda *a, **k: (_ for _ in ()).throw(ConnectionError("down")))
    client = TestClient(api_gateway.app)

    client.post(
        "/alerts",
        headers=_headers(api_gateway),
        json={"customer_id": "CUST-1", "account_id": "ACC-1", "narrative": "some PII here"},
    )

    event_types = [args[2] for args, _ in api_gateway._test_events]
    assert "ALERT_REJECTED_MASKING_UNAVAILABLE" in event_types


def test_masking_success_forwards_masked_narrative(api_gateway, monkeypatch):
    class _FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"masked_text": "contact [PERSON] about account"}

    monkeypatch.setattr(api_gateway.requests, "post", lambda *a, **k: _FakeResp())

    class _FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, *a, **k):
            pass

    class _FakeConn:
        def cursor(self):
            return _FakeCursor()

        def commit(self):
            pass

        def close(self):
            pass

    monkeypatch.setattr(api_gateway, "get_conn", lambda: _FakeConn())
    client = TestClient(api_gateway.app)

    resp = client.post(
        "/alerts",
        headers=_headers(api_gateway),
        json={"customer_id": "CUST-1", "account_id": "ACC-1", "narrative": "contact John Doe about account"},
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "IN_PROGRESS"
    assert len(api_gateway._test_published) == 1
    _, published_payload = api_gateway._test_published[0]
    assert published_payload["narrative"] == "contact [PERSON] about account"

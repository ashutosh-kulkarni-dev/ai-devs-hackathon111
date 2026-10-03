"""Small helper so every agent/service writes to the audit log the same way."""
import os

import requests

AUDIT_LOG_URL = os.environ.get("AUDIT_LOG_URL", "http://localhost:8030")


def log_event(correlation_id: str, actor: str, event_type: str, payload: dict):
    try:
        requests.post(
            f"{AUDIT_LOG_URL}/log",
            json={
                "correlation_id": correlation_id,
                "actor": actor,
                "event_type": event_type,
                "payload": payload,
            },
            timeout=5,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[audit] failed to log event: {exc}", flush=True)

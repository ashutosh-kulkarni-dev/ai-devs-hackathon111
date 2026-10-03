"""Phase 1 tests (plan_3.md): pubsub_client's ack-after-success contract.

Proves, with a pure in-memory fake (no emulator needed):
  (a) a handler exception does NOT ack the message,
  (b) that non-acked message is redelivered,
  (c) the Nth consecutive failure dead-letters the message and finally acks
      it so it stops looping.
"""
import pubsub_client
import pytest
from fake_pubsub import install_fake_pubsub


@pytest.fixture(autouse=True)
def _reset_worker_state(monkeypatch):
    """Each test gets a clean delivery-attempt counter and a captured, silent
    audit logger (no real network call to AUDIT_LOG_URL)."""
    monkeypatch.setattr(pubsub_client, "_attempt_counts", {})
    events = []
    monkeypatch.setattr(pubsub_client, "log_event", lambda *a, **k: events.append((a, k)))
    return events


def test_handler_exception_does_not_ack(monkeypatch):
    broker = install_fake_pubsub(monkeypatch, pubsub_client)
    topic = "test-topic"
    _, sub_path = pubsub_client.ensure_topic_and_subscription(topic)
    pubsub_client.ensure_topic_and_subscription(pubsub_client.dead_letter_topic_name(topic))
    pubsub_client.publish_json(topic, {"case_id": "CASE-1"})

    def boom(message):
        raise RuntimeError("handler blew up")

    result = pubsub_client.process_one(topic, boom)

    assert result == "nacked"
    # The message was never acknowledged -- it's back in the queue, not lost.
    assert broker.pending_count(sub_path) == 1


def test_redelivery_happens(monkeypatch):
    install_fake_pubsub(monkeypatch, pubsub_client)
    topic = "test-topic"
    pubsub_client.ensure_topic_and_subscription(topic)
    pubsub_client.ensure_topic_and_subscription(pubsub_client.dead_letter_topic_name(topic))
    pubsub_client.publish_json(topic, {"case_id": "CASE-1"})

    calls = []

    def flaky(message):
        calls.append(message)
        if len(calls) == 1:
            raise RuntimeError("first attempt fails")
        # second attempt (the redelivery) succeeds

    first = pubsub_client.process_one(topic, flaky)
    second = pubsub_client.process_one(topic, flaky)

    assert first == "nacked"
    assert second == "acked"
    assert len(calls) == 2
    # Both invocations saw the same message -- nothing was lost or duplicated in content.
    assert calls[0] == calls[1] == {"case_id": "CASE-1"}


def test_nth_failure_dead_letters_and_acks(monkeypatch):
    monkeypatch.setattr(pubsub_client, "MAX_DELIVERY_ATTEMPTS", 3)
    broker = install_fake_pubsub(monkeypatch, pubsub_client)
    topic = "test-topic"
    _, sub_path = pubsub_client.ensure_topic_and_subscription(topic)
    dead_letter_topic = pubsub_client.dead_letter_topic_name(topic)
    _, dl_sub_path = pubsub_client.ensure_topic_and_subscription(dead_letter_topic)
    pubsub_client.publish_json(topic, {"case_id": "CASE-POISON"})

    def always_fails(message):
        raise RuntimeError("permanently poisoned")

    results = [pubsub_client.process_one(topic, always_fails) for _ in range(3)]

    assert results == ["nacked", "nacked", "dead_lettered"]
    # It stopped looping: nothing left pending on the original subscription.
    assert broker.pending_count(sub_path) == 0
    # And it's visible on the dead-letter topic rather than having vanished
    # (payload contents are checked in the next test).
    assert broker.pending_count(dl_sub_path) == 1


def test_dead_letter_payload_contains_original_message_and_error(monkeypatch):
    monkeypatch.setattr(pubsub_client, "MAX_DELIVERY_ATTEMPTS", 1)
    install_fake_pubsub(monkeypatch, pubsub_client)
    topic = "test-topic"
    pubsub_client.ensure_topic_and_subscription(topic)
    dead_letter_topic = pubsub_client.dead_letter_topic_name(topic)
    pubsub_client.ensure_topic_and_subscription(dead_letter_topic)
    pubsub_client.publish_json(topic, {"case_id": "CASE-POISON"})

    def always_fails(message):
        raise ValueError("bad data")

    result = pubsub_client.process_one(topic, always_fails)
    assert result == "dead_lettered"

    pulled = pubsub_client.pull_one(dead_letter_topic)
    assert pulled is not None
    dead_letter_message, _ = pulled
    assert dead_letter_message["original_topic"] == topic
    assert dead_letter_message["message"] == {"case_id": "CASE-POISON"}
    assert "bad data" in dead_letter_message["error"]
    assert dead_letter_message["attempts"] == 1


def test_success_acks_and_no_redelivery(monkeypatch):
    broker = install_fake_pubsub(monkeypatch, pubsub_client)
    topic = "test-topic"
    _, sub_path = pubsub_client.ensure_topic_and_subscription(topic)
    pubsub_client.ensure_topic_and_subscription(pubsub_client.dead_letter_topic_name(topic))
    pubsub_client.publish_json(topic, {"case_id": "CASE-OK"})

    seen = []
    result = pubsub_client.process_one(topic, seen.append)

    assert result == "acked"
    assert seen == [{"case_id": "CASE-OK"}]
    assert broker.pending_count(sub_path) == 0

    # Nothing left to pull -- it wasn't redelivered after success.
    assert pubsub_client.process_one(topic, seen.append) == "empty"
    assert len(seen) == 1

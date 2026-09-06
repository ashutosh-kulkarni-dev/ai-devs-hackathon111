"""In-memory double for the slice of the google-cloud-pubsub API that
pubsub_client.py uses. Lets Phase 1's ack-after-success / nack / dead-letter
contract be tested as pure Python, with no emulator required.

Only implements enough surface area to exercise pubsub_client: topic_path/
subscription_path, create_topic/create_subscription, publish, pull,
acknowledge, modify_ack_deadline(0) == nack-and-redeliver-now.
"""
import itertools
import threading


class _Message:
    __slots__ = ("message_id", "data")

    def __init__(self, message_id: str, data: bytes):
        self.message_id = message_id
        self.data = data


class _ReceivedMessage:
    __slots__ = ("ack_id", "message")

    def __init__(self, ack_id: str, message: _Message):
        self.ack_id = ack_id
        self.message = message


class _PullResponse:
    __slots__ = ("received_messages",)

    def __init__(self, received_messages):
        self.received_messages = received_messages


class _FakeFuture:
    def __init__(self, result):
        self._result = result

    def result(self, timeout=None):
        return self._result


class FakeBroker:
    """Shared in-memory state behind both fake client classes below."""

    def __init__(self):
        self._lock = threading.Lock()
        self._topics = set()
        self._sub_topic = {}       # subscription_path -> topic_path
        self._queues = {}          # subscription_path -> list[_Message], pending (not leased)
        self._leased = {}          # ack_id -> (subscription_path, _Message)
        self._msg_ids = itertools.count(1)
        self._ack_ids = itertools.count(1)
        # Test-visible counters.
        self.dead_lettered = []    # list of (topic, decoded_json_message) published to *-dead-letter

    def create_topic(self, topic_path: str):
        self._topics.add(topic_path)

    def create_subscription(self, sub_path: str, topic_path: str):
        self._sub_topic[sub_path] = topic_path
        self._queues.setdefault(sub_path, [])

    def publish(self, topic_path: str, data: bytes) -> str:
        message_id = str(next(self._msg_ids))
        msg = _Message(message_id, data)
        with self._lock:
            for sub_path, sub_topic in self._sub_topic.items():
                if sub_topic == topic_path:
                    self._queues[sub_path].append(msg)
        return message_id

    def pull(self, sub_path: str, max_messages: int = 1):
        with self._lock:
            queue = self._queues.get(sub_path, [])
            if not queue:
                return []
            msg = queue.pop(0)
            ack_id = str(next(self._ack_ids))
            self._leased[ack_id] = (sub_path, msg)
            return [_ReceivedMessage(ack_id, msg)]

    def acknowledge(self, ack_ids):
        with self._lock:
            for ack_id in ack_ids:
                self._leased.pop(ack_id, None)

    def modify_ack_deadline(self, ack_ids, ack_deadline_seconds):
        if ack_deadline_seconds != 0:
            return  # only "nack now" is exercised/needed here
        with self._lock:
            for ack_id in ack_ids:
                leased = self._leased.pop(ack_id, None)
                if leased is not None:
                    sub_path, msg = leased
                    self._queues[sub_path].insert(0, msg)

    def pending_count(self, sub_path: str) -> int:
        with self._lock:
            return len(self._queues.get(sub_path, []))


class FakePublisherClient:
    def __init__(self, broker: FakeBroker):
        self._broker = broker

    def topic_path(self, project: str, topic: str) -> str:
        return f"projects/{project}/topics/{topic}"

    def create_topic(self, request):
        self._broker.create_topic(request["name"])

    def publish(self, topic, data):
        message_id = self._broker.publish(topic, data)
        return _FakeFuture(message_id)


class FakeSubscriberClient:
    def __init__(self, broker: FakeBroker):
        self._broker = broker

    def subscription_path(self, project: str, sub: str) -> str:
        return f"projects/{project}/subscriptions/{sub}"

    def create_subscription(self, request):
        self._broker.create_subscription(request["name"], request["topic"])

    def pull(self, request, timeout=None):
        received = self._broker.pull(request["subscription"], request.get("max_messages", 1))
        return _PullResponse(received)

    def acknowledge(self, request):
        self._broker.acknowledge(request["ack_ids"])

    def modify_ack_deadline(self, request):
        self._broker.modify_ack_deadline(request["ack_ids"], request["ack_deadline_seconds"])


def install_fake_pubsub(monkeypatch, pubsub_client_module, broker: FakeBroker = None) -> FakeBroker:
    """Monkeypatch pubsub_client's client factories to hand out fakes backed
    by a single shared broker (so publisher-side and subscriber-side state
    is the same in-memory queue, like the real emulator)."""
    broker = broker or FakeBroker()
    monkeypatch.setattr(pubsub_client_module, "_publisher", lambda: FakePublisherClient(broker))
    monkeypatch.setattr(pubsub_client_module, "_subscriber", lambda: FakeSubscriberClient(broker))
    return broker

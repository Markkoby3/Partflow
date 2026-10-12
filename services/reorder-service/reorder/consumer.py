"""Kafka consumer: at-least-once delivery, offsets committed after each event is handled.

Run with `python -m reorder.consumer`.
"""

from __future__ import annotations

import json
import logging
import signal
import time
from typing import Callable, Iterable, Protocol

from .handler import EventHandler

log = logging.getLogger(__name__)


class Message(Protocol):
    def error(self): ...
    def value(self) -> bytes | None: ...
    def topic(self) -> str: ...
    def partition(self) -> int: ...
    def offset(self) -> int: ...


def process_batch(handler: EventHandler, messages: Iterable[Message], commit: Callable[[Message], None]) -> dict[str, int]:
    """Handles messages in order, calling commit(msg) after each one is done.

    A poison message (unparseable JSON or schema) is logged and committed so it
    cannot block its partition; a handler failure (e.g. Mongo down) raises
    without committing, so the message is redelivered.
    """
    counts: dict[str, int] = {}
    for msg in messages:
        if msg.error():
            log.warning("kafka error: %s", msg.error())
            continue
        try:
            raw = json.loads(msg.value() or b"null")
            if not isinstance(raw, dict):
                raise ValueError("event is not a JSON object")
        except ValueError as err:
            log.error("skipping malformed message at %s[%s]@%s: %s", msg.topic(), msg.partition(), msg.offset(), err)
            counts["malformed"] = counts.get("malformed", 0) + 1
            commit(msg)
            continue
        try:
            outcome = handler.handle(raw).outcome
        except (ValueError, KeyError) as err:  # pydantic ValidationError is a ValueError
            log.error("skipping invalid event %s: %s", raw.get("eventId"), err)
            outcome = "invalid"
        counts[outcome] = counts.get(outcome, 0) + 1
        commit(msg)
    return counts


class Backoff:
    def __init__(self, base: float = 0.5, cap: float = 30.0) -> None:
        self.base, self.cap, self.n = base, cap, 0

    def next(self) -> float:
        self.n += 1
        return min(self.cap, self.base * 2 ** (self.n - 1))

    def reset(self) -> None:
        self.n = 0


def rewind_points(batch: Iterable[Message]):
    """First offset per partition in a batch, as confluent-kafka TopicPartitions."""
    from confluent_kafka import TopicPartition

    first: dict[tuple[str, int], int] = {}
    for m in batch:
        if m.error():
            continue
        key = (m.topic(), m.partition())
        first[key] = min(first.get(key, m.offset()), m.offset())
    return [TopicPartition(t, p, o) for (t, p), o in first.items()]


def main() -> None:
    from confluent_kafka import Consumer
    from pymongo import MongoClient

    from .advisor import Advisor
    from .config import Settings
    from .store import Store
    from .telemetry import setup

    setup("reorder-consumer")
    settings = Settings()
    store = Store(MongoClient(settings.mongo_url, tz_aware=True)[settings.mongo_db])
    store.ensure_indexes()
    advisor = Advisor.from_settings(settings.anthropic_api_key, settings.advisor_model, settings.advisor_timeout_s)
    handler = EventHandler(store, advisor, settings)
    log.info("advisor: %s", f"model {settings.advisor_model}" if advisor.enabled else "template (no ANTHROPIC_API_KEY)")

    consumer = Consumer(
        {
            "bootstrap.servers": settings.kafka_brokers,
            "group.id": settings.consumer_group,
            "enable.auto.commit": False,
            "auto.offset.reset": "earliest",
            "partition.assignment.strategy": "cooperative-sticky",
        }
    )
    consumer.subscribe([settings.inventory_topic])
    backoff = Backoff()
    running = True

    def stop(*_: object) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info("consuming %s as group %s", settings.inventory_topic, settings.consumer_group)
    try:
        while running:
            batch = consumer.consume(num_messages=100, timeout=1.0)
            if not batch:
                continue
            try:
                counts = process_batch(handler, batch, lambda _m: None)
            except Exception:
                # Transient failure (e.g. Mongo unreachable): rewind every partition to the
                # first message of this batch and retry after a pause. Handlers are
                # idempotent, so re-handling the part that already succeeded is safe.
                log.exception("batch failed; rewinding for redelivery")
                for tp in rewind_points(batch):
                    consumer.seek(tp)
                time.sleep(backoff.next())
                continue
            backoff.reset()
            consumer.commit(asynchronous=False)  # one commit per fully handled batch
            log.info("batch handled: %s", counts)
    finally:
        consumer.close()


if __name__ == "__main__":
    main()

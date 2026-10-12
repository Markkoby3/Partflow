from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone
from itertools import count

import mongomock
import pytest

from reorder.advisor import Advisor
from reorder.config import Settings
from reorder.handler import EventHandler
from reorder.store import Store

TODAY = date(2026, 10, 12)


@pytest.fixture
def store() -> Store:
    s = Store(mongomock.MongoClient(tz_aware=True)["partflow_test"])
    s.ensure_indexes()
    return s


@pytest.fixture
def settings() -> Settings:
    return Settings(anthropic_api_key=None)


@pytest.fixture
def handler(store: Store, settings: Settings) -> EventHandler:
    return EventHandler(store, Advisor(None, "test-model"), settings, today=lambda: TODAY)


class EventFactory:
    """Builds inventory.stock_changed envelopes the way the inventory API does."""

    def __init__(self, part_id: str = "P-100", lead_time: int = 10, safety: int = 20, on_hand: int = 500) -> None:
        self.part_id = part_id
        self.lead_time = lead_time
        self.safety = safety
        self.on_hand = on_hand
        self.on_order = 0
        self.version = count(1)

    def _env(self, reason: str, delta: int, when: datetime, **extra) -> dict:
        return {
            "eventId": str(uuid.uuid4()),
            "type": "inventory.stock_changed",
            "version": 1,
            "occurredAt": when.isoformat(),
            "partId": self.part_id,
            "data": {
                "reason": reason,
                "delta": delta,
                "onHand": self.on_hand,
                "onOrder": self.on_order,
                "stockVersion": next(self.version),
                "part": {
                    "sku": f"SKU-{self.part_id}",
                    "name": "Drive unit bearing",
                    "supplierId": "SUP-1",
                    "leadTimeDays": self.lead_time,
                    "safetyStock": self.safety,
                    "unitCostCents": 4200,
                },
                **extra,
            },
        }

    def consume(self, qty: int, day: date = TODAY) -> dict:
        self.on_hand -= qty
        return self._env("consumption", -qty, datetime.combine(day, time(12), tzinfo=timezone.utc), movementId=str(uuid.uuid4()))

    def po_created(self, qty: int) -> dict:
        self.on_order += qty
        return self._env("po_created", 0, datetime.combine(TODAY, time(13), tzinfo=timezone.utc), purchaseOrderId=str(uuid.uuid4()))

    def receive(self, qty: int) -> dict:
        self.on_order -= qty
        self.on_hand += qty
        return self._env("po_received", qty, datetime.combine(TODAY, time(14), tzinfo=timezone.utc))


@pytest.fixture
def events() -> EventFactory:
    return EventFactory()


def history(factory: EventFactory, per_day: list[int], end: date = TODAY - timedelta(days=1)) -> list[dict]:
    """One consumption event per day, oldest first, ending yesterday by default."""
    start = end - timedelta(days=len(per_day) - 1)
    return [factory.consume(q, start + timedelta(days=i)) for i, q in enumerate(per_day) if q > 0]

"""Runs against a real MongoDB when MONGO_URL is set (CI starts one)."""

import os
import uuid

import pytest
from conftest import TODAY, EventFactory, history

from reorder.advisor import Advisor
from reorder.handler import EventHandler
from reorder.store import Store

MONGO_URL = os.environ.get("MONGO_URL")
pytestmark = pytest.mark.skipif(not MONGO_URL, reason="MONGO_URL not set")


@pytest.fixture
def real_store():
    from pymongo import MongoClient

    client = MongoClient(MONGO_URL, tz_aware=True)
    name = f"partflow_it_{uuid.uuid4().hex[:8]}"
    s = Store(client[name])
    s.ensure_indexes()
    yield s
    client.drop_database(name)


def test_partial_unique_index_blocks_a_second_pending_recommendation(real_store):
    base = {"partId": "P-1", "quantity": 5, "risk": "medium"}
    assert real_store.create_recommendation(dict(base)) is not None
    assert real_store.create_recommendation(dict(base)) is None
    from pymongo.errors import DuplicateKeyError

    with pytest.raises(DuplicateKeyError):
        real_store.recommendations.insert_one({"_id": "dup", "partId": "P-1", "status": "pending"})


def test_end_to_end_handler_on_real_mongo(real_store, settings):
    h = EventHandler(real_store, Advisor(None, "m"), settings, today=lambda: TODAY)
    f = EventFactory()
    for e in history(f, [10] * 27):
        h.handle(e)
    result = h.handle(f.consume(130))
    assert result.outcome == "recommended"
    assert real_store.daily_usage("P-100", TODAY.replace(day=1))  # aggregation works on the real server
    assert real_store.pending_for("P-100")["_id"] == result.recommendation_id

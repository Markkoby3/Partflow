from conftest import TODAY, EventFactory, history

from reorder.advisor import Advisor
from reorder.handler import EventHandler


def test_recommends_when_position_drops_below_reorder_point(handler, store, events):
    # 28 days at ~10/day with a 10-day lead time: reorder point is about 120.
    for e in history(events, [10] * 27):
        assert handler.handle(e).outcome == "evaluated"
    result = handler.handle(events.consume(130))  # big draw today takes on-hand to 100
    assert result.outcome == "recommended"
    rec = store.get(result.recommendation_id)
    assert rec["status"] == "pending"
    assert rec["onHand"] == 100 and rec["reorderPoint"] >= 120
    assert rec["quantity"] > 0 and rec["adviceSource"] == "template"
    assert rec["demand"]["days"] == 28
    audit = store.decisions_for("P-100")
    assert [a["action"] for a in audit] == ["created"]


def test_duplicate_delivery_is_ignored_and_usage_counted_once(handler, store, events):
    e = events.consume(10)
    assert handler.handle(e).outcome == "evaluated"
    assert handler.handle(e).outcome == "duplicate"
    assert store.daily_usage("P-100", TODAY) == {TODAY: 10}


def test_usage_is_idempotent_even_if_the_processed_marker_was_lost(handler, store, events):
    e = events.consume(10)
    handler.handle(e)
    store.processed.delete_many({})  # simulate a crash after handling but before marking
    handler.handle(e)
    assert store.daily_usage("P-100", TODAY) == {TODAY: 10}


def test_stale_snapshot_does_not_overwrite_newer_state(handler, store, events):
    older = events.consume(5)
    newer = events.consume(5)
    handler.handle(newer)
    handler.handle(older)  # arrives late
    assert store.part_state.find_one({"_id": "P-100"})["onHand"] == 490


def test_only_one_open_recommendation_per_part_and_it_stays_current(handler, store, events):
    for e in history(events, [10] * 27):
        handler.handle(e)
    first = handler.handle(events.consume(130))
    again = handler.handle(events.consume(20))
    assert again.outcome == "refreshed" and again.recommendation_id == first.recommendation_id
    assert store.recommendations.count_documents({"partId": "P-100", "status": "pending"}) == 1
    rec = store.get(first.recommendation_id)
    assert rec["onHand"] == 80
    # The template explanation is rewritten to match the refreshed quantity.
    assert rec["advice"]["summary"].startswith(f"Order {rec['quantity']} x")


def test_recommendation_is_superseded_once_stock_recovers(handler, store, events):
    for e in history(events, [10] * 27):
        handler.handle(e)
    rec = handler.handle(events.consume(130)).recommendation_id
    handler.handle(events.po_created(400))
    assert store.get(rec)["status"] == "superseded"


def test_recommendation_mid_approval_is_left_alone(handler, store, events):
    for e in history(events, [10] * 27):
        handler.handle(e)
    rec = handler.handle(events.consume(130)).recommendation_id
    store.transition(rec, "pending", "approving", "planner")
    # The approved PO's own event arrives before the approval finishes.
    assert handler.handle(events.po_created(400)).outcome == "evaluated"
    assert store.get(rec)["status"] == "approving"
    # And a further draw while approving does not open a second recommendation.
    handler.handle(events.consume(50))
    assert store.recommendations.count_documents({"partId": "P-100"}) == 1


def test_other_event_types_are_ignored(handler):
    assert handler.handle({"eventId": "x", "type": "purchasing.po_created", "version": 1, "occurredAt": "2026-10-12T00:00:00Z", "partId": "P-1", "data": {}}).outcome == "ignored"


def test_advisor_output_is_stored_with_its_source(store, settings):
    class Fake:
        def create(self, **kw):
            from types import SimpleNamespace

            return SimpleNamespace(content=[SimpleNamespace(text='{"summary": "Supplier lead time exceeds cover.", "risk_factors": ["Volatile demand"]}')])

    h = EventHandler(store, Advisor(Fake(), "claude-x"), settings, today=lambda: TODAY)
    f = EventFactory(part_id="P-200", on_hand=500)
    for e in history(f, [10] * 27):
        h.handle(e)
    rec = store.get(h.handle(f.consume(200)).recommendation_id)
    assert rec["adviceSource"] == "model:claude-x"
    assert rec["advice"]["risk_factors"] == ["Volatile demand"]


def test_model_explanation_is_reused_until_the_quantity_moves_materially(store, settings):
    from types import SimpleNamespace

    class Counting:
        calls = 0

        def create(self, **kw):
            Counting.calls += 1
            return SimpleNamespace(content=[SimpleNamespace(text='{"summary": "Reorder now."}')])

    h = EventHandler(store, Advisor(Counting(), "claude-x"), settings, today=lambda: TODAY)
    f = EventFactory(part_id="P-300", on_hand=1000)
    for e in history(f, [10] * 27):
        h.handle(e)
    def adjust(delta):  # cycle-count adjustment: changes stock without counting as demand
        from datetime import datetime, timezone

        f.on_hand += delta
        return f._env("adjustment", delta, datetime.now(timezone.utc))

    rec_id = h.handle(adjust(-620)).recommendation_id  # on hand 110, just under the reorder point
    assert Counting.calls == 1
    h.handle(f.consume(1))  # small change: keep the model's explanation
    assert Counting.calls == 1
    h.handle(adjust(-60))  # quantity jumps by far more than 25%: explain again
    assert Counting.calls == 2
    assert store.get(rec_id)["adviceQuantity"] == store.get(rec_id)["quantity"]

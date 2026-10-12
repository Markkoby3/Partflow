import json
from datetime import date, timedelta
from types import SimpleNamespace

from reorder.advisor import Advisor, template_advice
from reorder.events import PartSnapshot
from reorder.policy import decide, demand_stats

TODAY = date(2026, 10, 12)
PART = PartSnapshot(sku="SKU-1", name="Seat frame", supplierId="SUP-9", leadTimeDays=12, safetyStock=10, unitCostCents=9000)


def _decision(on_hand=40, on_order=0):
    stats = demand_stats({TODAY - timedelta(days=i): (8 if i % 3 else 2) for i in range(5)}, TODAY, TODAY - timedelta(days=4), 28)
    return decide(on_hand=on_hand, on_order=on_order, lead_time_days=12, safety_floor=10, demand=stats)


class FakeMessages:
    def __init__(self, reply=None, exc=None):
        self.reply, self.exc, self.calls = reply, exc, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.exc:
            raise self.exc
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.reply)])


def test_template_when_no_model_configured():
    d = _decision()
    r = Advisor(None, "m").advise("P-1", PART, 40, 0, d)
    assert r.source == "template" and r.error is None
    assert f"Order {d.quantity} x Seat frame" in r.advice.summary
    assert any("lead time" in f for f in r.advice.risk_factors)
    assert any("low-confidence" in f for f in r.advice.risk_factors)


def test_model_output_is_used_when_valid_and_gets_the_policy_numbers():
    fake = FakeMessages(reply='Here you go: {"summary": "Order now; cover is short.", "risk_factors": ["Long lead time"], "planner_note": "Check supplier capacity."}')
    d = _decision()
    r = Advisor(fake, "claude-test").advise("P-1", PART, 40, 0, d)
    assert r.source == "model:claude-test"
    assert r.advice.summary == "Order now; cover is short."
    sent = json.loads(fake.calls[0]["messages"][0]["content"])
    assert sent["order_quantity"] == d.quantity
    assert sent["reorder_point"] == d.reorder_point
    assert fake.calls[0]["temperature"] == 0


def test_invalid_model_output_falls_back_to_template():
    for reply in ["no json here", '{"summary": ""}', '{"risk_factors": "not a list", "summary": "x"}']:
        r = Advisor(FakeMessages(reply=reply), "m").advise("P-1", PART, 40, 0, _decision())
        assert r.source == "template"
        assert r.error and r.error.startswith("invalid_output")


def test_model_errors_fall_back_to_template():
    r = Advisor(FakeMessages(exc=TimeoutError("read timed out")), "m").advise("P-1", PART, 40, 0, _decision())
    assert r.source == "template"
    assert r.error == "TimeoutError: read timed out"


def test_template_mentions_existing_orders():
    advice = template_advice(PART, 40, 25, _decision(on_order=25))
    assert any("25 units already on order" in f for f in advice.risk_factors)

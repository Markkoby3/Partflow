import math
from datetime import date, timedelta

import pytest

from reorder.policy import decide, demand_stats

TODAY = date(2026, 10, 12)


def test_demand_counts_quiet_days_as_zero():
    usage = {TODAY: 10, TODAY - timedelta(days=2): 20}
    stats = demand_stats(usage, TODAY, first_seen=TODAY - timedelta(days=3), window_days=28)
    assert stats.days == 4
    assert stats.total == 30
    assert stats.mean == pytest.approx(7.5)
    assert stats.stdev == pytest.approx(math.sqrt(((10 - 7.5) ** 2 + 7.5**2 + (20 - 7.5) ** 2 + 7.5**2) / 4))
    assert stats.low_confidence


def test_window_is_capped():
    usage = {TODAY - timedelta(days=i): 5 for i in range(60)}
    stats = demand_stats(usage, TODAY, first_seen=TODAY - timedelta(days=59), window_days=28)
    assert stats.days == 28 and stats.total == 140 and stats.stdev == 0


def test_reorder_point_and_order_up_to_quantity():
    stats = demand_stats({TODAY - timedelta(days=i): 10 for i in range(28)}, TODAY, TODAY - timedelta(days=27), 28)
    d = decide(on_hand=110, on_order=0, lead_time_days=10, safety_floor=20, demand=stats, z=1.65, review_period_days=7)
    # Steady demand: no variability, so the configured floor sets safety stock.
    assert d.safety_stock == 20
    assert d.reorder_point == 120
    assert d.reorder
    assert d.quantity == 10 * (10 + 7) + 20 - 110
    assert d.risk == "medium"
    assert d.days_of_cover == pytest.approx(11.0)


def test_volatile_demand_raises_safety_stock_above_floor():
    usage = {TODAY - timedelta(days=i): (40 if i % 2 else 0) for i in range(28)}
    stats = demand_stats(usage, TODAY, TODAY - timedelta(days=27), 28)
    d = decide(on_hand=1000, on_order=0, lead_time_days=9, safety_floor=5, demand=stats)
    assert d.safety_stock == math.ceil(1.65 * 20 * 3)  # z * stdev(20) * sqrt(9)
    assert not d.reorder and d.risk == "low"


def test_on_order_counts_toward_position():
    stats = demand_stats({TODAY - timedelta(days=i): 10 for i in range(28)}, TODAY, TODAY - timedelta(days=27), 28)
    d = decide(on_hand=50, on_order=200, lead_time_days=10, safety_floor=20, demand=stats)
    assert not d.reorder
    assert d.risk == "high"  # still flagged: on-hand runs out before lead time elapses


def test_no_demand_means_no_order_unless_below_floor():
    stats = demand_stats({}, TODAY, TODAY - timedelta(days=10), 28)
    assert not decide(on_hand=50, on_order=0, lead_time_days=5, safety_floor=20, demand=stats).reorder
    low = decide(on_hand=5, on_order=0, lead_time_days=5, safety_floor=20, demand=stats)
    assert low.reorder and low.quantity == 15 and low.days_of_cover is None


def test_rejects_non_positive_lead_time():
    stats = demand_stats({}, TODAY, TODAY, 28)
    with pytest.raises(ValueError):
        decide(on_hand=1, on_order=0, lead_time_days=0, safety_floor=0, demand=stats)

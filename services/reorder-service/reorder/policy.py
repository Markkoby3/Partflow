"""Reorder-point policy with demand-driven safety stock.

For a part with average daily demand d, daily demand standard deviation s and
supplier lead time L days:

    safety stock    SS  = max(configured floor, z * s * sqrt(L))
    reorder point   ROP = d * L + SS
    inventory position  = on hand + on order

When the position is at or below the reorder point, order up to the level that
covers lead time plus one review period:  d * (L + R) + SS - position.

The policy is deterministic and owns the quantity. The AI advisor only explains
the decision and flags risks; it can never change how much is ordered.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal, Mapping

Risk = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class DemandStats:
    days: int
    total: int
    mean: float
    stdev: float

    @property
    def low_confidence(self) -> bool:
        return self.days < 7


@dataclass(frozen=True)
class Decision:
    reorder: bool
    quantity: int
    reorder_point: int
    safety_stock: int
    position: int
    days_of_cover: float | None
    risk: Risk
    demand: DemandStats


def demand_stats(daily_usage: Mapping[date, int], today: date, first_seen: date, window_days: int) -> DemandStats:
    """Daily demand over the window, counting days with no consumption as zero."""
    start = max(first_seen, today - timedelta(days=window_days - 1))
    days = max(1, (today - start).days + 1)
    series = [daily_usage.get(start + timedelta(days=i), 0) for i in range(days)]
    total = sum(series)
    mean = total / days
    var = sum((x - mean) ** 2 for x in series) / days
    return DemandStats(days=days, total=total, mean=mean, stdev=math.sqrt(var))


def decide(
    *,
    on_hand: int,
    on_order: int,
    lead_time_days: int,
    safety_floor: int,
    demand: DemandStats,
    z: float = 1.65,
    review_period_days: int = 7,
) -> Decision:
    if lead_time_days <= 0:
        raise ValueError("lead_time_days must be positive")
    safety = max(safety_floor, math.ceil(z * demand.stdev * math.sqrt(lead_time_days)))
    rop = math.ceil(demand.mean * lead_time_days + safety)
    position = on_hand + on_order
    days_of_cover = on_hand / demand.mean if demand.mean > 0 else None

    # No demand and stock above the floor: nothing to replenish.
    needs = position <= rop and (demand.mean > 0 or position < safety)
    quantity = 0
    if needs:
        target = demand.mean * (lead_time_days + review_period_days) + safety
        quantity = max(1, math.ceil(target - position))

    if demand.mean > 0 and on_hand < demand.mean * lead_time_days:
        risk: Risk = "high"  # stock runs out before an order placed today can arrive
    elif needs:
        risk = "medium"
    else:
        risk = "low"

    return Decision(
        reorder=needs,
        quantity=quantity,
        reorder_point=rop,
        safety_stock=safety,
        position=position,
        days_of_cover=days_of_cover,
        risk=risk,
        demand=demand,
    )

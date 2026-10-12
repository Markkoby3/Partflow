"""Backtest the reorder policy against a static min/max rule on synthetic demand.

    python scripts/backtest.py [--days 180] [--parts 40] [--seed 7]

Each simulated part gets its own mean demand, volatility (including demand
spikes) and supplier lead time. Both strategies review stock daily, see the
same demand, and receive orders exactly one lead time after placing them.

* baseline: a static min/max rule set once from the first 14 days of demand
  (reorder point = mean x lead time, order 30 days of demand) - a common
  spreadsheet rule with no safety stock and no re-estimation;
* partflow: the service's policy (reorder.policy.decide) re-estimated daily over
  a trailing 28-day window, with demand-driven safety stock.

Reports fill rate (demand served from stock), stockout days and average units
on hand. Synthetic data: this measures the policy logic, not a real plant.
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reorder.policy import decide, demand_stats  # noqa: E402

START = date(2026, 1, 1)
WARMUP = 14


@dataclass
class Sim:
    on_hand: int
    pipeline: list[tuple[int, int]] = field(default_factory=list)  # (arrival day, qty)
    demand_total: int = 0
    served: int = 0
    stockout_days: int = 0
    on_hand_sum: int = 0
    orders: int = 0

    @property
    def on_order(self) -> int:
        return sum(q for _, q in self.pipeline)

    def step(self, day: int, demand: int) -> None:
        arrived = [q for d, q in self.pipeline if d == day]
        self.pipeline = [(d, q) for d, q in self.pipeline if d != day]
        self.on_hand += sum(arrived)
        served = min(self.on_hand, demand)
        if served < demand:
            self.stockout_days += 1
        self.on_hand -= served
        if day >= WARMUP:
            self.demand_total += demand
            self.served += served
            self.on_hand_sum += self.on_hand

    def order(self, day: int, lead: int, qty: int) -> None:
        if qty > 0:
            self.pipeline.append((day + lead, qty))
            self.orders += 1


def demand_series(rng: random.Random, days: int) -> tuple[list[int], int]:
    mean = rng.uniform(5, 60)
    cv = rng.uniform(0.1, 0.8)
    lead = rng.choice([5, 7, 10, 14, 21])
    series = []
    for _ in range(days):
        x = max(0.0, rng.gauss(mean, mean * cv))
        if rng.random() < 0.05:  # occasional production surge
            x *= rng.uniform(1.8, 3.0)
        series.append(round(x))
    return series, lead


def run(days: int, parts: int, seed: int) -> dict[str, dict[str, float]]:
    rng = random.Random(seed)
    totals = {name: {"demand": 0, "served": 0, "stockout_days": 0, "on_hand_sum": 0, "orders": 0} for name in ("baseline", "partflow")}
    for _ in range(parts):
        series, lead = demand_series(rng, days)
        warm = series[:WARMUP]
        warm_mean = sum(warm) / WARMUP
        opening = math.ceil(warm_mean * (lead + 14))
        base, pf = Sim(opening), Sim(opening)
        base_rop = math.ceil(warm_mean * lead)
        base_qty = math.ceil(warm_mean * 30)
        usage: dict[date, int] = {}
        for day, demand in enumerate(series):
            today = START + timedelta(days=day)
            base.step(day, demand)
            pf.step(day, demand)
            usage[today] = demand
            if day < WARMUP - 1:
                continue
            if base.on_hand + base.on_order <= base_rop:
                base.order(day, lead, base_qty)
            stats = demand_stats(usage, today, START, 28)
            d = decide(on_hand=pf.on_hand, on_order=pf.on_order, lead_time_days=lead, safety_floor=0, demand=stats)
            if d.reorder:
                pf.order(day, lead, d.quantity)
        for name, sim in (("baseline", base), ("partflow", pf)):
            t = totals[name]
            t["demand"] += sim.demand_total
            t["served"] += sim.served
            t["stockout_days"] += sim.stockout_days
            t["on_hand_sum"] += sim.on_hand_sum
            t["orders"] += sim.orders
    measured_days = (days - WARMUP) * parts
    return {
        name: {
            "fill_rate_pct": 100 * t["served"] / t["demand"],
            "stockout_days": t["stockout_days"],
            "avg_units_on_hand_per_part": t["on_hand_sum"] / measured_days,
            "orders": t["orders"],
        }
        for name, t in totals.items()
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=180)
    ap.add_argument("--parts", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    results = run(args.days, args.parts, args.seed)
    print(f"{args.parts} parts x {args.days} days, seed {args.seed}\n")
    print(f"{'strategy':<10} {'fill rate':>10} {'stockout days':>14} {'avg on hand':>12} {'orders':>7}")
    for name, r in results.items():
        print(f"{name:<10} {r['fill_rate_pct']:>9.1f}% {r['stockout_days']:>14} {r['avg_units_on_hand_per_part']:>12.0f} {r['orders']:>7}")


if __name__ == "__main__":
    main()

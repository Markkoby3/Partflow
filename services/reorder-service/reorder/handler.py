"""Turns inventory events into replenishment recommendations."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable

from opentelemetry import metrics, trace

from .advisor import Advisor
from .config import Settings
from .events import STOCK_CHANGED, Envelope, PartSnapshot, StockChanged
from .policy import decide, demand_stats
from .store import Store, window_start

log = logging.getLogger(__name__)
tracer = trace.get_tracer("partflow.reorder")
meter = metrics.get_meter("partflow.reorder")
events_counter = meter.create_counter("partflow_reorder_events_total", description="Inventory events handled, by outcome")
recs_counter = meter.create_counter("partflow_recommendations_total", description="Recommendation lifecycle changes, by action")
advisor_counter = meter.create_counter("partflow_advisor_calls_total", description="Advisor results, by source")


@dataclass
class HandleResult:
    outcome: str  # duplicate | ignored | evaluated | recommended | superseded | refreshed
    recommendation_id: str | None = None


class EventHandler:
    def __init__(self, store: Store, advisor: Advisor, settings: Settings, today: Callable[[], date] | None = None) -> None:
        self.store = store
        self.advisor = advisor
        self.settings = settings
        self._today = today or (lambda: datetime.now(timezone.utc).date())

    def handle(self, raw: dict) -> HandleResult:
        env = Envelope.model_validate(raw)
        with tracer.start_as_current_span("reorder.handle_event", attributes={"event.type": env.type, "part.id": env.part_id}):
            result = self._handle(env)
            events_counter.add(1, {"outcome": result.outcome})
            return result

    def _handle(self, env: Envelope) -> HandleResult:
        if env.type != STOCK_CHANGED:
            return HandleResult("ignored")
        # Every write below is idempotent, so the event is marked done only after it
        # is fully handled: a crash mid-way means a redelivery, never a lost event.
        if self.store.is_processed(env.event_id):
            return HandleResult("duplicate")

        data = StockChanged.model_validate(env.data)
        event_day = env.occurred_at.astimezone(timezone.utc).date()
        if data.reason == "consumption" and data.delta < 0:
            self.store.record_usage(data.movement_id or env.event_id, env.part_id, event_day, -data.delta)

        state = self.store.apply_state(
            env.part_id,
            data.part.model_dump(by_alias=True),
            data.on_hand,
            data.on_order,
            data.stock_version,
            min(event_day, self._today()),
        )
        result = self.evaluate(env.part_id, state, trigger_event=env.event_id)
        self.store.mark_processed(env.event_id)
        return result

    def evaluate(self, part_id: str, state: dict, trigger_event: str | None = None) -> HandleResult:
        part = PartSnapshot.model_validate(state["part"])
        today = self._today()
        first_seen = date.fromisoformat(state["firstSeen"])
        usage = self.store.daily_usage(part_id, window_start(today, self.settings.demand_window_days))
        stats = demand_stats(usage, today, first_seen, self.settings.demand_window_days)
        decision = decide(
            on_hand=state["onHand"],
            on_order=state["onOrder"],
            lead_time_days=part.lead_time_days,
            safety_floor=part.safety_stock,
            demand=stats,
            z=self.settings.service_level_z,
            review_period_days=self.settings.review_period_days,
        )
        numbers = {
            "quantity": decision.quantity,
            "reorderPoint": decision.reorder_point,
            "safetyStock": decision.safety_stock,
            "position": decision.position,
            "onHand": state["onHand"],
            "onOrder": state["onOrder"],
            "daysOfCover": decision.days_of_cover,
            "risk": decision.risk,
            "demand": {
                "days": stats.days,
                "total": stats.total,
                "meanPerDay": round(stats.mean, 3),
                "stdevPerDay": round(stats.stdev, 3),
                "lowConfidence": stats.low_confidence,
            },
        }
        self.store.save_assessment(part_id, {**numbers, "reorder": decision.reorder})
        pending = self.store.pending_for(part_id)

        if not decision.reorder:
            if pending and pending["status"] == "pending":
                self.store.transition(pending["_id"], "pending", "superseded", "reorder-service", {"reason": "position above reorder point", **numbers})
                recs_counter.add(1, {"action": "superseded"})
                return HandleResult("superseded", pending["_id"])
            return HandleResult("evaluated")

        if pending and pending["status"] == "approving":
            return HandleResult("evaluated", pending["_id"])  # a planner is mid-approval; leave it alone

        if pending:
            # Keep the open recommendation current. The explanation is regenerated when it
            # would no longer match the numbers: always for the free template, and for model
            # output once the quantity has moved by more than 25% since it was written.
            fields = dict(numbers)
            explained_for = pending.get("adviceQuantity") or pending["quantity"]
            if not pending.get("adviceSource", "").startswith("model:") or abs(decision.quantity - explained_for) > 0.25 * explained_for:
                fields.update(self._advice_fields(part_id, part, state, decision))
            self.store.refresh_recommendation(pending["_id"], fields)
            return HandleResult("refreshed", pending["_id"])

        doc = self.store.create_recommendation(
            {
                "partId": part_id,
                "sku": part.sku,
                "name": part.name,
                "supplierId": part.supplier_id,
                "leadTimeDays": part.lead_time_days,
                "unitCostCents": part.unit_cost_cents,
                **numbers,
                **self._advice_fields(part_id, part, state, decision),
                "triggerEventId": trigger_event,
            }
        )
        if doc is None:
            return HandleResult("refreshed")
        recs_counter.add(1, {"action": "created"})
        log.info("recommendation created", extra={"part_id": part_id, "quantity": decision.quantity, "risk": decision.risk})
        return HandleResult("recommended", doc["_id"])

    def _advice_fields(self, part_id: str, part: PartSnapshot, state: dict, decision) -> dict:
        result = self.advisor.advise(part_id, part, state["onHand"], state["onOrder"], decision)
        advisor_counter.add(1, {"source": result.source.split(":")[0]})
        return {
            "advice": result.advice.model_dump(),
            "adviceSource": result.source,
            "adviceError": result.error,
            "adviceQuantity": decision.quantity,
        }

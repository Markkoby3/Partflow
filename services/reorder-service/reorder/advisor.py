"""AI decision support for reorder recommendations.

The advisor turns a policy decision into a short explanation a planner can act
on, and flags risks the formula cannot see on its own (for example a long
supplier lead time combined with volatile demand). Guardrails:

* the policy's quantity is final; the model is never asked for, and never
  allowed to change, the order quantity;
* model output must validate against a strict schema, otherwise it is dropped;
* any error, timeout or missing API key falls back to a deterministic template,
  so recommendations never block on the model.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel, Field, ValidationError

from .events import PartSnapshot
from .policy import Decision

log = logging.getLogger(__name__)


class Advice(BaseModel):
    summary: str = Field(min_length=1, max_length=400)
    risk_factors: list[str] = Field(default_factory=list, max_length=5)
    planner_note: str = Field(default="", max_length=300)


@dataclass
class AdvisorResult:
    advice: Advice
    source: str  # "model:<name>" or "template"
    error: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class MessagesClient(Protocol):
    """The slice of the Anthropic client we use, so tests can pass a fake."""

    def create(self, **kwargs: Any) -> Any: ...


SYSTEM_PROMPT = """You are a supply-chain planning assistant at an electric-vehicle plant.
You explain replenishment recommendations to material planners.
The order quantity has already been computed by a fixed policy. Do not propose a
different quantity and do not invent numbers that are not in the input.
Reply with only a JSON object: {"summary": string (<= 2 sentences),
"risk_factors": [string, ...] (0-5 short items), "planner_note": string (optional, <= 1 sentence)}."""


def _fmt_cover(decision: Decision) -> str:
    return "n/a (no recent demand)" if decision.days_of_cover is None else f"{decision.days_of_cover:.1f} days"


def template_advice(part: PartSnapshot, on_hand: int, on_order: int, decision: Decision) -> Advice:
    d = decision.demand
    summary = (
        f"Order {decision.quantity} x {part.name} ({part.sku}): inventory position {decision.position} "
        f"is at or below the reorder point {decision.reorder_point} "
        f"(avg demand {d.mean:.1f}/day over {d.days} days, {part.lead_time_days}-day lead time)."
    )
    risks: list[str] = []
    if decision.risk == "high":
        risks.append(f"On-hand stock covers {_fmt_cover(decision)}, less than the {part.lead_time_days}-day lead time.")
    if d.mean > 0 and d.stdev / d.mean > 0.5:
        risks.append(f"Demand is volatile (std dev {d.stdev:.1f}/day vs mean {d.mean:.1f}/day).")
    if d.low_confidence:
        risks.append(f"Only {d.days} days of demand history; the estimate is low-confidence.")
    if on_order > 0:
        risks.append(f"{on_order} units already on order are counted in the position.")
    note = "Consider expediting the existing order." if decision.risk == "high" and on_order > 0 else ""
    return Advice(summary=summary, risk_factors=risks, planner_note=note)


def _extract_json(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in model output")
    return json.loads(match.group(0))


class Advisor:
    def __init__(self, client: MessagesClient | None, model: str, timeout_s: float = 10.0) -> None:
        self._client = client
        self._model = model
        self._timeout = timeout_s

    @classmethod
    def from_settings(cls, api_key: str | None, model: str, timeout_s: float) -> "Advisor":
        if not api_key:
            return cls(None, model, timeout_s)
        import anthropic  # imported lazily so the service runs without the SDK configured

        client = anthropic.Anthropic(api_key=api_key, timeout=timeout_s, max_retries=1)
        return cls(client.messages, model, timeout_s)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    def advise(self, part_id: str, part: PartSnapshot, on_hand: int, on_order: int, decision: Decision) -> AdvisorResult:
        fallback = template_advice(part, on_hand, on_order, decision)
        if self._client is None:
            return AdvisorResult(advice=fallback, source="template")
        facts = {
            "part": {"id": part_id, "sku": part.sku, "name": part.name, "supplier": part.supplier_id},
            "lead_time_days": part.lead_time_days,
            "on_hand": on_hand,
            "on_order": on_order,
            "inventory_position": decision.position,
            "reorder_point": decision.reorder_point,
            "safety_stock": decision.safety_stock,
            "order_quantity": decision.quantity,
            "avg_daily_demand": round(decision.demand.mean, 2),
            "daily_demand_std_dev": round(decision.demand.stdev, 2),
            "demand_history_days": decision.demand.days,
            "days_of_cover": None if decision.days_of_cover is None else round(decision.days_of_cover, 1),
            "policy_risk_level": decision.risk,
        }
        try:
            resp = self._client.create(
                model=self._model,
                max_tokens=400,
                temperature=0,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": json.dumps(facts)}],
            )
            text = "".join(getattr(block, "text", "") for block in resp.content)
            data = _extract_json(text)
            advice = Advice.model_validate(data)
            return AdvisorResult(advice=advice, source=f"model:{self._model}", raw=data)
        except (ValidationError, ValueError, json.JSONDecodeError) as err:
            log.warning("advisor output rejected, using template: %s", err)
            return AdvisorResult(advice=fallback, source="template", error=f"invalid_output: {err}"[:300])
        except Exception as err:  # network, timeout, auth, rate limit
            log.warning("advisor call failed, using template: %s", err)
            return AdvisorResult(advice=fallback, source="template", error=f"{type(err).__name__}: {err}"[:300])

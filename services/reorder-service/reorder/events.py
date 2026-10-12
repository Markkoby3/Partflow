"""Typed views of the events the inventory API publishes (see inventory-api/src/events.ts)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

STOCK_CHANGED = "inventory.stock_changed"


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class PartSnapshot(_Model):
    sku: str
    name: str
    supplier_id: str = Field(alias="supplierId")
    lead_time_days: int = Field(alias="leadTimeDays", gt=0)
    safety_stock: int = Field(alias="safetyStock", ge=0)
    unit_cost_cents: int = Field(alias="unitCostCents", ge=0)


class StockChanged(_Model):
    reason: Literal["receipt", "consumption", "adjustment", "po_created", "po_received", "po_cancelled"]
    delta: int
    on_hand: int = Field(alias="onHand", ge=0)
    on_order: int = Field(alias="onOrder", ge=0)
    stock_version: int = Field(alias="stockVersion", ge=0)
    movement_id: Optional[str] = Field(default=None, alias="movementId")
    purchase_order_id: Optional[str] = Field(default=None, alias="purchaseOrderId")
    part: PartSnapshot


class Envelope(_Model):
    event_id: str = Field(alias="eventId")
    type: str
    version: int
    occurred_at: datetime = Field(alias="occurredAt")
    part_id: str = Field(alias="partId")
    data: dict

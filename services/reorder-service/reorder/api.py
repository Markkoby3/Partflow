"""REST API for planners: review, approve or reject AI-assisted recommendations."""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .inventory_client import InventoryClient, InventoryError
from .store import Store

log = logging.getLogger(__name__)


class ApproveBody(BaseModel):
    approved_by: str = Field(alias="approvedBy", min_length=1, max_length=100)
    # Planners may adjust the quantity, within bounds, and the change is audited.
    quantity: Optional[int] = Field(default=None, gt=0, le=1_000_000)


class RejectBody(BaseModel):
    rejected_by: str = Field(alias="rejectedBy", min_length=1, max_length=100)
    reason: str = Field(min_length=1, max_length=500)


def _out(doc: dict) -> dict:
    out = {("id" if k == "_id" else k): v for k, v in doc.items()}
    for k in ("createdAt", "updatedAt", "decidedAt"):
        if out.get(k) is not None:
            out[k] = out[k].isoformat()
    return out


def create_app(store: Store, inventory: InventoryClient, cors_origin: str = "*") -> FastAPI:
    app = FastAPI(title="PartFlow reorder service", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=[cors_origin], allow_methods=["*"], allow_headers=["*"])

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> dict:
        try:
            store.db.command("ping")
        except Exception as err:  # pragma: no cover - depends on a live Mongo outage
            raise HTTPException(503, {"status": "mongo_unavailable", "error": str(err)})
        return {"status": "ready"}

    @app.get("/v1/recommendations")
    def list_recommendations(
        status: Optional[Literal["pending", "approving", "approved", "rejected", "superseded"]] = None,
        limit: int = Query(100, ge=1, le=500),
    ) -> dict:
        return {"items": [_out(d) for d in store.list(status, limit)]}

    @app.get("/v1/recommendations/{rec_id}")
    def get_recommendation(rec_id: str) -> dict:
        doc = store.get(rec_id)
        if not doc:
            raise HTTPException(404, {"error": "not_found"})
        return _out(doc)

    @app.post("/v1/recommendations/{rec_id}/approve")
    def approve(rec_id: str, body: ApproveBody) -> dict:
        doc = store.get(rec_id)
        if not doc:
            raise HTTPException(404, {"error": "not_found"})
        if doc["status"] == "approved":
            return _out(doc)  # idempotent retry
        quantity = body.quantity or doc["quantity"]
        # Claim the recommendation first ("approving") so the event consumer cannot
        # supersede it when the new PO's own stock event arrives mid-approval.
        claimed = store.transition(rec_id, "pending", "approving", body.approved_by)
        if claimed is None:
            current = store.get(rec_id) or doc
            if current["status"] == "approving":
                claimed = current  # a previous attempt crashed or timed out mid-way; resume it
            else:
                raise HTTPException(409, {"error": "not_pending", "status": current["status"]})
        try:
            po = inventory.create_purchase_order(
                part_id=doc["partId"], quantity=quantity, recommendation_id=rec_id, approved_by=body.approved_by
            )
        except Exception as err:
            store.transition(rec_id, "approving", "pending", body.approved_by, {"lastApprovalError": str(err)[:300]})
            log.warning("purchase order creation failed: %s", err)
            detail = str(err) if isinstance(err, InventoryError) else type(err).__name__
            raise HTTPException(502, {"error": "inventory_unavailable", "detail": detail})
        extra = {"purchaseOrderId": po["id"], "approvedQuantity": quantity}
        if quantity != doc["quantity"]:
            extra["quantityOverride"] = {"recommended": doc["quantity"], "approved": quantity}
        updated = store.transition(rec_id, "approving", "approved", body.approved_by, extra)
        return _out(updated or store.get(rec_id) or doc)

    @app.post("/v1/recommendations/{rec_id}/reject")
    def reject(rec_id: str, body: RejectBody) -> dict:
        updated = store.transition(rec_id, "pending", "rejected", body.rejected_by, {"rejectReason": body.reason})
        if updated is None:
            doc = store.get(rec_id)
            if not doc:
                raise HTTPException(404, {"error": "not_found"})
            raise HTTPException(409, {"error": "not_pending", "status": doc["status"]})
        return _out(updated)

    @app.get("/v1/assessments")
    def assessments() -> dict:
        return {"items": store.assessments()}

    @app.get("/v1/decisions")
    def decisions(partId: Optional[str] = None, limit: int = Query(100, ge=1, le=500)) -> dict:
        items = store.decisions_for(partId, limit)
        for d in items:
            d["at"] = d["at"].isoformat()
        return {"items": items}

    return app


def main_app() -> FastAPI:
    """Entrypoint for uvicorn: `uvicorn reorder.api:main_app --factory`."""
    import os

    from pymongo import MongoClient

    from .config import Settings
    from .telemetry import setup

    setup("reorder-api")
    settings = Settings()
    store = Store(MongoClient(settings.mongo_url, tz_aware=True)[settings.mongo_db])
    store.ensure_indexes()
    app = create_app(store, InventoryClient(settings.inventory_api_url), os.environ.get("CORS_ORIGIN", "*"))
    if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz")
    return app

"""MongoDB persistence for the reorder service.

Mongo fits this side of the system: recommendations carry model output and
input snapshots whose shape changes as the advisor evolves, and the audit trail
is append-only documents. Postgres stays the system of record for stock.

Every write here is idempotent so the Kafka consumer can run at-least-once:
usage is keyed by movement id, part state only moves forward by stock version,
and at most one pending recommendation exists per part.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, OperationFailure


OPEN_STATUSES = ["pending", "approving"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.part_state = db["part_state"]
        self.usage = db["usage"]
        self.recommendations = db["recommendations"]
        self.decisions = db["decisions"]
        self.processed = db["processed_events"]

    def ensure_indexes(self) -> None:
        self.usage.create_index([("partId", ASCENDING), ("day", ASCENDING)])
        self.recommendations.create_index([("status", ASCENDING), ("createdAt", DESCENDING)])
        self.decisions.create_index([("partId", ASCENDING), ("at", DESCENDING)])
        try:
            # Database-enforced: one pending recommendation per part, even with several consumers.
            self.recommendations.create_index(
                [("partId", ASCENDING)],
                unique=True,
                partialFilterExpression={"status": "pending"},
                name="one_pending_per_part",
            )
            self.processed.create_index("at", expireAfterSeconds=7 * 24 * 3600)
        except (OperationFailure, NotImplementedError, TypeError):  # e.g. in-memory test doubles
            pass

    # ---------- idempotency ----------

    def is_processed(self, event_id: str) -> bool:
        return self.processed.find_one({"_id": event_id}, {"_id": 1}) is not None

    def mark_processed(self, event_id: str) -> bool:
        """Returns False if this event id was already handled."""
        try:
            self.processed.insert_one({"_id": event_id, "at": utcnow()})
            return True
        except DuplicateKeyError:
            return False

    # ---------- demand + state ----------

    def record_usage(self, usage_id: str, part_id: str, day: date, quantity: int) -> None:
        self.usage.update_one(
            {"_id": usage_id},
            {"$setOnInsert": {"partId": part_id, "day": day.isoformat(), "qty": quantity}},
            upsert=True,
        )

    def daily_usage(self, part_id: str, since: date) -> dict[date, int]:
        pipeline = [
            {"$match": {"partId": part_id, "day": {"$gte": since.isoformat()}}},
            {"$group": {"_id": "$day", "qty": {"$sum": "$qty"}}},
        ]
        return {date.fromisoformat(r["_id"]): int(r["qty"]) for r in self.usage.aggregate(pipeline)}

    def apply_state(self, part_id: str, snapshot: dict[str, Any], on_hand: int, on_order: int, version: int, day: date) -> dict:
        """Moves part state forward only; an older or replayed version is ignored."""
        self.part_state.update_one(
            {"_id": part_id},
            {"$setOnInsert": {"firstSeen": day.isoformat(), "stockVersion": -1}},
            upsert=True,
        )
        self.part_state.update_one(
            {"_id": part_id, "stockVersion": {"$lt": version}},
            {"$set": {"part": snapshot, "onHand": on_hand, "onOrder": on_order, "stockVersion": version, "updatedAt": utcnow()}},
        )
        # Backfilled history can start before the first event we saw.
        self.part_state.update_one({"_id": part_id, "firstSeen": {"$gt": day.isoformat()}}, {"$set": {"firstSeen": day.isoformat()}})
        return self.part_state.find_one({"_id": part_id}) or {}

    def save_assessment(self, part_id: str, assessment: dict[str, Any]) -> None:
        """Latest policy evaluation per part, for dashboards (reorder point, risk, cover)."""
        self.part_state.update_one({"_id": part_id}, {"$set": {"assessment": {**assessment, "at": utcnow()}}})

    def assessments(self) -> list[dict]:
        out = []
        for doc in self.part_state.find({"assessment": {"$exists": True}}):
            a = dict(doc["assessment"])
            a["at"] = a["at"].isoformat()
            out.append({"partId": doc["_id"], **a})
        return sorted(out, key=lambda a: a["partId"])

    # ---------- recommendations ----------

    def pending_for(self, part_id: str) -> dict | None:
        """The part's open recommendation: awaiting review, or mid-approval."""
        return self.recommendations.find_one({"partId": part_id, "status": {"$in": OPEN_STATUSES}})

    def create_recommendation(self, doc: dict[str, Any]) -> dict | None:
        """Inserts a pending recommendation unless the part already has one."""
        now = utcnow()
        doc = {**doc, "_id": str(uuid.uuid4()), "status": "pending", "createdAt": now, "updatedAt": now}
        on_insert = {k: v for k, v in doc.items() if k != "partId"}  # partId is seeded from the filter
        try:
            res = self.recommendations.update_one(
                {"partId": doc["partId"], "status": {"$in": OPEN_STATUSES}}, {"$setOnInsert": on_insert}, upsert=True
            )
        except DuplicateKeyError:  # a concurrent consumer won the race
            return None
        if res.upserted_id is None:
            return None
        self.audit(doc["_id"], doc["partId"], "created", "reorder-service", {"quantity": doc["quantity"], "risk": doc["risk"], "adviceSource": doc.get("adviceSource")})
        return doc

    def refresh_recommendation(self, rec_id: str, fields: dict[str, Any]) -> None:
        self.recommendations.update_one({"_id": rec_id, "status": "pending"}, {"$set": {**fields, "updatedAt": utcnow()}})

    def transition(self, rec_id: str, from_status: str, to_status: str, actor: str, extra: dict[str, Any] | None = None) -> dict | None:
        updated = self.recommendations.find_one_and_update(
            {"_id": rec_id, "status": from_status},
            {"$set": {"status": to_status, "decidedBy": actor, "decidedAt": utcnow(), "updatedAt": utcnow(), **(extra or {})}},
            return_document=ReturnDocument.AFTER,
        )
        if updated:
            self.audit(rec_id, updated["partId"], to_status, actor, extra or {})
        return updated

    def get(self, rec_id: str) -> dict | None:
        return self.recommendations.find_one({"_id": rec_id})

    def list(self, status: str | None, limit: int = 100) -> list[dict]:
        query = {"status": status} if status else {}
        return list(self.recommendations.find(query).sort("createdAt", DESCENDING).limit(limit))

    # ---------- audit ----------

    def audit(self, rec_id: str, part_id: str, action: str, actor: str, details: dict[str, Any]) -> None:
        self.decisions.insert_one(
            {"recommendationId": rec_id, "partId": part_id, "action": action, "actor": actor, "details": details, "at": utcnow()}
        )

    def decisions_for(self, part_id: str | None, limit: int = 100) -> list[dict]:
        query = {"partId": part_id} if part_id else {}
        return list(self.decisions.find(query, {"_id": 0}).sort("at", DESCENDING).limit(limit))


def window_start(today: date, days: int) -> date:
    return today - timedelta(days=days - 1)

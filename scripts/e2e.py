"""End-to-end check against a running stack (used by CI, works against docker compose too).

    INVENTORY_URL=http://localhost:8080 REORDER_URL=http://localhost:8090 python scripts/e2e.py

Expects the demo plant to be seeded. Verifies the whole event path:
inventory API -> outbox -> Kafka -> reorder consumer -> Mongo -> reorder API
-> approval -> purchase order back in the inventory API.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

INV = os.environ.get("INVENTORY_URL", "http://localhost:8080")
REO = os.environ.get("REORDER_URL", "http://localhost:8090")


def call(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def wait_for(what: str, fn, timeout: float = 60.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(1)
    sys.exit(f"FAIL: timed out waiting for {what}")


def check(cond: bool, msg: str) -> None:
    if not cond:
        sys.exit(f"FAIL: {msg}")
    print(f"ok  {msg}")


parts = call("GET", f"{INV}/v1/parts")[1]["items"]
check(len(parts) >= 12, f"inventory API serves {len(parts)} seeded parts")

assessed = wait_for(
    "the consumer to assess every part from Kafka events",
    lambda: (lambda a: a if len(a) >= len(parts) else None)(call("GET", f"{REO}/v1/assessments")[1]["items"]),
)
check(len(assessed) == len(parts), "reorder consumer assessed every part from the event stream")

pending = wait_for("a pending recommendation", lambda: call("GET", f"{REO}/v1/recommendations?status=pending")[1]["items"])
rec = pending[0]
check(rec["quantity"] > 0 and rec["advice"]["summary"], f"recommendation for {rec['partId']}: order {rec['quantity']}")

part_before = call("GET", f"{INV}/v1/parts/{rec['partId']}")[1]
status, approved = call("POST", f"{REO}/v1/recommendations/{rec['id']}/approve", {"approvedBy": "ci@partflow"})
check(status == 200 and approved["status"] == "approved", "approval accepted")
status, again = call("POST", f"{REO}/v1/recommendations/{rec['id']}/approve", {"approvedBy": "ci@partflow"})
check(status == 200 and again["purchaseOrderId"] == approved["purchaseOrderId"], "retried approval is idempotent")

orders = call("GET", f"{INV}/v1/purchase-orders?status=open")[1]["items"]
mine = [o for o in orders if o["id"] == approved["purchaseOrderId"]]
check(len(mine) == 1 and mine[0]["source"] == "ai_recommendation", "purchase order created in the inventory API")
part_after = call("GET", f"{INV}/v1/parts/{rec['partId']}")[1]
check(part_after["onOrder"] == part_before["onOrder"] + rec["quantity"], "on-order quantity increased by the approved amount")

# The PO's own stock event flows back through Kafka; the recommendation must stay approved, not superseded.
time.sleep(3)
check(call("GET", f"{REO}/v1/recommendations/{rec['id']}")[1]["status"] == "approved", "approved recommendation not superseded by its own PO event")

# Oversell guard through the public API.
victim = parts[0]["id"]
on_hand = call("GET", f"{INV}/v1/parts/{victim}")[1]["onHand"]
status, body = call("POST", f"{INV}/v1/stock/movements", {"partId": victim, "kind": "consumption", "quantity": on_hand + 1})
check(status == 409 and body["error"] == "insufficient_stock", "consumption beyond on-hand is rejected")

print("\nend-to-end: all checks passed")

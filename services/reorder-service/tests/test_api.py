import httpx
import pytest
import respx
from conftest import TODAY, EventFactory, history
from fastapi.testclient import TestClient

from reorder.advisor import Advisor
from reorder.api import create_app
from reorder.handler import EventHandler
from reorder.inventory_client import InventoryClient

INV = "http://inventory.test"


@pytest.fixture
def rec_id(store, settings):
    h = EventHandler(store, Advisor(None, "m"), settings, today=lambda: TODAY)
    f = EventFactory()
    for e in history(f, [10] * 27):
        h.handle(e)
    return h.handle(f.consume(130)).recommendation_id


@pytest.fixture
def client(store):
    return TestClient(create_app(store, InventoryClient(INV)))


@respx.mock
def test_approve_creates_one_purchase_order_and_audits(client, store, rec_id):
    route = respx.post(f"{INV}/v1/purchase-orders").mock(return_value=httpx.Response(201, json={"id": "po-1"}))
    rec = store.get(rec_id)
    res = client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "planner@plant"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "approved" and body["purchaseOrderId"] == "po-1"
    sent = route.calls[0].request
    import json

    assert json.loads(sent.content) == {
        "partId": "P-100",
        "quantity": rec["quantity"],
        "source": "ai_recommendation",
        "recommendationId": rec_id,
        "approvedBy": "planner@plant",
    }
    # A retried approval is a no-op.
    again = client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "planner@plant"})
    assert again.status_code == 200 and route.call_count == 1
    actions = [d["action"] for d in client.get("/v1/decisions?partId=P-100").json()["items"]]
    assert actions == ["approved", "approving", "created"]


@respx.mock
def test_quantity_override_is_recorded(client, store, rec_id):
    respx.post(f"{INV}/v1/purchase-orders").mock(return_value=httpx.Response(201, json={"id": "po-2"}))
    recommended = store.get(rec_id)["quantity"]
    res = client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "p", "quantity": recommended + 50})
    assert res.json()["quantityOverride"] == {"recommended": recommended, "approved": recommended + 50}


@respx.mock
def test_inventory_failure_returns_502_and_reopens_the_recommendation(client, store, rec_id):
    respx.post(f"{INV}/v1/purchase-orders").mock(return_value=httpx.Response(503, text="db down"))
    res = client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "p"})
    assert res.status_code == 502
    assert store.get(rec_id)["status"] == "pending"
    respx.post(f"{INV}/v1/purchase-orders").mock(side_effect=httpx.ConnectError("refused"))
    assert client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "p"}).status_code == 502
    assert store.get(rec_id)["status"] == "pending"


def test_reject_and_state_conflicts(client, store, rec_id):
    res = client.post(f"/v1/recommendations/{rec_id}/reject", json={"rejectedBy": "p", "reason": "Line 2 retooling next week"})
    assert res.status_code == 200 and res.json()["status"] == "rejected"
    assert client.post(f"/v1/recommendations/{rec_id}/reject", json={"rejectedBy": "p", "reason": "x"}).status_code == 409
    assert client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": "p"}).status_code == 409
    assert client.post("/v1/recommendations/nope/reject", json={"rejectedBy": "p", "reason": "x"}).status_code == 404
    assert client.get("/v1/recommendations/nope").status_code == 404


def test_list_filters_by_status_and_validates_input(client, rec_id):
    assert [r["id"] for r in client.get("/v1/recommendations?status=pending").json()["items"]] == [rec_id]
    assert client.get("/v1/recommendations?status=approved").json()["items"] == []
    assert client.get("/v1/recommendations?status=bogus").status_code == 422
    assert client.post(f"/v1/recommendations/{rec_id}/approve", json={"approvedBy": ""}).status_code == 422
    assert client.get("/healthz").json() == {"status": "ok"}
    [a] = client.get("/v1/assessments").json()["items"]
    assert a["partId"] == "P-100" and a["reorder"] is True and a["risk"] in ("medium", "high")

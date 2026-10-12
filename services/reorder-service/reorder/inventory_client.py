"""HTTP client for the inventory API (the system of record for purchase orders)."""

from __future__ import annotations

import httpx


class InventoryError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"inventory API returned {status}: {body[:200]}")
        self.status = status


class InventoryClient:
    def __init__(self, base_url: str, client: httpx.Client | None = None) -> None:
        self._http = client or httpx.Client(base_url=base_url, timeout=httpx.Timeout(5.0, connect=2.0))

    def create_purchase_order(self, *, part_id: str, quantity: int, recommendation_id: str, approved_by: str) -> dict:
        """Idempotent on recommendation_id: a retried approval returns the same PO."""
        resp = self._http.post(
            "/v1/purchase-orders",
            json={
                "partId": part_id,
                "quantity": quantity,
                "source": "ai_recommendation",
                "recommendationId": recommendation_id,
                "approvedBy": approved_by,
            },
        )
        if resp.status_code not in (200, 201):
            raise InventoryError(resp.status_code, resp.text)
        return resp.json()

    def close(self) -> None:
        self._http.close()

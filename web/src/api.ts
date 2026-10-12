export interface Part {
  id: string;
  sku: string;
  name: string;
  supplierId: string;
  supplierName: string;
  leadTimeDays: number;
  unitCostCents: number;
  safetyStock: number;
  onHand: number;
  onOrder: number;
  updatedAt: string;
}

export interface Assessment {
  partId: string;
  reorderPoint: number;
  safetyStock: number;
  position: number;
  daysOfCover: number | null;
  risk: "low" | "medium" | "high";
  reorder: boolean;
  demand: { days: number; meanPerDay: number; stdevPerDay: number; lowConfidence: boolean };
}

export interface Recommendation {
  id: string;
  partId: string;
  sku: string;
  name: string;
  status: "pending" | "approving" | "approved" | "rejected" | "superseded";
  quantity: number;
  reorderPoint: number;
  position: number;
  onHand: number;
  onOrder: number;
  daysOfCover: number | null;
  leadTimeDays: number;
  unitCostCents: number;
  risk: "low" | "medium" | "high";
  advice: { summary: string; risk_factors: string[]; planner_note: string };
  adviceSource: string;
  createdAt: string;
  purchaseOrderId?: string;
}

export interface Movement {
  id: string;
  partId: string;
  kind: "receipt" | "consumption" | "adjustment";
  quantity: number;
  onHandAfter: number;
  reference: string | null;
  occurredAt: string;
}

export interface PurchaseOrder {
  id: string;
  partId: string;
  quantity: number;
  status: "open" | "received" | "cancelled";
  source: "manual" | "ai_recommendation";
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const INVENTORY = "/api/inventory";
const REORDER = "/api/reorder";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = body.detail ?? body;
    throw new ApiError(res.status, detail.error ?? "error", detail.message ?? detail.detail ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  parts: () => request<{ items: Part[] }>(`${INVENTORY}/v1/parts`).then((r) => r.items),
  movements: (limit = 12) => request<{ items: Movement[] }>(`${INVENTORY}/v1/stock/movements?limit=${limit}`).then((r) => r.items),
  openOrders: () => request<{ items: PurchaseOrder[] }>(`${INVENTORY}/v1/purchase-orders?status=open`).then((r) => r.items),
  receive: (id: string) => request<PurchaseOrder>(`${INVENTORY}/v1/purchase-orders/${id}/receive`, { method: "POST" }),
  consume: (partId: string, quantity: number, reference: string) =>
    request<Movement>(`${INVENTORY}/v1/stock/movements`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ partId, kind: "consumption", quantity, reference }),
    }),
  assessments: () => request<{ items: Assessment[] }>(`${REORDER}/v1/assessments`).then((r) => r.items),
  recommendations: () => request<{ items: Recommendation[] }>(`${REORDER}/v1/recommendations?limit=50`).then((r) => r.items),
  approve: (id: string, approvedBy: string, quantity?: number) =>
    request<Recommendation>(`${REORDER}/v1/recommendations/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approvedBy, quantity }),
    }),
  reject: (id: string, rejectedBy: string, reason: string) =>
    request<Recommendation>(`${REORDER}/v1/recommendations/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ rejectedBy, reason }),
    }),
  streamUrl: `${INVENTORY}/v1/stream`,
};

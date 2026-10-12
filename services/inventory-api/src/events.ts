import { randomUUID } from "node:crypto";
import type { Tx } from "./db/pool.js";

/** Versioned envelope shared by every event PartFlow publishes. */
export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  type: string;
  version: 1;
  occurredAt: string;
  partId: string;
  data: T;
}

export type StockChangeReason =
  | "receipt"
  | "consumption"
  | "adjustment"
  | "po_created"
  | "po_received"
  | "po_cancelled";

export interface PartSnapshot {
  sku: string;
  name: string;
  supplierId: string;
  leadTimeDays: number;
  safetyStock: number;
  unitCostCents: number;
}

/**
 * Event-carried state: consumers get the part attributes they need to make a
 * decision (lead time, safety stock) without a synchronous call back to this API.
 */
export interface StockChangedData {
  reason: StockChangeReason;
  delta: number;
  onHand: number;
  onOrder: number;
  /** Monotonic per part; consumers use it to ignore stale or replayed snapshots. */
  stockVersion: number;
  movementId?: string;
  purchaseOrderId?: string;
  part: PartSnapshot;
}

export const EVENT_TYPES = {
  stockChanged: "inventory.stock_changed",
  poCreated: "purchasing.po_created",
  poReceived: "purchasing.po_received",
  poCancelled: "purchasing.po_cancelled",
} as const;

export const NOTIFY_CHANNEL = "partflow_stock";

/**
 * Appends an event to the outbox inside the caller's transaction, so the event
 * exists if and only if the state change commits. Also issues a NOTIFY, which
 * Postgres delivers only on commit, to push live updates to dashboard clients.
 */
export async function appendEvent<T>(
  tx: Tx,
  topic: string,
  type: string,
  partId: string,
  data: T,
  occurredAt: Date = new Date(),
): Promise<EventEnvelope<T>> {
  const envelope: EventEnvelope<T> = {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    partId,
    data,
  };
  await tx.query(
    `INSERT INTO outbox (event_id, topic, message_key, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [envelope.eventId, topic, partId, type, JSON.stringify(envelope)],
  );
  await tx.query("SELECT pg_notify($1, $2)", [
    NOTIFY_CHANNEL,
    JSON.stringify({ type, partId, eventId: envelope.eventId }),
  ]);
  return envelope;
}

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { freshDatabase, seedPart, testApp } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDatabase();
  app = await testApp(pool);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const consume = (partId: string, quantity: number, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/v1/stock/movements", headers, payload: { partId, kind: "consumption", quantity } });

describe("parts", () => {
  it("creates a part with its opening stock and lists it", async () => {
    const partId = await seedPart(pool, { onHand: 40 });
    const res = await app.inject({ method: "GET", url: `/v1/parts/${partId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: partId, onHand: 40, onOrder: 0, leadTimeDays: 10, supplierName: "Acme Cells" });
  });

  it("rejects a duplicate part with 409", async () => {
    await seedPart(pool);
    const res = await app.inject({
      method: "POST",
      url: "/v1/parts",
      payload: { id: "P-100", sku: "OTHER", name: "x", supplierId: "SUP-1", unitCostCents: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("part_exists");
  });

  it("returns 404 for an unknown supplier and validation errors for bad input", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/v1/parts",
      payload: { id: "P-9", sku: "S9", name: "x", supplierId: "NOPE", unitCostCents: 1 },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: "POST", url: "/v1/parts", payload: { id: "bad id!", sku: "" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("validation_failed");
  });
});

describe("stock movements", () => {
  it("consumes stock and writes the movement, the new level and an outbox event atomically", async () => {
    const partId = await seedPart(pool, { onHand: 100 });
    const res = await consume(partId, 30);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ partId, kind: "consumption", quantity: -30, onHandAfter: 70 });

    const level = await pool.query("SELECT on_hand FROM stock_levels WHERE part_id = $1", [partId]);
    expect(level.rows[0].on_hand).toBe(70);

    const events = await pool.query("SELECT payload FROM outbox WHERE event_type = 'inventory.stock_changed' ORDER BY id");
    const last = events.rows.at(-1).payload;
    expect(last).toMatchObject({
      type: "inventory.stock_changed",
      partId,
      data: { reason: "consumption", delta: -30, onHand: 70, onOrder: 0, stockVersion: 1, part: { leadTimeDays: 10, safetyStock: 20 } },
    });
  });

  it("refuses to drive stock negative and leaves no partial writes behind", async () => {
    const partId = await seedPart(pool, { onHand: 5 });
    const before = await pool.query("SELECT count(*)::int AS n FROM outbox");
    const res = await consume(partId, 6);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_stock", onHand: 5, requested: 6 });
    const after = await pool.query("SELECT count(*)::int AS n FROM outbox");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const moves = await pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE kind = 'consumption'");
    expect(moves.rows[0].n).toBe(0);
  });

  it("never oversells under 200 concurrent consumption requests", async () => {
    const partId = await seedPart(pool, { onHand: 100 });
    const results = await Promise.all(Array.from({ length: 200 }, () => consume(partId, 1)));
    const ok = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter((r) => r.statusCode === 409).length;
    expect(ok).toBe(100);
    expect(rejected).toBe(100);
    const level = await pool.query("SELECT on_hand FROM stock_levels WHERE part_id = $1", [partId]);
    expect(level.rows[0].on_hand).toBe(0);
    // Every committed movement produced exactly one event; on_hand_after values are a gapless 99..0 sequence.
    const after = await pool.query("SELECT on_hand_after FROM stock_movements WHERE kind = 'consumption' ORDER BY on_hand_after DESC");
    expect(after.rows.map((r) => r.on_hand_after)).toEqual(Array.from({ length: 100 }, (_, i) => 99 - i));
  });

  it("replays an idempotent request instead of applying it twice, including concurrent retries", async () => {
    const partId = await seedPart(pool, { onHand: 50 });
    const first = await consume(partId, 10, { "idempotency-key": "line-3-shift-a-0001" });
    expect(first.statusCode).toBe(201);
    const retries = await Promise.all(Array.from({ length: 10 }, () => consume(partId, 10, { "idempotency-key": "line-3-shift-a-0001" })));
    for (const r of retries) {
      expect(r.statusCode).toBe(200);
      expect(r.headers["idempotent-replayed"]).toBe("true");
      expect(r.json().id).toBe(first.json().id);
    }
    const level = await pool.query("SELECT on_hand FROM stock_levels WHERE part_id = $1", [partId]);
    expect(level.rows[0].on_hand).toBe(40);

    // Concurrent first attempts with a fresh key: exactly one applies.
    const race = await Promise.all(Array.from({ length: 10 }, () => consume(partId, 5, { "idempotency-key": "race-key" })));
    expect(race.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const level2 = await pool.query("SELECT on_hand FROM stock_levels WHERE part_id = $1", [partId]);
    expect(level2.rows[0].on_hand).toBe(35);
  });

  it("accepts backfilled movements but rejects future timestamps and wrong signs", async () => {
    const partId = await seedPart(pool);
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const ok = await app.inject({
      method: "POST",
      url: "/v1/stock/movements",
      payload: { partId, kind: "consumption", quantity: 3, occurredAt: past },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().occurredAt).toBe(past);

    const future = await app.inject({
      method: "POST",
      url: "/v1/stock/movements",
      payload: { partId, kind: "consumption", quantity: 3, occurredAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(future.statusCode).toBe(400);
    const negative = await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "receipt", quantity: -3 } });
    expect(negative.statusCode).toBe(400);
  });

  it("applies signed adjustments and lists movements newest first", async () => {
    const partId = await seedPart(pool, { onHand: 10 });
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "adjustment", quantity: -4, reference: "cycle count" } });
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "receipt", quantity: 7 } });
    const res = await app.inject({ method: "GET", url: `/v1/stock/movements?partId=${partId}&limit=5` });
    const items = res.json().items;
    expect(items.map((m: { kind: string }) => m.kind)).toEqual(["receipt", "adjustment"]);
    expect(items[0].onHandAfter).toBe(13);
  });
});

describe("purchase orders", () => {
  it("moves quantity from on-order to on-hand when a PO is received", async () => {
    const partId = await seedPart(pool, { onHand: 10 });
    const created = await app.inject({ method: "POST", url: "/v1/purchase-orders", payload: { partId, quantity: 60 } });
    expect(created.statusCode).toBe(201);
    let part = (await app.inject({ method: "GET", url: `/v1/parts/${partId}` })).json();
    expect(part).toMatchObject({ onHand: 10, onOrder: 60 });

    const received = await app.inject({ method: "POST", url: `/v1/purchase-orders/${created.json().id}/receive` });
    expect(received.statusCode).toBe(200);
    expect(received.json().status).toBe("received");
    part = (await app.inject({ method: "GET", url: `/v1/parts/${partId}` })).json();
    expect(part).toMatchObject({ onHand: 70, onOrder: 0 });

    const again = await app.inject({ method: "POST", url: `/v1/purchase-orders/${created.json().id}/receive` });
    expect(again.statusCode).toBe(409);
    const types = (await pool.query("SELECT event_type FROM outbox ORDER BY id")).rows.map((r) => r.event_type);
    expect(types).toEqual([
      "inventory.stock_changed",
      "purchasing.po_created",
      "inventory.stock_changed",
      "purchasing.po_received",
      "inventory.stock_changed",
    ]);
  });

  it("creates at most one PO per AI recommendation, even when approval is retried", async () => {
    const partId = await seedPart(pool);
    const body = { partId, quantity: 25, source: "ai_recommendation", recommendationId: "rec-42", approvedBy: "planner@plant" };
    const results = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: "POST", url: "/v1/purchase-orders", payload: body })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const part = (await app.inject({ method: "GET", url: `/v1/parts/${partId}` })).json();
    expect(part.onOrder).toBe(25);
  });

  it("cancels an open PO and releases its on-order quantity", async () => {
    const partId = await seedPart(pool);
    const po = (await app.inject({ method: "POST", url: "/v1/purchase-orders", payload: { partId, quantity: 15 } })).json();
    const res = await app.inject({ method: "POST", url: `/v1/purchase-orders/${po.id}/cancel` });
    expect(res.json().status).toBe("cancelled");
    const part = (await app.inject({ method: "GET", url: `/v1/parts/${partId}` })).json();
    expect(part.onOrder).toBe(0);
    const bad = await app.inject({ method: "POST", url: "/v1/purchase-orders/not-a-uuid/cancel" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("health", () => {
  it("reports liveness and database readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).json()).toEqual({ status: "ready" });
  });
});

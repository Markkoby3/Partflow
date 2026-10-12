import type pg from "pg";
import { withTransaction, type Tx } from "./db/pool.js";
import { AppError, conflict, isUniqueViolation, notFound } from "./errors.js";
import { appendEvent, EVENT_TYPES, type PartSnapshot, type StockChangeReason } from "./events.js";
import { metrics } from "./metrics.js";

export interface Supplier {
  id: string;
  name: string;
  leadTimeDays: number;
}

export interface PartView {
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
  recommendationId: string | null;
  approvedBy: string | null;
  createdAt: string;
  receivedAt: string | null;
}

export interface MovementInput {
  partId: string;
  kind: "receipt" | "consumption" | "adjustment";
  /** Positive for receipt/consumption; signed for adjustment. */
  quantity: number;
  reference?: string;
  idempotencyKey?: string;
  occurredAt?: Date;
}

export interface Result<T> {
  value: T;
  /** True when an idempotency key matched an earlier request and nothing changed. */
  replayed: boolean;
}

interface LockedStock {
  onHand: number;
  onOrder: number;
  version: number;
  part: PartSnapshot;
}

const PART_VIEW_SQL = `
  SELECT p.id, p.sku, p.name, p.supplier_id, sup.name AS supplier_name, sup.lead_time_days,
         p.unit_cost_cents, p.safety_stock, s.on_hand, s.on_order, s.updated_at
    FROM parts p
    JOIN suppliers sup ON sup.id = p.supplier_id
    JOIN stock_levels s ON s.part_id = p.id`;

function toPartView(r: Record<string, any>): PartView {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    leadTimeDays: r.lead_time_days,
    unitCostCents: r.unit_cost_cents,
    safetyStock: r.safety_stock,
    onHand: r.on_hand,
    onOrder: r.on_order,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function toMovement(r: Record<string, any>): Movement {
  return {
    id: r.id,
    partId: r.part_id,
    kind: r.kind,
    quantity: r.quantity,
    onHandAfter: r.on_hand_after,
    reference: r.reference,
    occurredAt: new Date(r.occurred_at).toISOString(),
  };
}

function toPurchaseOrder(r: Record<string, any>): PurchaseOrder {
  return {
    id: r.id,
    partId: r.part_id,
    quantity: r.quantity,
    status: r.status,
    source: r.source,
    recommendationId: r.recommendation_id,
    approvedBy: r.approved_by,
    createdAt: new Date(r.created_at).toISOString(),
    receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
  };
}

export class InventoryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly topic: string,
  ) {}

  // ---------- reads ----------

  async listParts(): Promise<PartView[]> {
    const { rows } = await this.pool.query(`${PART_VIEW_SQL} ORDER BY p.sku`);
    return rows.map(toPartView);
  }

  async getPart(id: string): Promise<PartView> {
    const { rows } = await this.pool.query(`${PART_VIEW_SQL} WHERE p.id = $1`, [id]);
    if (!rows[0]) throw notFound("part", id);
    return toPartView(rows[0]);
  }

  async listMovements(partId: string | undefined, limit: number): Promise<Movement[]> {
    const { rows } = partId
      ? await this.pool.query(
          "SELECT * FROM stock_movements WHERE part_id = $1 ORDER BY occurred_at DESC, created_at DESC LIMIT $2",
          [partId, limit],
        )
      : await this.pool.query(
          "SELECT * FROM stock_movements ORDER BY occurred_at DESC, created_at DESC LIMIT $1",
          [limit],
        );
    return rows.map(toMovement);
  }

  async listPurchaseOrders(status?: string): Promise<PurchaseOrder[]> {
    const { rows } = status
      ? await this.pool.query("SELECT * FROM purchase_orders WHERE status = $1 ORDER BY created_at DESC", [status])
      : await this.pool.query("SELECT * FROM purchase_orders ORDER BY created_at DESC LIMIT 200");
    return rows.map(toPurchaseOrder);
  }

  // ---------- master data ----------

  async upsertSupplier(s: Supplier): Promise<Supplier> {
    await this.pool.query(
      `INSERT INTO suppliers (id, name, lead_time_days) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, lead_time_days = EXCLUDED.lead_time_days`,
      [s.id, s.name, s.leadTimeDays],
    );
    return s;
  }

  async createPart(input: {
    id: string;
    sku: string;
    name: string;
    supplierId: string;
    unitCostCents: number;
    safetyStock: number;
    initialOnHand: number;
  }): Promise<PartView> {
    await withTransaction(this.pool, async (tx) => {
      const sup = await tx.query("SELECT 1 FROM suppliers WHERE id = $1", [input.supplierId]);
      if (sup.rowCount === 0) throw notFound("supplier", input.supplierId);
      try {
        await tx.query(
          `INSERT INTO parts (id, sku, name, supplier_id, unit_cost_cents, safety_stock)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.id, input.sku, input.name, input.supplierId, input.unitCostCents, input.safetyStock],
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("part_exists", `part ${input.id} or sku ${input.sku} already exists`);
        throw err;
      }
      await tx.query("INSERT INTO stock_levels (part_id, on_hand) VALUES ($1, $2)", [input.id, input.initialOnHand]);
      const locked = await this.lockStock(tx, input.id);
      await appendEvent(tx, this.topic, EVENT_TYPES.stockChanged, input.id, {
        reason: "adjustment" satisfies StockChangeReason,
        delta: input.initialOnHand,
        onHand: locked.onHand,
        onOrder: locked.onOrder,
        stockVersion: locked.version,
        part: locked.part,
      });
    });
    return this.getPart(input.id);
  }

  // ---------- stock movements ----------

  async recordMovement(input: MovementInput): Promise<Result<Movement>> {
    if (input.idempotencyKey) {
      const existing = await this.findMovementByKey(input.idempotencyKey);
      if (existing) return { value: existing, replayed: true };
    }
    const delta =
      input.kind === "consumption" ? -Math.abs(input.quantity) : input.kind === "receipt" ? Math.abs(input.quantity) : input.quantity;
    if (delta === 0) throw new AppError(400, "bad_request", "quantity must be non-zero");

    try {
      const movement = await withTransaction(this.pool, async (tx) => {
        const locked = await this.lockStock(tx, input.partId);
        const next = locked.onHand + delta;
        if (next < 0) {
          throw conflict("insufficient_stock", `part ${input.partId} has ${locked.onHand} on hand, cannot remove ${-delta}`, {
            onHand: locked.onHand,
            requested: -delta,
          });
        }
        await tx.query(
          "UPDATE stock_levels SET on_hand = $2, version = version + 1, updated_at = now() WHERE part_id = $1",
          [input.partId, next],
        );
        const { rows } = await tx.query(
          `INSERT INTO stock_movements (part_id, kind, quantity, on_hand_after, reference, idempotency_key, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now())) RETURNING *`,
          [input.partId, input.kind, delta, next, input.reference ?? null, input.idempotencyKey ?? null, input.occurredAt ?? null],
        );
        const m = toMovement(rows[0]!);
        await appendEvent(
          tx,
          this.topic,
          EVENT_TYPES.stockChanged,
          input.partId,
          {
            reason: input.kind satisfies StockChangeReason,
            delta,
            onHand: next,
            onOrder: locked.onOrder,
            movementId: m.id,
            stockVersion: locked.version + 1,
            part: locked.part,
          },
          input.occurredAt,
        );
        return m;
      });
      metrics.movements.add(1, { kind: input.kind });
      return { value: movement, replayed: false };
    } catch (err) {
      // Two requests raced with the same idempotency key: the loser returns the winner's result.
      if (input.idempotencyKey && isUniqueViolation(err, "stock_movements_idempotency_key_key")) {
        const existing = await this.findMovementByKey(input.idempotencyKey);
        if (existing) return { value: existing, replayed: true };
      }
      if (err instanceof AppError && err.code === "insufficient_stock") metrics.rejections.add(1, { reason: err.code });
      throw err;
    }
  }

  // ---------- purchase orders ----------

  async createPurchaseOrder(input: {
    partId: string;
    quantity: number;
    source: "manual" | "ai_recommendation";
    recommendationId?: string;
    approvedBy?: string;
  }): Promise<Result<PurchaseOrder>> {
    if (input.recommendationId) {
      const existing = await this.pool.query("SELECT * FROM purchase_orders WHERE recommendation_id = $1", [input.recommendationId]);
      if (existing.rows[0]) return { value: toPurchaseOrder(existing.rows[0]), replayed: true };
    }
    try {
      const po = await withTransaction(this.pool, async (tx) => {
        const locked = await this.lockStock(tx, input.partId);
        const { rows } = await tx.query(
          `INSERT INTO purchase_orders (part_id, quantity, source, recommendation_id, approved_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [input.partId, input.quantity, input.source, input.recommendationId ?? null, input.approvedBy ?? null],
        );
        const po = toPurchaseOrder(rows[0]!);
        const onOrder = locked.onOrder + input.quantity;
        await tx.query(
          "UPDATE stock_levels SET on_order = $2, version = version + 1, updated_at = now() WHERE part_id = $1",
          [input.partId, onOrder],
        );
        await appendEvent(tx, this.topic, EVENT_TYPES.poCreated, input.partId, { purchaseOrder: po });
        await appendEvent(tx, this.topic, EVENT_TYPES.stockChanged, input.partId, {
          reason: "po_created" satisfies StockChangeReason,
          delta: 0,
          onHand: locked.onHand,
          onOrder,
          purchaseOrderId: po.id,
          stockVersion: locked.version + 1,
          part: locked.part,
        });
        return po;
      });
      metrics.purchaseOrders.add(1, { source: input.source });
      return { value: po, replayed: false };
    } catch (err) {
      if (input.recommendationId && isUniqueViolation(err, "purchase_orders_recommendation_id_key")) {
        const existing = await this.pool.query("SELECT * FROM purchase_orders WHERE recommendation_id = $1", [input.recommendationId]);
        if (existing.rows[0]) return { value: toPurchaseOrder(existing.rows[0]), replayed: true };
      }
      throw err;
    }
  }

  async receivePurchaseOrder(id: string): Promise<PurchaseOrder> {
    return withTransaction(this.pool, async (tx) => {
      const po = await this.lockOpenPo(tx, id);
      const locked = await this.lockStock(tx, po.partId);
      const onHand = locked.onHand + po.quantity;
      const onOrder = Math.max(0, locked.onOrder - po.quantity);
      await tx.query(
        "UPDATE stock_levels SET on_hand = $2, on_order = $3, version = version + 1, updated_at = now() WHERE part_id = $1",
        [po.partId, onHand, onOrder],
      );
      const mv = await tx.query(
        `INSERT INTO stock_movements (part_id, kind, quantity, on_hand_after, reference)
         VALUES ($1, 'receipt', $2, $3, $4) RETURNING id`,
        [po.partId, po.quantity, onHand, `PO ${po.id}`],
      );
      const { rows } = await tx.query(
        "UPDATE purchase_orders SET status = 'received', received_at = now() WHERE id = $1 RETURNING *",
        [id],
      );
      const updated = toPurchaseOrder(rows[0]!);
      await appendEvent(tx, this.topic, EVENT_TYPES.poReceived, po.partId, { purchaseOrder: updated });
      await appendEvent(tx, this.topic, EVENT_TYPES.stockChanged, po.partId, {
        reason: "po_received" satisfies StockChangeReason,
        delta: po.quantity,
        onHand,
        onOrder,
        movementId: mv.rows[0]!.id,
        purchaseOrderId: po.id,
        stockVersion: locked.version + 1,
        part: locked.part,
      });
      return updated;
    });
  }

  async cancelPurchaseOrder(id: string): Promise<PurchaseOrder> {
    return withTransaction(this.pool, async (tx) => {
      const po = await this.lockOpenPo(tx, id);
      const locked = await this.lockStock(tx, po.partId);
      const onOrder = Math.max(0, locked.onOrder - po.quantity);
      await tx.query("UPDATE stock_levels SET on_order = $2, version = version + 1, updated_at = now() WHERE part_id = $1", [
        po.partId,
        onOrder,
      ]);
      const { rows } = await tx.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 RETURNING *", [id]);
      const updated = toPurchaseOrder(rows[0]!);
      await appendEvent(tx, this.topic, EVENT_TYPES.poCancelled, po.partId, { purchaseOrder: updated });
      await appendEvent(tx, this.topic, EVENT_TYPES.stockChanged, po.partId, {
        reason: "po_cancelled" satisfies StockChangeReason,
        delta: 0,
        onHand: locked.onHand,
        onOrder,
        purchaseOrderId: po.id,
        stockVersion: locked.version + 1,
        part: locked.part,
      });
      return updated;
    });
  }

  // ---------- helpers ----------

  private async findMovementByKey(key: string): Promise<Movement | null> {
    const { rows } = await this.pool.query("SELECT * FROM stock_movements WHERE idempotency_key = $1", [key]);
    return rows[0] ? toMovement(rows[0]) : null;
  }

  /** Row-locks the part's stock level so concurrent movements serialize per part. */
  private async lockStock(tx: Tx, partId: string): Promise<LockedStock> {
    const { rows } = await tx.query(
      `SELECT s.on_hand, s.on_order, s.version, p.sku, p.name, p.supplier_id, p.safety_stock, p.unit_cost_cents, sup.lead_time_days
         FROM stock_levels s
         JOIN parts p ON p.id = s.part_id
         JOIN suppliers sup ON sup.id = p.supplier_id
        WHERE s.part_id = $1
        FOR UPDATE OF s`,
      [partId],
    );
    const r = rows[0];
    if (!r) throw notFound("part", partId);
    return {
      onHand: r.on_hand,
      onOrder: r.on_order,
      version: Number(r.version),
      part: {
        sku: r.sku,
        name: r.name,
        supplierId: r.supplier_id,
        leadTimeDays: r.lead_time_days,
        safetyStock: r.safety_stock,
        unitCostCents: r.unit_cost_cents,
      },
    };
  }

  private async lockOpenPo(tx: Tx, id: string): Promise<PurchaseOrder> {
    const { rows } = await tx.query("SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw notFound("purchase order", id);
    const po = toPurchaseOrder(rows[0]);
    if (po.status !== "open") throw conflict("po_not_open", `purchase order ${id} is ${po.status}`);
    return po;
  }
}

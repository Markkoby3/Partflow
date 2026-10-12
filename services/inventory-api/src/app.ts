import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type pg from "pg";
import { z, ZodError } from "zod";
import { AppError } from "./errors.js";
import { InventoryService } from "./inventory.js";
import type { Logger } from "./logger.js";
import type { StockStream, StockNotification } from "./stream.js";

export interface AppDeps {
  pool: pg.Pool;
  logger: Logger;
  topic: string;
  corsOrigin?: string;
  stream?: StockStream;
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, - and _ only");
const uuid = z.uuid();

const SupplierBody = z.object({
  id,
  name: z.string().min(1).max(200),
  leadTimeDays: z.number().int().min(1).max(365),
});

const PartBody = z.object({
  id,
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  supplierId: id,
  unitCostCents: z.number().int().min(0),
  safetyStock: z.number().int().min(0).default(0),
  initialOnHand: z.number().int().min(0).default(0),
});

const MAX_BACKFILL_MS = 400 * 24 * 3600 * 1000;
const MovementBody = z
  .object({
    partId: id,
    kind: z.enum(["receipt", "consumption", "adjustment"]),
    quantity: z.number().int().refine((n) => n !== 0, "quantity must be non-zero"),
    reference: z.string().max(200).optional(),
    occurredAt: z.iso
      .datetime({ offset: true })
      .optional()
      .refine((s) => s === undefined || Date.parse(s) <= Date.now() + 60_000, "occurredAt cannot be in the future")
      .refine((s) => s === undefined || Date.now() - Date.parse(s) <= MAX_BACKFILL_MS, "occurredAt too far in the past"),
  })
  .refine((b) => b.kind === "adjustment" || b.quantity > 0, {
    message: "receipt and consumption quantities must be positive",
    path: ["quantity"],
  });

const PurchaseOrderBody = z.object({
  partId: id,
  quantity: z.number().int().min(1).max(1_000_000),
  source: z.enum(["manual", "ai_recommendation"]).default("manual"),
  recommendationId: z.string().min(1).max(100).optional(),
  approvedBy: z.string().min(1).max(100).optional(),
});

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: deps.logger as unknown as FastifyBaseLogger, bodyLimit: 64 * 1024 });
  const svc = new InventoryService(deps.pool, deps.topic);

  await app.register(cors, { origin: deps.corsOrigin ?? "*" });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "validation_failed", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: "internal", message: "internal server error" });
  });

  // ---- health ----
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await deps.pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "db_unavailable" });
    }
  });

  // ---- master data ----
  app.put("/v1/suppliers/:id", async (req) => {
    const body = SupplierBody.parse({ ...(req.body as object), id: (req.params as { id: string }).id });
    return svc.upsertSupplier(body);
  });

  app.post("/v1/parts", async (req, reply) => {
    const part = await svc.createPart(PartBody.parse(req.body));
    return reply.status(201).send(part);
  });

  app.get("/v1/parts", async () => ({ items: await svc.listParts() }));

  app.get("/v1/parts/:id", async (req) => svc.getPart(id.parse((req.params as { id: string }).id)));

  // ---- stock ----
  app.post("/v1/stock/movements", async (req, reply) => {
    const body = MovementBody.parse(req.body);
    const key = req.headers["idempotency-key"];
    const result = await svc.recordMovement({
      ...body,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
      idempotencyKey: typeof key === "string" && key.length > 0 ? key.slice(0, 200) : undefined,
    });
    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.replayed ? 200 : 201).send(result.value);
  });

  app.get("/v1/stock/movements", async (req) => {
    const q = z
      .object({ partId: id.optional(), limit: z.coerce.number().int().min(1).max(500).default(50) })
      .parse(req.query);
    return { items: await svc.listMovements(q.partId, q.limit) };
  });

  // ---- purchase orders ----
  app.post("/v1/purchase-orders", async (req, reply) => {
    const result = await svc.createPurchaseOrder(PurchaseOrderBody.parse(req.body));
    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.status(result.replayed ? 200 : 201).send(result.value);
  });

  app.get("/v1/purchase-orders", async (req) => {
    const q = z.object({ status: z.enum(["open", "received", "cancelled"]).optional() }).parse(req.query);
    return { items: await svc.listPurchaseOrders(q.status) };
  });

  app.post("/v1/purchase-orders/:id/receive", async (req) =>
    svc.receivePurchaseOrder(uuid.parse((req.params as { id: string }).id)),
  );

  app.post("/v1/purchase-orders/:id/cancel", async (req) =>
    svc.cancelPurchaseOrder(uuid.parse((req.params as { id: string }).id)),
  );

  // ---- live updates (Server-Sent Events) ----
  app.get("/v1/stream", (req, reply) => {
    const stream = deps.stream;
    if (!stream) return reply.status(503).send({ error: "stream_unavailable" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": deps.corsOrigin ?? "*",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    const onChange = (n: StockNotification) => res.write(`event: change\ndata: ${JSON.stringify(n)}\n\n`);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    stream.on("change", onChange);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      stream.off("change", onChange);
    });
  });

  return app;
}

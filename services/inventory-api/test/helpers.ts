import type pg from "pg";
import { buildApp } from "../src/app.js";
import { migrate } from "../src/db/migrations.js";
import { createPool } from "../src/db/pool.js";
import { createLogger } from "../src/logger.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://partflow@localhost:5432/partflow_test";
export const TOPIC = "partflow.inventory";

export async function freshDatabase(): Promise<pg.Pool> {
  const pool = createPool(TEST_DB, 40);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(pool);
  return pool;
}

export const silentLogger = () => createLogger("silent");

export async function testApp(pool: pg.Pool) {
  return buildApp({ pool, logger: silentLogger(), topic: TOPIC });
}

/** Seeds one supplier (10-day lead time) and one part with the given stock. */
export async function seedPart(pool: pg.Pool, opts: { id?: string; onHand?: number; safetyStock?: number } = {}) {
  const app = await testApp(pool);
  const partId = opts.id ?? "P-100";
  await app.inject({ method: "PUT", url: "/v1/suppliers/SUP-1", payload: { name: "Acme Cells", leadTimeDays: 10 } });
  const res = await app.inject({
    method: "POST",
    url: "/v1/parts",
    payload: {
      id: partId,
      sku: `SKU-${partId}`,
      name: "Battery module",
      supplierId: "SUP-1",
      unitCostCents: 125000,
      safetyStock: opts.safetyStock ?? 20,
      initialOnHand: opts.onHand ?? 100,
    },
  });
  if (res.statusCode !== 201) throw new Error(`seed failed: ${res.body}`);
  await app.close();
  return partId;
}

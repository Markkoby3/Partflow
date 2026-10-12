import type { Pool } from "pg";

/**
 * Forward-only, ordered migrations. Each runs in its own transaction and is
 * recorded in schema_migrations. An advisory lock makes concurrent replicas
 * starting at once safe: only one applies migrations, the rest wait.
 */
export const migrations: { version: string; sql: string }[] = [
  {
    version: "001_core_schema",
    sql: `
      CREATE TABLE suppliers (
        id              text PRIMARY KEY,
        name            text NOT NULL,
        lead_time_days  integer NOT NULL CHECK (lead_time_days > 0),
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE parts (
        id               text PRIMARY KEY,
        sku              text NOT NULL UNIQUE,
        name             text NOT NULL,
        supplier_id      text NOT NULL REFERENCES suppliers(id),
        unit_cost_cents  integer NOT NULL CHECK (unit_cost_cents >= 0),
        safety_stock     integer NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
        created_at       timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE stock_levels (
        part_id     text PRIMARY KEY REFERENCES parts(id) ON DELETE CASCADE,
        on_hand     integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
        on_order    integer NOT NULL DEFAULT 0 CHECK (on_order >= 0),
        version     bigint  NOT NULL DEFAULT 0,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE stock_movements (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        part_id          text NOT NULL REFERENCES parts(id),
        kind             text NOT NULL CHECK (kind IN ('receipt', 'consumption', 'adjustment')),
        quantity         integer NOT NULL CHECK (quantity <> 0),
        on_hand_after    integer NOT NULL,
        reference        text,
        idempotency_key  text UNIQUE,
        occurred_at      timestamptz NOT NULL DEFAULT now(),
        created_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX stock_movements_part_time ON stock_movements (part_id, occurred_at DESC);

      CREATE TABLE purchase_orders (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        part_id            text NOT NULL REFERENCES parts(id),
        quantity           integer NOT NULL CHECK (quantity > 0),
        status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'received', 'cancelled')),
        source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_recommendation')),
        recommendation_id  text UNIQUE,
        approved_by        text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        received_at        timestamptz
      );
      CREATE INDEX purchase_orders_open ON purchase_orders (part_id) WHERE status = 'open';

      -- Transactional outbox: written in the same transaction as the state change,
      -- published to Kafka by the relay. published_at IS NULL = not yet delivered.
      CREATE TABLE outbox (
        id            bigserial PRIMARY KEY,
        event_id      uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        topic         text NOT NULL,
        message_key   text NOT NULL,
        event_type    text NOT NULL,
        payload       jsonb NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        published_at  timestamptz,
        attempts      integer NOT NULL DEFAULT 0,
        last_error    text
      );
      CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
    `,
  },
];

const LOCK_KEY = 4_217_001; // arbitrary, stable advisory-lock id for migrations

export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [m.version]);
        await client.query("COMMIT");
        applied.push(m.version);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

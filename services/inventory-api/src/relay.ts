import type pg from "pg";
import type { Logger } from "./logger.js";
import { metrics } from "./metrics.js";
import type { EventPublisher, OutboundMessage } from "./publisher.js";

const RELAY_LOCK_KEY = 4_217_002;

export interface DrainResult {
  published: number;
  /** False when another replica holds the relay lock this tick. */
  leader: boolean;
}

/**
 * Polls the outbox and publishes events to the broker in commit order.
 *
 * Exactly one replica publishes at a time (transaction-scoped advisory lock),
 * which keeps per-part ordering intact when the API is scaled out. Delivery is
 * at-least-once: a crash between publish and the UPDATE re-sends the batch,
 * and consumers de-duplicate on eventId.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;
  private stopped = true;

  constructor(
    private readonly pool: pg.Pool,
    private readonly publisher: EventPublisher,
    private readonly log: Logger,
    private readonly opts: { batchSize: number; intervalMs: number },
  ) {
    metrics.outboxLag.addCallback(async (r) => {
      const { rows } = await this.pool.query(
        "SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS lag, count(*)::int AS pending FROM outbox WHERE published_at IS NULL",
      );
      r.observe(rows[0]?.lag ?? 0);
    });
    metrics.outboxPending.addCallback(async (r) => {
      const { rows } = await this.pool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL");
      r.observe(rows[0]?.n ?? 0);
    });
  }

  async drainOnce(): Promise<DrainResult> {
    const client = await this.pool.connect();
    const started = performance.now();
    let ids: string[] = [];
    try {
      await client.query("BEGIN");
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [RELAY_LOCK_KEY]);
      if (!lock.rows[0]?.ok) {
        await client.query("COMMIT");
        return { published: 0, leader: false };
      }
      const { rows } = await client.query<{
        id: string;
        event_id: string;
        topic: string;
        message_key: string;
        event_type: string;
        payload: unknown;
      }>(
        `SELECT id, event_id, topic, message_key, event_type, payload
           FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
        [this.opts.batchSize],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        return { published: 0, leader: true };
      }
      ids = rows.map((r) => r.id);
      const messages: OutboundMessage[] = rows.map((r) => ({
        topic: r.topic,
        key: r.message_key,
        value: JSON.stringify(r.payload),
        headers: { "event-id": r.event_id, "event-type": r.event_type, "content-type": "application/json" },
      }));
      await this.publisher.publish(messages);
      await client.query("UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = ANY($1::bigint[])", [ids]);
      await client.query("COMMIT");
      metrics.outboxPublished.add(rows.length);
      metrics.outboxBatchMs.record(performance.now() - started);
      return { published: rows.length, leader: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (ids.length > 0) {
        await this.pool
          .query("UPDATE outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])", [
            ids,
            String((err as Error).message ?? err).slice(0, 500),
          ])
          .catch(() => undefined);
      }
      metrics.outboxFailures.add(1);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Drains until the outbox is empty (used by tests and graceful shutdown). */
  async drainAll(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.drainOnce();
      total += r.published;
      if (!r.leader || r.published < this.opts.batchSize) return total;
    }
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.running = true;
    let next = this.opts.intervalMs;
    try {
      const r = await this.drainOnce();
      this.failures = 0;
      // A full batch means more is waiting: go again immediately.
      if (r.published >= this.opts.batchSize) next = 0;
    } catch (err) {
      this.failures += 1;
      next = Math.min(5_000, this.opts.intervalMs * 2 ** this.failures);
      this.log.warn({ err, failures: this.failures, retryInMs: next }, "outbox publish failed; will retry");
    } finally {
      this.running = false;
      this.schedule(next);
    }
  }
}

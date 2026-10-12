import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { InMemoryPublisher } from "../src/publisher.js";
import { OutboxRelay } from "../src/relay.js";
import { StockStream, type StockNotification } from "../src/stream.js";
import { freshDatabase, seedPart, silentLogger, testApp, TEST_DB, TOPIC } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;

beforeEach(async () => {
  pool = await freshDatabase();
  app = await testApp(pool);
});

afterEach(async () => {
  await app.close();
  await pool.end();
});

const relayWith = (publisher: InMemoryPublisher, batchSize = 50) =>
  new OutboxRelay(pool, publisher, silentLogger(), { batchSize, intervalMs: 10 });

describe("outbox relay", () => {
  it("publishes every committed event once, in commit order, keyed by part", async () => {
    const partId = await seedPart(pool, { onHand: 1000 });
    for (let i = 0; i < 120; i++) {
      await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 1 } });
    }
    const publisher = new InMemoryPublisher();
    const relay = relayWith(publisher, 50);
    const published = await relay.drainAll();
    expect(published).toBe(121); // opening balance + 120 consumptions
    expect(publisher.sent.every((m) => m.topic === TOPIC && m.key === partId)).toBe(true);
    const onHands = publisher.sent.slice(1).map((m) => JSON.parse(m.value).data.onHand);
    expect(onHands).toEqual(Array.from({ length: 120 }, (_, i) => 999 - i));
    const ids = publisher.sent.map((m) => m.headers["event-id"]);
    expect(new Set(ids).size).toBe(ids.length);
    const pending = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL");
    expect(pending.rows[0].n).toBe(0);
    expect(await relay.drainAll()).toBe(0);
  });

  it("keeps events and retries them in order after a broker outage", async () => {
    const partId = await seedPart(pool, { onHand: 10 });
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 2 } });
    const publisher = new InMemoryPublisher();
    publisher.failNext = 2;
    const relay = relayWith(publisher);
    await expect(relay.drainOnce()).rejects.toThrow("simulated broker outage");
    await expect(relay.drainOnce()).rejects.toThrow("simulated broker outage");
    const failed = await pool.query("SELECT attempts, last_error FROM outbox ORDER BY id LIMIT 1");
    expect(failed.rows[0]).toMatchObject({ attempts: 2, last_error: "simulated broker outage" });

    expect((await relay.drainOnce()).published).toBe(2);
    expect(publisher.sent.map((m) => JSON.parse(m.value).data.onHand)).toEqual([10, 8]);
  });

  it("lets only one relay replica publish at a time", async () => {
    const partId = await seedPart(pool, { onHand: 500 });
    await Promise.all(
      Array.from({ length: 60 }, () =>
        app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 1 } }),
      ),
    );
    const publishers = [new InMemoryPublisher(), new InMemoryPublisher(), new InMemoryPublisher()];
    const relays = publishers.map((p) => relayWith(p, 10));
    // Run three replicas concurrently until the outbox is drained.
    for (let round = 0; round < 50; round++) {
      await Promise.all(relays.map((r) => r.drainOnce()));
      const left = await pool.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL");
      if (left.rows[0].n === 0) break;
    }
    const all = publishers.flatMap((p) => p.sent);
    expect(all).toHaveLength(61);
    expect(new Set(all.map((m) => m.headers["event-id"])).size).toBe(61);
  });

  it("runs on a timer and stops cleanly", async () => {
    const partId = await seedPart(pool, { onHand: 3 });
    const publisher = new InMemoryPublisher();
    const relay = relayWith(publisher);
    relay.start();
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 1 } });
    const deadline = Date.now() + 5_000;
    while (publisher.sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await relay.stop();
    expect(publisher.sent).toHaveLength(2);
  });
});

describe("live stream", () => {
  it("notifies listeners only after the transaction commits", async () => {
    const stream = new StockStream(TEST_DB, silentLogger());
    await stream.start();
    const seen: StockNotification[] = [];
    stream.on("change", (n: StockNotification) => seen.push(n));
    const partId = await seedPart(pool, { onHand: 1 });
    // A rejected movement rolls back, so it must not produce a notification.
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 5 } });
    await app.inject({ method: "POST", url: "/v1/stock/movements", payload: { partId, kind: "consumption", quantity: 1 } });
    const deadline = Date.now() + 3_000;
    while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await stream.stop();
    expect(seen).toHaveLength(2);
    expect(seen.every((n) => n.partId === partId && n.type === "inventory.stock_changed")).toBe(true);
  });
});

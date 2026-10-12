import { describe, expect, it } from "vitest";
import { Kafka, logLevel } from "kafkajs";
import { randomUUID } from "node:crypto";
import { KafkaPublisher } from "../src/publisher.js";

// Runs only where a broker is available (CI starts Redpanda; locally: docker compose up redpanda).
const brokers = (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);

describe.skipIf(brokers.length === 0)("KafkaPublisher against a real broker", () => {
  it("delivers a batch to the topic with keys and headers intact", async () => {
    const topic = `partflow.test.${randomUUID().slice(0, 8)}`;
    const kafka = new Kafka({ clientId: "test", brokers, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic, numPartitions: 3 }], waitForLeaders: true });
    await admin.disconnect();

    const publisher = new KafkaPublisher(brokers, "test-publisher");
    await publisher.connect();
    await publisher.publish(
      Array.from({ length: 25 }, (_, i) => ({
        topic,
        key: `P-${i % 5}`,
        value: JSON.stringify({ n: i }),
        headers: { "event-id": `e-${i}`, "event-type": "inventory.stock_changed" },
      })),
    );
    await publisher.disconnect();

    const consumer = kafka.consumer({ groupId: `g-${randomUUID()}` });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    const got: { key: string; n: number; eventId: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out with ${got.length} messages`)), 20_000);
      void consumer.run({
        eachMessage: async ({ message }) => {
          got.push({
            key: message.key!.toString(),
            n: JSON.parse(message.value!.toString()).n,
            eventId: message.headers!["event-id"]!.toString(),
          });
          if (got.length === 25) {
            clearTimeout(timer);
            resolve();
          }
        },
      });
    });
    await consumer.disconnect();

    expect(got).toHaveLength(25);
    // Same key -> same partition -> order preserved per part.
    for (const key of ["P-0", "P-1", "P-2", "P-3", "P-4"]) {
      const ns = got.filter((g) => g.key === key).map((g) => g.n);
      expect(ns).toEqual([...ns].sort((a, b) => a - b));
    }
  });
});

// Standalone relay process, for running the outbox publisher separately from the API
// (set RELAY_ENABLED=false on the API replicas when using this).
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./logger.js";
import { KafkaPublisher } from "./publisher.js";
import { OutboxRelay } from "./relay.js";

const config = loadConfig();
if (config.kafkaBrokers.length === 0) throw new Error("KAFKA_BROKERS is required for the standalone relay");
const log = createLogger(config.logLevel).child({ component: "relay" });
const pool = createPool(config.databaseUrl, 4);
const publisher = new KafkaPublisher(config.kafkaBrokers, config.kafkaClientId);
await publisher.connect();
const relay = new OutboxRelay(pool, publisher, log, { batchSize: config.relayBatchSize, intervalMs: config.relayIntervalMs });
relay.start();
log.info("outbox relay started");

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    await relay.stop();
    await publisher.disconnect();
    await pool.end();
    process.exit(0);
  });
}

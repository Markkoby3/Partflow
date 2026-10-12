import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrations.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./logger.js";
import { InMemoryPublisher, KafkaPublisher, type EventPublisher } from "./publisher.js";
import { OutboxRelay } from "./relay.js";
import { StockStream } from "./stream.js";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);

const applied = await migrate(pool);
if (applied.length) log.info({ applied }, "migrations applied");

const stream = new StockStream(config.databaseUrl, log);
await stream.start();

const app = await buildApp({ pool, logger: log, topic: config.inventoryTopic, corsOrigin: config.corsOrigin, stream });

let relay: OutboxRelay | undefined;
let publisher: EventPublisher | undefined;
if (config.relayEnabled) {
  if (config.kafkaBrokers.length > 0) {
    publisher = new KafkaPublisher(config.kafkaBrokers, config.kafkaClientId);
  } else {
    log.warn("KAFKA_BROKERS not set: relay will mark events published without sending them anywhere");
    publisher = new InMemoryPublisher();
  }
  await publisher.connect();
  relay = new OutboxRelay(pool, publisher, log, { batchSize: config.relayBatchSize, intervalMs: config.relayIntervalMs });
  relay.start();
}

await app.listen({ port: config.port, host: config.host });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  await app.close();
  await relay?.stop();
  await publisher?.disconnect();
  await stream.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

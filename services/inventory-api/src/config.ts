export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  kafkaBrokers: string[];
  kafkaClientId: string;
  inventoryTopic: string;
  relayEnabled: boolean;
  relayBatchSize: number;
  relayIntervalMs: number;
  corsOrigin: string;
  logLevel: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://partflow@localhost:5432/partflow",
    kafkaBrokers: (env.KAFKA_BROKERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? "inventory-api",
    inventoryTopic: env.INVENTORY_TOPIC ?? "partflow.inventory",
    relayEnabled: bool(env.RELAY_ENABLED, true),
    relayBatchSize: int(env.RELAY_BATCH_SIZE, 200),
    relayIntervalMs: int(env.RELAY_INTERVAL_MS, 250),
    corsOrigin: env.CORS_ORIGIN ?? "*",
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

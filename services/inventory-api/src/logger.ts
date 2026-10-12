import { pino } from "pino";

export type Logger = pino.Logger;

export function createLogger(level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({ level, base: { service: "inventory-api" } });
}

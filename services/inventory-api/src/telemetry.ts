// Loaded with `node --import ./dist/telemetry.js` so instrumentation patches
// http, pg, fastify and pino before they are imported. Exports traces, metrics
// and logs over OTLP/HTTP to the Grafana LGTM stack (Tempo, Mimir/Prometheus, Loki).
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { FastifyInstrumentation } from "@opentelemetry/instrumentation-fastify";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== "true") {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "inventory-api",
      [ATTR_SERVICE_VERSION]: process.env.SERVICE_VERSION ?? "0.1.0",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 10_000 })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === "/healthz" || req.url === "/readyz" }),
      new PgInstrumentation(),
      new FastifyInstrumentation(),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => void sdk.shutdown().catch(() => undefined);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

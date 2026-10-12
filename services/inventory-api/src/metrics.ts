import { metrics as otel } from "@opentelemetry/api";

// The OpenTelemetry API is a no-op until the SDK in telemetry.ts is started,
// so these are safe to use in tests and scripts that never start it.
const meter = otel.getMeter("partflow.inventory-api");

export const metrics = {
  movements: meter.createCounter("partflow_stock_movements_total", {
    description: "Stock movements committed, by kind",
  }),
  rejections: meter.createCounter("partflow_stock_rejections_total", {
    description: "Stock movements rejected by business rules, by reason",
  }),
  purchaseOrders: meter.createCounter("partflow_purchase_orders_total", {
    description: "Purchase orders created, by source (manual vs AI recommendation)",
  }),
  outboxPublished: meter.createCounter("partflow_outbox_published_total", {
    description: "Outbox events delivered to Kafka",
  }),
  outboxFailures: meter.createCounter("partflow_outbox_publish_failures_total", {
    description: "Failed outbox publish batches",
  }),
  outboxBatchMs: meter.createHistogram("partflow_outbox_batch_duration", {
    description: "Time to publish and mark one outbox batch",
    unit: "ms",
  }),
  outboxLag: meter.createObservableGauge("partflow_outbox_lag_seconds", {
    description: "Age of the oldest unpublished outbox event",
    unit: "s",
  }),
  outboxPending: meter.createObservableGauge("partflow_outbox_pending", {
    description: "Unpublished outbox events",
  }),
};

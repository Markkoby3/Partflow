"""OpenTelemetry setup: traces, metrics and logs over OTLP/HTTP to Grafana LGTM."""

from __future__ import annotations

import logging
import os
import sys


def setup(service_name: str) -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        stream=sys.stdout,
        format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or os.environ.get("OTEL_SDK_DISABLED") == "true":
        return

    from opentelemetry import metrics, trace
    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", service_name)})
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(
        MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter(), export_interval_millis=10_000)])
    )
    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(logger_provider)
    logging.getLogger().addHandler(LoggingHandler(level=logging.INFO, logger_provider=logger_provider))

    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.pymongo import PymongoInstrumentor

    HTTPXClientInstrumentor().instrument()
    PymongoInstrumentor().instrument()

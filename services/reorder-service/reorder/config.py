from __future__ import annotations

import os
from dataclasses import dataclass, field


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    mongo_url: str = field(default_factory=lambda: os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
    mongo_db: str = field(default_factory=lambda: os.environ.get("MONGO_DB", "partflow"))
    kafka_brokers: str = field(default_factory=lambda: os.environ.get("KAFKA_BROKERS", "localhost:9092"))
    inventory_topic: str = field(default_factory=lambda: os.environ.get("INVENTORY_TOPIC", "partflow.inventory"))
    consumer_group: str = field(default_factory=lambda: os.environ.get("CONSUMER_GROUP", "reorder-service"))
    inventory_api_url: str = field(default_factory=lambda: os.environ.get("INVENTORY_API_URL", "http://localhost:8080"))
    anthropic_api_key: str | None = field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY") or None)
    advisor_model: str = field(default_factory=lambda: os.environ.get("ADVISOR_MODEL", "claude-haiku-5-5"))
    advisor_timeout_s: float = field(default_factory=lambda: _float("ADVISOR_TIMEOUT_S", 10.0))
    service_level_z: float = field(default_factory=lambda: _float("SERVICE_LEVEL_Z", 1.65))  # ~95% cycle service level
    demand_window_days: int = field(default_factory=lambda: _int("DEMAND_WINDOW_DAYS", 28))
    review_period_days: int = field(default_factory=lambda: _int("REVIEW_PERIOD_DAYS", 7))

import { Kafka, CompressionTypes, logLevel, type Producer } from "kafkajs";

export interface OutboundMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

/** Transport-agnostic publisher, so the relay can be tested without a broker. */
export interface EventPublisher {
  connect(): Promise<void>;
  /** Must resolve only once every message is durably accepted by the transport. */
  publish(messages: OutboundMessage[]): Promise<void>;
  disconnect(): Promise<void>;
}

export class KafkaPublisher implements EventPublisher {
  private readonly producer: Producer;

  constructor(brokers: string[], clientId: string) {
    const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN, retry: { retries: 5 } });
    // Idempotent producer + acks=all: broker de-duplicates retries, and a send
    // resolves only once all in-sync replicas have the record.
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, allowAutoTopicCreation: true });
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async publish(messages: OutboundMessage[]): Promise<void> {
    const byTopic = new Map<string, OutboundMessage[]>();
    for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
    await this.producer.sendBatch({
      acks: -1,
      compression: CompressionTypes.GZIP,
      topicMessages: [...byTopic.entries()].map(([topic, ms]) => ({
        topic,
        messages: ms.map((m) => ({ key: m.key, value: m.value, headers: m.headers })),
      })),
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}

/** In-process publisher for tests and for running the API with no broker configured. */
export class InMemoryPublisher implements EventPublisher {
  readonly sent: OutboundMessage[] = [];
  failNext = 0;

  async connect(): Promise<void> {}

  async publish(messages: OutboundMessage[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated broker outage");
    }
    this.sent.push(...messages);
  }

  async disconnect(): Promise<void> {}
}

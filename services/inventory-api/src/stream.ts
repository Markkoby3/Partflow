import { EventEmitter } from "node:events";
import pg from "pg";
import type { Logger } from "./logger.js";
import { NOTIFY_CHANNEL } from "./events.js";

export interface StockNotification {
  type: string;
  partId: string;
  eventId: string;
}

/**
 * One dedicated LISTEN connection per API replica fans Postgres NOTIFYs out to
 * every connected dashboard over Server-Sent Events. NOTIFY is delivered only
 * after commit, so clients never see a change that later rolled back.
 */
export class StockStream extends EventEmitter {
  private client: pg.Client | undefined;
  private closed = false;

  constructor(
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {
    super();
    this.setMaxListeners(1_000);
  }

  async start(): Promise<void> {
    this.closed = false;
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
      try {
        this.emit("change", JSON.parse(msg.payload) as StockNotification);
      } catch (err) {
        this.log.warn({ err }, "bad notification payload");
      }
    });
    client.on("error", (err) => {
      this.log.warn({ err }, "stock stream connection lost; reconnecting");
      void this.reconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.client = client;
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    await this.client?.end().catch(() => undefined);
    this.client = undefined;
    setTimeout(
      () =>
        void this.start().catch((err) => {
          this.log.error({ err }, "stock stream reconnect failed");
          void this.reconnect();
        }),
      1_000,
    );
  }

  async stop(): Promise<void> {
    this.closed = true;
    await this.client?.end().catch(() => undefined);
  }
}

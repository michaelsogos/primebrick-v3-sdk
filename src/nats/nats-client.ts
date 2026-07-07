import { connect, type NatsConnection, type JetStreamClient } from "nats";

/**
 * Singleton NATS connection manager. Extracted from emailsender's
 * nats/client.ts:1-31.
 *
 * Requires `nats` as a peer dependency — consumers that don't need NATS
 * can skip installing it and won't import this module.
 * No DB dependency.
 */
export class NatsClient {
  private static nc: NatsConnection | null = null;
  private static js: JetStreamClient | null = null;

  static async getConnection(): Promise<NatsConnection> {
    if (NatsClient.nc) return NatsClient.nc;
    const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
    NatsClient.nc = await connect({ servers: natsUrl });
    NatsClient.js = NatsClient.nc.jetstream();
    console.log(`Connected to NATS at ${natsUrl}`);
    return NatsClient.nc;
  }

  static getJetStream(): JetStreamClient {
    if (!NatsClient.js) {
      throw new Error("NATS JetStream not initialized. Call NatsClient.getConnection() first.");
    }
    return NatsClient.js;
  }

  static async close(): Promise<void> {
    if (NatsClient.nc) {
      await NatsClient.nc.close();
      NatsClient.nc = null;
      NatsClient.js = null;
      console.log("NATS connection closed");
    }
  }
}

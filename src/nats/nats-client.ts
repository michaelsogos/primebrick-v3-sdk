import { connect, headers, type NatsConnection, type JetStreamClient, type Subscription, type Msg, type MsgHdrs } from "nats";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";

/**
 * Singleton NATS connection manager. Extracted from emailsender's
 * nats/client.ts:1-31.
 *
 * Requires `nats` as a peer dependency — consumers that don't need NATS
 * can skip installing it and won't import this module.
 * No DB dependency.
 *
 * The `publish()`, `subscribe()`, and `subscribeRequest()` methods use
 * Ext-JSON (BigInt-safe) serialization automatically. Consumers pass plain
 * TS objects and receive plain TS objects — they never call extJson functions
 * directly.
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

  /**
   * Check if the NATS connection is alive.
   * Returns false if the connection was never established or has been closed.
   */
  static isConnected(): boolean {
    return NatsClient.nc !== null && !NatsClient.nc.isClosed();
  }

  static async close(): Promise<void> {
    if (NatsClient.nc) {
      await NatsClient.nc.close();
      NatsClient.nc = null;
      NatsClient.js = null;
      console.log("NATS connection closed");
    }
  }

  /**
   * Publish a message with automatic Ext-JSON serialization.
   * The data object is serialized with extJsonStringify (BigInt-safe)
   * and encoded as UTF-8 before publishing.
   *
   * @param subject - NATS subject (e.g. "emailsender.send", "customer.created")
   * @param data - Any serializable object (bigint values are preserved)
   * @param headers - Optional NATS headers (e.g. auth headers for GATEWAY-RESOLVED mode)
   *
   * Example:
   *   await NatsClient.publish("customer.created", { entity_id: 42n, action: "CREATED" });
   *   await NatsClient.publish("emailsender.send", request, authHeaders);
   */
  static async publish(subject: string, data: unknown, hdrs?: Record<string, string>): Promise<void> {
    const nc = await NatsClient.getConnection();
    const payload = new TextEncoder().encode(extJsonStringify(data));
    if (hdrs && Object.keys(hdrs).length > 0) {
      const natsHeaders = headers();
      for (const [key, value] of Object.entries(hdrs)) {
        natsHeaders.set(key, value);
      }
      nc.publish(subject, payload, { headers: natsHeaders });
    } else {
      nc.publish(subject, payload);
    }
  }

  /**
   * Subscribe to a NATS subject with automatic Ext-JSON deserialization.
   * Each incoming message is decoded from UTF-8 and parsed with extJsonParse
   * (BigInt-safe). The handler receives a typed object — no manual decode/parse.
   *
   * @param subject - NATS subject to subscribe to
   * @param handler - Async function receiving the parsed message data and raw Msg
   * @returns The NATS Subscription (can be unsubscribed or iterated)
   *
   * Example:
   *   await NatsClient.subscribe<SendEmailRequest>(
   *     "emailsender.send",
   *     async (request) => {
   *       console.log(`Received: ${request.requestId}`);
   *       // request.entity_id is bigint if present
   *     }
   *   );
   */
  static async subscribe<T = unknown>(
    subject: string,
    handler: (data: T, raw: Msg) => Promise<void>,
  ): Promise<Subscription> {
    const nc = await NatsClient.getConnection();
    const sub = nc.subscribe(subject);

    (async () => {
      for await (const msg of sub) {
        try {
          const text = new TextDecoder().decode(msg.data);
          if (text === "") {
            // Empty payload — skip parsing, call handler with null
            await handler(null as T, msg);
            continue;
          }
          const data = extJsonParse<T>(text);
          await handler(data, msg);
        } catch (error) {
          console.error(`[NATS] Error processing message on "${subject}":`, error);
        }
      }
    })();

    return sub;
  }

  /**
   * Subscribe to a NATS subject with request-reply pattern.
   * The handler receives the parsed request and returns a response that is
   * automatically serialized with extJsonStringify and published back to
   * `msg.reply` (if set).
   *
   * @param subject - NATS subject to subscribe to
   * @param handler - Async function receiving parsed request, returning response
   * @returns The NATS Subscription
   *
   * Example:
   *   await NatsClient.subscribeRequest<SendEmailRequest, SendEmailResponse>(
   *     "emailsender.send",
   *     async (request) => {
   *       return { requestId: request.requestId, success: true };
   *     }
   *   );
   */
  static async subscribeRequest<TRequest = unknown, TResponse = unknown>(
    subject: string,
    handler: (request: TRequest, raw: Msg) => Promise<TResponse>,
  ): Promise<Subscription> {
    const nc = await NatsClient.getConnection();
    const sub = nc.subscribe(subject);

    (async () => {
      for await (const msg of sub) {
        let requestId: string | undefined;
        try {
          const text = new TextDecoder().decode(msg.data);
          const request = extJsonParse<TRequest>(text);
          requestId = (request as { requestId?: string })?.requestId;
          const response = await handler(request, msg);
          if (msg.reply) {
            const payload = new TextEncoder().encode(extJsonStringify(response));
            nc.publish(msg.reply, payload);
          }
        } catch (error) {
          console.error(`[NATS] Error processing request on "${subject}":`, error);
          if (msg.reply) {
            const errorResponse = {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
              requestId,
            };
            const payload = new TextEncoder().encode(extJsonStringify(errorResponse));
            nc.publish(msg.reply, payload);
          }
        }
      }
    })();

    return sub;
  }
}

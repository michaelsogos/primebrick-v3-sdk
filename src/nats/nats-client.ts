import { connect, headers, type NatsConnection, type JetStreamClient, type Subscription, type Msg, type MsgHdrs } from "nats";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";
import { natsCarrier, extractNatsContext } from "../telemetry/otel.js";

const natsTracer = trace.getTracer("@primebrick/sdk");

/** Inject W3C traceparent/tracestate into a MsgHdrs instance. */
function injectInto(hdrs: MsgHdrs): void {
  propagation.inject(context.active(), hdrs, natsCarrier);
}

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
  private static serverVersion: string | null = null;
  private static serverUrl: string | null = null;

  static async getConnection(url?: string): Promise<NatsConnection> {
    if (NatsClient.nc) return NatsClient.nc;
    const natsUrl = url ?? process.env.NATS_URL ?? "nats://127.0.0.1:4222";
    NatsClient.nc = await connect({ servers: natsUrl });
    NatsClient.js = NatsClient.nc.jetstream();
    NatsClient.serverUrl = natsUrl;
    // nc.info is populated by the INFO handshake at connect time.
    // ServerInfo.version is a string like "2.14.3".
    NatsClient.serverVersion = NatsClient.nc.info?.version ?? null;
    console.log(`[startup] NATS ${NatsClient.serverVersion ?? "unknown"} connected (${natsUrl})`);
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

  /**
   * Returns the NATS server version (from the INFO handshake), or null
   * if the connection was never established or the version was not available.
   */
  static getServerVersion(): string | null {
    return NatsClient.serverVersion;
  }

  /**
   * Returns the NATS server URL used for the connection, or null if
   * the connection was never established.
   */
  static getServerUrl(): string | null {
    return NatsClient.serverUrl;
  }

  static async close(): Promise<void> {
    if (NatsClient.nc) {
      await NatsClient.nc.close();
      NatsClient.nc = null;
      NatsClient.js = null;
      NatsClient.serverVersion = null;
      NatsClient.serverUrl = null;
      console.log("NATS connection closed");
    }
  }

  /**
   * Send a request-reply message and wait for the response.
   * The request data is serialized with extJsonStringify (BigInt-safe) and
   * the response is parsed with extJsonParse.
   *
   * @param subject - NATS subject to send the request to
   * @param data - Request payload (any serializable object). Pass `null` or `""` for an empty request.
   * @param timeoutMs - Timeout in milliseconds. If the responder doesn't reply within this time, the promise rejects.
   * @returns The parsed response object, or `null` if the response was empty.
   *
   * Example:
   *   const config = await NatsClient.request<SharedConfig>("config.get", null, 5000);
   */
  static async request<TResponse = unknown>(
    subject: string,
    data: unknown = null,
    timeoutMs: number = 5000,
  ): Promise<TResponse | null> {
    const nc = await NatsClient.getConnection();
    const payload = data === null || data === undefined
      ? new Uint8Array(0)
      : new TextEncoder().encode(extJsonStringify(data));
    const hdrs = headers();
    injectInto(hdrs);
    const msg = await nc.request(subject, payload, { timeout: timeoutMs, headers: hdrs });
    const text = new TextDecoder().decode(msg.data);
    if (text === "") return null;
    return extJsonParse<TResponse>(text);
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
    const natsHeaders = headers();
    if (hdrs) {
      for (const [key, value] of Object.entries(hdrs)) {
        natsHeaders.set(key, value);
      }
    }
    injectInto(natsHeaders);
    nc.publish(subject, payload, { headers: natsHeaders });
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
        const parentCtx = extractNatsContext(msg.headers);
        const span = natsTracer.startSpan(
          `nats.consume ${subject}`,
          { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "nats", "messaging.destination.name": subject } },
          parentCtx,
        );
        await context.with(trace.setSpan(parentCtx, span), async () => {
          try {
            const text = new TextDecoder().decode(msg.data);
            if (text === "") {
              // Empty payload — skip parsing, call handler with null
              await handler(null as T, msg);
              return;
            }
            const data = extJsonParse<T>(text);
            await handler(data, msg);
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            console.error(`[NATS] Error processing message on "${subject}":`, error);
          } finally {
            span.end();
          }
        });
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
        const parentCtx = extractNatsContext(msg.headers);
        const span = natsTracer.startSpan(
          `nats.serve ${subject}`,
          { kind: SpanKind.SERVER, attributes: { "messaging.system": "nats", "messaging.destination.name": subject } },
          parentCtx,
        );
        await context.with(trace.setSpan(parentCtx, span), async () => {
          let requestId: string | undefined;
          try {
            const text = new TextDecoder().decode(msg.data);
            const request = extJsonParse<TRequest>(text);
            requestId = (request as { requestId?: string })?.requestId;
            const response = await handler(request, msg);
            if (msg.reply) {
              const replyHdrs = headers();
              injectInto(replyHdrs);
              const payload = new TextEncoder().encode(extJsonStringify(response));
              nc.publish(msg.reply, payload, { headers: replyHdrs });
            }
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
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
          } finally {
            span.end();
          }
        });
      }
    })();

    return sub;
  }
}

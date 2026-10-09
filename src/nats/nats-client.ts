import {
  connect,
  headers,
  AckPolicy,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  type Subscription,
  type Msg,
  type MsgHdrs,
} from "nats";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { logger } from "../lifecycle/logger.js";
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
  private static jsm: JetStreamManager | null = null;
  private static serverVersion: string | null = null;
  private static serverUrl: string | null = null;

  static async getConnection(url?: string): Promise<NatsConnection> {
    if (NatsClient.nc) return NatsClient.nc;
    const natsUrl = url ?? process.env.NATS_URL ?? "nats://127.0.0.1:4222";
    NatsClient.nc = await connect({ servers: natsUrl });
    NatsClient.js = NatsClient.nc.jetstream();
    NatsClient.jsm = await NatsClient.nc.jetstreamManager();
    NatsClient.serverUrl = natsUrl;
    // nc.info is populated by the INFO handshake at connect time.
    // ServerInfo.version is a string like "2.14.3".
    NatsClient.serverVersion = NatsClient.nc.info?.version ?? null;
    logger.done(`NATS ${NatsClient.serverVersion ?? "unknown"} connected (${natsUrl})`, { tags: ["core"] });
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
      NatsClient.jsm = null;
      NatsClient.serverVersion = null;
      NatsClient.serverUrl = null;
      logger.info("NATS connection closed", { tags: ["core"] });
    }
  }

  /**
   * @deprecated DEPRECATO — NON PASSIAMO DA NATS REQ/RES.
   * The legal communication model (decided 2026-10-09) is:
   * BE→US = HTTP proxy req/res, US→* = NATS pub/sub fire-and-forget or
   * choreographed event bus. Synchronous-looking needs use pub/sub
   * correlation replies (`x.call` → `x.response.<requestId>`).
   * Kept only until auth.apikey.byHash / service.registry.get / config.get
   * are migrated. Do NOT use in new code.
   *
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
   *       logger.info(`Received: ${request.requestId}`);
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
            logger.error(`Error processing message on "${subject}"`, { tags: ["nats"], error: error });
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
   *
   * @deprecated DEPRECATO — NON PASSIAMO DA NATS REQ/RES. See request().
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
            // Empty payloads are legal for parameterless request/reply
            // subjects (e.g. config.get) — treat them as `null`, not as a
            // parse error that never reaches the handler.
            const request = text === "" ? (null as TRequest) : extJsonParse<TRequest>(text);
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
            logger.error(`Error processing request on "${subject}"`, { tags: ["nats"], error: error });
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

  /**
   * Ensure a JetStream stream exists (idempotent). Creates it if missing;
   * returns silently if it already exists. Requires the server to run
   * with JetStream enabled (`nats -js`).
   *
   * @param name - Stream name (e.g. "WEBHOOK")
   * @param subjects - Subjects bound to the stream (e.g. ["webhook.>"])
   */
  static async ensureStream(name: string, subjects: string[]): Promise<void> {
    const nc = await NatsClient.getConnection();
    const jsm = NatsClient.jsm ?? (await nc.jetstreamManager());
    try {
      await jsm.streams.add({ name, subjects });
    } catch (error) {
      // 10058 = stream name already in use — treat as already-ensured.
      const apiErr = (error as { api_error?: { err_code?: number } })?.api_error;
      if (apiErr?.err_code === 10058) return;
      throw error;
    }
  }

  /**
   * Publish a message to JetStream and await the PubAck (durable write
   * confirmed server-side). Same Ext-JSON serialization and header
   * propagation as `publish()`.
   *
   * @returns The stream sequence number assigned by JetStream.
   */
  static async jetstreamPublish(
    subject: string,
    data: unknown,
    hdrs?: Record<string, string>,
  ): Promise<bigint> {
    const js = NatsClient.getJetStream();
    const payload = new TextEncoder().encode(extJsonStringify(data));
    const natsHeaders = headers();
    if (hdrs) {
      for (const [key, value] of Object.entries(hdrs)) {
        natsHeaders.set(key, value);
      }
    }
    injectInto(natsHeaders);
    const ack = await js.publish(subject, payload, { headers: natsHeaders });
    return BigInt(ack.seq);
  }

  /**
   * Subscribe to a JetStream stream via a durable pull consumer
   * (at-least-once). Creates the durable consumer if missing
   * (idempotent), then loops `fetch()`: auto-`ack()` after the handler
   * resolves, `nak(5000)` (redelivery) when it throws.
   *
   * @returns A handle whose `close()` stops the fetch loop.
   */
  static async jetstreamSubscribe<T = unknown>(opts: {
    stream: string;
    durable: string;
    filterSubject: string;
    handler: (
      data: T,
      msg: { headers?: MsgHdrs; info: { redeliveryCount: number } },
    ) => Promise<void>;
  }): Promise<{ close(): Promise<void> }> {
    const js = NatsClient.getJetStream();
    const jsm = NatsClient.jsm ?? (await (await NatsClient.getConnection()).jetstreamManager());
    try {
      await jsm.consumers.add(opts.stream, {
        durable_name: opts.durable,
        ack_policy: AckPolicy.Explicit,
        filter_subject: opts.filterSubject,
      });
    } catch (error) {
      // 10014/10148 = consumer name already in use — already ensured.
      const apiErr = (error as { api_error?: { err_code?: number } })?.api_error;
      if (apiErr?.err_code !== 10014 && apiErr?.err_code !== 10148) throw error;
    }

    let stopped = false;
    const process = async (m: JsMsg): Promise<void> => {
      const subject = m.subject;
      const parentCtx = extractNatsContext(m.headers);
      const span = natsTracer.startSpan(
        `nats.consume ${subject}`,
        { kind: SpanKind.CONSUMER, attributes: { "messaging.system": "nats", "messaging.destination.name": subject } },
        parentCtx,
      );
      await context.with(trace.setSpan(parentCtx, span), async () => {
        try {
          const text = new TextDecoder().decode(m.data);
          const data = text === "" ? (null as T) : extJsonParse<T>(text);
          await opts.handler(data, {
            headers: m.headers,
            info: { redeliveryCount: m.info.redeliveryCount },
          });
          m.ack();
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.error(`Error processing JetStream message on "${subject}"`, { tags: ["nats"], error: error });
          m.nak(5000);
        } finally {
          span.end();
        }
      });
    };

    (async () => {
      while (!stopped && NatsClient.isConnected()) {
        try {
          const batch = js.fetch(opts.stream, opts.durable, { batch: 10, expires: 5000 });
          for await (const m of batch) {
            if (stopped) {
              m.nak();
              continue;
            }
            await process(m);
          }
        } catch (error) {
          if (stopped) break;
          logger.error(`JetStream fetch failed on ${opts.stream}/${opts.durable}`, { tags: ["nats"], error: error });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();

    return {
      async close(): Promise<void> {
        stopped = true;
      },
    };
  }
}

import { connect, headers } from "@nats-io/transport-node";
import type { NatsConnection, Subscription, Msg, MsgHdrs } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, AckPolicy, JetStreamApiError } from "@nats-io/jetstream";
import type { JetStreamClient, JetStreamManager, JsMsg } from "@nats-io/jetstream";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { logger } from "../lifecycle/logger.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";
import { natsCarrier, extractNatsContext } from "../telemetry/otel.js";
import { internalIdentityHeaders } from "../http/internal-client.js";
import { msgHeader } from "./msg-headers.js";
import { lifecycleRegistry } from "../lifecycle/process-registry.js";
import type { AuthUser } from "../auth/types.js";

export { msgHeader };

const natsTracer = trace.getTracer("@primebrick/sdk");

/** Inject W3C traceparent/tracestate into a MsgHdrs instance. */
function injectInto(hdrs: MsgHdrs): void {
  propagation.inject(context.active(), hdrs, natsCarrier);
}

/**
 * Extract the JetStream API error code (`err_code`) from a thrown error.
 * nats.js v3 wraps API errors in `JetStreamApiError` (`apiError().err_code`);
 * the raw `{api_error: {err_code}}` shape is kept as a fallback for errors
 * surfaced without the wrapper.
 */
function apiErrCode(error: unknown): number | undefined {
  if (error instanceof JetStreamApiError) return error.apiError().err_code;
  return (error as { api_error?: { err_code?: number } })?.api_error?.err_code;
}

/**
 * Stamp the caller's service identity (User-Agent + client shield key)
 * onto outbound message headers — applied AFTER caller-supplied headers
 * so identity can never be overridden. Silent no-op until
 * `configureInternalClient()` runs at boot.
 *
 * Header names are written lowercase: MsgHdrs is case-sensitive (unlike
 * HTTP Headers), so the wire convention is lowercase — the same form the
 * SDK's `msgHeader` reader looks up first.
 */
function injectIdentity(hdrs: MsgHdrs): void {
  const identity = internalIdentityHeaders();
  if (!identity) return;
  for (const [name, value] of Object.entries(identity)) {
    hdrs.set(name.toLowerCase(), value);
  }
}

/**
 * Singleton NATS connection manager. Extracted from emailsender's
 * nats/client.ts:1-31.
 *
 * Requires `nats` as a peer dependency — consumers that don't need NATS
 * can skip installing it and won't import this module.
 * No DB dependency.
 *
 * The `publish()` and `subscribe()` methods use
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
  private static connecting: Promise<NatsConnection> | null = null;

  static async getConnection(url?: string): Promise<NatsConnection> {
    if (NatsClient.nc && !NatsClient.nc.isClosed()) return NatsClient.nc;
    if (NatsClient.connecting) return NatsClient.connecting;
    if (NatsClient.nc) {
      // Permanently closed (broker down past the client's reconnect
      // window) — nats.js cannot revive it. Drop the dead handles so a
      // fresh connection can be made. Every subscription bound to the old
      // conn is dead too: clear the hot-reload dedupe map so callers
      // re-subscribing the same subject don't unsubscribe() ghosts.
      NatsClient.nc = null;
      NatsClient.js = null;
      NatsClient.jsm = null;
      NatsClient.serverVersion = null;
      NatsClient.serverUrl = null;
      lifecycleRegistry().natsSubscriptions?.clear();
      logger.warn("NATS connection was closed — opening a fresh one", { tags: ["core"] });
    }
    // Closed-set env contract: no NATS_URL env read — callers pass the URL
    // explicitly from their config_entries (`createMicroservice` requires
    // `nats_url`); the default is the local dev broker.
    const natsUrl = url ?? "nats://127.0.0.1:4222";
    NatsClient.connecting = (async () => {
      try {
        const nc = await connect({ servers: natsUrl });
        NatsClient.nc = nc;
        NatsClient.js = jetstream(nc);
        NatsClient.jsm = await jetstreamManager(nc);
        NatsClient.serverUrl = natsUrl;
        // nc.info is populated by the INFO handshake at connect time.
        // ServerInfo.version is a string like "2.14.3".
        NatsClient.serverVersion = nc.info?.version ?? null;
        logger.done(`NATS ${NatsClient.serverVersion ?? "unknown"} connected (${natsUrl})`, { tags: ["core"] });
        return nc;
      } finally {
        NatsClient.connecting = null;
      }
    })();
    return NatsClient.connecting;
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
    injectIdentity(natsHeaders);
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
    opts?: { queue?: string },
  ): Promise<Subscription> {
    const nc = await NatsClient.getConnection();
    // Queue groups are for WORK items only (one replica processes each
    // message). Broadcasts every instance must receive — lifecycle events,
    // cache invalidation — stay unqueued.
    // Hot-reload dedupe: on `bun --hot`/`tsx watch` the connection survives
    // module reloads while new instances re-subscribe — replace the
    // previous subscription for the same subject+queue instead of
    // accumulating one delivery per reload.
    const subKey = `${subject}::${opts?.queue ?? ""}`;
    const prev = lifecycleRegistry().natsSubscriptions?.get(subKey);
    if (prev && typeof prev.unsubscribe === "function") prev.unsubscribe();
    const sub = nc.subscribe(subject, opts?.queue ? { queue: opts.queue } : undefined);
    (lifecycleRegistry().natsSubscriptions ??= new Map()).set(subKey, sub);

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
   * Ensure a JetStream stream exists (idempotent). Creates it if missing;
   * if it already exists and the requested options differ (e.g. the
   * `allow_msg_schedules` feature flag was added later), the stream config
   * is UPDATED in place — "ensure" means the declared state holds, not just
   * that the name exists. Requires the server to run with JetStream
   * enabled (`nats -js`).
   *
   * @param name - Stream name (e.g. "WEBHOOK")
   * @param subjects - Subjects bound to the stream (e.g. ["webhook.>"]). For
   *   scheduled-message streams BOTH the schedule subjects AND the fire
   *   targets must be covered (ADR-51).
   * @param opts.allowMsgSchedules - ADR-51: enables `Nats-Schedule*` header
   *   processing on this stream (requires JetStream API level ≥ 2, verified
   *   on nats-server 2.14.3).
   * @param opts.syncSubjects - reconcile the existing stream's `subjects`
   *   list to the provided one when they differ (default false — creating
   *   an existing stream is normally a no-op).
   */
  static async ensureStream(
    name: string,
    subjects: string[],
    opts?: { allowMsgSchedules?: boolean; syncSubjects?: boolean },
  ): Promise<void> {
    const nc = await NatsClient.getConnection();
    const jsm = NatsClient.jsm ?? (await jetstreamManager(nc));
    const config = {
      name,
      subjects,
      ...(opts?.allowMsgSchedules ? { allow_msg_schedules: true } : {}),
    };
    try {
      await jsm.streams.add(config);
      return;
    } catch (error) {
      // 10058 = stream name already in use — fall through to reconcile.
      if (apiErrCode(error) !== 10058) throw error;
    }
    const wantsSchedules = opts?.allowMsgSchedules === true;
    if (!wantsSchedules && !opts?.syncSubjects) return;
    const info = await jsm.streams.info(name);
    const cfg = info.config as unknown as Record<string, unknown>;
    let changed = false;
    if (wantsSchedules && !cfg.allow_msg_schedules) {
      cfg.allow_msg_schedules = true;
      changed = true;
    }
    if (
      opts?.syncSubjects &&
      extJsonStringify([...(cfg.subjects as string[] ?? [])].sort()) !==
        extJsonStringify([...subjects].sort())
    ) {
      cfg.subjects = subjects;
      changed = true;
    }
    if (changed) {
      await jsm.streams.update(name, cfg as unknown as typeof info.config);
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
    injectIdentity(natsHeaders);
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
   * Shield model — the `verify` callback runs BEFORE the handler, same
   * convention as NatsRouteVerify:
   *   - returns `AuthUser` → verified, handler receives `authUser`
   *   - returns `undefined` → verified, no user context (system lane)
   *   - returns `null` → denied: `term()` — auth failures are TERMINAL,
   *     redelivery would just re-deny (same policy as webhook-subscriber)
   *   - throws → transient: `nak()` redelivery applies
   *
   * `consumer` tunes the durable: `ackWaitMs` is the redelivery delay (size
   * it above the handler's worst case), `maxAckPending` caps in-flight
   * messages (concurrency), `maxDeliver` bounds retries.
   *
   * @returns A handle whose `close()` stops the fetch loop.
   */
  static async jetstreamSubscribe<T = unknown>(opts: {
    stream: string;
    durable: string;
    filterSubject: string;
    consumer?: {
      batch?: number;
      fetchExpiresMs?: number;
      ackWaitMs?: number;
      maxDeliver?: number;
      maxAckPending?: number;
    };
    verify?: (msg: {
      subject?: string;
      headers?: MsgHdrs;
    }) => Promise<AuthUser | null | undefined>;
    handler: (
      data: T,
      msg: {
        subject: string;
        headers?: MsgHdrs;
        info: { redeliveryCount: number };
        authUser?: AuthUser;
      },
    ) => Promise<void>;
  }): Promise<{ close(): Promise<void> }> {
    const js = NatsClient.getJetStream();
    const jsm = NatsClient.jsm ?? (await jetstreamManager(await NatsClient.getConnection()));
    // Consumers may start before the ingress service has created the stream —
    // retry on "stream not found" (10059) the same way the registrar retries
    // service.register until the BE is up. Other errors are fatal.
    for (let attempt = 1; ; attempt++) {
      try {
        await jsm.consumers.add(opts.stream, {
          durable_name: opts.durable,
          ack_policy: AckPolicy.Explicit,
          filter_subject: opts.filterSubject,
          ...(opts.consumer?.ackWaitMs !== undefined
            ? { ack_wait: opts.consumer.ackWaitMs * 1e6 }
            : {}),
          ...(opts.consumer?.maxDeliver !== undefined
            ? { max_deliver: opts.consumer.maxDeliver }
            : {}),
          ...(opts.consumer?.maxAckPending !== undefined
            ? { max_ack_pending: opts.consumer.maxAckPending }
            : {}),
        });
        break;
      } catch (error) {
        const errCode = apiErrCode(error);
        // 10014/10148 = consumer name already in use — already ensured.
        if (errCode === 10014 || errCode === 10148) break;
        if (errCode === 10059) {
          logger.warn(`JetStream stream "${opts.stream}" not found — retrying in 5s`, { tags: ["nats"], attempt });
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw error;
      }
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
          let authUser: AuthUser | undefined;
          if (opts.verify) {
            const result = await opts.verify(m);
            if (result === null) {
              // Terminal denial — term() prevents pointless redelivery.
              m.term();
              return;
            }
            authUser = result;
          }
          const text = new TextDecoder().decode(m.data);
          const data = text === "" ? (null as T) : extJsonParse<T>(text);
          await opts.handler(data, {
            subject,
            headers: m.headers,
            info: { redeliveryCount: m.info.deliveryCount },
            authUser,
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

    const pullConsumer = await js.consumers.get(opts.stream, opts.durable);
    (async () => {
      while (!stopped && NatsClient.isConnected()) {
        try {
          const batch = await pullConsumer.fetch({ max_messages: 10, expires: 5000 });
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

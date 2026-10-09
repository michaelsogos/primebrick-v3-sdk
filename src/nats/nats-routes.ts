/**
 * makeNatsRoutes / makeNatsRequestRoute — the ONLY legal way to expose NATS
 * endpoints. Mirrors makeRpcRouter for the message transport: auth
 * (GATEWAY-RESOLVED via verifyNatsMessage), RBAC (enforceNatsRbac), payload
 * validation, and optional Redis cache are MANDATORY middleware — no free
 * NATS endpoints, same as no free HTTP endpoints.
 *
 * Route kinds:
 *   - `makeNatsRoutes`      → fire-and-forget subscribers (the default)
 *   - `makeNatsRequestRoute` → governed correlation-reply endpoint: the caller
 *     publishes on the subject with a private _INBOX reply subject, the
 *     responder publishes the result there. Pure pub/sub primitives — this
 *     REPLACES the banned NatsClient.request()/subscribeRequest() while
 *     keeping auth+RBAC enforced. Caller side: `callNats()`.
 *
 * Queue groups: every subscription joins a queue named after the service
 * code by default → identical replicas get ONE copy round-robin; a service
 * that wants every message (e.g. cache invalidation listeners) passes
 * `queue: null` explicitly — visible and auditable in the declaration.
 */

import { createInbox, headers as natsHeaders, type Msg, type NatsConnection, type Subscription } from "nats";
import { NatsClient } from "./nats-client.js";
import { extJsonParse, extJsonStringify } from "../json/ext-json.js";
import { verifyNatsMessage } from "../auth/verify-nats.js";
import { enforceNatsRbac, RbacDeniedError } from "../auth/rbac-enforce.js";
import { AuthError } from "../auth/verify.js";
import { getAuthConfig } from "../auth/auth-config-cache.js";
import type { AuthUser } from "../auth/types.js";
import { logger } from "../lifecycle/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NatsRouteContext<TReq = unknown> {
  /** Resolved caller (GATEWAY-RESOLVED headers). */
  user: AuthUser;
  /** Validated request payload. */
  request: TReq;
  /** Raw NATS message — headers, subject, reply. */
  msg: Msg;
}

export interface NatsRoute<TReq = unknown> {
  /** NATS subject, e.g. "emailsender.send". */
  subject: string;
  /**
   * Queue group. Default: the service code (one copy round-robin across
   * replicas). Pass `null` ONLY for broadcast listeners that must see every
   * message — that intent stays visible in the declaration.
   */
  queue?: string | null;
  /** RBAC permissions — MANDATORY. */
  permissions: readonly string[];
  rbacMode?: "any" | "all";
  /** Payload validator — throws on invalid shape (zod .parse or manual). */
  validate?: (raw: unknown) => TReq;
  /** The ONE service call. */
  handler: (ctx: NatsRouteContext<TReq>) => Promise<void>;
}

export interface NatsRequestRoute<TReq = unknown, TRes = unknown> {
  subject: string;
  queue?: string | null;
  permissions: readonly string[];
  rbacMode?: "any" | "all";
  validate?: (raw: unknown) => TReq;
  /** Returns the reply payload — published to msg.reply. */
  handler: (ctx: NatsRouteContext<TReq>) => Promise<TRes>;
}

export interface NatsRouterDeps {
  /** Queue-group default — the registered service code. */
  serviceCode: string;
  /** Injectable for tests — defaults to NatsClient.getConnection(). */
  connection?: NatsConnection;
}

interface NatsReplyError {
  error: { code: string; message: string };
}

function isReplyError(x: unknown): x is NatsReplyError {
  return !!x && typeof x === "object" && "error" in x;
}

function encode(data: unknown): Uint8Array {
  return new TextEncoder().encode(extJsonStringify(data));
}

function decode<T>(data: Uint8Array): T {
  return extJsonParse(new TextDecoder().decode(data)) as T;
}

async function verifyAndAuthorize(
  msg: Msg,
  permissions: readonly string[],
  rbacMode: "any" | "all" | undefined,
): Promise<AuthUser> {
  const user = await verifyNatsMessage(msg, getAuthConfig());
  enforceNatsRbac(user, permissions, rbacMode);
  return user;
}

// ─── Fire-and-forget subscribers ────────────────────────────────────────────

/**
 * Register governed pub/sub subscribers. Errors are logged, never thrown
 * into the message loop — fire-and-forget has no caller to answer to.
 */
export async function makeNatsRoutes(
  routes: NatsRoute[],
  deps: NatsRouterDeps,
): Promise<Subscription[]> {
  const nc = deps.connection ?? (await NatsClient.getConnection());
  const subs: Subscription[] = [];

  for (const route of routes) {
    const queue = route.queue === null ? undefined : (route.queue ?? deps.serviceCode);
    const sub = nc.subscribe(route.subject, queue ? { queue } : undefined);
    subs.push(sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const user = await verifyAndAuthorize(msg, route.permissions, route.rbacMode);
          const raw = decode(msg.data);
          const request = route.validate ? route.validate(raw) : raw;
          await route.handler({ user, request, msg });
        } catch (err) {
          if (err instanceof AuthError || err instanceof RbacDeniedError) {
            logger.warn(`${route.subject} denied: ${err.message}`, { tags: ["nats-routes"] });
          } else {
            logger.error(`${route.subject} handler error`, { tags: ["nats-routes"], error: err });
          }
        }
      }
    })();
  }
  return subs;
}

// ─── Correlation-reply endpoints (replaces NATS req/res) ────────────────────

/**
 * Register a governed request/reply-style endpoint over pure pub/sub:
 * the caller publishes with `reply: <private inbox>`; the response is
 * published back there. Auth + RBAC enforced exactly like makeNatsRoutes;
 * denials/failures reply with `{ error: { code, message } }`.
 */
export async function makeNatsRequestRoute<TReq = unknown, TRes = unknown>(
  routes: NatsRequestRoute<TReq, TRes>[],
  deps: NatsRouterDeps,
): Promise<Subscription[]> {
  const nc = deps.connection ?? (await NatsClient.getConnection());
  const subs: Subscription[] = [];

  for (const route of routes) {
    const queue = route.queue === null ? undefined : (route.queue ?? deps.serviceCode);
    const sub = nc.subscribe(route.subject, queue ? { queue } : undefined);
    subs.push(sub);

    (async () => {
      for await (const msg of sub) {
        const replyError = (code: string, message: string) => {
          if (msg.reply) msg.respond(encode({ error: { code, message } }));
        };
        try {
          const user = await verifyAndAuthorize(msg, route.permissions, route.rbacMode);
          const raw = decode<TReq>(msg.data);
          const request = route.validate ? route.validate(raw) : raw;
          const result = await route.handler({ user, request, msg });
          if (msg.reply) msg.respond(encode(result ?? null));
        } catch (err) {
          if (err instanceof AuthError) {
            replyError(err.internal_code, err.message);
          } else if (err instanceof RbacDeniedError) {
            replyError("RBAC_PERMISSION_DENIED", err.message);
          } else {
            logger.error(`${route.subject} request handler error`, { tags: ["nats-routes"], error: err });
            replyError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
          }
        }
      }
    })();
  }
  return subs;
}

/**
 * Caller side of the correlation-reply pattern — the governed replacement
 * for `NatsClient.request()`. Publishes on `subject` with a private reply
 * inbox and resolves with the responder's payload (or rejects on
 * `{error}`/timeout). Auth headers are the caller's responsibility (BE
 * uses `buildNatsAuthHeaders` to forward the resolved user).
 */
export async function callNats<TRes = unknown>(
  subject: string,
  data: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string>; connection?: NatsConnection } = {},
): Promise<TRes> {
  const nc = opts.connection ?? (await NatsClient.getConnection());
  const inbox = createInbox();
  const timeoutMs = opts.timeoutMs ?? 5000;

  return new Promise<TRes>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error(`callNats timeout after ${timeoutMs}ms on ${subject}`));
    }, timeoutMs);

    const sub = nc.subscribe(inbox, { max: 1 });
    (async () => {
      for await (const msg of sub) {
        clearTimeout(timer);
        try {
          const decoded = decode<unknown>(msg.data);
          if (isReplyError(decoded)) {
            reject(new Error(`${decoded.error.code}: ${decoded.error.message}`));
          } else {
            resolve(decoded as TRes);
          }
        } catch (e) {
          reject(e);
        }
      }
    })();

    let hdrs;
    if (opts.headers) {
      hdrs = natsHeaders();
      for (const [k, v] of Object.entries(opts.headers)) hdrs.set(k, v);
    }
    nc.publish(subject, encode(data), { reply: inbox, headers: hdrs });
  });
}
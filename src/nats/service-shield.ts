/**
 * Client-shield verification for inbound NATS messages — layer 1 of the
 * two-layer inbound model: FIRST the client identity is authorized
 * (User-Agent prefix + shield key vs the client registry allowlist),
 * THEN the user layer runs (gateway secret + AuthUser + RBAC) where a
 * user context exists.
 *
 * The registry holder is set once at boot:
 *   - `createMicroservice` calls `setNatsShieldRegistry(clientRegistry)`
 *     right after `clientRegistry.start()` (before any NATS subscription);
 *   - the BE wires its own equivalent (createPublisherVerifier).
 *
 * When no registry is configured the check is skipped — that only happens
 * in unit tests and non-microservice contexts; every real service boots
 * through createMicroservice which always sets it. A missing registry must
 * never silently open the perimeter in production code paths, so
 * `verifyNatsPublisher` logs a warning the first time it is skipped.
 */

import type { Msg, MsgHdrs } from "nats";
import { NatsClient } from "./nats-client.js";
import { msgHeader } from "./msg-headers.js";
import { verifyClientIdentity, CLIENT_SHIELD_KEY_HEADER } from "../service/service-identity.js";
import { logger } from "../lifecycle/logger.js";

/** Structural view of the client registry needed for shield checks. */
export interface ShieldRegistryLike {
  readonly allowedPrefixes: readonly string[];
  verifyKey(uaPrefix: string, presentedKey: string): boolean;
  /** Optional warm-up — called before each verify so cold caches load. */
  refresh?(): Promise<unknown>;
}

let registry: ShieldRegistryLike | null = null;
let warnedOnce = false;

export function setNatsShieldRegistry(r: ShieldRegistryLike | null): void {
  registry = r;
  warnedOnce = false;
}

export function getNatsShieldRegistry(): ShieldRegistryLike | null {
  return registry;
}

/**
 * Verify the publisher's client-shield identity. Returns true when the
 * caller is a registered client (or the registry is not configured — test
 * contexts only). Denials are logged with the presented UA.
 */
export async function verifyNatsPublisher(msg: { subject?: string; headers?: MsgHdrs }): Promise<boolean> {
  if (!registry) {
    if (!warnedOnce) {
      warnedOnce = true;
      logger.warn("NATS shield verify skipped — no client registry configured", { tags: ["nats-shield"] });
    }
    return true;
  }
  // Cold-cache warm-up only — steady-state refreshes ride the shielded
  // `client_registry.changed` broadcast; an empty snapshot fails closed.
  if (registry.allowedPrefixes.length === 0) {
    try {
      await registry.refresh?.();
    } catch {
      // fall through — empty snapshot rejects below
    }
  }
  const getHdr = (name: string): string | null => msgHeader(msg.headers, name);
  const result = await verifyClientIdentity(
    { headers: { get: getHdr } },
    {
      allowedPrefixes: [...registry.allowedPrefixes],
      verifyKey: (prefix, key) => registry!.verifyKey(prefix, key),
    },
  );
  if (!result.ok) {
    logger.error(`NATS publisher rejected on "${msg.subject ?? "?"}" — ${result.error}`, {
      tags: ["nats-shield", `${result.status}`],
      presented_ua: getHdr("user-agent") || null,
      shield_key_present: Boolean(getHdr(CLIENT_SHIELD_KEY_HEADER)),
    });
  }
  return result.ok;
}

/**
 * NatsRouteVerify adapter — use as `verify` on service-identity routes
 * (no AuthUser): `verify: serviceShieldVerify`.
 */
export const serviceShieldVerify = async (msg: Msg) =>
  (await verifyNatsPublisher(msg)) ? undefined : null;

/**
 * Shield-gated fire-and-forget subscription for broadcast subjects
 * (config.changed, service.gateway_online, lifecycle events): the handler
 * runs only after the publisher's client identity is verified. Use this —
 * never raw NatsClient.subscribe — for subjects published by other services.
 */
export async function subscribeShielded<T = unknown>(
  subject: string,
  handler: (payload: T, msg: Msg) => Promise<unknown>,
  opts?: { queue?: string },
): Promise<void> {
  await NatsClient.subscribe<T>(
    subject,
    async (payload, msg) => {
      if (!(await verifyNatsPublisher(msg))) return;
      await handler(payload, msg);
    },
    opts,
  );
}

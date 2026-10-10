/**
 * Rotating Secret Engine — self-sufficient rotation+provisioning for
 * internally-issued shared secrets (gateway_secret first; scoped keys such
 * as service_client_shield_key later).
 *
 * Model:
 *
 *   Redis   primebrick:secrets:{scope}:{name}
 *           = hash { current, previous, rotated_at }, TTL = rotation + grace
 *           The key IS the lifecycle: expired/missing ⇒ regenerate on demand
 *           (self-healing after Redis flush or restart).
 *
 *   Owner   RotatingSecretEngine (runs on the BE — the auth root-of-trust).
 *           Single writer via a short-lived lock key; regenerates every
 *           `rotationMs`, publishes the shielded broadcast `secret.rotated`.
 *
 *   Client  SecretProvider (every consumer, incl. the BE's own outbound
 *           paths). Caches the slot in memory, refetches via the governed
 *           correlation route `secret.get` on boot and on each rotation.
 *
 * Scopes: `{ scope: "global" }` for fleet-wide secrets; `{ scope: "<service-code>" }`
 * for per-service secrets — designed now so client-shield-key rotation (B14)
 * plugs in without refactoring.
 */

import { randomBytes } from "node:crypto";
import type { RedisClientType } from "redis";
import { NatsClient } from "../nats/nats-client.js";
import { callNats } from "../nats/nats-routes.js";
import { subscribeShielded } from "../nats/service-shield.js";
import { setGatewaySecretSlot, SECRET_DEFAULTS, type GatewaySecretSlot } from "../auth/gateway-secret.js";
import { logger } from "../lifecycle/logger.js";

export const SECRET_SUBJECTS = {
  GET: "secret.get",
  ROTATED: "secret.rotated",
} as const;

const KEY_PREFIX = "primebrick:secrets";
const LOCK_TTL_MS = 10_000;
export { SECRET_DEFAULTS } from "../auth/gateway-secret.js";

export interface RotatingSecretRef {
  /** "global" or a service code — scopes the key namespace. */
  scope: string;
  name: string;
}

export interface SecretGetRequest extends RotatingSecretRef {}
export interface SecretGetResponse extends GatewaySecretSlot {}

const redisKey = (ref: RotatingSecretRef) => `${KEY_PREFIX}:${ref.scope}:${ref.name}`;
const lockKey = (ref: RotatingSecretRef) => `${redisKey(ref)}:lock`;

const newSecret = () => randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------
// Owner side (BE)
// ---------------------------------------------------------------------------

export class RotatingSecretEngine {
  constructor(
    private readonly redis: RedisClientType,
    private readonly opts: { rotationMs?: number; graceMs?: number } = {},
  ) {}

  private get rotationMs() { return this.opts.rotationMs ?? SECRET_DEFAULTS.rotationMs; }
  private get graceMs() { return this.opts.graceMs ?? SECRET_DEFAULTS.graceMs; }

  /** Read the slot; generate on cold start (TTL-expired or first boot). */
  async get(ref: RotatingSecretRef): Promise<GatewaySecretSlot> {
    const h = await this.redis.hGetAll(redisKey(ref));
    const slot = h.current
      ? { current: h.current, previous: h.previous || null, rotated_at: Number(h.rotated_at) || 0 }
      : await this.rotate(ref);
    if (ref.scope === "global" && ref.name === "gateway_secret") setGatewaySecretSlot(slot);
    return slot;
  }

  /**
   * Rotate `ref`: previous := current, current := fresh random. Serialized by a
   * NX lock so concurrent owners (BE replicas, get-vs-timer races) rotate once.
   */
  async rotate(ref: RotatingSecretRef): Promise<GatewaySecretSlot> {
    const locked = await this.redis.set(lockKey(ref), "1", { NX: true, PX: LOCK_TTL_MS });
    if (!locked) {
      // Someone else is rotating — wait a beat and read what they wrote.
      await new Promise((r) => setTimeout(r, 300));
      const h = await this.redis.hGetAll(redisKey(ref));
      if (h.current) {
        return { current: h.current, previous: h.previous || null, rotated_at: Number(h.rotated_at) || 0 };
      }
      return this.rotate(ref); // they failed before writing — take over
    }
    try {
      // Double-check under the lock: another instance may have just rotated.
      const h = await this.redis.hGetAll(redisKey(ref));
      const rotatedAt = Number(h.rotated_at) || 0;
      if (h.current && Date.now() - rotatedAt < this.rotationMs) {
        return { current: h.current, previous: h.previous || null, rotated_at: rotatedAt };
      }
      const slot: GatewaySecretSlot = {
        current: newSecret(),
        previous: h.current || null,
        rotated_at: Date.now(),
      };
      const key = redisKey(ref);
      await this.redis.hSet(key, {
        current: slot.current,
        previous: slot.previous ?? "",
        rotated_at: String(slot.rotated_at),
      });
      // TTL = rotation + grace: the key IS the lifecycle — its expiry forces
      // regeneration, so no scheduler is required for self-healing.
      await this.redis.pExpire(key, this.rotationMs + this.graceMs);
      await NatsClient.publish(SECRET_SUBJECTS.ROTATED, { ...ref, rotated_at: slot.rotated_at });
      if (ref.scope === "global" && ref.name === "gateway_secret") setGatewaySecretSlot(slot);
      logger.info(`rotated secret ${ref.scope}/${ref.name}`, {
        tags: ["secrets"],
        rotated_at: new Date(slot.rotated_at).toISOString(),
        next_rotation_in_ms: this.rotationMs,
      });
      return slot;
    } finally {
      await this.redis.del(lockKey(ref)).catch(() => {});
    }
  }

  /** Interval driver — ensure existence now, then rotate every rotationMs. */
  startAutoRotation(ref: RotatingSecretRef): void {
    void this.get(ref).catch((e) =>
      logger.error(`secret engine init failed for ${ref.scope}/${ref.name}`, { tags: ["secrets"], error: e }),
    );
    const t = setInterval(() => {
      void this.rotate(ref).catch((e) =>
        logger.error(`scheduled rotation failed for ${ref.scope}/${ref.name}`, { tags: ["secrets"], error: e }),
      );
    }, this.rotationMs);
    t.unref();
  }
}

// ---------------------------------------------------------------------------
// Consumer side (every service, incl. BE for its own outbound headers)
// ---------------------------------------------------------------------------

export class SecretProvider {
  private readonly cache = new Map<string, GatewaySecretSlot>();
  private readonly refKey = (r: RotatingSecretRef) => `${r.scope}/${r.name}`;

  async get(ref: RotatingSecretRef): Promise<GatewaySecretSlot> {
    const k = this.refKey(ref);
    const cached = this.cache.get(k);
    if (cached) return cached;
    const raw = await callNats<SecretGetResponse>(SECRET_SUBJECTS.GET, ref, { timeoutMs: 5_000 });
    // ext-json transports integers as BigInt — coerce before caching/logging.
    const slot: GatewaySecretSlot = {
      current: raw.current,
      previous: raw.previous ?? null,
      rotated_at: Number(raw.rotated_at),
    };
    this.cache.set(k, slot);
    this.applyGatewaySlot(ref, slot);
    logger.info(`provisioned secret ${k} (rotated_at ${new Date(slot.rotated_at).toISOString()})`, { tags: ["secrets"] });
    return slot;
  }

  invalidate(scope: string, name: string): void {
    this.cache.delete(`${scope}/${name}`);
  }

  private applyGatewaySlot(ref: RotatingSecretRef, slot: GatewaySecretSlot): void {
    if (ref.scope === "global" && ref.name === "gateway_secret") setGatewaySecretSlot(slot);
  }
}

/**
 * Wire the consumer: subscribe to `secret.rotated` (shielded broadcast),
 * refetch and re-cache. Call once per service after NATS + shield registry
 * are up, then `provider.get(ref)` for each consumed secret.
 */
export async function startSecretProvider(provider: SecretProvider): Promise<void> {
  await subscribeShielded(SECRET_SUBJECTS.ROTATED, async (payload) => {
    const { scope, name } = payload as RotatingSecretRef;
    provider.invalidate(scope, name);
    const slot = await provider.get({ scope, name });
    logger.info(`updated secret ${scope}/${name} after rotation`, {
      tags: ["secrets"],
      rotated_at: new Date(slot.rotated_at).toISOString(),
    });
  });
}

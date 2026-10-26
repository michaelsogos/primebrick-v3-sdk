/**
 * Client registry — the consumer-side allowlist cache for service-identity
 * verification.
 *
 * Source of truth: `system.client_shield_registry` (BE-owned). Distribution:
 *   - snapshot at boot via `system.clientShieldRegistry.get` (governed correlation-reply, BE responder)
 *   - live invalidation via `system.client_shield_registry.changed` pub/sub —
 *     every mutation (register, admin CRUD, enable/disable, rotation) re-fetches
 *     the snapshot, so there is exactly one read pattern.
 *
 * Fail-closed: if the snapshot cannot be loaded, `allowedPrefixes` is empty
 * and every internal call is rejected — a US must never accept callers it
 * cannot identify.
 */

import { NatsClient } from "../nats/nats-client.js";
import { callNats } from "../nats/nats-routes.js";
import { subscribeShielded } from "../nats/service-shield.js";
import { logger } from "../lifecycle/logger.js";
import { verifyRowKey, type ClientKeyMaterial } from "./service-identity.js";

export const CLIENT_SHIELD_REGISTRY_SUBJECTS = {
  /** nats-req subject answered by the BE: full enabled-row snapshot. */
  GET: "system.clientShieldRegistry.get",
  /** pub/sub subject published by the BE on every registry mutation. */
  CHANGED: "system.client_shield_registry.changed",
} as const;

export interface ClientShieldRegistryRow {
  ua_prefix: string;
  client_key_hash: string;
  is_enabled: boolean;
  /**
   * Key-rotation state (B14). `key_generation` is the BE-issued generation a
   * derived-mode service must use to re-derive its key; `previous_*` carries
   * the old hash during the grace window.
   */
  key_generation?: number;
  previous_key_hash?: string | null;
  /** ISO string on the wire; Date when the BE passes rows in-process. */
  previous_valid_until?: string | Date | null;
}

interface CachedRow extends ClientKeyMaterial {
  key_generation: number;
}

export class ClientShieldRegistry {
  private rows = new Map<string, CachedRow>();
  private listeners: (() => void)[] = [];

  /**
   * Subscribe to invalidation events first, then keep retrying the snapshot
   * until the BE answers — the BE may be down at boot (same stateless-retry
   * model as service.register). Non-blocking: until the first snapshot lands
   * the allowlist is empty and every internal call is rejected (fail-closed).
   */
  async start(): Promise<void> {
    await subscribeShielded(CLIENT_SHIELD_REGISTRY_SUBJECTS.CHANGED, () => this.refresh());
    void this.reloadUntilOk();
  }

  /**
   * Forced snapshot reload — drives the `.changed` broadcast handler and the
   * NATS shield's stale-snapshot recovery (`ShieldRegistryLike.refresh`: on a
   * 403 denial the shield force-refreshes and retries once, so a client
   * enrolled after the last refresh — e.g. a new-version service or the BE
   * itself after a version bump — is learnable immediately instead of being
   * dropped until the next verifiable broadcast).
   */
  async refresh(): Promise<void> {
    try {
      const changed = await this.reload();
      if (changed) {
        this.logAllowed("have been updated");
        this.notifyListeners();
      }
    } catch (error) {
      logger.warn("client_shield_registry reload failed — keeping previous snapshot", {
        tags: ["core"],
        error,
      });
    }
  }

  /**
   * Register a callback fired after a reload that actually changed row
   * material — the service registrar hooks this to re-register when its own
   * `key_generation` was bumped by a BE rotation.
   */
  addChangeListener(cb: () => void): void {
    this.listeners.push(cb);
  }

  private notifyListeners(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (error) {
        logger.warn("client_shield_registry change listener failed", { tags: ["core"], error });
      }
    }
  }

  private async reloadUntilOk(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.reload();
        this.logAllowed("are", attempt > 1 ? attempt : undefined);
        return;
      } catch (error) {
        logger.warn(`client_shield_registry snapshot attempt ${attempt} failed — retrying in 5s`, { tags: ["core"], attempt, error });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private logAllowed(verb: "are" | "have been updated", attempts?: number): void {
    logger.info(`Services allowed to communicate with ${verb}:`, {
      tags: ["core"],
      ...(attempts ? { attempts } : {}),
    });
    for (const prefix of this.rows.keys()) {
      logger.info(`  - ${prefix}`, { tags: ["core"] });
    }
  }

  /**
   * Re-fetch the snapshot. Returns true when the row material actually
   * changed — hash, previous-hash, or generation (a generation bump with an
   * unchanged hash is still a material change: the owning service must
   * re-register with its newly derived key).
   */
  private async reload(): Promise<boolean> {
    const rows = await callNats<ClientShieldRegistryRow[]>(
      CLIENT_SHIELD_REGISTRY_SUBJECTS.GET,
      null,
      { timeoutMs: 5000 },
    );
    const next = new Map<string, CachedRow>();
    for (const row of rows ?? []) {
      if (row.is_enabled) {
        next.set(row.ua_prefix, {
          client_key_hash: row.client_key_hash,
          previous_key_hash: row.previous_key_hash ?? null,
          previous_valid_until: row.previous_valid_until ?? null,
          key_generation: row.key_generation ?? 0,
        });
      }
    }
    const changed =
      next.size !== this.rows.size ||
      [...next].some(([k, v]) => {
        const prev = this.rows.get(k);
        return (
          !prev ||
          prev.client_key_hash !== v.client_key_hash ||
          prev.previous_key_hash !== v.previous_key_hash ||
          prev.previous_valid_until !== v.previous_valid_until ||
          prev.key_generation !== v.key_generation
        );
      });
    this.rows = next;
    return changed;
  }

  /** UA prefixes currently allowed (enabled rows only). */
  get allowedPrefixes(): readonly string[] {
    return [...this.rows.keys()];
  }

  /**
   * The generation the BE issued for `uaPrefix` — a derived-mode service
   * re-derives its key as `HMAC(secret, prefix:generation)`. Returns 0 for
   * unknown/static rows (matches the DB default).
   */
  generationFor(uaPrefix: string): number {
    return this.rows.get(uaPrefix)?.key_generation ?? 0;
  }

  /** Current-hash or grace-windowed previous-hash comparison for the matched prefix. */
  verifyKey(uaPrefix: string, presentedKey: string): boolean {
    return verifyRowKey(this.rows.get(uaPrefix), presentedKey);
  }
}

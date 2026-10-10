/**
 * Client registry — the consumer-side allowlist cache for service-identity
 * verification.
 *
 * Source of truth: `system.client_registry` (BE-owned). Distribution:
 *   - snapshot at boot via `system.clientRegistry.get` (nats-req, BE responder)
 *   - live invalidation via `system.client_registry.changed` pub/sub —
 *     every mutation (register, admin CRUD, enable/disable) re-fetches
 *     the snapshot, so there is exactly one read pattern.
 *
 * Fail-closed: if the snapshot cannot be loaded, `allowedPrefixes` is empty
 * and every internal call is rejected — a US must never accept callers it
 * cannot identify.
 */

import { NatsClient } from "../nats/nats-client.js";
import { logger } from "../lifecycle/logger.js";
import { clientKeyHash } from "./service-identity.js";

export const CLIENT_REGISTRY_SUBJECTS = {
  /** nats-req subject answered by the BE: full enabled-row snapshot. */
  GET: "system.clientRegistry.get",
  /** pub/sub subject published by the BE on every registry mutation. */
  CHANGED: "system.client_registry.changed",
} as const;

export interface ClientRegistryRow {
  ua_prefix: string;
  client_key_hash: string;
  is_enabled: boolean;
}

export class ClientRegistry {
  private rows = new Map<string, string>();

  /**
   * Subscribe to invalidation events first, then keep retrying the snapshot
   * until the BE answers — the BE may be down at boot (same stateless-retry
   * model as service.register). Non-blocking: until the first snapshot lands
   * the allowlist is empty and every internal call is rejected (fail-closed).
   */
  async start(): Promise<void> {
    await NatsClient.subscribe(CLIENT_REGISTRY_SUBJECTS.CHANGED, async () => {
      try {
        const changed = await this.reload();
        if (changed) this.logAllowed("have been updated");
      } catch (error) {
        logger.warn("client_registry reload failed — keeping previous snapshot", {
          tags: ["core"],
          error,
        });
      }
    });
    void this.reloadUntilOk();
  }

  private async reloadUntilOk(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.reload();
        this.logAllowed("are", attempt > 1 ? attempt : undefined);
        return;
      } catch {
        logger.warn(`client_registry snapshot attempt ${attempt} failed (BE unreachable?) — retrying in 5s`, { tags: ["core"], attempt });
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
   * Re-fetch the snapshot. Returns true when the enabled-prefix set
   * actually changed — callers use it to log only on real diffs (the BE
   * publishes `changed` on every enrollment, including re-registers that
   * leave the set identical).
   */
  private async reload(): Promise<boolean> {
    const rows = await NatsClient.request<ClientRegistryRow[]>(
      CLIENT_REGISTRY_SUBJECTS.GET,
      null,
      5000,
    );
    const next = new Map<string, string>();
    for (const row of rows ?? []) {
      if (row.is_enabled) next.set(row.ua_prefix, row.client_key_hash);
    }
    const changed =
      next.size !== this.rows.size ||
      [...next].some(([k, v]) => this.rows.get(k) !== v);
    this.rows = next;
    return changed;
  }

  /** UA prefixes currently allowed (enabled rows only). */
  get allowedPrefixes(): readonly string[] {
    return [...this.rows.keys()];
  }

  /** Constant-time-ish hash comparison for the matched UA prefix. */
  verifyKey(uaPrefix: string, presentedKey: string): boolean {
    const expected = this.rows.get(uaPrefix);
    return expected !== undefined && expected === clientKeyHash(presentedKey);
  }
}

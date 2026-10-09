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
   * Load the snapshot and subscribe to invalidation events.
   * Safe to call once at service start (after NATS connect).
   */
  async start(): Promise<void> {
    await this.reload();
    await NatsClient.subscribe(CLIENT_REGISTRY_SUBJECTS.CHANGED, async () => {
      try {
        await this.reload();
      } catch (error) {
        logger.warn("client_registry reload failed — keeping previous snapshot", {
          tags: ["core"],
          error,
        });
      }
    });
    logger.info(`Client registry loaded (${this.rows.size} allowed clients)`, { tags: ["core"] });
  }

  private async reload(): Promise<void> {
    const rows = await NatsClient.request<ClientRegistryRow[]>(
      CLIENT_REGISTRY_SUBJECTS.GET,
      null,
      5000,
    );
    this.rows.clear();
    for (const row of rows ?? []) {
      if (row.is_enabled) this.rows.set(row.ua_prefix, row.client_key_hash);
    }
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

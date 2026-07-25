/**
 * Shared config protocol — NATS `config.get` request/reply.
 *
 * Allows microservices to discover configuration that is centralized in the BE's
 * `auth_configurations` table (e.g. `redis_url`) without duplicating it in their
 * own config tables.
 *
 * The BE subscribes to `config.get` and responds with a `SharedConfig` object.
 * Microservices call `fetchSharedConfig(nats)` (or indirectly via
 * `initCacheFromSharedConfig`) to get the shared config.
 *
 * The `SharedConfig` interface is extensible — future fields (e.g. `s3_url`,
 * `feature_flags`) can be added without breaking consumers. All fields are
 * optional: the BE only includes what it has configured.
 */

import { NatsClient } from "../nats/nats-client.js";

/**
 * Shape of the shared config object exchanged via NATS `config.get`.
 * Extensible — future fields can be added without breaking consumers.
 * All fields are optional: the BE only includes what it has configured.
 */
export interface SharedConfig {
  /** Redis cache URL, e.g. `redis://localhost:6379`. Empty/undefined = cache disabled. */
  redis_url?: string;
  // Future: s3_url?, feature_flags?, etc.
}

/** NATS subject for the shared config request/reply. */
export const SHARED_CONFIG_SUBJECT = "config.get";

/** Timeout for the NATS request (ms). If the BE doesn't respond, the caller continues without shared config. */
const SHARED_CONFIG_TIMEOUT_MS = 5_000;

/**
 * BE side: subscribe to `config.get` on NATS and respond with the shared config object.
 *
 * The `getConfig` function is called on each request — the BE passes a function that
 * reads from its auth config (already loaded in memory via `getAuthConfig()`).
 *
 * @param nats The NatsClient class (uses the singleton connection)
 * @param getConfig Function that returns the current SharedConfig
 *
 * Example:
 *   await subscribeSharedConfig(NatsClient, () => {
 *     const cfg = getAuthConfig();
 *     return { redis_url: cfg.redis_url };
 *   });
 */
export async function subscribeSharedConfig(
  nats: typeof NatsClient,
  getConfig: () => SharedConfig,
): Promise<void> {
  await nats.subscribeRequest<unknown, SharedConfig>(
    SHARED_CONFIG_SUBJECT,
    async () => {
      try {
        return getConfig();
      } catch {
        return {};
      }
    },
  );
}

/**
 * Microservice side: fetch the shared config from the BE via NATS request/reply.
 *
 * Best-effort: returns an empty object if the BE doesn't respond or times out.
 * The caller should check individual fields (e.g. `result.redis_url`) rather than
 * assuming the whole object is populated.
 *
 * @param nats The NatsClient class (uses the singleton connection)
 * @returns The SharedConfig object (fields may be undefined if not configured)
 *
 * Example:
 *   const shared = await fetchSharedConfig(NatsClient);
 *   if (shared.redis_url) { /* connect to Redis *\/ }
 */
export async function fetchSharedConfig(
  nats: typeof NatsClient,
): Promise<SharedConfig> {
  try {
    const response = await nats.request<SharedConfig>(
      SHARED_CONFIG_SUBJECT,
      null,
      SHARED_CONFIG_TIMEOUT_MS,
    );
    return response ?? {};
  } catch {
    return {};
  }
}

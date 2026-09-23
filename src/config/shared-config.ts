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
  /**
   * Telemetry/logging config — BE-owned (config_entries rows), shared with
   * all microservices. Single point of configuration; changes are pushed
   * via the `config.changed` broadcast subject.
   */
  telemetry?: TelemetrySharedConfig;
  // Future: s3_url?, feature_flags?, etc.
}

/** Telemetry/logging block distributed via SharedConfig. */
export interface TelemetrySharedConfig {
  enabled?: boolean;
  otlp_endpoint?: string;
  otlp_headers?: Record<string, string>;
  sampler?: "always_on" | "always_off" | "traceidratio";
  sampler_arg?: number;
  log_format?: "pretty" | "json";
  log_level?: "debug" | "info" | "warn" | "error";
}

/** NATS subject for the shared config request/reply. */
export const SHARED_CONFIG_SUBJECT = "config.get";

/**
 * NATS broadcast subject for config-change notifications.
 * The BE publishes `{ keys: [...] }` (fire-and-forget) whenever relevant
 * config rows are written; microservices re-fetch `config.get` and apply.
 */
export const CONFIG_CHANGED_SUBJECT = "config.changed";

/**
 * Microservice side: subscribe to `config.changed` broadcasts.
 * The handler fires on every notification — it should re-fetch the shared
 * config and apply changes (telemetry restart, logger options, etc.).
 */
export async function subscribeConfigChanged(
  nats: typeof NatsClient,
  handler: (payload: { keys?: string[] }) => Promise<void>,
): Promise<void> {
  await nats.subscribe<{ keys?: string[] }>(CONFIG_CHANGED_SUBJECT, handler);
}

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

/**
 * Redis client factory — singleton Redis client, mirroring the SDK's `NatsClient` pattern.
 *
 * The URL is passed in by the caller (the BE, which loads it from `auth_configurations`).
 * The SDK NEVER reads ENV for Redis — per the project rule, the only ENV-allowed variable
 * is the PG connection string. `redis_url` comes from `auth_configurations` via the BE's
 * `loadAuthConfig`.
 *
 * Uses lazyConnect + explicit `connect()` so connection failures throw to the caller, who
 * decides whether to warn-and-continue or fail. The BE's `initCache()` warns and continues
 * — the cache is a feature, not a requirement.
 */

import { createClient, type RedisClientType } from "redis";

let client: RedisClientType | null = null;

/**
 * Create (or return the existing) Redis client. Singleton — subsequent calls with a
 * different URL return the existing client (the URL is only used on first call).
 *
 * @param url Redis URL, e.g. `redis://localhost:6379` or `rediss://host:6380` (TLS).
 * @throws if the connection fails. The caller should catch and warn-and-continue.
 */
export async function createRedisClient(url: string): Promise<RedisClientType> {
  if (client) return client;
  client = createClient({ url }) as RedisClientType;
  client.on("error", (err) => console.error("[redis] client error:", err));
  await client.connect();
  return client;
}

/**
 * Graceful shutdown — disconnect the Redis client. Safe to call multiple times.
 * Registered with the SDK's `GracefulShutdown` by the BE (or US) at bootstrap.
 */
export async function closeRedisClient(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      // If quit fails (e.g. already disconnected), force disconnect.
      client.disconnect();
    }
    client = null;
  }
}

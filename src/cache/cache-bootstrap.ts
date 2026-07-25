/**
 * Cache bootstrap for microservices — one-liner that discovers `redis_url`
 * from the BE via NATS `config.get`, connects to Redis, queries the server
 * version, and logs a startup banner.
 *
 * This is the MANDATORY entry point for any microservice that uses `@Cached()`
 * entities. Without connecting to Redis, cache invalidation from the BE (or
 * other microservices) cannot propagate, and the microservice would serve
 * stale data.
 *
 * Best-effort: if `redis_url` is not configured, Redis is unreachable, or the
 * BE doesn't respond to `config.get`, returns `{ cachePort: null, redisInfo: null }`
 * and logs a `warn`. The system is fully valid without Redis.
 */

import type { CachePort } from "./cache-port.js";
import type { CacheLogger } from "./cached-repository.js";
import { RedisCachePort } from "./redis-cache-port.js";
import { createRedisClient } from "./redis-client.js";
import { getRedisInfo, type RedisInfo } from "./redis-info.js";
import { fetchSharedConfig, type SharedConfig } from "../config/shared-config.js";
import { NatsClient } from "../nats/nats-client.js";

export type CacheBootstrapResult = {
  /** The initialized CachePort, or null if Redis is not configured/unreachable. */
  cachePort: CachePort | null;
  /** Redis server info (version), or null if not connected. */
  redisInfo: RedisInfo | null;
  /** The full shared config received from the BE (may contain other fields in the future). */
  sharedConfig: SharedConfig;
};

/**
 * Initialize the Redis cache for a microservice by discovering `redis_url`
 * from the BE via NATS `config.get`.
 *
 * Must be called AFTER `NatsClient.getConnection()` has succeeded.
 *
 * @param nats The NatsClient class (uses the singleton connection)
 * @param logger Console or custom logger with info/warn methods
 * @returns The cache port (or null) + Redis info (or null) + the full shared config
 *
 * Example:
 *   await NatsClient.getConnection(natsUrl);
 *   const { cachePort } = await initCacheFromSharedConfig(NatsClient, console);
 *   if (cachePort) {
 *     // Use cachePort with withCache() wrapper for your repositories
 *   }
 */
export async function initCacheFromSharedConfig(
  nats: typeof NatsClient,
  logger: CacheLogger,
): Promise<CacheBootstrapResult> {
  const sharedConfig = await fetchSharedConfig(nats);

  if (!sharedConfig.redis_url) {
    logger.warn("[cache] redis_url not received from BE — cache disabled (best-effort)");
    return { cachePort: null, redisInfo: null, sharedConfig };
  }

  try {
    const redis = await createRedisClient(sharedConfig.redis_url);
    const cachePort = new RedisCachePort(redis);
    const redisInfo = await getRedisInfo(redis);

    if (redisInfo) {
      logger.info(`[cache] Redis connected (v${redisInfo.version})`);
    } else {
      logger.info("[cache] Redis connected (version unknown)");
    }

    return { cachePort, redisInfo, sharedConfig };
  } catch (err) {
    logger.warn(`[cache] Redis connection failed — cache disabled: ${err}`);
    return { cachePort: null, redisInfo: null, sharedConfig };
  }
}

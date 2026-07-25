/**
 * Singleton holder for the CachePort instance — for microservices (US).
 *
 * The BE has its own holder at `primebrick-be-v3/src/cache/cache-port-holder.ts`
 * which also manages Redis health. This SDK holder is simpler — it just stores
 * the cachePort and redisInfo so the health check can access them.
 *
 * The US microservice calls `setSdkCachePort()` after `initCacheFromSharedConfig()`
 * and `getSdkCachePort()` in the health check function.
 */
import type { CachePort } from "./cache-port.js";
import type { RedisInfo } from "./redis-info.js";

let sdkCachePort: CachePort | null = null;
let sdkRedisInfo: RedisInfo | null = null;

/**
 * Store the cache port and Redis info (called once after Redis connects).
 */
export function setSdkCachePort(port: CachePort | null, info?: RedisInfo | null): void {
  sdkCachePort = port;
  sdkRedisInfo = info ?? null;
}

/**
 * Returns the CachePort, or null if cache is disabled.
 */
export function getSdkCachePort(): CachePort | null {
  return sdkCachePort;
}

/**
 * Returns the Redis info (version), or null if not connected.
 */
export function getSdkRedisInfo(): RedisInfo | null {
  return sdkRedisInfo;
}

/**
 * Clear the singleton (for tests or graceful shutdown).
 */
export function resetSdkCachePort(): void {
  sdkCachePort = null;
  sdkRedisInfo = null;
}

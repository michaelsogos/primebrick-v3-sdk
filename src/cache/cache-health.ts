/**
 * Redis health check helper — creates a function suitable for passing to
 * `HealthCheck`'s `customChecks` parameter.
 *
 * The function calls `cachePort.ping()` — an actual Redis PING command,
 * not just a null check on the singleton. This detects Redis going down
 * AFTER startup.
 *
 * If cachePort is null (Redis not configured), returns { ok: false }.
 */
import type { CachePort } from "./cache-port.js";
import type { HealthCheckResult } from "../http/health-response.js";

/**
 * Create a Redis health check function from a CachePort getter.
 *
 * @param getCachePort A function that returns the current CachePort (or null).
 *   Using a getter instead of a direct reference allows the health check to
 *   pick up a cache port that is initialized after the health check is created
 *   (e.g. during startup retry).
 * @param getVersion Optional function that returns the cached Redis version
 *   (avoids re-querying INFO on every health probe).
 */
export function createRedisHealthCheck(
  getCachePort: () => CachePort | null,
  getVersion?: () => string | undefined,
): () => Promise<HealthCheckResult> {
  return async () => {
    const port = getCachePort();
    if (!port) return { ok: false, error: "Redis not configured" };
    const ok = await port.ping();
    if (ok) {
      const version = getVersion?.();
      return version ? { ok: true, version } : { ok: true };
    }
    return { ok: false, error: "Redis PING failed" };
  };
}

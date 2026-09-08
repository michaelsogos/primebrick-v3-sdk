/**
 * Cache entry wrapper — stores data + computed ETag in Redis.
 *
 * The SDK's `withCache` wrapper and `TranslationsCache` store `CacheEntry<T>`
 * instead of the raw value. This allows the BE to return ETag headers and
 * answer conditional GET requests (`If-None-Match` → `304 Not Modified`).
 *
 * The `cached_at` timestamp is for debugging/observability only — it is NOT
 * used for TTL. Redis TTL is set via `port.set(key, value, ttl)`.
 */

/** Redis cache entry — wraps the cached value with its ETag. */
export interface CacheEntry<T> {
  data: T;
  etag: string;
  /** Epoch ms (debugging only — not used for TTL). */
  cached_at: number;
}

/** HTTP response metadata for cached endpoints. */
export interface CacheResponseMeta {
  etag: string;
  /** True if the data came from Redis cache (vs fresh DB read). */
  cached: boolean;
}

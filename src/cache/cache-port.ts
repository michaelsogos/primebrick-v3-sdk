/**
 * Cache port — the cache abstraction used by the `withCache` Repository wrapper.
 *
 * The DAL is NOT involved. The SDK owns this port. Consumers (BE, US) inject their own
 * implementation — typically `RedisCachePort` (also in the SDK), but any implementation
 * is accepted (useful for tests with `FakeCachePort`).
 *
 * The `withCache` wrapper calls all methods best-effort: any rejection is swallowed and
 * logged as a `warn`. The cache is a feature, not a requirement — the system is fully
 * valid without it.
 */

import "reflect-metadata";
import { getCacheKeyProperty } from "./cache-decorators.js";

/**
 * Cache port interface. Implementations MUST be best-effort safe: the `withCache` wrapper
 * already wraps every call in try/catch, but implementations should not throw on common
 * conditions (key not found → return `null`, not throw).
 */
export interface CachePort {
  /**
   * Read a value from the cache.
   * @returns The cached value, or `null` if the key does not exist.
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Write a value to the cache.
   * @param ttl Time-to-live in milliseconds. **Omit for no expiry** — use this ONLY for
   *   genuinely immutable data (the cached value can never change). For mutable data,
   *   pick a TTL that bounds the staleness window if Redis is intermittently unavailable
   *   during invalidation. Recommended starting point for mutable data: `300_000` (5 min).
   *   There is NO implicit default — omitting `ttl` means "no TTL, immutable".
   */
  set<T>(key: string, value: T, ttl?: number): Promise<void>;

  /** Delete a single key. No-op if the key does not exist. */
  del(key: string): Promise<void>;

  /**
   * Delete all keys matching a prefix. Used for entity-level invalidation
   * (e.g. `dal:customers:` evicts every cached row of the `customers` entity).
   * Implementations should use SCAN + DEL (not KEYS) to avoid blocking Redis.
   */
  delByPrefix(prefix: string): Promise<void>;
}

/**
 * Builds stable cache keys from entity class + result rows.
 *
 * Key format: `dal:{tableName}:{value}` where `tableName` is the snake_case DB table
 * name read via `Reflect.getMetadata("primebrick:tableName", ctor)`. The DAL's `@Entity`
 * decorator writes this metadata via `Reflect.defineMetadata` (standard JS reflection
 * API — no import from the DAL needed). Falls back to `ctor.name` (JS class name) if the
 * DAL is not used or the metadata is absent.
 *
 * Key resolution order for a row (deterministic, dev-controlled, no magic):
 *   1. The property marked `@CacheKey()` → `dal:{table}:{row[propertyKey]}`
 *   2. Else `row.uuid` (JS property convention — the DAL returns rows with JS property
 *      keys, and the convention is the property is named `uuid`) → `dal:{table}:{row.uuid}`
 *   3. Else the `@Key()` column value, read via
 *      `Reflect.getMetadata("primebrick:keyColumn", ctor)` (written by the DAL's `@Key`
 *      decorator) → `dal:{table}:{row[keyPropertyKey]}`
 *   4. Else throw — `@CacheKey()` is required for entities without a `uuid` property and
 *      without a `@Key()` column exposed via Reflect.
 *
 * The key is always derived from the RESULT ROW, never from the input argument of
 * `findById` / `findByUUID`. This ensures `findById(42)` and `findByUUID(<uuid>)` on the
 * same row produce the SAME cache key, avoiding duplicate entries and partial-invalidation
 * bugs.
 *
 * Why table name via Reflect and not class name: the table name is snake_case and matches
 * the DB — more familiar when debugging Redis keys (`dal:customers:<uuid>` vs
 * `dal:CustomerEntity:<uuid>`). Stable across class renames (the class can be renamed
 * without breaking cache keys, as long as the table name stays). The Reflect API is
 * standard JS — no import from the DAL, just a shared metadata-key convention.
 */
export class CacheKeyBuilder {
  /**
   * Build the entity prefix: `dal:{tableName}:`.
   * Reads the snake_case table name from `Reflect.getMetadata("primebrick:tableName", ctor)`
   * (written by the DAL's `@Entity` decorator). Falls back to `ctor.name` if absent.
   */
  static forEntity(entityClass: new (...args: any[]) => any): string {
    const tableName = Reflect.getMetadata("primebrick:tableName", entityClass) ?? entityClass.name;
    return `dal:${tableName}:`;
  }

  /**
   * Build the cache key for a single result row.
   * Resolution order: `@CacheKey()` → `row.uuid` → `@Key()` column (via Reflect) → throw.
   */
  static forRowFromMeta(entityClass: new (...args: any[]) => any, row: Record<string, unknown>): string {
    const prefix = CacheKeyBuilder.forEntity(entityClass);

    // 1. @CacheKey() — read from the SDK's own metadata (see cache-decorators.ts)
    const cacheKeyProp = getCacheKeyProperty(entityClass);
    if (cacheKeyProp && row[cacheKeyProp] !== undefined && row[cacheKeyProp] !== null) {
      return `${prefix}${row[cacheKeyProp]}`;
    }

    // 2. row.uuid (JS property convention)
    if (row.uuid !== undefined && row.uuid !== null) {
      return `${prefix}${row.uuid}`;
    }

    // 3. @Key() column value, read via Reflect (written by the DAL's @Key decorator)
    const keyCol = Reflect.getMetadata("primebrick:keyColumn", entityClass) as
      | { propertyKey: string; sqlName: string }
      | undefined;
    if (keyCol && row[keyCol.propertyKey] !== undefined && row[keyCol.propertyKey] !== null) {
      return `${prefix}${row[keyCol.propertyKey]}`;
    }

    // 4. No fallback — require @CacheKey() for entities without uuid and without @Key
    throw new Error(
      `Entity ${entityClass.name} has no @CacheKey() property, no row.uuid, and no @Key() column ` +
        `exposed via Reflect — cannot build cache key. Add @CacheKey() to the property to use ` +
        `as the cache key.`,
    );
  }
}

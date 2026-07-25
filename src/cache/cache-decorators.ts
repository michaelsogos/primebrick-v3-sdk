/**
 * Cache decorators — `@Cached(ttl?)` and `@CacheKey()`.
 *
 * These decorators use the SDK's OWN WeakMap metadata store. They do NOT interact with the
 * DAL's `ClassEntityMeta` — they are a completely separate metadata system that coexists
 * on the same class. The SDK has ZERO dependency on the DAL (no `import`, no
 * `import type`, no package dependency).
 *
 * Usage:
 * ```ts
 * @Entity("customers")        // DAL decorator — writes primebrick:tableName via Reflect
 * @Cached(300_000)            // SDK decorator — marks the entity as cacheable, 5min TTL
 * export class CustomerEntity {
 *   @Key() id!: bigint;       // DAL decorator — writes primebrick:keyColumn via Reflect
 *   uuid!: string;            // Convention — CacheKeyBuilder falls back to row.uuid
 *   @Column({ pgType: "varchar" }) name!: string;
 * }
 * ```
 *
 * Or with an explicit cache key (when the entity has no `uuid` and no `@Key`, or when you
 * want a different field):
 * ```ts
 * @Entity("idp_code_map")
 * @Cached()                   // No TTL — immutable data only
 * export class IdpCodeMapEntity {
 *   @CacheKey() idp_code!: string;   // SDK decorator — marks the cache key source
 *   uuid!: string;
 * }
 * ```
 */

/** SDK-internal cache metadata. Stored in a WeakMap keyed by the entity constructor. */
interface CacheEntityMeta {
  isCached: boolean;
  /** Time-to-live in milliseconds. `undefined` = no expiry (immutable data only). */
  ttl?: number;
}

const CACHE_META = new WeakMap<Function, CacheEntityMeta>();
const CACHE_KEY_PROPS = new WeakMap<Function, string>();

/**
 * Mark an entity as cacheable. Reads through the injected `CachePort` on miss; writes
 * invalidate the entity's cache prefix. The wrapper (`withCache`) is best-effort — if the
 * cache is unavailable, the Repository's real methods are called directly.
 *
 * @param ttl Time-to-live in milliseconds. **Omit for no expiry** — use this ONLY for
 *   genuinely immutable data (the cached value can never change). For mutable data, pick a
 *   TTL that bounds the staleness window if Redis is intermittently unavailable during
 *   invalidation. Recommended starting point for mutable data: `300_000` (5 minutes).
 *   There is NO implicit default — `@Cached()` with no arg means "no TTL, immutable".
 */
export function Cached(ttl?: number): ClassDecorator {
  return (ctor: Function) => {
    if (ttl !== undefined && ttl <= 0) {
      throw new Error(`@Cached(): ttl must be a positive number of milliseconds, got ${ttl}`);
    }
    CACHE_META.set(ctor, { isCached: true, ttl });
  };
}

/**
 * Mark the property used as the cache key source. Optional — if absent, `CacheKeyBuilder`
 * falls back to `row.uuid` (JS property convention), then to the `@Key()` column (read via
 * `Reflect.getMetadata("primebrick:keyColumn", ctor)`). If none of these exist,
 * `CacheKeyBuilder.forRowFromMeta` throws and the dev must add `@CacheKey()`.
 *
 * Use this when the entity has no `uuid` property, or when you want the cache key to use
 * a different field (e.g. a natural key like `idp_code`).
 */
export function CacheKey(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: Function }).constructor;
    CACHE_KEY_PROPS.set(ctor, String(propertyKey));
  };
}

/** Returns `true` if the entity class is marked with `@Cached()`. */
export function isEntityCached(ctor: new (...args: any[]) => any): boolean {
  return CACHE_META.get(ctor)?.isCached === true;
}

/**
 * Returns the cache TTL in milliseconds, or `undefined` if no TTL (immutable data).
 * Returns `undefined` for entities not marked with `@Cached()`.
 */
export function getEntityCacheTtl(ctor: new (...args: any[]) => any): number | undefined {
  return CACHE_META.get(ctor)?.ttl;
}

/**
 * Returns the property name marked with `@CacheKey()`, or `undefined` if not set.
 * Used by `CacheKeyBuilder.forRowFromMeta` as the first resolution step.
 */
export function getCacheKeyProperty(ctor: new (...args: any[]) => any): string | undefined {
  return CACHE_KEY_PROPS.get(ctor);
}

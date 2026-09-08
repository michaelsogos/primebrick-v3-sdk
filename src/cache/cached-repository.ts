/**
 * `withCache` — a higher-order wrapper that adds best-effort Redis caching to a DAL
 * Repository (or any object structurally compatible with `CacheableRepository`).
 *
 * The DAL is NOT involved. The SDK owns this wrapper. It uses:
 *   - `CachePort` (the cache abstraction, SDK-local)
 *   - `CacheKeyBuilder` (reads entity metadata via `Reflect.getMetadata`, SDK-local)
 *   - `isEntityCached` / `getEntityCacheTtl` / `getCacheKeyProperty` (SDK's own WeakMap)
 *   - A structural `CacheableRepository` interface — TypeScript structural typing means a
 *     DAL `Repository` is assignable WITHOUT any `import type` from the DAL.
 *
 * **Contract (critical):**
 * 1. **Writes go to the DB first, always.** Cache invalidation happens after a successful
 *    DB write, in a `try/catch` that swallows Redis errors as `warn`. If Redis is down,
 *    the write still succeeded and the caller gets the correct response.
 * 2. **Reads fall through on any cache failure.** `port.get` throws → `warn` + go to DB.
 *    `port.get` returns `null` (miss) → go to DB. `port.set` throws after a miss →
 *    fire-and-forget, the read already returned the DB row. The caller never sees a cache
 *    error.
 * 3. **Cache key is derived from the RESULT ROW** via `CacheKeyBuilder.forRowFromMeta`.
 *    For `findByUUID`, the input IS the uuid, so we can try `port.get` before the DB using
 *    the pre-built key. For `findById`, the input is the PKEY but the cache key is the
 *    uuid (or `@CacheKey` field), so we **must** go to the DB first, then `set` from the
 *    result.
 *
 * Only entities marked `@Cached()` are cached. Other entities pass through untouched.
 * Only single-row finders are cached: `findById`, `findByUUID`, `find`. `findAll` and
 * `findByPage` are NOT cached (high-cardinality keys, memory bomb risk, stale-on-write
 * window dangerous for list views).
 *
 * Cache entries are stored as `CacheEntry<T>` (data + etag) in Redis. The wrapper
 * unwraps `CacheEntry.data` before returning to callers, so existing code sees the
 * raw row (backward compatible). The ETag is available via `findByUUIDWithCache`
 * for endpoints that need to return ETag headers.
 *
 * Writes invalidate the entity cache prefix after a successful DB write. `add` is
 * NOT included in write methods — an INSERT creates a new row that was never cached
 * and does not modify existing cached rows.
 */

import type { CachePort } from "./cache-port.js";
import { CacheKeyBuilder } from "./cache-port.js";
import { isEntityCached, getEntityCacheTtl, getCacheKeyProperty } from "./cache-decorators.js";
import type { CacheEntry } from "./cache-entry.js";
import { wrapCacheEntry } from "./etag.js";

/**
 * Structural interface — a DAL Repository satisfies this without any import from the DAL.
 * TypeScript structural typing: if it has these methods with compatible signatures, it's
 * assignable. No `extends`, no `import type` from `@primebrick/dal-pg`.
 *
 * The signatures are intentionally loose (`any` for entity class and options) because the
 * DAL's `Repository` uses generics that we cannot (and should not) replicate here without
 * importing the DAL's types. The wrapper preserves the runtime behavior; type safety on
 * the entity class is the caller's responsibility (the BE passes a real `Repository`).
 */
export interface CacheableRepository {
  findById(cls: any, id: any, opts?: any): Promise<any>;
  findByUUID(cls: any, uuid: string, opts?: any): Promise<any>;
  find(cls: any, fields?: any, opts?: any): Promise<any>;
  add(cls: any, ...args: any[]): Promise<any>;
  update(cls: any, ...args: any[]): Promise<any>;
  delete(cls: any, ...args: any[]): Promise<any>;
  restore(cls: any, ...args: any[]): Promise<any>;
  hardDelete(cls: any, ...args: any[]): Promise<any>;
  upsert(cls: any, ...args: any[]): Promise<any>;
  upsertMany(cls: any, ...args: any[]): Promise<any>;
  updateMany(cls: any, ...args: any[]): Promise<any>;
}

/** Logger port — matches the DAL's `LoggerPort` shape (structural typing, no import). */
export interface CacheLogger {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/**
 * Wrap a Repository with best-effort Redis caching. Returns the same Repository instance
 * with `findById`, `findByUUID`, `find`, and all write methods overridden.
 *
 * If `port` throws on any call, the wrapper logs a `warn` and falls through to the
 * underlying Repository method. The cache is a feature, not a requirement.
 *
 * Only entities marked `@Cached()` are cached. Other entities pass through untouched.
 *
 * @param repo A DAL Repository (or any object structurally compatible with `CacheableRepository`)
 * @param port CachePort implementation (e.g. `RedisCachePort`)
 * @param logger Optional logger — if absent, warnings are swallowed
 */
export function withCache<R extends CacheableRepository>(
  repo: R,
  port: CachePort,
  logger?: CacheLogger,
): R {
  const orig = {
    findById: repo.findById.bind(repo),
    findByUUID: repo.findByUUID.bind(repo),
    find: repo.find.bind(repo),
    add: repo.add.bind(repo),
    update: repo.update.bind(repo),
    delete: repo.delete.bind(repo),
    restore: repo.restore.bind(repo),
    hardDelete: repo.hardDelete.bind(repo),
    upsert: repo.upsert.bind(repo),
    upsertMany: repo.upsertMany.bind(repo),
    updateMany: repo.updateMany.bind(repo),
  };

  // ─── Reads ───────────────────────────────────────────────────────────────────

  // findById: input is the PKEY, but the cache key is the uuid/@CacheKey field from the
  // result row. So we CANNOT try cache before DB — we go to DB first, then set from result.
  // Stores CacheEntry (data + etag) in Redis; unwraps to raw row for callers (backward compat).
  repo.findById = async (cls, id, opts) => {
    if (!isEntityCached(cls)) return orig.findById(cls, id, opts);
    const row = await orig.findById(cls, id, opts);
    if (row) {
      try {
        const key = CacheKeyBuilder.forRowFromMeta(cls, row);
        if (key === null) return row; // non-entity-shaped row → skip cache silently
        const entry = wrapCacheEntry(row);
        port.set(key, entry, getEntityCacheTtl(cls)).catch((e) =>
          logger?.warn(`[cache] set failed for ${cls.name}: ${e}`),
        );
      } catch (e) {
        logger?.warn(`[cache] key build failed for ${cls.name}: ${e}`);
      }
    }
    return row;
  };

  // findByUUID: input IS the uuid, which is the cache key (or @CacheKey field). We CAN
  // try cache before DB. If @CacheKey is set on a non-uuid field, we fall back to DB-first
  // behavior (same as findById) because we can't predict the key from the input.
  // Stores CacheEntry (data + etag) in Redis; unwraps to raw row for callers (backward compat).
  repo.findByUUID = async (cls, uuid, opts) => {
    if (!isEntityCached(cls)) return orig.findByUUID(cls, uuid, opts);
    const cacheKeyProp = getCacheKeyProperty(cls);
    // Only pre-DB cache lookup if the cache key is the uuid property (the input).
    if (!cacheKeyProp || cacheKeyProp === "uuid") {
      const key = `${CacheKeyBuilder.forEntity(cls)}${uuid}`;
      try {
        const cached = await port.get<CacheEntry<any>>(key);
        if (cached !== null && cached !== undefined) {
          // Unwrap CacheEntry — callers see the raw row (backward compat)
          if (cached && typeof cached === "object" && "data" in cached && "etag" in cached) {
            return cached.data;
          }
          // Legacy: old cache entries stored the raw row without wrapper
          return cached;
        }
      } catch (e) {
        logger?.warn(`[cache] get failed for ${cls.name} uuid=${uuid}: ${e}`);
      }
    }
    const row = await orig.findByUUID(cls, uuid, opts);
    if (row) {
      try {
        const key = CacheKeyBuilder.forRowFromMeta(cls, row);
        if (key === null) return row; // non-entity-shaped row → skip cache silently
        const entry = wrapCacheEntry(row);
        port.set(key, entry, getEntityCacheTtl(cls)).catch((e) =>
          logger?.warn(`[cache] set failed for ${cls.name}: ${e}`),
        );
      } catch (e) {
        logger?.warn(`[cache] key build failed for ${cls.name}: ${e}`);
      }
    }
    return row;
  };

  // find: returns 1 row by construction (limit: 1). Input is filters, not a key —
  // DB-first, then set from result. Stores CacheEntry (data + etag) in Redis.
  repo.find = async (cls, fields, opts) => {
    if (!isEntityCached(cls)) return orig.find(cls, fields, opts);
    const row = await orig.find(cls, fields, opts);
    if (row) {
      try {
        const key = CacheKeyBuilder.forRowFromMeta(cls, row);
        if (key === null) return row; // non-entity-shaped row (e.g. aggregate) → skip cache silently
        const entry = wrapCacheEntry(row);
        port.set(key, entry, getEntityCacheTtl(cls)).catch((e) =>
          logger?.warn(`[cache] set failed for ${cls.name}: ${e}`),
        );
      } catch (e) {
        logger?.warn(`[cache] key build failed for ${cls.name}: ${e}`);
      }
    }
    return row;
  };

  // ─── Writes (invalidate AFTER successful DB write) ────────────────────────────

  const invalidate = async (cls: any) => {
    if (!isEntityCached(cls)) return;
    try {
      await port.delByPrefix(CacheKeyBuilder.forEntity(cls));
    } catch (e) {
      logger?.warn(`[cache] invalidate failed for ${cls.name}: ${e}`);
    }
  };

  // Write methods that invalidate the entity cache prefix after a successful DB write.
  // `add` is NOT included: an INSERT creates a new row that was never cached, and does
  // not modify any existing cached row. Existing cache entries remain valid.
  // `addMany` and `clone` are also excluded (same reasoning — bulk INSERT / copy-INSERT).
  const writeMethods = [
    "update",
    "delete",
    "restore",
    "hardDelete",
    "upsert",
    "upsertMany",
    "updateMany",
  ] as const;
  for (const name of writeMethods) {
    const fn = orig[name];
    (repo as any)[name] = async (cls: any, ...args: any[]) => {
      const result = await fn(cls, ...args);
      await invalidate(cls);
      return result;
    };
  }

  return repo;
}

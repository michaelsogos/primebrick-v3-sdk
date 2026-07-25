/**
 * `RedisCachePort` — Redis implementation of the `CachePort` interface.
 *
 * Uses `node-redis` (the `redis` npm package, v6.x) — the official Redis client for
 * Node.js, recommended by Redis org for new projects. `ioredis` is in best-effort
 * maintenance.
 *
 * Serialization uses the SDK's canonical `extJsonStringify` / `extJsonParse` (built on
 * `json-bigint` with `useNativeBigInt: true`). This is the SAME bigint-safe JSON
 * serializer the BE uses for HTTP responses and the US uses for NATS messages — no
 * divergent `$bigint:` hack. `Date` values are serialized as ISO strings and parsed back
 * as strings; the DAL's existing `pgValueToJsValue` / `hydrateEntityDateFieldsFromJson`
 * coerces ISO strings → `Date` on read (same path as HTTP responses).
 */

import type { CachePort } from "./cache-port.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";
import type { RedisClientType } from "redis";

export class RedisCachePort implements CachePort {
  constructor(private readonly redis: RedisClientType) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw ? extJsonParse<T>(raw) : null;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const raw = extJsonStringify(value);
    if (ttl && ttl > 0) {
      // PX = milliseconds (Redis SET command option)
      await this.redis.set(key, raw, { PX: ttl });
    } else {
      // No TTL — immutable data only. The caller is responsible for ensuring the data
      // is genuinely immutable; otherwise stale reads are unbounded.
      await this.redis.set(key, raw);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async delByPrefix(prefix: string): Promise<void> {
    // node-redis v6: scanIterator yields keys in batches without manual cursor handling.
    // Uses SCAN (not KEYS) to avoid blocking Redis on large keyspaces.
    for await (const key of this.redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      await this.redis.del(key);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }
}

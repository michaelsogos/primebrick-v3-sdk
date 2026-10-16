/**
 * `CachingApiKeyPort` — the ONE cached `ApiKeyPort` implementation.
 *
 * Every service resolves API keys through the same two-step: cache → inner
 * resolver. What varies is only the inner source:
 *   - BE: `DomainApiKeyPort` (owns `public.api_keys`, reads its own DB)
 *   - any US: `NatsApiKeyPort` (governed `auth.apikey.byHash` → BE)
 *
 * Two cache modes:
 *   - `cache` provided (a `CachePort` — Redis): shared key
 *     `be:api_keys:hash:<sha>` / `API_KEY_CACHE_TTL_MS`, so a single warm-up
 *     serves every reader platform-wide. Only positive results are cached —
 *     a revoked key is never served past its TTL anyway.
 *   - `cache` absent/null: bounded in-memory Map — positive TTL 60s,
 *     negative TTL 10s (an unknown key can't NATS-flood the BE), max 1000
 *     entries. This is the ingress-firewall mode (e.g. `webhook`, which has
 *     no database and mostly no Redis).
 *
 * `cache` may be a getter `() => CachePort | null` — services whose port is
 * constructed before Redis connects (e.g. the `apiKeyPort` factory in
 * `createMicroservice`) resolve the port lazily per call.
 */

import { logger } from "../../lifecycle/logger.js";
import type { CachePort } from "../../cache/cache-port.js";
import { apiKeyCacheKey, API_KEY_CACHE_TTL_MS } from "../api-key-cache.js";
import type { ApiKeyPort, ApiKeyRecord } from "./api-key-port.js";

const MEMORY_POSITIVE_TTL_MS = 60_000;
const MEMORY_NEGATIVE_TTL_MS = 10_000;
const MEMORY_MAX_ENTRIES = 1000;

interface MemoryEntry {
  record: ApiKeyRecord | null;
  expires_at_ms: number;
}

export type ApiKeyCacheSource =
  | CachePort
  | (() => CachePort | null)
  | null
  | undefined;

export class CachingApiKeyPort implements ApiKeyPort {
  private memory = new Map<string, MemoryEntry>();

  constructor(
    private inner: ApiKeyPort,
    private cache?: ApiKeyCacheSource,
  ) {}

  private resolveCache(): CachePort | null {
    const c = this.cache;
    if (!c) return null;
    return typeof c === "function" ? c() : c;
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const cache = this.resolveCache();

    if (cache) {
      const key = apiKeyCacheKey(hash);
      try {
        const cached = await cache.get<ApiKeyRecord>(key);
        if (cached) {
          // JSON round-trip turns expires_at into an ISO string — rehydrate
          // to Date or verifyApiKey's `.getTime()` throws on the hot path.
          if (cached.expires_at && !(cached.expires_at instanceof Date)) {
            cached.expires_at = new Date(cached.expires_at);
          }
          return cached;
        }
      } catch (e) {
        logger.warn(`api_keys cache get failed: ${e}`, { tags: ["auth"] });
      }
      const record = await this.inner.findByHash(hash);
      if (!record) return null;
      try {
        await cache.set(key, record, API_KEY_CACHE_TTL_MS);
      } catch (e) {
        logger.warn(`api_keys cache set failed: ${e}`, { tags: ["auth"] });
      }
      return record;
    }

    const now = Date.now();
    const hit = this.memory.get(hash);
    if (hit && hit.expires_at_ms > now) return hit.record;

    const record = await this.inner.findByHash(hash);
    if (this.memory.size >= MEMORY_MAX_ENTRIES) {
      // Evict the oldest insertion (Map preserves insertion order).
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(hash, {
      record,
      expires_at_ms:
        now + (record ? MEMORY_POSITIVE_TTL_MS : MEMORY_NEGATIVE_TTL_MS),
    });
    return record;
  }
}

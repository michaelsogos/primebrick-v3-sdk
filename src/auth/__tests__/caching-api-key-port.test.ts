import { describe, it, expect, vi, afterEach } from "vitest";
import { CachingApiKeyPort } from "../ports/caching-api-key-port.js";
import { apiKeyCacheKey } from "../api-key-cache.js";
import type { ApiKeyPort, ApiKeyRecord } from "../ports/api-key-port.js";
import type { CachePort } from "../../cache/cache-port.js";

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    uuid: "key-uuid-1",
    name: "test-key",
    permissions: ["read"],
    is_system: false,
    is_active: true,
    expires_at: null,
    ...overrides,
  };
}

function makeResolver(record: ApiKeyRecord | null = makeRecord()) {
  const findByHash = vi.fn(async (_hash: string) => record);
  const port: ApiKeyPort = { findByHash };
  return { port, findByHash };
}

/** Minimal in-memory CachePort fake (mirrors Redis semantics). */
class FakeCachePort implements CachePort {
  store = new Map<string, unknown>();
  getCalls = 0;
  setCalls = 0;
  failGet = false;
  failSet = false;

  async get<T>(key: string): Promise<T | null> {
    this.getCalls++;
    if (this.failGet) throw new Error("redis down");
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T, _ttl?: number): Promise<void> {
    this.setCalls++;
    if (this.failSet) throw new Error("redis down");
    this.store.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  async delByPrefix(prefix: string): Promise<void> {
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }
  async isHealthy(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

const HASH = "a".repeat(64);

afterEach(() => {
  vi.useRealTimers();
});

describe("CachingApiKeyPort — CachePort (Redis) mode", () => {
  it("caches a positive result: second call hits the cache, not the resolver", async () => {
    const { port: inner, findByHash } = makeResolver();
    const cache = new FakeCachePort();
    const port = new CachingApiKeyPort(inner, cache);

    const first = await port.findByHash(HASH);
    const second = await port.findByHash(HASH);

    expect(first?.uuid).toBe("key-uuid-1");
    expect(second?.uuid).toBe("key-uuid-1");
    expect(findByHash).toHaveBeenCalledTimes(1);
    expect(cache.getCalls).toBe(2);
    expect(cache.setCalls).toBe(1);
  });

  it("stores under the shared platform key with the shared TTL", async () => {
    const { port: inner } = makeResolver();
    const cache = new FakeCachePort();
    const port = new CachingApiKeyPort(inner, cache);

    await port.findByHash(HASH);
    expect(cache.store.has(apiKeyCacheKey(HASH))).toBe(true);
  });

  it("does NOT cache negative results — every unknown key re-resolves", async () => {
    const { port: inner, findByHash } = makeResolver(null);
    const cache = new FakeCachePort();
    const port = new CachingApiKeyPort(inner, cache);

    expect(await port.findByHash(HASH)).toBeNull();
    expect(await port.findByHash(HASH)).toBeNull();
    expect(findByHash).toHaveBeenCalledTimes(2);
    expect(cache.setCalls).toBe(0);
  });

  it("rehydrates expires_at after the JSON round-trip (string → Date)", async () => {
    const { port: inner, findByHash } = makeResolver();
    const cache = new FakeCachePort();
    const port = new CachingApiKeyPort(inner, cache);

    // Pre-seed exactly what Redis JSON round-trip produces.
    cache.store.set(apiKeyCacheKey(HASH), {
      ...makeRecord(),
      expires_at: "2030-01-01T00:00:00.000Z",
    });

    const hit = await port.findByHash(HASH);
    expect(hit?.expires_at).toBeInstanceOf(Date);
    expect(hit?.expires_at?.getTime()).toBe(
      new Date("2030-01-01T00:00:00.000Z").getTime(),
    );
    expect(findByHash).not.toHaveBeenCalled();
  });

  it("tolerates cache.get failure: falls through to the resolver (fail-open on cache, not on auth)", async () => {
    const { port: inner, findByHash } = makeResolver();
    const cache = new FakeCachePort();
    cache.failGet = true;
    const port = new CachingApiKeyPort(inner, cache);

    const rec = await port.findByHash(HASH);
    expect(rec?.uuid).toBe("key-uuid-1");
    expect(findByHash).toHaveBeenCalledTimes(1);
  });

  it("tolerates cache.set failure: still returns the resolved record", async () => {
    const { port: inner } = makeResolver();
    const cache = new FakeCachePort();
    cache.failSet = true;
    const port = new CachingApiKeyPort(inner, cache);

    expect((await port.findByHash(HASH))?.uuid).toBe("key-uuid-1");
  });

  it("propagates resolver errors — fail-closed, nothing cached", async () => {
    const inner: ApiKeyPort = {
      findByHash: vi.fn(async () => {
        throw new Error("nats timeout");
      }),
    };
    const cache = new FakeCachePort();
    const port = new CachingApiKeyPort(inner, cache);

    await expect(port.findByHash(HASH)).rejects.toThrow("nats timeout");
    expect(cache.setCalls).toBe(0);
    // And the error is not sticky — a retry reaches the resolver again.
    await expect(port.findByHash(HASH)).rejects.toThrow("nats timeout");
    expect(inner.findByHash).toHaveBeenCalledTimes(2);
  });
});

describe("CachingApiKeyPort — in-memory fallback mode", () => {
  it("caches a positive result for the positive TTL window", async () => {
    const { port: inner, findByHash } = makeResolver();
    const port = new CachingApiKeyPort(inner);

    await port.findByHash(HASH);
    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(1);
  });

  it("caches a NEGATIVE result — an unknown key cannot NATS-flood the BE", async () => {
    const { port: inner, findByHash } = makeResolver(null);
    const port = new CachingApiKeyPort(inner);

    expect(await port.findByHash(HASH)).toBeNull();
    expect(await port.findByHash(HASH)).toBeNull();
    expect(findByHash).toHaveBeenCalledTimes(1);
  });

  it("negative entries expire after the short negative TTL", async () => {
    vi.useFakeTimers();
    const { port: inner, findByHash } = makeResolver(null);
    const port = new CachingApiKeyPort(inner);

    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(11_000); // > 10s negative TTL
    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(2);
  });

  it("positive entries expire after the positive TTL", async () => {
    vi.useFakeTimers();
    const { port: inner, findByHash } = makeResolver();
    const port = new CachingApiKeyPort(inner);

    await port.findByHash(HASH);
    vi.advanceTimersByTime(59_000);
    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // > 60s positive TTL
    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache at 1000 entries, evicting the oldest insertion", async () => {
    const { port: inner, findByHash } = makeResolver();
    const port = new CachingApiKeyPort(inner);

    // Fill to capacity with distinct hashes.
    for (let i = 0; i < 1000; i++) {
      await port.findByHash(i.toString(16).padStart(64, "0"));
    }
    expect(findByHash).toHaveBeenCalledTimes(1000);

    // Entry #1001 must evict hash #0 — re-requesting #0 hits the resolver
    // (and its own re-insert evicts hash #1 in turn).
    await port.findByHash("f".repeat(64));
    expect(findByHash).toHaveBeenCalledTimes(1001);

    await port.findByHash("0".repeat(64));
    expect(findByHash).toHaveBeenCalledTimes(1002);

    // Hash #2 is still cached.
    await port.findByHash("2".padStart(64, "0"));
    expect(findByHash).toHaveBeenCalledTimes(1002);
  });
});

describe("CachingApiKeyPort — lazy cache getter", () => {
  it("resolves the cache per call — memory mode until the getter supplies a port", async () => {
    vi.useFakeTimers();
    const cache = new FakeCachePort();
    let available: CachePort | null = null;
    const { port: inner, findByHash } = makeResolver();
    const port = new CachingApiKeyPort(inner, () => available);

    // Before Redis is up: memory mode (60s TTL).
    await port.findByHash(HASH);
    vi.advanceTimersByTime(61_000);
    await port.findByHash(HASH);
    expect(findByHash).toHaveBeenCalledTimes(2);

    // After Redis comes up: the next call goes through the CachePort path.
    available = cache;
    await port.findByHash("b".repeat(64));
    expect(cache.setCalls).toBe(1);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import "reflect-metadata";

import {
  CachePort,
  CacheKeyBuilder,
  Cached,
  CacheKey,
  isEntityCached,
  getEntityCacheTtl,
  getCacheKeyProperty,
  withCache,
  type CacheableRepository,
  type CacheLogger,
} from "../../index.js";
import { extJsonStringify, extJsonParse } from "../../json/ext-json.js";

// ─── Test entities ─────────────────────────────────────────────────────────────

// Simulates a DAL entity with @Entity("customers") metadata exposed via Reflect.
// We write the Reflect metadata manually (the DAL's @Entity decorator would do this).
function simulateDalEntityMeta(tableName: string, keyPropertyKey: string, keySqlName: string) {
  return function <T extends Function>(ctor: T): T {
    Reflect.defineMetadata("primebrick:tableName", tableName, ctor);
    Reflect.defineMetadata("primebrick:keyColumn", { propertyKey: keyPropertyKey, sqlName: keySqlName }, ctor);
    return ctor;
  };
}

@simulateDalEntityMeta("customers", "id", "id")
@Cached(300_000)
class CustomerEntity {
  id!: bigint;
  uuid!: string;
  name!: string;
  created_at!: Date;
}

@simulateDalEntityMeta("orders", "id", "id")
@Cached() // No TTL — immutable
class OrderEntity {
  id!: bigint;
  uuid!: string;
  total!: number;
}

@simulateDalEntityMeta("idp_code_map", "idp_code", "idp_code")
@Cached()
class IdpCodeMapEntity {
  @CacheKey() idp_code!: string;
  uuid!: string;
}

// Entity WITHOUT @Cached — should pass through untouched
@simulateDalEntityMeta("audit_logs", "id", "id")
class AuditLogEntity {
  id!: bigint;
  uuid!: string;
  event!: string;
}

// Entity without uuid and without @CacheKey — should throw on key build
@simulateDalEntityMeta("weird_table", "id", "id")
@Cached(60_000)
class WeirdEntity {
  id!: bigint;
  // No uuid, no @CacheKey
  some_field!: string;
}

// ─── FakeCachePort ─────────────────────────────────────────────────────────────

class FakeCachePort implements CachePort {
  store = new Map<string, string>();
  getShouldThrow = false;
  setShouldThrow = false;
  delByPrefixShouldThrow = false;

  async get<T>(key: string): Promise<T | null> {
    if (this.getShouldThrow) throw new Error("FakeCachePort.get forced throw");
    const raw = this.store.get(key);
    return raw ? (extJsonParse<T>(raw)) : null;
  }
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (this.setShouldThrow) throw new Error("FakeCachePort.set forced throw");
    this.store.set(key, extJsonStringify(value));
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  async delByPrefix(prefix: string): Promise<void> {
    if (this.delByPrefixShouldThrow) throw new Error("FakeCachePort.delByPrefix forced throw");
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

// ─── FakeRepository ────────────────────────────────────────────────────────────

class FakeRepository implements CacheableRepository {
  findByIdCalls = 0;
  findByUUIDCalls = 0;
  findCalls = 0;
  addCalls = 0;
  updateCalls = 0;
  deleteCalls = 0;
  restoreCalls = 0;
  hardDeleteCalls = 0;
  upsertCalls = 0;
  upsertManyCalls = 0;
  updateManyCalls = 0;

  async findById(cls: any, id: any): Promise<any> {
    this.findByIdCalls++;
    return { id, uuid: `uuid-for-${id}`, name: "from-db", created_at: "2026-07-21T10:00:00Z" };
  }
  async findByUUID(cls: any, uuid: string): Promise<any> {
    this.findByUUIDCalls++;
    return { id: 42n, uuid, name: "from-db", created_at: "2026-07-21T10:00:00Z" };
  }
  async find(cls: any, fields?: any): Promise<any> {
    this.findCalls++;
    return { id: 42n, uuid: "uuid-from-filters", name: "from-db", created_at: "2026-07-21T10:00:00Z" };
  }
  async add(cls: any, ...args: any[]): Promise<any> {
    this.addCalls++;
    return { id: 1n, uuid: "new-uuid", ...args[0] };
  }
  async update(cls: any, ...args: any[]): Promise<any> {
    this.updateCalls++;
    return { id: args[0], uuid: `uuid-for-${args[0]}`, name: "updated" };
  }
  async delete(cls: any, ...args: any[]): Promise<any> {
    this.deleteCalls++;
    return { id: args[0], uuid: `uuid-for-${args[0]}` };
  }
  async restore(cls: any, ...args: any[]): Promise<any> {
    this.restoreCalls++;
    return { id: args[0], uuid: `uuid-for-${args[0]}` };
  }
  async hardDelete(cls: any, ...args: any[]): Promise<any> {
    this.hardDeleteCalls++;
    return { id: args[0] };
  }
  async upsert(cls: any, ...args: any[]): Promise<any> {
    this.upsertCalls++;
    return { id: 1n, uuid: "upserted-uuid", ...args[0] };
  }
  async upsertMany(cls: any, ...args: any[]): Promise<any> {
    this.upsertManyCalls++;
    return args[0].map((x: any) => ({ id: 1n, uuid: "upserted-uuid", ...x }));
  }
  async updateMany(cls: any, ...args: any[]): Promise<any> {
    this.updateManyCalls++;
    return args[0].map((x: any) => ({ id: x.id, uuid: `uuid-for-${x.id}`, name: "updated" }));
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("cache-decorators", () => {
  it("isEntityCached returns true for @Cached entities", () => {
    expect(isEntityCached(CustomerEntity)).toBe(true);
    expect(isEntityCached(OrderEntity)).toBe(true);
    expect(isEntityCached(IdpCodeMapEntity)).toBe(true);
  });

  it("isEntityCached returns false for non-@Cached entities", () => {
    expect(isEntityCached(AuditLogEntity)).toBe(false);
  });

  it("getEntityCacheTtl returns the ttl for @Cached(ttl)", () => {
    expect(getEntityCacheTtl(CustomerEntity)).toBe(300_000);
  });

  it("getEntityCacheTtl returns undefined for @Cached() with no ttl", () => {
    expect(getEntityCacheTtl(OrderEntity)).toBeUndefined();
  });

  it("getCacheKeyProperty returns the property for @CacheKey", () => {
    expect(getCacheKeyProperty(IdpCodeMapEntity)).toBe("idp_code");
  });

  it("getCacheKeyProperty returns undefined when @CacheKey is absent", () => {
    expect(getCacheKeyProperty(CustomerEntity)).toBeUndefined();
  });

  it("@Cached throws on non-positive ttl", () => {
    expect(() => Cached(0)(class Foo {})).toThrow();
    expect(() => Cached(-1)(class Bar {})).toThrow();
  });
});

describe("CacheKeyBuilder", () => {
  it("forEntity uses the snake_case table name from Reflect metadata", () => {
    expect(CacheKeyBuilder.forEntity(CustomerEntity)).toBe("dal:customers:");
    expect(CacheKeyBuilder.forEntity(OrderEntity)).toBe("dal:orders:");
  });

  it("forEntity falls back to ctor.name when Reflect metadata is absent", () => {
    class NoDalEntity {}
    expect(CacheKeyBuilder.forEntity(NoDalEntity)).toBe("dal:NoDalEntity:");
  });

  it("forRowFromMeta uses @CacheKey property when present", () => {
    const row = { idp_code: "ACME", uuid: "some-uuid" };
    expect(CacheKeyBuilder.forRowFromMeta(IdpCodeMapEntity, row)).toBe("dal:idp_code_map:ACME");
  });

  it("forRowFromMeta falls back to row.uuid when @CacheKey is absent", () => {
    const row = { id: 42n, uuid: "abc-123", name: "test" };
    expect(CacheKeyBuilder.forRowFromMeta(CustomerEntity, row)).toBe("dal:customers:abc-123");
  });

  it("forRowFromMeta falls back to @Key column (via Reflect) when no @CacheKey and no uuid", () => {
    const row = { id: 99n, some_field: "x" };
    expect(CacheKeyBuilder.forRowFromMeta(WeirdEntity, row)).toBe("dal:weird_table:99");
  });

  it("forRowFromMeta throws when no @CacheKey, no uuid, and no @Key", () => {
    class NoKeyEntity {}
    expect(() => CacheKeyBuilder.forRowFromMeta(NoKeyEntity, { foo: "bar" })).toThrow();
  });

  it("forRowFromMeta ignores undefined/null values in fallback chain", () => {
    const row = { id: 42n, uuid: undefined, name: "test" };
    // uuid is undefined → fall back to @Key column (id)
    expect(CacheKeyBuilder.forRowFromMeta(CustomerEntity, row)).toBe("dal:customers:42");
  });
});

describe("withCache — reads", () => {
  let port: FakeCachePort;
  let repo: FakeRepository;
  let logger: CacheLogger;

  beforeEach(() => {
    port = new FakeCachePort();
    repo = new FakeRepository();
    logger = { warn: vi.fn(), info: vi.fn() };
    withCache(repo, port, logger);
  });

  it("findByUUID hits cache on second call (no DB call)", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    expect(repo.findByUUIDCalls).toBe(1);
    await repo.findByUUID(CustomerEntity, "abc-123");
    expect(repo.findByUUIDCalls).toBe(1); // second call hit cache
  });

  it("findByUUID hydrates cache on miss", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    expect(port.store.size).toBe(1);
    expect(port.store.has("dal:customers:abc-123")).toBe(true);
  });

  it("findById goes to DB first (input id != cache key), then sets from result row", async () => {
    await repo.findById(CustomerEntity, 42);
    expect(repo.findByIdCalls).toBe(1);
    // Cache key is derived from result row's uuid, not from input id
    expect(port.store.has("dal:customers:uuid-for-42")).toBe(true);
  });

  it("find goes to DB first, then sets from result row", async () => {
    await repo.find(CustomerEntity, { name: "test" });
    expect(repo.findCalls).toBe(1);
    expect(port.store.has("dal:customers:uuid-from-filters")).toBe(true);
  });

  it("non-cached entity passes through (no cache calls)", async () => {
    await repo.findByUUID(AuditLogEntity, "abc-123");
    expect(repo.findByUUIDCalls).toBe(1);
    expect(port.store.size).toBe(0);
    await repo.findByUUID(AuditLogEntity, "abc-123");
    expect(repo.findByUUIDCalls).toBe(2); // second call also hits DB
  });
});

describe("withCache — writes invalidate", () => {
  let port: FakeCachePort;
  let repo: FakeRepository;
  let logger: CacheLogger;

  beforeEach(() => {
    port = new FakeCachePort();
    repo = new FakeRepository();
    logger = { warn: vi.fn(), info: vi.fn() };
    withCache(repo, port, logger);
  });

  it("update invalidates the entity's cache prefix", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    expect(port.store.size).toBe(1);
    await repo.update(CustomerEntity, 42);
    expect(port.store.size).toBe(0); // invalidated
  });

  it("delByPrefix cross-entity isolation: write on A does not evict B", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    await repo.findByUUID(OrderEntity, "ord-456");
    expect(port.store.size).toBe(2);
    await repo.update(CustomerEntity, 42);
    expect(port.store.has("dal:customers:abc-123")).toBe(false);
    expect(port.store.has("dal:orders:ord-456")).toBe(true); // not evicted
  });

  it("non-cached entity write does not invalidate anything", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    expect(port.store.size).toBe(1);
    await repo.update(AuditLogEntity, 99);
    expect(port.store.size).toBe(1); // not invalidated
  });
});

describe("withCache — failure handling (best-effort)", () => {
  let port: FakeCachePort;
  let repo: FakeRepository;
  let logger: CacheLogger;

  beforeEach(() => {
    port = new FakeCachePort();
    repo = new FakeRepository();
    logger = { warn: vi.fn(), info: vi.fn() };
    withCache(repo, port, logger);
  });

  it("cache get throws → DB fallback, warn logged, no error to caller", async () => {
    port.getShouldThrow = true;
    const result = await repo.findByUUID(CustomerEntity, "abc-123");
    expect(result).toEqual({ id: 42n, uuid: "abc-123", name: "from-db", created_at: "2026-07-21T10:00:00Z" });
    expect(repo.findByUUIDCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("cache set throws → read still succeeds (fire-and-forget)", async () => {
    port.setShouldThrow = true;
    const result = await repo.findByUUID(CustomerEntity, "abc-123");
    expect(result).toEqual({ id: 42n, uuid: "abc-123", name: "from-db", created_at: "2026-07-21T10:00:00Z" });
    expect(repo.findByUUIDCalls).toBe(1);
  });

  it("cache invalidate throws → write still succeeds, warn logged", async () => {
    await repo.findByUUID(CustomerEntity, "abc-123");
    port.delByPrefixShouldThrow = true;
    const result = await repo.update(CustomerEntity, 42);
    expect(result).toEqual({ id: 42, uuid: "uuid-for-42", name: "updated" });
    expect(repo.updateCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("withCache — DAL independence (no import from @primebrick/dal-pg)", () => {
  it("cache module files have no import from @primebrick/dal-pg", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const files = [
      "cache-port.ts",
      "cache-decorators.ts",
      "cached-repository.ts",
      "redis-cache-port.ts",
      "redis-client.ts",
    ];
    for (const f of files) {
      const content = readFileSync(resolve(process.cwd(), "src/cache", f), "utf8");
      expect(content).not.toMatch(/from\s+["']@primebrick\/dal/);
    }
  });
});

describe("ext-json round-trip (bigint + Date)", () => {
  it("bigint PK + Date created_at round-trip via extJsonStringify/extJsonParse", async () => {
    const original = { id: 42n, created_at: new Date("2026-07-21T10:00:00Z") };
    const serialized = extJsonStringify(original);
    const parsed = extJsonParse<{ id: bigint; created_at: string }>(serialized);
    expect(parsed.id).toBe(42n);
    expect(typeof parsed.created_at).toBe("string");
    // Date round-trips as ISO string; new Date(...) reconstructs the same instant
    expect(new Date(parsed.created_at).toISOString()).toBe("2026-07-21T10:00:00.000Z");
  });
});

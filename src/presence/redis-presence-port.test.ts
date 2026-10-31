/**
 * RedisPresencePort — session-keyed presence semantics (F13).
 * Entries are stored per `user_uuid:session_id`; LEAVE/READING of one tab
 * must never clobber another tab of the same user.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RedisPresencePort } from "./redis-presence-port.js";
import type { PresenceEntry } from "./types.js";

/** Minimal in-memory Redis double covering the commands the port uses. */
function makeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  return {
    hashes,
    sets,
    strings,
    hSet: async (k: string, f: string, v: string) => {
      if (!hashes.has(k)) hashes.set(k, new Map());
      hashes.get(k)!.set(f, v);
    },
    hGet: async (k: string, f: string) => hashes.get(k)?.get(f) ?? null,
    hGetAll: async (k: string) => Object.fromEntries(hashes.get(k) ?? new Map()),
    hKeys: async (k: string) => [...(hashes.get(k)?.keys() ?? [])],
    hDel: async (k: string, f: string) => void hashes.get(k)?.delete(f),
    sAdd: async (k: string, m: string) => {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k)!.add(m);
    },
    sRem: async (k: string, m: string) => void sets.get(k)?.delete(m),
    sCard: async (k: string) => sets.get(k)?.size ?? 0,
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => void strings.set(k, v),
    del: async (k: string) => {
      hashes.delete(k);
      sets.delete(k);
      strings.delete(k);
    },
    expire: async () => true,
  };
}

const E = "job_rule";
const U = "uuid-1";
const USER = "user-1";

function entry(user: string, session: string, status: "READING" | "EDITING" = "READING"): PresenceEntry {
  return {
    user_uuid: user,
    user_name: user,
    avatar_color: null,
    avatar_initials: null,
    status,
    last_seen_at: Date.now(),
    tab_count: 1,
    session_id: session,
  };
}

describe("RedisPresencePort — session-keyed entries", () => {
  let redis: ReturnType<typeof makeRedis>;
  let port: RedisPresencePort;

  beforeEach(() => {
    redis = makeRedis();
    port = new RedisPresencePort(redis as never);
  });

  it("two tabs of the same user coexist as distinct entries", async () => {
    await port.upsertReading(E, U, entry(USER, "sess-a"));
    await port.upsertEditing(E, U, entry(USER, "sess-b", "EDITING"));
    const snap = await port.getSnapshot(E, U);
    expect(snap.readers).toHaveLength(1);
    expect(snap.editors).toHaveLength(1);
    expect(snap.readers[0].session_id).toBe("sess-a");
    expect(snap.editors[0].session_id).toBe("sess-b");
    expect(snap.editors[0].tab_count).toBe(2);
  });

  it("READING on one tab does not clear EDITING on another tab", async () => {
    await port.upsertEditing(E, U, entry(USER, "sess-b", "EDITING"));
    await port.upsertReading(E, U, entry(USER, "sess-a"));
    const snap = await port.getSnapshot(E, U);
    expect(snap.editors).toHaveLength(1); // sess-b still editing
    expect(snap.readers).toHaveLength(1); // sess-a reading
  });

  it("LEAVE removes only that session's entries", async () => {
    await port.upsertReading(E, U, entry(USER, "sess-a"));
    await port.upsertReading(E, U, entry(USER, "sess-b"));
    await port.remove(E, U, USER, "sess-a");
    const snap = await port.getSnapshot(E, U);
    expect(snap.readers).toHaveLength(1);
    expect(snap.readers[0].session_id).toBe("sess-b");
    // tabs set dropped the left session only
    const tabsKey = `presence:${E}:${U}:tabs:${USER}`;
    expect(redis.sets.get(tabsKey)!.has("sess-b")).toBe(true);
    expect(redis.sets.get(tabsKey)!.has("sess-a")).toBe(false);
  });

  it("LEAVE without session removes every session of that user", async () => {
    await port.upsertReading(E, U, entry(USER, "sess-a"));
    await port.upsertReading(E, U, entry(USER, "sess-b"));
    await port.remove(E, U, USER);
    const snap = await port.getSnapshot(E, U);
    expect(snap.readers).toHaveLength(0);
  });

  it("snapshot filters entries whose last_seen_at is stale", async () => {
    const stale = entry(USER, "sess-dead");
    stale.last_seen_at = Date.now() - 60_000; // beyond the 30s TTL
    await port.upsertReading(E, U, stale);
    await port.upsertReading(E, U, entry(USER, "sess-live"));
    const snap = await port.getSnapshot(E, U);
    expect(snap.readers).toHaveLength(1);
    expect(snap.readers[0].session_id).toBe("sess-live");
  });

  it("markEdited stamps every session of the saver", async () => {
    await port.upsertReading(E, U, entry(USER, "sess-a"));
    await port.upsertReading(E, U, entry(USER, "sess-b"));
    await port.markEdited(E, U, USER, Date.now());
    const snap = await port.getSnapshot(E, U);
    for (const e of snap.readers) expect(e.edited_at).toBeDefined();
  });

  it("heartbeat updates only its own session's entry", async () => {
    await port.upsertEditing(E, U, entry(USER, "sess-a", "EDITING"));
    await port.upsertReading(E, U, entry(USER, "sess-b"));
    const t1 = Date.now();
    await port.heartbeat(E, U, USER, "sess-a");
    const usersKey = `presence:${E}:${U}:users`;
    const rawA = JSON.parse(redis.hashes.get(usersKey)!.get(`${USER}:sess-a`)!);
    const rawB = JSON.parse(redis.hashes.get(usersKey)!.get(`${USER}:sess-b`)!);
    expect(rawA.last_seen_at).toBeGreaterThanOrEqual(t1);
    expect(rawA.status).toBe("EDITING"); // heartbeat must not clobber status
    expect(rawB.session_id).toBe("sess-b");
  });
});

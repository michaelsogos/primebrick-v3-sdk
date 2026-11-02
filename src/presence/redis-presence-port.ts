/**
 * `RedisPresencePort` — Redis implementation of the `PresencePort` interface.
 *
 * Uses `node-redis` (the `redis` npm package, v6.x) — the same client the
 * `RedisCachePort` uses. Serialization uses the SDK's canonical `extJsonStringify`
 * / `extJsonParse` (BigInt-safe).
 *
 * Redis key design (per the collaboration plan, section 4.3):
 *
 * - Hash `presence:{entityType}:{entityUuid}:users`
 *     field = `${userUuid}:${sessionId}` (one entry per TAB SESSION — two
 *     tabs of the same user are distinct entries), value = JSON
 *     `PresenceEntry` (status READING or EDITING). TTL 60s (refreshed by
 *     every signal, the SSE liveness tick, and fallback heartbeats).
 *
 * - Hash `presence:{entityType}:{entityUuid}:editors`
 *     field = `${userUuid}:${sessionId}`, value = JSON `{ field, value, since }`.
 *     TTL 60s. A session is in `users` with status EDITING AND in `editors`
 *     while editing; LEAVE removes that session's fields from both.
 *
 * - Set `presence:{entityType}:{entityUuid}:tabs:{userUuid}`
 *     members = sessionId strings. `tab_count = scard`.
 *     TTL 60s. On LEAVE of a tab, `srem` that sessionId only — the user's
 *     other tabs keep their entries.
 *
 * - String `presence:{entityType}:{entityUuid}:changed`
 *     value = JSON `EntityChangedMarker`. TTL 300000ms (5 min).
 *
 * Staleness: Redis cannot expire hash fields individually — the whole-hash
 * TTL is refreshed by any writer, so a dead tab's field would linger
 * forever while others heartbeat. `getSnapshot` therefore filters entries
 * whose `last_seen_at` is older than the presence TTL.
 *
 * Best-effort: if Redis is unavailable, the BE wrapper turns this into a no-op
 * (mirror `cache-port-holder.ts`). The system remains functional; presence UI
 * is simply disabled.
 */
import type { RedisClientType } from "redis";
import type { PresencePort } from "./presence-port.js";
import type { PresenceEntry, PresenceSnapshot, EntityChangedMarker } from "./types.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";

/** Default TTL for presence hashes/sets: 60 seconds. */
const PRESENCE_TTL_MS = 60_000;
/** Default TTL for the "changed" marker: 5 minutes. */
const CHANGED_TTL_MS = 300_000;

export class RedisPresencePort implements PresencePort {
  private readonly redis: RedisClientType;
  private readonly ttlMs: number;

  constructor(redis: RedisClientType, ttlMs: number = PRESENCE_TTL_MS) {
    this.redis = redis;
    this.ttlMs = ttlMs;
  }

  // ─── Key builders ─────────────────────────────────────────────────

  private usersKey(entityType: string, entityUuid: string): string {
    return `presence:${entityType}:${entityUuid}:users`;
  }

  private editorsKey(entityType: string, entityUuid: string): string {
    return `presence:${entityType}:${entityUuid}:editors`;
  }

  private tabsKey(entityType: string, entityUuid: string, userUuid: string): string {
    return `presence:${entityType}:${entityUuid}:tabs:${userUuid}`;
  }

  private changedKey(entityType: string, entityUuid: string): string {
    return `presence:${entityType}:${entityUuid}:changed`;
  }

  /**
   * Hash field for a session entry: `userUuid:sessionId`. Entries without a
   * sessionId (legacy/manual writes) use the bare userUuid.
   */
  private fieldKey(userUuid: string, sessionId?: string): string {
    return sessionId ? `${userUuid}:${sessionId}` : userUuid;
  }

  /**
   * extJsonParse revives every integer as bigint — presence arithmetic
   * (`now - last_seen_at`) expects plain numbers. Normalize after parse.
   */
  private normalizeEntry(entry: PresenceEntry): PresenceEntry {
    entry.last_seen_at = Number(entry.last_seen_at);
    entry.tab_count = Number(entry.tab_count);
    if (entry.edited_at !== undefined) entry.edited_at = Number(entry.edited_at);
    return entry;
  }

  /** Refresh TTL on all presence keys for an entity (+ a specific user's tabs). */
  private async refreshTtl(entityType: string, entityUuid: string, userUuid: string): Promise<void> {
    const ttlSeconds = Math.ceil(this.ttlMs / 1000);
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    await this.redis.expire(usersKey, ttlSeconds);
    await this.redis.expire(editorsKey, ttlSeconds);
    if (userUuid) {
      await this.redis.expire(this.tabsKey(entityType, entityUuid, userUuid), ttlSeconds);
    }
  }

  // ─── PresencePort implementation ──────────────────────────────────

  async upsertReading(entityType: string, entityUuid: string, entry: PresenceEntry): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    const field = this.fieldKey(entry.user_uuid, entry.session_id);
    const readingEntry: PresenceEntry = { ...entry, status: "READING", field: undefined, value: undefined };
    await this.redis.sAdd(this.tabsKey(entityType, entityUuid, entry.user_uuid), field.slice(entry.user_uuid.length + 1));
    await this.redis.hSet(usersKey, field, extJsonStringify(readingEntry));
    // Clear THIS session's editor record (was editing, now reading) — other
    // sessions of the same user keep their EDITING state.
    await this.redis.hDel(editorsKey, field);
    await this.refreshTtl(entityType, entityUuid, entry.user_uuid);
  }

  async upsertEditing(entityType: string, entityUuid: string, entry: PresenceEntry): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    const field = this.fieldKey(entry.user_uuid, entry.session_id);
    const editingEntry: PresenceEntry = { ...entry, status: "EDITING" };
    await this.redis.sAdd(this.tabsKey(entityType, entityUuid, entry.user_uuid), field.slice(entry.user_uuid.length + 1));
    await this.redis.hSet(usersKey, field, extJsonStringify(editingEntry));
    const editorRec = {
      field: entry.field ?? "",
      value: entry.value,
      since: entry.last_seen_at,
    };
    await this.redis.hSet(editorsKey, field, extJsonStringify(editorRec));
    await this.refreshTtl(entityType, entityUuid, entry.user_uuid);
  }

  async remove(entityType: string, entityUuid: string, userUuid: string, sessionId?: string): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    const tabsKey = this.tabsKey(entityType, entityUuid, userUuid);
    if (sessionId) {
      // Session-scoped leave: drop only this tab's entries; other tabs of the
      // same user remain present.
      const field = this.fieldKey(userUuid, sessionId);
      await this.redis.hDel(usersKey, field);
      await this.redis.hDel(editorsKey, field);
      await this.redis.sRem(tabsKey, sessionId);
      return;
    }
    // Whole-user leave (no session known): remove every field belonging to
    // the user — both the legacy bare field and all `userUuid:*` sessions.
    const fields = await this.redis.hKeys(usersKey);
    const owned = fields.filter((f) => f === userUuid || f.startsWith(`${userUuid}:`));
    for (const f of owned) {
      await this.redis.hDel(usersKey, f);
      await this.redis.hDel(editorsKey, f);
    }
    await this.redis.del(tabsKey);
  }

  async heartbeat(entityType: string, entityUuid: string, userUuid: string, sessionId: string): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const tabsKey = this.tabsKey(entityType, entityUuid, userUuid);
    // Add the session id to the tabs set (dedup by set semantics)
    await this.redis.sAdd(tabsKey, sessionId);
    // Update last_seen_at on THIS session's entry, if present
    const field = this.fieldKey(userUuid, sessionId);
    const raw = await this.redis.hGet(usersKey, field);
    if (raw) {
      const entry = this.normalizeEntry(extJsonParse(raw) as PresenceEntry);
      entry.last_seen_at = Date.now();
      entry.tab_count = await this.redis.sCard(tabsKey);
      await this.redis.hSet(usersKey, field, extJsonStringify(entry));
    }
    await this.refreshTtl(entityType, entityUuid, userUuid);
  }

  async getSnapshot(entityType: string, entityUuid: string): Promise<PresenceSnapshot> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const changedKey = this.changedKey(entityType, entityUuid);
    const [usersMap, changedRaw] = await Promise.all([
      this.redis.hGetAll(usersKey),
      this.redis.get(changedKey),
    ]);
    const readers: PresenceEntry[] = [];
    const editors: PresenceEntry[] = [];
    const now = Date.now();
    for (const [field, raw] of Object.entries(usersMap)) {
      const entry = this.normalizeEntry(extJsonParse(raw) as PresenceEntry);
      // Stale entries: Redis cannot expire hash fields — a dead tab's field
      // lingers as long as anyone else refreshes the hash TTL. Drop entries
      // whose last signal is older than the presence TTL.
      if (now - entry.last_seen_at > this.ttlMs) continue;
      // Refresh tab_count from the tabs set (in case of drift)
      const tabsKey = this.tabsKey(entityType, entityUuid, entry.user_uuid);
      entry.tab_count = await this.redis.sCard(tabsKey);
      if (entry.status === "EDITING") {
        editors.push(entry);
      } else {
        readers.push(entry);
      }
    }
    const changed = changedRaw ? (extJsonParse(changedRaw) as EntityChangedMarker) : null;
    // current_version: we don't read the DB here (the SDK is DB-agnostic).
    // The BE fills this in before sending the snapshot (it has the DAL).
    return {
      readers,
      editors,
      changed,
      current_version: 0,
    };
  }

  async markEdited(entityType: string, entityUuid: string, userUuid: string, editedAt: number): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const usersMap = await this.redis.hGetAll(usersKey);
    // Stamp edited_at on EVERY session entry of the saver — all tabs of the
    // same user saved jointly from other viewers' perspective.
    for (const [field, raw] of Object.entries(usersMap)) {
      if (field !== userUuid && !field.startsWith(`${userUuid}:`)) continue;
      const entry = this.normalizeEntry(extJsonParse(raw) as PresenceEntry);
      entry.edited_at = editedAt;
      await this.redis.hSet(usersKey, field, extJsonStringify(entry));
    }
  }

  async setChanged(marker: EntityChangedMarker, ttlMs: number = CHANGED_TTL_MS): Promise<void> {
    const changedKey = this.changedKey(marker.entity_type, marker.entity_uuid);
    await this.redis.set(changedKey, extJsonStringify(marker), { PX: ttlMs });
  }

  async clearChanged(entityType: string, entityUuid: string): Promise<void> {
    const changedKey = this.changedKey(entityType, entityUuid);
    await this.redis.del(changedKey);
  }
}

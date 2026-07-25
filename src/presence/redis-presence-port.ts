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
 *     field = userUuid, value = JSON `PresenceEntry` (status READING or EDITING).
 *     TTL 30s (refreshed by every signal + heartbeat).
 *
 * - Hash `presence:{entityType}:{entityUuid}:editors`
 *     field = userUuid, value = JSON `{ field, value, since }`.
 *     TTL 30s. A user is in `users` with status EDITING AND in `editors` while
 *     editing; LEAVE removes from both.
 *
 * - Set `presence:{entityType}:{entityUuid}:tabs:{userUuid}`
 *     members = sessionId strings. `tab_count = scard`.
 *     TTL 30s. On LEAVE of a tab, `srem` that sessionId; if empty → remove the
 *     user from `users` and `editors`.
 *
 * - String `presence:{entityType}:{entityUuid}:changed`
 *     value = JSON `EntityChangedMarker`. TTL 300000ms (5 min).
 *
 * Best-effort: if Redis is unavailable, the BE wrapper turns this into a no-op
 * (mirror `cache-port-holder.ts`). The system remains functional; presence UI
 * is simply disabled.
 */
import type { RedisClientType } from "redis";
import type { PresencePort } from "./presence-port.js";
import type { PresenceEntry, PresenceSnapshot, EntityChangedMarker } from "./types.js";
import { extJsonStringify, extJsonParse } from "../json/ext-json.js";

/** Default TTL for presence hashes/sets: 30 seconds. */
const PRESENCE_TTL_MS = 30_000;
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
    const readingEntry: PresenceEntry = { ...entry, status: "READING", field: undefined, value: undefined };
    await this.redis.hSet(usersKey, entry.user_uuid, extJsonStringify(readingEntry));
    // Clear from editors (was editing, now reading)
    await this.redis.hDel(editorsKey, entry.user_uuid);
    await this.refreshTtl(entityType, entityUuid, entry.user_uuid);
  }

  async upsertEditing(entityType: string, entityUuid: string, entry: PresenceEntry): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    const editingEntry: PresenceEntry = { ...entry, status: "EDITING" };
    await this.redis.hSet(usersKey, entry.user_uuid, extJsonStringify(editingEntry));
    const editorRec = {
      field: entry.field ?? "",
      value: entry.value,
      since: entry.last_seen_at,
    };
    await this.redis.hSet(editorsKey, entry.user_uuid, extJsonStringify(editorRec));
    await this.refreshTtl(entityType, entityUuid, entry.user_uuid);
  }

  async remove(entityType: string, entityUuid: string, userUuid: string): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const editorsKey = this.editorsKey(entityType, entityUuid);
    const tabsKey = this.tabsKey(entityType, entityUuid, userUuid);
    await this.redis.hDel(usersKey, userUuid);
    await this.redis.hDel(editorsKey, userUuid);
    await this.redis.del(tabsKey);
  }

  async heartbeat(entityType: string, entityUuid: string, userUuid: string, sessionId: string): Promise<void> {
    const usersKey = this.usersKey(entityType, entityUuid);
    const tabsKey = this.tabsKey(entityType, entityUuid, userUuid);
    // Add the session id to the tabs set (dedup by set semantics)
    await this.redis.sAdd(tabsKey, sessionId);
    // Update last_seen_at on the user entry, if present
    const raw = await this.redis.hGet(usersKey, userUuid);
    if (raw) {
      const entry = extJsonParse(raw) as PresenceEntry;
      entry.last_seen_at = Date.now();
      entry.tab_count = await this.redis.sCard(tabsKey);
      await this.redis.hSet(usersKey, userUuid, extJsonStringify(entry));
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
    for (const [userUuid, raw] of Object.entries(usersMap)) {
      const entry = extJsonParse(raw) as PresenceEntry;
      // Refresh tab_count from the tabs set (in case of drift)
      const tabsKey = this.tabsKey(entityType, entityUuid, userUuid);
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

  async setChanged(marker: EntityChangedMarker, ttlMs: number = CHANGED_TTL_MS): Promise<void> {
    const changedKey = this.changedKey(marker.entity_type, marker.entity_uuid);
    await this.redis.set(changedKey, extJsonStringify(marker), { PX: ttlMs });
  }

  async clearChanged(entityType: string, entityUuid: string): Promise<void> {
    const changedKey = this.changedKey(entityType, entityUuid);
    await this.redis.del(changedKey);
  }
}

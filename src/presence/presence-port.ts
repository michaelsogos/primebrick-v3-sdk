/**
 * Presence port — the collaboration presence abstraction.
 *
 * The SDK owns this port. Consumers (BE) inject their own implementation —
 * typically `RedisPresencePort` (also in the SDK), but any implementation is
 * accepted (useful for tests with a fake/in-memory port).
 *
 * All methods MUST be best-effort safe: the BE wrapper swallows rejections
 * (mirror `cache-port-holder.ts` pattern). Presence is a feature, not a
 * requirement — the system is fully valid without it; the UI simply shows no
 * other users.
 */
import type { PresenceEntry, PresenceSnapshot, EntityChangedMarker } from "./types.js";

export interface PresencePort {
  /**
   * Upsert a READING entry for a user on an entity.
   * Refreshes the TTL on the user hash and the tabs set.
   * If the user was previously EDITING, their status becomes READING and
   * the `field`/`value` are cleared.
   */
  upsertReading(entityType: string, entityUuid: string, entry: PresenceEntry): Promise<void>;

  /**
   * Upsert an EDITING entry for a user on an entity.
   * Refreshes the TTL on the user hash, the editors hash, and the tabs set.
   * The `field` and `value` from the entry are stored.
   */
  upsertEditing(entityType: string, entityUuid: string, entry: PresenceEntry): Promise<void>;

  /**
   * Remove a user entirely from an entity's presence (LEAVE).
   * Removes from the users hash, the editors hash, and deletes the tabs set.
   * No-op if the user was not present.
   */
  remove(entityType: string, entityUuid: string, userUuid: string): Promise<void>;

  /**
   * Refresh the TTL for a user's presence on an entity (HEARTBEAT).
   * Updates `last_seen_at` on the entry. No-op if the user is not present
   * (heartbeat is only sent by tabs that previously sent READING/EDITING).
   */
  heartbeat(entityType: string, entityUuid: string, userUuid: string, sessionId: string): Promise<void>;

  /**
   * Build the full snapshot for an entity: readers, editors, changed marker.
   * Called on SSE connect (snapshot event) and on GET presence.
   */
  getSnapshot(entityType: string, entityUuid: string): Promise<PresenceSnapshot>;

  /**
   * Set the "changed" marker for an entity (server-side save hook).
   * Overwrites any existing marker. TTL is `ttlMs` (default 300000 = 5 min).
   */
  setChanged(marker: EntityChangedMarker, ttlMs?: number): Promise<void>;

  /**
   * Clear the "changed" marker for an entity (e.g. on explicit dismiss).
   * No-op if no marker exists.
   */
  clearChanged(entityType: string, entityUuid: string): Promise<void>;
}

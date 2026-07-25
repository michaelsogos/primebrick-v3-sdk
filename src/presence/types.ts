/**
 * Presence & collaboration types for Primebrick v3.
 *
 * These types define the contract for real-time collaboration awareness:
 * who is viewing/editing an entity, what field they are editing, and what
 * the latest server-side change is. They are shared between the BE (which
 * produces them) and the FE (which consumes them via SSE).
 *
 * snake_case everywhere per `data-model-conventions.md` (BE/FE/DAL).
 */

/**
 * Client → BE signal describing what the user is doing on an entity.
 *
 * - `READING`: user opened the entity (loaded_version is what they fetched).
 * - `EDITING`: user is editing a field (field + value are the current draft).
 * - `HEARTBEAT`: keep-alive (refreshes the Redis TTL; no state change).
 * - `LEAVE`: user closed the tab / navigated away.
 */
export type PresenceAction = "READING" | "EDITING" | "LEAVE" | "HEARTBEAT";

/**
 * Persistent status derived from the latest non-heartbeat signal.
 * `HEARTBEAT` and `LEAVE` do not change `status` (LEAVE removes the entry).
 */
export type PresenceStatus = "READING" | "EDITING";

/**
 * Wire payload for `POST /api/v1/entities/:entity/:uuid/presence`.
 * Sent by the FE on open, on field focus, on field blur, on heartbeat, and on close.
 */
export interface PresenceSignal {
  action: PresenceAction;
  /** EDITING only — the field name being edited. */
  field?: string;
  /** EDITING only — the current draft value of the field (full value). */
  value?: unknown;
  /** READING / HEARTBEAT — the `version` the client loaded (for staleness detection). */
  loaded_version?: number;
  /** Tab session id — deduplicates tabs for the same user. FE-generated (uuid). */
  session_id?: string;
}

/**
 * A single user's presence on an entity. Stored in Redis as JSON.
 * One entry per (entity_type, entity_uuid, user_uuid).
 */
export interface PresenceEntry {
  user_uuid: string;
  user_name: string;
  avatar_color: string | null;
  avatar_initials: string | null;
  status: PresenceStatus;
  /** EDITING only — the field being edited. */
  field?: string;
  /** EDITING only — the current draft value of the field. */
  value?: unknown;
  /** Epoch ms of the last signal/heartbeat from this user. */
  last_seen_at: number;
  /** Number of open tabs for this user on this entity (deduped by session_id). */
  tab_count: number;
}

/**
 * Marker published server-side when an auditable entity is saved.
 * Stored in Redis with a 5-minute TTL so late-joining clients can see the
 * most recent change without scanning the audit log.
 */
export interface EntityChangedMarker {
  entity_type: string;
  entity_uuid: string;
  /** The new `version` after the save. */
  version: number;
  /** The `audit_log_id` of the change (for the GET audit/:auditLogId diff endpoint). */
  audit_log_id: number;
  /** user_uuid of the writer. */
  changed_by: string;
  /** Epoch ms of the save. */
  changed_at: number;
}

/**
 * Snapshot returned by `GET /api/v1/entities/:entity/:uuid/presence` and
 * sent as the initial SSE `snapshot` event on connect.
 */
export interface PresenceSnapshot {
  /** Users in READING status (not editing). */
  readers: PresenceEntry[];
  /** Users in EDITING status. */
  editors: PresenceEntry[];
  /** Most recent server-side change marker, or null if none in the TTL window. */
  changed: EntityChangedMarker | null;
  /** Current `version` of the entity (read from DB on snapshot build). */
  current_version: number;
}

/**
 * Delta published on the NATS `presence.{entityType}.{entityUuid}` subject.
 * Consumed by the BE SSE bridge and forwarded to connected FE clients.
 */
export interface PresenceDelta {
  /** The user whose presence changed. */
  user_uuid: string;
  /** The action that triggered this delta. */
  action: PresenceAction;
  /** The updated entry (for READING/EDITING/HEARTBEAT), or null (for LEAVE). */
  entry: PresenceEntry | null;
  /** Epoch ms of the delta (for dedup / ordering on the FE). */
  emitted_at: number;
}

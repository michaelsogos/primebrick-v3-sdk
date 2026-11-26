/**
 * `makeMarkerAuditPort` — collaboration `EntityChangedMarker` publisher for
 * service-owned entities.
 *
 * Wraps any audit writer (typically the DAL's `dal.tableAuditPort()`, which
 * persists the `{table}_audit` row): after the audit write it publishes the
 * marker on NATS `entity.{entityType}.{entityUuid}.changed` — the gateway's
 * collaboration module bridges it to connected SSE clients and persists it
 * to Redis (`setChanged` + `markEdited`).
 *
 * This module deliberately has NO dependency on `@primebrick/dal-pg`
 * (dependency direction is dal ← consumers; the SDK is a sibling) — the port
 * contract is mirrored structurally. And NO Redis: services never own the
 * presence store; Redis persistence is the gateway's `marker-persister`.
 *
 * Usage (inside a service's `entityService` config):
 *
 *   auditPort: makeMarkerAuditPort(dal.tableAuditPort(), "job_rule")
 *
 * `entityType` MUST be the API entity name (singular, the `/entities/:entity`
 * path segment — e.g. `job_rule`), NOT the physical table name: presence keys
 * and NATS subjects are namespaced by it.
 */

import { NatsClient } from "../nats/nats-client.js";
import { getClientSessionId } from "../auth/session-context.js";
import { publishEntityChanged } from "./nats-subjects.js";
import type { EntityChangedMarker } from "./types.js";

/**
 * Structural mirror of dal-pg `AuditParams` (SDK cannot import
 * `@primebrick/dal-pg` — see src/http/entity-router.ts for the same
 * convention). Structurally assignable from the real `AuditParams`:
 * `action` arrives as dal's string-enum `AuditAction`.
 */
export interface MarkerAuditParams {
  entityClassName: string;
  tableName: string;
  /** Mirrors dal `AuditParams.entityId` — null once the entity migrated to
   *  a uuid primary key (its `*_audit` table drops the column). */
  entityId: bigint | null;
  entityUuid: string;
  action: string;
  /** Mirrors dal `AuditParams.changedAt` (`Date | DalNow`): in practice the
   *  dal ALWAYS passes the DAL_NOW sentinel — a symbol meaning "the database
   *  stamps clock_timestamp() itself". The application never knows the real
   *  time by doctrine, so this value is NEVER a usable timestamp: the marker
   *  must take the time from entity_updated_at or the audit row read-back. */
  changedAt: Date | symbol;
  version: bigint;
  changedBy: string;
  delta: Record<string, { old: unknown; new: unknown }>;
  /** Mirrors dal `AuditParams.entity_updated_at` — the entity row's freshly
   *  stamped updated_at from the write's own RETURNING record (authoritative
   *  DB clock). Present only when the write re-stamped it; absent/null for
   *  HARD_DELETE and entities without the column. Never the pre-write stale
   *  value. The marker PREFERS this — it is the entity's canonical
   *  modification time — and falls back to the audit row's changed_at. */
  entity_updated_at?: Date | null;
}

/**
 * Structural mirror of dal-pg `AuditWriteResult` — the inserted audit row
 * key plus its authoritative `changed_at` read back from the RETURNING
 * projection (DB-clock truth, never the application clock).
 */
export interface MarkerAuditResult {
  key: bigint | string;
  changed_at: Date;
}

/**
 * Structural mirror of dal-pg `AuditPort`.
 */
export interface MarkerAuditPort {
  writeAudit(params: MarkerAuditParams): Promise<MarkerAuditResult>;
}

/** Actions that change entity state — INSERT never marks (a new row has no
 *  concurrent viewers); mirrors the gateway's EntityAuditPort. */
const MARKER_ACTIONS = new Set([
  "UPDATE",
  "SOFT_DELETE",
  "RESTORE",
  "HARD_DELETE",
]);

export function makeMarkerAuditPort(
  inner: MarkerAuditPort,
  entityType: string,
): MarkerAuditPort {
  return {
    async writeAudit(params: MarkerAuditParams): Promise<MarkerAuditResult> {
      const result = await inner.writeAudit(params);
      if (!MARKER_ACTIONS.has(params.action)) return result;

      // The marker's changed_at is authoritative DB-clock time, NEVER the
      // application clock: prefer the entity row's freshly stamped
      // updated_at (canonical modification time, carried in params from the
      // write's RETURNING record); fall back to the audit row's changed_at
      // read back by the inner port (the HARD_DELETE path — the entity row
      // no longer exists). params.changedAt is the DAL_NOW sentinel in
      // practice — a symbol, never a timestamp — and must not be consulted.
      const changedAtMs = params.entity_updated_at instanceof Date
        ? params.entity_updated_at.getTime()
        : result.changed_at.getTime();

      const marker: EntityChangedMarker = {
        entity_type: entityType,
        entity_uuid: params.entityUuid,
        version: params.version,
        audit_log_id: typeof result.key === "bigint" ? Number(result.key) : result.key,
        changed_by: params.changedBy,
        // Writer's tab session (X-Client-Session → ALS): distinguishes
        // "my own tab saved" from "another tab of the same user saved".
        changed_by_session: getClientSessionId(),
        changed_at: changedAtMs,
      };
      try {
        if (NatsClient.isConnected()) {
          await publishEntityChanged(NatsClient, marker);
        }
      } catch {
        // best-effort: NATS unavailable — marker lost, audit row kept
      }
      return result;
    },
  };
}

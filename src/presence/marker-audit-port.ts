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
  changedAt: Date;
  version: number;
  changedBy: string;
  delta: Record<string, { old: unknown; new: unknown }>;
}

/**
 * Structural mirror of dal-pg `AuditPort` — `writeAudit` returns the
 * inserted audit row id (used for the marker's `audit_log_id`).
 */
export interface MarkerAuditPort {
  writeAudit(params: MarkerAuditParams): Promise<bigint>;
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
    async writeAudit(params: MarkerAuditParams): Promise<bigint> {
      const auditId = await inner.writeAudit(params);
      if (!MARKER_ACTIONS.has(params.action)) return auditId;

      const marker: EntityChangedMarker = {
        entity_type: entityType,
        entity_uuid: params.entityUuid,
        version: params.version,
        audit_log_id: Number(auditId),
        changed_by: params.changedBy,
        // Writer's tab session (X-Client-Session → ALS): distinguishes
        // "my own tab saved" from "another tab of the same user saved".
        changed_by_session: getClientSessionId(),
        changed_at: params.changedAt.getTime(),
      };
      try {
        if (NatsClient.isConnected()) {
          await publishEntityChanged(NatsClient, marker);
        }
      } catch {
        // best-effort: NATS unavailable — marker lost, audit row kept
      }
      return auditId;
    },
  };
}

/**
 * NATS subject builders + publish helpers for the collaboration feature.
 *
 * Subjects:
 * - `presence.{entityType}.{entityUuid}` — presence deltas (JOIN/LEAVE/EDIT/HEARTBEAT).
 * - `entity.{entityType}.{entityUuid}.changed` — server-side save markers.
 *
 * Subscription is handled by the SDK's existing `bridgeNatsToSse` (no new
 * subscribe helper needed) — the BE bridges these subjects to per-entity
 * `SseEventBus` instances.
 *
 * Serialization uses `extJsonStringify` (BigInt-safe) via `NatsClient.publish`.
 */
import { NatsClient } from "../nats/nats-client.js";
import type { PresenceDelta, EntityChangedMarker } from "./types.js";

/**
 * Build the NATS subject for presence deltas on an entity.
 * Format: `presence.{entityType}.{entityUuid}`
 */
export function presenceSubject(entityType: string, entityUuid: string): string {
  return `presence.${entityType}.${entityUuid}`;
}

/**
 * Build the NATS subject for entity-changed markers.
 * Format: `entity.{entityType}.{entityUuid}.changed`
 */
export function entityChangedSubject(entityType: string, entityUuid: string): string {
  return `entity.${entityType}.${entityUuid}.changed`;
}

/**
 * Publish a presence delta on the NATS `presence.{entityType}.{entityUuid}` subject.
 * The BE calls this after updating Redis via `PresencePort`.
 *
 * `nc` is the `NatsClient` class (publish is a static method). Pass the class
 * itself: `publishPresence(NatsClient, entityType, entityUuid, delta)`.
 */
export async function publishPresence(
  nc: typeof NatsClient,
  entityType: string,
  entityUuid: string,
  delta: PresenceDelta,
): Promise<void> {
  await nc.publish(presenceSubject(entityType, entityUuid), delta);
}

/**
 * Publish an entity-changed marker on the NATS
 * `entity.{entityType}.{entityUuid}.changed` subject.
 * The BE calls this from the audit-port-adapter hook after a successful save.
 *
 * `nc` is the `NatsClient` class (publish is a static method).
 */
export async function publishEntityChanged(
  nc: typeof NatsClient,
  marker: EntityChangedMarker,
): Promise<void> {
  await nc.publish(entityChangedSubject(marker.entity_type, marker.entity_uuid), marker);
}

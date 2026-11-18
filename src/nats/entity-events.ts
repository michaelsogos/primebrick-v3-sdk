/**
 * entity-events — the JetStream transport for the dal-pg domain-event
 * contract (`EntityEvent`/`EntityEventPort` from `@primebrick/dal-pg`).
 *
 * Wire shape: `events.<service_code>.<entity>.<uuid>` — the action lives
 * in the payload, never the subject (trigger filters discriminate via
 * `job_trigger.filter` dot-paths). All events land on the durable
 * `ENTITY_EVENTS` stream; Job Handler is the ONLY sanctioned consumer —
 * cross-service reactions are declared as `job_triggers` rows, never as
 * direct subscriptions in consumer code.
 *
 * Retention: `max_age` bounds staleness globally; `max_msgs_per_subject`
 * bounds per-instance history (per-uuid subject → a hot row cannot evict
 * another row's events). `discard:"old"` = FIFO eviction — the publisher
 * NEVER blocks or throws on a full subject (verified empirically on
 * NATS 2.14.3: PubAck always succeeds, oldest evicted silently — and
 * `discard:"new"` per-subject is not honored on this version, newest
 * wins either way). A lane with no consumer can therefore never create
 * back-pressure on writers; the risk is silent loss for absent/slow
 * consumers, which the JH durable binding is what makes survivable.
 */

import { NatsClient } from "./nats-client.js";

// The event contract is OWNED by dal-pg (`src/entity/events.ts` — the
// repo write path emits it). It is mirrored here STRUCTURALLY because
// the SDK must not gain a dal-pg dependency: `EntityEventPort` is an
// interface, so this port typechecks at the consumer's
// `dal.eventPort = makeNatsEntityEventPort(code)` assignment. Keep the
// shapes in sync — the wire is the real contract.
type EntityWriteAction =
  | "create" | "update" | "delete" | "restore" | "purge" | "duplicate";
export interface EntityEvent {
  schema: 1;
  service: string;
  entity: string;
  table: string;
  action: EntityWriteAction;
  uuid: string;
  version?: number;
  actor: string;
  changed_at: number;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  delta: Record<string, { old: unknown; new: unknown }> | null;
  batch?: string;
}
export type EntityEventDraft = Omit<EntityEvent, "service">;
export interface EntityEventPort {
  emit(event: EntityEventDraft): Promise<void>;
}

/** Stream all entity-domain events land on. */
export const ENTITY_EVENTS_STREAM = "ENTITY_EVENTS";
/** Subject prefix all entity-domain events publish under. */
export const ENTITY_EVENTS_FILTER = "events.>";
/** Retention: global staleness bound — events older than this purge. */
export const ENTITY_EVENTS_MAX_AGE_SECS = 72 * 3600; // 72h
/** Retention: per-instance (`...<uuid>` subject) history bound. */
export const ENTITY_EVENTS_MAX_MSGS_PER_SUBJECT = 100;

/**
 * Canonical subject for an entity event — per entity instance:
 * `events.<service_code>.<entity>.<uuid>`. Consumers bind
 * `events.<svc>.<entity>.>` for all actions/instances of an entity, or
 * the exact subject for a single row.
 */
export function entityEventSubject(serviceCode: string, entity: string, uuid: string): string {
  return `events.${serviceCode}.${entity}.${uuid}`;
}

/**
 * The `EntityEventPort` the Dal emits through — stamps `service` onto
 * the draft, publishes JetStream-durable to the per-uuid subject.
 * Assigned once at boot: `dal.eventPort = makeNatsEntityEventPort(code)`.
 */
export function makeNatsEntityEventPort(serviceCode: string): EntityEventPort {
  return {
    async emit(draft: EntityEventDraft): Promise<void> {
      const event: EntityEvent = { ...draft, service: serviceCode };
      await NatsClient.jetstreamPublish(
        entityEventSubject(serviceCode, draft.entity, draft.uuid),
        event,
      );
    },
  };
}

/**
 * Ensure the `ENTITY_EVENTS` stream exists with the retention limits —
 * idempotent, call at service boot (createMicroservice does this).
 */
export async function ensureEntityEventsStream(): Promise<void> {
  await NatsClient.ensureStream(ENTITY_EVENTS_STREAM, [ENTITY_EVENTS_FILTER], {
    maxAgeSecs: ENTITY_EVENTS_MAX_AGE_SECS,
    maxMsgsPerSubject: ENTITY_EVENTS_MAX_MSGS_PER_SUBJECT,
    discard: "old",
  });
}

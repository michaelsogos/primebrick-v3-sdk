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

import { HONEST_FORMAT_HINTS, type EntityMeta, type MetaColumn } from "@primebrick/core";
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

/** JSON Schema declared on auto-census emits — mirror of dal-pg
 *  `ENTITY_EVENT_SCHEMA` (the wire is the real contract). */
export const ENTITY_EVENT_PAYLOAD_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "schema", "service", "entity", "table", "action", "uuid",
    "actor", "changed_at", "before", "after", "delta",
  ],
  properties: {
    schema: { const: 1 },
    service: { type: "string" },
    entity: { type: "string" },
    table: { type: "string" },
    action: { enum: ["create", "update", "delete", "restore", "purge", "duplicate"] },
    uuid: { type: "string", format: "uuid" },
    version: { type: "integer" },
    actor: { type: "string" },
    changed_at: { type: "integer" },
    before: { type: ["object", "null"] },
    after: { type: ["object", "null"] },
    delta: { type: ["object", "null"] },
    batch: { type: "string" },
  },
};

/**
 * Column → JSON-schema leaf for the typed event snapshot. `pg_type`
 * (physical truth) wins; the UI `type` is the fallback. `badge.values`
 * keys become an `enum` so pickers can offer the closed vocabulary.
 */
function columnEventJsonSchema(col: MetaColumn): Record<string, unknown> {
  const enumVals = col.badge?.values ? Object.keys(col.badge.values) : null;
  const base: Record<string, unknown> = {};
  switch (col.pg_type) {
    case "boolean": case "bool":
      base.type = "boolean"; break;
    case "smallint": case "integer": case "bigint": case "serial": case "bigserial":
      base.type = "integer"; break;
    case "numeric": case "decimal": case "real": case "double precision": case "money":
      base.type = "number"; break;
    case "json": case "jsonb":
      break; // any shape — no type constraint
    default:
      switch (col.type) {
        case "boolean": base.type = "boolean"; break;
        case "number": case "ref_count": base.type = "number"; break;
        default: base.type = "string"; break;
      }
  }
  if (enumVals?.length) base.enum = enumVals;
  const fmt = honestColumnFormat(col, base["type"]);
  if (fmt) base.format = fmt;
  // Presentation hints for schema-driven pickers (filter composer,
  // payload-map navigator): the column's label key + per-enum-value
  // labels ride the schema so consumers translate, never guess.
  if (col.label_key) base.x_label_key = col.label_key;
  if (col.badge?.values) {
    const labels = Object.fromEntries(
      Object.entries(col.badge.values)
        .filter(([, v]) => typeof v.label_key === "string" && v.label_key)
        .map(([k, v]) => [k, v.label_key]),
    );
    if (Object.keys(labels).length > 0) base.x_enum_labels = labels;
  }
  return base;
}

/** Repository-managed audit stamps — identical semantics on every auditable
 *  entity and already carried by the event envelope (`actor`, `changed_at`,
 *  `action`, `version`). Kept OUT of the typed snapshot so the filter
 *  composer offers domain vocabulary only — and a `text` actor column never
 *  claims `uuid` format it cannot keep (`system:<code>` tokens are legal
 *  actors, so the census name-vs-format gate would be lied to). */
const DAL_AUDIT_STAMPS = new Set([
  "created_at", "created_by", "updated_at", "updated_by",
  "deleted_at", "deleted_by", "cloned_at", "cloned_by",
]);

/** Honest `format` for the census enrollment gate (name-vs-format honesty):
 *  only formats the physical type can keep. `ref` columns store the
 *  referenced row uuid. Name-declared hints apply to text leaves EXCEPT
 *  the uuid-promising ones (`*_by`, `*uuid*`): a text column named that way
 *  either stores real uuids (pg_type already says so) or the lie is the
 *  model's — the gate exists to surface it, not to be bypassed. */
function honestColumnFormat(col: MetaColumn, leafType: unknown): string | undefined {
  switch (col.pg_type) {
    case "uuid": return "uuid";
    case "timestamptz": case "timestamp with time zone":
    case "timestamp": case "timestamp without time zone": return "date-time";
    case "date": return "date";
  }
  if (col.type === "ref") return "uuid";
  if (leafType !== "string") return undefined;
  const hint = HONEST_FORMAT_HINTS.find((h) => h.re.test(col.key));
  if (hint && !hint.formats.includes("uuid")) return hint.formats[0];
  return undefined;
}

/**
 * Per-entity payload schema — clones the generic contract and types the
 * `before`/`after` snapshots + `delta` map from the entity's meta columns.
 * Drives the trigger filter composer (real `$.after.<column>` paths and
 * closed enum vocabularies) instead of untyped free JSONPath.
 */
export function entityEventPayloadSchema(meta?: EntityMeta): Record<string, unknown> {
  if (!meta?.columns?.length) return ENTITY_EVENT_PAYLOAD_SCHEMA;
  const snapshot: Record<string, unknown> = {};
  const deltaProps: Record<string, unknown> = {};
  for (const col of meta.columns) {
    if (!col.key || DAL_AUDIT_STAMPS.has(col.key)) continue;
    const leaf = columnEventJsonSchema(col);
    snapshot[col.key] = leaf;
    // `delta.<col>.{old,new}` typed by the same leaf — `$.delta.status.new`
    // resolves the column's format/enum/labels like `$.after.status` does.
    deltaProps[col.key] = {
      type: "object",
      properties: { old: leaf, new: leaf },
      ...(leaf.x_label_key ? { x_label_key: leaf.x_label_key } : {}),
    };
  }
  return {
    ...ENTITY_EVENT_PAYLOAD_SCHEMA,
    properties: {
      ...(ENTITY_EVENT_PAYLOAD_SCHEMA.properties as Record<string, unknown>),
      before: { type: ["object", "null"], properties: snapshot },
      after: { type: ["object", "null"], properties: snapshot },
      delta: { type: ["object", "null"], properties: deltaProps },
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

/**
 * Composition-root wiring for the dal-pg entity-event emission —
 * call ONCE per service boot, after `initDal()`:
 *
 *   await wireEntityEventEmission(dalInfra(), SERVICE_CODE);
 *
 * Ensures the ENTITY_EVENTS stream (idempotent) then binds
 * `dal.eventPort` — from that point every governed `svc` write emits by
 * construction (entity `@Entity(..., {events})` flags still gate). The
 * `dal` parameter is STRUCTURAL (SDK never imports dal-pg): anything
 * with a settable `eventPort`.
 */
export async function wireEntityEventEmission(
  dal: { eventPort?: EntityEventPort },
  serviceCode: string,
): Promise<void> {
  await ensureEntityEventsStream();
  dal.eventPort = makeNatsEntityEventPort(serviceCode);
}

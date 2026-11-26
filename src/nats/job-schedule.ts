/**
 * JetStream message scheduling (ADR-51) + due-lane verification.
 *
 * Verified empirically against nats-server 2.14.3 (see
 * ai-plans/jobs-orchestration-architecture.md §7):
 *
 *   - `allow_msg_schedules` on the stream enables the scheduler; BOTH the
 *     schedule subject and the fire target must be covered by the stream
 *     subjects — use NatsClient.ensureStream(name, subjects, {
 *     allowMsgSchedules: true }).
 *   - The schedule declaration is a stored, rollup-subject message carrying
 *     `Nats-Schedule` + `Nats-Schedule-Target`; republishing on the same
 *     subject REPLACES the schedule.
 *   - Custom headers (incl. the L1 client-shield key and the correlation
 *     headers `x-job-schedule-subject`) are copied verbatim onto the fired
 *     message — publisher identity and correlation survive the delayed fire.
 *   - Fired messages are written into the stream and NEVER dispatched to
 *     core subscribers — due consumers MUST be durable JetStream consumers
 *     (NatsClient.jetstreamSubscribe).
 *   - Cancellation: publish `Nats-Schedule-Next: purge` + `Nats-Scheduler`
 *     on a DIFFERENT subject than the held schedule message.
 *
 * Subject taxonomy:
 *   jobs.schedule.<svc>.<name>[.<id>]   schedule declarations (rollup)
 *   jobs.due.user.<svc>.<action>[.<id>] due lane — full L1+L2+RBAC at fire
 *   jobs.due.system.<svc>.<action>[.<id>] due lane — L1 only (actor=system)
 *   jobs.result.<svc>.<name>            execution results (governance tap)
 *   jobs.cancel.<svc>.<name>[.<id>]     schedule cancellations
 *   jobs.ctl.>                          CONTROL routes (request/reply) —
 *                                       deliberately OUTSIDE the stream
 *                                       capture set: a request on a subject
 *                                       stored by the JOBS stream would be
 *                                       swallowed into the stream and the
 *                                       JetStream PubAck would fake a reply.
 *
 * The JOBS stream subjects are therefore the four data lanes ONLY — never
 * a bare `jobs.>`.
 *
 * NO ARM/DISARM API HERE: schedules are materialized exclusively by
 * primebrick-job's triggers engine — every `jobs.schedule.*` mirror is
 * owned by a `job_triggers` row. Modules declare jobs through
 * `declareSystemJobs` (`jobs.ctl.triggers.materialize`, system-jobs.ts);
 * user-made triggers ride the canonical entity API. The raw publish
 * mechanism is NOT exported: it lives inside the job-handler, the only
 * service that may write `jobs.schedule.*`/`jobs.cancel.*`.
 */

/** Canonical JOBS stream capture set — schedule/due/result/cancel lanes only. */
export const JOB_STREAM_SUBJECTS = [
  "jobs.schedule.>",
  "jobs.due.>",
  "jobs.result.>",
  "jobs.cancel.>",
] as const;

import type { MsgHdrs } from "@nats-io/transport-node";
import { getAuthConfig } from "../auth/auth-config-cache.js";
import type { AuthUser } from "../auth/types.js";

export const JOB_SCHEDULE_HEADERS = {
  schedule: "Nats-Schedule",
  target: "Nats-Schedule-Target",
  ttl: "Nats-Schedule-TTL",
  source: "Nats-Schedule-Source",
  next: "Nats-Schedule-Next",
  scheduler: "Nats-Scheduler",
} as const;

/**
 * Lane-aware `verify` for `NatsClient.jetstreamSubscribe` on `jobs.due.*`.
 *
 * What a due message CAN prove at the gate:
 *   - L1 publisher identity — the schedule declaration was published by an
 *     enrolled service (its static client-shield key survives the rotating
 *     secret because it lives outside that scheme).
 *   - For the user lane: the structural presence of the actor claim
 *     (`x-user-id`) that the ARM attested.
 *
 * What it deliberately does NOT check: the arm-time serialized AuthUser
 * and the rotating client-shield secret frozen in the fired headers —
 * both die ~65 minutes after arming (rotation 60m + grace 5m), which
 * would kill every long-lived user-lane schedule. Authorization is
 * re-derived AT FIRE TIME instead: the consumer runs the freshness
 * checkpoint (see due-forwarder's `freshAuthHeaders` →
 * `auth.ctl.resolve_user`), which re-resolves the actor with CURRENT
 * permissions or refuses the fire (fail-closed). RBAC belongs on the
 * callable's own route — evaluated on FRESH headers — never at this
 * gate: arm-time permissions would keep firing for a since-revoked
 * grant until the secret happened to rotate.
 *
 *   - "system" lane → L1 only; the handler receives no authUser.
 *   - "user" lane   → L1 + actor-claim presence; the handler ALSO
 *     receives no authUser at the gate (it resolves its own). A due
 *     message without the claim is malformed → `null` → the consumer
 *     `term()`s it (terminal denial — redelivery can never fix it).
 */
export function dueLaneVerify(
  lane: "system" | "user",
): (msg: { subject?: string; headers?: MsgHdrs }) => Promise<AuthUser | null | undefined> {
  return async (msg) => {
    // A7 — no shield publisher check here either: the sealed envelope is
    // the provenance proof by construction (see nats-routes.ts).
    if (lane === "system") return undefined;
    return forwardedActor(msg).actor_uuid ? undefined : null;
  };
}

/**
 * Copy the auth headers off an inbound message for verbatim forwarding —
 * used when a service re-publishes a trigger event (or arms a schedule)
 * and the originating user's context must ride along. Only the auth
 * header names configured on this service's AuthConfig are copied.
 */
export function forwardAuthHeaders(msg: { headers?: MsgHdrs }): Record<string, string> {
  const config = getAuthConfig();
  const out: Record<string, string> = {};
  const names = new Set<string>(
    [
      ...Object.values(config.gateway.headers),
      config.gateway.secret_header_name,
    ].filter((n): n is string => typeof n === "string" && n.length > 0),
  );
  for (const name of names) {
    const v = msg.headers?.get(name) ?? msg.headers?.get(name.toLowerCase());
    if (v) out[name.toLowerCase()] = v;
  }
  return out;
}

/**
 * Read the session actor's identity off an inbound message's auth headers
 * — `x-user-id` → `actor_uuid`, `x-user-locale` → `actor_locale` (BCP-47),
 * `x-user-email` → `actor_email`. Header names resolve against the
 * configured `gateway.headers` map with the serializer defaults. All
 * absent on system-lane messages — the values are reported, never
 * invented.
 */
export function forwardedActor(msg: { headers?: MsgHdrs }): {
  actor_uuid?: string;
  actor_locale?: string;
  actor_email?: string;
} {
  const config = getAuthConfig();
  const h = config.gateway.headers;
  const get = (n: string) =>
    msg.headers?.get(n) ?? msg.headers?.get(n.toLowerCase()) ?? undefined;
  return {
    actor_uuid: get(h.user_id ?? "x-user-id"),
    actor_locale: get(h.locale ?? "x-user-locale"),
    actor_email: get(h.email ?? "x-user-email"),
  };
}

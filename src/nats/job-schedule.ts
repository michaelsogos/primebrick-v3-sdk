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
 *   - Custom headers (incl. the L1 client-shield key and forwarded auth
 *     headers) are copied verbatim onto the fired message — L1 identity of
 *     the declaring service survives the delayed fire.
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
 */

/** Canonical JOBS stream capture set — schedule/due/result/cancel lanes only. */
export const JOB_STREAM_SUBJECTS = [
  "jobs.schedule.>",
  "jobs.due.>",
  "jobs.result.>",
  "jobs.cancel.>",
] as const;

/** Control-plane route for schedule declarations (primebrick-job). */
export const JOB_SCHEDULE_REQUEST_SUBJECT = "jobs.ctl.schedule.request";

import type { MsgHdrs } from "nats";
import { NatsClient } from "./nats-client.js";
import { verifyNatsPublisher } from "./service-shield.js";
import { verifyNatsMessage } from "../auth/verify-nats.js";
import { enforceNatsRbac } from "../auth/rbac-enforce.js";
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

export interface EnsureJobScheduleOpts {
  /**
   * Unique schedule subject — `jobs.schedule.<svc>.<name>[.<entity-id>]`.
   * One schedule per subject; republishing replaces it atomically.
   */
  scheduleSubject: string;
  /** `"@every 30s"` | `"@at 2025-12-01T09:00:00Z"` | cron expression. */
  schedule: string;
  /** Subject the stored message is republished to at fire time —
   *  `jobs.due.user.*` or `jobs.due.system.*`. Must be covered by the same
   *  stream's subjects. */
  target: string;
  /** Payload stored on the schedule message — fired verbatim unless
   *  `source` is set. Serialized via extJson by jetstreamPublish. */
  payload?: unknown;
  /** Fire-time indirection (ADR-51): at fire time the scheduler reads the
   *  LATEST message on this subject and fires THAT as the payload — the
   *  schedule declaration never holds business state. */
  source?: string;
  /** `Nats-Schedule-TTL` — auto-purge the schedule after this duration. */
  ttl?: string;
  /**
   * Extra headers stamped on the declaration and forwarded VERBATIM to the
   * fired message. For `jobs.due.user.*` targets pass the triggering
   * message's auth headers via `forwardAuthHeaders()` so the executor can
   * run the full L2+RBAC chain on the ORIGINATING user.
   */
  forwardHeaders?: Record<string, string>;
}

/**
 * Arm a JetStream schedule. Publishes the declaration message — the NATS
 * server itself republishes `payload`/`source` to `target` per `schedule`.
 *
 * Callers do NOT publish on `jobs.schedule.*` directly in production:
 * the governed entry point is the `jobs.schedule.request` route on
 * primebrick-job, which validates the caller's namespace and records the
 * declaration in `job.job_schedules`. This helper is what THAT service
 * calls (and is also usable by tests/tooling).
 */
export async function ensureJobSchedule(opts: EnsureJobScheduleOpts): Promise<bigint> {
  const hdrs: Record<string, string> = {
    ...opts.forwardHeaders,
    [JOB_SCHEDULE_HEADERS.schedule]: opts.schedule,
    [JOB_SCHEDULE_HEADERS.target]: opts.target,
  };
  if (opts.ttl) hdrs[JOB_SCHEDULE_HEADERS.ttl] = opts.ttl;
  if (opts.source) hdrs[JOB_SCHEDULE_HEADERS.source] = opts.source;
  return NatsClient.jetstreamPublish(opts.scheduleSubject, opts.payload ?? null, hdrs);
}

/**
 * Disarm a previously armed schedule. The cancellation MUST go to a
 * different subject than `scheduleSubject` (a same-subject publish would
 * just replace the declaration).
 */
export async function cancelJobSchedule(
  scheduleSubject: string,
  cancelSubject: string,
): Promise<bigint> {
  if (cancelSubject === scheduleSubject) {
    throw new Error(
      "cancelJobSchedule: cancelSubject must differ from scheduleSubject (same-subject publish replaces the schedule)",
    );
  }
  return NatsClient.jetstreamPublish(cancelSubject, null, {
    [JOB_SCHEDULE_HEADERS.next]: "purge",
    [JOB_SCHEDULE_HEADERS.scheduler]: scheduleSubject,
  });
}

/**
 * Lane-aware `verify` for `NatsClient.jetstreamSubscribe` on `jobs.due.*`.
 *
 *   - "system" lane → L1 client shield only (verifyNatsPublisher). The fired
 *     message carries the DECLARING service's static identity — verified
 *     verbatim. No user context exists by design; the handler receives no
 *     authUser.
 *   - "user" lane → L1 + full L2 chain: gateway-secret + serialized AuthUser
 *     + RBAC `permissions`. An expired rotating secret or missing permission
 *     returns null → the consumer `term()`s the message (terminal denial —
 *     recorded as a failed run by the result tap).
 */
export function dueLaneVerify(
  lane: "system" | "user",
  permissions?: readonly string[],
): (msg: { subject?: string; headers?: MsgHdrs }) => Promise<AuthUser | null | undefined> {
  return async (msg) => {
    if (!(await verifyNatsPublisher(msg))) return null;
    if (lane === "system") return undefined;
    const user = await verifyNatsMessage(msg as never, getAuthConfig());
    enforceNatsRbac(user, permissions ?? []);
    return user;
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

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

import type { MsgHdrs } from "@nats-io/transport-node";
import { AckPolicy, JetStreamApiError } from "@nats-io/jetstream";
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

/** One live schedule declaration found in the stream (read via `last_by_subj`). */
export interface JobScheduleDeclaration {
  subject: string;
  /** `Nats-Schedule` spec — "@every 30s", cron, "@at …". */
  schedule: string | undefined;
  /** `Nats-Schedule-Target` — the fired republish destination. */
  target: string | undefined;
  seq: number;
}

/**
 * Read the live declaration stored on `scheduleSubject`, or `null` when no
 * message exists (schedule purged / never armed / stream wiped). Uses the
 * JetStream `last_by_subj` direct-get — O(1) per subject.
 */
export async function getJobSchedule(
  scheduleSubject: string,
  stream = "JOBS",
): Promise<JobScheduleDeclaration | null> {
  const jsm = await NatsClient.getJetStreamManager();
  try {
    const sm = await jsm.streams.getMessage(stream, { last_by_subj: scheduleSubject });
    if (sm === null) return null;
    return {
      subject: sm.subject,
      schedule: sm.header?.get(JOB_SCHEDULE_HEADERS.schedule),
      target: sm.header?.get(JOB_SCHEDULE_HEADERS.target),
      seq: sm.seq,
    };
  } catch (error) {
    // 10037 = no message found — the expected "absent" answer.
    if (error instanceof JetStreamApiError && error.apiError().err_code === 10037) return null;
    throw error;
  }
}

/**
 * Enumerate every live `jobs.schedule.*` declaration in the stream.
 * Ephemeral pull consumer + fetch — each rollup subject yields at most one
 * stored message, so subjects dedup naturally. The consumer is deleted
 * afterwards; partial failures surface as an incomplete list, never a throw
 * that hides them (the caller decides whether a short list is fatal).
 */
export async function listJobScheduleSubjects(stream = "JOBS"): Promise<string[]> {
  const jsm = await NatsClient.getJetStreamManager();
  const js = NatsClient.getJetStream();
  const name = `sched-enum-${Date.now()}`;
  await jsm.consumers.add(stream, {
    durable_name: name,
    filter_subjects: ["jobs.schedule.>"],
    ack_policy: AckPolicy.None,
  });
  try {
    const consumer = await js.consumers.get(stream, name);
    const subjects = new Set<string>();
    for (let round = 0; round < 20; round++) {
      const batch = await consumer.fetch({ max_messages: 200, expires: 1500 });
      let n = 0;
      for await (const m of batch) {
        n++;
        subjects.add(m.subject);
      }
      if (n === 0) break;
    }
    return [...subjects].sort();
  } finally {
    await jsm.consumers.delete(stream, name).catch(() => {});
  }
}

/**
 * Disarm a set of schedules — or ALL live ones with `"all"`. Single purge
 * logic: resolves the subject list then applies `cancelJobSchedule` per
 * subject (the only mechanism — a `jobs.cancel.*` purge publish). Every
 * per-subject failure is collected, not thrown: a disarm pass must run to
 * completion so one bad subject cannot shield the rest. Returns per-subject
 * outcomes for the caller to log/surface.
 */
export async function cancelJobSchedules(
  subjects: string[] | "all",
  stream = "JOBS",
): Promise<{ subject: string; ok: boolean; error?: string }[]> {
  const list = subjects === "all" ? await listJobScheduleSubjects(stream) : subjects;
  const results: { subject: string; ok: boolean; error?: string }[] = [];
  for (const scheduleSubject of list) {
    const rest = scheduleSubject.replace(/^jobs\.schedule\./, "");
    if (rest === scheduleSubject) {
      results.push({ subject: scheduleSubject, ok: false, error: "not a jobs.schedule.* subject" });
      continue;
    }
    try {
      await cancelJobSchedule(scheduleSubject, `jobs.cancel.${rest}`);
      results.push({ subject: scheduleSubject, ok: true });
    } catch (error) {
      results.push({ subject: scheduleSubject, ok: false, error: String(error) });
    }
  }
  return results;
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

/**
 * Read the session actor's identity off an inbound message's auth headers
 * — `x-user-id` → `actor_uuid`, `x-user-locale` → `actor_locale` (BCP-47).
 * Header names resolve against the configured `gateway.headers` map with
 * the serializer defaults. Both absent on system-lane messages — the
 * values are reported, never invented.
 */
export function forwardedActor(msg: { headers?: MsgHdrs }): {
  actor_uuid?: string;
  actor_locale?: string;
} {
  const config = getAuthConfig();
  const h = config.gateway.headers;
  const get = (n: string) =>
    msg.headers?.get(n) ?? msg.headers?.get(n.toLowerCase()) ?? undefined;
  return {
    actor_uuid: get(h.user_id ?? "x-user-id"),
    actor_locale: get(h.locale ?? "x-user-locale"),
  };
}

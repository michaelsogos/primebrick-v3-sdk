/**
 * Job execution-result contract — the header + subject convention the SDK
 * transport middleware enforces on every consumer.
 *
 * A producer correlates a unit of work by stamping `x-job-run-id` (a
 * `job.job_runs` row the publisher already recorded) and/or
 * `x-job-schedule-subject` (the `jobs.schedule.*` declaration that caused
 * the fire). `NatsClient.subscribe` and `NatsClient.jetstreamSubscribe`
 * then publish the handler outcome on `jobs.result.<…>` automatically —
 * observability lives in the transport, it cannot be forgotten per
 * service. A result is emitted for every terminal outcome:
 *
 *   - handler resolved → `succeeded`
 *   - handler threw    → `failed` (then normal ack/nak semantics apply)
 *   - `verify` denied  → `failed` / `error_code: "DENIED"` (terminal)
 *   - a `dispatched` run that never gets a result → the job-handler
 *     sweeper marks it `lost`
 */

/** Correlation header — the `job.job_runs` row this work belongs to. */
export const JOB_RUN_ID_HEADER = "x-job-run-id";

/** Correlation header — the `jobs.schedule.*` declaration that fired it. */
export const JOB_SCHEDULE_SUBJECT_HEADER = "x-job-schedule-subject";

/** Outcome message published on `jobs.result.<…>` after a correlated handler. */
export interface JobResultMessage {
  /**
   * Run-row status vocabulary — `succeeded`/`failed` are the SAME words the
   * `job.job_runs` row and the admin stats/sparkline surfaces use: the
   * recorder folds this value verbatim, no mapping layer.
   */
  status: "succeeded" | "failed";
  run_id?: string;
  schedule_subject?: string;
  /**
   * Stream sequence of the consumed fire (JetStream consumers only).
   * WIRE REALITY: ext-json decodes every JSON integer as `bigint` —
   * publishers assign `number`, consumers MUST accept `bigint`.
   */
  fire_seq?: number | bigint;
  /** The subject the handler consumed — what the outcome refers to. */
  target?: string;
  /** Handler wall time measured by the transport middleware — same
   *  `number`-publish/`bigint`-receive contract as `fire_seq`. */
  duration_ms?: number | bigint;
  /**
   * Structured report returned by the handler — folded into
   * `job_runs.report` by the run-recorder. Only object returns are
   * reported; scalar/void returns carry no report.
   */
  report?: unknown;
  /** Machine-readable failure class, e.g. "DENIED", "HANDLER_ERROR". */
  error_code?: string;
  error_detail?: string;
}

/**
 * Result-lane subject for a consumed subject:
 * `jobs.due.<lane>.<rest>` → `jobs.result.<rest>` (the fire lane peels
 * off); anything else maps verbatim (`emailsender.send` →
 * `jobs.result.emailsender.send`).
 */
export function jobResultSubject(subject: string): string {
  const due = /^jobs\.due\.(?:user|system)\.(.+)$/.exec(subject);
  return `jobs.result.${due ? due[1] : subject}`;
}

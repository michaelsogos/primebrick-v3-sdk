/**
 * System-trigger materialization — the governed way a module declares a
 * code-owned job.
 *
 * A module's system jobs are DECLARED in its code (schedule, source,
 * destination, run_as) and materialized onto `job.job_triggers` via the
 * `jobs.ctl.triggers.materialize` control route on primebrick-job. The
 * materialized row is then the declaration of record the triggers
 * engine reads: the user governs `schedule_spec`/`name` through the
 * entity surface, the code owns the interchange contract
 * (`event_subject`, `target_subject`, `run_as`, `payload_map`,
 * `filter`) — server-side reconcile applies release changes to the
 * code-owned fields only (delta-only writes), never touches user-owned
 * fields, and never resurrects a disabled (soft-deleted) row.
 *
 * Key namespacing is enforced server-side AND by this helper: the job
 * `key` is prefixed with the caller's static service code
 * (`ai.partition_maintenance`), so a service can never materialize
 * outside its own namespace.
 */

import type { NatsConnection } from "@nats-io/transport-node";
import { callNats } from "./nats-routes.js";
import { currentServiceCode } from "../service/service-identity.js";

/** Control-plane route for system-trigger materialization (primebrick-job). */
export const JOB_TRIGGERS_MATERIALIZE_SUBJECT = "jobs.ctl.triggers.materialize";

export interface SystemJobDecl {
  /**
   * Job id inside the caller's namespace — this helper prefixes
   * `<this-service>.` automatically ("partition_maintenance" travels as
   * "ai.partition_maintenance"). Subject-safe tokens only
   * (`^[a-z0-9_][a-z0-9_.-]*$`).
   */
  key: string;
  /** Display name — seeds the row; user-renameable afterwards. */
  name: string;
  /** `"@every 5m"` (≥1m floor) | `"@at …"` | 5-field cron (UTC). Seeds the
   *  row; the user owns it afterwards — re-declaring never re-seeds. */
  schedule_spec?: string;
  /** Source contract (code-owned). Absent for schedule-only jobs. */
  event_subject?: string;
  /** Destination contract (code-owned) — the subject the due-forwarder
   *  republishes the mapped payload onto; typically a callable. */
  target_subject: string;
  /** Code-owned: `system` (no actor), `author` (arm-time actor),
   *  `originator` (event actor — requires `event_subject`). */
  run_as: "system" | "author" | "originator";
  /** Code-owned: `{path → template}` payload map applied by the forwarder. */
  payload_map?: Record<string, string>;
  /** Code-owned: event filter (predicate-tree over the source payload). */
  filter?: unknown;
}

export interface MaterializeResult {
  key: string;
  action: "inserted" | "updated" | "unchanged" | "skipped_deleted";
  uuid?: string;
  changed_fields?: string[];
}

/**
 * THE governed way to materialize a module's system jobs — awaited
 * end-to-end: request/reply onto `jobs.ctl.triggers.materialize` on
 * primebrick-job, which reconciles every declared job against its row
 * (insert if absent, delta-update code-owned fields, skip deleted rows).
 * Rejects on validation/namespace errors — the caller retries at the
 * next registration; it never writes `job_triggers` directly.
 */
export async function declareSystemJobs(
  jobs: SystemJobDecl[],
  opts: { timeoutMs?: number; connection?: NatsConnection } = {},
): Promise<MaterializeResult[]> {
  const svc = currentServiceCode();
  const res = await callNats<{ results: MaterializeResult[] }>(
    JOB_TRIGGERS_MATERIALIZE_SUBJECT,
    { jobs: jobs.map((j) => ({ ...j, key: `${svc}.${j.key}` })) },
    opts,
  );
  return res.results;
}

/**
 * Sequence-revive — the shared SYSTEM JOB every dal-backed service gets
 * by construction: the builtin `sequences` table mounts unconditionally,
 * so every module owns reviving rows potentially due at any time.
 *
 * The job is declared in code (the code owns the interchange contract)
 * and materialized onto `job.job_triggers` via `declareSystemJobs` →
 * `jobs.ctl.triggers.materialize` on primebrick-job. The trigger row is
 * the declaration of record: primebrick-job's triggers engine arms the
 * JetStream schedule, the due-forwarder republishes onto the
 * `<svc>.sequence_revive` callable mounted here, and the owning
 * service executes the DAL `sequenceRevive` primitive inside its own
 * process — the executor is the owning service itself, never a shared
 * worker, and the revive ALGORITHM lives once in dal-pg, identical for
 * every service (phase A successor clone + phase B switched-row
 * retirement in one transaction).
 *
 * Ownership split (the materialize contract) — same as the
 * partition-maintenance twin:
 *   - code owns   → `target_subject`, `run_as`, `event_subject`,
 *                   `payload_map`, `filter` — releases reconcile them
 *                   delta-only
 *   - user owns   → `schedule_spec`, `name`, enable/disable — the row's
 *                   user-visible schedule is THE schedule
 *
 * Materialize goes through the governed control route (primebrick-job
 * down = the call rejects): retried every 30s and on
 * `service.gateway_online`. The reconcile is idempotent — re-declaring
 * the same contract is a pure read; a disabled (soft-deleted) trigger
 * row is NEVER resurrected.
 *
 * A late job never halts: `sequenceRevive` chains successors one real
 * period at a time until the current generation owns `now`, and the
 * missed-fire evidence stays in `job.job_schedules`/`job.job_runs` for
 * the future log-interceptor plan.
 */

import { makeNatsRoutes } from "../nats/nats-routes.js";
import { serviceShieldVerify, subscribeShielded } from "../nats/service-shield.js";
import { declareSystemJobs } from "../nats/system-jobs.js";
import { setProcessInterval } from "../lifecycle/process-registry.js";
import { SERVICE_SUBJECTS } from "../service/service-lifecycle-subjects.js";
import { currentServiceCode } from "../service/service-identity.js";
import { ValidationError } from "../http/rpc-router.js";
import { logger } from "../lifecycle/logger.js";

/**
 * What `createMicroservice` needs to mount the job — produced by
 * dal-pg's `makeSequenceReviveJob()`:
 * `needed` is the ownership gate, `run` is the DAL executor.
 */
export interface SequenceReviveJob {
  /** `false` when the service owns no sequence surface — nothing mounts. */
  needed: boolean;
  /** Runs `dal.sequenceRevive({actor:"system"})`; result → run report. */
  run: () => Promise<unknown>;
  /**
   * The owning schema's translation namespace for the callable's
   * label/description keys — `public`→`app`, every other schema owns
   * itself. Resolved lazily at mount time by the dal-pg factory.
   */
  i18nNs: () => string;
}

const JOB_NAME = "sequence_revive";
/** Seed cadence — 04:15 UTC daily; revives are date-boundary work. The
 *  row is user-editable afterwards (user owns `schedule_spec`). */
const SEED_SCHEDULE = "15 4 * * *";
const ARM_RETRY_MS = 30_000;

/** Parameterless call — the payload contract served to the callable
 *  census. Accepts a plain object or null (schedule-only triggers
 *  dispatch a null payload); anything else is rejected before the
 *  handler runs. */
const PAYLOAD_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
};
const parsePayload = (raw: unknown): unknown => {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  throw new ValidationError(`${JOB_NAME}: payload must be an object or null`);
};

/**
 * Mount the `<svc>.sequence_revive` callable and materialize the
 * system trigger. Called by `createMicroservice` inside the deferred
 * on-ready init — NATS is connected and migrations have succeeded by
 * then, and the callable is picked up by the post-onReady census.
 */
export async function mountSequenceReviveJob(
  job: SequenceReviveJob,
): Promise<void> {
  const svc = currentServiceCode();
  const subject = `${svc}.${JOB_NAME}`;
  const i18nNs = job.i18nNs();

  // The callable route — the actual executor, inside this process. A
  // work item (queue `<svc>`): exactly one replica runs each fire. A
  // system-lane dispatch carries NO user context and NO client-shield
  // secret (run_as:"system" arms headers-free — the rotating secret is
  // never frozen), so `verify: serviceShieldVerify` replaces the default
  // verifyNatsMessage L2 chain: the L1 client-shield enrollment is the
  // gate, exactly as `dueLaneVerify("system")` defines the lane.
  await makeNatsRoutes(
    [
      {
        subject,
        queue: svc,
        permissions: [],
        verify: serviceShieldVerify,
        payload_schema: { schema: PAYLOAD_JSON_SCHEMA, parse: parsePayload },
        label_key: `${i18nNs}.callable.sequence_revive.label`,
        description_key: `${i18nNs}.callable.sequence_revive.desc`,
        handler: async () => {
          logger.info(`${JOB_NAME} fired`, { tags: ["jobs"] });
          const report = await job.run();
          logger.done(`${JOB_NAME} done`, { tags: ["jobs"] });
          return report;
        },
      },
    ],
    { serviceCode: svc },
  );
  logger.done(`${JOB_NAME} callable ready on ${subject}`, { tags: ["jobs"] });

  let armed = false;
  /** One materialize attempt — idempotent (an unchanged contract is a
   *  pure read). A failure is never fatal: the callable route above is
   *  ready regardless, and the retry loop re-attempts until
   *  primebrick-job answers. */
  const tryDeclare = async (reason: string): Promise<void> => {
    if (armed) return;
    try {
      const results = await declareSystemJobs(
        [
          {
            key: JOB_NAME,
            name: `${svc}-sequence-revive`,
            schedule_spec: SEED_SCHEDULE,
            target_subject: subject,
            run_as: "system",
          },
        ],
        { timeoutMs: 3000 },
      );
      armed = true;
      logger.done(
        `${JOB_NAME} system trigger materialized (${results.map((r) => `${r.key}:${r.action}`).join(", ")})`,
        { tags: ["jobs"] },
      );
    } catch (err) {
      logger.warn(
        `${JOB_NAME} materialize failed (${reason}): ${err instanceof Error ? err.message : err} — retry pending`,
        { tags: ["jobs"] },
      );
    }
  };

  // Materialize now; if primebrick-job is unreachable the interval + the
  // gateway_online broadcast (ecosystem restart — services re-register)
  // keep retrying.
  void tryDeclare("boot");
  setProcessInterval(`${svc}-sequence-revive-materialize-retry`, ARM_RETRY_MS, () => {
    void tryDeclare("interval");
  });
  await subscribeShielded(SERVICE_SUBJECTS.GATEWAY_ONLINE, () => tryDeclare("gateway_online"));
}

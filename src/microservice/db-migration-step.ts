/**
 * Boot-time migration step (createMicroservice step 2.5).
 *
 * Runs AFTER initDal (pool must exist) and BEFORE ConfigLoader/every other
 * table read — the owning service patches its own schema before anything
 * trusts the catalog. Mode comes from `<schema>.config_entries`
 * (key `db_migration.mode`), read by the engine itself — never from env.
 *
 * On critical failure the service keeps booting in DEGRADED mode: it
 * registers, heartbeats `db_migration.ok=false` (BE → `migration_failed`),
 * mounts ONLY the admin remediation routes and 503s everything else.
 *
 * Dependency direction: the SDK cannot import @primebrick/dal-pg — the
 * service injects it via `engine` (structural port, satisfied by the
 * dal-pg migrations exports: `engine: dalMigrations` where
 * `import * as dalMigrations from "@primebrick/dal-pg"`).
 */

import { logger } from "../lifecycle/logger.js";
import { assertDbEnv } from "../env/db-env.js";

/** Structural mirror of dal-pg's MigrationRunResult — no dal import. */
export interface MigrationRunResultLike {
  mode: string;
  degraded: boolean;
  applied: string[];
  failed: { patch_name: string; error: string }[];
  pendingReview: string[];
  skipped: string[];
  securityEvents: string[];
}

export interface MigrationEngineOptsLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- port boundary: the concrete pool type lives in dal-pg, which the SDK must not import
  pool: any;
  schema: string;
  patchesDir: string;
  dbMetaDir?: string;
  allowedTrust?: readonly ("release" | "dev")[];
  approvedReviews?: readonly string[];
  actor?: string;
  lockWaitMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LoggerPort lives in dal-pg
  logger?: any;
}

/**
 * Structural port satisfied by `@primebrick/dal-pg` migrations exports
 * (`import * as dalMigrations from "@primebrick/dal-pg"` → `engine: dalMigrations`).
 * Params are `any` at the boundary: strictFunctionTypes contravariance would
 * otherwise reject the dal signatures, and the concrete types cannot be
 * named here anyway (SDK must not import dal-pg).
 */
export interface DbMigrationEnginePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runMigrations(opts: MigrationEngineOptsLike): Promise<MigrationRunResultLike>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registryStatus(pool: any, schema: string): Promise<unknown[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retryFailedPatches(pool: any, schema: string, actor?: string): Promise<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  approvePendingReview(
    pool: any,
    schema: string,
    patchName: string,
    actor: string,
    note?: string,
  ): Promise<boolean>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveManually(
    pool: any,
    schema: string,
    patchName: string,
    actor: string,
    note: string,
  ): Promise<boolean>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkDrift(registry: readonly any[], db: any): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isDriftClean(diff: any): boolean;
  /** Boot schema-domain guard — dal-pg `assertEntitySchemaDomain`. Throws on violations. */
  assertEntitySchemaDomain?(entities: readonly unknown[], schemas: readonly string[]): void;
}

export interface DbMigrationBootOptions {
  /** dal-pg migrations surface — `import * as m from "@primebrick/dal-pg"` satisfies this. */
  engine: DbMigrationEnginePort;
  /** Live pg pool — evaluated lazily right after `getDal()` ran. */
  pool: () => unknown;
  /** Owning service schema (e.g. `env.DATABASE_SCHEMA`) — registry lives there. */
  schema: () => string;
  /** Directory containing the .sql patch files (usually `<svc>/db-meta/patches`). */
  patchesDir: string;
  /** db-meta dir with MANIFEST.json + keys.json — defaults to dirname(patchesDir). */
  dbMetaDir?: string;
  /** Manifest signature trust levels accepted by this deploy. Default ["release"]. */
  allowedTrust?: readonly ("release" | "dev")[];
  /** Entity registry of this service — enables the post-apply drift check. */
  entityRegistry?: readonly unknown[];
}

export interface MigrationBootState {
  /** null when migrations never ran (option not set). */
  result: MigrationRunResultLike | null;
  /** Boot-time mode actually used. */
  degraded: boolean;
  /** Monotonic flag the heartbeat/health surface reads live. */
  lastError: string | null;
  appliedCount: number;
}

export async function runDbMigrationStep(
  opts: DbMigrationBootOptions,
): Promise<MigrationBootState> {
  const state: MigrationBootState = {
    result: null,
    degraded: false,
    lastError: null,
    appliedCount: 0,
  };
  const pool = opts.pool();
  const schema = opts.schema();

  // Schema-domain guard BEFORE any migration/drift work: every registered
  // entity must resolve inside DATABASE_SCHEMA — a cross-schema entity is a
  // code bug, so it crashes the boot (outside try: never degraded-swallowed).
  const { schemas } = assertDbEnv();
  if (opts.entityRegistry && opts.engine.assertEntitySchemaDomain) {
    opts.engine.assertEntitySchemaDomain(opts.entityRegistry, schemas);
  }

  try {
    const result = await opts.engine.runMigrations({
      pool,
      schema,
      patchesDir: opts.patchesDir,
      dbMetaDir: opts.dbMetaDir,
      allowedTrust: opts.allowedTrust ?? ["release"],
      actor: `boot:${process.pid}`,
      logger,
    });
    state.result = result;
    state.appliedCount = result.applied.length;
    state.degraded = result.degraded;

    if (result.degraded) {
      logger.error(
        `db-migration: CRITICAL patch failure — service boots degraded, domain routes will 503 until an admin remediates`,
        {
          tags: ["db-migration"],
          error: result.failed.map((f) => `${f.patch_name}: ${f.error}`).join(" | "),
        },
      );
      return state;
    }

    // Post-apply drift verification — visible, never silently ignored.
    if (opts.entityRegistry && opts.entityRegistry.length > 0) {
      const drift = await opts.engine.checkDrift(opts.entityRegistry, pool);
      if (!opts.engine.isDriftClean(drift)) {
        logger.warn("db-migration: post-apply drift remains (see diff)", {
          tags: ["db-migration"],
          drift,
        });
      } else {
        logger.done("db-migration: post-apply drift check clean", { tags: ["db-migration"] });
      }
    }
    return state;
  } catch (error) {
    // Engine throws on security gate failures and lock contention — boot
    // continues degraded so the admin surface can remediate.
    state.degraded = true;
    state.lastError = error instanceof Error ? error.message : String(error);
    logger.error(`db-migration: engine aborted — degraded boot (${state.lastError})`, {
      tags: ["db-migration"],
      error,
    });
    return state;
  }
}

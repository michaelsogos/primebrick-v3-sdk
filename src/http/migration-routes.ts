/**
 * `db_patch` system module — admin remediation surface for DB migrations.
 *
 * Mounted automatically by createMicroservice whenever `dbPatches` is
 * configured — in degraded mode it is the ONLY reachable surface (domain
 * routes 503). All routes are `auth: "user"` + AUTHENTICATED_ADMIN.
 *
 *   GET  /api/v1/system/db-migration/status   registry rows + boot result
 *   POST /api/v1/system/db-migration/retry    failed → pending, then re-run
 *   POST /api/v1/system/db-migration/approve  pending_review → approved, then re-run
 *   POST /api/v1/system/db-migration/resolve  failed/pending → resolved_manual (escape hatch)
 *   POST /api/v1/system/db-migration/drift-check   on-demand catalog diff
 *
 * Dependency direction: uses `boot.engine` (DbMigrationEnginePort) injected
 * by the service — the SDK never imports @primebrick/dal-pg.
 */

import { makeRpcRouter, type RouteHandler, type RpcRoute } from "./rpc-router.js";
import { Permission } from "../auth/permissions.js";
import type {
  DbMigrationBootOptions,
  MigrationBootState,
} from "../microservice/db-migration-step.js";
import { logger } from "../lifecycle/logger.js";

export const MIGRATION_ROUTE_PREFIX = "/api/v1/system/db-migration";

export function makeDbMigrationRouteHandler(
  boot: DbMigrationBootOptions,
  state: MigrationBootState,
): RouteHandler {
  const pool = () => boot.pool();
  const schema = () => boot.schema();

  const rerun = async (actor: string) => {
    const result = await boot.engine.runMigrations({
      pool: pool(),
      schema: schema(),
      patchesDir: boot.patchesDir,
      dbMetaDir: boot.dbMetaDir,
      allowedTrust: boot.allowedTrust ?? ["release"],
      actor,
      logger,
    });
    state.result = result;
    state.appliedCount = result.applied.length;
    state.degraded = result.degraded;
    state.lastError = result.failed[0]?.error ?? null;
    return result;
  };

  const routes: RpcRoute[] = [
    {
      method: "GET",
      path: `${MIGRATION_ROUTE_PREFIX}/status`,
      auth: "user",
      permissions: [Permission.AUTHENTICATED_ADMIN],
      openapi: { summary: "DB migration registry + boot status for this service" },
      handler: async () => ({
        service_schema: schema(),
        degraded: state.degraded,
        last_error: state.lastError,
        boot_result: state.result,
        patches: await boot.engine.registryStatus(pool(), schema()),
      }),
    },
    {
      method: "POST",
      path: `${MIGRATION_ROUTE_PREFIX}/retry`,
      auth: "user",
      permissions: [Permission.AUTHENTICATED_ADMIN],
      openapi: { summary: "Reset failed patches to pending and re-run migrations" },
      handler: async (ctx) => {
        const actor = `admin:${ctx.user?.id ?? "unknown"}`;
        const flipped = await boot.engine.retryFailedPatches(pool(), schema(), actor);
        logger.warn(
          `db-migration: admin retry requested — ${flipped} failed patch(es) reset to pending`,
          { tags: ["db-migration"] },
        );
        return { retried: flipped, result: await rerun(actor) };
      },
    },
    {
      method: "POST",
      path: `${MIGRATION_ROUTE_PREFIX}/approve`,
      auth: "user",
      permissions: [Permission.AUTHENTICATED_ADMIN],
      openapi: { summary: "Approve a pending_review patch and re-run migrations" },
      body: (raw): { patch_name: string; note?: string } => {
        const b = raw as { patch_name?: string; note?: string };
        if (!b?.patch_name || typeof b.patch_name !== "string") {
          throw new Error("patch_name required");
        }
        return { patch_name: b.patch_name, note: b.note };
      },
      handler: async (ctx) => {
        const actor = `admin:${ctx.user?.id ?? "unknown"}`;
        const body = ctx.body as { patch_name: string; note?: string };
        const ok = await boot.engine.approvePendingReview(
          pool(),
          schema(),
          body.patch_name,
          actor,
          body.note,
        );
        if (!ok) {
          return { approved: false, detail: `no pending_review patch named '${body.patch_name}'` };
        }
        logger.warn(`db-migration: admin approved ${body.patch_name}`, { tags: ["db-migration"] });
        return { approved: true, result: await rerun(actor) };
      },
    },
    {
      method: "POST",
      path: `${MIGRATION_ROUTE_PREFIX}/resolve`,
      auth: "user",
      permissions: [Permission.AUTHENTICATED_ADMIN],
      openapi: { summary: "Mark a failed/pending patch resolved_manual (escape hatch)" },
      body: (raw): { patch_name: string; note?: string } => {
        const b = raw as { patch_name?: string; note?: string };
        if (!b?.patch_name || typeof b.patch_name !== "string") {
          throw new Error("patch_name required");
        }
        return { patch_name: b.patch_name, note: b.note ?? "resolved manually" };
      },
      handler: async (ctx) => {
        const actor = `admin:${ctx.user?.id ?? "unknown"}`;
        const body = ctx.body as { patch_name: string; note?: string };
        const ok = await boot.engine.resolveManually(
          pool(),
          schema(),
          body.patch_name,
          actor,
          body.note ?? "",
        );
        if (!ok) {
          return { resolved: false, detail: `no failed/pending patch named '${body.patch_name}'` };
        }
        logger.warn(`db-migration: admin marked ${body.patch_name} resolved_manual`, {
          tags: ["db-migration"],
        });
        return { resolved: true, result: await rerun(actor) };
      },
    },
    {
      method: "POST",
      path: `${MIGRATION_ROUTE_PREFIX}/drift-check`,
      auth: "user",
      permissions: [Permission.AUTHENTICATED_ADMIN],
      openapi: { summary: "On-demand entity-vs-catalog drift check" },
      handler: async () => {
        if (!boot.entityRegistry || boot.entityRegistry.length === 0) {
          return { checked: false, detail: "service did not declare an entityRegistry" };
        }
        const diff = await boot.engine.checkDrift(boot.entityRegistry, pool());
        return { checked: true, clean: boot.engine.isDriftClean(diff), diff };
      },
    },
  ];

  return makeRpcRouter(routes);
}

/**
 * Session context propagation via `AsyncLocalStorage`.
 *
 * Why this exists:
 *   Passing the authenticated actor (UUID, roles, ...) through every DAL
 *   method signature pollutes business APIs and makes refactors painful.
 *   `AsyncLocalStorage` lets the auth middleware *implicitly* hand the session
 *   down to any code running on the same async chain, exactly like Express'
 *   request-scoped state but without manual plumbing.
 *
 * Usage from router (set automatically by auth middleware):
 *   // nothing to do — `req.user` is mirrored to ALS already.
 *
 * Usage from DAL / repo / services (read):
 *   import { requireActor } from "@primebrick/sdk";
 *   await this.repo.update(CustomerEntity, uuid, body, requireActor());
 *
 * Usage from non-HTTP code (seeds, scripts, jobs):
 *   import { runAsSystem } from "@primebrick/sdk";
 *   await runAsSystem(() => dal.seedIfEmpty());
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Session payload carried per HTTP request. Mirrors the relevant subset of
 * `AuthUser` plus future-proofing room (e.g. tenantId, requestId, locale).
 *
 * Kept intentionally minimal & immutable: callers should treat it as read-only.
 */
export interface Session {
  /**
   * Internal Primebrick UUID of the authenticated user. Used as the value
   * stored in audit columns (`created_by`, `updated_by`, `deleted_by`, ...).
   *
   * The literal string `"system"` is reserved for non-HTTP execution paths
   * (database seeds, scheduled jobs, migrations, system API keys) and is only
   * set via `runAsSystem()`.
   */
  actor: string;

  /**
   * Roles attached to the user / job, useful for low-level RBAC decisions
   * inside services. May be empty for `"system"` callers.
   */
  roles: readonly string[];

  /** Original IDP `sub` for traceability. `null` for `"system"`. */
  idpCode: string | null;

  /** IDP organization (from `owner` or `organization` claim). `null` for `"system"`. */
  idpOrg: string | null;

  /** IDP username (from `name`, `username`, or `preferred_username` claim). `null` for `"system"`. */
  idpUsername: string | null;

  /** Email verification status from IDP. `null` for `"system"`. */
  isVerified?: boolean;

  /** Email verification status (email-specific). `null` for `"system"`. */
  emailVerified?: boolean;

  /** IDP issuer URL (from `iss` claim). `null` for `"system"`. */
  issuer?: string;
}

const als = new AsyncLocalStorage<Session>();

/**
 * Run `fn` with the given session attached to the current async chain.
 *
 * Prefer the higher-level `runAsSystem()` / the auth middleware over calling
 * this directly, unless you are writing infrastructure code.
 */
export function runWithSession<T>(session: Session, fn: () => T): T {
  return als.run(session, fn);
}

/**
 * Read the current session, or `undefined` when called from outside any
 * `als.run()` scope (e.g. before the auth middleware, or in a top-level
 * script).
 */
export function getSession(): Session | undefined {
  return als.getStore();
}

/**
 * Read the current actor (UUID or `"system"`). Throws if no session is in
 * scope — meaning the caller forgot to wrap the code in `runAsSystem()` or
 * is running before the auth middleware.
 */
export function requireActor(): string {
  const s = als.getStore();
  if (!s || !s.actor) {
    throw new Error(
      "[auth] No session in scope: requireActor() called outside an HTTP " +
        "request and outside runAsSystem(). Wrap the call in runAsSystem(...) " +
        "or ensure the auth middleware ran first.",
    );
  }
  return s.actor;
}

/**
 * Sentinel actor used by non-HTTP code paths (seeds, migrations, scheduled
 * jobs, system API keys). Audit columns will record the literal string
 * `"system"` so it is trivially distinguishable from any user UUID.
 */
export const SYSTEM_ACTOR = "system";

/**
 * Run `fn` with a synthetic "system" session in scope. The only legitimate
 * use cases are bootstrap scripts (seeds, migrations) and well-isolated
 * background jobs that have no real authenticated user.
 *
 * Do NOT use this from inside an HTTP handler to bypass auth.
 */
export function runAsSystem<T>(fn: () => T): T {
  return runWithSession(
    { actor: SYSTEM_ACTOR, roles: [], idpCode: null, idpOrg: null, idpUsername: null },
    fn,
  );
}

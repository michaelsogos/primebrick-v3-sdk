/**
 * RBAC enforcement wrappers — throw on denial.
 *
 * These are convenience functions that call checkRbac() and throw RbacDeniedError
 * if the user is not allowed. Used by HTTP route handlers and NATS subscribers.
 */

import type { AuthUser } from "./types.js";
import { checkRbac } from "./rbac.js";

/** Error thrown when RBAC check fails. */
export class RbacDeniedError extends Error {
  constructor(
    public missing: string[],
    public required: readonly string[],
  ) {
    super("RBAC_PERMISSION_DENIED: missing " + missing.join(", "));
    this.name = "RbacDeniedError";
  }
}

/**
 * Enforce RBAC for an HTTP request. Throws RbacDeniedError on denial.
 *
 * @param user - The authenticated AuthUser
 * @param requiredPermissions - List of accepted permissions for this endpoint
 * @param mode - "any" (OR, default) or "all" (AND)
 */
export function enforceHttpRbac(
  user: AuthUser,
  requiredPermissions: readonly string[],
  mode?: "any" | "all",
): void {
  const result = checkRbac(user, requiredPermissions, mode);
  if (!result.allowed) {
    throw new RbacDeniedError(result.missing || [], requiredPermissions);
  }
}

/**
 * Enforce RBAC for a NATS message. Throws RbacDeniedError on denial.
 * Same logic as enforceHttpRbac — separated for semantic clarity.
 */
export function enforceNatsRbac(
  user: AuthUser,
  requiredPermissions: readonly string[],
  mode?: "any" | "all",
): void {
  const result = checkRbac(user, requiredPermissions, mode);
  if (!result.allowed) {
    throw new RbacDeniedError(result.missing || [], requiredPermissions);
  }
}

/**
 * Framework-agnostic RBAC evaluation.
 *
 * Evaluates whether an authenticated user is allowed to access an endpoint
 * that requires one of the given permissions (OR semantics by default).
 *
 * Sentinel handling:
 *   - Permission.PUBLIC             → always allowed
 *   - Permission.AUTHENTICATED_USER → allowed if user is authenticated
 *   - user.isAdmin                  → bypasses all permission checks
 *   - user.isSystem                 → bypasses all permission checks (system API key)
 */

import type { AuthUser } from "./types.js";
import { isPermissionSentinel, isPermissionGranted, Permission } from "./permissions.js";

export interface RbacResult {
  allowed: boolean;
  /** Missing permissions (only populated when not allowed) */
  missing?: string[];
}

/**
 * Evaluate RBAC for a user against a list of required permissions.
 *
 * @param user - The authenticated AuthUser
 * @param requiredPermissions - List of accepted permissions for this endpoint
 * @param mode - "any" (OR, default) or "all" (AND)
 */
export function checkRbac(
  user: AuthUser,
  requiredPermissions: readonly string[],
  mode: "any" | "all" = "any",
): RbacResult {
  // Sentinel: PUBLIC → always allowed
  if (requiredPermissions.includes(Permission.PUBLIC)) {
    return { allowed: true };
  }

  // Sentinel: AUTHENTICATED_USER → allowed if user is authenticated
  if (requiredPermissions.includes(Permission.AUTHENTICATED_USER)) {
    return { allowed: true };
  }

  // Admin bypass
  if (user.isAdmin) {
    return { allowed: true };
  }

  // System bypass (system API keys)
  if (user.isSystem) {
    return { allowed: true };
  }

  // Filter out sentinels — they were already checked above
  const realPerms = requiredPermissions.filter((p) => !isPermissionSentinel(p));
  if (realPerms.length === 0) {
    return { allowed: true };
  }

  if (mode === "all") {
    const missing = realPerms.filter((p) => !isPermissionGranted(user.permissions, p));
    return missing.length === 0 ? { allowed: true } : { allowed: false, missing };
  }

  // OR mode (default)
  const passes = realPerms.some((p) => isPermissionGranted(user.permissions, p));
  return passes ? { allowed: true } : { allowed: false, missing: realPerms };
}

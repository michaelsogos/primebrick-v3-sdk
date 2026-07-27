/**
 * RBAC registry — single source of truth for permissions and role mappings.
 *
 * Design:
 *   - Each HTTP action declares the EXACT permission(s) it requires
 *     (e.g. `customers.read.all`, `emailsender.providers.create`). The endpoint,
 *     not the role, determines what is needed.
 *   - Role → Permission mappings are stored in the `role_mappings` table (database).
 *     The auth middleware loads these mappings at startup and expands a user's
 *     roles into a flat `Set<Permission>` once per request.
 *   - The RBAC middleware evaluates the array with **OR** semantics by default
 *     (any-of). Use `rbacHandler.all([...])` for AND semantics.
 *   - Roles marked with `is_admin=true` in the database grant ALL permissions
 *     (super-user wildcard).
 *   - API keys marked with `is_system=true` bypass all permission checks
 *     and set the actor to "system" for audit fields.
 *
 * Three pseudo-permissions exist as sentinels handled directly by the middleware
 * (they are NOT stored in `role_mappings`):
 *
 *   - `Permission.PUBLIC`             → endpoint reachable without a JWT.
 *   - `Permission.AUTHENTICATED_USER` → any caller with a valid identity
 *                                       passes, regardless of roles.
 *   - `Permission.AUTHENTICATED_ADMIN`→ only callers with `isAdmin === true`
 *                                       pass. Use for high-risk non-CRUD
 *                                       operations (e.g. admin change-password).
 */

export const Permission = {
  // --- Sentinels (not mapped to any role; handled by rbac middleware) ---
  /** Endpoint reachable anonymously. STILL requires gateway-secret in GATEWAY mode. */
  PUBLIC: "_public",
  /** Any caller whose identity has been authenticated, regardless of roles. */
  AUTHENTICATED_USER: "_authenticated_user",
  /** Only callers with `isAdmin === true` pass. Use for high-risk non-CRUD admin-only operations. */
  AUTHENTICATED_ADMIN: "_authenticated_admin",

  // --- System / cross-module ---
  MODULES_READ_ALL: "modules.read.all",
  MODULES_READ_SINGLE: "modules.read.single",
  MODULES_UPDATE: "modules.update.single",
  MODULES_DELETE: "modules.delete.single",
  MODULES_CONFIG_READ: "modules.config.read",
  MODULES_CONFIG_UPDATE: "modules.config.update",

  // --- Settings / Profile module ---
  PROFILE_READ: "profile.read",
  PROFILE_UPDATE: "profile.update",
  USER_PROFILE_READ_AUDIT: "userprofile.read.audit",

  // --- Users module (admin) ---
  USERS_READ_ALL: "users.read.all",
  USERS_READ_SINGLE: "users.read.single",
  USERS_CREATE_SINGLE: "users.create.single",
  USERS_UPDATE_SINGLE: "users.update.single",
  USERS_DELETE_SINGLE: "users.delete.single",
  USERS_RESTORE_SINGLE: "users.restore.single",

  // --- Auth events (audit log entity — read-only, no CRUD via MCP) ---
  AUTH_EVENTS_READ_ALL: "auth_events.read.all",

  // --- Organizations module (admin) ---
  ORGANIZATIONS_READ_ALL: "organizations.read.all",
  ORGANIZATIONS_READ_SINGLE: "organizations.read.single",
  ORGANIZATIONS_READ_AUDIT: "organizations.read.audit",
  ORGANIZATIONS_CREATE_SINGLE: "organizations.create.single",
  ORGANIZATIONS_UPDATE_SINGLE: "organizations.update.single",
  ORGANIZATIONS_DELETE_SINGLE: "organizations.delete.single",
  ORGANIZATIONS_RESTORE_SINGLE: "organizations.restore.single",

  // --- Customers module ---
  CUSTOMERS_READ_ALL: "customers.read.all",
  CUSTOMERS_READ_SINGLE: "customers.read.single",
  CUSTOMERS_READ_AUDIT: "customers.read.audit",
  CUSTOMERS_CREATE_SINGLE: "customers.create.single",
  CUSTOMERS_CREATE_BULK: "customers.create.bulk",
  CUSTOMERS_UPDATE_SINGLE: "customers.update.single",
  CUSTOMERS_UPDATE_BULK: "customers.update.bulk",
  CUSTOMERS_DELETE_SINGLE: "customers.delete.single",
  CUSTOMERS_DELETE_BULK: "customers.delete.bulk",
  CUSTOMERS_RESTORE_SINGLE: "customers.restore.single",
  CUSTOMERS_RESTORE_BULK: "customers.restore.bulk",
  CUSTOMERS_DUPLICATE_BULK: "customers.duplicate.bulk",
  CUSTOMERS_EXPORT: "customers.export",

  // --- Emailsender / Providers module ---
  EMAILSENDER_PROVIDERS_READ_ALL: "emailsender.providers.read.all",
  EMAILSENDER_PROVIDERS_READ_SINGLE: "emailsender.providers.read.single",
  EMAILSENDER_PROVIDERS_CREATE: "emailsender.providers.create",
  EMAILSENDER_PROVIDERS_UPDATE: "emailsender.providers.update",
  EMAILSENDER_PROVIDERS_DELETE: "emailsender.providers.delete",
  EMAILSENDER_SEND: "emailsender.send",
  EMAILSENDER_LOG_CREATE: "emailsender.log.create",

  // --- Role mappings module (admin) ---
  ROLE_MAPPINGS_READ_ALL: "role_mappings.read.all",
  ROLE_MAPPINGS_READ_SINGLE: "role_mappings.read.single",
  ROLE_MAPPINGS_READ_AUDIT: "role_mappings.read.audit",
  ROLE_MAPPINGS_CREATE: "role_mappings.create",
  ROLE_MAPPINGS_UPDATE: "role_mappings.update",
  ROLE_MAPPINGS_DELETE: "role_mappings.delete",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * `true` when the given permission is a sentinel (PUBLIC / AUTHENTICATED_USER /
 * AUTHENTICATED_ADMIN) handled directly by the rbac middleware rather than by
 * role expansion.
 */
export function isPermissionSentinel(p: string): boolean {
  return (
    p === Permission.PUBLIC ||
    p === Permission.AUTHENTICATED_USER ||
    p === Permission.AUTHENTICATED_ADMIN
  );
}

/**
 * Returns all non-sentinel permission strings (i.e. the real RBAC permissions,
 * excluding PUBLIC / AUTHENTICATED_USER / AUTHENTICATED_ADMIN).
 * Used by the BE to build the permissions catalog for the FE role-management UI.
 */
export function listNonSentinelPermissions(): string[] {
  return Object.values(Permission).filter((p) => !isPermissionSentinel(p));
}

/**
 * Convert a wildcard pattern to a regex for matching.
 * Supports * wildcard only (no ? or character classes for simplicity).
 * Example: "customers.read.*" → /^customers\.read\..*$/
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const wildcardPattern = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${wildcardPattern}$`);
}

/**
 * Check if a permission string matches a pattern (supports * wildcard).
 * @param pattern - Pattern with optional * wildcard (e.g., "customers.read.*")
 * @param permission - Permission string to match (e.g., "customers.read.single")
 * @returns true if permission matches pattern
 */
export function matchesWildcard(pattern: string, permission: string): boolean {
  if (!pattern.includes("*")) {
    // No wildcard - exact match
    return pattern === permission;
  }
  const regex = wildcardToRegex(pattern);
  return regex.test(permission);
}

/**
 * Check if a permission is granted given a set of user permissions.
 * Supports wildcard patterns in user permissions.
 * @param userPermissions - Set of permissions granted to user (may contain wildcards)
 * @param requiredPermission - Permission required by the endpoint
 * @returns true if permission is granted
 */
export function isPermissionGranted(userPermissions: Set<string>, requiredPermission: string): boolean {
  // Check exact match first (fast path)
  if (userPermissions.has(requiredPermission)) {
    return true;
  }

  // Check wildcard patterns
  for (const userPerm of userPermissions) {
    if (userPerm.includes("*") && matchesWildcard(userPerm, requiredPermission)) {
      return true;
    }
  }

  return false;
}

/**
 * Expand a list of role names into patterns and admin status.
 * This function queries the `role_mappings` table to resolve roles to permissions.
 * Roles marked with `is_admin=true` bypass all permission checks.
 *
 * @param roles - Role names from the IDP (as extracted from JWT via roles_path)
 * @param getRoleMappingFn - Function that returns the mapping for a specific role
 * @returns Object with patterns array and isAdmin flag
 */
export async function expandPermissions(
  roles: readonly string[],
  getRoleMappingFn: (role: string) => Promise<{ permissions: string[]; is_admin: boolean } | null>,
): Promise<{ patterns: string[]; isAdmin: boolean }> {
  const patterns = new Set<string>();
  let isAdmin = false;

  for (const r of roles) {
    const mapping = await getRoleMappingFn(r);
    if (!mapping) continue;

    // If any role is admin, set isAdmin flag
    if (mapping.is_admin) {
      isAdmin = true;
    }

    // Add all patterns from this role (ignored if isAdmin=true, but we collect them anyway)
    for (const p of mapping.permissions) patterns.add(p);
  }

  return { patterns: Array.from(patterns), isAdmin };
}

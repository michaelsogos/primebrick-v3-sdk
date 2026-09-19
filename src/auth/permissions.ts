/**
 * RBAC registry — single source of truth for permissions and role mappings.
 *
 * Design:
 *   - Each HTTP action declares the EXACT permission(s) it requires
 *     (e.g. `customer.read.all`, `emailsender.provider.create.single`). The endpoint,
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

  // --- Core / non-entity namespaces ---
  // Modules service-registry (not entity CRUD — populated by NATS registration).
  MODULES_READ_ALL: "modules.read.all",
  MODULES_READ_SINGLE: "modules.read.single",
  MODULES_UPDATE_SINGLE: "modules.update.single",
  MODULES_DELETE_SINGLE: "modules.delete.single",
  // Module config_entry sub-entity (core concept shared by every module).
  // Scope `modules.config` — per-module config object → single cardinality.
  MODULES_CONFIG_READ_SINGLE: "modules.config.read.single",
  MODULES_CONFIG_UPDATE_SINGLE: "modules.config.update.single",

  // --- Entity permission sets ---
  // Grammar: {scope}.{action}.{cardinality}
  //   scope       = entity path segment, snake_case SINGULAR (the object granted
  //                 on, never the collection). Microservice entities are
  //                 module-prefixed: {module}.{entity}.
  //   ROPs (read) = read.single | read.all | read.audit | export (no qualifier)
  //   WOPs (write)= create|update|delete|restore|duplicate . single|bulk
  // Every CRUD entity owns the canonical 14-permission set — permissions exist
  // in the registry even when no endpoint uses them yet (admin-gating is a
  // temporary enforcement posture, not a reason to skip the permission).
  // Const names are mechanical: CONST = string.toUpperCase().replaceAll(".", "_").

  // --- auth_event (audit log entity) ---
  AUTH_EVENT_READ_ALL: "auth_event.read.all",
  AUTH_EVENT_READ_SINGLE: "auth_event.read.single",
  AUTH_EVENT_READ_AUDIT: "auth_event.read.audit",
  AUTH_EVENT_EXPORT: "auth_event.export",
  AUTH_EVENT_CREATE_SINGLE: "auth_event.create.single",
  AUTH_EVENT_CREATE_BULK: "auth_event.create.bulk",
  AUTH_EVENT_UPDATE_SINGLE: "auth_event.update.single",
  AUTH_EVENT_UPDATE_BULK: "auth_event.update.bulk",
  AUTH_EVENT_DELETE_SINGLE: "auth_event.delete.single",
  AUTH_EVENT_DELETE_BULK: "auth_event.delete.bulk",
  AUTH_EVENT_RESTORE_SINGLE: "auth_event.restore.single",
  AUTH_EVENT_RESTORE_BULK: "auth_event.restore.bulk",
  AUTH_EVENT_DUPLICATE_SINGLE: "auth_event.duplicate.single",
  AUTH_EVENT_DUPLICATE_BULK: "auth_event.duplicate.bulk",

  // --- customer ---
  CUSTOMER_READ_ALL: "customer.read.all",
  CUSTOMER_READ_SINGLE: "customer.read.single",
  CUSTOMER_READ_AUDIT: "customer.read.audit",
  CUSTOMER_EXPORT: "customer.export",
  CUSTOMER_CREATE_SINGLE: "customer.create.single",
  CUSTOMER_CREATE_BULK: "customer.create.bulk",
  CUSTOMER_UPDATE_SINGLE: "customer.update.single",
  CUSTOMER_UPDATE_BULK: "customer.update.bulk",
  CUSTOMER_DELETE_SINGLE: "customer.delete.single",
  CUSTOMER_DELETE_BULK: "customer.delete.bulk",
  CUSTOMER_RESTORE_SINGLE: "customer.restore.single",
  CUSTOMER_RESTORE_BULK: "customer.restore.bulk",
  CUSTOMER_DUPLICATE_SINGLE: "customer.duplicate.single",
  CUSTOMER_DUPLICATE_BULK: "customer.duplicate.bulk",

  // --- organization ---
  ORGANIZATION_READ_ALL: "organization.read.all",
  ORGANIZATION_READ_SINGLE: "organization.read.single",
  ORGANIZATION_READ_AUDIT: "organization.read.audit",
  ORGANIZATION_EXPORT: "organization.export",
  ORGANIZATION_CREATE_SINGLE: "organization.create.single",
  ORGANIZATION_CREATE_BULK: "organization.create.bulk",
  ORGANIZATION_UPDATE_SINGLE: "organization.update.single",
  ORGANIZATION_UPDATE_BULK: "organization.update.bulk",
  ORGANIZATION_DELETE_SINGLE: "organization.delete.single",
  ORGANIZATION_DELETE_BULK: "organization.delete.bulk",
  ORGANIZATION_RESTORE_SINGLE: "organization.restore.single",
  ORGANIZATION_RESTORE_BULK: "organization.restore.bulk",
  ORGANIZATION_DUPLICATE_SINGLE: "organization.duplicate.single",
  ORGANIZATION_DUPLICATE_BULK: "organization.duplicate.bulk",

  // --- role_mapping (admin) ---
  ROLE_MAPPING_READ_ALL: "role_mapping.read.all",
  ROLE_MAPPING_READ_SINGLE: "role_mapping.read.single",
  ROLE_MAPPING_READ_AUDIT: "role_mapping.read.audit",
  ROLE_MAPPING_EXPORT: "role_mapping.export",
  ROLE_MAPPING_CREATE_SINGLE: "role_mapping.create.single",
  ROLE_MAPPING_CREATE_BULK: "role_mapping.create.bulk",
  ROLE_MAPPING_UPDATE_SINGLE: "role_mapping.update.single",
  ROLE_MAPPING_UPDATE_BULK: "role_mapping.update.bulk",
  ROLE_MAPPING_DELETE_SINGLE: "role_mapping.delete.single",
  ROLE_MAPPING_DELETE_BULK: "role_mapping.delete.bulk",
  ROLE_MAPPING_RESTORE_SINGLE: "role_mapping.restore.single",
  ROLE_MAPPING_RESTORE_BULK: "role_mapping.restore.bulk",
  ROLE_MAPPING_DUPLICATE_SINGLE: "role_mapping.duplicate.single",
  ROLE_MAPPING_DUPLICATE_BULK: "role_mapping.duplicate.bulk",

  // --- translation (admin, per-module schemas via ?module= query param) ---
  TRANSLATION_READ_ALL: "translation.read.all",
  TRANSLATION_READ_SINGLE: "translation.read.single",
  TRANSLATION_READ_AUDIT: "translation.read.audit",
  TRANSLATION_EXPORT: "translation.export",
  TRANSLATION_CREATE_SINGLE: "translation.create.single",
  TRANSLATION_CREATE_BULK: "translation.create.bulk",
  TRANSLATION_UPDATE_SINGLE: "translation.update.single",
  TRANSLATION_UPDATE_BULK: "translation.update.bulk",
  TRANSLATION_DELETE_SINGLE: "translation.delete.single",
  TRANSLATION_DELETE_BULK: "translation.delete.bulk",
  TRANSLATION_RESTORE_SINGLE: "translation.restore.single",
  TRANSLATION_RESTORE_BULK: "translation.restore.bulk",
  TRANSLATION_DUPLICATE_SINGLE: "translation.duplicate.single",
  TRANSLATION_DUPLICATE_BULK: "translation.duplicate.bulk",

  // --- user_profile ---
  USER_PROFILE_READ_ALL: "user_profile.read.all",
  USER_PROFILE_READ_SINGLE: "user_profile.read.single",
  USER_PROFILE_READ_AUDIT: "user_profile.read.audit",
  USER_PROFILE_EXPORT: "user_profile.export",
  USER_PROFILE_CREATE_SINGLE: "user_profile.create.single",
  USER_PROFILE_CREATE_BULK: "user_profile.create.bulk",
  USER_PROFILE_UPDATE_SINGLE: "user_profile.update.single",
  USER_PROFILE_UPDATE_BULK: "user_profile.update.bulk",
  USER_PROFILE_DELETE_SINGLE: "user_profile.delete.single",
  USER_PROFILE_DELETE_BULK: "user_profile.delete.bulk",
  USER_PROFILE_RESTORE_SINGLE: "user_profile.restore.single",
  USER_PROFILE_RESTORE_BULK: "user_profile.restore.bulk",
  USER_PROFILE_DUPLICATE_SINGLE: "user_profile.duplicate.single",
  USER_PROFILE_DUPLICATE_BULK: "user_profile.duplicate.bulk",

  // --- emailsender.provider (microservice entity — module-prefixed scope) ---
  EMAILSENDER_PROVIDER_READ_ALL: "emailsender.provider.read.all",
  EMAILSENDER_PROVIDER_READ_SINGLE: "emailsender.provider.read.single",
  EMAILSENDER_PROVIDER_READ_AUDIT: "emailsender.provider.read.audit",
  EMAILSENDER_PROVIDER_EXPORT: "emailsender.provider.export",
  EMAILSENDER_PROVIDER_CREATE_SINGLE: "emailsender.provider.create.single",
  EMAILSENDER_PROVIDER_CREATE_BULK: "emailsender.provider.create.bulk",
  EMAILSENDER_PROVIDER_UPDATE_SINGLE: "emailsender.provider.update.single",
  EMAILSENDER_PROVIDER_UPDATE_BULK: "emailsender.provider.update.bulk",
  EMAILSENDER_PROVIDER_DELETE_SINGLE: "emailsender.provider.delete.single",
  EMAILSENDER_PROVIDER_DELETE_BULK: "emailsender.provider.delete.bulk",
  EMAILSENDER_PROVIDER_RESTORE_SINGLE: "emailsender.provider.restore.single",
  EMAILSENDER_PROVIDER_RESTORE_BULK: "emailsender.provider.restore.bulk",
  EMAILSENDER_PROVIDER_DUPLICATE_SINGLE: "emailsender.provider.duplicate.single",
  EMAILSENDER_PROVIDER_DUPLICATE_BULK: "emailsender.provider.duplicate.bulk",

  // --- Action permissions (non-entity, module-scoped verbs) ---
  // Service action (Category-2 endpoint) — verb-form scope, qualifier-free
  // by grammar extension: a bare `{scope}.{action}` is legal only when
  // `action` is NOT a reserved entity op (read/create/update/delete/restore/
  // duplicate/export) — those always require a qualifier.
  EMAILSENDER_SEND: "emailsender.send",
  EMAILSENDER_LOG_CREATE_SINGLE: "emailsender.log.create.single",
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
 * Example: "customer.read.*" → /^customer\.read\..*$/
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const wildcardPattern = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${wildcardPattern}$`);
}

/**
 * Check if a permission string matches a pattern (supports * wildcard).
 * @param pattern - Pattern with optional * wildcard (e.g., "customer.read.*")
 * @param permission - Permission string to match (e.g., "customer.read.single")
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

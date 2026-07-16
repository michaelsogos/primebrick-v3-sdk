/**
 * IDP-agnostic token payload normalization.
 *
 * Different identity providers represent roles in different shapes:
 *   - Casdoor / Microsoft Entra:  `roles: ["admin", "user"]`
 *   - Keycloak (realm):           `realm_access.roles: ["admin"]`
 *   - Keycloak (client):          `resource_access.<client>.roles: ["admin"]`
 *   - Some IDPs:                  `roles: [{ name: "admin" }, { name: "user" }]`
 *
 * `normalizeIdpToken` reads a single config-driven path (`roles_path`) and
 * coerces whatever it finds into a flat `string[]` so the rest of the system
 * can stay dumb-and-portable.
 */

import type { AuthUser } from "./types.js";

/** Minimal shape of a decoded JWT payload (claims map). */
export type JwtClaims = Record<string, unknown>;

/**
 * Walk a dotted path (e.g. `"realm_access.roles"`) into an arbitrary object.
 * Returns `undefined` if any intermediate segment is missing.
 */
function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Coerce any role payload shape into a clean array of strings.
 * - Strings stay as-is (after String() coercion)
 * - Objects with a `name` field are reduced to that name
 * - Anything else is stringified
 * - Empty / non-array inputs become `[]`
 */
export function coerceRoles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (r && typeof r === "object" && "name" in r) {
        const name = (r as { name?: unknown }).name;
        return name == null ? "" : String(name);
      }
      return r == null ? "" : String(r);
    })
    .filter((s) => s.length > 0);
}

export interface NormalizedIdpUser {
  /** IDP subject (JWT `sub`). Stable per-user IDP identifier. */
  idp_code: string;
  email: string | null;
  name: string | null;
  roles: string[];
  /** IDP organization (from `owner` or `organization` claim) */
  idp_org: string | null;
  /** IDP username (from `name`, `username`, or `preferred_username` claim) */
  idp_username: string | null;
}

/**
 * Build a normalized user shape from a JWT payload using a configurable
 * roles path. Throws on empty payload or missing `sub` claim.
 */
export function normalizeIdpToken(
  payload: JwtClaims | null | undefined,
  rolesPath: string,
): NormalizedIdpUser {
  if (!payload || typeof payload !== "object") {
    throw new Error("[auth] empty token payload");
  }

  const sub = payload["sub"];
  if (!sub || typeof sub !== "string") {
    throw new Error("[auth] token payload missing required `sub` claim");
  }

  const rawRoles = readPath(payload, rolesPath);
  const roles = coerceRoles(rawRoles);

  const email = typeof payload["email"] === "string" ? (payload["email"] as string) : null;
  const preferredUsername = typeof payload["preferred_username"] === "string"
    ? (payload["preferred_username"] as string)
    : null;
  const nameClaim = typeof payload["name"] === "string" ? (payload["name"] as string) : null;
  const usernameClaim = typeof payload["username"] === "string" ? (payload["username"] as string) : null;
  const ownerClaim = typeof payload["owner"] === "string" ? (payload["owner"] as string) : null;
  const organizationClaim = typeof payload["organization"] === "string" ? (payload["organization"] as string) : null;

  const idp_org = ownerClaim ?? organizationClaim;
  const idp_username = nameClaim ?? usernameClaim ?? preferredUsername;
  // MUST use ONLY JWT sub (UUID) as idp_code - NO fallback logic
  const idp_code = sub;

  return {
    idp_code,
    email,
    name: nameClaim ?? preferredUsername,
    roles,
    idp_org,
    idp_username,
  };
}

/**
 * Combine a normalized IDP user with the internal Primebrick UUID.
 * Permissions are NOT computed here - they are computed separately using
 * the database-driven role mapping.
 *
 * Note: `id` here is the **internal** UUID from `user_profiles.uuid`, NEVER
 * the IDP `sub`. The mapping is performed by the UserResolverPort.
 */
export function buildAuthUser(
  internalUuid: string,
  normalized: NormalizedIdpUser,
  permissions: Set<string>,
  isAdmin: boolean,
): AuthUser {
  return {
    id: internalUuid,
    idp_code: normalized.idp_code,
    email: normalized.email,
    name: normalized.name,
    roles: normalized.roles,
    permissions,
    isAdmin,
    isSystem: false,
    idp_org: normalized.idp_org,
    idp_username: normalized.idp_username,
  };
}

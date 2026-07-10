/**
 * AuthUser serialization/deserialization for GATEWAY-RESOLVED mode.
 *
 * The BE (STANDALONE mode) resolves the full AuthUser (internal UUID, expanded
 * permissions, roles, etc.) and serializes it into headers. Microservices
 * (GATEWAY-RESOLVED mode) deserialize the AuthUser from headers — no DB
 * queries, no ports, no cross-schema access.
 *
 * Header names are configurable via AuthConfig.gateway.headers, but default
 * to a standard set. The gateway secret header is always added for
 * anti-spoofing.
 */

import type { HeaderProvider } from "./header-provider.js";
import type { AuthConfig, AuthUser } from "./types.js";

/** Default header names for AuthUser fields. */
const DEFAULT_HEADER_NAMES = {
  user_id: "x-user-id",
  email: "x-user-email",
  name: "x-user-name",
  roles: "x-user-roles",
  idp_code: "x-user-idp-code",
  idp_org: "x-user-idp-org",
  idp_username: "x-user-idp-username",
  permissions: "x-user-permissions",
  is_admin: "x-user-is-admin",
  is_system: "x-user-is-system",
} as const;

/**
 * Serialize a fully resolved AuthUser into a headers object for forwarding
 * to microservices (HTTP proxy or NATS). Also includes the gateway secret
 * header for anti-spoofing.
 */
export function serializeAuthUserToHeaders(
  user: AuthUser,
  config: AuthConfig,
): Record<string, string> {
  const h = config.gateway.headers;
  const names = {
    user_id: h.user_id ?? DEFAULT_HEADER_NAMES.user_id,
    email: h.email ?? DEFAULT_HEADER_NAMES.email,
    name: h.name ?? DEFAULT_HEADER_NAMES.name,
    roles: h.roles ?? DEFAULT_HEADER_NAMES.roles,
    idp_code: h.idp_code ?? DEFAULT_HEADER_NAMES.idp_code,
    idp_org: h.idp_org ?? DEFAULT_HEADER_NAMES.idp_org,
    idp_username: h.idp_username ?? DEFAULT_HEADER_NAMES.idp_username,
    permissions: h.permissions ?? DEFAULT_HEADER_NAMES.permissions,
    is_admin: h.is_admin ?? DEFAULT_HEADER_NAMES.is_admin,
    is_system: h.is_system ?? DEFAULT_HEADER_NAMES.is_system,
  };

  const headers: Record<string, string> = {};

  headers[names.user_id] = user.id;
  if (user.email) headers[names.email] = user.email;
  if (user.name) headers[names.name] = user.name;
  headers[names.roles] = user.roles.join(",");
  headers[names.idp_code] = user.idp_code;
  if (user.idp_org) headers[names.idp_org] = user.idp_org;
  if (user.idp_username) headers[names.idp_username] = user.idp_username;
  headers[names.permissions] = Array.from(user.permissions).join(",");
  headers[names.is_admin] = String(user.isAdmin);
  headers[names.is_system] = String(user.isSystem);

  // Gateway secret header for anti-spoofing
  if (config.gateway.secret_header_name && config.gateway.secret) {
    headers[config.gateway.secret_header_name] = config.gateway.secret;
  }

  return headers;
}

/**
 * Deserialize an AuthUser from headers (microservice side, GATEWAY-RESOLVED mode).
 * The gateway secret is verified separately by verifyAuthGatewayResolved().
 */
export function deserializeAuthUserFromHeaders(
  headers: HeaderProvider,
  config: AuthConfig,
): AuthUser {
  const h = config.gateway.headers;
  const names = {
    user_id: h.user_id ?? DEFAULT_HEADER_NAMES.user_id,
    email: h.email ?? DEFAULT_HEADER_NAMES.email,
    name: h.name ?? DEFAULT_HEADER_NAMES.name,
    roles: h.roles ?? DEFAULT_HEADER_NAMES.roles,
    idp_code: h.idp_code ?? DEFAULT_HEADER_NAMES.idp_code,
    idp_org: h.idp_org ?? DEFAULT_HEADER_NAMES.idp_org,
    idp_username: h.idp_username ?? DEFAULT_HEADER_NAMES.idp_username,
    permissions: h.permissions ?? DEFAULT_HEADER_NAMES.permissions,
    is_admin: h.is_admin ?? DEFAULT_HEADER_NAMES.is_admin,
    is_system: h.is_system ?? DEFAULT_HEADER_NAMES.is_system,
  };

  const id = headers.getHeader(names.user_id) ?? "";
  const email = headers.getHeader(names.email) ?? null;
  const name = headers.getHeader(names.name) ?? null;
  const rolesStr = headers.getHeader(names.roles) ?? "";
  const roles = rolesStr ? rolesStr.split(",").filter(Boolean) : [];
  const idpCode = headers.getHeader(names.idp_code) ?? "";
  const idpOrg = headers.getHeader(names.idp_org) ?? null;
  const idpUsername = headers.getHeader(names.idp_username) ?? null;
  const permsStr = headers.getHeader(names.permissions) ?? "";
  const permissions = new Set(permsStr ? permsStr.split(",").filter(Boolean) : []);
  const isAdmin = headers.getHeader(names.is_admin) === "true";
  const isSystem = headers.getHeader(names.is_system) === "true";

  return {
    id,
    idp_code: idpCode,
    email,
    name,
    roles,
    permissions,
    isAdmin,
    isSystem,
    idp_org: idpOrg,
    idp_username: idpUsername,
  };
}

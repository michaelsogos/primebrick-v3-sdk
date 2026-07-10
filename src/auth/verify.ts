/**
 * Core auth verification — two distinct modes:
 *
 *   STANDALONE (BE only):
 *     Verifies a JWT via OIDC discovery, resolves the IDP subject to an
 *     internal UUID via UserResolverPort, expands roles to permissions via
 *     RoleMappingPort. Needs AuthPorts.
 *
 *   GATEWAY-RESOLVED (microservices):
 *     Verifies the gateway secret header (anti-spoofing), then deserializes
 *     the pre-resolved AuthUser from headers. NO ports needed. The BE already
 *     did all the work; the microservice just trusts the result.
 */

import type { HeaderProvider } from "./header-provider.js";
import type { AuthConfig, AuthUser } from "./types.js";
import { AuthMode } from "./types.js";
import { verifyAccessToken } from "./oidc-verifier.js";
import { normalizeIdpToken, coerceRoles, buildAuthUser } from "./token-normalizer.js";
import { expandPermissions } from "./permissions.js";
import { deserializeAuthUserFromHeaders } from "./auth-user-serializer.js";
import type { ResolveInput } from "./ports/user-resolver-port.js";

/** Ports needed ONLY by BE (STANDALONE mode). Microservices do NOT provide these. */
export interface AuthPorts {
  resolveInternalUuid(input: ResolveInput): Promise<string>;
  getRoleMapping(role: string): Promise<{ permissions: string[]; is_admin: boolean } | null>;
}

/**
 * Verify auth in STANDALONE mode (BE only).
 * Needs AuthPorts (UserResolverPort + RoleMappingPort).
 */
export async function verifyAuth(
  headers: HeaderProvider,
  config: AuthConfig,
  ports: AuthPorts,
): Promise<AuthUser> {
  if (config.mode === AuthMode.GATEWAY) {
    // If a BE is configured in GATEWAY mode (reverse proxy in front),
    // it still needs to resolve the user from gateway headers.
    return verifyGatewayWithPorts(headers, config, ports);
  }
  return verifyStandalone(headers, config, ports);
}

/**
 * Verify auth in GATEWAY-RESOLVED mode (microservices).
 * NO ports needed. Just verifies gateway secret + deserializes AuthUser from headers.
 */
export async function verifyAuthGatewayResolved(
  headers: HeaderProvider,
  config: AuthConfig,
): Promise<AuthUser> {
  verifyGatewaySecret(headers, config);
  return deserializeAuthUserFromHeaders(headers, config);
}

// --- STANDALONE mode (BE only) ---

async function verifyStandalone(
  headers: HeaderProvider,
  config: AuthConfig,
  ports: AuthPorts,
): Promise<AuthUser> {
  // Extract token from Authorization: Bearer <token>
  const authHeader = headers.getHeader("authorization");
  let token = "";
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    throw new AuthError("AUTH_TOKEN_MISSING", "Authentication required - please provide a valid token via Bearer header or cookie");
  }

  let claims;
  try {
    claims = await verifyAccessToken(token, config.oidc);
  } catch {
    throw new AuthError("AUTH_TOKEN_INVALID", "Invalid or expired access token");
  }

  const normalized = normalizeIdpToken(claims, config.roles_path);
  const internalUuid = await ports.resolveInternalUuid({
    idp_code: normalized.idp_code,
    email: normalized.email,
    display_name: normalized.name,
    idp_org: normalized.idp_org,
    idp_username: normalized.idp_username,
  });
  const { patterns, isAdmin } = await expandPermissions(normalized.roles, ports.getRoleMapping);
  const user = buildAuthUser(internalUuid, normalized, new Set(patterns), isAdmin);
  user.raw_access_token = token;
  return user;
}

// --- GATEWAY mode with ports (BE in GATEWAY mode, or any service that needs to resolve from gateway headers) ---

async function verifyGatewayWithPorts(
  headers: HeaderProvider,
  config: AuthConfig,
  ports: AuthPorts,
): Promise<AuthUser> {
  verifyGatewaySecret(headers, config);

  const { headers: headerNames } = config.gateway;
  const idpCode = headers.getHeader(headerNames.idp_code!);
  if (!idpCode) {
    throw new AuthError("AUTH_GATEWAY_HEADERS_MISSING", `Missing user identity header '${headerNames.idp_code}' from gateway`);
  }

  const email = headers.getHeader(headerNames.email!) ?? null;
  const name = headers.getHeader(headerNames.name!) ?? null;
  const rawRoles = headers.getHeader(headerNames.roles!);
  const roles = rawRoles
    ? coerceRoles(rawRoles.split(",").map((s) => s.trim()).filter(Boolean))
    : [];

  const idpOrg = headers.getHeader(headerNames.idp_org!) ?? null;
  const idpUsername = headers.getHeader(headerNames.idp_username!) ?? null;
  let finalIdpOrg = idpOrg;
  let finalIdpUsername = idpUsername;
  if (!finalIdpOrg && !finalIdpUsername && idpCode.includes("/")) {
    const parts = idpCode.split("/");
    finalIdpOrg = parts[0];
    finalIdpUsername = parts[1];
  }

  const internalUuid = await ports.resolveInternalUuid({
    idp_code: idpCode,
    email,
    display_name: name,
    idp_org: finalIdpOrg,
    idp_username: finalIdpUsername,
  });
  const { patterns, isAdmin } = await expandPermissions(roles, ports.getRoleMapping);
  return buildAuthUser(
    internalUuid,
    { idp_code: idpCode, email, name, roles, idp_org: finalIdpOrg, idp_username: finalIdpUsername },
    new Set(patterns),
    isAdmin,
  );
}

// --- Shared gateway secret verification ---

function verifyGatewaySecret(headers: HeaderProvider, config: AuthConfig): void {
  const { secret, secret_header_name } = config.gateway;
  if (!secret || !secret_header_name) {
    throw new AuthError("AUTH_GATEWAY_NOT_CONFIGURED", "Gateway secret not configured");
  }
  const provided = headers.getHeader(secret_header_name);
  if (typeof provided !== "string" || provided !== secret) {
    throw new AuthError("AUTH_GATEWAY_SECRET_INVALID", "Gateway authentication failed");
  }
}

// --- Error class ---

export class AuthError extends Error {
  constructor(
    public internal_code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

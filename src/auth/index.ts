/**
 * Auth module barrel export.
 *
 * Framework-agnostic auth for HTTP + NATS. Used by BE (STANDALONE mode) and
 * microservices (GATEWAY-RESOLVED mode).
 */

// Types
export { AuthMode, type AuthMode as AuthModeType, type AuthUser, type AuthConfig, type OidcConfig, type GatewayConfig } from "./types.js";

// Header providers
export { type HeaderProvider, HttpHeaderProvider, NatsHeaderProvider } from "./header-provider.js";

// Token normalization
export { normalizeIdpToken, coerceRoles, buildAuthUser, type NormalizedIdpUser, type JwtClaims } from "./token-normalizer.js";

// OIDC verifier (STANDALONE mode only)
export { verifyAccessToken, resetOidcRuntimeForTest } from "./oidc-verifier.js";

// Permissions
export { Permission, isPermissionSentinel, listNonSentinelPermissions, matchesWildcard, isPermissionGranted, expandPermissions, type Permission as PermissionType } from "./permissions.js";

// Session context
export { runWithSession, getSession, requireActor, runAsSystem, SYSTEM_ACTOR, type Session } from "./session-context.js";

// Ports
export { type AuthConfigPort } from "./ports/auth-config-port.js";
export { type UserResolverPort, type ResolveInput } from "./ports/user-resolver-port.js";
export { type RoleMappingPort, type RoleMappingEntry } from "./ports/role-mapping-port.js";
export { type ApiKeyPort, type ApiKeyRecord } from "./ports/api-key-port.js";

// Auth config cache
export { initAuthConfig, loadAuthConfig, getAuthConfig, invalidateAuthConfig, resetAuthConfigForTest } from "./auth-config-cache.js";

// Core verification
export { verifyAuth, verifyAuthGatewayResolved, AuthError, type AuthPorts } from "./verify.js";

// HTTP wrapper
export { verifyHttpRequest } from "./verify-http.js";

// NATS wrapper
export { verifyNatsMessage, buildNatsAuthHeaders } from "./verify-nats.js";

// AuthUser serialization
export { serializeAuthUserToHeaders, deserializeAuthUserFromHeaders } from "./auth-user-serializer.js";

// RBAC
export { checkRbac, type RbacResult } from "./rbac.js";
export { enforceHttpRbac, enforceNatsRbac, RbacDeniedError } from "./rbac-enforce.js";

// API key
export { verifyApiKey } from "./verify-api-key.js";
export { hashApiKey, generateApiKey } from "./api-key-hash.js";

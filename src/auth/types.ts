/**
 * Shared auth types — used by BE (STANDALONE mode) and microservices (GATEWAY-RESOLVED mode).
 *
 * No Express dependency. No DB dependency. Framework-agnostic.
 */

/**
 * Authentication operating modes.
 *
 *   STANDALONE — the service itself validates the Bearer token against the IDP
 *                via OIDC discovery (jose + JWKS). Used by the BE.
 *
 *   GATEWAY    — a trusted reverse proxy (or the BE proxy) forwards the fully
 *                resolved user identity via custom HTTP headers. The service
 *                verifies a shared secret header to defend against spoofing.
 *                Used by microservices (GATEWAY-RESOLVED — BE already resolved
 *                the user, microservice just deserializes headers).
 */
export const AuthMode = {
  STANDALONE: "STANDALONE",
  GATEWAY: "GATEWAY",
} as const;

export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

/**
 * Authenticated user context. Produced by verifyAuth() (STANDALONE) or
 * deserializeAuthUserFromHeaders() (GATEWAY-RESOLVED).
 *
 * Identity model:
 *   - `id`         → internal Primebrick user UUID (from `user_profiles.uuid`).
 *                    The literal string `"system"` for system API keys.
 *   - `idp_code`   → original IDP subject (the JWT `sub`). Traceability only.
 *   - `roles`      → normalized role names from the IDP token.
 *   - `permissions`→ flattened set of permissions derived from `roles`.
 *   - `isAdmin`    → if true, user bypasses all permission checks (admin role).
 *   - `isSystem`   → if true, this is a system API key (not a user). Bypasses
 *                    all RBAC. Actor defaults to `"system"` for audit fields.
 */
export type AuthUser = {
  /** Internal Primebrick UUID. Use this for `created_by` / `updated_by` etc. */
  id: string;
  /** Original IDP subject (JWT `sub`). Read-only audit/log purposes. */
  idp_code: string;
  email: string | null;
  name: string | null;
  roles: string[];
  /** Flattened set of permissions granted by `roles`. */
  permissions: Set<string>;
  /** If true, user bypasses all permission checks (admin role). */
  isAdmin: boolean;
  /** If true, this is a system API key (not a user). Bypasses RBAC. Actor = "system". */
  isSystem: boolean;
  /** IDP organization (from `owner` or `organization` claim). */
  idp_org: string | null;
  /** IDP username (from `name`, `username`, or `preferred_username` claim). */
  idp_username: string | null;
  /** Raw access token captured in STANDALONE mode for proxy forwarding. undefined in GATEWAY mode. */
  raw_access_token?: string;
};

/** OIDC configuration (STANDALONE mode only). */
export interface OidcConfig {
  issuer_url?: string;
  client_id?: string;
  client_secret?: string;
  audience?: string;
  idp_type?: string;
}

/** Gateway configuration (GATEWAY mode). */
export interface GatewayConfig {
  secret?: string;
  secret_header_name?: string;
  public_secret?: string;
  public_secret_header_name?: string;
  headers: {
    user_id?: string;
    email?: string;
    name?: string;
    roles?: string;
    idp_code?: string;
    idp_org?: string;
    idp_username?: string;
    /** Header name for the full resolved AuthUser (GATEWAY-RESOLVED mode) */
    permissions?: string;
    is_admin?: string;
    is_system?: string;
  };
}

/** Full auth configuration loaded at startup from the service's config table. */
export interface AuthConfig {
  mode: AuthMode;
  /**
   * Path expression used to extract the roles array from a JWT payload.
   * Examples: "roles", "realm_access.roles", "resource_access.<client>.roles"
   */
  roles_path: string;
  oidc: OidcConfig;
  gateway: GatewayConfig;
  idp_endpoint?: string;
  idp_organization?: string;
  enable_email_verification_check: boolean;
  /**
   * Whether WebAuthn / passkey passwordless authentication is enabled.
   * When false, the BE WebAuthn endpoints return 503 and the FE hides the
   * passkey button. Parsed from the "true"/"false" string in the DB.
   */
  enable_webauthn: boolean;
  /**
   * Whether passkey enrollment is mandatory. When true, the FE passkey prompt
   * cannot be dismissed and the "do not show again" checkbox is hidden.
   * Parsed from the "true"/"false" string in the DB.
   */
  passkey_required: boolean;
  /**
   * Whether MFA / 2FA is enabled (login MFA + step-up MFA).
   * When false, login never branches to MFA and the step-up middleware
   * passes through. Parsed from the "true"/"false" string in the DB.
   */
  enable_mfa: boolean;
  /**
   * Redis cache URL (e.g. `redis://localhost:6379` or `rediss://host:6380` for TLS).
   * Empty string or `undefined` = cache disabled — the system runs without cache, with
   * `warn` logs. Cache is a feature, not a requirement; the system is fully valid without
   * it. Read from the `auth_configurations` table by the BE's `initCache()` at startup.
   */
  redis_url?: string;
}

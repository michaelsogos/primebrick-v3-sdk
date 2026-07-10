/**
 * OIDC client — performs discovery against the configured IDP and exposes a
 * `verifyAccessToken()` function that:
 *   - downloads & caches the JWKS automatically (`jose.createRemoteJWKSet`),
 *   - verifies the JWT signature, expiration, issuer and (optionally) audience,
 *   - returns the decoded payload as `JwtClaims`.
 *
 * Discovery endpoint used:
 *   <issuerUrl>/.well-known/openid-configuration
 *
 * The function is IDP-agnostic on purpose: replacing Casdoor with Keycloak /
 * Microsoft Entra / Auth0 only requires changing `oidc_issuer_url` (and
 * possibly `roles_path`).
 *
 * This module is STANDALONE-mode only. Microservices in GATEWAY-RESOLVED mode
 * do not verify JWTs — they deserialize the pre-resolved AuthUser from headers.
 */

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
} from "jose";
import type { OidcConfig } from "./types.js";
import type { JwtClaims } from "./token-normalizer.js";

interface DiscoveryDocument {
  issuer: string;
  jwks_uri: string;
}

interface OidcRuntime {
  discovery: DiscoveryDocument;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

// Singleton per issuer_url — keyed by issuer to support multiple IDPs
const runtimeCache = new Map<string, Promise<OidcRuntime>>();

async function getRuntime(oidc: OidcConfig): Promise<OidcRuntime> {
  const issuerUrl = oidc.issuer_url!;
  const cached = runtimeCache.get(issuerUrl);
  if (cached) return cached;

  const promise = (async (): Promise<OidcRuntime> => {
    const discoveryUrl = `${issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const res = await fetch(discoveryUrl);
    if (!res.ok) {
      throw new Error(`[auth] OIDC discovery failed: GET ${discoveryUrl} → HTTP ${res.status}`);
    }
    const discovery = (await res.json()) as DiscoveryDocument;
    if (!discovery.jwks_uri) {
      throw new Error("[auth] OIDC discovery document missing 'jwks_uri'");
    }
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    return { discovery, jwks };
  })();

  runtimeCache.set(issuerUrl, promise);

  // If discovery fails, drop the cached promise so the next request can retry.
  promise.catch(() => {
    runtimeCache.delete(issuerUrl);
  });

  return promise;
}

/**
 * Verify a Bearer access token against the configured IDP.
 *
 * Validations performed:
 *   - JWT signature (via JWKS published by the IDP)
 *   - `exp` (not expired) and `nbf` (not used before)
 *   - `iss` matches the configured issuer
 *   - `aud` matches `oidc.audience` if configured (otherwise ignored)
 *
 * Throws on any failure. Callers should catch and translate to 401.
 *
 * @param token - The raw JWT access token string
 * @param oidc - OIDC configuration (issuer_url, audience, etc.)
 */
export async function verifyAccessToken(token: string, oidc: OidcConfig): Promise<JwtClaims> {
  const { discovery, jwks } = await getRuntime(oidc);

  const verifyOpts: JWTVerifyOptions = {
    issuer: discovery.issuer,
  };
  if (oidc.audience) verifyOpts.audience = oidc.audience;

  const result = await jwtVerify(token, jwks, verifyOpts);
  return result.payload as JwtClaims;
}

/** Test helper: drop all cached OIDC runtimes so new discovery happens. */
export function resetOidcRuntimeForTest(): void {
  runtimeCache.clear();
}

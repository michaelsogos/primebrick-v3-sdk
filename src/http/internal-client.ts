/**
 * Internal HTTP client — the ONLY legal way to call another Primebrick
 * service over HTTP (BE→US, US→US).
 *
 * `internalFetch` is a thin wrapper over `fetch` that force-injects the
 * caller's service-identity headers (User-Agent + x-primebrick-client-shield-key)
 * provided by `configureInternalClient`. Identity headers are applied AFTER
 * the caller's own headers so they can never be overridden or spoofed.
 *
 * Fail-closed: if no provider was configured at boot, every call throws —
 * a raw `fetch()` to a microservice would be rejected by the identity gate
 * anyway, so bypassing this client is pointless. This is what makes the
 * "forgot the identity headers" class of bug impossible.
 *
 * External calls (Casdoor, Brevo, LLM providers, …) MUST keep using plain
 * `fetch` — they are not governed by the client registry.
 */

import { signInternalRequest } from "../auth/http-signing.js";
import { currentServiceCode } from "../service/service-identity.js";
import { getLoadedAuthConfig } from "../auth/auth-config-cache.js";

export type InternalIdentityProvider = () => Record<string, string>;

let provider: InternalIdentityProvider | null = null;

/**
 * Register the identity provider once at boot:
 * - microservices: wired automatically by `createMicroservice`
 * - the BE: `configureInternalClient(backendIdentityHeaders)` after
 *   `initBackendIdentity()`.
 */
export function configureInternalClient(p: InternalIdentityProvider): void {
  provider = p;
}

/** Test hook — clears the configured provider. */
export function resetInternalClient(): void {
  provider = null;
}

/**
 * The configured identity headers, or null when unconfigured. Used by the
 * NATS layer to stamp the same identity onto published messages — one
 * provider feeds both transports.
 */
export function internalIdentityHeaders(): Record<string, string> | null {
  return provider ? provider() : null;
}

/** `fetch` with the caller's service-identity headers force-injected. */
export async function internalFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  if (!provider) {
    throw new Error(
      "internalFetch: internal HTTP client not configured — " +
        "createMicroservice()/BE boot must call configureInternalClient() first",
    );
  }
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(provider())) {
    headers.set(name, value); // identity always wins over caller-supplied headers
  }

  // Internal provenance (arch-internal-trust-and-transports §12): sensitive
  // headers travel ONLY inside the sealed blob; the request carries a
  // proof-of-possession signature, never a secret. Fail-closed by construction:
  // no key material → throw BEFORE anything reaches the wire.
  const configuredAuthHeaders = new Set<string>();
  const authConfig = getLoadedAuthConfig();
  if (authConfig) {
    for (const configured of Object.values(authConfig.gateway.headers)) {
      if (typeof configured === "string") configuredAuthHeaders.add(configured.toLowerCase());
    }
  }
  const sensitive: Record<string, string> = {};
  for (const [name, value] of [...headers.entries()]) {
    if (name.toLowerCase().startsWith("x-user-") || configuredAuthHeaders.has(name.toLowerCase())) {
      sensitive[name] = value;
      headers.delete(name);
    }
  }

  const u = new URL(url.toString(), "http://internal");
  const path = u.pathname + u.search;
  const method = (init.method ?? "GET").toUpperCase();
  let bodyBytes: string | Buffer | undefined;
  if (typeof init.body === "string") bodyBytes = init.body;
  else if (Buffer.isBuffer(init.body)) bodyBytes = init.body;
  else if (init.body instanceof Uint8Array) bodyBytes = Buffer.from(init.body);
  else if (init.body != null) {
    throw new Error(
      "internalFetch: unsupported body type for signing — internal calls must pass string/Buffer bodies (streams cannot be hashed without consuming them)",
    );
  }

  const signed = signInternalRequest({
    service: currentServiceCode(),
    method,
    path,
    body: bodyBytes,
    sensitiveHeaders: sensitive,
  });
  for (const [name, value] of Object.entries(signed)) {
    headers.set(name, value);
  }
  return fetch(url, { ...init, headers });
}

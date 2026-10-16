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
  return fetch(url, { ...init, headers });
}

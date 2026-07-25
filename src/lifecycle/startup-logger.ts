/**
 * Startup logging helper — prints a consistent one-line banner for each
 * infrastructure module after successful connection.
 *
 * Pattern:
 *   [startup] PostgreSQL 18.0 connected (127.0.0.1:5432)
 *   [startup] Redis 8.8.0 connected (127.0.0.1:6379)
 *   [startup] NATS 2.14.3 connected (127.0.0.1:4222)
 *   [startup] Casdoor v3.118.0 connected (127.0.0.1:8000)
 *   [startup] primebrick-api 0.30.0 listening on http://localhost:3001
 *
 * Used by both the BE and US microservices for consistent observability.
 */

/**
 * Log a successful infrastructure module connection.
 *
 * @param name Module name (e.g. "PostgreSQL", "Redis", "NATS", "Casdoor")
 * @param version Server version (e.g. "18.0", "8.8.0"), or "unknown" if not available
 * @param url Connection URL or address (e.g. "127.0.0.1:5432")
 */
export function logModuleStartup(name: string, version: string | null | undefined, url: string): void {
  const v = version || "unknown";
  console.log(`[startup] ${name} ${v} connected (${url})`);
}

/**
 * Log a service startup (the service itself, not an infrastructure dependency).
 *
 * @param serviceName Service name (e.g. "primebrick-api", "emailsender")
 * @param version Service version from package.json
 * @param url Base URL the service is listening on
 */
export function logServiceStartup(serviceName: string, version: string, url: string): void {
  console.log(`[startup] ${serviceName} ${version} listening on ${url}`);
}

/**
 * Unified health response shape — used by both the BE and US microservices.
 *
 * The SDK owns this type so that the BE (Express) and US (createHttpServer)
 * produce the same JSON structure, and the FE can parse a single shape.
 *
 * Each service registers only the checks it has:
 *   - BE: db, redis, nats, idp
 *   - US: db, redis, nats (no IDP)
 *
 * The `ok` field is true only if ALL checks pass (HTTP 200). If any check
 * fails, `ok` is false (HTTP 503).
 */

/**
 * A single health check result. `ok` is mandatory; other fields are optional
 * metadata (version, type, error message).
 */
export interface HealthCheckResult {
  ok: boolean;
  /** Server version (e.g. "18.0" for PostgreSQL, "8.8.0" for Redis). */
  version?: string;
  /** Service type (e.g. "Casdoor" for IDP). */
  type?: string;
  /** Error message if ok is false. */
  error?: string;
  /** Allow additional service-specific fields without breaking the interface. */
  [key: string]: unknown;
}

/**
 * The unified health response returned by `/health` on both BE and US.
 */
export interface HealthResponse {
  /** true only if ALL checks pass. */
  ok: boolean;
  /** Service identifier (e.g. "primebrick-api", "emailsender"). */
  service: string;
  /** Service version (from package.json). */
  version: string;
  /** Base URL the service is listening on (if applicable). */
  url?: string;
  /** Map of check name → result. Keys are service-specific (db, redis, nats, idp). */
  checks: Record<string, HealthCheckResult>;
}

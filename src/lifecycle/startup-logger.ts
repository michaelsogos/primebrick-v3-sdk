/**
 * Startup logging helper — prints a consistent one-line banner for each
 * infrastructure module after successful connection.
 *
 * Pattern (the [service#version] tag is added by the logger itself):
 *   PostgreSQL 18.0 connected (127.0.0.1:5432)
 *   Redis 8.8.0 connected (127.0.0.1:6379)
 *   NATS 2.14.3 connected (127.0.0.1:4222)
 *   Casdoor v3.118.0 connected (127.0.0.1:8000)
 *   Listening on http://localhost:3001
 *
 * Used by both the BE and US microservices for consistent observability.
 */
import { logger } from "./logger.js";

/**
 * Log a successful infrastructure module connection.
 *
 * @param name Module name (e.g. "PostgreSQL", "Redis", "NATS", "Casdoor")
 * @param version Server version (e.g. "18.0", "8.8.0"), or "unknown" if not available
 * @param url Connection URL or address (e.g. "127.0.0.1:5432")
 */
export function logModuleStartup(name: string, version: string | null | undefined, url: string): void {
  const v = version || "unknown";
  logger.done(`${name} ${v} connected (${url})`, { tags: ["core"] });
}

/**
 * Log the service's own startup — name/version are already carried by the
 * logger's mandatory [service#version] tag, so only the URL is needed.
 *
 * @param url Base URL the service is listening on
 */
export function logServiceStartup(url: string): void {
  logger.done(`Listening on ${url}`, { tags: ["core"] });
}

/**
 * Minimal pool shape — satisfied by `pg.Pool` and the DAL's pool without
 * the SDK depending on `pg` types.
 */
export interface SqlPoolLike {
  query(sql: string): Promise<{ rows: { version?: string }[] }>;
}

/**
 * PostgreSQL startup banner probe for `createMicroservice`'s `dbBanner`
 * option. Returns the same `{name, version, url}` the BE logs at boot:
 * `PostgreSQL 18.4 connected (postgres://user@host:5432/db)`.
 * The connection URL is printed with the password stripped.
 */
export async function pgServerBanner(
  pool: SqlPoolLike,
  databaseUrl: string,
): Promise<{ name: string; version: string | null; url: string }> {
  const res = await pool.query("SELECT version()");
  const raw = res.rows[0]?.version ?? "";
  const match = raw.match(/PostgreSQL\s+([\d.]+)/);
  return {
    name: "PostgreSQL",
    version: match?.[1] ?? null,
    url: databaseUrl.replace(/(:\/\/[^:/]+):[^@]+@/, "$1@"),
  };
}

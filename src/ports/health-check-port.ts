/**
 * Port interface for a DB health check (connectivity ping).
 *
 * The SDK's HealthCheck depends on this port, NOT on pg.Pool.
 * The consumer provides an adapter that runs whatever their DB uses
 * (e.g. `SELECT 1` for PG, `SELECT 1` for MSSQL, etc.).
 */
export interface HealthCheckPort {
  /** Returns true if the DB is reachable and responsive. */
  ping(): Promise<boolean>;
}

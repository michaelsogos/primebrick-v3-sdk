/**
 * Port interface for executing parameterized SQL queries.
 *
 * The SDK's migration runner (applyPatches) depends on this port,
 * NOT on pg.Pool. The consumer provides an adapter that wraps their
 * DB driver (pg.Pool, mssql.ConnectionPool, mariadb.Pool, etc.).
 *
 * The contract mirrors the minimal `query(text, params?)` shape that
 * every SQL DB driver exposes.
 */
export interface DatabasePort {
  /**
   * Execute a SQL statement. Returns rows (empty for non-SELECT statements).
   * Used by the migration runner for BEGIN/COMMIT/ROLLBACK and patch SQL.
   */
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Port interface for reading config rows from a DB config table.
 *
 * The SDK's ConfigLoader depends on this port, NOT on any specific DAL.
 * The consumer provides an adapter implementation using their DAL
 * (e.g. @primebrick/dal-pg's dal.findAll, or a raw SQL query).
 */
export interface ConfigRepositoryPort {
  /**
   * Return all config rows as { key, value } pairs.
   * value is null when the config key exists but has no value set.
   */
  findAll(): Promise<Array<{ key: string; value: string | null }>>;
}

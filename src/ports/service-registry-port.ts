import type { IServiceRegistry } from "../service/service-registry.js";

/**
 * Port interface for CRUD operations on the service_registry table.
 *
 * The BE implements this port using @primebrick/dal-pg's Repository.
 * The SDK's ServiceRegistrar no longer uses this port — it publishes
 * via NATS instead. The BE's NATS subscriber uses this port (via
 * ServiceRegistryRepo) to persist incoming lifecycle events.
 */
export interface ServiceRegistryPort<T = IServiceRegistry> {
  /** Find a service registry row by its code. Returns null if not found. */
  findByCode(code: string): Promise<T | null>;

  /** Find a service registry row by code + base_url (for direct mode with multiple instances). */
  findByCodeAndBaseUrl(code: string, baseUrl: string): Promise<T | null>;

  /** Find all service registry rows for a given code (multiple instances in direct mode). */
  findAllByCode(code: string): Promise<T[]>;

  /** Find all service registry rows. */
  findAll(): Promise<T[]>;

  /** Insert a new service registry row. */
  insert(row: Partial<T>): Promise<void>;

  /** Update an existing service registry row by code (scaler mode — one row per code). */
  updateByCode(code: string, row: Partial<T>): Promise<void>;

  /** Update an existing service registry row by code + base_url (direct mode — multiple rows per code). */
  updateByCodeAndBaseUrl(code: string, baseUrl: string, row: Partial<T>): Promise<void>;

  /** Delete a service registry row by code + base_url (direct mode). */
  deleteByCodeAndBaseUrl(code: string, baseUrl: string): Promise<void>;
}

import type { IServiceRegistry } from "../service/service-registry.js";

/**
 * Port interface for CRUD operations on the service_registry table.
 *
 * The SDK's ServiceRegistrar depends on this port, NOT on any specific DAL.
 * The consumer provides an adapter implementation using their DAL
 * (e.g. @primebrick/dal-pg's dal.find/dal.add/dal.update).
 */
export interface ServiceRegistryPort<T = IServiceRegistry> {
  /** Find a service registry row by its code. Returns null if not found. */
  findByCode(code: string): Promise<T | null>;

  /** Insert a new service registry row. */
  insert(row: T): Promise<void>;

  /** Update an existing service registry row by code. */
  updateByCode(code: string, row: Partial<T>): Promise<void>;
}

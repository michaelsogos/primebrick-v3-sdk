import type { AuthConfig } from "../types.js";

/**
 * Port for loading auth configuration from the service's config store.
 *
 * BE implements this reading from `auth_configurations` table.
 * Microservices implement this reading from their own `config` table.
 */
export interface AuthConfigPort {
  load(): Promise<AuthConfig>;
}

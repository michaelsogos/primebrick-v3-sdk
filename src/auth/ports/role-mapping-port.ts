/**
 * Port for loading role-to-permission mappings from the database.
 *
 * BE-ONLY port. Microservices do NOT implement this — they use
 * GATEWAY-RESOLVED mode where the BE already expanded permissions and
 * forwards them in headers.
 */

export interface RoleMappingEntry {
  permissions: string[];
  is_admin: boolean;
  label_key?: string;
}

export interface RoleMappingPort {
  /** Get the mapping for a single role. Returns null if role is not mapped. */
  getRoleMapping(role: string): Promise<RoleMappingEntry | null>;

  /** Load all role mappings into a map. Called at startup. */
  loadAllMappings(): Promise<Map<string, RoleMappingEntry>>;
}

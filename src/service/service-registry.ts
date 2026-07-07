/**
 * Shape of a row in the `service_registry` table.
 *
 * Self-contained interface — NO decorators, NO IAuditableEntity.
 * The SDK is DB-agnostic; the consumer keeps their own decorated
 * entity class (e.g. ServiceRegistryEntity with @Entity/@Column from
 * @primebrick/dal-pg) and maps it to/from this interface in their adapter.
 *
 * Previously duplicated in emailsender (service_registry_entity.ts:1-54)
 * and BE (service_registry_entity.ts:1-42). Now the shared shape lives here.
 */
export interface IServiceRegistry {
  code: string;
  base_url: string;
  endpoints: Record<string, unknown>;
}

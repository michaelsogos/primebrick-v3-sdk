/**
 * @primebrick/sdk — Shared microservice infrastructure for Primebrick v3.
 *
 * DB-agnostic via port interfaces (dependency inversion).
 * ZERO dependencies on any Primebrick library or DB driver.
 *
 * Modules:
 * - ports: ConfigRepositoryPort, DatabasePort, ServiceRegistryPort, HealthCheckPort
 * - config: ConfigLoader, IConfigEntity
 * - migrations: applyPatches, patch-registry, patch-naming
 * - service: ServiceRegistrar, IServiceRegistry
 * - lifecycle: GracefulShutdown
 * - nats: NatsClient (requires `nats` peer dependency)
 * - http: createHttpServer, HealthCheck
 * - env: validateEnv, requireEnv
 */

// Ports (dependency inversion — consumer implements these)
export { type ConfigRepositoryPort } from "./ports/config-repository-port.js";
export { type DatabasePort } from "./ports/database-port.js";
export { type ServiceRegistryPort } from "./ports/service-registry-port.js";
export { type HealthCheckPort } from "./ports/health-check-port.js";

// Config
export { type IConfigEntity } from "./config/iconfig-entity.js";
export { ConfigLoader } from "./config/config-loader.js";

// Migrations
export {
  PATCH_REGISTRY_DDL,
  PATCH_REGISTRY_FQNAME,
  isPatchBodyAlreadyRecorded,
} from "./migrations/patch-registry.js";
export {
  utcTimestampForFilename,
  slugifyPatchSegment,
  patchIdFromFilename,
  sha256Hex,
} from "./migrations/patch-naming.js";
export { applyPatches, type ApplyPatchesResult } from "./migrations/apply-patches.js";

// Service registration
export { type IServiceRegistry } from "./service/service-registry.js";
export { ServiceRegistrar, type ServiceRegistrarConfig } from "./service/service-registrar.js";

// Lifecycle
export { GracefulShutdown, type CleanupFn } from "./lifecycle/graceful-shutdown.js";

// NATS (optional — requires `nats` peer dependency)
export { NatsClient } from "./nats/nats-client.js";

// HTTP
export { createHttpServer, type HttpServerOptions } from "./http/http-server.js";
export { HealthCheck, type HealthCheckResult } from "./http/health-check.js";

// Env validation
export { validateEnv, requireEnv, type EnvSchema, type EnvValidationResult } from "./env/env-validator.js";

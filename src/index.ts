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
 * - nats: NatsClient
 * - http: createHttpServer, HealthCheck
 * - env: validateEnv, requireEnv
 * - sse: createSseWriter, createSseEventBus, bridgeNatsToSse
 */

// Ports (dependency inversion — consumer implements these)
export { type ConfigRepositoryPort } from "./ports/config-repository-port.js";
export { type DatabasePort } from "./ports/database-port.js";
export { type ServiceRegistryPort } from "./ports/service-registry-port.js";
export { type HealthCheckPort } from "./ports/health-check-port.js";

// Config
export {
  type IConfigEntity,
  type ConfigType,
  type ConfigTypeMoneyConfig,
  type ConfigValidation,
  type ConfigValidationRules,
  type ValidationRuleMin,
  type ValidationRuleMax,
  type ValidationRuleUrl,
  type ValidationRuleEmail,
  type ValidationRuleRegex,
} from "./config/iconfig-entity.js";
export { ConfigLoader } from "./config/config-loader.js";
export {
  validateConfigValue,
  ConfigValidationError,
  coerceConfigValue,
  serializeConfigValue,
} from "./config/config-validator.js";

// Currency helpers (BE/US only — FE has its own independent copy)
export * from "./currency/index.js";

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
export { ServiceRegistrar, type ServiceRegistrarConfig, type HealthCheckFn } from "./service/service-registrar.js";
export {
  SERVICE_SUBJECTS,
  type ServiceHeartbeatPayload,
  type ServiceRegisterPayload,
  type ServiceUnregisterPayload,
  type ServiceStalePayload,
  type ServiceHealthCheck,
} from "./service/service-lifecycle-subjects.js";

// Lifecycle
export { GracefulShutdown, type CleanupFn } from "./lifecycle/graceful-shutdown.js";

// NATS
export { NatsClient } from "./nats/nats-client.js";

// HTTP
export { createHttpServer, type HttpServerOptions } from "./http/http-server.js";
export { HealthCheck, type HealthCheckResult } from "./http/health-check.js";
export { type HealthResponse } from "./http/health-response.js";

// Lifecycle — startup logging
export { logModuleStartup, logServiceStartup } from "./lifecycle/startup-logger.js";

// Microservice bootstrap builder — eliminates ~140 lines of boilerplate
export {
  createMicroservice,
  readServiceVersion,
  type MicroserviceOptions,
  type MicroserviceContext,
} from "./microservice/create-microservice.js";

// Env validation
export { validateEnv, requireEnv, type EnvSchema, type EnvValidationResult } from "./env/env-validator.js";

// Ext-JSON — BigInt-safe JSON serialization/deserialization (BE/US only, NOT for FE)
export {
  extJsonStringify,
  extJsonParse,
  extJsonMiddleware,
  extJsonBodyParser,
} from "./json/ext-json.js";

// Cache — best-effort Redis cache layer (BE/US; DAL is NOT involved)
// The SDK owns the cache abstraction, decorators, key builder, withCache wrapper, and
// the Redis implementation. The DAL is untouched — entity metadata is read via
// Reflect.getMetadata (standard JS reflection API, no import from the DAL).
export {
  type CachePort,
  CacheKeyBuilder,
} from "./cache/cache-port.js";
export {
  Cached,
  CacheKey,
  isEntityCached,
  getEntityCacheTtl,
  getCacheKeyProperty,
} from "./cache/cache-decorators.js";
export {
  withCache,
  type CacheableRepository,
  type CacheLogger,
} from "./cache/cached-repository.js";
export { RedisCachePort } from "./cache/redis-cache-port.js";
export { createRedisClient, closeRedisClient } from "./cache/redis-client.js";
export { getRedisInfo, type RedisInfo } from "./cache/redis-info.js";
export {
  initCacheFromSharedConfig,
  type CacheBootstrapResult,
} from "./cache/cache-bootstrap.js";
export { createRedisHealthCheck } from "./cache/cache-health.js";
export {
  setSdkCachePort,
  getSdkCachePort,
  getSdkRedisInfo,
  resetSdkCachePort,
} from "./cache/cache-port-holder.js";

// Shared config — NATS `config.get` protocol for BE→microservice config sharing
export {
  type SharedConfig,
  SHARED_CONFIG_SUBJECT,
  subscribeSharedConfig,
  fetchSharedConfig,
} from "./config/shared-config.js";

// Auth — framework-agnostic auth for HTTP + NATS (BE + microservices)
export * from "./auth/index.js";

// SSE — Server-Sent Events infrastructure (BE only)
// Provides the writer, event bus, and NATS bridge for SSE endpoints.
// @see docs/user-guide/sse-standard.mdx for the full SSE development standard.
export { createSseWriter, SSE_HEADERS } from "./sse/sse-writer.js";
export { createSseEventBus } from "./sse/sse-event-bus.js";
export { bridgeNatsToSse, type NatsSseBridgeMapping } from "./sse/nats-sse-bridge.js";
export type {
  SseEvent,
  SseWriter,
  SseEventBus,
  SseEventBusSubscription,
} from "./sse/types.js";

// Presence & collaboration — real-time awareness for shared entities (BE only)
// Provides the presence port, Redis implementation, NATS subject builders, and
// shared types. The BE combines these with the SSE primitives above to expose
// collaboration SSE endpoints. See docs/user-guide/collaboration.mdx.
export * from "./presence/types.js";
export { type PresencePort } from "./presence/presence-port.js";
export { RedisPresencePort } from "./presence/redis-presence-port.js";
export {
  presenceSubject,
  entityChangedSubject,
  publishPresence,
  publishEntityChanged,
} from "./presence/nats-subjects.js";

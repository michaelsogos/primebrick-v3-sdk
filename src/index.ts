/**
 * @primebrick/sdk — Shared microservice infrastructure for Primebrick v3.
 *
 * DB-agnostic via port interfaces (dependency inversion).
 * ZERO dependencies on any Primebrick library or DB driver.
 *
 * Modules:
 * - ports: ConfigRepositoryPort, ServiceRegistryPort, HealthCheckPort
 * - config: ConfigLoader, IConfigEntity
 * - migrations: boot step via dbPatches (engine lives in @primebrick/dal-pg)
 * - service: ServiceRegistrar, IServiceRegistry
 * - lifecycle: GracefulShutdown
 * - nats: NatsClient
 * - http: createHttpServer, HealthCheck
 * - env: validateEnv, requireEnv
 * - sse: createSseWriter, createSseEventBus, bridgeNatsToSse
 */

// Ports (dependency inversion — consumer implements these)
export { type ConfigRepositoryPort } from "./ports/config-repository-port.js";
export { type ServiceRegistryPort } from "./ports/service-registry-port.js";
export { type HealthCheckPort } from "./ports/health-check-port.js";

// Config
export {
  type IConfigEntity,
  type ConfigType,
  type ConfigTypeMoneyConfig,
  type ConfigTypeUrlConfig,
  type ConfigTypePhoneConfig,
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
export {
  STRING_DERIVED_TYPES,
  NUMERIC_TYPES,
  TYPE_CAPABILITIES,
  typeCapabilities,
  type BoundsKind,
  type WidgetCapability,
  type ValidationCapabilities,
  type TypeCapabilities,
} from "./config/type-capabilities.js";

// Currency helpers (BE/US only — FE has its own independent copy)
export * from "./currency/index.js";

// Migrations — the engine lives in @primebrick/dal-pg (src/migrations/*).
// The old SDK applyPatches/DatabasePort were deleted (breaking): services
// wire `dbPatches` in createMicroservice and use `primebrick-db` CLI.

// Service registration
export { type IServiceRegistry } from "./service/service-registry.js";
export { ServiceRegistrar, type ServiceRegistrarConfig, type HealthCheckFn } from "./service/service-registrar.js";
export {
  CLIENT_SHIELD_KEY_HEADER,
  clientKeyHash,
  deriveClientKey,
  verifyRowKey,
  detectPackageIdentity,
  buildUserAgent,
  identityHeaders,
  verifyClientIdentity,
  type PackageIdentity,
  type ClientIdentityResult,
  type ClientKeyMaterial,
} from "./service/service-identity.js";
export { ClientShieldRegistry, CLIENT_SHIELD_REGISTRY_SUBJECTS, type ClientShieldRegistryRow } from "./service/client-shield-registry.js";
export {
  DOCS_PACK_CAPABILITY,
  DOCS_PACK_SCHEMA_VERSION,
  parseDocsPackPayload,
  type DocsPackManifest,
  type DocsPackFile,
  type DocsPackPayload,
  type DocsPackContentFile,
} from "./docs-pack/manifest.js";
export {
  buildDocsPack,
  type BuildDocsPackOptions,
  type GenerateDocsFn,
  type GenerateDocsContext,
  type GeneratedDoc,
} from "./docs-pack/build-docs-pack.js";
export { docsPackRouteHandler, DOCS_PACK_ROUTE } from "./docs-pack/serve-docs-pack.js";
export { fetchDocsPack, DOCS_PACK_SHIELD_HEADER } from "./docs-pack/docs-pack-client.js";
export {
  internalFetch,
  configureInternalClient,
  resetInternalClient,
  type InternalIdentityProvider,
} from "./http/internal-client.js";
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
export { NatsClient, msgHeader } from "./nats/nats-client.js";
export {
  makeNatsRoutes,
  makeNatsRequestRoute,
  callNats,
  type NatsRoute,
  type NatsRequestRoute,
  type NatsRouteContext,
  type NatsRouteVerify,
  type NatsRouterDeps,
} from "./nats/nats-routes.js";
export {
  setNatsShieldRegistry,
  getNatsShieldRegistry,
  verifyNatsPublisher,
  serviceShieldVerify,
  subscribeShielded,
  type ShieldRegistryLike,
} from "./nats/service-shield.js";
export {
  ensureJobSchedule,
  cancelJobSchedule,
  dueLaneVerify,
  forwardAuthHeaders,
  JOB_SCHEDULE_HEADERS,
  JOB_STREAM_SUBJECTS,
  JOB_SCHEDULE_REQUEST_SUBJECT,
  type EnsureJobScheduleOpts,
} from "./nats/job-schedule.js";
export {
  RotatingSecretEngine,
  SecretProvider,
  startSecretProvider,
  SECRET_SUBJECTS,
  SECRET_DEFAULTS,
  type RotatingSecretRef,
  type SecretGetRequest,
  type SecretGetResponse,
} from "./secrets/rotating-secret.js";
export {
  setClientShieldSecretSlot,
  getClientShieldSecretSlot,
  currentClientShieldSecret,
  validClientShieldSecrets,
  humanizeMs,
  CLIENT_SHIELD_SECRET_REF,
  type ClientShieldSecretSlot,
} from "./auth/client-shield-secret.js";

// HTTP
export { createHttpServer, type HttpServerOptions } from "./http/http-server.js";
export {
  makeRpcRouter,
  composeRouteHandlers,
  brandRouteHandler,
  isFactoryRouteHandler,
  ValidationError,
  type RpcRoute,
  type RpcRouteContext,
  type RpcRouterDeps,
  type RouteHandler,
} from "./http/rpc-router.js";
export {
  makeEntityRouter,
  parseBracketQuery,
  type EntityRouterConfig,
  type EntityServiceLike,
  type EntityActionMeta,
} from "./http/entity-router.js";
export {
  mapDalError,
  type MappedDalError,
  type Rfc7807Body,
} from "./errors/dal-error-mapper.js";
export { HealthCheck, type HealthCheckResult } from "./http/health-check.js";
export { type HealthResponse } from "./http/health-response.js";
export {
  buildOpenApiSpec,
  entityCrudSpec,
  rpcSpec,
  makeOpenApiHandler,
  operationIdFor,
  type JsonSchema,
  type OpenApiRouteDoc,
  type RpcRouteOpenApi,
  type EntityCrudOp,
  type OpenApiSpecInput,
} from "./http/openapi.js";

// Lifecycle — startup logging
export { logModuleStartup, logServiceStartup, pgServerBanner, type SqlVersionProbe } from "./lifecycle/startup-logger.js";

// Lifecycle — async structured logger + console bridge
export {
  logger,
  installConsoleBridge,
  setLogOptions,
  getLogOptions,
  setOtelLogSink,
  flushLogsSync,
  type LogLevel,
  type LogFormat,
  type LogMeta,
} from "./lifecycle/logger.js";

// Telemetry — OpenTelemetry init/restart + propagation helpers
export {
  initTelemetry,
  restartTelemetry,
  shutdownTelemetry,
  getTelemetryConfig,
  injectTraceHeaders,
  extractTraceContext,
  extractNatsContext,
  fetchTraced,
  natsCarrier,
  recordCarrier,
  type TelemetryConfig,
} from "./telemetry/otel.js";

// Microservice bootstrap builder — eliminates ~140 lines of boilerplate
export {
  createMicroservice,
  readServiceVersion,
  type MicroserviceOptions,
  type MicroserviceContext,
} from "./microservice/create-microservice.js";

// DB migration boot step + db_patch remediation surface (step 2.5)
export {
  runDbMigrationStep,
  type DbMigrationBootOptions,
  type DbMigrationEnginePort,
  type MigrationBootState,
  type MigrationRunResultLike,
  type MigrationEngineOptsLike,
} from "./microservice/db-migration-step.js";
export {
  makeDbMigrationRouteHandler,
  MIGRATION_ROUTE_PREFIX,
} from "./http/migration-routes.js";

// Env validation
export { validateEnv, requireEnv, type EnvSchema, type EnvValidationResult } from "./env/env-validator.js";
export { assertDbEnv, type DbEnv } from "./env/db-env.js";

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
export { createRedisClient, closeRedisClient, getRedisClient } from "./cache/redis-client.js";
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
export { type CacheEntry, type CacheResponseMeta } from "./cache/cache-entry.js";
export {
  computeETag,
  computeVersionETag,
  wrapCacheEntry,
  etagMatches,
} from "./cache/etag.js";
export {
  CACHE_HEADERS,
  CACHE_CONTROL_CACHED,
  type CacheScope,
} from "./cache/cache-headers.js";

// Shared config — NATS `config.get` protocol for BE→microservice config sharing
export {
  type SharedConfig,
  type TelemetrySharedConfig,
  SHARED_CONFIG_SUBJECT,
  CONFIG_CHANGED_SUBJECT,
  subscribeSharedConfig,
  fetchSharedConfig,
  subscribeConfigChanged,
  setSharedConfig,
  getSharedConfig,
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

// Translations — framework-agnostic i18n service + cache helpers (BE only)
// DB-agnostic: the BE resolves entity metadata (schema, qualified table name)
// and passes it to the service. PG builds the dict via jsonb_object_agg.
export * from "./translations/index.js";

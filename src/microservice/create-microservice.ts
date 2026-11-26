/**
 * Microservice bootstrap builder — eliminates ~140 lines of boilerplate
 * that every Primebrick microservice must replicate in `src/index.ts`.
 *
 * The SDK is DB-agnostic (zero deps on DB drivers), so DAL init is injected
 * via a callback. All service-specific adapters (config repository, auth config
 * port, API key port, health check port) are provided by the consumer as
 * factories that receive context as it is built.
 *
 * Orchestration order (strict — each step depends on the previous):
 *   1. ENV validation (requireEnv)
 *   2. DAL init (consumer callback — creates pg.Pool)
 *   3. ConfigLoader (reads config table via ConfigRepositoryPort)
 *   4. Auth config (initAuthConfig + loadAuthConfig via AuthConfigPort)
 *   5. Auth dependency wiring (consumer setters)
 *   6. NATS connection (URL from config table)
 *   7. ServiceRegistrar (register + heartbeat via NATS)
 *   8. HTTP server (createHttpServer + HealthCheck)
 *   9. GracefulShutdown (cleanup: registrar, NATS, DAL, HTTP)
 *  10. onReady callback (consumer business logic — NATS subscriptions, etc.)
 *
 * @example
 * ```typescript
 * import "dotenv/config";
 * import "reflect-metadata";
 * import { createMicroservice } from "@primebrick/sdk";
 * import { initDal, getDal } from "./db/dal.js";
 * import { ConfigRepositoryAdapter, HealthCheckAdapter } from "./adapters/index.js";
 * import { MyAuthConfigPort, MyApiKeyPort } from "./adapters/auth-ports-adapter.js";
 * import { compositeRouteHandler } from "./server/composite-route.js";
 *
 * const ctx = await createMicroservice({
 *   serviceName: "my-service",
 *   serviceDescription: "My microservice",
 *   icon: "mail",
 *   iconType: "icon",
 *   envSchema: {
 *     DATABASE_URL: { required: true, description: "PostgreSQL connection string" },
 *     DB_SCHEMA: { required: false, default: "my_service", description: "Database schema" },
 *     DATABASE_URL: { required: true, description: "PostgreSQL connection string" },
 *     DB_SCHEMA: { required: false, default: "my_service", description: "Database schema" },
 *   },
 *   },
 *   initDal,
 *   configRepositoryAdapter: () => new ConfigRepositoryAdapter(),
 *   authConfigPort: (configLoader) => new MyAuthConfigPort(configLoader),
 *   apiKeyPort: () => new CachingApiKeyPort(new NatsApiKeyPort(3000), () => getSdkCachePort()),
 *   healthCheckPort: () => new HealthCheckAdapter(getDal().getPool()),
 *   routeHandler: compositeRouteHandler,
 *   endpoints: { webhook: "/webhook" },
 *   authDependencySetters: [(cfg, apiKeyPort) => { /* wire auth *\/ }],
 *   onReady: async (ctx) => { /* subscribe to NATS, etc. *\/ },
 * });
 * ```
 */

import { logger } from "../lifecycle/logger.js";
import { ClientShieldRegistry } from "../service/client-shield-registry.js";
import { setNatsShieldRegistry } from "../nats/service-shield.js";
import { SecretProvider, startSecretProvider, refreshSecretWithRetry } from "../secrets/rotating-secret.js";
import { CLIENT_SHIELD_SECRET_REF } from "../auth/client-shield-secret.js";
import { SecretVaultReader, MESSAGE_KEY_MATERIAL_REF, VAULT_SUBJECTS, type SqlPoolPort } from "../secrets/secret-vault.js";
import { MessageKeyProvider, setMessageKeyProvider } from "../nats/message-key-provider.js";
import { subscribeShielded } from "../nats/service-shield.js";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { composeRouteHandlers, type RouteHandler } from "../http/rpc-router.js";
import { mergeBuiltinNav } from "../http/builtin-entities.js";
import { entityEventPayloadSchema } from "../nats/entity-events.js";
import type { EntityRouteDecl } from "../http/service-routes.js";
import { docsPackRouteHandler } from "../docs-pack/serve-docs-pack.js";
import { docsPackStale, emitServiceDocs } from "../docs-gen/emit.js";
import {
  ConfigLoader,
  ServiceRegistrar,
  GracefulShutdown,
  NatsClient,
  createHttpServer,
  resolveHttpBindHost,
  HealthCheck,
  requireEnv,
  assertDbEnv,
  assertValidSchemaList,
  type DbEnv,
  initAuthConfig,
  invalidateAuthConfig,
  loadAuthConfig,
  getAuthConfig,
  type EnvSchema,
  type ConfigRepositoryPort,
  type AuthConfigPort,
  type ApiKeyPort,
  type HealthCheckPort,
  type HealthCheckResult,
  type AuthConfig,
  type HealthCheckFn,
  installConsoleBridge,
  initTelemetry,
  restartTelemetry,
  shutdownTelemetry,
  flushLogsSync,
  setLogOptions,
  fetchSharedConfig,
  subscribeConfigChanged,
  setSharedConfig,
  initCacheFromSharedConfig,
  setSdkCachePort,
  configureInternalClient,
  detectPackageIdentity,
  resolveServiceCode,
  setCurrentServiceCode,
  buildUserAgent,
  deriveClientKey,
  logModuleStartup,
  CLIENT_SHIELD_KEY_HEADER,
  isFactoryRouteHandler,
  brandRouteHandler,
} from "../index.js";
import type { TelemetryConfig } from "../telemetry/otel.js";
import type { ModuleNavDeclaration, ModuleEventsDecl } from "@primebrick/core";
import type { TelemetrySharedConfig } from "../config/shared-config.js";
import {
  runDbMigrationStep,
  rerunMigrations,
  makeRunOnceInit,
  type DbMigrationBootOptions,
  type ServiceDbMigrationOptions,
  type MigrationBootState,
} from "./db-migration-step.js";
import { makeDbMigrationRouteHandler, MIGRATION_ROUTE_PREFIX } from "../http/migration-routes.js";
import { snapshotCallables } from "../nats/callable-registry.js";
import {
  mountPartitionMaintenanceJob,
  type PartitionMaintenanceJob,
} from "./partition-maintenance-job.js";
import {
  mountSequenceReviveJob,
  type SequenceReviveJob,
} from "./sequence-revive-job.js";

// ─── Options ───────────────────────────────────────────────────────────────

export interface MicroserviceOptions {
  /** Service name for logging and health endpoint (e.g. "emailsender"). */
  serviceName: string;
  /**
   * Owned PG schema list — declaration order, `[0]` = the primary/owned
   * schema. This is the service's schema identity AS CODE (typically the
   * service's `OWNED_SCHEMAS` const): it feeds the service_registry
   * ownership claim, the entity schema-domain assert, and the migration
   * boot step. It is deliberately NOT env-configurable — a mutated schema
   * silently bifurcates the database.
   */
  schemas: readonly string[];
  /** Human-readable name shown in service registry (e.g. "Email Sender"). */
  serviceDisplayName?: string;
  /** Service description for service registry. */
  serviceDescription?: string;
  /** Icon name for service registry (e.g. "mail"). */
  icon?: string;
  /** Icon type for service registry. */
  iconType?: "url" | "base64" | "icon";
  /** Whether the service is behind a scaler (default false). */
  isBehindScaler?: boolean;
  /** Service version — if omitted, reads from package.json in CWD. */
  serviceVersion?: string;

  /** Environment variable schema — validated via requireEnv. */
  envSchema: EnvSchema;

  /**
   * DAL init callback — called first, before everything else.
   * The SDK is DB-agnostic so the consumer provides this.
   * Typically reads DATABASE_URL / DB_SCHEMA from env and calls getDal().
   */
  initDal: () => void | Promise<void>;

  /**
   * Optional DB startup banner — called right after `initDal`, rendered
   * via `logModuleStartup` (`PostgreSQL 18.4 connected (url)`). Keeps the
   * SDK DB-agnostic: the service supplies a probe, e.g.
   * `dbBanner: () => pgServerBanner(getDal().getPool(), process.env.DATABASE_URL!)`.
   */
  dbBanner?: () => Promise<{ name: string; version?: string | null; url: string }>;

  /**
   * DAL close callback — called during graceful shutdown.
   * The SDK is DB-agnostic so the consumer provides this.
   * Typically `async () => { await getDal().close(); }`.
   */
  dalClose: () => Promise<void>;

  /**
   * Lazy accessor for the consumer-owned pg pool — REQUIRED, enforced by
   * construction: the fabric message-key provider reads vault material
   * through direct DAL (never NATS), so every microservice must expose
   * its pool. Typically `() => getDal().getPool()`. Lazy because initDal
   * has not run yet when the options object is built.
   */
  dalPool: () => SqlPoolPort;

  /**
   * Factory for ConfigRepositoryPort — called after initDal.
   * Reads config rows from the microservice's config table.
   */
  configRepositoryAdapter: () => ConfigRepositoryPort;

  /**
   * Factory for AuthConfigPort — called after ConfigLoader is created.
   * Receives the ConfigLoader so it can read auth-related config keys.
   */
  authConfigPort: (configLoader: ConfigLoader) => AuthConfigPort;

  /**
   * Factory for ApiKeyPort — called after auth config is loaded.
   * Optional — only needed if the microservice uses API key auth (e.g. webhooks).
   * Standard wiring: `new CachingApiKeyPort(new NatsApiKeyPort(3000), () => getSdkCachePort())`
   * — microservices NEVER read `public.api_keys` directly; resolution goes
   * through the governed BE route `auth.apikey.byHash`. The factory runs
   * before the SDK cache port is set, so pass `getSdkCachePort` lazily.
   */
  apiKeyPort?: () => ApiKeyPort;

  /**
   * Factory for HealthCheckPort — called after initDal.
   * Adapts the DB pool to the SDK's HealthCheckPort interface.
   */
  healthCheckPort: () => HealthCheckPort;

  /**
   * Custom route handler — MUST be produced by an approved factory
   * (`makeRpcRouter`, `makeOpenApiHandler`, `composeRouteHandlers`).
   * Arbitrary handlers are rejected at startup: the middleware chain
   * (auth → RBAC → validation → RFC 7807) is not optional.
   * If omitted, only the /health endpoint is served.
   */
  routeHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

  /**
   * Override the docs-pack dir served/declared by this service.
   * Default: `<service cwd>/dist/docs-pack` — produced by `buildDocsPack`
   * in the service's build script.
   */
  docsPackDir?: string;

  /**
   * Paths exempt from the client-identity gate — only for services with a
   * genuinely public surface (e.g. the webhook ingress, whose callers are
   * external providers). Everything else is gated by default.
   */
  identityExemptPaths?: RegExp[];
  /**
   * Internal provenance mode — defaults to "enforce" (internal-only services).
   * The BE edge passes "verify-if-present": browser traffic is unsigned by
   * nature, but cleartext identity injection is rejected and signed internal
   * traffic is verified. Never set "off" outside tests.
   */
  internalProvenance?: "enforce" | "verify-if-present" | "off";

  /**
   * Auth dependency setters — called after auth config is loaded.
   * Each setter receives (authConfig, apiKeyPort?) and typically wires
   * auth dependencies into route handlers (e.g. setAuthDependencies(cfg, apiKeyPort)).
   */
  authDependencySetters?: Array<(cfg: AuthConfig, apiKeyPort?: ApiKeyPort) => void>;

  /**
   * Service-specific endpoints (relative paths, e.g. { webhook: "/webhook" }).
   * The health endpoint is added automatically.
   * Full URLs are built as `${baseUrl}${path}` for the service registry.
   */
  endpoints?: Record<string, string>;

  /**
   * Module navigation self-declaration — the wiring that lets THIS module
   * own its FE pages. Persisted verbatim in `service_registry.endpoints.nav`
   * via `service.register`; the BE merges it into `/modules/:code/meta`,
   * `/modules` (route_prefixes) and the routes census. Declaring pages
   * inside another module's static nav registry is the anti-pattern this
   * replaces: each module presents its own nav.
   *
   * `route_prefixes` resolve the active module (longest match wins — a
   * page under a shared prefix like `/system/jobs` belongs to THIS module,
   * not to the module owning `/system`). `component_url` route fields are
   * self-described by the service (e.g. `/svc/<code>/api/v1/module-assets/…`).
   */
  nav?: ModuleNavDeclaration;

  /**
   * Module emitted-event self-declaration — `events.emits` lists the NATS
   * subjects THIS service publishes as domain events (wildcards allowed).
   * Persisted verbatim in `service_registry.endpoints.events`, served on
   * `/modules` — the decoupled vocabulary subject-pickers (job rules,
   * triggers) resolve options from. Subscriptions stay internal and are
   * never declared.
   */
  events?: ModuleEventsDecl;

  /**
   * ROOT LEVEL this module is part of (`service_registry.part_of`) —
   * 'system' for platform services, 'crm' for the CRM domain, … Combined
   * with the service code it derives the module's FE route prefix
   * `/{part_of}/{code}`; the BE rejects registration whose declared
   * route_prefixes/nav/routes live outside it. No default — a module
   * states its level explicitly.
   */
  partOf: string;

  /**
   * DEFAULT-MODULE claim for the module's root level — `true` declares
   * this service as the landing module of `partOf` (app select → this
   * module → its nav[0].href). At most one holder per root: the BE keeps
   * the existing winner on conflict (claim stored as `false`, warn-logged,
   * registration still succeeds). Declaring `false`/omitting never
   * downgrades an admin-set flag.
   */
  isDefault?: boolean;

  /**
   * i18n key for the module's localized display name — sent as `label_key`
   * in service.register and resolved by every UI surface (breadcrumbs,
   * app launcher, module menus) against this service's own translation
   * namespace. Fallback when absent/unresolved: the raw `name`.
   */
  labelKey?: string;

  /**
   * Custom health checks beyond DB — added to the HealthCheck constructor.
   * NATS check is added automatically if not provided.
   */
  customHealthChecks?: Record<string, () => Promise<HealthCheckResult>>;

  /**
   * Database migration boot step — runs immediately after `initDal`, before
   * ConfigLoader and any other table read. When set, the service owns its
   * schema patches (`db-meta/patches` + signed MANIFEST.json) and applies
   * them before registration. A critical failure boots the service in
   * DEGRADED mode: only `/health` + the db-migration admin routes answer,
   * domain traffic gets 503, heartbeat reports `db_migration.ok=false`.
   * `schemas` is injected from the top-level `schemas` option (the service
   * cannot declare a divergent list); `schema` defaults to the primary.
   */
  dbPatches?: ServiceDbMigrationOptions;

  /**
   * Partition/retention maintenance — the shared system job produced by
   * dal-pg's `makePartitionMaintenanceJob(entityRegistry)`.
   * `needed=false` (no `@Partition`/`@AuditTrail`/`@Retention` surface)
   * mounts nothing and materializes no trigger. When set and needed, the
   * `<svc>.partition_maintenance` callable is mounted inside the deferred
   * on-ready init (post-NATS, post-migrations) and the system trigger is
   * declared through the governed materialize route.
   */
  partitionMaintenance?: PartitionMaintenanceJob;

  /**
   * Shared sequence-revive job wiring — produced by dal-pg's
   * `makeSequenceReviveJob()`. The builtin `sequences` table mounts
   * unconditionally, so the `<svc>.sequence_revive` callable mounts on
   * every dal-backed service inside the deferred on-ready init
   * (post-NATS, post-migrations); the system trigger is declared
   * through the governed materialize route. The revive ALGORITHM lives
   * once in dal-pg (`dal.sequenceRevive`) — the service only hosts the
   * executor.
   */
  sequenceRevive?: SequenceReviveJob;

  /**
   * Callback fired after everything is wired (NATS subscriptions, business
   * logic init, etc.). Receives the full MicroserviceContext.
   * SKIPPED entirely when the service booted degraded (migration failure).
   */
  onReady?: (ctx: MicroserviceContext) => Promise<void>;
}

// ─── Context ───────────────────────────────────────────────────────────────

export interface MicroserviceContext {
  /** Validated environment variables (from requireEnv). */
  env: Record<string, string | undefined>;
  /** ConfigLoader instance (config loaded from DB). */
  configLoader: ConfigLoader;
  /** NatsClient singleton (connected). */
  natsClient: typeof NatsClient;
  /** ServiceRegistrar instance (registered + heartbeat started). */
  registrar: ServiceRegistrar;
  /** HealthCheck instance (wired with DB + custom checks). */
  healthCheck: HealthCheck;
  /** HTTP server instance (listening on configured port). */
  server: Server;
  /** GracefulShutdown instance (cleanup handlers installed). */
  shutdown: GracefulShutdown;
  /** Auth config (loaded from DB via AuthConfigPort). */
  authConfig: AuthConfig;
  /** API key port (if provided). */
  apiKeyPort?: ApiKeyPort;
  /** Service version (from package.json or option). */
  serviceVersion: string;
  /** Base URL (from `service_base_url` config key). */
  baseUrl: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Read service version from the deployed package.json — resolved by
 * walking up from the entry file (`detectPackageIdentity`), so it is
 * cwd-independent and always the same package as the service identity.
 */
export function readServiceVersion(): string {
  return detectPackageIdentity().version ?? "0.0.0";
}

// ─── Builder ───────────────────────────────────────────────────────────────

/**
 * Bootstrap a Primebrick microservice with minimal boilerplate.
 *
 * Orchestrates: env validation → DAL init → config load → auth config →
 * NATS connect → service register → HTTP server → graceful shutdown → onReady.
 *
 * Returns a MicroserviceContext with all wired components for the consumer
 * to use in service-specific logic (NATS subscriptions, custom endpoints, etc.).
 *
 * @throws if any critical step fails (DAL init, NATS connect). Non-critical
 *         steps (config load, auth config load) log warnings and continue.
 */
export async function createMicroservice(
  options: MicroserviceOptions,
): Promise<MicroserviceContext> {
  // 0. Async console bridge — timestamps + trace_id on every log line
  //    from the very first message. Safe under vitest (auto-skipped).
  installConsoleBridge();
  logger.info(`Starting ${options.serviceName} microservice...`, { tags: ["core"] });

  // 1. Environment validation — loud preflight: a missing .env file or
  //    missing required vars must never die silently (the logger is not
  //    guaranteed to be wired/flushed this early, so write to stderr
  //    directly AND throw for the caller's catch).
  let env: Record<string, string | undefined>;
  let dbEnv: DbEnv;
  let schemas: readonly string[];
  try {
    // Closed-set contract: DATABASE_URL is the ONLY env var a service may
    // consume (DATABASE_SCHEMA is rejected — schema identity is code).
    // Any violation crashes the boot.
    dbEnv = assertDbEnv();
    env = requireEnv(options.envSchema);
    // The declared schema list is service identity — validate it with the
    // same strictness as the env contract (boot crash on malformed names).
    schemas = assertValidSchemaList(options.schemas);
  } catch (error) {
    const envFile = join(process.cwd(), ".env");
    const missing = (error as Error).message;
    const fileHint = existsSync(envFile)
      ? `.env found at ${envFile} — the following keys are missing or empty in the environment:`
      : `NO .env file at ${envFile} — create it from .env.example (or export the vars).`;
    process.stderr.write(
      `\n[FATAL] ${options.serviceName} — environment validation failed\n` +
        `        ${fileHint}\n` +
        `        ${missing.replace(/\n/g, "\n        ")}\n\n`,
    );
    throw error;
  }

  // Resolved migration boot options — `schemas` is injected from the
  // service's declared schema list (single source; services cannot
  // declare it on dbPatches), `schema` defaults to the primary unless the
  // service overrides it explicitly.
  const dbPatches: DbMigrationBootOptions | undefined = options.dbPatches && {
    schemas: () => schemas,
    schema: () => schemas[0]!,
    ...options.dbPatches,
  };

  // 2. DAL init (consumer callback — DB-agnostic; may be async when the
  // service wires dal event emission — `wireEntityEventEmission` awaits
  // the ENTITY_EVENTS stream ensure).
  await options.initDal();
  // Warm every declared entity's dal service — `DomainService.svc` is
  // lazy, but the ref-display registry resolves join targets at query
  // time; warming here makes it complete before the first request,
  // never hit-order-dependent. Plain `EntityServiceLike` facades carry
  // no `svc` getter — the access is a harmless no-op.
  const warmable = options.routeHandler as
    | { entityDecls?: { service?: { svc?: unknown } }[] }
    | undefined;
  for (const d of warmable?.entityDecls ?? []) {
    try {
      void d.service?.svc;
    } catch {
      // registry stays cold for this decl — ref cells degrade to uuid
    }
  }
  if (options.dbBanner) {
    try {
      const banner = await options.dbBanner();
      logModuleStartup(banner.name, banner.version, banner.url);
    } catch {
      logger.warn("Database banner probe failed (connection up? /health will report)", { tags: ["core"] });
    }
  }

  // 2.5 Database migration — BEFORE any table read (ConfigLoader included).
  //     The engine reads its own mode from <schema>.config_entries; if a
  //     patch touched preloaded state, post-apply reads see fresh data by
  //     construction (ConfigLoader has not run yet).
  const migrationState: MigrationBootState = dbPatches
    ? await runDbMigrationStep(dbPatches)
    : { result: null, degraded: false, lastError: null, appliedCount: 0 };

  // 2.6 Fabric message-key provider (WP-A6) — the vault reader goes through
  //     direct DAL, NEVER NATS. Boot refresh is tolerant: on a fresh database
  //     the BE may not have provisioned the vault yet — the reactive
  //     debounced self-heal in the provider (plus the rotation-hint
  //     subscription wired after the NATS connect) closes the gap on first
  //     traffic instead of walling the boot.
  const vaultReader = new SecretVaultReader({ pool: options.dalPool(), schema: "system" });
  const messageKeyProvider = new MessageKeyProvider(() => vaultReader.readGenerations(MESSAGE_KEY_MATERIAL_REF));
  try {
    await messageKeyProvider.refresh();
  } catch (error) {
    logger.warn("fabric message-key material not readable yet — reactive self-heal will retry on first traffic", {
      tags: ["core"],
      error,
    });
  }
  setMessageKeyProvider(messageKeyProvider);

  // Deferred boot init — assigned once ctx exists (step 10). Any recovery
  // path that unlatches degraded (admin route or heartbeat auto-retry)
  // completes the skipped onReady + callable re-register here; on failure
  // it retries on the next heartbeat. `recoveryInFlight` serializes ticks.
  let deferredOnReady: (() => Promise<void>) | undefined;
  let recoveryInFlight = false;
  const attemptMigrationRecovery = async () => {
    if (recoveryInFlight || !dbPatches || !deferredOnReady) return;
    recoveryInFlight = true;
    try {
      if (migrationState.degraded) {
        const actor = `auto-remediation:${options.serviceName}`;
        const flipped = await dbPatches.engine.retryFailedPatches(
          dbPatches.pool(),
          dbPatches.schema?.() ?? schemas[0]!,
          actor,
        );
        if (flipped > 0) {
          logger.warn(`db-migration: auto-remediation reset ${flipped} failed patch(es) to pending`, {
            tags: ["db-migration"],
          });
        }
        const result = await rerunMigrations(dbPatches, migrationState, actor);
        if (result.degraded) return;
        logger.done(
          "db-migration: auto-remediation cleared degraded state — completing boot init",
          { tags: ["db-migration"] },
        );
      }
      // Clean state (recovered just now or earlier): finish any pending
      // init — no-op once completed.
      await deferredOnReady();
    } catch (error) {
      logger.warn("db-migration: auto-remediation/init attempt failed — will retry on next heartbeat", {
        tags: ["db-migration"],
        error,
      });
    } finally {
      recoveryInFlight = false;
    }
  };

  // 3. ConfigLoader (reads config table via ConfigRepositoryPort)
  const configLoader = new ConfigLoader(options.configRepositoryAdapter());
  try {
    const loaded = await configLoader.load();
    logger.done(`Module configuration loaded — ${Object.keys(loaded).length} keys found (${schemas[0]}.config_entries)`, { tags: ["core"] });
  } catch (error) {
    logger.error("Failed to load config (non-fatal — table may be empty)", { tags: ["core"], error: error });
  }

  // 4. Auth config initialization
  const authConfigPort = options.authConfigPort(configLoader);
  initAuthConfig(authConfigPort);
  try {
    await loadAuthConfig();
    logger.done("Auth settings resolved", { tags: ["core"] });
  } catch (error) {
    logger.error("Failed to load auth config (non-fatal — config table may be empty)", { tags: ["core"], error: error });
  }

  // 5. Auth dependency wiring
  let apiKeyPort: ApiKeyPort | undefined;
  let authConfig: AuthConfig;
  try {
    authConfig = getAuthConfig();
    if (options.apiKeyPort) {
      apiKeyPort = options.apiKeyPort();
    }
    if (options.authDependencySetters) {
      for (const setter of options.authDependencySetters) {
        setter(authConfig, apiKeyPort);
      }
    }
  } catch (error) {
    logger.error("Failed to wire auth dependencies (non-fatal)", { tags: ["core"], error: error });
    authConfig = getAuthConfig();
  }

  // 6. NATS connection (URL from config table)
  const natsUrl = configLoader.require("nats_url");
  try {
    await NatsClient.getConnection(natsUrl);
  } catch (error) {
    logger.error("Failed to connect to NATS", { tags: ["core"], error: error });
    process.exit(1);
  }

  // 6b. Shared config + telemetry (BE-owned config, distributed via NATS).
  //     Telemetry init is non-fatal: a bad config must never crash a service.
  const serviceVersionEarly = options.serviceVersion ?? readServiceVersion();
  const applyTelemetry = (t: TelemetrySharedConfig | undefined): void => {
    const cfg: TelemetryConfig = {
      enabled: t?.enabled ?? false,
      otlp_endpoint: t?.otlp_endpoint,
      otlp_headers: t?.otlp_headers,
      sampler: t?.sampler,
      sampler_arg: t?.sampler_arg,
    };
    void restartTelemetry(cfg, options.serviceName, serviceVersionEarly);
    // Logger identity stays package.json-derived (logger.ts) — never
    // override `service` here or the tag would flip mid-boot.
    setLogOptions({
      level: t?.log_level,
      format: t?.log_format,
    });
  };
  // Internal HTTP client (B11): all service-to-service fetches go through
  // `internalFetch` — identity headers are injected automatically and can
  // never be forgotten or overridden by the caller. MUST run before any
  // callNats (config.get, service.register): the BE's shield check reads
  // these headers.
  // Resolve service coordinates EARLY — the identity closure below captures
  // serviceCode; every callNats (client_shield_registry.get, secret.get, register)
  // invokes it, so these must be initialized before the first NATS call.
  // serviceCode is STATIC identity: package.json "service_code" or the
  // `primebrick-<code>` name derivation — never runtime-editable config.
  // A `service_code` config row survives only as a drift tripwire: when it
  // disagrees with the static identity, boot fails loudly.
  const selfIdentity = detectPackageIdentity();
  const serviceCode = resolveServiceCode(selfIdentity, configLoader.get("service_code"));
  setCurrentServiceCode(serviceCode);

  // Builtin nav mount — entity-registry leaves contributed by registered
  // providers (dal-pg sequences today) merge into the module's nav BY
  // CONSTRUCTION, appended LAST inside their sibling. Same invariant as
  // the route mount: module-authored collisions are a boot error.
  const nav = mergeBuiltinNav(options.nav, schemas);

  // Docs emit — the service documents itself from THIS options object
  // (nav + the route handler's .entityDecls/.spec brands), never a
  // parallel docs config: a route/entity added to the service is in the
  // docs by construction. Three modes on one code path:
  //   `--emit-docs`        unconditional emit → exit — every service's
  //                        `generate:docs` is literally this command.
  //   `--emit-docs --check` fresh emit diffed vs committed generated/ —
  //                        the release-close freshness gate (exit 1 on drift).
  //   normal boot           emit only when generation inputs are newer
  //                        than the pack — the `docs_pack` capability is
  //                        always backed by a fresh pack in dev, and the
  //                        pack is assembled before registration.
  const docsPackDir = options.docsPackDir ?? join(process.cwd(), "dist", "docs-pack");
  const emitFlag = process.argv.includes("--emit-docs");
  const emitCheck = process.argv.includes("--check");
  const branded = options.routeHandler as
    | (RouteHandler & { entityDecls?: EntityRouteDecl[]; spec?: Record<string, unknown> })
    | undefined;
  if (emitFlag || emitCheck || docsPackStale(process.cwd(), docsPackDir)) {
    const emitResult = await emitServiceDocs({
      service_root: process.cwd(),
      service_code: serviceCode,
      ...(nav ? { nav } : {}),
      ...(branded?.entityDecls ? { entity_decls: branded.entityDecls } : {}),
      ...(branded?.spec ? { spec: branded.spec } : {}),
      own_schemas: [...schemas],
      pack_dir: docsPackDir,
      check: emitCheck,
    });
    if (emitFlag || emitCheck) {
      await options.dalClose();
      process.exit(emitCheck && emitResult.drift.length ? 1 : 0);
    }
  }

  const baseUrl = configLoader.require("service_base_url");
  const serviceVersion = options.serviceVersion ?? readServiceVersion();
  const clientKey = configLoader.get("service_client_shield_key");
  const keyDerivationSecret = configLoader.get("service_key_derivation_secret");
  const uaPrefix = `${selfIdentity.name}/${serviceVersion}`;
  /**
   * Shared acked-generation slot (B14): the registrar writes the generation
   * of each successful register; the header closure keeps deriving it until
   * the post-rotation handshake lands — during a rotation the old
   * (grace-windowed) key keeps outbound calls alive while the new one is
   * being enrolled. Zero-gap.
   */
  const generationSlot: { value?: number } = {};
  const outboundClientKey = (): string | null => {
    if (keyDerivationSecret) {
      const generation = generationSlot.value ?? clientShieldRegistry.generationFor(uaPrefix);
      return deriveClientKey(keyDerivationSecret, uaPrefix, generation);
    }
    return clientKey;
  };
  configureInternalClient(() => {
    const key = outboundClientKey();
    return {
      "User-Agent": buildUserAgent(selfIdentity, serviceCode),
      ...(key ? { [CLIENT_SHIELD_KEY_HEADER]: key } : {}),
    };
  });
  if (clientKey || keyDerivationSecret) {
    logger.done(`The service ${selfIdentity.name}/${selfIdentity.version ?? "?"} shield key enrolled`, { tags: ["core"] });
  }

  // Client-identity registry (B11): drives BOTH the HTTP client gate and
  // the NATS publisher shield (verifyNatsPublisher). Must start before any
  // shielded NATS subscription — fail-closed: an unavailable registry
  // means every internal call is rejected, loudly.
  const clientShieldRegistry = new ClientShieldRegistry();
  setNatsShieldRegistry(clientShieldRegistry);
  try {
    await clientShieldRegistry.start();
  } catch (error) {
    logger.error("Client registry unavailable — internal calls will be rejected (fail-closed)", {
      tags: ["core"],
      error,
    });
  }

  // Rotating secrets: provision `service_client_shield_secret` (global scope) from the BE
  // owner via the governed `secret.get` correlation route, and keep the
  // in-memory slot fresh on every `secret.rotated` broadcast. The slot feeds
  // BOTH sides of the wire — outbound header stamping and inbound verify —
  // so the shared secret never lives in config_entries or on disk.
  const secretProvider = new SecretProvider();
  try {
    await startSecretProvider(secretProvider);
    await secretProvider.get(CLIENT_SHIELD_SECRET_REF);
  } catch (error) {
    logger.warn("The secret engine is unreachable — falling back to the static client-shield secret from config", {
      tags: ["core"],
      error,
    });
    // Self-heal: without the rotating secret every shield-verified inbound
    // call is rejected — a boot-time miss must not become a permanent wall.
    // Same unbounded retry the secret.rotated consumer path uses (deduped:
    // a broadcast landing mid-retry coalesces into this loop).
    void refreshSecretWithRetry(secretProvider, CLIENT_SHIELD_SECRET_REF);
  }

  // Vault rotation hints (WP-A6) — metadata-only broadcast on the DEDICATED
  // subject: the correct consumer reaction is a direct-DAL re-read, never a
  // secret.get fetch. Unqueued broadcast: every instance must refresh its
  // key window. Hint loss is irrelevant by construction — the provider's
  // reactive debounced self-heal re-reads on the first message that meets
  // a generation it does not know.
  await subscribeShielded(VAULT_SUBJECTS.ROTATED, async (payload) => {
    const hint = payload as { scope?: string; name?: string };
    if (hint.scope === MESSAGE_KEY_MATERIAL_REF.scope && hint.name === MESSAGE_KEY_MATERIAL_REF.name) {
      await messageKeyProvider.refresh();
    }
  });

  try {
    // The BE registers its `config.get` responder after NATS connect — a
    // microservice that starts concurrently can hit the race where no
    // responder exists yet. Retry briefly before degrading to no-config.
    let shared = await fetchSharedConfig(NatsClient);
    for (let attempt = 0; attempt < 4 && !shared.redis_url && !shared.telemetry; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      shared = await fetchSharedConfig(NatsClient);
    }
    setSharedConfig(shared);
    const globalKeys = [
      shared.redis_url ? "redis_url" : null,
      shared.telemetry ? "telemetry" : null,
    ].filter((k): k is string => k !== null);
    logger.done(
      `Global configuration received from BE — ${globalKeys.length} keys found (${globalKeys.join(", ") || "none"})`,
      { tags: ["core"] },
    );
    await initTelemetry(
      {
        enabled: shared.telemetry?.enabled ?? false,
        otlp_endpoint: shared.telemetry?.otlp_endpoint,
        otlp_headers: shared.telemetry?.otlp_headers,
        sampler: shared.telemetry?.sampler,
        sampler_arg: shared.telemetry?.sampler_arg,
      },
      options.serviceName,
      serviceVersionEarly,
    );
    setLogOptions({
      level: shared.telemetry?.log_level,
      format: shared.telemetry?.log_format,
    });
    // Redis cache (best-effort) — reuses the shared config just fetched.
    // Sets the SDK cache-port holder so adapters can call getSdkCachePort().
    let { cachePort, redisInfo } = await initCacheFromSharedConfig(
      NatsClient,
      console,
      shared,
    );
    setSdkCachePort(cachePort, redisInfo);

    // Hot-reload: BE broadcasts config.changed on config writes.
    await subscribeConfigChanged(NatsClient, async () => {
      try {
        // Local config_entries may also have changed — reload the cache and
        // re-resolve auth config so gateway/secret changes take effect
        // without a restart.
        await configLoader.load();
        invalidateAuthConfig();
        await loadAuthConfig();
        const fresh = await fetchSharedConfig(NatsClient);
        setSharedConfig(fresh);
        applyTelemetry(fresh.telemetry);
        // If redis_url was missed at startup (BE race) or has been added
        // since, bring the cache online without a restart.
        if (!cachePort && fresh.redis_url) {
          const boot = await initCacheFromSharedConfig(NatsClient, console, fresh);
          cachePort = boot.cachePort;
          redisInfo = boot.redisInfo;
          setSdkCachePort(cachePort, redisInfo);
        }
      } catch (err) {
        logger.error("failed to apply config.changed", { tags: ["core"], error: err });
      }
    });
  } catch (error) {
    logger.error("init failed (non-fatal)", { tags: ["core"], error: error });
  }

  // 7. ServiceRegistrar — serviceCode/baseUrl/serviceVersion resolved above.
  const healthCheckPort = options.healthCheckPort();

  // Build endpoints: merge service-specific + automatic health
  const registrarEndpoints: Record<string, unknown> = {
    health: `${baseUrl}/health`,
  };
  if (options.endpoints) {
    for (const [key, path] of Object.entries(options.endpoints)) {
      registrarEndpoints[key] = `${baseUrl}${path}`;
    }
  }
  // Module nav self-declaration — verbatim object (not a URL path): the BE
  // merges endpoints.nav into module meta + routes census.
  if (nav) {
    registrarEndpoints.nav = nav;
  }

  // Module emitted-event self-declaration — verbatim object riding the same
  // channel as nav: persisted in service_registry.endpoints.events, served
  // on /modules. Domain subject pickers resolve options from the census.
  // Entity-domain events AUTO-DECLARE: every served entity emits
  // `events.<code>.<entity>.>` by construction (dal-pg repo write path +
  // wireEntityEventEmission) — explicit `options.events.emits` merge on
  // top; the census offers the subjects to trigger forms without any
  // hand-maintained vocabulary.
  {
    const autoEmits = (branded?.entityDecls ?? []).map((d) => ({
      subject: `events.${serviceCode}.${d.entityName}.>`,
      // Humanized pickers by construction: the label reuses the entity's
      // OWN `.singular` key (e.g. "Cliente"), the schema types the
      // before/after/delta snapshots from meta columns, and `entity`
      // marks where the snapshot lives in the payload.
      label_key: `${d.meta?.entities_ns ?? "system"}.entities.${d.meta?.translation_key ?? d.entityName}.singular`,
      payload_schema: entityEventPayloadSchema(d.meta),
      entity: { key: "after", entity: d.entityName },
    }));
    const declared = (options.events?.emits ?? []) as { subject: string }[];
    const seen = new Set(declared.map((e) => e.subject));
    const emits = [...autoEmits.filter((e) => !seen.has(e.subject)), ...declared];
    if (emits.length || options.events) {
      registrarEndpoints.events = { ...options.events, emits };
    }
  }

  // Entity self-declaration — the entity names this service owns, derived
  // from the SAME entityDecls that produce its CRUD routes. Persisted in
  // service_registry.endpoints.entities and served on /modules: the FE
  // resolves entity→service (ref-sheet drill-through, api base prefixes)
  // from the discovery document — never a hand-maintained map.
  if (branded?.entityDecls?.length) {
    registrarEndpoints.entities = branded.entityDecls.map((d) => d.entityName);
  }

  // Docs pack dir — shared between the registrar (capability) and the
  // auto-mounted serving route below (computed once, at the emit step).
  // Build health check function for registrar heartbeats
  const registrarHealthCheckFn: HealthCheckFn = async () => {
    const dbOk = await healthCheckPort.ping();
    // Self-heal: while degraded, every heartbeat retries the failed
    // migrations — a successful run unlatches the 503 gate (live-read) and
    // completes the skipped onReady init: a reboot without shutdown.
    if (dbOk) await attemptMigrationRecovery();
    const natsOk = NatsClient.isConnected();
    return {
      // A degraded service is not healthy for domain traffic even when the
      // DB itself answers — status never reaches `online`.
      http_healthy: dbOk && !migrationState.degraded,
      checks: {
        db: { ok: dbOk },
        nats: { ok: natsOk },
        // Live-read: a successful admin retry flips this without restart.
        db_migration: {
          ok: !migrationState.degraded,
          ...(migrationState.degraded
            ? { error: migrationState.lastError ?? "critical patch failure" }
            : {}),
        },
      },
    };
  };

  const registrar = new ServiceRegistrar(
    NatsClient,
    {
      serviceCode,
      baseUrl,
      endpoints: registrarEndpoints,
      partOf: options.partOf,
      isDefault: options.isDefault,
      labelKey: options.labelKey,
      service_version: serviceVersion,
      name: options.serviceDisplayName,
      description: options.serviceDescription,
      is_behind_scaler: options.isBehindScaler ?? false,
      icon: options.icon,
      icon_type: options.iconType,
      // Per-service client key from module config (never env).
      clientKey: configLoader.get("service_client_shield_key") ?? undefined,
      // Derived-key mode (B14): `service_key_derivation_secret` — the service
      // derives its key as HMAC(secret, ua_prefix:generation); a BE rotate
      // bumps the generation and this registrar re-enrolls automatically.
      keyDerivationSecret: keyDerivationSecret ?? undefined,
      registryGeneration: () => clientShieldRegistry.generationFor(uaPrefix),
      generationSlot,
      // API gateway endpoint — shown as a log tag on register/heartbeat.
      // Required module config: it is also the identity of the only public
      // ingress this service talks to; a missing value is a misconfigured
      // module, not an optional nicety.
      gatewayUrl: configLoader.require("be_base_url"),
      // Docs pack lives next to the service entry (dist/docs-pack at the
      // service root) — present → docs_pack capability auto-declared.
      docsPackDir,
      // Schema ownership claim — the service's declared schema list
      // (code constant, step 1). The BE enforces one-module-one-schema.
      schemas: [...schemas],
      // Static code provenance — the BE re-derives `derived` codes and
      // rejects mismatches; `override` = explicit package.json service_code.
      codeSource: selfIdentity.service_code ? "override" : "derived",
    },
    registrarHealthCheckFn,
  );

  // Derived-key rotation (B14): when the BE bumps this service's
  // key_generation (rotate endpoint), the registry reload notifies the
  // registrar → re-register with the newly derived key. Until the ack
  // lands, outbound calls keep using the acked (grace-windowed) key.
  clientShieldRegistry.addChangeListener(() =>
    registrar.onRegistryChanged(clientShieldRegistry.generationFor(uaPrefix)),
  );

  // 8. HTTP server + HealthCheck
  // Build custom health checks — include NATS check automatically
  const customChecks: Record<string, () => Promise<HealthCheckResult>> = {
    nats: async () => {
      const ok = NatsClient.isConnected();
      return { ok, ...(ok ? {} : { error: "NATS connection is not alive" }) };
    },
    ...(options.customHealthChecks ?? {}),
  };

  const healthCheck = new HealthCheck(healthCheckPort, customChecks);
  const httpPort = parseInt(configLoader.require("http_port"), 10);
  // Deterministic bind: 0.0.0.0 production / 127.0.0.1 dev — no opt-in.

  // Route-handler enforcement — the service surface is closed-by-design:
  // only factory-produced handlers (makeRpcRouter / makeOpenApiHandler /
  // composeRouteHandlers) may be mounted. Anything else means a route
  // bypassed the mandatory middleware chain — fail the boot, loudly.
  // Auto-mount the docs-pack route when a built pack exists — the same
  // manifest that makes the registrar declare `docs_pack`. Services never
  // wire this by hand; building the pack is the only opt-in.
  let routeHandler: RouteHandler | undefined = options.routeHandler;
  if (existsSync(join(docsPackDir, "manifest.json"))) {
    routeHandler = routeHandler
      ? composeRouteHandlers(routeHandler, docsPackRouteHandler(docsPackDir))
      : docsPackRouteHandler(docsPackDir);
  }

  // db_patch system module — always mounted when migrations are configured
  // (status surface for the FE admin page, and the ONLY reachable surface
  // when the service is degraded).
  if (dbPatches) {
    const migrationHandler = makeDbMigrationRouteHandler(
      dbPatches,
      migrationState,
      async () => {
        await deferredOnReady?.();
      },
    );
    routeHandler = routeHandler
      ? composeRouteHandlers(migrationHandler, routeHandler)
      : migrationHandler;
  }

  if (routeHandler && !isFactoryRouteHandler(routeHandler)) {
    throw new Error(
      `createMicroservice(${options.serviceName}): routeHandler was not produced by an ` +
        `approved route factory. Mount routes via makeRpcRouter([...RpcRoute]) ` +
        `(or composeRouteHandlers of factory-produced handlers) — arbitrary ` +
        `(req, res, url) => boolean functions are rejected.`,
    );
  }

  // Degraded gate — a critical migration failure must never serve domain
  // traffic. Everything except the remediation surface answers 503. The
  // flag is read live per request: a successful remediation (admin route
  // or heartbeat auto-recovery) reopens traffic without a restart.
  if (dbPatches && routeHandler) {
    const inner = routeHandler;
    routeHandler = brandRouteHandler(async (req, res, url) => {
      if (!migrationState.degraded || url.pathname.startsWith(MIGRATION_ROUTE_PREFIX)) {
        return inner(req, res, url);
      }
      res.writeHead(503, { "content-type": "application/problem+json" });
      res.end(
        JSON.stringify({
          type: "https://primebrick.io/errors/db_migration_failed",
          title: "Service Unavailable",
          status: 503,
          detail: `service '${options.serviceName}' is degraded — a database migration failed; an admin can remediate via ${MIGRATION_ROUTE_PREFIX}`,
          internal_code: "DB_MIGRATION_FAILED",
        }),
      );
      return true;
    });
  }

  const server = await createHttpServer({
    port: httpPort,
    healthCheck,
    serviceName: options.serviceName,
    serviceVersion,
    serviceUrl: baseUrl,
    routeHandler,
    clientShieldRegistry,
    identityExemptPaths: options.identityExemptPaths,
    internalProvenance: options.internalProvenance ?? "enforce",
  });

  // 8b. Register AFTER the HTTP server is listening — the BE discovers
  // this service's entities by fetching its OpenAPI spec the moment the
  // register lands; registering before listen() would always race it.
  // register() is a req/reply handshake with 5s retry — it resolves only
  // when the BE acks. No ack = no heartbeats = the service is dead to
  // the system.
  try {
    await registrar.register();
  } catch (error) {
    logger.error("Failed to register service", { tags: ["core"], error: error });
  }
  registrar.startHeartbeat();

  // 9. GracefulShutdown
  const shutdown = new GracefulShutdown(options.serviceName);
  shutdown.addCleanup(async () => { registrar.stopHeartbeat(); });
  shutdown.addCleanup(async () => { await registrar.unregister(); });
  shutdown.addCleanup(async () => { await NatsClient.close(); });
  shutdown.addCleanup(async () => { await options.dalClose(); });
  shutdown.addCleanup(async () => { await shutdownTelemetry(); });
  shutdown.addCleanup(async () => { flushLogsSync(); });
  shutdown.addCleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  shutdown.install();

  // 10. onReady callback (consumer business logic) — in degraded mode it
  // is DEFERRED, not lost: subscribers and domain init must not run against
  // a schema whose migrations failed. The deferred init below runs on a
  // successful remediation (admin route or heartbeat auto-recovery) — a
  // reboot without shutdown. Promise-memoized: concurrent unlatch paths
  // share one in-flight init; failure clears it so the next tick retries.
  const ctx: MicroserviceContext = {
    env,
    configLoader,
    natsClient: NatsClient,
    registrar,
    healthCheck,
    server,
    shutdown,
    authConfig,
    apiKeyPort,
    serviceVersion,
    baseUrl,
  };

  deferredOnReady = makeRunOnceInit(async () => {
    if (options.onReady) await options.onReady(ctx);
    // Shared maintenance job — mounted before the census below so its
    // callable is registered in the same payload-schema sweep. Gated by
    // metadata (`needed`): a service with no maintained surface gets no
    // callable and no trigger.
    if (options.partitionMaintenance?.needed) {
      await mountPartitionMaintenanceJob(options.partitionMaintenance);
    } else if (options.partitionMaintenance) {
      logger.info(
        "partition_maintenance: no maintained surface in entity registry — job not declared",
        { tags: ["jobs"] },
      );
    }
    // Shared sequence-revive job — same mount contract: the callable is
    // registered in the same payload-schema census; `needed` gates on
    // sequence-surface ownership.
    if (options.sequenceRevive?.needed) {
      await mountSequenceReviveJob(options.sequenceRevive);
    } else if (options.sequenceRevive) {
      logger.info(
        "sequence_revive: no sequence surface in entity registry — job not declared",
        { tags: ["jobs"] },
      );
    }
    // Callable census — makeNatsRoutes subscriptions run inside onReady,
    // AFTER the initial register() (NATS routes need a live connection).
    // Any route declared with payload_schema was collected by the
    // callable registry; a second register carries endpoints.callables
    // to the gateway so rule/scheduling pickers see real, subscribed
    // destinations.
    const callables = snapshotCallables();
    if (callables.length > 0) {
      registrarEndpoints.callables = { callables };
      await registrar.register();
    }
  });

  if (!migrationState.degraded) {
    await deferredOnReady();
  } else {
    logger.error(
      `Service '${options.serviceName}' booted DEGRADED (db migration failed) — domain routes 503, init deferred. Remediate via ${MIGRATION_ROUTE_PREFIX}/* (admin) or wait for heartbeat auto-recovery.`,
      { tags: ["core", "db-migration"], error: migrationState.lastError },
    );
  }

  return ctx;
}

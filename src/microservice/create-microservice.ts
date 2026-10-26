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
import { SecretProvider, startSecretProvider } from "../secrets/rotating-secret.js";
import { CLIENT_SHIELD_SECRET_REF, getClientShieldSecretSlot } from "../auth/client-shield-secret.js";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { composeRouteHandlers, type RouteHandler } from "../http/rpc-router.js";
import { docsPackRouteHandler } from "../docs-pack/serve-docs-pack.js";
import {
  ConfigLoader,
  ServiceRegistrar,
  GracefulShutdown,
  NatsClient,
  createHttpServer,
  HealthCheck,
  requireEnv,
  assertDbEnv,
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
  buildUserAgent,
  deriveClientKey,
  logModuleStartup,
  CLIENT_SHIELD_KEY_HEADER,
  isFactoryRouteHandler,
  brandRouteHandler,
} from "../index.js";
import type { TelemetryConfig } from "../telemetry/otel.js";
import type { ModuleNavDeclaration } from "@primebrick/core";
import type { TelemetrySharedConfig } from "../config/shared-config.js";
import {
  runDbMigrationStep,
  type DbMigrationBootOptions,
  type MigrationBootState,
} from "./db-migration-step.js";
import { makeDbMigrationRouteHandler, MIGRATION_ROUTE_PREFIX } from "../http/migration-routes.js";

// ─── Options ───────────────────────────────────────────────────────────────

export interface MicroserviceOptions {
  /** Service name for logging and health endpoint (e.g. "emailsender"). */
  serviceName: string;
  /** Human-readable name shown in service registry (e.g. "Email Sender"). */
  serviceDisplayName?: string;
  /** Service description for service registry. */
  serviceDescription?: string;
  /** Icon name for service registry (e.g. "mail"). */
  icon?: string;
  /** Icon type for service registry. */
  iconType?: "url" | "svg" | "base64" | "icon";
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
  initDal: () => void;

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
   */
  dbPatches?: DbMigrationBootOptions;

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
  try {
    // Closed-set contract: DATABASE_URL + DATABASE_SCHEMA are the ONLY
    // env vars a service may consume. Any violation crashes the boot.
    dbEnv = assertDbEnv();
    env = requireEnv(options.envSchema);
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

  // 2. DAL init (consumer callback — DB-agnostic)
  options.initDal();
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
  const migrationState: MigrationBootState = options.dbPatches
    ? await runDbMigrationStep(options.dbPatches)
    : { result: null, degraded: false, lastError: null, appliedCount: 0 };

  // 3. ConfigLoader (reads config table via ConfigRepositoryPort)
  const configLoader = new ConfigLoader(options.configRepositoryAdapter());
  try {
    const loaded = await configLoader.load();
    logger.done(`Module configuration loaded — ${Object.keys(loaded).length} keys found (${dbEnv.schemas[0]}.config_entries)`, { tags: ["core"] });
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
    // Retry in the background until the slot lands (bounded; the
    // secret.rotated broadcast may also heal it earlier).
    void (async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 1; attempt <= 30 && !getClientShieldSecretSlot(); attempt++) {
        await sleep(10_000);
        try {
          await secretProvider.get(CLIENT_SHIELD_SECRET_REF);
          logger.info("Client-shield secret provisioned on background retry", { tags: ["core"] });
          break;
        } catch {
          // engine still unreachable — keep waiting
        }
      }
      if (!getClientShieldSecretSlot()) {
        logger.error("Client-shield secret still missing after background retries — every shielded call will be rejected until rotation or restart", { tags: ["core"] });
      }
    })();
  }

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
  if (options.nav) {
    registrarEndpoints.nav = options.nav;
  }

  // Docs pack dir — shared between the registrar (capability) and the
  // auto-mounted serving route below. One detection, one source of truth.
  const docsPackDir = options.docsPackDir ?? join(process.cwd(), "dist", "docs-pack");

  // Build health check function for registrar heartbeats
  const registrarHealthCheckFn: HealthCheckFn = async () => {
    const dbOk = await healthCheckPort.ping();
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
      // Schema ownership claim — the validated DATABASE_SCHEMA list from
      // the env contract (step 2). The BE enforces one-module-one-schema.
      schemas: dbEnv.schemas,
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
  if (options.dbPatches) {
    const migrationHandler = makeDbMigrationRouteHandler(options.dbPatches, migrationState);
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
  // traffic. Everything except the remediation surface answers 503.
  if (migrationState.degraded && routeHandler) {
    const inner = routeHandler;
    routeHandler = brandRouteHandler(async (req, res, url) => {
      if (url.pathname.startsWith(MIGRATION_ROUTE_PREFIX)) return inner(req, res, url);
      res.writeHead(503, { "content-type": "application/problem+json" });
      res.end(
        // standards-exempt: ext-json — RFC7807 problem+json is plain JSON by spec
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

  // 10. onReady callback (consumer business logic) — skipped in degraded
  // mode: subscribers and domain init must not run against a schema whose
  // migrations failed.
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

  if (options.onReady && !migrationState.degraded) {
    await options.onReady(ctx);
  } else if (migrationState.degraded) {
    logger.error(
      `Service '${options.serviceName}' booted DEGRADED (db migration failed) — domain routes 503, onReady skipped. Remediate via ${MIGRATION_ROUTE_PREFIX}/* (admin).`,
      { tags: ["core", "db-migration"], error: migrationState.lastError },
    );
  }

  return ctx;
}

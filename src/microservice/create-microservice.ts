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
 *     SERVICE_BASE_URL: { required: false, default: "http://localhost:3005", description: "Exposed URL" },
 *   },
 *   initDal,
 *   configRepositoryAdapter: () => new ConfigRepositoryAdapter(),
 *   authConfigPort: (configLoader) => new MyAuthConfigPort(configLoader),
 *   apiKeyPort: () => new MyApiKeyPort(),
 *   healthCheckPort: () => new HealthCheckAdapter(getDal().getPool()),
 *   routeHandler: compositeRouteHandler,
 *   endpoints: { webhook: "/webhook" },
 *   authDependencySetters: [(cfg, apiKeyPort) => { /* wire auth *\/ }],
 *   onReady: async (ctx) => { /* subscribe to NATS, etc. *\/ },
 * });
 * ```
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import {
  ConfigLoader,
  ServiceRegistrar,
  GracefulShutdown,
  NatsClient,
  createHttpServer,
  HealthCheck,
  requireEnv,
  initAuthConfig,
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
} from "../index.js";

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
   */
  apiKeyPort?: () => ApiKeyPort;

  /**
   * Factory for HealthCheckPort — called after initDal.
   * Adapts the DB pool to the SDK's HealthCheckPort interface.
   */
  healthCheckPort: () => HealthCheckPort;

  /**
   * Custom route handler — receives req/res, returns true if handled.
   * If omitted, only the /health endpoint is served.
   */
  routeHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

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
   * Custom health checks beyond DB — added to the HealthCheck constructor.
   * NATS check is added automatically if not provided.
   */
  customHealthChecks?: Record<string, () => Promise<HealthCheckResult>>;

  /**
   * Callback fired after everything is wired (NATS subscriptions, business
   * logic init, etc.). Receives the full MicroserviceContext.
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
  /** Base URL (from env.SERVICE_BASE_URL). */
  baseUrl: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Read service version from package.json in the current working directory.
 * Works because the microservice's CWD is its own root directory
 * (both in dev with `bun --hot` and in Docker with WORKDIR set).
 */
export function readServiceVersion(): string {
  try {
    const pkgPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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
  console.log(`Starting ${options.serviceName} microservice...`);

  // 1. Environment validation
  const env = requireEnv(options.envSchema);

  // 2. DAL init (consumer callback — DB-agnostic)
  options.initDal();

  // 3. ConfigLoader (reads config table via ConfigRepositoryPort)
  const configLoader = new ConfigLoader(options.configRepositoryAdapter());
  try {
    await configLoader.load();
    console.log("Config loaded from DB");
  } catch (error) {
    console.error("Failed to load config (non-fatal — table may be empty):", error);
  }

  // 4. Auth config initialization
  const authConfigPort = options.authConfigPort(configLoader);
  initAuthConfig(authConfigPort);
  try {
    await loadAuthConfig();
    console.log("Auth config loaded");
  } catch (error) {
    console.error("Failed to load auth config (non-fatal — config table may be empty):", error);
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
    console.error("Failed to wire auth dependencies (non-fatal):", error);
    authConfig = getAuthConfig();
  }

  // 6. NATS connection (URL from config table)
  const natsUrl = configLoader.require("nats_url");
  try {
    await NatsClient.getConnection(natsUrl);
    console.log("NATS connection established");
  } catch (error) {
    console.error("Failed to connect to NATS:", error);
    process.exit(1);
  }

  // 7. ServiceRegistrar
  const baseUrl = env.SERVICE_BASE_URL!;
  const serviceCode = configLoader.require("service_code");
  const serviceVersion = options.serviceVersion ?? readServiceVersion();
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

  // Build health check function for registrar heartbeats
  const registrarHealthCheckFn: HealthCheckFn = async () => {
    const dbOk = await healthCheckPort.ping();
    const natsOk = NatsClient.isConnected();
    return {
      http_healthy: dbOk,
      checks: {
        db: { ok: dbOk },
        nats: { ok: natsOk },
      },
    };
  };

  const registrar = new ServiceRegistrar(
    NatsClient,
    {
      serviceCode,
      baseUrl,
      endpoints: registrarEndpoints,
      service_version: serviceVersion,
      name: options.serviceDisplayName,
      description: options.serviceDescription,
      is_behind_scaler: options.isBehindScaler ?? false,
      icon: options.icon,
      icon_type: options.iconType,
    },
    registrarHealthCheckFn,
  );

  try {
    await registrar.register();
    console.log("Service registered via NATS");
  } catch (error) {
    console.error("Failed to register service:", error);
  }
  registrar.startHeartbeat();
  console.log("Heartbeat started");

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
  const server = await createHttpServer({
    port: httpPort,
    healthCheck,
    serviceName: options.serviceName,
    serviceVersion,
    serviceUrl: baseUrl,
    routeHandler: options.routeHandler,
  });

  console.log(`${options.serviceName} microservice started successfully`);

  // 9. GracefulShutdown
  const shutdown = new GracefulShutdown(options.serviceName);
  shutdown.addCleanup(async () => { registrar.stopHeartbeat(); });
  shutdown.addCleanup(async () => { await registrar.unregister(); });
  shutdown.addCleanup(async () => { await NatsClient.close(); });
  shutdown.addCleanup(async () => { await options.dalClose(); });
  shutdown.addCleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  shutdown.install();

  // 10. onReady callback (consumer business logic)
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

  if (options.onReady) {
    await options.onReady(ctx);
  }

  return ctx;
}

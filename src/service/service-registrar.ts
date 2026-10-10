import { NatsClient } from "../nats/nats-client.js";
import { detectPackageIdentity, clientKeyHash } from "./service-identity.js";
import { logger } from "../lifecycle/logger.js";
import {
  SERVICE_SUBJECTS,
  type ServiceRegisterPayload,
  type ServiceHeartbeatPayload,
  type ServiceUnregisterPayload,
  type ServiceHealthCheck,
} from "./service-lifecycle-subjects.js";

export interface ServiceRegistrarConfig {
  serviceCode: string;
  baseUrl: string;
  endpoints: Record<string, unknown>;
  heartbeatIntervalMs?: number;
  name?: string;
  description?: string;
  author?: string;
  github_repo_url?: string;
  service_version?: string;
  is_behind_scaler?: boolean;
  icon?: string;
  icon_type?: 'url' | 'svg' | 'base64' | 'icon';
  /**
   * This service's own client key (module config `service_client_shield_key`) — paired with
   * the UA prefix in `system.client_registry`. Only its sha256 hash is sent
   * in `service.register`; the raw key never leaves the service.
   */
  clientKey?: string;
  /**
   * API gateway base URL (the BE, e.g. `http://localhost:3001`) — used only
   * as a log tag on lifecycle messages so the target of registration and
   * heartbeats is visible on the service's stdout.
   */
  gatewayUrl?: string;
}

/**
 * Health check function — returns the result of local health checks
 * (DB ping, NATS connectivity, etc.). The microservice injects this
 * so the registrar can include health status in heartbeats.
 */
export type HealthCheckFn = () => Promise<{
  http_healthy: boolean;
  checks: Record<string, ServiceHealthCheck>;
}>;

/**
 * Registers a microservice via NATS lifecycle events and maintains
 * a heartbeat.
 *
 * NATS-based: publishes to service.register / service.heartbeat /
 * service.unregister subjects. The BE subscribes and persists to the
 * `service_registry` table. The microservice never touches the DB directly.
 *
 * The healthCheckFn is called on each heartbeat to include the current
 * health status (HTTP + NATS + custom checks).
 */
export class ServiceRegistrar {
  private readonly config: Required<ServiceRegistrarConfig>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** sha256 of PRIMEBRICK_CLIENT_KEY — sent to the BE at register; raw key never leaves the service. */
  private readonly clientKeyHash?: string;
  private readonly pkgName: string;
  private readonly capabilities?: string[];

  constructor(
    private readonly nats: typeof NatsClient,
    config: ServiceRegistrarConfig,
    private readonly healthCheckFn?: HealthCheckFn,
  ) {
    // Auto-derive name/version from package.json — the registry row must
    // always carry real identity (it feeds system.client_registry).
    const pkg = detectPackageIdentity();
    this.pkgName = pkg.name;
    this.capabilities = pkg.capabilities;
    // The client key is a module config (`service_client_shield_key`), never an env var —
    // each service has its own key; only the sha256 hash leaves the service.
    const clientKey = config.clientKey;
    this.clientKeyHash = clientKey ? clientKeyHash(clientKey) : undefined;
    if (!clientKey) {
      logger.error(
        "config 'service_client_shield_key' is not set — this service cannot enroll in system.client_registry; inbound identity verification will reject its callers",
        { tags: ["core"] },
      );
    }
    this.config = {
      heartbeatIntervalMs: 30000,
      is_behind_scaler: false,
      name: pkg.name,
      description: undefined,
      author: undefined,
      github_repo_url: undefined,
      service_version: pkg.version,
      icon: undefined,
      icon_type: undefined,
      ...config,
    } as Required<ServiceRegistrarConfig>;
  }

  /**
   * Register with the BE via NATS request/reply (`service.register` is a
   * subscribeRequest subject). Stateless by design: retries every 5s until
   * the BE acknowledges — a service that never registers does not exist to
   * the system, so this method only resolves on ack.
   */
  async register(): Promise<void> {
    const { http_healthy, checks } = await this.runHealthChecks();
    const payload: ServiceRegisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      endpoints: this.config.endpoints,
      service_version: this.config.service_version,
      name: this.config.name,
      description: this.config.description,
      author: this.config.author,
      github_repo_url: this.config.github_repo_url,
      is_behind_scaler: this.config.is_behind_scaler,
      icon: this.config.icon,
      icon_type: this.config.icon_type,
      http_healthy,
      nats_connected: this.nats.isConnected(),
      checks,
      pkg_name: this.pkgName,
      client_key_hash: this.clientKeyHash,
      capabilities: this.capabilities,
    };
    const ref = `${this.pkgName}/${this.config.service_version ?? "?"}`;
    const gwTag = this.config.gatewayUrl;
    logger.info(`Registering ${ref} — attempt 1`, { tags: gwTag ? ["core", gwTag] : ["core"] });
    for (let attempt = 1; ; attempt++) {
      try {
        const ack = await this.nats.request<{ registered?: boolean; error?: string }>(
          SERVICE_SUBJECTS.REGISTER,
          payload,
          3000,
        );
        if (ack?.registered) {
          logger.done(
            `The service ${ref} has been successfully registered after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
            { tags: gwTag ? ["core", gwTag] : ["core"] },
          );
          void this.watchGatewayRestarts();
          return;
        }
        logger.warn(
          `service.register rejected by BE — ${ack?.error ?? "no ack"} — retrying in 5s`,
          { tags: gwTag ? ["core", gwTag] : ["core"], attempt },
        );
      } catch (error) {
        // timeout / no responders (BE down) — keep retrying
        logger.warn(
          `Registering ${ref} — attempt ${attempt + 1} in 5s (${error instanceof Error ? error.message : String(error)})`,
          { tags: gwTag ? ["core", gwTag] : ["core"], attempt: attempt + 1 },
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  /**
   * After a successful registration, listen for `service.gateway_online`:
   * when the BE restarts it announces itself and every live service
   * re-registers — the gateway re-ingests identity/endpoints/capabilities
   * and re-discovers OpenAPI without polling anyone.
   */
  private gatewayWatchStarted = false;
  private reregisterInFlight = false;
  private async watchGatewayRestarts(): Promise<void> {
    if (this.gatewayWatchStarted) return;
    this.gatewayWatchStarted = true;
    const gwTag = this.config.gatewayUrl;
    // Hot-reload safety: a module reload creates a NEW registrar that
    // subscribes on the SAME persistent NATS connection — replace the
    // previous instance's subscription instead of accumulating one per
    // reload (observed: N reloads → N parallel re-registers per event).
    // NOTE: NatsClient.subscribe already dedupes by subject — the
    // registry gatewayOnlineSub entry is belt-and-suspenders for
    // subscribers that bypass NatsClient (none today).
    await this.nats.subscribe(SERVICE_SUBJECTS.GATEWAY_ONLINE, async () => {
      if (this.reregisterInFlight) return;
      this.reregisterInFlight = true;
      try {
        logger.info("API gateway announced restart — re-registering", {
          tags: gwTag ? ["core", gwTag] : ["core"],
        });
        await this.register();
      } catch (error) {
        logger.error("Re-registration after gateway restart failed", {
          tags: gwTag ? ["core", gwTag] : ["core"],
          error,
        });
      } finally {
        this.reregisterInFlight = false;
      }
    });
  }

  async sendHeartbeat(): Promise<void> {
    try {
      const { http_healthy, checks } = await this.runHealthChecks();
      const payload: ServiceHeartbeatPayload = {
        code: this.config.serviceCode,
        base_url: this.config.baseUrl,
        service_version: this.config.service_version,
        name: this.config.name,
        description: this.config.description,
        author: this.config.author,
        github_repo_url: this.config.github_repo_url,
        is_behind_scaler: this.config.is_behind_scaler,
        icon: this.config.icon,
        icon_type: this.config.icon_type,
        http_healthy,
        nats_connected: this.nats.isConnected(),
        checks,
        pkg_name: this.pkgName,
      };
      await this.nats.publish(SERVICE_SUBJECTS.HEARTBEAT, payload);
    } catch (error) {
      logger.error(`Heartbeat error for ${this.config.serviceCode}`, { tags: ["core"], error: error });
    }
  }

  async unregister(): Promise<void> {
    const payload: ServiceUnregisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      is_behind_scaler: this.config.is_behind_scaler,
      pkg_name: this.pkgName,
      service_version: this.config.service_version,
    };
    await this.nats.publish(SERVICE_SUBJECTS.UNREGISTER, payload);
    logger.info(`Unregistered ${this.config.serviceCode} via NATS`, { tags: ["core"] });
  }

  /**
   * Start the heartbeat loop. The first heartbeat is sent immediately —
   * the register ack already proved the BE is listening, so there's no
   * reason to wait a full interval before the BE sees fresh health data.
   */
  startHeartbeat(): ReturnType<typeof setInterval> {
    const gwTag = this.config.gatewayUrl;
    void this.sendHeartbeat().then(() => {
      logger.info(`First heartbeat sent to api gateway`, { tags: gwTag ? ["core", gwTag] : ["core"] });
    });
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.config.heartbeatIntervalMs);
    return this.heartbeatTimer;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async runHealthChecks(): Promise<{ http_healthy: boolean; checks: Record<string, ServiceHealthCheck> }> {
    if (this.healthCheckFn) {
      return this.healthCheckFn();
    }
    // Default: assume healthy if we can publish (NATS is connected)
    return {
      http_healthy: true,
      checks: {},
    };
  }
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { NatsClient } from "../nats/nats-client.js";
import { DOCS_PACK_CAPABILITY } from "../docs-pack/manifest.js";
import { callNats } from "../nats/nats-routes.js";
import { subscribeShielded } from "../nats/service-shield.js";
import { detectPackageIdentity, clientKeyHash, deriveClientKey } from "./service-identity.js";
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
  /**
   * Root level this module is part of (e.g. 'system', 'crm') — sent as
   * `part_of` in service.register; the module's FE routes must live under
   * `/{part_of}/{serviceCode}`.
   */
  partOf: string;
  /**
   * Default-module claim for `partOf` — `true` asks the BE to mark this
   * service as its root level's landing module. Keep-winner on conflict;
   * absent/false never downgrades a stored flag.
   */
  isDefault?: boolean;
  /**
   * i18n key for the module's localized display name — sent as `label_key`
   * in service.register; resolved against this service's own translation
   * namespace by every UI surface (fallback: raw `name`).
   */
  labelKey?: string;
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
   * the UA prefix in `system.client_shield_registry`. Only its sha256 hash is sent
   * in `service.register`; the raw key never leaves the service.
   */
  clientKey?: string;
  /**
   * Derived-key mode (B14): the service's derivation secret (module config
   * `service_key_derivation_secret`). When set, every `service.register`
   * materializes the key as `HMAC(secret, ua_prefix:generation)` for the
   * generation the BE advertises — the row becomes `key_mode='derived'` and
   * a BE-side rotate (generation bump) auto-triggers re-registration with
   * the newly derived key. No key material rests in config or on disk.
   */
  keyDerivationSecret?: string;
  /**
   * Reads this service's current `key_generation` from the client-shield
   * registry snapshot (wired by create-microservice). Required for derived
   * mode; unused otherwise.
   */
  registryGeneration?: () => number;
  /**
   * Shared slot (wired by create-microservice): the registrar writes the
   * generation of each ACKED register so outbound calls keep deriving the
   * acked key while the post-rotation handshake completes (zero-gap).
   */
  generationSlot?: { value?: number };
  /**
   * API gateway base URL (the BE, e.g. `http://localhost:3001`) — used only
   * as a log tag on lifecycle messages so the target of registration and
   * heartbeats is visible on the service's stdout.
   */
  gatewayUrl?: string;
  /**
   * Absolute path of the built docs pack (e.g. `dist/docs-pack`). When it
   * contains a manifest.json, the `docs_pack` capability is added to the
   * registration automatically — no package.json edit needed.
   */
  docsPackDir?: string;
  /**
   * PG schema ownership claim — the service's `DATABASE_SCHEMA` list
   * (validated by `assertDbEnv`, first = owned schema). Sent in
   * `service.register` → persisted in `service_registry.schemas` so the
   * BE can enforce one-module-one-schema (`SCHEMA_OWNERSHIP_CONFLICT`).
   */
  schemas?: string[];
  /**
   * How `serviceCode` was resolved: `"override"` when package.json
   * declares an explicit `service_code`, else `"derived"` (package name
   * minus `primebrick-`). Wired by create-microservice — the BE
   * re-derives `derived` codes and rejects mismatches.
   */
  codeSource?: "derived" | "override";
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
  /** sha256 of the client key — recomputed per register in derived mode; raw key never leaves the service. */
  private clientKeyHash?: string;
  /** Generation of the last ACKED register — outbound calls keep deriving this one until the post-rotation handshake lands (zero-gap rotation). */
  private _ackedGeneration?: number;
  /** Hint for the next register attempt — set by onRegistryChanged (rotation) or a stale_generation ack. */
  private keyGenerationHint?: number;
  private readonly pkgName: string;
  private capabilities?: string[];

  constructor(
    private readonly nats: typeof NatsClient,
    config: ServiceRegistrarConfig,
    private readonly healthCheckFn?: HealthCheckFn,
  ) {
    // Auto-derive name/version from package.json — the registry row must
    // always carry real identity (it feeds system.client_shield_registry).
    const pkg = detectPackageIdentity();
    this.pkgName = pkg.name;
    this.capabilities = pkg.capabilities;
    // Auto-capability: a service that ships a built docs pack (dist/docs-pack/
    // manifest.json next to the running entry) declares docs_pack without any
    // manual config — the AI service pulls it on registration.
    if (
      config.docsPackDir &&
      existsSync(join(config.docsPackDir, "manifest.json")) &&
      !(this.capabilities ?? []).includes(DOCS_PACK_CAPABILITY)
    ) {
      this.capabilities = [...(this.capabilities ?? []), DOCS_PACK_CAPABILITY];
    }
    // The client key is a module config (`service_client_shield_key`), never an env var —
    // each service has its own key; only the sha256 hash leaves the service.
    // Derived mode materializes the key per register via clientKeyProvider.
    const clientKey = config.clientKey;
    this.clientKeyHash = clientKey ? clientKeyHash(clientKey) : undefined;
    if (!clientKey && !config.keyDerivationSecret) {
      logger.error(
        "neither config 'service_client_shield_key' nor 'service_key_derivation_secret' is set — this service cannot enroll in system.client_shield_registry; inbound identity verification will reject its callers",
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
   * correlation-reply endpoint). Stateless by design: retries every 5s until
   * the BE acknowledges — a service that never registers does not exist to
   * the system, so this method only resolves on ack.
   */
  /** This service's client_shield_registry prefix — `{pkg_name}/{service_version}`. */
  private get uaPrefix(): string {
    return `${this.pkgName}/${this.config.service_version ?? ""}`;
  }

  /**
   * Generation to register for: the rotation/stale hint wins, else the
   * generation the BE registry snapshot currently advertises.
   */
  private generationForRegister(): number | undefined {
    if (!this.config.keyDerivationSecret) return undefined;
    return this.keyGenerationHint ?? this.config.registryGeneration?.() ?? 0;
  }

  /** The generation outbound calls should derive keys for (last acked one). */
  get ackedGeneration(): number | undefined {
    return this._ackedGeneration;
  }

  async register(): Promise<void> {
    const { http_healthy, checks } = await this.runHealthChecks();
    // Derived mode: materialize the key for the generation the BE currently
    // advertises (or the hint learned from a rotate/stale-ack).
    const generation = this.generationForRegister();
    const key = generation !== undefined
      ? deriveClientKey(this.config.keyDerivationSecret!, this.uaPrefix, generation)
      : this.config.clientKey;
    this.clientKeyHash = key ? clientKeyHash(key) : undefined;
    const payload: ServiceRegisterPayload = {
      code: this.config.serviceCode,
      base_url: this.config.baseUrl,
      endpoints: this.config.endpoints,
      part_of: this.config.partOf,
      is_default: this.config.isDefault,
      label_key: this.config.labelKey,
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
      key_generation: generation,
      key_mode: generation !== undefined ? "derived" : "static",
      capabilities: this.capabilities,
      schemas: this.config.schemas ?? [],
      code_source: this.config.codeSource,
    };
    const ref = `${this.pkgName}/${this.config.service_version ?? "?"}`;
    const gwTag = this.config.gatewayUrl;
    logger.info(`Registering ${ref} — attempt 1`, { tags: gwTag ? ["core", gwTag] : ["core"] });
    for (let attempt = 1; ; attempt++) {
      try {
        const ack = await callNats<{ registered?: boolean; error?: string; key_generation?: number }>(
          SERVICE_SUBJECTS.REGISTER,
          payload,
          { timeoutMs: 3000, natsClient: this.nats },
        );
        if (ack?.registered) {
          this._ackedGeneration = generation;
          if (this.config.generationSlot) this.config.generationSlot.value = generation;
          this.keyGenerationHint = undefined;
          logger.done(
            `The service ${ref} has been successfully registered after ${attempt} attempt${attempt === 1 ? "" : "s"}`,
            { tags: gwTag ? ["core", gwTag] : ["core"] },
          );
          void this.watchGatewayRestarts();
          return;
        }
        // Stale-generation self-heal (B14): the BE tells us the generation it
        // issued — the next attempt re-derives for it (restart-after-rotation
        // or a snapshot that never loaded).
        if (typeof ack?.key_generation === "number") {
          this.keyGenerationHint = ack.key_generation;
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
    await subscribeShielded(SERVICE_SUBJECTS.GATEWAY_ONLINE, async () => {
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

  /**
   * Derived-key mode (B14): invoked by the client-shield registry after a
   * reload that changed row material. `currentGeneration` is the generation
   * the BE snapshot now advertises for this service — when the BE bumped it
   * (rotate endpoint), re-register with the newly derived key.
   */
  onRegistryChanged(currentGeneration: number): void {
    if (!this.config.keyDerivationSecret) return;
    if (currentGeneration <= (this.config.generationSlot?.value ?? this._ackedGeneration ?? -1)) return;
    this.keyGenerationHint = currentGeneration;
    logger.info("client key generation rotated — re-registering with the newly derived key", {
      tags: ["core"],
    });
    void this.register();
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

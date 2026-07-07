# @primebrick/sdk

Shared microservice infrastructure for Primebrick v3 — config loading, migration runner, service registration, graceful shutdown, NATS client, health checks, env validation. DB-agnostic via port interfaces.

## What the SDK provides

- **Port interfaces** — `ConfigRepositoryPort`, `DatabasePort`, `ServiceRegistryPort`, `HealthCheckPort`. Abstract contracts the consumer implements using their DAL.
- **ConfigLoader** — load config from a DB config table at startup, cache in memory, `get(key)` on hot path, `invalidate()` for refresh.
- **IConfigEntity** — self-contained interface for dictionary-style config rows.
- **Migration runner** — SHA256-based patch tracking, idempotent re-runs.
- **ServiceRegistrar** — register microservice in `service_registry`, maintain heartbeat.
- **IServiceRegistry** — self-contained interface for `service_registry` rows.
- **GracefulShutdown** — re-entrancy guard, `Promise.allSettled` for parallel resource cleanup, signal handlers.
- **NatsClient** — singleton NATS connection management.
- **HttpServer** — minimal HTTP server with health endpoint.
- **HealthCheck** — DB health check utility.
- **EnvValidator** — centralized env var validation.

## License

MIT — Copyright (c) 2026 Michael Sogos

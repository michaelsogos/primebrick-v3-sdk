# @primebrick/sdk

Microservice infrastructure for Primebrick v3 — `createMicroservice`
lifecycle (config loading, migration runner, service registration,
heartbeats, graceful shutdown, health checks), the route-handler
factories (`makeRpcRouter`, `makeEntityRouter`, `makeOpenApiHandler`,
`composeRouteHandlers`), NATS™ client, ext-json wire codec, and port
interfaces (`ConfigRepositoryPort`, `DatabasePort`, `HealthCheckPort`…)
that keep the SDK DB-agnostic.

## Documentation

- [AGENTS.md](./AGENTS.md) — agent entry point, repo conventions
- [docs/dev-guide/](./docs/dev-guide/) — generated API reference +
  hand-written guides
- `src/index.ts` — the public barrel is the source of truth for exports;
  `package.json` `exports` lists every importable subpath

## License

MIT — Copyright (c) 2026 Michael Sogos

# AI AGENT INSTRUCTIONS - @primebrick/sdk

## CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**

- WAIT for the user to explicitly tell you to commit before running any `git commit` command.
- This applies to ALL situations - no exceptions.

## Repository overview

`@primebrick/sdk` is the shared microservice infrastructure SDK for Primebrick v3.
It provides config loading, migration runner, service registration, graceful
shutdown, NATS™ client, health checks, and env validation.

**Documentation language:** All `*.md` files use **English**.

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Test | `pnpm test` |

## Architectural invariants (MANDATORY — do not weaken)

- **Route factory is a closed set**: HTTP routes exist only via `makeRpcRouter`,
  `makeOpenApiHandler`, `composeRouteHandlers` — outputs carry a
  `Symbol.for("primebrick.sdk.factory-route-handler")` runtime brand and
  `createMicroservice` refuses to boot on unbranded handlers. New route kinds
  must be added INSIDE the factories (e.g. `streaming:"sse"`, `rawBody`,
  `:param*` wildcards), never as an escape hatch.
- **NATS queue groups**: `subscribe`/`subscribeRequest` accept `{ queue }` —
  work items get a per-service queue, broadcasts every instance must receive
  (`service.gateway_online`, `config.changed`, `client_registry.changed`)
  MUST stay unqueued.
- **Hot-reload dedupe**: `lifecycle/process-registry.ts` keeps
  process-level handles (NATS subs, signal listeners) on `globalThis` so
  watch-mode reloads REPLACE instead of stack. New per-instance
  subscriptions/listeners must go through the same registry.

## Patch SHA256 management

The SDK provides `applyPatches()` in `src/migrations/apply-patches.ts` which enforces
strict sha256 immutability on database patches. If a consuming repo (BE or US) hits
a sha256 mismatch, they must follow their own `.devin/rules/patch-sha256-management.md`.

The SDK MUST NOT add a "force" or "skip hash check" option. See
[.devin/rules/patch-sha256-management.md](./.devin/rules/patch-sha256-management.md).

## Package Versioning — FIXED versions only (MANDATORY)

All package versions in `package.json` MUST be pinned to exact versions (e.g.
`"typescript": "5.9.3"`). NO ranges (`^`, `~`, `>=`, `*`, `latest`) are allowed
for registry packages. This ensures every dev machine, CI build, and production
rebuild gets the exact same dependency tree that was tested during UAT.

See [.devin/rules/package-versioning.md](./.devin/rules/package-versioning.md)
for the full rule and upgrade procedure.

## User-facing documentation

User-facing developer documentation lives in `docs/user-guide/` as MDX files.
These are synced to `docs.primebrick.dev` by the docs repo's CI pipeline.

- **Location**: `docs/user-guide/*.mdx` — one file per topic
- **Ordering**: `docs/user-guide/_order.json` defines the sidebar page order
- **Conventions**: see `.devin/rules/docs-user-guide.md` for editorial rules
- **Mermaid**: use `<Mermaid chart={...} />`, never ` ```Code ` or ` ```mermaid `
- **API extraction**: run `pnpm extract-docs` to generate
  `docs/user-guide/_extracted/api.json` from TypeDoc
- **Do NOT hand-edit** files in `docs/ai/` or `docs/skills/` — those are internal
- **Internal docs** (`docs/ai/`, `docs/skills/`, `docs/gitflow.md`) are NOT synced
  to the docs site — they stay in this repo for AI agents only

## Logging & Telemetry

- Use `logger` (`logger.info/warn/error/debug(msg, meta?)`) — never `console.*` in new code. `installConsoleBridge()` covers legacy call sites.
- Structured meta uses snake_case keys; never log secrets/PII.
- Telemetry config is BE-owned (`config_entries`), shared via `SharedConfig.telemetry` + `config.changed` broadcast; `restartTelemetry` hot-swaps the OTel pipeline (proxy tracer provider — globals registered once).
- NATS trace propagation is automatic in `NatsClient`; HTTP outbound uses `fetchTraced()`; inbound HTTP spans are created in `createHttpServer`.
- See [.devin/rules/logging-telemetry.md](./.devin/rules/logging-telemetry.md) and `docs/user-guide/telemetry-logging.mdx`.

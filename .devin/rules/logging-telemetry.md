# Devin Rule: Logging & Telemetry

## Trigger
- Applies to ALL code that logs or emits telemetry in this repository.

## Rules

1. **NEVER use `console.*` in new code** — use `logger` from `@primebrick/sdk`
   (`logger.info/warn/error/debug(msg, meta?)`). The console bridge keeps
   legacy call sites working, but new code must use structured logging.
2. **Structured meta**: pass a `Record<string, unknown>` with snake_case keys
   as the second arg — not string interpolation for values that a SIEM should
   query (e.g. `logger.info("Email sent", { request_id, provider })`).
3. **Never log secrets/PII**: no passwords, tokens, API keys, cookies,
   Authorization headers, or full request bodies.
4. **No env config** besides `DATABASE_URL` — telemetry/logging settings live
   in the BE `config_entries` table (single point), distributed to
   microservices via `SharedConfig.telemetry` + `config.changed` broadcast.
5. **Context propagation**: outbound HTTP → `fetchTraced()` (injects
   `traceparent`); NATS propagation is automatic inside `NatsClient`.
   Do not hand-roll traceparent strings.
6. **OTel globals are registered once** — never call `setGlobalTracerProvider`
   or `NodeSDK` in consumer code; use `initTelemetry`/`restartTelemetry`.

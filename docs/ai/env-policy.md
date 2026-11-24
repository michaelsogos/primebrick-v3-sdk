# Environment Variable Policy

> `.devin/rules/env-policy.md` is a pointer to this page — canonical text.

## Golden Rule

**The ONLY allowed environment variable is `DATABASE_URL`** (connection
string). Everything else — URLs, ports, secrets, keys, feature flags — is
a **module config** read from the config table (`config_entries` on the
BE, `<schema>.config` via `ConfigLoader` in microservices).
`assertDbEnv()` validates the contract at boot — unknown, missing, empty
or malformed keys crash startup.

**`DATABASE_SCHEMA` is a reserved violation, not a variable.** Schema
identity is **code**: each service declares `OWNED_SCHEMAS` in
`db/dal.ts` (BE: `src/db/owned-schemas.ts`) — the single source that feeds
`createMicroservice({ schemas })` (registry ownership claim + entity
guard + injected `dbPatches.schemas`) and the `db:check`/`db:meta:compare`
wrappers. If `DATABASE_SCHEMA` is present in the process env (`.env`,
docker `environment:`) `assertDbEnv()` **throws** — docker can configure
where the database *is*, never which schemas the service *owns*.

**`NODE_ENV` is not a config value** — it is the platform deployment-shape
convention (`development`/`production`) set by the runtime, and the one
sanctioned env READ beyond the DB pair. It is never read to branch a
feature; its one use is the deterministic HTTP bind policy:
`0.0.0.0` in production (containers/LB need a reachable socket) /
`127.0.0.1` otherwise. That policy is **code, not config** — there is no
config row, no option, no opt-in for IPv6 or interface-specific binds.

## Why

- Env vars are invisible, un-versioned, and un-audited — config entries are
  managed, audited and consistent across environments.
- Per-service secrets (e.g. `client_key` for the B11 service-identity
  layer) MUST be per-service config rows, so each service holds its own
  key and a leaked key compromises one caller only — never a shared secret
  via env.

## Enforcement

- ❌ NEVER introduce a new `process.env.X` read for a configurable value
  (secrets included — a secret is config, not env).
- ❌ NEVER use env vars for URLs, ports, credentials, client keys, feature
  flags, or anything the service could read from its config table.
- ✅ `DATABASE_URL` is the sole exception — it must exist before the
  config table is readable. `DATABASE_SCHEMA` must NOT exist: it is a
  reserved name — schema identity lives in the `OWNED_SCHEMAS` const in
  code (entity guard + registry claim + `dbPatches` domain all read it),
  and `assertDbEnv()` throws when it is present.
- ✅ When adding a config value: create a config entry (key, type, i18n
  label) in the module's config seed, document it, and read it via
  `ConfigLoader`/`ConfigEntriesService`.
- When reviewing code, flag any new `process.env.` read other than the DB
  connection as a violation.

## Platform variables (process env — never `.env`, never config)

A closed set of **platform** env vars is permitted. They are supplied at
process launch or via Docker `ENV` — never in `.env`, never hardcoded,
never in `config_entries`:

- `NODE_ENV` — `production` enables the security gates consumed by the
  SDK: `Secure` session-cookie flag (`auth-session.service.ts`, BE) and
  migration signature trust `allowedTrust: ["release"]` (the
  `db-migration` engine — non-production accepts `dev` + `release`
  signed patches). Set via `ENV NODE_ENV=production` in each service
  Dockerfile; local dev leaves it unset.
- `FORCE_COLOR` / `NO_COLOR` / `VITEST` — CLI/test-runtime knobs consumed
  by the logger and test runner; not configuration.
- `E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD` — ephemeral E2E actor
  credentials minted per run by the test harness (deleted at teardown).
- Script-level knobs (`FE_DIR`, `DOCS_DIR`, `EVAL_*`, `OPENAPI_PATH`, …)
  — CLI arguments for `scripts/`/`eval/` tooling; not runtime config.

The `.env` file itself may contain ONLY `DATABASE_URL` — extra keys crash
`assertDbEnv()` at boot.

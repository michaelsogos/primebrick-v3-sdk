# Devin Rule: Database Patches (db-meta + migration engine)

## Trigger
- Applies whenever creating or modifying files under `db-meta/`
- Applies when `pnpm run db:migrate` or `primebrick-db` commands fail
- Applies when entity/model code changes the DB schema

## The Model

The migration engine is `runMigrations` from `@primebrick/dal-pg`, running
**at service boot before any domain traffic** (and via `pnpm db:migrate` for
manual runs). Every service owns `db-meta/`:

- `patches/YYYYMMDDHHMMSS_<slug>.sql` — filename-sorted, **mandatory and
  ordered**: after one fails, later patches in that module do not execute
- `MANIFEST.json` — Ed25519-signed `patch_name → content_sha256` map; the
  engine verifies the signature against `keys.json` before trusting hashes
- `keys.json` — trusted public keys (`"release" | "dev"` trust levels;
  `allowedTrust` defaults to `["release"]`, dev allowed locally)

The registry table is **per-schema**: `<schema>.primebrick_database_patches`
(not `public.`). The old `applyPatches()` SDK runner is **deleted**.

## The Rules

### 1. NEVER edit a shipped patch
A filename already registered with a different sha256 is a **security
event**, not a re-apply — the engine aborts. To change the schema, ship a
**new** patch file. (The old "update the init patch in place + FnF script to
fix the registry hash" workflow is dead.)

### 2. SQL lives only in `db-meta/patches/`
`db-meta/fire-and-forget/` is **retired** — the folders were deleted; git
history preserves them. One-off operational SQL goes to the workspace
`temp/` directory, **never committed**.

### 3. Entity drift → compare → sign → commit
```bash
pnpm db:meta:compare      # entity snapshot vs catalog → new unsigned patch
primebrick-db sign --db-meta db-meta --key @<keyfile> --key-id <id>   # re-sign MANIFEST.json
```
Commit the patch + `MANIFEST.json` + snapshots together. The dev key lives
in workspace `temp/` — never in the repo.

### 4. Pragmas (patch header, first 40 lines)
- `-- pb:requires-review` — parks at `pending_review` until an admin approves
- `-- pb:no-transaction` — opts out of the per-patch transaction
  (`CREATE INDEX CONCURRENTLY` and friends)

### 5. Mode is runtime config, not env
`<schema>.config_entries` key `db_migration.mode` = `apply | check | off` —
re-read after each run (a patch may change it). No env flag, no guessing.

## Failure handling

Registry transitions happen through the admin surface, never by hand:
`failed → retry` · `pending_review → approve` · `any → resolveManually`
(FE `/system/migrations` page or `src/migrations/status.ts` helpers).
**NEVER** hand-edit `MANIFEST.json`, `keys.json`, or registry rows.

## Deep dive

The normative rules live here; the full mechanics are in the dal-pg
dev-guide `migrations.mdx` (engine semantics, provenance, CLI) — link, do
not duplicate.

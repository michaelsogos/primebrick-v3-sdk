# AI AGENT INSTRUCTIONS - @primebrick/sdk

## CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**

- WAIT for the user to explicitly tell you to commit before running any `git commit` command.
- This applies to ALL situations - no exceptions.

## Repository overview

`@primebrick/sdk` is the shared microservice infrastructure SDK for Primebrick v3.
It provides config loading, migration runner, service registration, graceful
shutdown, NATS client, health checks, and env validation.

**Documentation language:** All `*.md` files use **English**.

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Test | `pnpm test` |

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

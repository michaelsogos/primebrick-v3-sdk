# Devin Rule: Database Patches (db-meta + migration engine)

## Trigger
- Applies whenever creating or modifying files under `db-meta/`
- Applies when `pnpm run db:migrate` or `primebrick-db` commands fail
- Applies when entity/model code changes the DB schema

## Canonical doc
**`docs/ai/db-patches.md` — read it before acting.** This file is a
pointer; the normative text lives in the canonical doc.

## Enforcement
- Follow the normative body in the canonical doc — it is the contract; this file is only its trigger.

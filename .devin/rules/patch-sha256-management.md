# Devin Rule: Database Patch SHA256 Management

## Trigger
- Applies when modifying the `applyPatches()` function in `src/migrations/apply-patches.ts`
- Applies when modifying the patch registry logic in `src/migrations/patch-registry.ts`
- Applies when the sha256 check behavior is involved in any way

## The Problem

The patch registry (`public.primebrick_database_patches`) records the `content_sha256` of each patch file when it was first applied. If a patch file is later modified (e.g. the init script is updated with new tables/columns), the hash no longer matches and `applyPatches()` throws:

```
Patch <filename> (<patch_id>) exists in registry with a different content_sha256 — refusing to run.
```

This is BY DESIGN — patches are immutable. The correct way to handle a modified patch is documented in the BE and US repos' `.devin/rules/patch-sha256-management.md`.

## The Rule

### 1. The sha256 check MUST remain strict
- `applyPatches()` MUST throw when `patch_id` exists with a different `content_sha256`.
- Do NOT add a "force" flag, a "skip hash check" option, or any bypass mechanism.
- The strict check is the safety net that prevents silent schema drift.

### 2. The error message MUST be actionable
- The error message MUST include the patch filename, patch_id, and instruct the user to create a fire-and-forget script.
- Suggested error message format:
  ```
  Patch <filename> (<patch_id>) exists in registry with a different content_sha256 — refusing to run.
  To fix: update the patch file in place, then create a fire-and-forget script to update the registry hash.
  See .devin/rules/patch-sha256-management.md in the consuming repo (BE or US).
  ```

### 3. The SDK does NOT manage fire-and-forget scripts
- Fire-and-forget scripts live in the consuming repo's `db-meta/fire-and-forget/` directory.
- The SDK only provides the `applyPatches()` runner.
- The SDK MUST NOT auto-apply fire-and-forget scripts or auto-update registry hashes.

### 4. Tests MUST cover the sha256 mismatch case
- `src/migrations/__tests__/apply-patches.test.ts` MUST include a test case for:
  - Same patch_id + different sha256 → throws with actionable message
  - Same patch_id + same sha256 → skips
  - Missing patch_id + same sha256 under another patch_id → registers without re-executing
  - Missing patch_id + new sha256 → applies SQL + inserts registry row

## Enforcement
- AI agent MUST NOT add a "force" or "skip hash check" option to `applyPatches()`.
- AI agent MUST keep the sha256 mismatch error message actionable and informative.
- AI agent MUST NOT add fire-and-forget auto-apply logic to the SDK.
- AI agent MUST maintain test coverage for all 4 sha256 scenarios.

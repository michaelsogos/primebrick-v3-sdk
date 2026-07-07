import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabasePort } from "../ports/database-port.js";
import { PATCH_REGISTRY_DDL, PATCH_REGISTRY_FQNAME } from "./patch-registry.js";
import { patchIdFromFilename, sha256Hex } from "./patch-naming.js";

export interface ApplyPatchesResult {
  appliedOrRegistered: number;
  skipped: number;
}

/**
 * Apply database SQL patches from a directory.
 *
 * Strategy (adapted from BE's scripts/database-patch-apply.ts:1-148):
 * - Read .sql files from patchesDir sorted by filename.
 * - For each file, consult public.primebrick_database_patches (patch_id + content_sha256):
 *   - Same patch_id + same SHA → skip (already applied).
 *   - Same patch_id + different SHA → fail (immutable patch changed).
 *   - Missing patch_id but same SHA exists → register without re-executing.
 *   - Otherwise → BEGIN; apply SQL; INSERT registry row; COMMIT.
 *
 * DB-agnostic: depends on DatabasePort, NOT on pg.Pool.
 * The consumer provides an adapter that wraps their DB driver.
 *
 * @param patchesDir Absolute path to the directory containing .sql patch files.
 * @param db DatabasePort adapter (wraps the consumer's DB driver).
 * @returns Result with count of applied/registered and skipped patches.
 */
export async function applyPatches(patchesDir: string, db: DatabasePort): Promise<ApplyPatchesResult> {
  await db.query(PATCH_REGISTRY_DDL);

  let files: string[] = [];
  try {
    files = readdirSync(patchesDir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return { appliedOrRegistered: 0, skipped: 0 };
  }

  if (files.length === 0) {
    return { appliedOrRegistered: 0, skipped: 0 };
  }

  let appliedOrRegistered = 0;
  let skipped = 0;

  for (const filename of files) {
    const patchPath = join(patchesDir, filename);
    const raw = readFileSync(patchPath, "utf8");
    const sha = sha256Hex(raw);
    const patchId = patchIdFromFilename(filename);

    const byId = await db.query<{ content_sha256: string }>(
      `SELECT content_sha256 FROM ${PATCH_REGISTRY_FQNAME} WHERE patch_id = $1`,
      [patchId]
    );

    if (byId.rows.length > 0) {
      const recorded = (byId.rows[0] as { content_sha256: string }).content_sha256;
      if (recorded === sha) {
        console.log(`Skipping already applied patch: ${filename}`);
        skipped++;
        continue;
      }
      throw new Error(
        `Patch ${filename} (${patchId}) exists in registry with a different content_sha256 — refusing to run.`
      );
    }

    const bySha = await db.query<{ patch_id: string }>(
      `SELECT patch_id FROM ${PATCH_REGISTRY_FQNAME} WHERE content_sha256 = $1 LIMIT 1`,
      [sha]
    );
    if (bySha.rows.length > 0) {
      const other = (bySha.rows[0] as { patch_id: string }).patch_id;
      await db.query(
        `INSERT INTO ${PATCH_REGISTRY_FQNAME} (patch_id, content_sha256) VALUES ($1, $2)`,
        [patchId, sha]
      );
      console.log(`Registered ${filename} (same body as ${other}) — no SQL re-execution.`);
      appliedOrRegistered++;
      continue;
    }

    console.log(`Applying patch: ${filename}`);
    try {
      await db.query("BEGIN");
      await db.query(raw);
      await db.query(
        `INSERT INTO ${PATCH_REGISTRY_FQNAME} (patch_id, content_sha256) VALUES ($1, $2)`,
        [patchId, sha]
      );
      await db.query("COMMIT");
      appliedOrRegistered++;
    } catch (e) {
      await db.query("ROLLBACK");
      throw new Error(`Failed to apply patch ${filename}: ${e}`);
    }
  }

  return { appliedOrRegistered, skipped };
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatches } from "../apply-patches.js";
import { sha256Hex } from "../patch-naming.js";
import { PATCH_REGISTRY_FQNAME } from "../patch-registry.js";
import type { DatabasePort } from "../../ports/database-port.js";

function makeDb(queryImpl?: (text: string, params?: unknown[]) => { rows: unknown[] }): DatabasePort & {
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const db: DatabasePort & { calls: typeof calls } = {
    calls,
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (queryImpl) return queryImpl(text, params);
      return { rows: [] };
    }),
  };
  return db;
}

describe("applyPatches", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "patches-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns zero counts when directory is empty", async () => {
    const db = makeDb();
    const result = await applyPatches(dir, db);
    expect(result).toEqual({ appliedOrRegistered: 0, skipped: 0 });
  });

  it("returns zero counts when directory does not exist", async () => {
    const db = makeDb();
    const result = await applyPatches(join(dir, "nope"), db);
    expect(result).toEqual({ appliedOrRegistered: 0, skipped: 0 });
  });

  it("applies a new patch (BEGIN / SQL / INSERT / COMMIT)", async () => {
    writeFileSync(join(dir, "0001_init.sql"), "CREATE TABLE foo (id int);");
    const db = makeDb((text) => {
      if (text.includes("WHERE patch_id = $1")) return { rows: [] };
      if (text.includes("WHERE content_sha256 = $1")) return { rows: [] };
      return { rows: [] };
    });
    const result = await applyPatches(dir, db);
    expect(result.appliedOrRegistered).toBe(1);
    expect(result.skipped).toBe(0);
    const texts = db.calls.map((c) => c.text);
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");
    expect(texts).toContain("CREATE TABLE foo (id int);");
  });

  it("skips a patch when patch_id + content_sha256 match", async () => {
    const body = "CREATE TABLE bar (id int);";
    writeFileSync(join(dir, "0002_bar.sql"), body);
    const sha = sha256Hex(body);
    const db = makeDb((text) => {
      if (text.includes("WHERE patch_id = $1")) {
        return { rows: [{ content_sha256: sha }] };
      }
      return { rows: [] };
    });
    const result = await applyPatches(dir, db);
    expect(result.skipped).toBe(1);
    expect(result.appliedOrRegistered).toBe(0);
  });

  it("throws when patch_id exists with a different content_sha256", async () => {
    writeFileSync(join(dir, "0003_changed.sql"), "SELECT 1;");
    const db = makeDb((text) => {
      if (text.includes("WHERE patch_id = $1")) {
        return { rows: [{ content_sha256: "different_sha_value" }] };
      }
      return { rows: [] };
    });
    await expect(applyPatches(dir, db)).rejects.toThrow(/different content_sha256/);
  });

  it("registers without re-executing when same SHA exists under a different patch_id", async () => {
    const body = "SELECT 1;";
    writeFileSync(join(dir, "0004_dup.sql"), body);
    const sha = sha256Hex(body);
    const db = makeDb((text) => {
      if (text.includes("WHERE patch_id = $1")) return { rows: [] };
      if (text.includes("WHERE content_sha256 = $1")) {
        return { rows: [{ patch_id: "0001_other" }] };
      }
      return { rows: [] };
    });
    const result = await applyPatches(dir, db);
    expect(result.appliedOrRegistered).toBe(1);
    const texts = db.calls.map((c) => c.text);
    expect(texts).not.toContain("BEGIN");
  });

  it("always runs the registry DDL first", async () => {
    writeFileSync(join(dir, "0005.sql"), "SELECT 1;");
    const db = makeDb((text) => {
      if (text.includes("WHERE patch_id = $1")) return { rows: [] };
      if (text.includes("WHERE content_sha256 = $1")) return { rows: [] };
      return { rows: [] };
    });
    await applyPatches(dir, db);
    expect(db.calls[0].text).toContain(PATCH_REGISTRY_FQNAME);
  });
});

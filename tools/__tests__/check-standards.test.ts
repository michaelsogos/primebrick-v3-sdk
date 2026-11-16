/**
 * check-standards E2E — fixture-repo probes through the REAL tool process.
 *
 * Each case builds a minimal repo tree, spawns
 * `bun tools/check-standards.ts src` with cwd=fixture, and asserts the
 * rule ids the tool reports. These are the regression specs for the
 * dal-access hardening: construction bypasses (`new Dal(`), accessor
 * references beyond call sites (`resetDal`, import-of-symbol aliasing),
 * unsuppressible governance rules (`exempt-governance`), and default-on
 * coverage for repos with NO `.devin/check-standards.json` — the missing
 * opt-in surface.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "check-standards.ts");
const T = 30_000; // bun cold-start per spawn

interface LintResult { code: number | null; out: string }

/** Build a fixture repo, run the tool inside it, return exit code + output. */
function runLint(files: Record<string, string>, config?: { rules?: Record<string, unknown> }): LintResult {
  const repo = mkdtempSync(join(tmpdir(), "cs-e2e-"));
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(repo, "src", rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, src);
    }
    if (config) {
      mkdirSync(join(repo, ".devin"), { recursive: true });
      writeFileSync(join(repo, ".devin", "check-standards.json"), JSON.stringify(config));
    }
    const r = spawnSync("bun", [TOOL, "src"], { cwd: repo, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const GETDAL = 'import { getDal } from "@primebrick/dal-pg";\nexport const x = async () => getDal().findAll();\n';

describe("check-standards — dal-access hardening", () => {
  it("`new Dal(` is flagged as dal-construct", () => {
    const r = runLint({ "services/x.ts": 'import { Dal } from "@primebrick/dal-pg";\nexport const d = new Dal({} as never);\n' });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[dal-construct]");
  }, T);

  it("dal-access flags getDal/initDal/resetDal calls outside allowPaths", () => {
    const r = runLint({
      "services/a.ts": GETDAL,
      "services/b.ts": 'import { initDal } from "../db/dal.js";\ninitDal();\n',
      "services/c.ts": 'import { resetDal } from "@primebrick/dal-pg";\nresetDal();\n',
    });
    expect(r.code).toBe(1);
    // 2 hits per file — the import-of-symbol AND the call are each flagged.
    expect(r.out.match(/\[dal-access\]/g)?.length).toBe(6);
  }, T);

  it("import-of-symbol is flagged even without a call (alias evasion)", () => {
    const r = runLint({
      "services/x.ts": 'import { getDal as grab } from "@primebrick/dal-pg";\nexport const g = grab;\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[dal-access]");
  }, T);

  it("default-on with NO config file: gateway+index allowed, everything else flagged", () => {
    const r = runLint({
      "db/dal.ts": GETDAL,
      "index.ts": 'import { initDal } from "./db/dal.js";\ninitDal();\n',
      "services/x.ts": GETDAL,
      "controllers/http/y.ts": 'import { resetDal } from "@primebrick/dal-pg";\nresetDal();\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("services/x.ts");
    expect(r.out).toContain("controllers/http/y.ts");
    expect(r.out).not.toContain("db/dal.ts:");
    expect(r.out).not.toContain("index.ts:");
    // 2 hits per offending file — import-of-symbol + call.
    expect(r.out.match(/\[dal-access\]/g)?.length).toBe(4);
  }, T);

  it("standards-exempt CANNOT suppress dal-access — the tag itself is flagged", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt: dal-access — tried to self-waive\n' + GETDAL,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[dal-access]");
  }, T);

  it("standards-exempt: all cannot suppress governance rules either", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt: all — blanket self-waiver attempt\n' + GETDAL,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[dal-access]");
  }, T);

  it("file-level exempt cannot suppress governance rules", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt-file: dal-access — tooling file claim\n' + GETDAL,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[dal-access]");
  }, T);

  it("standards-exempt still works on NON-governance rules", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt: ext-json — sanctioned stringify for cache blob\nexport const s = JSON.stringify({ a: 1 });\n',
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[ext-json]");
  }, T);

  it("layer-repo-import is default-on: controllers flagged, elsewhere clean", () => {
    const r = runLint({
      "db/entity-repo.ts": "export const entityActor = {};\n",
      "controllers/http/x.ts": 'import { entityActor } from "../../db/entity-repo.js";\nexport const a = entityActor;\n',
      "services/x.ts": 'import { entityActor } from "../db/entity-repo.js";\nexport const a = entityActor;\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("controllers/http/x.ts");
    expect(r.out).toContain("[layer-repo-import]");
    expect(r.out).not.toContain("services/x.ts:");
  }, T);

  it("config-declared allowPaths still honored — repo narrows the defaults", () => {
    const r = runLint(
      { "custom/gw.ts": GETDAL, "index.ts": 'import { initDal } from "./x.js";\ninitDal();\n' },
      { rules: { "dal-access": { allowPaths: ["custom/gw.ts", "index.ts"] } } },
    );
    expect(r.code).toBe(0);
  }, T);

  it("raw driver surface stays banned (regression matrix)", () => {
    const r = runLint({
      "a.ts": 'import { Pool } from "pg";\nexport const p = new Pool();\n',
      "b.ts": 'export const q = async (c: { query: (s: string) => unknown }) => c.query("x");\n',
      "c.ts": 'export const w = async (d: { withClient: (f: unknown) => unknown }) => d.withClient(() => {});\n',
      "d.ts": 'export const u = async (r: { upsert: (x: unknown) => unknown }) => r.upsert({});\n',
      "e.ts": 'import { Repository } from "@primebrick/dal-pg";\nexport const rr = new Repository();\n',
    });
    expect(r.code).toBe(1);
    for (const rule of ["pg-import", "pg-pool", "raw-query", "withClient", "upsert", "new-repository"]) {
      expect(r.out).toContain(`[${rule}]`);
    }
  }, T);

  it("governance rules are also unsuppressible for the driver family", () => {
    const r = runLint({
      "a.ts": '// standards-exempt: pg-import — legacy driver escape\nimport { Pool } from "pg";\nexport const p = new Pool();\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[pg-import]");
  }, T);
});

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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "check-standards.ts");
const T = 30_000; // bun cold-start per spawn

interface LintResult { code: number | null; out: string }

/** Build a fixture repo, run the tool inside it, return exit code + output. */
function runLint(files: Record<string, string>, config?: Record<string, unknown>, profile = "consumer"): LintResult {
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
    const r = spawnSync("bun", [TOOL, "src", `--profile=${profile}`], { cwd: repo, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/** Like runLint but paths are repo-ROOT relative — db-meta/patches and
 *  other out-of-src surfaces the repo-level rules scan. A `src/` stub is
 *  required (the line-rule walk needs it to exist). */
function runLintRepo(files: Record<string, string>, config?: Record<string, unknown>): LintResult {
  const repo = mkdtempSync(join(tmpdir(), "cs-e2e-"));
  try {
    for (const [rel, src] of Object.entries(files)) {
      const p = join(repo, rel);
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
      "services/x.ts": '// standards-exempt: column-flag-defaults — legacy flag read\nexport const s = c.default_visible !== false;\n',
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[column-flag-defaults]");
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

  it("dal-member-write flags this.dal.<write> — svc is the only write path", () => {
    const r = runLint({
      "services/x.ts": [
        'export class X {',
        '  private dal = {',
        '    update: async (e: unknown, d: unknown, o: unknown) => d,',
        '    findAll: async (e: unknown) => [] as unknown[],',
        '    transaction: async (f: (t: unknown) => unknown) => f({}),',
        '  };',
        '  private svc = { update: async (u: string, b: unknown) => b };',
        '  async a() { return this.dal.update(E, { uuid: "1" }, {}); }',
        '  async b() { return this._dal!.hardDelete(E, { uuid: "1" }); }',
        '  private _dal?: { hardDelete: (e: unknown, d: unknown) => unknown };',
        '  async c() { return this.svc.update("1", { name: "x" }); }',
        '  async d() { return this.dal.findAll(E); }',
        '  async e() { return this.dal.transaction((tx) => tx); }',
        '}',
        'const E = {};',
      ].join("\n"),
    });
    expect(r.code).toBe(1);
    // update + hardDelete flagged; findAll/transaction reads stay clean.
    expect(r.out.match(/\[dal-member-write\]/g)?.length).toBe(2);
    expect(r.out).toContain("dal.update");
    expect(r.out).toContain("_dal!.hardDelete");
  }, T);

  it("dal-member-write catches alias + bracket-access evasions, not reads", () => {
    const r = runLint({
      "services/x.ts": [
        'declare const thisDal: any;',
        'export const run = async () => {',
        '  const dal = thisDal;                    // alias evasion',
        '  await dal.update(E, { uuid: "1" }, {});',
        '  await dal.add(E, {});',
        '  await this.dal["hardDelete"](E, { uuid: "1" });',
        '  await getDal().update(E, {});           // NOT this rule — dal-access owns getDal',
        '  await dal.findAll(E);                   // read — clean',
        '  await dal.transaction((tx: unknown) => tx);',
        '};',
        'const E = {};',
        'declare function getDal(): any;',
      ].join("\n"),
    });
    expect(r.code).toBe(1);
    // Exactly the 3 writes — getDal() is dal-access's domain (flagged there
    // too, but never under dal-member-write); reads stay clean.
    expect(r.out.match(/\[dal-member-write\]/g)?.length).toBe(3);
    expect(r.out).not.toMatch(/findAll.*\[dal-member-write\]/);
  }, T);

  it("standards-exempt CANNOT suppress dal-member-write", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt: dal-member-write — tried to self-waive\nexport class X { m() { return this.dal.add(E, {}); } }\nconst E = {};\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[dal-member-write]");
  }, T);

  it("--write-baseline is dead: exit 2 and NO baseline file is minted", () => {
    const repo = mkdtempSync(join(tmpdir(), "cs-e2e-"));
    try {
      mkdirSync(join(repo, "src", "svc"), { recursive: true });
      writeFileSync(join(repo, "src", "svc", "x.ts"), GETDAL);
      const r = spawnSync("bun", [TOOL, "src", "--write-baseline"], { cwd: repo, encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).toContain("debt is never declared");
      expect(existsSync(join(repo, ".devin", "check-standards-baseline.json"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, T);

  it("existing baseline still suppresses declared debt but cannot grow", () => {
    const repo = mkdtempSync(join(tmpdir(), "cs-e2e-"));
    try {
      mkdirSync(join(repo, "src", "svc"), { recursive: true });
      mkdirSync(join(repo, ".devin"), { recursive: true });
      writeFileSync(join(repo, "src", "svc", "old.ts"), 'export const x = () => getDal().findAll();\n');
      writeFileSync(join(repo, "src", "svc", "fresh.ts"), GETDAL);
      writeFileSync(
        join(repo, ".devin", "check-standards-baseline.json"),
        JSON.stringify({ violations: [{ file: "svc/old.ts", rule: "dal-access", text: "export const x = () => getDal().findAll();" }] }),
      );
      const r = spawnSync("bun", [TOOL, "src"], { cwd: repo, encoding: "utf8" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status).toBe(1); // fresh.ts is NOT declared → fails
      expect(out).toContain("suppressed by baseline");
      expect(out).toContain("fresh.ts");
      expect(out).not.toContain("svc/old.ts:2");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, T);
});

// ─── i18n namespace boundary ──────────────────────────────────────────────
// Regression specs for the strict-segregation contract: a module cites only
// {app, own-schema} namespaces — in code literals (i18n-key-ns, template
// literals included) and in db-meta reference columns (i18n-sql-key-ref).
const KEYCFG = { i18n_namespaces: ["app", "job"] };

describe("check-standards — i18n namespace boundary", () => {
  it("system_key is NOT an i18n field — callable subjects never flag", () => {
    const r = runLint(
      { "x.ts": 'export const m = { system_key: "ai.partition_maintenance" };\n' },
      KEYCFG,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-key-ns]");
  }, T);

  it("foreign-ns *_key literals flag i18n-key-ns", () => {
    const r = runLint(
      { "x.ts": 'export const m = { label_key: "system.entities.x.title" };\n' },
      KEYCFG,
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("[i18n-key-ns]");
  }, T);

  it("t() template literals flag when the static prefix carries a foreign ns", () => {
    const r = runLint(
      { "x.ts": 'declare const t: (k: string) => string;\ndeclare const s: string;\nexport const a = t(`system.entities.ai_model.sort_${s}`);\n' },
      KEYCFG,
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("[i18n-key-ns]");
  }, T);

  it("t()/field templates stay clean for own-ns, static bodies, and unprovable prefixes", () => {
    const r = runLint(
      {
        "x.ts": [
          'declare const t: (k: string) => string;',
          'declare const s: string;',
          'declare const K: string;',
          'export const a = t(`job.entities.x.sort_${s}`);',     // own ns
          'export const b = t(`${K}.desc.y`);',                  // dynamic ns — unprovable
          'export const c = t(`jo${s}.y`);',                     // ns segment breaks — unprovable
          'export const d = t(`job.entities.x.title`);',         // fully static template
          'export const m = { desc_key: `${K}.desc.z` };',       // dynamic field — unprovable
          'export const n = { label_key: "app.common.ok" };',    // app.* always legal
        ].join("\n") + "\n",
      },
      KEYCFG,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-");
  }, T);

  it("camelCase *Key fields flag foreign-ns — labelKey/messageKey/errorScopeKey", () => {
    const r = runLint(
      {
        "x.ts":
          'export const m = { labelKey: "system.entities.x.title" };\n' +
          'export const n = { messageKey: "custom.foo.bar" };\n' +
          'export const o = { errorScopeKey: "other.errors.scope.x" };\n',
      },
      KEYCFG,
    );
    expect(r.code).toBe(1);
    expect(r.out.match(/\[i18n-key-ns\]/g)?.length).toBe(3);
  }, T);

  it("camelCase *Key fields pass own-ns and app.* citations", () => {
    const r = runLint(
      {
        "x.ts":
          'export const m = { labelKey: "job.module.name" };\n' +
          'export const n = { messageKey: "app.common.ok" };\n' +
          'export const o = { errorScopeKey: "job.errors.scope.x" };\n' +
          'export const p = { titleKey: `job.entities.x.title` };\n',
      },
      KEYCFG,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-");
  }, T);

  it("non-i18n *Key denylist — systemKey/credential family never flag", () => {
    const r = runLint(
      {
        "x.ts":
          'export const m = { systemKey: "ai.partition_maintenance" };\n' +
          'export const n = { apiKey: "v1.abc.def" };\n' +
          'export const o = { publicKey: "rsa.pub" };\n',
      },
      KEYCFG,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-");
  }, T);

  it("tFn() alias calls flag foreign-ns literals and template prefixes", () => {
    const r = runLint(
      {
        "x.ts": [
          "declare const tFn: (k: string) => string;",
          "declare const s: string;",
          'export const a = tFn("system.entities.x.title");',
          "export const b = tFn(`custom.c.${s}`);",
        ].join("\n") + "\n",
      },
      KEYCFG,
    );
    expect(r.code).toBe(1);
    expect(r.out.match(/\[i18n-key-ns\]/g)?.length).toBe(2);
  }, T);

  it("tFn() alias stays clean for own-ns and single-segment args", () => {
    const r = runLint(
      {
        "x.ts": [
          "declare const tFn: (k: string) => string;",
          'export const a = tFn("job.module.name");',
          'export const b = tFn("loading");',
          'export const c = tFn("app.common.ok");',
        ].join("\n") + "\n",
      },
      KEYCFG,
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-");
  }, T);

  it("i18n-sql-key-ref flags foreign-ns refs in INSERT column cells only", () => {
    const r = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_seed.sql":
        "INSERT INTO job.config_entries (key, label_key, description_key) VALUES " +
        "('svc', 'system.settings.config.svc.label', 'job.settings.config.svc.desc');\n",
    });
    expect(r.code).toBe(1);
    // system.* flagged once; job.* and the plain `key` data cell stay clean.
    expect(r.out.match(/\[i18n-sql-key-ref\]/g)?.length).toBe(1);
    expect(r.out).toContain("system.settings.config.svc.label");
  }, T);

  it("i18n-sql-key-ref honors declared i18n_namespaces over the target fallback", () => {
    const r = runLintRepo(
      {
        "src/x.ts": "export const x = 1;\n",
        "db-meta/patches/0001_seed.sql":
          "INSERT INTO public.config_entries (key, label_key) VALUES ('oidc', 'system.settings.config.oidc.label');\n",
      },
      { i18n_namespaces: ["app", "system", "custom"] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-sql-key-ref]");
  }, T);

  it("translations targets are skipped — the seeded key column is i18n-sql-ns domain", () => {
    const r = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_seed.sql":
        "INSERT INTO job.translations (key, language, value) VALUES ('job.a.b', 'en-GB', 'x');\n",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-sql-key-ref]");
  }, T);

  it("UPDATE SET flags foreign-ns refs — WHERE literals are predicates, not refs", () => {
    const bad = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_fix.sql":
        "UPDATE job.config_entries SET label_key = 'system.settings.config.x' WHERE key = 'svc';\n",
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("[i18n-sql-key-ref]");
    // The canonical repoint: writes job.*, selects system.* — must be clean.
    const good = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_fix.sql":
        "UPDATE job.config_entries SET label_key = 'job.settings.config.svc.label' WHERE label_key = 'system.settings.config.svc.label';\n",
    });
    expect(good.code).toBe(0);
    expect(good.out).not.toContain("[i18n-sql-key-ref]");
  }, T);

  it("nested JSON *_key refs inside type_config literals flag", () => {
    const r = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_seed.sql":
        `INSERT INTO job.config_entries (key, type_config) VALUES ('svc', '{"values":{"a":{"label_key":"system.b.c"}}}');\n`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[i18n-sql-key-ref]");
  }, T);

  it("system_key columns are not i18n refs (callable subjects)", () => {
    const r = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "db-meta/patches/0001_seed.sql":
        "INSERT INTO job.triggers (name, system_key) VALUES ('x', 'ai.partition_maintenance');\n",
    });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-sql-key-ref]");
  }, T);

  it("i18n_key_ref_exempt grandfathers shipped patches by filename", () => {
    const r = runLintRepo(
      {
        "src/x.ts": "export const x = 1;\n",
        "db-meta/patches/0002_seed.sql":
          "INSERT INTO job.config_entries (key, label_key) VALUES ('svc', 'system.settings.config.svc.label');\n",
      },
      { i18n_key_ref_exempt: ["0002_seed.sql"] },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("[i18n-sql-key-ref]");
  }, T);
});

describe("check-standards — suppress-no-reason", () => {
  it("bare eslint-disable tags flag", () => {
    const r = runLint({
      "x.ts": "// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst a: any = 1;\nexport { a };\n",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[suppress-no-reason]");
  }, T);

  it("` -- <reason>` tail satisfies the rule", () => {
    const r = runLint({
      "x.ts": "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- port boundary: dal-pg types cannot be named here\nconst a: any = 1;\nexport { a };\n",
    });
    expect(r.out).not.toContain("[suppress-no-reason]");
  }, T);

  it("svelte-ignore with an adjacent explanatory comment passes; alone it flags", () => {
    const explained = runLint({
      "C.svelte": "<script>\n  let { v } = $props();\n  // svelte-ignore state_referenced_locally\n  // local draft — snapshots once, remounts re-read\n  let d = $state(v);\n</script>\n",
    });
    expect(explained.out).not.toContain("[suppress-no-reason]");
    const bare = runLint({
      "C.svelte": "<script>\n  let { v } = $props();\n\n  // svelte-ignore state_referenced_locally\n\n  let d = $state(v);\n</script>\n",
    });
    expect(bare.out).toContain("[suppress-no-reason]");
  }, T);

  it("@ts-ignore/@ts-expect-error need reasons too", () => {
    const r = runLint({
      "x.ts": "// @ts-ignore\nconst a = 1;\nexport { a };\n",
    });
    expect(r.out).toContain("[suppress-no-reason]");
    const ok = runLint({
      "x.ts": "// @ts-expect-error -- upstream lib ships wrong overload\nconst a = 1;\nexport { a };\n",
    });
    expect(ok.out).not.toContain("[suppress-no-reason]");
  }, T);

  it("an HTML-comment close `-->` does NOT count as a reason", () => {
    const r = runLint({
      "C.svelte": "<p>x</p>\n\n<!-- eslint-disable-next-line svelte/no-at-html-tags -->\n{@html h}\n",
    });
    expect(r.out).toContain("[suppress-no-reason]");
  }, T);

  it("block-form disable with reason + enable passes", () => {
    const r = runLint({
      "x.ts": "/* eslint-disable @typescript-eslint/no-explicit-any -- port boundary */\nconst a: any = 1;\nexport { a };\n/* eslint-enable @typescript-eslint/no-explicit-any */\n",
    });
    expect(r.out).not.toContain("[suppress-no-reason]");
  }, T);
});

describe("check-standards — suppress-no-reason multi-line explanations", () => {
  it("a multi-line HTML comment ending just above the tag counts as explained", () => {
    const r = runLint({
      "C.svelte": "<!-- listbox pattern: the column owns the tab stop and arrow\n     stepping — options are not individually focusable. -->\n<!-- svelte-ignore a11y_click_events_have_key_events -->\n<div onclick={() => {}} role=\"option\"></div>\n",
    });
    expect(r.out).not.toContain("[suppress-no-reason]");
  }, T);

  it("a multi-line block comment above a ts tag counts as explained", () => {
    const r = runLint({
      "x.ts": "/* the registry is heterogeneous —\n   each entry declares its own props. */\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst a: any = 1;\nexport { a };\n",
    });
    expect(r.out).not.toContain("[suppress-no-reason]");
  }, T);
});

describe("check-standards — no-native-dialog", () => {
  const FE = "fe";

  it("flags bare confirm()/alert()/prompt() expression calls", () => {
    const r = runLint({
      "src/a.svelte": "const x = confirm(t(key));\nconst y = alert('msg');\nconst z = !prompt('?');\n",
    }, undefined, FE);
    expect(r.code).toBe(1);
    expect((r.out.match(/no-native-dialog/g) ?? []).length).toBe(3);
  }, T);

  it("flags window. / globalThis.-prefixed natives", () => {
    const r = runLint({
      "src/a.ts": "window.confirm('x');\nglobalThis.alert('y');\n",
    }, undefined, FE);
    expect(r.code).toBe(1);
    expect((r.out.match(/no-native-dialog/g) ?? []).length).toBe(2);
  }, T);

  it("method calls and identifier suffixes are NOT native calls", () => {
    const r = runLint({
      "src/a.ts": [
        "dialog.confirm(row);",
        "host.confirm(x);",
        "const ok = confirmDelete(row);",
        "const p = promptForName(x);",
        "alertBox.show();",
      ].join("\n"),
    }, undefined, FE);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("no-native-dialog");
  }, T);

  it("local function declarations + no-arg calls don't fire", () => {
    const r = runLint({
      "src/a.svelte": "function confirm() { return true; }\nconst ok = confirm();\n",
    }, undefined, FE);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("no-native-dialog");
  }, T);

  it("comment bodies never fire", () => {
    const r = runLint({
      "src/a.ts": "// guard calls confirm() natively — migrated\nconst x = 1;\n",
    }, undefined, FE);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("no-native-dialog");
  }, T);

  it("standards-exempt CANNOT suppress it — the tag itself is flagged", () => {
    const r = runLint({
      "src/a.svelte": "// standards-exempt: no-native-dialog — legacy gate\nconst x = confirm(t(key));\n",
    }, undefined, FE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("exempt-governance");
    expect(r.out).toContain("no-native-dialog");
  }, T);

  it("fe/src remote surfaces inside consumer repos inherit the rule", () => {
    const r = runLintRepo({
      "src/x.ts": "export const x = 1;\n",
      "fe/src/lib/Page.svelte": "const y = confirm('del?');\n",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("no-native-dialog");
    expect(r.out).toContain("Page.svelte");
  }, T);

  it("consumer profile does NOT scan server src for natives (browser rule)", () => {
    const r = runLint({
      "src/a.ts": "const x = confirm(t);\n",
    });
    expect(r.out).not.toContain("no-native-dialog");
  }, T);
});

describe("check-standards — ext-json codec boundary", () => {
  it("flags raw JSON.stringify/JSON.parse", () => {
    const r = runLint({
      "services/x.ts": 'export const a = JSON.stringify({ a: 1 });\nexport const b = JSON.parse("{}");\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[ext-json]");
  }, T);

  it("flags argument-less .json() wire reads", () => {
    const r = runLint({
      "services/x.ts": 'export async function f(res: Response) { return res.json(); }\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[ext-json]");
  }, T);

  it("does NOT flag .json(arg) — express/body senders keep working", () => {
    const r = runLint({
      "controllers/x.ts": 'export function g(res: any, body: unknown) { res.json(body); }\n',
    });
    expect(r.out).not.toContain("[ext-json]");
  }, T);

  it("standards-exempt CANNOT suppress ext-json — governance finding", () => {
    const r = runLint({
      "services/x.ts": '// standards-exempt: ext-json — sanctioned stringify\nexport const s = JSON.stringify({ a: 1 });\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[ext-json]");
    expect(r.out).toContain("[exempt-governance]");
  }, T);

  it("config allowPaths exempts the codec implementation only", () => {
    const r = runLint(
      {
        "ext-json.ts": 'export const p = JSON.parse("{}");\n',
        "services/x.ts": 'export const s = JSON.parse("{}");\n',
      },
      { rules: { "ext-json": { allowPaths: ["ext-json.ts"] } } },
    );
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("ext-json.ts");
    expect(r.out).toContain("services/x.ts");
    expect(r.out).toContain("[ext-json]");
  }, T);

  it("scans test files even without --tests (wire contracts hold in tests)", () => {
    const r = runLint({
      "services/__tests__/x.test.ts": 'const d = JSON.parse("{}");\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("[ext-json]");
    expect(r.out).toContain("x.test.ts");
  }, T);

  it("fe profile flags raw JSON in browser code", () => {
    const r = runLint(
      { "lib/x.ts": 'export const s = JSON.stringify({});\nexport async function f(r: Response) { return r.json(); }\n' },
      undefined,
      "fe",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("[ext-json]");
  }, T);

  it("e2e-wait-budget flags wait timeouts >5s in e2e specs (fe)", () => {
    const r = runLint(
      {
        "e2e/x.spec.ts":
          'await expect(l).toBeVisible({ timeout: 10_000 });\nawait w(url, { timeout: 20_000 });\nawait l.waitFor({ timeout: 6000 });\n',
      },
      undefined,
      "fe",
    );
    expect(r.code).toBe(1);
    expect(r.out.match(/\[e2e-wait-budget\]/g)?.length).toBe(3);
    expect(r.out).toContain("e2e-browser-session.md");
  }, T);

  it("e2e-wait-budget passes: 5s boundary, sub-5s, suite budgets, named/variable budgets", () => {
    const r = runLint(
      {
        "e2e/x.spec.ts":
          'await expect(l).toBeVisible({ timeout: 5_000 });\nawait l.waitFor({ timeout: 900 });\ntest.describe.configure({ timeout: 600_000 });\ntest.describe.configure({ timeout: 90_000, mode: "serial" });\nawait poll({ timeout: timeoutMs });\nawait w({ timeout: LH_TIMEOUT_MS });\n',
      },
      undefined,
      "fe",
    );
    expect(r.code).toBe(0);
  }, T);

  it("e2e-wait-budget does not scan non-e2e paths", () => {
    const r = runLint(
      { "lib/__tests__/x.test.ts": 'const o = { timeout: 60_000 };\n' },
      undefined,
      "fe",
    );
    expect(r.code).toBe(0);
  }, T);

  it("e2e-wait-budget is NO_EXEMPT — standards-exempt on it is itself flagged", () => {
    const r = runLint(
      {
        "e2e/x.spec.ts": '// standards-exempt: e2e-wait-budget — padded wait\nawait expect(l).toBeVisible({ timeout: 10_000 });\n',
      },
      undefined,
      "fe",
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("[exempt-governance]");
    expect(r.out).toContain("[e2e-wait-budget]");
  }, T);
});

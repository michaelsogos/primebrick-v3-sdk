#!/usr/bin/env bun
/**
 * check-standards — zero-dep source scanner enforcing Primebrick standards.
 *
 * Rules (profile `consumer`, for BE + US service repos):
 *   ext-json        `JSON.stringify`/`JSON.parse` — use extJson* (BigInt/Date-safe)
 *   pg-import       `from "pg"` / `require("pg")` — driver access only via dal-pg
 *   pg-pool         `new Pool(` — pools are owned by the Dal gateway
 *   raw-query       `.query(` — raw SQL; use Repository/entity DSL
 *   raw-sql         SQL literals (SELECT…FROM, INSERT INTO, UPDATE…SET,
 *                   DELETE FROM, TRUNCATE/ALTER/CREATE/DROP TABLE, BEGIN/COMMIT)
 *                   inside quoted strings, UPPERCASE keywords only
 *   getPool         `.getPool()` — consumer code must use dal.* proxies
 *   withClient      `withClient` — use dal.transaction(repo => …)
 *   upsert          `.upsert(`/`.upsertMany(` — removed; find → add | update
 *   new-repository  `new Repository(` — use dal.entityService/tableAuditPort
 *   pool-ping       `client|pool|conn.ping(` — raw driver ping; use dal.serverVersion()
 *   entity-nullable-explicit
 *                   In @Entity classes, properties declared `prop?:` or
 *                   `prop: T | null` MUST carry an explicit nullability marker:
 *                   `@Column({ nullable: … })` or an implying decorator
 *                   (@DeletableField / @CloneField / @IsNotColumn). Runtime
 *                   `design:type` inference was removed — it is transpiler
 *                   dependent (esbuild/tsx never emits it; bun collapses
 *                   unions to the concrete type). Without an explicit option,
 *                   an optional property silently snapshots as NOT NULL.
 *   truncated-sibling
 *                   A file whose name is a proper prefix of a sibling's name
 *                   with byte-identical content — the signature of a write
 *                   path cut mid-stream (`AG` next to `AGENTS.md`). Delete
 *                   the prefix file.
 *   nav-decl-access
 *                   A `nav-declaration.ts` declaring a ModuleNavDeclaration
 *                   must set module-level `access:` — declared nav is
 *                   exposed surface and ungated exposure is not allowed.
 *                   Static mirror of the enrollment-time
 *                   `validateNavDeclaration` gate (that one is the authority;
 *                   this catches the omission before boot).
 *
 * Profile `lib` (dal-pg itself): `ext-json` + `entity-nullable-explicit` —
 * the library IS the driver wrapper; query/sql/pool rules are its
 * implementation, not violations.
 *
 * Config-gated rules (activate only via `.devin/check-standards.json` in the
 * repo root — see below):
 *   dal-access      `getDal(`/`initDal(` — data access ONLY inside the
 *                   declared allowlist (gateway, entity-router plumbing,
 *                   bootstrap, approved DB-backed ports, legacy debt). Worker
 *                   services must use `this.dal`/`this.svc` from DomainService.
 *   layer-repo-import
 *                   `from|import|require "…*(-|_)(dal|repo|repository)"` —
 *                   forbidden inside the configured path scopes (transport +
 *                   dispatch layers must call services, never repo wrappers).
 *
 * `.devin/check-standards.json` — per-repo rule activation + allowlists:
 *   {
 *     "rules": {
 *       "dal-access":        { "allowPaths": ["db/dal-gateway.ts", …] },
 *       "layer-repo-import": { "appliesTo":  ["controllers/", "modules/mcp/"] }
 *     }
 *   }
 * `allowPaths` = exact srcDir-relative file paths exempt from the rule.
 * `appliesTo`  = path prefixes the rule is restricted to (default: all files).
 *
 * Exemptions — put on the SAME line or the line directly ABOVE the call:
 *   // standards-exempt: <rule-id>[,<rule-id>…] — <reason (required)>
 *   // standards-exempt: all — <reason>
 * File-level (tooling files only — every line is the same sanctioned pattern):
 *   // standards-exempt-file: <rule-id>[,<rule-id>…] — <reason (required)>
 * A missing/short reason is itself a violation.
 *
 * Usage:
 *   bun tools/check-standards.ts <srcDir> [--profile=consumer|lib] [--tests]
 * Exit 0 = clean, 1 = violations.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

type RuleId =
  | "ext-json"
  | "pg-import"
  | "pg-pool"
  | "raw-query"
  | "raw-sql"
  | "getPool"
  | "withClient"
  | "upsert"
  | "new-repository"
  | "pool-ping"
  | "entity-nullable-explicit"
  | "dal-access"
  | "layer-repo-import"
  | "i18n-key-ns"
  | "i18n-sql-ns"
  | "nav-decl-access"
  | "truncated-sibling";

interface Rule {
  id: RuleId;
  pattern: RegExp;
  hint: string;
  /** srcDir-relative paths (normalized to `/`) that never fire the rule. */
  allowPaths?: RegExp;
  /** srcDir-relative path prefixes the rule is restricted to (absent = all). */
  appliesTo?: RegExp;
}

const LINE_RULES: Rule[] = [
  { id: "ext-json", pattern: /\bJSON\.(?:stringify|parse)\b/, hint: "use extJsonStringify/extJsonParse" },
  { id: "pg-import", pattern: /(?:from\s+["']pg["']|require\(\s*["']pg["']\s*\))/, hint: "driver access only via dal-pg" },
  { id: "pg-pool", pattern: /\bnew\s+Pool\s*\(/, hint: "pools are owned by the Dal gateway" },
  { id: "raw-query", pattern: /\.query\s*\(/, hint: "raw SQL — use Repository/entity DSL" },
  { id: "getPool", pattern: /\.getPool\s*\(\s*\)|\bgetPool\s*\(\s*\)/, hint: "use dal.* proxies (sanctioned: migration tooling only)" },
  { id: "withClient", pattern: /\bwithClient\b/, hint: "use dal.transaction(repo => …)" },
  { id: "upsert", pattern: /\.upsert(?:Many)?\s*\(/, hint: "upsert removed — find → add | update(version)" },
  { id: "new-repository", pattern: /\bnew\s+Repository\s*\(/, hint: "use dal.entityService()/dal.tableAuditPort()" },
  { id: "pool-ping", pattern: /\b(?:client|pool|conn)\.ping\s*\(/, hint: "raw driver ping — use dal.serverVersion()" },
];

// Config-gated rules — populated from `.devin/check-standards.json` (repo
// root); absent from the config = rule off entirely. Patterns are fixed;
// allowPaths/appliesTo come from the per-repo config.
const GATED_RULE_IDS = new Set<RuleId>(["dal-access", "layer-repo-import"]);
const GATED_LINE_RULES: Rule[] = [
  { id: "dal-access", pattern: /\b(?:initDal|getDal)\s*\(/, hint: "data access via this.dal/this.svc (DomainService) — getDal()/initDal() only inside the declared allowlist" },
  { id: "layer-repo-import", pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*[-_](?:dal|repo|repository)(?:\.js|\.ts)?["']/, hint: "transport/dispatch layers must call services — never import *-dal/*-repo modules" },
];

interface StandardsConfig {
  rules?: Record<string, { allowPaths?: string[]; appliesTo?: string[] } | true>;
  /**
   * Allowed first-segment i18n namespaces for `*_key` literals
   * (`label_key: "job.jobs.nav"` → `job`). Presence activates the
   * `i18n-key-ns` rule. Per the namespace contract: a module declares
   * `{own-code, app, system}` — meta may REFERENCE core labels but never
   * foreign non-core namespaces.
   */
  i18n_namespaces?: string[];
  /**
   * db-meta/patches filenames exempt from `i18n-sql-ns` — shipped patches
   * that predate the namespace boundary can never be edited, so they are
   * grandfathered by name. New patches must comply.
   */
  i18n_sql_exempt?: string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact relative paths → `^(?:a/b/c.ts|…)$`. */
function exactPathsRegex(paths: string[] | undefined): RegExp | undefined {
  if (!paths?.length) return undefined;
  return new RegExp(`^(?:${paths.map(escapeRe).join("|")})$`);
}

/** Path prefixes → `^(?:controllers/|modules/mcp/)`. */
function prefixRegex(paths: string[] | undefined): RegExp | undefined {
  if (!paths?.length) return undefined;
  return new RegExp(`^(?:${paths.map(escapeRe).join("|")})`);
}

function loadStandardsConfig(): StandardsConfig {
  const p = join(process.cwd(), ".devin", "check-standards.json");
  try {
    return JSON.parse(readFileSync(p, "utf8")) as StandardsConfig;
  } catch {
    return {};
  }
}

// ── entity-nullable-explicit ────────────────────────────────────────────────
// Structural rule: track class scopes by brace depth; a class is an entity
// when its decorator block (immediately above) contains @Entity. Inside it,
// `prop?:` or `prop: … | null` requires `nullable:` in the @Column options or
// a decorator that implies nullability. Decorators in this codebase are
// single-line; the block above a property is collected via @/comment prefix.
const CLASS_DECL = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/;
const ENTITY_PROP_OPTIONAL =
  /^\s*(?:(?:public|private|protected|readonly|declare|static)\s+)*([A-Za-z_]\w*)\s*(\?)?\s*:\s*(.+?);?\s*(?:\/\/.*)?$/;
const NULL_UNION = /\|\s*null\b/;
const NULLABLE_IMPLYING_DECORATOR = /@(?:DeletableField|CloneField|IsNotColumn)\b/;

function decoratorBlockAbove(lines: string[], i: number): string {
  let block = "";
  for (let j = i - 1; j >= 0 && /^\s*(?:@|\/\/|\/\*|\*)/.test(lines[j]); j--) {
    block = lines[j] + "\n" + block;
  }
  return block;
}

function checkEntityNullableExplicit(
  lines: string[],
  rel: string,
  isExempted: (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) => boolean,
  exemptAt: (i: number) => { rules: Set<string>; hasReason: boolean } | null,
): Violation[] {
  const out: Violation[] = [];
  const stack: { depth: number; entity: boolean }[] = [];
  let depth = 0;
  const inEntity = () => stack.some((s) => s.entity);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();

    if (CLASS_DECL.test(line)) {
      const startDepth = depth;
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      stack.push({ depth: startDepth, entity: /@Entity\b/.test(decoratorBlockAbove(lines, i)) });
      continue;
    }

    if (inEntity()) {
      const m = line.match(ENTITY_PROP_OPTIONAL);
      if (m) {
        const nullableDecl = m[2] === "?" || NULL_UNION.test(m[3]);
        const block = decoratorBlockAbove(lines, i);
        const hasTrue = /nullable\s*:\s*true\b/.test(block) || NULLABLE_IMPLYING_DECORATOR.test(block);
        const hasFalse = /nullable\s*:\s*false\b/.test(block);
        const bad =
          (nullableDecl && !hasTrue) ||                    // `?`/`| null` must declare nullable:true
          (!nullableDecl && hasTrue && !hasFalse);          // non-optional must NOT declare nullable:true
        if (bad) {
          // exemption may sit on the prop line or anywhere in the decorator block
          const exempt =
            exemptAt(i) ??
            block
              .split("\n")
              .map((l) => parseExempt(l))
              .find(Boolean) ??
            null;
          if (!isExempted(exempt, "entity-nullable-explicit")) {
            out.push({
              file: rel,
              line: i + 1,
              rule: "entity-nullable-explicit",
              text: line.trim(),
              hint: nullableDecl
                ? "optional/null-union entity prop needs @Column({ nullable: true }) or @DeletableField/@CloneField"
                : "non-optional entity prop must not declare nullable: true — drop it or make the prop optional",
            });
          }
        }
      }
    }

    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
  }
  return out;
}

// SQL shapes inside quoted strings — UPPERCASE keywords only (project SQL
// style), so UI text like "Update an existing entity" does not fire.
const STRING_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const SQL_SHAPES =
  /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bTRUNCATE\s+(?:TABLE\s+)?\w|\bUPDATE\s+\w+\s+SET\b|\bSELECT\b.{0,300}?\bFROM\b|\bALTER\s+TABLE\b|\bCREATE\s+TABLE\b|\bDROP\s+TABLE\b|\bBEGIN\b\s*;?|\bCOMMIT\b\s*;?|\bROLLBACK\b\s*;?/;

const CONSUMER_RULES = new Set<RuleId>([
  "ext-json", "pg-import", "pg-pool", "raw-query", "raw-sql",
  "getPool", "withClient", "upsert", "new-repository", "pool-ping",
  "entity-nullable-explicit", "nav-decl-access",
]);
const LIB_RULES = new Set<RuleId>(["ext-json", "entity-nullable-explicit"]);

interface Violation {
  file: string;
  line: number;
  rule: RuleId | "exempt-no-reason";
  text: string;
  hint: string;
}

function isCommentOnly(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function parseExempt(line: string, fileLevel = false): { rules: Set<string>; hasReason: boolean } | null {
  // Rule ids contain hyphens (ext-json) — the reason separator must be the
  // em-dash surrounded by spaces: `// standards-exempt: <ids> — <reason>`.
  const tag = fileLevel ? "standards-exempt-file:" : "standards-exempt:";
  const m = line.match(new RegExp(`\\/\\/\\s*${tag.replace(":", "\\:")}\\s*([\\w,\\s-]+?)\\s+—\\s*(.+)`));
  if (!m) {
    if (line.includes(tag)) return { rules: new Set(["__invalid__"]), hasReason: false };
    return null;
  }
  const rules = new Set(m[1].split(",").map((s) => s.trim()));
  return { rules, hasReason: m[2].trim().length >= 8 };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (entry.endsWith(".ts")) yield p;
  }
}

// truncated-sibling — a model write whose file_path was cut mid-stream
// leaves a sibling file whose name is a proper prefix of the intended
// file's name, carrying the full content (e.g. `AG` next to `AGENTS.md`,
// `foo.t` next to `foo.ts`). Flag the prefix file only when its content is
// byte-identical to the longer sibling — name-prefix alone has legitimate
// cases (Dockerfile vs Dockerfile.prod never share content).
function* walkAll(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walkAll(p);
    else yield p;
  }
}

function checkTruncatedSiblings(srcDir: string): Violation[] {
  const out: Violation[] = [];
  const byDir = new Map<string, string[]>();
  for (const f of walkAll(srcDir)) {
    const d = dirname(f);
    (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
  }
  for (const files of byDir.values()) {
    for (const f of files) {
      const name = basename(f);
      for (const g of files) {
        if (g === f || !basename(g).startsWith(name) || basename(g) === name) continue;
        if (statSync(f).size !== statSync(g).size) continue;
        if (!readFileSync(f).equals(readFileSync(g))) continue;
        out.push({
          file: relative(srcDir, f).replace(/\\/g, "/"), line: 1, rule: "truncated-sibling",
          text: name, hint: `truncated-write sibling of ${basename(g)} — delete this file`,
        });
      }
    }
  }
  return out;
}

function isTestFile(p: string): boolean {
  return (
    p.includes("__tests__") ||
    /\.(test|spec)\.ts$/.test(p) ||
    /[\\/]tests?[\\/]/.test(p)
  );
}

function checkFile(file: string, srcDir: string, rules: Set<RuleId>, i18nNamespaces?: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  const rel = relative(srcDir, file).replace(/\\/g, "/");

  // Per-file rule scope: allowPaths skips the file entirely for that rule;
  // appliesTo restricts where the rule fires at all.
  const activeLineRules = LINE_RULES.filter(
    (r) =>
      rules.has(r.id) &&
      !r.allowPaths?.test(rel) &&
      (!r.appliesTo || r.appliesTo.test(rel)),
  );

  // File-level exemption — scanned before the loop; still requires a reason.
  const fileExempt = lines.map((l) => parseExempt(l, true)).find(Boolean) ?? null;
  if (fileExempt && !fileExempt.hasReason) {
    const lineNo = lines.findIndex((l) => l.includes("standards-exempt-file:")) + 1;
    out.push({
      file: rel, line: lineNo, rule: "exempt-no-reason",
      text: lines[lineNo - 1]?.trim() ?? "", hint: "standards-exempt-file requires a reason after '—'",
    });
  }
  const isExempted = (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) =>
    (exempt?.hasReason && (exempt.rules.has(id) || exempt.rules.has("all"))) ||
    (fileExempt?.hasReason && (fileExempt.rules.has(id) || fileExempt.rules.has("all")));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnly(line)) continue;

    const exemptHere = parseExempt(line);
    const exemptAbove = i > 0 ? parseExempt(lines[i - 1]) : null;
    const exempt = exemptHere ?? exemptAbove;

    if (exempt && !exempt.hasReason) {
      out.push({
        file: rel, line: i + 1, rule: "exempt-no-reason",
        text: line.trim(), hint: "standards-exempt requires a reason after '—'",
      });
    }

    for (const rule of activeLineRules) {
      if (!rule.pattern.test(line)) continue;
      if (isExempted(exempt, rule.id)) continue;
      out.push({ file: rel, line: i + 1, rule: rule.id, text: line.trim(), hint: rule.hint });
      break; // one finding per line keeps output readable
    }

    if (rules.has("raw-sql")) {
      STRING_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STRING_RE.exec(line))) {
        if (SQL_SHAPES.test(m[0])) {
          if (!isExempted(exempt, "raw-sql")) {
            out.push({ file: rel, line: i + 1, rule: "raw-sql", text: line.trim(), hint: "raw SQL literal — use entity DSL/Repository" });
          }
          break;
        }
      }
    }

    if (i18nNamespaces) {
      I18N_KEY_LITERAL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = I18N_KEY_LITERAL.exec(line))) {
        if (!i18nNamespaces.has(m[1])) {
          out.push({
            file: rel,
            line: i + 1,
            rule: "i18n-key-ns" as RuleId,
            text: line.trim(),
            hint: `i18n key namespace '${m[1]}' is outside this repo's allowlist {${[...i18nNamespaces].join(", ")}} — declarations may reference own + CORE (app/system) namespaces only`,
          });
        }
      }
    }
  }

  if (rules.has("entity-nullable-explicit")) {
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    out.push(...checkEntityNullableExplicit(lines, rel, isExempted, exemptAt));
  }

  // nav-decl-access — a file declaring a ModuleNavDeclaration must set
  // module-level `access:` somewhere (top-level decl property). Item-level
  // access alone also satisfies the literal check by design — exact-value
  // enforcement lives in `validateNavDeclaration` at enrollment; this lint
  // only proves the omission does not pass silently.
  if (
    rules.has("nav-decl-access") &&
    basename(file) === "nav-declaration.ts" &&
    lines.some((l) => l.includes("ModuleNavDeclaration"))
  ) {
    const declLine = lines.findIndex((l) => l.includes("ModuleNavDeclaration"));
    const hasAccess = lines.some((l) => /^\s*access\s*:/.test(l));
    if (!hasAccess) {
      const exempt =
        parseExempt(lines[declLine]) ?? (declLine > 0 ? parseExempt(lines[declLine - 1]) : null);
      if (!isExempted(exempt, "nav-decl-access")) {
        out.push({
          file: rel,
          line: declLine + 1,
          rule: "nav-decl-access",
          text: lines[declLine]?.trim() ?? "",
          hint: "nav declaration must set module-level `access:` (accessNamespace(code, part_of)) — declared nav is exposed surface; ungated modules are not allowed",
        });
      }
    }
  }
  return out;
}

// i18n-key-ns — captures `*_key:` string literals (`label_key`, `title_key`,
// `tooltip_key`, …) whose value is namespaced (`"ns.rest"`). The first
// segment must be in the repo's configured `i18n_namespaces` allowlist.
// Single-segment values (`sort_key: "key"` — a field name, not i18n) are
// skipped by requiring a dot in the literal.
const I18N_KEY_LITERAL = /\b(?:\w*_key|tooltip|tooltip_title)\s*:\s*["'`]([a-z][a-z0-9_]*)\.[a-z0-9_.]*["'`]/g;

// i18n-sql-ns — db-meta seed boundary: a patch may insert translation keys
// only inside the namespace owned by the target schema. Canonical rule
// (mirrors @primebrick/core `translationKeyNamespace` — this tool is
// zero-dep by design): `public` → `app`, else the schema name itself.
const SQL_INSERT_TRANSLATIONS = /INSERT\s+INTO\s+"?(\w+)"?\.translations/i;
const SQL_TUPLE_KEY = /\(\s*'([a-z][a-z0-9_]*)\./g;

function sqlKeyNamespace(schema: string): string {
  return schema === "public" ? "app" : schema;
}

/** Scan db-meta/patches/*.sql for translation seeds violating the schema→namespace boundary. */
function checkTranslationSeedPatches(repoRoot: string, exemptFiles: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const dir = join(repoRoot, "db-meta", "patches");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql") && !exemptFiles.has(f));
  } catch {
    return out; // no db-meta/patches in this repo — rule does not apply
  }
  for (const f of files) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    let targetSchema: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ins = line.match(SQL_INSERT_TRANSLATIONS);
      if (ins) targetSchema = ins[1].toLowerCase();
      if (targetSchema) {
        SQL_TUPLE_KEY.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = SQL_TUPLE_KEY.exec(line))) {
          const expected = sqlKeyNamespace(targetSchema);
          if (m[1] !== expected) {
            out.push({
              file: `db-meta/patches/${f}`,
              line: i + 1,
              rule: "i18n-sql-ns" as RuleId,
              text: line.trim(),
              hint: `keys seeded into ${targetSchema}.translations must start with '${expected}.' — a schema owns only its own namespace`,
            });
          }
        }
        if (/;\s*(?:--.*)?$/.test(line) && !/INSERT\s+INTO/i.test(line)) targetSchema = null;
      }
    }
  }
  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const profile = args.find((a) => a.startsWith("--profile="))?.split("=")[1] ?? "consumer";
const includeTests = args.includes("--tests");

if (!dir) {
  console.error("usage: check-standards <srcDir> [--profile=consumer|lib] [--tests]");
  process.exit(2);
}

const rules = new Set(profile === "lib" ? LIB_RULES : CONSUMER_RULES);

// Config-gated rules: `.devin/check-standards.json` in the repo root enables
// them per-repo and carries their allowPaths/appliesTo (injected onto the
// rule objects here — patterns stay fixed in code).
const cfg = loadStandardsConfig();
for (const [id, opts] of Object.entries(cfg.rules ?? {})) {
  if (!GATED_RULE_IDS.has(id as RuleId)) continue;
  const rule = GATED_LINE_RULES.find((r) => r.id === id);
  if (!rule) continue;
  if (opts !== true) {
    rule.allowPaths = exactPathsRegex(opts.allowPaths);
    rule.appliesTo = prefixRegex(opts.appliesTo);
  }
  LINE_RULES.push(rule);
  rules.add(rule.id);
}

const violations: Violation[] = [];
// i18n-key-ns — activated by `i18n_namespaces` in .devin/check-standards.json.
const i18nNamespaces = cfg.i18n_namespaces?.length ? new Set(cfg.i18n_namespaces) : undefined;

for (const file of walk(dir)) {
  if (!includeTests && isTestFile(file)) continue;
  violations.push(...checkFile(file, dir, rules, i18nNamespaces));
}

// i18n-sql-ns — repo-level scan of db-meta/patches (outside srcDir);
// always-on — the schema→namespace seed boundary is a repo invariant.
// `i18n_sql_exempt` grandfathers shipped pre-boundary patches by filename.
violations.push(...checkTranslationSeedPatches(process.cwd(), new Set(cfg.i18n_sql_exempt ?? [])));

// truncated-sibling — always-on; sweeps every file in the REPO (cwd),
// not just srcDir and not just .ts — the classic victims are root files
// (AGENTS.md, package.json) and docs/, which srcDir never covers.
violations.push(...checkTruncatedSiblings(process.cwd()));

for (const v of violations) {
  console.log(`${v.file}:${v.line}  [${v.rule}] ${v.text.slice(0, 140)}  → ${v.hint}`);
}
if (violations.length) {
  console.error(`\ncheck-standards: ${violations.length} violation(s) [profile=${profile}]`);
  process.exit(1);
}
console.log(`check-standards: clean [profile=${profile}]`);

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
 *   column-flag-defaults
 *                   `col.default_visible|sortable|filterable|searchable
 *                   !==|=== false` — column flags are opt-out (absent =
 *                   enabled); read them ONLY via the canonical predicates
 *                   isColumnVisible/isColumnSortable/isColumnFilterable/
 *                   isColumnSearchable in @primebrick/core. The canonical
 *                   implementation file (core/src/columns.ts) is exempt.
 *   entity-nullable-explicit
 *                   In @Entity classes, properties declared `prop?:` or
 *                   `prop: T | null` MUST carry an explicit nullability marker:
 *                   `@Column({ nullable: … })` or an implying decorator
 *                   (@DeletableField / @CloneField / @IsNotColumn). Runtime
 *                   `design:type` inference was removed — it is transpiler
 *                   dependent (esbuild/tsx never emits it; bun collapses
 *                   unions to the concrete type). Without an explicit option,
 *                   an optional property silently snapshots as NOT NULL.
 *   entity-type-declared
 *                   In @Entity classes, a column prop whose annotation maps
 *                   to NON-text storage (`Date`, `bigint`, `number`,
 *                   `boolean`, `UUID`, `Decimal`, `Vector`, `ISODate`,
 *                   `ISOTime`, `unknown`/`any`/`object`/`Record`, arrays,
 *                   `Uint8Array`/`Buffer`) MUST carry a decorator-visible
 *                   type declaration: `@Column({ jsType })`, an explicit
 *                   `pgType`, a semantic-pin decorator (@AuditableField /
 *                   @DeletableField / @SynchronizableField), or a
 *                   non-manual @Key (identity keys pin int8). The TS
 *                   annotation is erased at transpile — without the option
 *                   the column silently resolves `pg_type:"text"` at
 *                   runtime (wrong widget, wrong flags, lying contract,
 *                   missing ILIKE text-cast → 42883 on search).
 *                   `string`/string-literal-union and unknown named aliases
 *                   are NOT flagged — they legitimately map to text.
 *                   A declared jsType must MATCH the annotation: `Date`
 *                   takes only "instant", `bigint` only "bigint",
 *                   `Decimal`/`Vector` only their codec; annotations
 *                   without a codec take NO jsType (pgType instead).
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
 * Profile `fe` (browser SPA repos): NO base rules — the consumer set encodes
 * server-side contracts (driver boundary, BigInt-safe JSON) that are false
 * positives in browser code. Only config-gated rules fire, exactly the same
 * opt-in mechanism the other repos use.
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
 *   raw-switch      `import { …Switch… } from '@primebrick/ui'` — labelled
 *                   booleans MUST render SwitchField (switch-first anatomy).
 *                   Raw Switch is composite-internal only; sanctioned
 *                   composites go in `allowPaths`. Multi-line import lists
 *                   are caught by the structural pass.
 *   button-variant-toolbar
 *                   `variant="soft"` — toolbar action CTAs are solid variants
 *                   only (default/destructive/warning; `outline` for
 *                   secondary). `soft` is reserved for Layout-1 in-card
 *                   secondary CTAs. Scope via `appliesTo` (toolbar dirs).
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
 * Baseline (declared-debt gate): `.devin/check-standards-baseline.json` in
 * the repo root carries `{ "violations": [{file,rule,text}] }` — entries
 * suppressed on every run; any violation NOT in the baseline fails.
 * Identity = file+rule+full line text (line numbers excluded: insertions
 * elsewhere must not resurrect hidden debt; editing the line IS new debt).
 * Stale entries warn, never fail. Regenerate: `--write-baseline`.
 *
 * Usage:
 *   bun tools/check-standards.ts <srcDir> [--profile=consumer|lib|fe] [--tests] [--write-baseline]
 * Exit 0 = clean, 1 = violations, 2 = malformed baseline/usage.
 *
 * Auto-scan: when the invoked repo contains `fe/src` (remote-module bundle),
 * that tree is ALWAYS scanned too under the `fe` profile + the same
 * config-gated rules — presence, not config, is the trigger; findings print
 * as `fe/src/<file>`. This is the single canonical tool: repos invoke it via
 * sibling path (`bun ../../primebrick-v3-sdk/tools/check-standards.ts src`).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
// Zero-dep by contract: the honesty matrix is imported from the sibling
// core checkout BY RELATIVE PATH (workspace layout — same shape in CI:
// checkouts sit side by side). Never @primebrick/core — that would force
// an install step the tool must not need.
import { HONEST_FORMAT_HINTS } from "../../primebrick-v3-core/src/honest-format-hints.ts";

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
  | "entity-type-declared"
  | "column-flag-defaults"
  | "error-detail-stringify"
  | "dal-access"
  | "layer-repo-import"
  | "i18n-key-ns"
  | "i18n-sql-ns"
  | "i18n-key-grammar"
  | "seed-audit-trail"
  | "nav-decl-access"
  | "schema-honest-format"
  | "raw-switch"
  | "button-variant-toolbar"
  | "truncated-sibling"
  | "panel-layout"
  | "panel-content-scroll"
  | "panel-raw-label"
  | "panel-control-id"
  | "panel-select-dropdown"
  | "panel-button-testid"
  | "panel-switch"
  | "panel-search-clearable"
  | "panel-raw-input"
  | "panel-footer-chrome"
  | "panel-footer-start"
  | "panel-toolbar-tools"
  | "panel-chrome-class"
  | "native-control"
  | "field-stock-chrome"
  | "i18n-entity-fallback"
  | "page-scaffold-ownership"
  | "icon-no-fallback";

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
  // Serialized content in `detail`/`message`/`extra` fields is a contract
  // violation: `detail` carries human text, structured payloads live in
  // `extra` as NATIVE objects (the body serializer owns the only encode).
  { id: "error-detail-stringify", pattern: /(?:detail|message|error_detail|extra)\s*[:=]\s*[^\n;]*\b(?:JSON\.stringify|extJsonStringify)|\b(?:new\s+\w*Error|sendRfcError|replyError)\s*\([^)\n]*\b(?:JSON\.stringify|extJsonStringify)/, hint: "never serialize into error detail/message/extra — detail is human text; structured payloads go in `extra` as native objects" },
  { id: "pg-import", pattern: /(?:from\s+["']pg["']|require\(\s*["']pg["']\s*\))/, hint: "driver access only via dal-pg" },
  { id: "pg-pool", pattern: /\bnew\s+Pool\s*\(/, hint: "pools are owned by the Dal gateway" },
  { id: "raw-query", pattern: /\.query\s*\(/, hint: "raw SQL — use Repository/entity DSL" },
  { id: "getPool", pattern: /\.getPool\s*\(\s*\)|\bgetPool\s*\(\s*\)/, hint: "use dal.* proxies (sanctioned: migration tooling only)" },
  { id: "withClient", pattern: /\bwithClient\b/, hint: "use dal.transaction(repo => …)" },
  { id: "upsert", pattern: /\.upsert(?:Many)?\s*\(/, hint: "upsert removed — find → add | update(version)" },
  { id: "new-repository", pattern: /\bnew\s+Repository\s*\(/, hint: "use dal.entityService()/dal.tableAuditPort()" },
  { id: "pool-ping", pattern: /\b(?:client|pool|conn)\.ping\s*\(/, hint: "raw driver ping — use dal.serverVersion()" },
  { id: "column-flag-defaults", pattern: /\.(?:default_visible|sortable|filterable|searchable)\s*(?:!==|===)\s*false\b/, hint: "column flags are opt-out — read them via isColumnVisible/isColumnSortable/isColumnFilterable/isColumnSearchable (@primebrick/core)" },
  {
    id: "native-control",
    pattern: /<(input|select|textarea)\b/,
    hint: "raw HTML control — use the canonical wrappers (components/input/, ComboSelect, Textarea…)",
    allowPaths: /^lib\/components\/(input|input-group|textarea)\//,
  },
];

// Config-gated rules — populated from `.devin/check-standards.json` (repo
// root); absent from the config = rule off entirely. Patterns are fixed;
// allowPaths/appliesTo come from the per-repo config.
const GATED_RULE_IDS = new Set<RuleId>([
  "dal-access", "layer-repo-import", "raw-switch", "button-variant-toolbar",
  "panel-layout", "panel-content-scroll", "panel-raw-label",
  "panel-control-id", "panel-select-dropdown", "panel-button-testid",
  "panel-switch", "panel-search-clearable", "panel-raw-input",
  "panel-footer-chrome", "panel-footer-start", "panel-toolbar-tools",
  "panel-chrome-class",
  "field-stock-chrome",
  "i18n-entity-fallback", "page-scaffold-ownership", "icon-no-fallback",
]);
const GATED_LINE_RULES: Rule[] = [
  { id: "dal-access", pattern: /\b(?:initDal|getDal)\s*\(/, hint: "data access via this.dal/this.svc (DomainService) — getDal()/initDal() only inside the declared allowlist" },
  { id: "layer-repo-import", pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*[-_](?:dal|repo|repository)(?:\.js|\.ts)?["']/, hint: "transport/dispatch layers must call services — never import *-dal/*-repo modules" },
  // Single-line `import { …Switch… } from '@primebrick/ui'` — \b after
  // "Switch" never matches SwitchField. Multi-line import lists are caught
  // by checkRawSwitch (structural pass below), so no overlap.
  { id: "raw-switch", pattern: /import\s+(?:type\s+)?\{[^}]*\bSwitch\b[^}]*\}\s*from\s*["']@primebrick\/ui["']/, hint: "labelled booleans MUST use SwitchField (switch-first anatomy) — raw Switch is composite-internal only (allowPaths for sanctioned composites)" },
  { id: "button-variant-toolbar", pattern: /variant\s*=\s*\{?\s*["'`]soft["'`]/, hint: "toolbar action CTAs are solid variants only (default/destructive/warning; `outline` for secondary) — `soft` is reserved for Layout-1 in-card secondary CTAs" },
  // page-scaffold-ownership — the bordered rounded page-body container is
  // mounted ONCE by AppShell for every (app) page (remote chunks render
  // inside it too, never drawing it). Self-wrapping is an anatomy drift:
  // allowPaths = AppShell + pages pending conversion to the inherited wrap.
  { id: "page-scaffold-ownership", pattern: /<AppPageScaffold\b/, hint: "AppPageScaffold is mounted once by AppShell — pages never self-wrap; the bordered box is inherited chrome" },
  // icon-no-fallback — a field-mapped icon renders iff the mapped field
  // carries a value: absent data → absent element, never an invented
  // default icon. Catches `name={x ?? 'icon'}` on DynamicIcon AND
  // `*icon* = x ?? 'icon'` assignments; field-to-field chains and
  // `?? null`/`?? ''` type coercions stay legal.
  { id: "icon-no-fallback", pattern: /name\s*=\s*\{[^}]*(?:\?\?|\|\|)\s*['"`][a-z0-9_-]+|\b\w*[Ii]con\b\s*[:=]\s*[^;{=]*(?:\?\?|\|\|)\s*['"`][a-z0-9_-]+/, hint: "invented icon fallback — a mapped icon renders iff the field carries a value ({#if icon}<DynamicIcon name={icon}/>); absent data → absent element, never a default" },
  // ── sheet-panel anatomy rules (scope via appliesTo → */sheets/panels/) ──
  // panel-layout's finding comes from the structural pass in checkFile —
  // the never-match pattern keeps the line loop inert.
  { id: "panel-layout", pattern: /(?!)/, hint: "every sheet panel mounts <SheetPanelLayout> as its root anatomy (header/toolbar/content/footer)" },
  { id: "panel-content-scroll", pattern: /contentClass\s*=\s*["'{`][^"'`}]*\boverflow\b/, hint: "CONTENT is the only scrollable region — SheetPanelLayout owns overflow; contentClass carries padding/spacing only" },
  { id: "panel-raw-label", pattern: /<(?:label|Label)[\s/>]/, hint: "field labels come from PrimeField/FormField — a raw <label> or the bare <Label> component bypasses the icon/help/id contract" },
  { id: "panel-control-id", pattern: /\{#snippet\s+control\(\s*\)\}/, hint: "the control snippet MUST destructure { id } and apply it to the control — the label for/id pair is structural, not optional" },
  { id: "panel-select-dropdown", pattern: /\bDropdownMenuCheckboxItem\b|closeOnSelect\s*=/, hint: "select anatomy goes through the dispatcher/ComboSelect — hand-built dropdown selects are the duplicated-filter drift" },
  // panel-button-testid — findings come from the structural pass: the
  // attribute block may span lines and carry `=>` inside handlers, which
  // a `[^>]*` line pattern cannot see past. Never-match keeps it inert here.
  { id: "panel-button-testid", pattern: /(?!)/, hint: "interactive controls carry data-testid (<scope>-<purpose>, kebab-case) — E2E locators are brittle-on-purpose by convention" },
  // Panel-scoped stricter rules — inside a sheet panel there is NO
  // sanctioned raw Switch / no opt-out of the eraser affordance: the
  // raw-switch allowPaths must never extend into panels (FiltersPanel's
  // AND/OR Switch escaped exactly that way), and SearchInput's eraser is
  // the shared trailing-CTA anatomy, not a per-panel choice.
  { id: "panel-switch", pattern: /<Switch[\s>/]/, hint: "binary/mode toggles inside panels are ButtonGroup segmented (mode buttons, aria-pressed) — raw Switch has no sanctioned use in sheet-panel anatomy" },
  { id: "panel-search-clearable", pattern: /clearable\s*=\s*[{("'`]?false/, hint: "the eraser affordance is structural (disabled when empty) — a panel must not opt out of it" },
  // bare <Input> in a panel is the primitive without the contract —
  // TextInput (fields) and SearchInput (searches) both OWN the eraser +
  // trailing-CTA anatomy; raw Input is for inside-component use only.
  { id: "panel-raw-input", pattern: /<Input[\s/>]/, hint: "panel text inputs MUST be TextInput (fields) or SearchInput (searches) — the eraser affordance is structural and component-owned; bare <Input> is composite-internal only" },
  // panel-footer-chrome / panel-toolbar-tools — findings come from the
  // structural pass in checkFile (snippet-range aware). Never-match keeps
  // them inert as line rules: the FOOT contract is "content through
  // <SheetPanelFooter>" and tools belong inside {#snippet toolbar}.
  { id: "panel-footer-chrome", pattern: /(?!)/, hint: "panel FOOT content goes through <SheetPanelFooter> — right-aligned natural-width CTAs on the layout-owned muted strip (w-full/p-3 wrapper footers are the old pattern)" },
  { id: "panel-footer-start", pattern: /(?!)/, hint: "SheetPanelFooter {#snippet start} carries legend/meta content only (KeyboardHints, meta text) — interactive controls (Button) are CTAs and live in the right-aligned group" },
  { id: "panel-toolbar-tools", pattern: /(?!)/, hint: "tools live inside {#snippet toolbar} (mode/connector ButtonGroup, SearchInput) — a tool in CONTENT lands under the toolbar border-b and reads as a second header" },
  // panel-chrome-class — findings come from the structural pass: a stock
  // component's opening tag + its class attribute may span lines, so the
  // line loop cannot see them together. Never-match keeps it inert here.
  { id: "panel-chrome-class", pattern: /(?!)/, hint: "stock component chrome is the contract — class= carries LAYOUT only (min-w-0/w-full/grow/shrink/self/margins/position); height, font size/weight, padding, radius and shadows are component-owned" },
  // Stock vendored-kit color tokens have no sanctioned use in field chrome:
  // fills are bg-background / bg-transparent / bg-muted and the focus border
  // comes from the variant chrome (foreground/50 ghost, primary-gradient
  // field). `bg-input` produced the sky-tinted search-input background;
  // `border-ring` produced the blue focus border beside neutral ghost rings.
  { id: "field-stock-chrome", pattern: /\bbg-input\b|\bborder-ring\b/, hint: "stock vendored-kit tokens — field chrome is bg-background/bg-transparent + foreground/* or border-primary-gradient + ring-ring/50 (input-anatomy); never the kit's tinted fill / blue focus border" },
  { id: "i18n-entity-fallback", pattern: /\$t\([^)]*\|\|/, hint: "no entity-specific i18n fallback inside shared entity-list code — label_key resolves or the raw key shows" },
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
  /**
   * db-meta/patches filenames exempt from `seed-audit-trail` — shipped
   * seed patches that predate the audit-trail rule can never be edited;
   * a backfill patch remedies their data instead. New patches must comply
   * (or carry `-- pb:no-audit-trail`).
   */
  seed_audit_exempt?: string[];
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
  /^\s*(?:(?:public|private|protected|readonly|declare|static)\s+)*([A-Za-z_]\w*)\s*([?!])?\s*:\s*(.+?);?\s*(?:\/\/.*)?$/;
const NULL_UNION = /\|\s*null\b/;
// `@Calculated` props are SQL projections, not physical columns: `?` means
// "may be absent on non-read paths" — presence is never guaranteed — so the
// optional marker is legal without `nullable:true`; NULL-valued results are
// declared via @Calculated(expr, { nullable:true }) for the meta channel.
const NULLABLE_IMPLYING_DECORATOR = /@(?:DeletableField|CloneField|IsNotColumn|Calculated)\b/;

function decoratorBlockAbove(lines: string[], i: number): string {
  let block = "";
  // Decorator calls may span lines (`@Calculated(\n  expr,\n  { opts }\n)`):
  // walk up while a decorator-prefix line OR inside an unclosed call —
  // `)` increments the reverse paren depth, `(` decrements it; the `@` head
  // line that balances the depth is itself a prefix line, so collection
  // continues naturally above it (doc comments, stacked decorators).
  let closeDepth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const line = lines[j];
    for (const ch of line) {
      if (ch === ")") closeDepth++;
      if (ch === "(") closeDepth--;
    }
    if (closeDepth > 0 || /^\s*(?:@|\/\/|\/\*|\*)/.test(line)) {
      block = line + "\n" + block;
      continue;
    }
    break;
  }
  return block;
}

type ClassScope = { depth: number; entity: boolean; pending: boolean };

/** Pop closed class scopes; a `pending` scope is a multi-line class
 *  declaration (`class X` … `extends Y` … `{`) whose `{` hasn't arrived
 *  yet — it must NOT pop on the next line (depth still ≤ entry depth). */
function popClosedScopes(stack: ClassScope[], depth: number, line: string): void {
  while (stack.length && !stack[stack.length - 1].pending && depth <= stack[stack.length - 1].depth)
    stack.pop();
  const top = stack[stack.length - 1];
  if (top?.pending) {
    if (line.includes("{")) top.pending = false;
    else if (line.includes(";")) stack.pop(); // `declare class X;` — no body
  }
}

function checkEntityNullableExplicit(
  lines: string[],
  rel: string,
  isExempted: (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) => boolean,
  exemptAt: (i: number) => { rules: Set<string>; hasReason: boolean } | null,
): Violation[] {
  const out: Violation[] = [];
  const stack: ClassScope[] = [];
  let depth = 0;
  const inEntity = () => stack.some((s) => s.entity);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    popClosedScopes(stack, depth, line);

    if (CLASS_DECL.test(line)) {
      const startDepth = depth;
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      stack.push({
        depth: startDepth,
        entity: /@Entity\b/.test(decoratorBlockAbove(lines, i)),
        pending: !line.includes("{"),
      });
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

// ── entity-type-declared ────────────────────────────────────────────────
// Structural rule (same class-scope walker as entity-nullable-explicit): a
// column prop whose annotation maps to NON-text pg storage must carry a
// runtime-visible type declaration — `jsType:`/`pgType:` in the column
// decorator options, a semantic-pin decorator (audit/deletable/
// synchronizable pin their storage by contract), or a non-manual @Key
// (identity keys pin int8). The annotation is erased at transpile so a
// prop without declaration silently resolves `pg_type:"text"` at runtime.
// Exempt: @IsNotColumn/@Calculated (no physical column), `string`/
// string-literal-union annotations (text IS their storage), and unknown
// named aliases (could be string unions — unresolvable structurally).
const TYPE_DECL_OPTION = /\b(?:jsType|pgType)\s*:/;
const SEMANTIC_PIN_DECORATOR = /@(?:AuditableField|DeletableField|SynchronizableField)\b/;
const NON_COLUMN_DECORATOR = /@(?:IsNotColumn)\b/;
// `@Calculated` counts as a column decorator for entity-type-declared: the
// annotation is erased identically, and `@Calculated(expr, { pgType })` is
// its runtime declaration channel.
const COLUMN_DECORATOR = /@(?:Column|Key|Unique|Index|ForeignKey|PartitionField|CloneField|Calculated)\b/;
const KEY_IDENTITY_DECORATOR = /@Key\b/;
const KEY_MANUAL_GENERATED = /generated\s*:\s*["']manual["']/;
// Annotations that statically map to non-text storage — mirrors
// pgTypeFromAnnotation. `number` is included (float8 inference; int4
// columns must declare pgType). Named aliases are deliberately absent.
const NON_TEXT_ANNOTATION =
  /^(?:Date|bigint|BigInt|number|Number|boolean|Boolean|UUID|Decimal|Vector|ISODate|ISOTime|unknown|any|object|Record|Uint8Array|Buffer)$/;
const JSTYPE_DECLARED = /\bjsType\s*:\s*["']([^"']+)["']/;
// `jsType: SomeClass` — a class-ctor declaration (jsonb instance revival),
// as opposed to a builtin codec string literal above.
const JSTYPE_CTOR_DECLARED = /\bjsType\s*:\s*([A-Z][A-Za-z0-9_]*)\b/;
// PascalCase named annotation (`ExecutionConfig`, `RuleFilter[]`) — a class
// or type-alias whose name is erased at transpile, so it needs a runtime
// declaration (`jsType:<ctor>` for a class prop, `pgType` for an alias).
const NAMED_ANNOTATION = /^([A-Z][A-Za-z0-9_]*)(\[\])?$/;
// `export type X = "a" | "b"` — a string-literal union alias: text storage
// is already correct, no runtime declaration needed.
const STRING_UNION_TYPE_DECL = /(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)\s*=\s*["'`]/;
// The only valid jsType per annotation — a `Date` prop can only say
// "instant", a `bigint` prop only "bigint", etc. Annotations without a
// codec (UUID/boolean/number/json/arrays) take NO jsType: they declare
// the physical type via pgType instead.
const JSTYPE_FOR_ANNOTATION: Record<string, string> = {
  Date: "instant",
  Decimal: "decimal",
  Vector: "vector",
  bigint: "bigint",
  BigInt: "bigint",
};

/** The jsType the annotation REQUIRES, or null when none exists. */
function expectedJsTypeFor(typeText: string): string | null {
  const tokens = typeText
    .replace(/;\s*$/, "")
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t !== "null" && t !== "undefined" && t !== "");
  for (const t of tokens) {
    if (t.endsWith("[]") || t.includes("<") || t.startsWith("{")) continue;
    const j = JSTYPE_FOR_ANNOTATION[t];
    if (j) return j;
  }
  return null;
}

/** First annotation token that maps to non-text storage, or null when the
 *  prop's annotation is text-compatible/unresolvable (no flag needed). */
function nonTextAnnotationToken(typeText: string): string | null {
  const tokens = typeText
    .replace(/;\s*$/, "")
    .split("|")
    .map((t) => t.trim())
    .filter((t) => t !== "null" && t !== "undefined" && t !== "");
  for (const t of tokens) {
    if (t.endsWith("[]") || t.startsWith("Array<")) return t;
    if (t.startsWith("Record<") || t.startsWith("{")) return t;
    if (NON_TEXT_ANNOTATION.test(t)) return t;
  }
  return null;
}

function checkEntityTypeDeclared(
  lines: string[],
  rel: string,
  isExempted: (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) => boolean,
  exemptAt: (i: number) => { rules: Set<string>; hasReason: boolean } | null,
): Violation[] {
  const out: Violation[] = [];
  const stack: ClassScope[] = [];
  let depth = 0;
  const inEntity = () => stack.some((s) => s.entity);
  const stringUnionNames = new Set(
    lines.map((l) => l.match(STRING_UNION_TYPE_DECL)?.[1]).filter((n): n is string => n !== undefined),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    popClosedScopes(stack, depth, line);

    if (CLASS_DECL.test(line)) {
      const startDepth = depth;
      for (const ch of line) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
      }
      stack.push({
        depth: startDepth,
        entity: /@Entity\b/.test(decoratorBlockAbove(lines, i)),
        pending: !line.includes("{"),
      });
      continue;
    }

    if (inEntity()) {
      const m = line.match(ENTITY_PROP_OPTIONAL);
      if (!m) {
        // not a prop line
      } else {
        const block = decoratorBlockAbove(lines, i);
        if (COLUMN_DECORATOR.test(block) && !NON_COLUMN_DECORATOR.test(block)) {
          const annotation = m[3].replace(/;\s*$/, "").trim();
          const declaredJs = block.match(JSTYPE_DECLARED)?.[1];
          const declaredJsCtor = block.match(JSTYPE_CTOR_DECLARED)?.[1];
          const expectedJs = expectedJsTypeFor(m[3]);
          const offending = nonTextAnnotationToken(m[3]);
          const namedAnn = annotation.match(NAMED_ANNOTATION);
          let hint: string | null = null;
          if (declaredJs !== undefined) {
            // A declared jsType must MATCH the annotation — `Date` takes
            // only "instant", `bigint` only "bigint", and annotations
            // without a codec (UUID/boolean/number/json/arrays) take NO
            // jsType at all: they declare storage via pgType.
            if (declaredJs !== expectedJs) {
              hint =
                expectedJs === null
                  ? `jsType:"${declaredJs}" has no meaning for "${annotation}" — jsType exists only for instant/decimal/vector/bigint props; declare the physical type with pgType`
                  : `jsType:"${declaredJs}" contradicts the annotation — "${annotation}" props take jsType:"${expectedJs}"`;
            }
          } else if (declaredJsCtor !== undefined) {
            // `jsType: <Ctor>` is valid only on a named class annotation and
            // must name the SAME class — a mismatched ctor revives the wrong
            // type on every hydration.
            const annName = namedAnn?.[1];
            if (!annName || stringUnionNames.has(annName)) {
              hint = `jsType:${declaredJsCtor} has no meaning for "${annotation}" — a class-ctor jsType belongs on a class-typed prop; declare the physical type with pgType`;
            } else if (declaredJsCtor !== annName) {
              hint = `jsType:${declaredJsCtor} contradicts the annotation — "${annotation}" props take jsType:${annName}`;
            }
          } else if (offending !== null) {
            // A non-manual @Key pins int8 — it covers `bigint` annotations
            // only; any other non-string annotation on a key still needs
            // an explicit pgType (the pin would force int8 over e.g. uuid).
            const keyCovers =
              KEY_IDENTITY_DECORATOR.test(block) &&
              !KEY_MANUAL_GENERATED.test(block) &&
              /^(?:bigint|BigInt)$/.test(offending);
            if (!keyCovers && !TYPE_DECL_OPTION.test(block) && !SEMANTIC_PIN_DECORATOR.test(block)) {
              hint = `"${offending}" column prop needs a runtime type declaration — @Column({ jsType }) or explicit pgType — the annotation is erased at transpile and the column silently resolves "text"`;
            }
          } else if (
            namedAnn &&
            !stringUnionNames.has(namedAnn[1]) &&
            !TYPE_DECL_OPTION.test(block) &&
            !SEMANTIC_PIN_DECORATOR.test(block) &&
            !KEY_IDENTITY_DECORATOR.test(block)
          ) {
            // A named (class/type-alias) annotation is erased at transpile
            // just like `boolean` — without a declaration the column
            // resolves "text". `jsType:<ctor>` declares a class prop
            // (instance revival, jsonb storage); `pgType` declares an
            // alias/Record prop (plain object). String-literal union
            // aliases are exempt: text is already the honest storage.
            hint = `"${annotation}" column prop needs a runtime type declaration — @Column({ jsType: ${namedAnn[1]} }) for a class prop, or explicit pgType — the annotation is erased at transpile and the column silently resolves "text"`;
          }
          if (hint) {
            const exempt =
              exemptAt(i) ??
              block
                .split("\n")
                .map((l) => parseExempt(l))
                .find(Boolean) ??
              null;
            if (!isExempted(exempt, "entity-type-declared")) {
              out.push({
                file: rel,
                line: i + 1,
                rule: "entity-type-declared",
                text: line.trim(),
                hint,
              });
            }
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

// ── schema-honest-format ────────────────────────────────────────────────
// Static mirror of the enrollment-time `schemaHonestyIssue` gate (core is
// the authority — this catches the drift BEFORE boot, so the dishonest
// schema never even compiles into a build that could register it). ERROR
// level: any violation fails the check.
// A property literal `name: { type: "string" … }` — or `type:"array"` with
// `{type:"string"}` items — whose NAME implies a data shape (`*_at`,
// `*_by`, uuid/email/phone/url/locale-shaped — the core
// `HONEST_FORMAT_HINTS` matrix) must declare it inside the literal:
// `format:`/`x_semantic:`/`enum:`/`const:`/`pattern:`. Zod-authored
// schemas (`z.string().email()` → `z.toJSONSchema`) carry no `type:"string"`
// text and are covered by the runtime gate, so they are unaffected here.
const HONEST_PROP_OPEN = /["']?([a-zA-Z_]\w*)["']?\s*:\s*\{/g;
const HONEST_MARKERS = /\b(?:format|x_semantic|enum|const|pattern)\s*:/;

function checkSchemaHonesty(
  lines: string[],
  rel: string,
  isExempted: (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) => boolean,
  exemptAt: (i: number) => { rules: Set<string>; hasReason: boolean } | null,
): Violation[] {
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnly(line)) continue;
    HONEST_PROP_OPEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HONEST_PROP_OPEN.exec(line))) {
      const field = m[1]!;
      const hint = HONEST_FORMAT_HINTS.find((h) => h.re.test(field));
      if (!hint) continue;
      // Collect the object literal — balance braces from the `{` ending m[0].
      const startCol = m.index + m[0].length - 1;
      let depth = 0;
      let text = "";
      let j = i;
      for (; j < lines.length; j++) {
        const seg = j === i ? line.slice(startCol) : lines[j];
        for (const ch of seg) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
        }
        text += seg + "\n";
        if (depth === 0) break;
        if (j - i > 80) break; // runaway guard — malformed source
      }
      // A string leaf is dishonest: the prop itself string-typed, or an
      // `array` whose items are strings and carry no marker either.
      const stringLeaf = /type\s*:\s*["']string["']/.test(text);
      const arrayOfStrings =
        /type\s*:\s*["']array["']/.test(text) &&
        /items\s*:\s*\{[^}]*type\s*:\s*["']string["']/.test(text);
      if (!stringLeaf && !arrayOfStrings) continue;
      if (HONEST_MARKERS.test(text)) continue;
      const exempt = exemptAt(i) ?? exemptAt(j);
      if (isExempted(exempt, "schema-honest-format")) continue;
      out.push({
        file: rel,
        line: i + 1,
        rule: "schema-honest-format",
        text: line.trim(),
        hint: `"${field}" looks like a ${hint.why} value — declare format:"${hint.formats.join("|")}" on it (enrollment rejects a bare string)`,
      });
      break; // one finding per line keeps output readable
    }
  }
  return out;
}

// ── raw-switch ──────────────────────────────────────────────────────────
// Multi-line `import { …Switch… } from '@primebrick/ui'` — the line-rule
// above catches single-line imports; this pass tracks import blocks whose
// `}` and `from` land on later lines, buffers the `Switch` specifier lines,
// and flags them only if the resolved package is @primebrick/ui.
const RAW_SWITCH_IMPORT_OPEN = /^\s*import\s+(?:type\s+)?\{/;
const RAW_SWITCH_FROM = /\}\s*from\s*["']([^"']+)["']/;

function checkRawSwitch(
  lines: string[],
  rel: string,
  isExempted: (exempt: { rules: Set<string>; hasReason: boolean } | null, id: string) => boolean,
  exemptAt: (i: number) => { rules: Set<string>; hasReason: boolean } | null,
): Violation[] {
  const out: Violation[] = [];
  let collecting = false;
  let switchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentOnly(line)) continue;
    if (!collecting) {
      if (!RAW_SWITCH_IMPORT_OPEN.test(line)) continue;
      if (RAW_SWITCH_FROM.test(line)) continue; // single-line — the line rule owns it
      collecting = true;
      continue;
    }
    const to = line.match(RAW_SWITCH_FROM);
    if (to) {
      if (to[1] === "@primebrick/ui") {
        for (const ln of switchLines) {
          const exempt = exemptAt(ln) ?? exemptAt(ln - 1);
          if (isExempted(exempt, "raw-switch")) continue;
          out.push({
            file: rel,
            line: ln + 1,
            rule: "raw-switch",
            text: lines[ln]?.trim() ?? "",
            hint: "labelled booleans MUST use SwitchField (switch-first anatomy) — raw Switch is composite-internal only (allowPaths for sanctioned composites)",
          });
        }
      }
      collecting = false;
      switchLines = [];
      continue;
    }
    if (/\bSwitch\b/.test(line)) switchLines.push(i);
    if (/;/.test(line)) { collecting = false; switchLines = []; } // runaway guard — malformed import
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
  "entity-nullable-explicit", "nav-decl-access", "column-flag-defaults",
  "schema-honest-format", "entity-type-declared",
]);
const LIB_RULES = new Set<RuleId>(["ext-json", "entity-nullable-explicit", "column-flag-defaults", "native-control"]);
// `fe` — browser SPA: no base line rules (server-side contracts don't
// apply); the gated rules above activate via .devin/check-standards.json.
const FE_RULES = new Set<RuleId>([]);

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
    else if (entry.endsWith(".ts") || entry.endsWith(".svelte")) yield p;
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

  // `@Calculated(...)` argument context — the decorator OWNS raw SQL by
  // contract: entity classes are the one sanctioned place for projection
  // expressions (they never reach DDL; the DAL projects them on read).
  // A SQL-shaped string inside the call's argument list is legal; the
  // raw-sql ban still applies everywhere else. Track paren depth from the
  // `@Calculated(` token until the call closes.
  let calculatedDepth = 0;
  const parenDelta = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === "(") d++;
      else if (ch === ")") d--;
    }
    return d;
  };

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

    // Inside a `@Calculated(` argument list? The decorator line itself
    // opens the context; the depth returns to 0 when the call closes.
    const atCalculated = line.indexOf("@Calculated(");
    const inCalculated =
      calculatedDepth > 0 ? calculatedDepth + parenDelta(line) > 0 : atCalculated !== -1;
    if (atCalculated !== -1) {
      calculatedDepth = parenDelta(line.slice(atCalculated + "@Calculated".length));
    } else if (calculatedDepth > 0) {
      calculatedDepth += parenDelta(line);
    }

    for (const rule of activeLineRules) {
      if (!rule.pattern.test(line)) continue;
      if (isExempted(exempt, rule.id)) continue;
      out.push({ file: rel, line: i + 1, rule: rule.id, text: line.trim(), hint: rule.hint });
      break; // one finding per line keeps output readable
    }

    if (rules.has("raw-sql") && !inCalculated) {
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
        const lit = m[1]!;
        if (!lit.includes(".")) continue; // field-name, not an i18n key
        const ns = lit.split(".")[0]!;
        if (!i18nNamespaces.has(ns)) {
          out.push({
            file: rel,
            line: i + 1,
            rule: "i18n-key-ns" as RuleId,
            text: line.trim(),
            hint: `i18n key namespace '${ns}' is outside this repo's allowlist {${[...i18nNamespaces].join(", ")}} — declarations may reference own + CORE (app/system) namespaces only`,
          });
        } else if (!KEY_GRAMMAR.test(lit)) {
          out.push({
            file: rel,
            line: i + 1,
            rule: "i18n-key-grammar" as RuleId,
            text: line.trim(),
            hint: `i18n key '${lit}' violates the segment grammar — every segment must be [a-z0-9_]+ (lowercase snake_case), ≥2 dot-separated segments`,
          });
        }
      }
      T_CALL_LITERAL.lastIndex = 0;
      while ((m = T_CALL_LITERAL.exec(line))) {
        const lit = m[1]!;
        if (!lit.includes(".")) continue;
        const ns = lit.split(".")[0]!;
        if (!i18nNamespaces.has(ns)) {
          out.push({
            file: rel,
            line: i + 1,
            rule: "i18n-key-ns" as RuleId,
            text: line.trim(),
            hint: `t() references namespace '${ns}' outside this repo's allowlist {${[...i18nNamespaces].join(", ")}} — callsites may reference own + CORE (app/system) namespaces only`,
          });
        } else if (!KEY_GRAMMAR.test(lit)) {
          out.push({
            file: rel,
            line: i + 1,
            rule: "i18n-key-grammar" as RuleId,
            text: line.trim(),
            hint: `t() literal '${lit}' violates the segment grammar — every segment must be [a-z0-9_]+ (lowercase snake_case), ≥2 dot-separated segments`,
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

  if (rules.has("entity-type-declared")) {
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    out.push(...checkEntityTypeDeclared(lines, rel, isExempted, exemptAt));
  }

  if (rules.has("schema-honest-format")) {
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    out.push(...checkSchemaHonesty(lines, rel, isExempted, exemptAt));
  }

  // raw-switch structural pass — multi-line import lists. Scope mirrors
  // the activeLineRules filter (config-injected allowPaths/appliesTo).
  const rawSwitchRule = LINE_RULES.find((r) => r.id === "raw-switch");
  if (
    rules.has("raw-switch") &&
    rawSwitchRule &&
    !rawSwitchRule.allowPaths?.test(rel) &&
    (!rawSwitchRule.appliesTo || rawSwitchRule.appliesTo.test(rel))
  ) {
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    out.push(...checkRawSwitch(lines, rel, isExempted, exemptAt));
  }

  // panel-layout — every file under the appliesTo scope mounts
  // SheetPanelLayout as its root anatomy. Scope mirrors activeLineRules.
  const panelLayoutRule = LINE_RULES.find((r) => r.id === "panel-layout");
  if (
    rules.has("panel-layout") &&
    panelLayoutRule &&
    !panelLayoutRule.allowPaths?.test(rel) &&
    (!panelLayoutRule.appliesTo || panelLayoutRule.appliesTo.test(rel)) &&
    !lines.some((l) => l.includes("<SheetPanelLayout"))
  ) {
    const exempt = parseExempt(lines[0]);
    if (!isExempted(exempt, "panel-layout")) {
      out.push({
        file: rel,
        line: 1,
        rule: "panel-layout",
        text: basename(rel),
        hint: "every sheet panel mounts <SheetPanelLayout> as its root anatomy (header/toolbar/content/footer)",
      });
    }
  }

  // panel-button-testid — attribute-block pass: a `<button` opening tag
  // spans multiple lines and its handlers carry `=>`, so the tag is only
  // known to be closed when a line TRIMMED ends with `>` (or `/>`). Scan
  // at most 15 lines; `data-testid` seen anywhere before close clears it.
  const panelTestidRule = LINE_RULES.find((r) => r.id === "panel-button-testid");
  if (
    rules.has("panel-button-testid") &&
    panelTestidRule &&
    !panelTestidRule.allowPaths?.test(rel) &&
    (!panelTestidRule.appliesTo || panelTestidRule.appliesTo.test(rel))
  ) {
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentOnly(line) || !line.includes("<button")) continue;
      let hasTestid = false;
      for (let j = i; j < lines.length && j - i < 15; j++) {
        const l = lines[j];
        if (l.includes("data-testid")) {
          hasTestid = true;
          break;
        }
        const tr = l.trimEnd();
        if (tr.endsWith(">") || tr.endsWith("/>")) break;
      }
      if (hasTestid) continue;
      const exempt = exemptAt(i);
      if (isExempted(exempt, "panel-button-testid")) continue;
      out.push({
        file: rel,
        line: i + 1,
        rule: "panel-button-testid",
        text: line.trim(),
        hint: "interactive controls carry data-testid (<scope>-<purpose>, kebab-case) — E2E locators are brittle-on-purpose by convention",
      });
    }
  }

  // panel-chrome-class — attribute-block pass: on a stock component the
  // literal class= carries LAYOUT utilities only (min-w-0/w-full/grow/
  // shrink/self/margins/position). Geometry + typography utilities
  // (h-N, text-<size>, font-*, p*-N, rounded, ring, shadow, opacity)
  // reshape the component-owned chrome — the bespoke-look drift. Dynamic
  // class={expr} is opaque to the audit (shared chrome constants live
  // there); only literal class strings are checked.
  const panelChromeRule = LINE_RULES.find((r) => r.id === "panel-chrome-class");
  if (
    rules.has("panel-chrome-class") &&
    panelChromeRule &&
    !panelChromeRule.allowPaths?.test(rel) &&
    (!panelChromeRule.appliesTo || panelChromeRule.appliesTo.test(rel))
  ) {
    const STOCK_COMP =
      /<(Input|TextInput|Textarea|ComboSelect|SearchInput|NumericInput|CopyButton|Button|ButtonGroup|Badge|Switch|SwitchField|Checkbox|CheckboxField|Label|Select)\b/;
    // Token boundary = start-or-whitespace (tailwind classes are
    // space-separated): `\b` would match `w-0` inside `min-w-0` and `p-1`
    // inside `gap-1` — both sanctioned layout utilities.
    const CHROME_UTIL =
      /(?:^|\s)(?:h-(?:\d|\[)|min-h-|max-h-|w-(?:\d|\[)|text-(?:xs|sm|base|lg|xl|\d+xl|\[)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|sans|serif|mono)|leading-|tracking-|p[xytblrse]?-(?:\d|\[)|rounded|ring-|shadow-|opacity-)/;
    const CLASS_ATTR = /\bclass\s*=\s*["']([^"']*)["']/;
    const exemptAt = (i: number) =>
      parseExempt(lines[i]) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentOnly(line) || !STOCK_COMP.test(line)) continue;
      let block = line;
      for (let j = i + 1; j < lines.length && j - i < 15; j++) {
        if (lines[j - 1].trimEnd().endsWith(">") || lines[j - 1].trimEnd().endsWith("/>")) break;
        block += "\n" + lines[j];
      }
      const m = block.match(CLASS_ATTR);
      if (!m || !CHROME_UTIL.test(m[1])) continue;
      const exempt = exemptAt(i);
      if (isExempted(exempt, "panel-chrome-class")) continue;
      out.push({
        file: rel,
        line: i + 1,
        rule: "panel-chrome-class",
        text: line.trim(),
        hint: "stock component chrome is the contract — class= carries LAYOUT only (min-w-0/w-full/grow/shrink/self/margins/position); height, font size/weight, padding, radius and shadows are component-owned",
      });
    }
  }

  // panel-footer-chrome — a panel declaring FOOT content (`{#snippet footer}`
  // or `footer={…}` prop) must render it through <SheetPanelFooter>: the
  // layout owns the muted strip, the footer component owns right-aligned
  // natural-width CTAs. Input-box feet (chat) are exempt via allowPaths.
  const panelFooterRule = LINE_RULES.find((r) => r.id === "panel-footer-chrome");
  if (
    rules.has("panel-footer-chrome") &&
    panelFooterRule &&
    !panelFooterRule.allowPaths?.test(rel) &&
    (!panelFooterRule.appliesTo || panelFooterRule.appliesTo.test(rel))
  ) {
    const declaresFoot = lines.some(
      (l) => /\{#snippet\s+\w*[Ff]ooter\b/.test(l) || /\bfooter\s*=\s*\{/.test(l),
    );
    if (declaresFoot && !lines.some((l) => l.includes("<SheetPanelFooter"))) {
      const footLine = lines.findIndex(
        (l) => /\{#snippet\s+\w*[Ff]ooter\b/.test(l) || /\bfooter\s*=\s*\{/.test(l),
      );
      const exempt =
        parseExempt(lines[footLine]) ?? (footLine > 0 ? parseExempt(lines[footLine - 1]) : null);
      if (!isExempted(exempt, "panel-footer-chrome")) {
        out.push({
          file: rel,
          line: footLine + 1,
          rule: "panel-footer-chrome",
          text: lines[footLine]?.trim() ?? "",
          hint: "panel FOOT content goes through <SheetPanelFooter> — right-aligned natural-width CTAs on the layout-owned muted strip (w-full/p-3 wrapper footers are the old pattern)",
        });
      }
    }
  }

  // panel-footer-start — inside <SheetPanelFooter>, {#snippet start} is the
  // LEFT slot reserved for legend/meta content (KeyboardHints, meta text).
  // Interactive controls found there are CTAs misplaced out of the
  // right-aligned group — flag them.
  const panelStartRule = LINE_RULES.find((r) => r.id === "panel-footer-start");
  if (
    rules.has("panel-footer-start") &&
    panelStartRule &&
    !panelStartRule.allowPaths?.test(rel) &&
    (!panelStartRule.appliesTo || panelStartRule.appliesTo.test(rel)) &&
    lines.some((l) => l.includes("<SheetPanelFooter"))
  ) {
    // Ranges: <SheetPanelFooter …> … </SheetPanelFooter> → {#snippet start}
    // … {/snippet} inside them → interactive lines inside the snippet.
    const footerRanges: [number, number][] = [];
    let footOpen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/<SheetPanelFooter\b/.test(lines[i])) footOpen = i;
      if (footOpen >= 0 && /<\/SheetPanelFooter>/.test(lines[i])) {
        footerRanges.push([footOpen, i]);
        footOpen = -1;
      }
    }
    for (const [fa, fb] of footerRanges) {
      let startOpen = -1;
      for (let i = fa + 1; i < fb; i++) {
        if (/\{#snippet\s+start\b/.test(lines[i])) startOpen = i;
        else if (/\{\/snippet\}/.test(lines[i])) startOpen = -1;
        else if (startOpen >= 0 && /<Button\b|<button\b/.test(lines[i])) {
          const exempt = parseExempt(lines[i]) ?? parseExempt(lines[i - 1]);
          if (!isExempted(exempt, "panel-footer-start")) {
            out.push({
              file: rel,
              line: i + 1,
              rule: "panel-footer-start",
              text: lines[i].trim(),
              hint: "CTAs live in the right-aligned SheetPanelFooter group — {#snippet start} is for legend/meta content only",
            });
          }
        }
      }
    }
  }

  // panel-toolbar-tools — when a panel declares {#snippet toolbar}, tool
  // elements (segmented ButtonGroup, SearchInput) must live INSIDE that
  // snippet range: a tool rendered in CONTENT lands under the toolbar's
  // border-b and reads as a second header band.
  const panelToolsRule = LINE_RULES.find((r) => r.id === "panel-toolbar-tools");
  if (
    rules.has("panel-toolbar-tools") &&
    panelToolsRule &&
    !panelToolsRule.allowPaths?.test(rel) &&
    (!panelToolsRule.appliesTo || panelToolsRule.appliesTo.test(rel)) &&
    lines.some((l) => /\{#snippet\s+toolbar\b/.test(l))
  ) {
    const toolbarRanges: [number, number][] = [];
    const stack: { name: string; line: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/\{#snippet\s+(\w+)/);
      if (open) stack.push({ name: open[1], line: i });
      if (/\{\/snippet\}/.test(lines[i])) {
        const top = stack.pop();
        if (top?.name === "toolbar") toolbarRanges.push([top.line, i]);
      }
    }
    const inToolbar = (i: number) =>
      toolbarRanges.some(([a, b]) => i > a && i < b);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentOnly(line)) continue;
      if (!/<ButtonGroup|<SearchInput\b/.test(line)) continue;
      if (inToolbar(i)) continue;
      const exempt = parseExempt(line) ?? (i > 0 ? parseExempt(lines[i - 1]) : null);
      if (isExempted(exempt, "panel-toolbar-tools")) continue;
      out.push({
        file: rel,
        line: i + 1,
        rule: "panel-toolbar-tools",
        text: line.trim(),
        hint: "tools live inside {#snippet toolbar} (mode/connector ButtonGroup, SearchInput) — a tool in CONTENT lands under the toolbar border-b and reads as a second header",
      });
    }
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
// i18n-key-grammar — same literal, full capture: every dot-separated
// segment must be `[a-z0-9_]+` (the ONE grammar, mirrors @primebrick/core
// TRANSLATION_KEY_GRAMMAR — this tool is zero-dep by design). Also covers
// `t(`/`$t(` callsite literals via T_CALL_LITERAL below.
const KEY_GRAMMAR = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const I18N_KEY_LITERAL = /\b(?:\w*_key|tooltip|tooltip_title)\s*:\s*["'`]([a-zA-Z][a-zA-Z0-9_.]*)["'`]/g;
const T_CALL_LITERAL = /\b\$?t\(\s*["'`]([a-zA-Z][a-zA-Z0-9_.]*)["'`]/g;

// i18n-sql-ns — db-meta seed boundary: a patch may insert translation keys
// only inside the namespace owned by the target schema. Canonical rule
// (mirrors @primebrick/core `translationKeyNamespace` — this tool is
// zero-dep by design): `public` → `app`, else the schema name itself.
const SQL_INSERT_TRANSLATIONS = /INSERT\s+INTO\s+"?(\w+)"?\.translations/i;
// First tuple literal when key-shaped (`ns.rest` — no `'` inside, so `[^']*`
// is safe): captures the WHOLE key so grammar applies, not just the prefix.
const SQL_TUPLE_KEY = /\(\s*'([a-z][a-z0-9_]*\.[^']*)'/g;

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
          const lit = m[1]!;
          if (!lit.startsWith(`${expected}.`)) {
            out.push({
              file: `db-meta/patches/${f}`,
              line: i + 1,
              rule: "i18n-sql-ns" as RuleId,
              text: line.trim(),
              hint: `keys seeded into ${targetSchema}.translations must start with '${expected}.' — a schema owns only its own namespace`,
            });
          } else if (!KEY_GRAMMAR.test(lit)) {
            out.push({
              file: `db-meta/patches/${f}`,
              line: i + 1,
              rule: "i18n-key-grammar" as RuleId,
              text: line.trim(),
              hint: `seeded key '${lit}' violates the segment grammar — every segment must be [a-z0-9_]+ (lowercase snake_case), ≥2 dot-separated segments`,
            });
          }
        }
        if (/;\s*(?:--.*)?$/.test(line) && !/INSERT\s+INTO/i.test(line)) targetSchema = null;
      }
    }
  }
  return out;
}

// seed-audit-trail — seeds bypass the DAL: a patch that INSERTs into an
// auditable entity table (isAuditable in db-meta/snapshot-entities.json)
// must write the <t>_audit rows itself, or carry `-- pb:no-audit-trail`.
const SQL_INSERT_TARGET = /\bINSERT\s+INTO\s+"?(\w+)"?\s*\.\s*"?(\w+)"?/gi;
const SQL_INSERT_AUDIT = /\bINSERT\s+INTO\s+"?(\w+)"?\s*\.\s*"?(\w+_audit)"?/gi;

/** Scan db-meta/patches/*.sql for seeds into auditable tables lacking the audit-trail write. */
function checkSeedAuditTrail(repoRoot: string, exemptFiles: ReadonlySet<string>): Violation[] {
  const out: Violation[] = [];
  const dir = join(repoRoot, "db-meta", "patches");
  let files: string[];
  let auditable: Set<string>;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".sql") && !exemptFiles.has(f));
    const snap = JSON.parse(readFileSync(join(repoRoot, "db-meta", "snapshot-entities.json"), "utf8"));
    auditable = new Set(
      Object.entries(snap.tables ?? {})
        .filter(([, t]) => (t as { isAuditable?: boolean }).isAuditable === true)
        .map(([k]) => k.toLowerCase()),
    );
  } catch {
    return out; // no db-meta or no entity snapshot — rule does not apply
  }
  if (!auditable.size) return out;
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    if (/--\s*pb:no-audit-trail/.test(raw)) continue;
    const auditInserts = new Set(
      [...raw.matchAll(SQL_INSERT_AUDIT)].map((m) => `${m[1]!.toLowerCase()}.${m[2]!.toLowerCase()}`),
    );
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*--/.test(line)) continue;
      SQL_INSERT_TARGET.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SQL_INSERT_TARGET.exec(line))) {
        const schema = m[1]!.toLowerCase();
        const table = m[2]!.toLowerCase();
        if (table.endsWith("_audit")) continue;
        const fq = `${schema}.${table}`;
        if (!auditable.has(fq) || auditInserts.has(`${fq}_audit`)) continue;
        out.push({
          file: `db-meta/patches/${f}`,
          line: i + 1,
          rule: "seed-audit-trail" as RuleId,
          text: line.trim().slice(0, 120),
          hint: `${fq} is auditable — seeds must write the ${table}_audit rows (or '-- pb:no-audit-trail'); @AuditTrail never fires for SQL seeds`,
        });
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
  console.error("usage: check-standards <srcDir> [--profile=consumer|lib|fe] [--tests]");
  process.exit(2);
}

const rules = new Set(
  profile === "lib" ? LIB_RULES : profile === "fe" ? FE_RULES : CONSUMER_RULES,
);

// Config-gated rules: `.devin/check-standards.json` in the repo root enables
// them per-repo and carries their allowPaths/appliesTo (injected onto the
// rule objects here — patterns stay fixed in code).
const cfg = loadStandardsConfig();
const cfgEnabled = new Set<RuleId>();
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
  cfgEnabled.add(rule.id);
}

const violations: Violation[] = [];
// i18n-key-ns — activated by `i18n_namespaces` in .devin/check-standards.json.
const i18nNamespaces = cfg.i18n_namespaces?.length ? new Set(cfg.i18n_namespaces) : undefined;

for (const file of walk(dir)) {
  if (!includeTests && isTestFile(file)) continue;
  violations.push(...checkFile(file, dir, rules, i18nNamespaces));
}

// Remote-module surfaces (`fe/src`) are browser code inside service repos —
// the consumer profile encodes server-side contracts and would false-positive
// there, so they went unscanned for a generation of sheet panels. Scan them
// ALWAYS with the `fe` profile when the directory exists: presence, not
// config, is the trigger. srcDir stays `cwd` so findings print as
// `fe/src/<file>` and `appliesTo: ["fe/src/"]` scopes the panel rules.
const feDir = join(process.cwd(), "fe", "src");
const dirNorm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
if (dirNorm !== "fe/src" && existsSync(feDir)) {
  const feRules = new Set<RuleId>([...FE_RULES, ...cfgEnabled]);
  for (const file of walk(feDir)) {
    if (!includeTests && isTestFile(file)) continue;
    violations.push(...checkFile(file, process.cwd(), feRules, i18nNamespaces));
  }
}

// i18n-sql-ns — repo-level scan of db-meta/patches (outside srcDir);
// always-on — the schema→namespace seed boundary is a repo invariant.
// `i18n_sql_exempt` grandfathers shipped pre-boundary patches by filename.
violations.push(...checkTranslationSeedPatches(process.cwd(), new Set(cfg.i18n_sql_exempt ?? [])));

// seed-audit-trail — repo-level scan of db-meta/patches (outside srcDir);
// always-on when db-meta/snapshot-entities.json declares auditable
// entities. `seed_audit_exempt` grandfathers shipped pre-rule patches.
violations.push(...checkSeedAuditTrail(process.cwd(), new Set(cfg.seed_audit_exempt ?? [])));

// truncated-sibling — always-on; sweeps every file in the REPO (cwd),
// not just srcDir and not just .ts — the classic victims are root files
// (AGENTS.md, package.json) and docs/, which srcDir never covers.
violations.push(...checkTruncatedSiblings(process.cwd()));

// ── baseline mode ────────────────────────────────────────────────────────────
// `.devin/check-standards-baseline.json` declares known debt so the gate can
// enforce "never add debt" mechanically: declared violations are suppressed,
// anything else fails the run. Identity = file + rule + full line text (line
// numbers deliberately excluded — insertions elsewhere must not resurrect
// hidden debt; a content edit IS a new violation). Stale entries (paid debt
// or moved lines) warn but don't fail — regen with --write-baseline.
const BASELINE_PATH = join(process.cwd(), ".devin", "check-standards-baseline.json");
interface BaselineEntry {
  file: string;
  rule: string;
  text: string;
}
const baselineKey = (e: { file: string; rule: string; text: string }) =>
  `${e.file}${e.rule}${e.text.trim()}`;

if (args.includes("--write-baseline")) {
  const data = {
    violations: violations.map((v) => ({ file: v.file, rule: v.rule, text: v.text.trim() })),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `check-standards: baseline written — ${violations.length} violation(s) declared → ${BASELINE_PATH}`,
  );
  process.exit(0);
}

let baseline: BaselineEntry[] | null = null;
if (existsSync(BASELINE_PATH)) {
  try {
    baseline = (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { violations?: BaselineEntry[] })
      .violations ?? [];
  } catch {
    console.error(`check-standards: malformed baseline at ${BASELINE_PATH} — cannot verify debt`);
    process.exit(2);
  }
}

if (baseline) {
  const declared = new Map<string, number>();
  for (const e of baseline) declared.set(baselineKey(e), (declared.get(baselineKey(e)) ?? 0) + 1);
  const fresh: Violation[] = [];
  for (const v of violations) {
    const k = baselineKey(v);
    const n = declared.get(k) ?? 0;
    if (n > 0) declared.set(k, n - 1);
    else fresh.push(v);
  }
  const suppressed = violations.length - fresh.length;
  const stale = [...declared.values()].reduce((a, n) => a + n, 0);
  if (suppressed > 0)
    console.log(`check-standards: ${suppressed} violation(s) suppressed by baseline (declared debt)`);
  if (stale > 0)
    console.log(
      `check-standards: baseline carries ${stale} stale entr${stale === 1 ? "y" : "ies"} — paid debt or moved lines; regenerate with --write-baseline`,
    );
  violations.length = 0;
  violations.push(...fresh);
}

for (const v of violations) {
  console.log(`${v.file}:${v.line}  [${v.rule}] ${v.text.slice(0, 140)}  → ${v.hint}`);
}
if (violations.length) {
  console.error(`\ncheck-standards: ${violations.length} violation(s) [profile=${profile}]`);
  process.exit(1);
}
console.log(`check-standards: clean [profile=${profile}]`);

# check-standards — the declared-debt gate

> `.devin/rules/` may point here — canonical text for how the
> `check-standards` gate works across every Primebrick repo.

## What it is

`tools/check-standards.ts` in this repo is the **single canonical
scanner**. Vendored copies are forbidden — every repo's
`check:standards` script invokes this file by sibling-relative path
(`bun ../primebrick-v3-sdk/tools/check-standards.ts src …`).

It is **dependency-free by construction**: it imports only the honesty
matrix from `@primebrick/core` via a sibling-relative source path, so it
runs on a bare checkout with no `pnpm install`.

## Baseline mode — debt is declared, never hidden

`.devin/check-standards-baseline.json` (per repo) declares pre-existing
violations:

- **Identity** = `file + rule + line text` (line numbers are excluded —
  edits must not resurrect suppressed debt).
- **Declared** violations are suppressed; **new** violations fail the
  gate (exit ≠ 0); **stale** baseline entries warn (the debt was fixed —
  regenerate).
- `--write-baseline` was **removed** (exit 2): debt can never be minted —
  the only legal doors are code fixes, `allowPaths` config entries, or a
  shrunken baseline after fixing declared debt (delete the stale rows by
  hand; stale entries warn, never fail).

For debt that is *correct by construction* (e.g. the one sanctioned
`getPool()` seam, `JSON.stringify` inside the zero-dep leaf package),
use an inline `// standards-exempt: <reason>` comment instead — not a
baseline row.

## Per-repo wiring

| Piece | Where |
|---|---|
| Config | `.devin/check-standards.json` — profile (`consumer`/`fe`/`lib`) + rule options (`dal-access.allowPaths`, `layer-repo-import`) |
| Script | `package.json` → `check:standards`; wired into `test`/`prebuild` |
| Baseline | `.devin/check-standards-baseline.json` — only when debt exists |
| CI | `.github/workflows/check-standards.yml` — zero-install sibling layout: self + `primebrick-v3-sdk` + `primebrick-v3-core` checkouts + `setup-bun` |

CI checkouts track `develop` of sdk+core — a new rule activates
everywhere at once; repos that violate it are honestly red until fixed
or baselined.

## Suppression hygiene — `suppress-no-reason`

Always-on meta rule, every profile, every scanned file: linter/compiler
suppression tags MUST justify themselves.

| Tag family | Reason forms accepted |
|---|---|
| `eslint-disable`, `eslint-disable-next-line` | ` -- <reason>` tail on the same line, or an adjacent explanatory comment |
| `svelte-ignore` | adjacent explanatory comment (`//` or `<!-- -->`, multi-line comments count) or ` -- <reason>` tail |
| `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` | same |

A bare suppression is a `suppress-no-reason` violation — non-exemptible:
there is never a legal reason to suppress silently. The intent is that
suppressions are **reviewable**: when the codebase has a sanctioned idiom
(`untrack()` for `state_referenced_locally`, `<SafeHtml>` for `{@html}`),
the reason field is where the reviewer sees why the idiom did not apply.

## i18n namespace rules

Four rules enforce the namespace-segregation contract (canonical:
`primebrick-be-v3/docs/ai/i18n-namespace-segregation.md`):

| Rule | Surface | Fails when |
|---|---|---|
| `i18n-key-ns` | `src/` (+ `fe/src/` under `fe` profile) | an i18n-bearing literal's first segment is outside `i18n_namespaces` |
| `i18n-key-grammar` | same | any dot-segment is not `snake_case` |
| `i18n-sql-ns` | `db-meta/patches/*.sql` | an INSERT seeds keys outside `{app, <stmt-schema>}` |
| `i18n-sql-key-ref` | same | a `*_key` reference (INSERT values, `UPDATE SET`, nested JSON) cites outside `{app, <stmt-schema>}` |

**Scanned code surfaces**: `t(`/`$t(`/`tFn(` calls and `*_key:` /
`*Key:` / `tooltip:` / `tooltip_title:` fields — literals and template
static prefixes (a template's namespace is checked only when a `.`
precedes the first `${`; an opening `${` is unprovable and skipped).
Both the snake_case and camelCase field families are covered
(`label_key`, `labelKey`, `messageKey`, `errorScopeKey`, …).

**Deliberately not scanned**: arbitrary `fn('dotted')` calls (NATS
subjects/getters — guaranteed FP storm); `system_key`/`systemKey` and
the credential `*Key` family (`apiKey`, `privateKey`, `publicKey`,
`sshKey`) via `NON_I18N_KEY_FIELDS`; single-segment literals (no dot →
not a key); display-text fields (`scope:`, `message:` — they carry
resolved text, not keys).

**Config**:

- `i18n_namespaces` (root): allowlist activating `i18n-key-ns`. US
  modules declare `["app", "{own-code}"]` — `system`/`custom` in a
  module's list is a contract violation.
- `i18n_sql_exempt` / `i18n_key_ref_exempt` / `i18n_lang_exempt`:
  filename-level grandfathering for immutable shipped patches only.
- `// standards-exempt:` comments do NOT apply to `i18n-key-ns` — a
  namespace violation is never "correct by construction".

## Enforcement

- ❌ NEVER vendor or copy the tool into another repo.
- ❌ NEVER add a baseline entry for a violation introduced in the same
  changeset — fix it or exempt it with a reason.
- ❌ NEVER weaken a rule's config to pass the gate.
- ✅ When fixing declared debt, delete the stale baseline rows by hand and
  commit the shrunken file in the same changeset.

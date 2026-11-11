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
- `bun tools/check-standards.ts src --write-baseline` regenerates the
  file. Never hand-edit it to hide a new violation — that is the exact
  failure mode the gate exists to prevent.

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

## Enforcement

- ❌ NEVER vendor or copy the tool into another repo.
- ❌ NEVER add a baseline entry for a violation introduced in the same
  changeset — fix it or exempt it with a reason.
- ❌ NEVER weaken a rule's config to pass the gate.
- ✅ When fixing declared debt, re-run `--write-baseline` and commit the
  shrunken file in the same changeset.

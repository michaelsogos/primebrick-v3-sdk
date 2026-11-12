# Devin Rule: check-standards Declared-Debt Gate

## Trigger
- Applies whenever working with `check-standards`, the
  `.devin/check-standards.json` config, or
  `.devin/check-standards-baseline.json` files in any Primebrick repo.

## Canonical doc
**`docs/ai/check-standards-gate.md` — read it before acting.** This file is a
pointer; the normative text lives in the canonical doc.

## Enforcement
- NEVER vendor or copy `tools/check-standards.ts` into another repo.
- NEVER baseline a violation introduced in the same changeset — fix it
  or use `// standards-exempt: <reason>` for structurally-intentional cases.
- When fixing declared debt, regenerate the baseline (`--write-baseline`)
  in the same changeset.

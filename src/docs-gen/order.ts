/**
 * docs-gen — `_order.json` reconciliation.
 *
 * The files on disk are the ground truth: every `.mdx` emitted by ANY
 * generator into the pack's `generated/` dir must appear in the sidebar
 * order; entries whose file no longer exists must drop. No manual
 * curation step. New files join at the end of the generated cluster,
 * sorted — hand-written top-level entries keep their position.
 *
 * Generalizes the BE `generate-reference-docs` reconcile so every service
 * pack gets the same behavior.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extJsonParse, extJsonStringify } from "../json/ext-json.js";

/**
 * Reconcile `<generatedDir>/../_order.json` against the `.mdx` files in
 * `generatedDir`. Returns the change summary for reporting.
 */
export function reconcileOrder(generatedDir: string): { added: string[]; dropped: string[] } {
  const orderPath = join(generatedDir, "..", "_order.json");
  const order = existsSync(orderPath)
    ? (extJsonParse(readFileSync(orderPath, "utf-8")) as { pages: string[] })
    : { pages: [] as string[] };
  const onDisk = new Set(
    readdirSync(generatedDir)
      .filter((f) => f.endsWith(".mdx") && !f.startsWith("["))
      .map((f) => `generated/${f.replace(/\.mdx$/, "")}`),
  );
  // 1. drop generated/* entries whose file is gone
  const before = order.pages;
  const kept = before.filter((p) => !p.startsWith("generated/") || onDisk.has(p));
  const dropped = before.filter((p) => p.startsWith("generated/") && !onDisk.has(p));
  // 2. generated files missing from the manifest join at the end of the
  //    generated cluster (right after the last generated entry), sorted
  const missing = [...onDisk].filter((s) => !kept.includes(s)).sort();
  const lastGen = kept.reduce((acc, p, i) => (p.startsWith("generated/") ? i : acc), -1);
  order.pages = lastGen === -1
    ? [...kept, ...missing]
    : [...kept.slice(0, lastGen + 1), ...missing, ...kept.slice(lastGen + 1)];
  // deterministic pretty format — `{ "pages": [...] }`, one entry per
  // line (extJson-safe per element, no JSON.* anywhere)
  const lines = order.pages.map((p) => `    ${extJsonStringify(p)}`).join(",\n");
  writeFileSync(orderPath, `{\n  "pages": [\n${lines}\n  ]\n}\n`, "utf-8");
  return { added: missing, dropped };
}

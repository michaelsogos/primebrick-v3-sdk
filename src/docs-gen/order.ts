/**
 * docs-gen — `_order.json` reconciliation.
 *
 * The files on disk are the ground truth: every `.mdx` emitted by ANY
 * generator into its owned dir must appear in the sidebar order under
 * that dir's name prefix; entries whose file no longer exists must drop.
 * No manual curation step. New files join at the end of their dir's
 * cluster, sorted — hand-written top-level entries and entries owned by
 * other dirs keep their position.
 *
 * Each generator owns exactly one output dir (page docs → `generated/`,
 * reference docs → `reference/`): the entry prefix is the dir basename,
 * so two generators reconciling the same `_order.json` never touch each
 * other's entries.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { extJsonParse, extJsonStringify } from "../json/ext-json.js";

/**
 * Reconcile `<dir>/../_order.json` against the `.mdx` files in `dir`,
 * using `basename(dir)` as the entry prefix. Returns the change summary
 * for reporting.
 */
export function reconcileOrder(dir: string): { added: string[]; dropped: string[] } {
  const prefix = `${basename(dir)}/`;
  const orderPath = join(dir, "..", "_order.json");
  const order = existsSync(orderPath)
    ? (extJsonParse(readFileSync(orderPath, "utf-8")) as { pages: string[] })
    : { pages: [] as string[] };
  const onDisk = new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".mdx") && !f.startsWith("["))
      .map((f) => `${prefix}${f.replace(/\.mdx$/, "")}`),
  );
  // 1. drop <prefix>/* entries whose file is gone
  const before = order.pages;
  const kept = before.filter((p) => !p.startsWith(prefix) || onDisk.has(p));
  const dropped = before.filter((p) => p.startsWith(prefix) && !onDisk.has(p));
  // 2. files missing from the manifest join at the end of their dir's
  //    cluster (right after the last <prefix> entry), sorted
  const missing = [...onDisk].filter((s) => !kept.includes(s)).sort();
  const lastGen = kept.reduce((acc, p, i) => (p.startsWith(prefix) ? i : acc), -1);
  order.pages = lastGen === -1
    ? [...kept, ...missing]
    : [...kept.slice(0, lastGen + 1), ...missing, ...kept.slice(lastGen + 1)];
  // deterministic pretty format — `{ "pages": [...] }`, one entry per
  // line (extJson-safe per element, no JSON.* anywhere)
  const lines = order.pages.map((p) => `    ${extJsonStringify(p)}`).join(",\n");
  writeFileSync(orderPath, `{\n  "pages": [\n${lines}\n  ]\n}\n`, "utf-8");
  return { added: missing, dropped };
}

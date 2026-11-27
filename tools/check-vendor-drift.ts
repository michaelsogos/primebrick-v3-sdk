#!/usr/bin/env bun
/**
 * check-vendor-drift — proportional staleness enforcement for remote chunks.
 *
 * The runtime never blocks on patch drift nor on ANY @primebrick/* drift
 * (user-ratified 2026-11-27): enforcement lives HERE, at lint time, where
 * it belongs. The tool scans the service's built remote chunks
 * (`fe/dist/*.deps.json`) and diffs every `vendor_requires` entry against
 * the version the SAME resolution rules produce today:
 *
 *   patch drift       → WARNING — rebuild recommended, never blocking
 *   minor/major drift → ERROR   — the chunk MUST be rebuilt (`pnpm fe:build`)
 *   no deps.json      → pass    — chunk never built, nothing to compare
 *
 * Exit 1 when any error is present, 0 otherwise. Run from the service root:
 *
 *   bun ../../primebrick-v3-sdk/tools/check-vendor-drift.ts
 *
 * The resolution mirrors the chunk build's `specifierVersion` (see any
 * service `fe/vite.config.ts`): `@primebrick/ui/vendor/*` specifiers wrap a
 * real package declared in ui's `vendor-map.json` — the version that
 * matters lives inside ui's own node_modules; every other specifier takes
 * its top-level package version from the service's node_modules.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { versionDrift } from "@primebrick/core";

type RemoteDepsManifest = { vendor_requires?: Record<string, string> };

const serviceRoot = process.cwd();
const uiRoot = join(serviceRoot, "node_modules", "@primebrick", "ui");

function pkgVersionAt(dir: string, pkg: string): string | null {
  const pj = join(dir, "node_modules", ...pkg.split("/"), "package.json");
  if (!existsSync(pj)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pj, "utf8")) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function topPackage(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function loadUiVendorMap(): Record<string, string> {
  const file = join(uiRoot, "vendor-map.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Current version of a specifier — the same answer the chunk build gives today. */
function currentSpecifierVersion(specifier: string, vendorMap: Record<string, string>): string | null {
  const wrappedKey = Object.keys(vendorMap)
    .filter((k) => specifier === k || specifier.startsWith(k + "/"))
    .sort((a, b) => b.length - a.length)[0];
  if (wrappedKey) return pkgVersionAt(uiRoot, vendorMap[wrappedKey]);
  return pkgVersionAt(serviceRoot, topPackage(specifier));
}

interface Finding {
  chunk: string;
  specifier: string;
  required: string;
  current: string;
  drift: "patch" | "minor" | "major" | "unresolvable";
}

const distDir = join(serviceRoot, "fe", "dist");
if (!existsSync(distDir)) {
  console.log("check-vendor-drift: no fe/dist — never built, nothing to compare");
  process.exit(0);
}

const depsFiles = readdirSync(distDir).filter((f) => f.endsWith(".deps.json"));
if (depsFiles.length === 0) {
  console.log("check-vendor-drift: no *.deps.json in fe/dist — nothing to compare");
  process.exit(0);
}

const vendorMap = loadUiVendorMap();
const warnings: Finding[] = [];
const errors: Finding[] = [];

for (const file of depsFiles) {
  let manifest: RemoteDepsManifest;
  try {
    manifest = JSON.parse(readFileSync(join(distDir, file), "utf8")) as RemoteDepsManifest;
  } catch {
    errors.push({ chunk: file, specifier: "(manifest)", required: "?", current: "?", drift: "unresolvable" });
    continue;
  }
  for (const [specifier, required] of Object.entries(manifest.vendor_requires ?? {})) {
    const current = currentSpecifierVersion(specifier, vendorMap);
    if (current == null) {
      errors.push({ chunk: file, specifier, required, current: "(unresolvable)", drift: "unresolvable" });
      continue;
    }
    const drift = versionDrift(required, current);
    if (drift === "none") continue;
    const finding = { chunk: file, specifier, required, current, drift } as Finding;
    if (drift === "patch") warnings.push(finding);
    else errors.push(finding);
  }
}

for (const w of warnings) {
  console.warn(
    `check-vendor-drift WARNING: ${w.chunk} — ${w.specifier} built against ${w.required}, current ${w.current} (patch drift — rebuild recommended: pnpm fe:build)`,
  );
}
for (const e of errors) {
  console.error(
    `check-vendor-drift ERROR: ${e.chunk} — ${e.specifier} built against ${e.required}, current ${e.current} (${e.drift} drift — the chunk MUST be rebuilt: pnpm fe:build)`,
  );
}

if (errors.length > 0) {
  console.error(`check-vendor-drift: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(
  warnings.length > 0
    ? `check-vendor-drift: pass with ${warnings.length} warning(s) [${depsFiles.length} manifest(s)]`
    : `check-vendor-drift: clean [${depsFiles.length} manifest(s)]`,
);

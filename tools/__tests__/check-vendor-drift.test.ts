/**
 * check-vendor-drift E2E — fixture-service probes through the REAL tool process.
 *
 * Each case builds a minimal service tree (fe/dist/*.deps.json + the
 * node_modules version sources the resolution reads), spawns
 * `bun tools/check-vendor-drift.ts` with cwd=fixture, and asserts exit
 * code + classification: patch drift warns (exit 0), minor/major errors
 * (exit 1), absent manifests pass silently.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "check-vendor-drift.ts");
const T = 30_000;

interface LintResult { code: number | null; out: string }

function writePkg(root: string, pkg: string, version: string): void {
  const dir = join(root, "node_modules", ...pkg.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
}

function runTool(setup: (root: string) => void): LintResult {
  const root = mkdtempSync(join(tmpdir(), "cvd-e2e-"));
  try {
    setup(root);
    const res = spawnSync("bun", [TOOL], { cwd: root, encoding: "utf8", timeout: T });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeDeps(root: string, requires: Record<string, string>): void {
  const dir = join(root, "fe", "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "svc-pages.deps.json"), JSON.stringify({ vendor_requires: requires }));
}

describe("check-vendor-drift", () => {
  it("passes silently when fe/dist does not exist", () => {
    const r = runTool(() => {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to compare");
  }, T);

  it("clean when versions match exactly", () => {
    const r = runTool((root) => {
      writePkg(root, "svelte", "5.57.2");
      writeDeps(root, { svelte: "5.57.2" });
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("clean");
  }, T);

  it("patch drift → warning, exit 0", () => {
    const r = runTool((root) => {
      writePkg(root, "svelte", "5.57.3");
      writeDeps(root, { svelte: "5.57.2" });
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(r.out).toContain("patch drift");
  }, T);

  it("minor drift → error, exit 1", () => {
    const r = runTool((root) => {
      writePkg(root, "svelte", "5.58.0");
      writeDeps(root, { svelte: "5.57.2" });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR");
    expect(r.out).toContain("minor drift");
  }, T);

  it("major drift → error, exit 1", () => {
    const r = runTool((root) => {
      writePkg(root, "@primebrick/ui", "4.0.0");
      writeDeps(root, { "@primebrick/ui": "3.5.1" });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("major drift");
  }, T);

  it("unresolvable current version → error", () => {
    const r = runTool((root) => {
      writeDeps(root, { svelte: "5.57.2" });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("unresolvable");
  }, T);

  it("ui vendor-map wrapped specifiers resolve inside ui's own node_modules", () => {
    const r = runTool((root) => {
      // ui itself at 3.5.1, wrapping clsx 2.1.1 via vendor-map
      writePkg(root, "@primebrick/ui", "3.5.1");
      writePkg(join(root, "node_modules", "@primebrick", "ui"), "clsx", "2.1.2");
      const uiDir = join(root, "node_modules", "@primebrick", "ui");
      writeFileSync(join(uiDir, "vendor-map.json"), JSON.stringify({ "@primebrick/ui/vendor/clsx": "clsx" }));
      writeDeps(root, { "@primebrick/ui/vendor/clsx": "2.1.1" });
    });
    // clsx 2.1.1 → 2.1.2 is a patch drift — warning, never error
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING");
  }, T);
});

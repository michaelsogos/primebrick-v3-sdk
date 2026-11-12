import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// check-standards is a CLI: `node tools/check-standards.ts <srcDir>
// --profile=fe`, config read from <cwd>/.devin/check-standards.json. Each
// case builds a throwaway repo dir (os.tmpdir — never inside a repo) with a
// `.devin` config plus `src/lib/entity-list/sheets/panels/` fixtures, then
// asserts on exit code + rule ids in the output.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "check-standards.ts");
const PANEL_DIR = join("lib", "entity-list", "sheets", "panels");

const CONFIG = {
  rules: {
    "panel-footer-start": { appliesTo: ["lib/entity-list/sheets/panels/"] },
    "panel-footer-cta": { appliesTo: ["lib/entity-list/sheets/panels/"] },
    "panel-button-testid": { appliesTo: ["lib/entity-list/sheets/panels/"] },
  },
};

interface Fixture {
  root: string;
  run: () => { status: number; output: string };
}

function repo(files: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), "stdfix-"));
  mkdirSync(join(root, ".devin"), { recursive: true });
  writeFileSync(join(root, ".devin", "check-standards.json"), JSON.stringify(CONFIG, null, 2));
  for (const [name, src] of Object.entries(files)) {
    const p = join(root, "src", PANEL_DIR, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return {
    root,
    run: () => {
      const r = spawnSync(process.execPath, [SCRIPT, "src", "--profile=fe"], {
        cwd: root,
        encoding: "utf8",
      });
      return { status: r.status ?? 2, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

const PANEL = (body: string) => `<script lang="ts">\n  const noop = () => {};\n</script>\n\n<SheetPanelLayout>\n  ${body}\n</SheetPanelLayout>\n`;

describe("check-standards — SheetPanelFooter split contract", () => {
  const fixtures: Fixture[] = [];
  const make = (files: Record<string, string>) => {
    const f = repo(files);
    fixtures.push(f);
    return f.run();
  };
  afterAll(() => {
    for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
  });

  it("passes: badge + badge-drill (button wrapping Badge) in start, CTAs on the right", () => {
    const { status, output } = make({
      "Ok.svelte": PANEL(`<SheetPanelFooter>
    {#snippet start()}
      <button type="button" data-testid="p-ver" title="v" onclick={noop}>
        <Badge variant="outline" class="text-xs font-semibold border border-primary cursor-pointer hover:bg-primary/10">v3</Badge>
      </button>
      <Badge variant="destructive">deleted</Badge>
      <span>meta</span>
    {/snippet}
    <button type="button" data-testid="p-save" onclick={noop}>Save</button>
  </SheetPanelFooter>`),
    });
    expect(output).toContain("clean");
    expect(status).toBe(0);
  });

  it("flags panel-footer-start: a text CTA (no Badge inside) inside {#snippet start}", () => {
    const { status, output } = make({
      "Bad.svelte": PANEL(`<SheetPanelFooter>
    {#snippet start()}
      <button type="button" data-testid="p-x" onclick={noop}>x</button>
      <Button data-testid="p-y">y</Button>
    {/snippet}
  </SheetPanelFooter>`),
    });
    expect(status).toBe(1);
    expect(output).toContain("[panel-footer-start]");
  });

  it("flags panel-footer-cta: a bare Badge in the right-aligned group", () => {
    const { status, output } = make({
      "Bad.svelte": PANEL(`<SheetPanelFooter>
    {#snippet start()}
      <span>meta</span>
    {/snippet}
    <Badge variant="destructive">deleted</Badge>
    <button type="button" data-testid="p-save" onclick={noop}>Save</button>
  </SheetPanelFooter>`),
    });
    expect(status).toBe(1);
    expect(output).toContain("[panel-footer-cta]");
  });

  it("ignores markup comments mentioning interactive controls", () => {
    const { status, output } = make({
      "Ok.svelte": PANEL(`<SheetPanelFooter>
    {#snippet start()}
      <!-- the <button> drill affordance lives in the default group,
           alongside <Button> commit CTAs -->
      <Badge variant="outline">v3</Badge>
    {/snippet}
  </SheetPanelFooter>`),
    });
    expect(output).toContain("clean");
    expect(status).toBe(0);
  });
});

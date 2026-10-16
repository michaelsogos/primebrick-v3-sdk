import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDocsPack } from "../build-docs-pack.js";
import { parseDocsPackPayload, DOCS_PACK_CAPABILITY } from "../manifest.js";

let dir: string;
let docsDir: string;
let outDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "docs-pack-"));
  docsDir = join(dir, "docs");
  outDir = join(dir, "out");
  mkdirSync(join(docsDir, "dev-guide"), { recursive: true });
  writeFileSync(join(docsDir, "dev-guide", "index.mdx"), "# Hello\n", "utf-8");
  writeFileSync(join(docsDir, "_order.json"), '{"pages":["dev-guide/index"]}', "utf-8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildDocsPack", () => {
  it("copies docs verbatim, runs generators, writes a valid manifest", async () => {
    const manifest = await buildDocsPack({
      repo: "ai",
      docsDir,
      outDir,
      generators: [
        async () => [
          { path: "generated/extra.mdx", content: "# Generated\n" },
        ],
      ],
    });
    expect(manifest.schema).toBe(1);
    expect(manifest.repo).toBe("ai");
    const paths = manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual(["_order.json", "dev-guide/index.mdx", "generated/extra.mdx"]);
    for (const f of manifest.files) expect(f.sha256).toHaveLength(64);

    // Round-trip: what serve-docs-pack emits must re-validate.
    const payload = parseDocsPackPayload({
      manifest,
      files: manifest.files.map((f) => ({ path: f.path, content: "# x" })),
    });
    expect(payload.files).toHaveLength(3);
  });

  it("fails when docsDir is missing", async () => {
    await expect(
      buildDocsPack({ repo: "x", docsDir: join(dir, "nope"), outDir: join(dir, "o2") }),
    ).rejects.toThrow("docsDir not found");
  });
});

describe("parseDocsPackPayload", () => {
  const good = {
    manifest: {
      schema: 1,
      repo: "ai",
      generated_at: "2026-10-12T00:00:00.000Z",
      files: [{ path: "a.mdx", sha256: "0".repeat(64), bytes: 3 }],
    },
    files: [{ path: "a.mdx", content: "abc" }],
  };

  it("accepts a valid payload", () => {
    expect(parseDocsPackPayload(good).manifest.repo).toBe("ai");
  });

  it.each([
    ["wrong schema", { ...good, manifest: { ...good.manifest, schema: 2 } }],
    ["missing repo", { ...good, manifest: { ...good.manifest, repo: "" } }],
    ["bad sha256", { ...good, manifest: { ...good.manifest, files: [{ path: "a", sha256: "x", bytes: 1 }] } }],
    ["non-string content", { ...good, files: [{ path: "a", content: 5 }] }],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseDocsPackPayload(raw)).toThrow("invalid docs pack payload");
  });
});

it("exposes the capability constant", () => {
  expect(DOCS_PACK_CAPABILITY).toBe("docs_pack");
});

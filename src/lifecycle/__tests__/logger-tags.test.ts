import { describe, it, expect } from "vitest";
import { formatLine, setLogOptions, argsToMsgAndMeta } from "../logger.js";

describe("logger tags", () => {
  it("renders [tag1] [tag2] before the message in pretty format", () => {
    const line = formatLine("info", "Loaded docs", { tags: ["embedding-pipeline", "docs"] });
    expect(line).toContain("[embedding-pipeline] [docs] Loaded docs");
    // tags must NOT be duplicated inside the rendered meta body
    expect(line.indexOf("embedding-pipeline")).toBeLessThan(line.indexOf("Loaded docs"));
  });

  it("renders no tag brackets when tags are absent or empty", () => {
    const noTags = formatLine("info", "plain message");
    expect(noTags).toContain("plain message");
    expect(noTags).not.toContain("[info]"); // sanity: nothing injected
    const empty = formatLine("info", "plain message", { tags: [] });
    expect(empty).not.toContain("[] ");
  });

  it("keeps tags as a structured field in json format", () => {
    setLogOptions({ format: "json" });
    const line = formatLine("info", "Loaded docs", { tags: ["a", "b"], extra: 1 });
    const rec = JSON.parse(line);
    expect(rec.tags).toEqual(["a", "b"]);
    expect(rec.extra).toBe(1);
    expect(rec.msg).toBe("Loaded docs");
    setLogOptions({ format: "pretty" });
  });
});

describe("console bridge — no tag magic", () => {
  it("never extracts [tag] from the message (no legacy shim)", () => {
    const r = argsToMsgAndMeta(["[embedding-pipeline] Loaded 113 docs"]);
    expect(r.msg).toBe("[embedding-pipeline] Loaded 113 docs");
    expect(r.meta?.tags).toBeUndefined();
  });
});

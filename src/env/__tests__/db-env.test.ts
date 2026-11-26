import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDbEnv, assertValidSchemaList } from "../db-env.js";

const GOOD_URL = "postgres://primebrick:pw@127.0.0.1:5432/primebrick";

describe("assertDbEnv — closed-set DB env contract (URL only)", () => {
  const originalEnv = { ...process.env };
  let cwd: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_SCHEMA;
    cwd = mkdtempSync(join(tmpdir(), "dbenv-"));
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns { url } for the happy path", () => {
    process.env.DATABASE_URL = GOOD_URL;
    expect(assertDbEnv(cwd)).toEqual({ url: GOOD_URL });
  });

  it("accepts a PG keyword connection string", () => {
    process.env.DATABASE_URL = "host=127.0.0.1 dbname=primebrick user=primebrick";
    expect(assertDbEnv(cwd).url).toContain("dbname=primebrick");
  });

  it("crashes when DATABASE_URL is missing or empty", () => {
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is required/);
    process.env.DATABASE_URL = "   ";
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is required/);
  });

  it("crashes when DATABASE_URL is not parseable", () => {
    process.env.DATABASE_URL = "not-a-conn-string";
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is neither/);
  });

  it("crashes when DATABASE_SCHEMA is set in process.env — schema identity is code, env injection is a violation", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "ai"; // docker env injection attempt
    expect(() => assertDbEnv(cwd)).toThrow(/env 'DATABASE_SCHEMA'.*reserved/);
  });

  it("crashes when DATABASE_SCHEMA appears in the .env file", () => {
    process.env.DATABASE_URL = GOOD_URL;
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=x\nDATABASE_SCHEMA=ai\n");
    expect(() => assertDbEnv(cwd)).toThrow(/\.env contains 'DATABASE_SCHEMA'/);
  });

  it("crashes on extra keys in the .env file", () => {
    process.env.DATABASE_URL = GOOD_URL;
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=x\nREDIS_URL=redis://x\n");
    expect(() => assertDbEnv(cwd)).toThrow(/\.env contains 'REDIS_URL'/);
  });

  it("crashes on stray DATABASE_*/DB_* process env keys", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DB_SCHEMA = "ai";
    expect(() => assertDbEnv(cwd)).toThrow(/env 'DB_SCHEMA'.*reserved/);
  });
});

describe("assertValidSchemaList — code-declared schema identity", () => {
  it("accepts a single schema", () => {
    expect(assertValidSchemaList(["ai"])).toEqual(["ai"]);
  });

  it("dedupes and preserves declaration order (first = primary)", () => {
    expect(assertValidSchemaList(["system", "public", "system", "custom"])).toEqual([
      "system",
      "public",
      "custom",
    ]);
  });

  it("crashes on an empty list", () => {
    expect(() => assertValidSchemaList([])).toThrow(/non-empty/);
  });

  it("crashes on invalid schema names", () => {
    expect(() => assertValidSchemaList(["1bad", "ok_name", "SCREAMING"])).toThrow(
      /invalid name\(s\) \[1bad, SCREAMING\]/,
    );
  });
});

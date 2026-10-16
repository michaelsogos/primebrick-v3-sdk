import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDbEnv } from "../db-env.js";

const GOOD_URL = "postgres://primebrick:pw@127.0.0.1:5432/primebrick";

describe("assertDbEnv — closed-set DB env contract", () => {
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

  it("returns { url, schemas } for the happy path (single schema)", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "ai";
    expect(assertDbEnv(cwd)).toEqual({ url: GOOD_URL, schemas: ["ai"] });
  });

  it("accepts CSV and JSON-array schema lists, deduped", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "public, system ,custom";
    expect(assertDbEnv(cwd).schemas).toEqual(["public", "system", "custom"]);
    process.env.DATABASE_SCHEMA = '["public","system","system"]';
    expect(assertDbEnv(cwd).schemas).toEqual(["public", "system"]);
  });

  it("accepts a PG keyword connection string", () => {
    process.env.DATABASE_URL = "host=127.0.0.1 dbname=primebrick user=primebrick";
    process.env.DATABASE_SCHEMA = "job";
    expect(assertDbEnv(cwd).url).toContain("dbname=primebrick");
  });

  it("crashes when DATABASE_URL is missing or empty", () => {
    process.env.DATABASE_SCHEMA = "ai";
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is required/);
    process.env.DATABASE_URL = "   ";
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is required/);
  });

  it("crashes when DATABASE_URL is not parseable", () => {
    process.env.DATABASE_URL = "not-a-conn-string";
    process.env.DATABASE_SCHEMA = "ai";
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_URL is neither/);
  });

  it("crashes when DATABASE_SCHEMA is missing or empty", () => {
    process.env.DATABASE_URL = GOOD_URL;
    expect(() => assertDbEnv(cwd)).toThrow(/DATABASE_SCHEMA is required/);
    process.env.DATABASE_SCHEMA = " , ";
    expect(() => assertDbEnv(cwd)).toThrow();
  });

  it("crashes on invalid schema names", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "1bad,ok_name,SCREAMING";
    expect(() => assertDbEnv(cwd)).toThrow(/invalid name\(s\) \[1bad, SCREAMING\]/);
  });

  it("crashes on extra keys in the .env file", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "ai";
    writeFileSync(
      join(cwd, ".env"),
      "DATABASE_URL=x\nDATABASE_SCHEMA=ai\nREDIS_URL=redis://x\n",
    );
    expect(() => assertDbEnv(cwd)).toThrow(/\.env contains 'REDIS_URL'/);
  });

  it("crashes on stray DATABASE_*/DB_* process env keys", () => {
    process.env.DATABASE_URL = GOOD_URL;
    process.env.DATABASE_SCHEMA = "ai";
    process.env.DB_SCHEMA = "ai";
    expect(() => assertDbEnv(cwd)).toThrow(/env 'DB_SCHEMA'.*reserved/);
  });
});

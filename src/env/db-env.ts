/**
 * Closed-set DB env contract — the ONLY two env vars a Primebrick service
 * may consume (everything else lives in `<schema>.config_entries`).
 *
 * Contract (hard crashes at boot on any violation):
 * - the service `.env` file may contain ONLY `DATABASE_URL` and
 *   `DATABASE_SCHEMA` — extra keys are a boot error;
 * - `DATABASE_URL` — required, non-empty, parseable as a `postgres://` /
 *   `postgresql://` URL or a PG keyword connection string
 *   (`host=… dbname=… user=…`);
 * - `DATABASE_SCHEMA` — required, non-empty; accepts a single name, a CSV
 *   list, or a JSON array; each entry must be a valid PG identifier
 *   (`^[a-z][a-z0-9_]*$`); resolves to a deduped `string[]` (first = the
 *   service's primary/owned schema).
 *
 * `process.env` itself can't be closed-set (system noise like PATH) — the
 * closed set is enforced on the `.env` FILE plus a guard on the
 * `DATABASE_*`/`DB_*` prefix family in process.env.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DbEnv = {
  url: string;
  /** Owned schemas, declaration order — [0] is the primary/owned schema. */
  schemas: string[];
};

import { extJsonParse } from "../json/ext-json.js";

const ALLOWED_KEYS = new Set(["DATABASE_URL", "DATABASE_SCHEMA"]);
const SCHEMA_NAME = /^[a-z][a-z0-9_]*$/;
/** Prefixes in OUR namespace — anything here that isn't ours is a violation. */
const RESERVED_PREFIX = /^(DATABASE_|DB_)/;

function parseSchemas(raw: string): string[] {
  const t = raw.trim();
  let list: string[];
  if (t.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = extJsonParse(t);
    } catch {
      throw new Error(`DATABASE_SCHEMA is not valid JSON: ${t}`);
    }
    if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
      throw new Error(`DATABASE_SCHEMA JSON must be an array of strings, got: ${t}`);
    }
    list = parsed as string[];
  } else {
    list = t.split(",").map((s) => s.trim());
  }
  const bad = list.filter((s) => !SCHEMA_NAME.test(s));
  if (bad.length) {
    throw new Error(`DATABASE_SCHEMA invalid name(s) [${bad.join(", ")}] — must match ${SCHEMA_NAME}`);
  }
  return [...new Set(list)];
}

function assertValidConnString(url: string): void {
  if (/^postgres(ql)?:\/\//.test(url)) {
    try {
      const u = new URL(url);
      if (!u.hostname) throw new Error("no host");
      return;
    } catch (e) {
      throw new Error(`DATABASE_URL is not a valid postgres URL: ${e instanceof Error ? e.message : e}`);
    }
  }
  // PG keyword connection string: host=… dbname=… user=…
  if (/\bhost\s*=/.test(url) && /\bdbname\s*=/.test(url)) return;
  throw new Error(
    `DATABASE_URL is neither a postgres:// URL nor a PG keyword conn string (needs host=… dbname=…)`
  );
}

function assertEnvFileClosedSet(cwd: string, errors: string[]): void {
  const envFile = join(cwd, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !ALLOWED_KEYS.has(m[1]!)) {
      errors.push(`.env contains '${m[1]}' — only DATABASE_URL and DATABASE_SCHEMA are allowed`);
    }
  }
}

/**
 * Validate the DB env contract and return the resolved `{ url, schemas }`.
 * Throws with the full violation list on any failure — services MUST crash.
 */
export function assertDbEnv(cwd = process.cwd()): DbEnv {
  const errors: string[] = [];

  assertEnvFileClosedSet(cwd, errors);

  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    errors.push("DATABASE_URL is required and must be non-empty");
  } else {
    try {
      assertValidConnString(url.trim());
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const schemaRaw = process.env.DATABASE_SCHEMA;
  let schemas: string[] = [];
  if (!schemaRaw?.trim()) {
    errors.push("DATABASE_SCHEMA is required and must be non-empty");
  } else {
    try {
      schemas = parseSchemas(schemaRaw);
      if (schemas.length === 0) errors.push("DATABASE_SCHEMA resolved to an empty schema list");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  for (const key of Object.keys(process.env)) {
    if (RESERVED_PREFIX.test(key) && !ALLOWED_KEYS.has(key)) {
      errors.push(`env '${key}' is in the reserved DATABASE_*/DB_* namespace but is not an allowed key`);
    }
  }

  if (errors.length) {
    throw new Error(`DB env contract violated — fix and restart:\n  - ${errors.join("\n  - ")}`);
  }
  return { url: url!.trim(), schemas };
}

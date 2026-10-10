/**
 * Service identity — the caller-identification layer for internal
 * (BE↔US, US↔US) traffic.
 *
 * Every internal call carries two headers:
 *   - `User-Agent: {pkg_name}/{pkg_version} ({capabilities}) {runtime}/{ver}`
 *   - `x-primebrick-client-shield-key: <key>`
 *
 * The endpoint middleware `verifyClientIdentity()` enforces:
 *   - no UA            → 401 (unidentified caller)
 *   - UA prefix not in allowlist → 403 (unknown client)
 *   - bad client key   → 401
 *
 * The allowlist's source of truth is `system.client_registry` (BE-owned):
 * rows with `source='registry'` are auto-maintained from `service.register`
 * payloads; `source='manual'` rows are admin-managed (e.g. Postman).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const CLIENT_SHIELD_KEY_HEADER = "x-primebrick-client-shield-key";

/**
 * sha256 hex of a client key — the only form that ever leaves the service
 * (sent in `service.register` → stored in system.client_registry) and the
 * only form compared at verification time.
 */
export function clientKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface PackageIdentity {
  name: string;
  version?: string;
  /**
   * Declared capabilities from package.json (`"capabilities": [...]`),
   * snake_case lowercase. Sent in `service.register` → persisted in
   * `service_registry.capabilities` — refreshed at every registration.
   */
  capabilities?: string[];
}

/**
 * Derive the caller's package identity from `package.json`.
 *
 * Search root: the entry file's directory (`process.argv[1]`), walking
 * upward until a package.json is found — so identity is the *deployed
 * package* regardless of the process cwd (e.g. `cd ../.. && bun --hot
 * ./primebrick-us-v3/ai/src/index.ts` still resolves primebrick-ai).
 * `startDir` overrides the search root (tests, scripts).
 * Returns `{name: "app"}` when no package.json is found.
 */
function findPackageDir(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function detectPackageIdentity(startDir?: string): PackageIdentity {
  const entryDir = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd();
  const cwd = startDir ?? findPackageDir(entryDir) ?? entryDir;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      capabilities?: unknown;
    };
    return {
      name: pkg.name ?? "app",
      version: pkg.version,
      capabilities: Array.isArray(pkg.capabilities)
        ? pkg.capabilities.filter((c): c is string => typeof c === "string")
        : undefined,
    };
  } catch {
    return { name: "app" };
  }
}

/** Detected runtime, e.g. `Bun/1.2.19` or `Node/24.14.1`. */
function runtimeTag(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `Bun/${bun}` : `Node/${process.versions.node}`;
}

/**
 * Build the Primebrick User-Agent string, e.g.
 * `primebrick-emailsender/1.4.0 (emailsender) Node/24.14.1`.
 * `capabilities` is the service code / role tag — free-form but should be
 * stable; it is what the allowlist prefix matches against along with name.
 */
export function buildUserAgent(identity: PackageIdentity, capabilities?: string): string {
  const ver = identity.version ? `/${identity.version}` : "";
  const caps = capabilities ? ` (${capabilities})` : "";
  return `${identity.name}${ver}${caps} ${runtimeTag()}`;
}

/**
 * Identity headers to attach to every outbound internal call.
 * `clientKey` comes from the service's own config (env/config entry) —
 * it is the secret paired with the UA in `system.client_registry`.
 */
export function identityHeaders(identity: PackageIdentity, capabilities: string, clientKey: string): Record<string, string> {
  return {
    "User-Agent": buildUserAgent(identity, capabilities),
    [CLIENT_SHIELD_KEY_HEADER]: clientKey,
  };
}

export type ClientIdentityResult =
  | { ok: true; ua: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verify an inbound internal call's identity headers.
 *
 * - `ua` missing                → 401 UNIDENTIFIED_CLIENT
 * - `ua` not starting with an allowed prefix → 403 UNKNOWN_CLIENT
 * - `verifyKey(key)` false      → 401 INVALID_CLIENT_SHIELD_KEY
 *
 * `allowedPrefixes` is loaded from `system.client_registry` (cached by the
 * caller and refreshed on `system.client_registry.changed` events).
 * `verifyKey` compares the presented key against the registry entry for the
 * matched prefix (hash comparison — inject the hasher).
 */
export async function verifyClientIdentity(
  req: { headers: { get(name: string): string | null } },
  opts: {
    allowedPrefixes: readonly string[];
    verifyKey: (uaPrefix: string, presentedKey: string) => boolean | Promise<boolean>;
  },
): Promise<ClientIdentityResult> {
  const ua = req.headers.get("user-agent") ?? "";
  if (!ua) {
    return { ok: false, status: 401, error: "UNIDENTIFIED_CLIENT" };
  }
  const prefix = opts.allowedPrefixes.find((p) => ua.startsWith(p));
  if (!prefix) {
    return { ok: false, status: 403, error: "UNKNOWN_CLIENT" };
  }
  const key = req.headers.get(CLIENT_SHIELD_KEY_HEADER) ?? "";
  if (!key || !(await opts.verifyKey(prefix, key))) {
    return { ok: false, status: 401, error: "INVALID_CLIENT_SHIELD_KEY" };
  }
  return { ok: true, ua };
}

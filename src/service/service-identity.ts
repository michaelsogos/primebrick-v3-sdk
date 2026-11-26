/**
 * Service identity — static package identity and observability metadata for
 * internal (BE↔US, US↔US) traffic.
 *
 * Trust on internal hops is proof-of-possession — vault-derived per-service
 * HTTP signatures and sealed NATS envelopes — never a transmitted secret.
 * What this module provides is the non-cryptographic identity layer: the
 * User-Agent string (name/version/runtime) carried as observability metadata
 * for logs and traces, and the static service-code resolution everything
 * downstream is generated from.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extJsonParse } from "../json/ext-json.js";

export interface PackageIdentity {
  name: string;
  version?: string;
  /**
   * Declared capabilities from package.json (`"capabilities": [...]`),
   * snake_case lowercase. Sent in `service.register` → persisted in
   * `service_registry.capabilities` — refreshed at every registration.
   */
  capabilities?: string[];
  /**
   * Static service-code override declared in package.json
   * (`"service_code": "..."`). When absent, the code is derived from
   * `name` (`primebrick-<code>` → `<code>`). This is the ONLY way a
   * service may carry a code that does not derive from its package name —
   * it is part of the shipped artifact, not runtime-editable config.
   */
  service_code?: string;
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
    const pkg = extJsonParse<{
      name?: string;
      version?: string;
      capabilities?: unknown;
      service_code?: unknown;
    }>(readFileSync(join(cwd, "package.json"), "utf8"));
    return {
      name: pkg.name ?? "app",
      version: pkg.version,
      capabilities: Array.isArray(pkg.capabilities)
        ? pkg.capabilities.filter((c): c is string => typeof c === "string")
        : undefined,
      service_code: typeof pkg.service_code === "string" ? pkg.service_code : undefined,
    };
  } catch {
    return { name: "app" };
  }
}

/**
 * Canonical service code — STATIC identity resolved once at boot from the
 * deployed artifact, never from runtime-editable config:
 *
 *   1. package.json `"service_code"` (explicit override)
 *   2. derived from package name (`primebrick-<code>` → `<code>`)
 *
 * Everything downstream — service_registry.code, `/svc/<code>` proxy
 * routes, the i18n namespace (`<code>.*`), the NATS/schema ownership
 * claim — is generated from this value. A DB `service_code` config row
 * may still exist (legacy seeds): it is treated as a drift tripwire —
 * when present and different from the static identity, boot fails loudly
 * instead of silently re-identifing the service under a mutated code.
 */
export function resolveServiceCode(identity: PackageIdentity, configuredCode?: string | null): string {
  const code = identity.service_code ?? identity.name.replace(/^primebrick-/, "");
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    throw new Error(
      `Invalid service_code "${code}" (from ${identity.service_code ? 'package.json "service_code"' : `package name "${identity.name}"`}) — ` +
        `must match ^[a-z][a-z0-9_]*$. Declare an explicit "service_code" in package.json to override.`,
    );
  }
  if (configuredCode && configuredCode !== code) {
    throw new Error(
      `service_code config drift: config_entries carries "${configuredCode}" but the deployed artifact resolves to "${code}" ` +
        `(${identity.service_code ? 'package.json "service_code"' : `derived from package name "${identity.name}"`}). ` +
        `service_code is static identity — fix the config row, not the code.`,
    );
  }
  return code;
}

/**
 * Runtime slot for the service code resolved at `createMicroservice()` —
 * the same static identity stamped in the UA. Set once at boot; the getter
 * falls back to deriving it from the deployed artifact so tests/tooling
 * calling governed helpers outside a full boot still resolve correctly.
 */
let currentServiceCodeSlot: string | undefined;
export function setCurrentServiceCode(code: string): void {
  currentServiceCodeSlot = code;
}
export function currentServiceCode(): string {
  return (currentServiceCodeSlot ??= resolveServiceCode(detectPackageIdentity()));
}

/** Detected runtime, e.g. `Bun/1.2.19` or `Node/24.14.1`. */
function runtimeTag(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `Bun/${bun}` : `Node/${process.versions.node}`;
}

/**
 * Build the Primebrick User-Agent string, e.g.
 * `primebrick-emailsender/1.4.0 (emailsender) Node/24.14.1` — observability
 * metadata for logs and traces, never consulted for trust decisions.
 */
export function buildUserAgent(identity: PackageIdentity, capabilities?: string): string {
  const ver = identity.version ? `/${identity.version}` : "";
  const caps = capabilities ? ` (${capabilities})` : "";
  return `${identity.name}${ver}${caps} ${runtimeTag()}`;
}

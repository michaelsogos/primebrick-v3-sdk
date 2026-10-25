/**
 * Access-axis grant evaluation — `access.{app}.{module}.{leaf}`.
 *
 * A separate vocabulary inside the SAME permission pipeline as entity RBAC
 * (role_mappings → expanded permission set). Entity permissions answer
 * "may this request execute"; access grants answer "does this
 * app/module/page exist for this user" — the FE discovery/navigation
 * plane. A user can hold `customer.read.*` (API) while lacking
 * `access.crm.customers` (page), and vice-versa.
 *
 * Coverage is PURE PATTERN MATCHING — never ancestor logic:
 *   grant === required     → covers
 *   grant contains `*`     → regex match
 *   otherwise              → does not cover
 * A bare namespace grant (`access.system.job`) therefore covers NOTHING
 * but itself — and since namespaces are never leaves, it is a dead string
 * (rejected outright by `isAccessGrantLegal`). Whole-module grants are
 * written `access.system.job.*`; single-page grants are the exact leaf
 * key `access.system.job.rules`.
 *
 * `is_admin` bypasses entity RBAC but NOT this axis — access grants are
 * always explicit in the role's permission set.
 *
 * Required keys are never declared by hand — `accessLeafKey` derives them
 * from the leaf's route path (`create`/`[param]` subroutes collapse into
 * the owning leaf). Page keys collapse the module segment when
 * `part_of === code` — same rule as the URL (`/crm/customers` →
 * `access.crm.customers`).
 */

const ACCESS_PREFIX = "access.";

/** `access.<seg>[.<seg>…]` — declared keys carry no wildcard. */
const ACCESS_KEY_RE = /^access(\.[a-z0-9_-]+)+$/i;

export function isAccessKey(value: unknown): value is string {
  return typeof value === "string" && ACCESS_KEY_RE.test(value);
}

/**
 * `true` when `grant` covers `required` on the access axis — exact match
 * or grant-side `*` wildcard regex. NEVER ancestor coverage: a bare
 * namespace grant (`access.system.job`) covers nothing but itself.
 */
function accessGrantCovers(grant: string, required: string): boolean {
  if (grant === required) return true;
  if (!grant.includes("*")) return false;
  const regex = new RegExp(
    "^" + grant.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(required);
}

/**
 * Evaluate an access requirement against the user's grants.
 *
 * - `required` absent → true (undeclared = open).
 * - `required` not an access key → false (defensive: never a silent grant).
 * - No `is_admin` short-circuit — admin sees only what its grants cover.
 */
export function isAccessGranted(
  userPermissions: Set<string> | readonly string[],
  required?: string | null,
): boolean {
  if (required == null || required === "") return true;
  if (!isAccessKey(required)) return false;
  for (const grant of userPermissions) {
    if (accessGrantCovers(grant, required)) return true;
  }
  return false;
}

/**
 * The access key of a leaf route — `create` and `[param]` segments are
 * sub-states of the owning leaf, never leaves of their own.
 *
 * `/system/job/job-schedules/create` under ns `access.system.job` →
 * `access.system.job.job-schedules`; `/crm/customers` under `access.crm`
 * → `access.crm.customers`.
 *
 * `relPath` = the route path with the module prefix already stripped
 * (leading `/` tolerated).
 */
export function accessLeafKey(ns: string, relPath: string): string {
  const segs = relPath
    .split("/")
    .filter(Boolean)
    .filter((s) => s !== "create" && !(s.startsWith("[") && s.endsWith("]")));
  return `${ns}.${segs.join(".")}`;
}

/**
 * The access key of a module sheet — sheet keys are `<code>.<name>`;
 * strip the code prefix and attach the name to the module namespace:
 * `job.runDetail` under `access.system.job` → `access.system.job.runDetail`.
 */
export function accessSheetKey(ns: string, code: string, sheetKey: string): string {
  return `${ns}.${sheetKey.slice(code.length + 1)}`;
}

/**
 * Grant-legality grammar for `access.*` permission strings — the
 * role_mappings write-path guard (rejection, not silent non-coverage):
 *
 *   `access`           → ILLEGAL — the axis root is not a grant
 *   `access.*`         → ILLEGAL — would cover the whole axis
 *   `access.<path>.*`  → LEGAL wildcard (any non-empty path; `*` only as
 *                        the trailing whole segment)
 *   `access.<leaf>`    → LEGAL exact — only when the key is a REAL leaf:
 *                        bare namespaces (`access.system.job`) and typos
 *                        are ILLEGAL, not dead grants. Requires `leafKeys`
 *                        (the inventory of derived leaf keys); absent =
 *                        structural check only.
 */
export function isAccessGrantLegal(
  grant: string,
  leafKeys?: ReadonlySet<string>,
): boolean {
  if (!grant.startsWith(ACCESS_PREFIX)) return false;
  if (grant.includes("*")) {
    return /^access\.[a-z0-9_-]+(\.[a-z0-9_-]+)*\.\*$/.test(grant);
  }
  if (!isAccessKey(grant)) return false;
  if (!leafKeys) return true; // structural check only — caller has no inventory
  return leafKeys.has(grant);
}

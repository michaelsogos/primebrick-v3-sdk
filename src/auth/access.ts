/**
 * Access-axis grant evaluation — `access.{app}.{module}.{page}`.
 *
 * A separate vocabulary inside the SAME permission pipeline as entity RBAC
 * (role_mappings → expanded permission set → wildcards). The questions are
 * different: entity permissions answer "may this request execute", access
 * grants answer "does this app/module/page exist for this user" — the FE
 * discovery/navigation plane. A user can hold `customer.read.*` (API) while
 * lacking `access.crm.customers` (page), and vice-versa.
 *
 * Deny-first, hierarchical: a bare grant covers its whole subtree —
 * `access.system.job` ⇒ `access.system.job.rules`, `access.crm` ⇒ every
 * crm page. Wildcards work at any level (`access.system.*`). Page keys
 * collapse the module segment when `part_of === code` — same rule as the
 * URL (`/crm/customers` → `access.crm.customers`, not `access.crm.crm.*`).
 *
 * `is_admin` is NOT a blanket bypass here: it implies `access.system` only
 * (the platform plane admins operate). Business roots (`access.crm.*`,
 * `access.shop.*`, …) require explicit role grants even for admins.
 */

const ACCESS_PREFIX = "access.";
/** Root implied for admins on the access axis — platform plane only. */
export const ADMIN_INHERITED_ACCESS = "access.system";

/** `access` / `access.<seg>[.<seg>[.<seg>]]` — declared keys carry no wildcard. */
const ACCESS_KEY_RE = /^access(\.[a-z0-9_-]+)+$/i;

export function isAccessKey(value: unknown): value is string {
  return typeof value === "string" && ACCESS_KEY_RE.test(value);
}

/**
 * `true` when `grant` covers `required` on the access axis:
 * exact match, OR bare-ancestor (`access.system.job` covers
 * `access.system.job.rules`), OR grant-side `*` wildcard.
 */
function accessGrantCovers(grant: string, required: string): boolean {
  if (grant === required) return true;
  if (required.startsWith(grant + ".")) return true;
  if (grant.includes("*")) {
    const regex = new RegExp(
      "^" + grant.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
    );
    return regex.test(required);
  }
  return false;
}

/**
 * Evaluate an access requirement against the user's grants.
 *
 * - `required` absent → true (undeclared = open to authenticated users).
 * - `required` not an access key → false (defensive: never a silent grant).
 * - `is_admin` → behaves as if `access.system` were granted. Non-system
 *   roots are unaffected — admin sees the System app, not every app.
 */
export function isAccessGranted(
  userPermissions: Set<string> | readonly string[],
  isAdmin: boolean,
  required?: string | null,
): boolean {
  if (required == null || required === "") return true;
  if (!isAccessKey(required)) return false;
  for (const grant of userPermissions) {
    if (accessGrantCovers(grant, required)) return true;
  }
  return isAdmin && accessGrantCovers(ADMIN_INHERITED_ACCESS, required);
}

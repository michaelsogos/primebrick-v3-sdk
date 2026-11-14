/**
 * `endpoints.entities` — the entity names a service owns, derived from
 * the SAME declarations that produce its `/entities/*` routes. Served on
 * `/modules`: the FE resolves entity→service (ref-sheet drill-through,
 * `/svc/<code>` api prefix) from the discovery document instead of any
 * hand-maintained map.
 *
 * Shape: `entities: string[]` — snake_case api names, unique, non-empty.
 * The enrollment gate rejects malformed declarations so a poisoned
 * payload never reaches service_registry.
 */

const API_NAME = /^[a-z][a-z0-9_]*$/;

export function validateEntitiesDeclaration(
  code: string,
  decl: unknown,
): string | null {
  if (decl === undefined || decl === null) return null; // optional axis
  if (!Array.isArray(decl)) {
    return `endpoints.entities must be an array of entity api names (service "${code}")`;
  }
  const seen = new Set<string>();
  for (const e of decl) {
    if (typeof e !== "string" || !API_NAME.test(e)) {
      return `endpoints.entities: every entry must be a snake_case entity api name (service "${code}")`;
    }
    if (seen.has(e)) {
      return `endpoints.entities: duplicate entity "${e}" (service "${code}")`;
    }
    seen.add(e);
  }
  return null;
}

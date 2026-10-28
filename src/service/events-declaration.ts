/**
 * `endpoints.events` declaration + enrollment validator.
 *
 * A module declares the NATS subjects it PUBLISHES as domain events
 * (`events.emits`) — the decoupled vocabulary other modules and host
 * pickers consume (e.g. a job rule's `event_subject`/`source_subject`
 * combobox fed from the `/modules` census). Persisted verbatim in
 * `service_registry.endpoints.events`; validated at enrollment like
 * `endpoints.nav` so malformed declarations never reach the registry.
 *
 * Subject grammar (NATS): dot-separated non-empty segments; `*` is a
 * single-token wildcard, `>` is a terminal multi-token wildcard only.
 * No spaces, no empty segments, `.`/leading/trailing dots rejected.
 */

const SEGMENT = /^[a-z0-9_-]+$/i;

function validateSubject(subject: unknown, path: string): string | null {
  if (typeof subject !== "string" || subject.length === 0) {
    return `${path}: every subject must be a non-empty string`;
  }
  if (/\s/.test(subject)) return `${path}: subject "${subject}" contains whitespace`;
  const segs = subject.split(".");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "") return `${path}: subject "${subject}" has an empty segment`;
    if (s === ">") {
      if (i !== segs.length - 1) {
        return `${path}: ">" wildcard must be the LAST segment ("${subject}")`;
      }
      continue;
    }
    if (s === "*") continue;
    if (!SEGMENT.test(s)) {
      return `${path}: subject "${subject}" has invalid segment "${s}"`;
    }
  }
  return null;
}

/**
 * Validate an `endpoints.events` declaration — returns an error string or
 * `null` when valid (same contract as `validateNavDeclaration`, enforced
 * at `service.register` enrollment).
 */
const I18N_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i;
const EMIT_KEYS = new Set(["subject", "label_key", "description_key"]);

export function validateEventsDeclaration(code: string, decl: unknown): string | null {
  if (decl === undefined || decl === null) return null; // optional axis
  if (typeof decl !== "object" || Array.isArray(decl)) {
    return `endpoints.events must be an object {emits?} (service "${code}")`;
  }
  const d = decl as Record<string, unknown>;
  if (d["emits"] !== undefined) {
    if (!Array.isArray(d["emits"])) {
      return `endpoints.events.emits must be an array of {subject, label_key?, description_key?} (service "${code}")`;
    }
    const seen = new Set<string>();
    for (const e of d["emits"] as unknown[]) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        return `endpoints.events.emits: every entry must be {subject, label_key?, description_key?} (service "${code}")`;
      }
      const emit = e as Record<string, unknown>;
      const err = validateSubject(emit["subject"], `endpoints.events.emits`);
      if (err) return `${err} (service "${code}")`;
      const subject = emit["subject"] as string;
      if (seen.has(subject)) {
        return `endpoints.events.emits: duplicate subject "${subject}" (service "${code}")`;
      }
      seen.add(subject);
      for (const k of ["label_key", "description_key"] as const) {
        const v = emit[k];
        if (v !== undefined && (typeof v !== "string" || !I18N_KEY.test(v))) {
          return `endpoints.events.emits: ${k} for "${subject}" must be an i18n key (service "${code}")`;
        }
      }
      const unknownEmit = Object.keys(emit).filter((k) => !EMIT_KEYS.has(k));
      if (unknownEmit.length > 0) {
        return `endpoints.events.emits["${subject}"]: unknown key(s) ${unknownEmit.join(", ")} (service "${code}")`;
      }
    }
  }
  const unknown = Object.keys(d).filter((k) => k !== "emits");
  if (unknown.length > 0) {
    return `endpoints.events: unknown key(s) ${unknown.join(", ")} (service "${code}")`;
  }
  return null;
}

/**
 * `endpoints.callables` declaration + enrollment validator.
 *
 * Mirror axis of `endpoints.events`: `emits` lists the subjects a service
 * PUBLISHES; `callables` lists the subjects it LISTENS to and is willing to
 * serve as a work destination (schedulers, rules, external callers). The
 * list is auto-collected from `makeNatsRoutes`/`makeNatsRequestRoute` route
 * declarations carrying `payload_schema` — the schema IS the listing opt-in:
 * a callable without a payload contract is not mappable and never listed.
 * Services declare their own domain subjects only — nothing about this axis
 * knows scheduling exists.
 *
 * Persisted verbatim in `service_registry.endpoints.callables`; validated at
 * enrollment like `endpoints.events` so malformed declarations never reach
 * the registry.
 */

import type { CallableDecl } from "@primebrick/core";
import {
  PAYLOAD_INJECTORS,
  PAYLOAD_OPTIONS_VALUES_SOURCES,
  PAYLOAD_SEMANTIC_SLOTS,
  PAYLOAD_X_INJECT,
  PAYLOAD_X_MAP_KEYS,
  PAYLOAD_X_NOT_EDITABLE,
  PAYLOAD_X_OPTIONS,
  PAYLOAD_X_SEMANTIC,
  schemaHonestyIssue,
  walkSchemaProps,
} from "@primebrick/core";
export type { CallableDecl };

const SEGMENT = /^[a-z0-9_-]+$/i;
const I18N_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i;
const CALLABLE_KEYS = new Set([
  "subject",
  "kind",
  "permissions",
  "payload_schema",
  "label_key",
  "description_key",
]);

/**
 * Validate the `x_*` annotation vocabulary AND the name-vs-format honesty
 * of a `payload_schema` — closed registries, fail-closed: an unknown
 * injector/semantic/options shape or a dishonest `type:"string"` on a
 * `*_at`/`*_by`/email/phone/url/uuid/locale-named field is a declaration
 * bug and never reaches the registry. Shared by `endpoints.callables`
 * AND `endpoints.events` — one deep gate, `at` carries the mount point.
 */
export function validatePayloadSchemaDeep(at: string, schema: Record<string, unknown>, code: string): string | null {
  const props = schema["properties"];
  if (props === undefined) return null;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return `${at}: payload_schema.properties must be an object (service "${code}")`;
  }
  for (const { field, path, prop: p, required: isRequired } of walkSchemaProps(schema)) {
    const propPath = `${at}.properties.${path.replace(/\./g, ".properties.")}`;

    // A required field the form cannot render MUST declare how its value
    // arrives — otherwise the form can never submit. Fail at declaration.
    if (
      isRequired &&
      p[PAYLOAD_X_NOT_EDITABLE] === true &&
      p[PAYLOAD_X_INJECT] === undefined &&
      p[PAYLOAD_X_SEMANTIC] === undefined
    ) {
      return `${propPath}: required + x_not_editable needs x_inject or x_semantic (service "${code}")`;
    }

    // Honesty: a semantic name (`*_at`, `*email*`, `preferred_locale`…)
    // on a string leaf must carry the format the name promises.
    const honest = schemaHonestyIssue(field, p);
    if (honest) return `${propPath}: ${honest} (service "${code}")`;

    if (p[PAYLOAD_X_INJECT] !== undefined) {
      const v = p[PAYLOAD_X_INJECT];
      if (typeof v !== "string" || !(PAYLOAD_INJECTORS as readonly string[]).includes(v)) {
        return `${propPath}: x_inject must be one of ${PAYLOAD_INJECTORS.join("|")} (service "${code}")`;
      }
    }
    if (p[PAYLOAD_X_NOT_EDITABLE] !== undefined && typeof p[PAYLOAD_X_NOT_EDITABLE] !== "boolean") {
      return `${propPath}: x_not_editable must be a boolean (service "${code}")`;
    }
    if (p[PAYLOAD_X_SEMANTIC] !== undefined) {
      const v = p[PAYLOAD_X_SEMANTIC];
      if (typeof v !== "string" || !(PAYLOAD_SEMANTIC_SLOTS as readonly string[]).includes(v)) {
        return `${propPath}: x_semantic must be one of ${PAYLOAD_SEMANTIC_SLOTS.join("|")} (service "${code}")`;
      }
    }
    if (p[PAYLOAD_X_OPTIONS] !== undefined) {
      const o = p[PAYLOAD_X_OPTIONS];
      if (typeof o !== "object" || o === null || Array.isArray(o)) {
        return `${propPath}: x_options must be an object (service "${code}")`;
      }
      const opt = o as Record<string, unknown>;
      const hasApi = typeof opt["api_url"] === "string" && opt["api_url"];
      const hasSource = typeof opt["values_source"] === "string" && opt["values_source"];
      if (!hasApi && !hasSource) {
        return `${propPath}: x_options needs api_url or values_source (service "${code}")`;
      }
      if (hasApi) {
        // Catalog sources declare verb+fields explicitly — no silent
        // "GET"/"value"/"label" defaults in resolvers.
        for (const k of ["api_verb", "value_field", "label_field"] as const) {
          if (typeof opt[k] !== "string" || !opt[k]) {
            return `${propPath}: x_options.${k} is required with api_url (service "${code}")`;
          }
        }
      }
      if (hasSource && !(PAYLOAD_OPTIONS_VALUES_SOURCES as readonly string[]).includes(opt["values_source"] as string)) {
        return `${propPath}: x_options.values_source must be one of ${PAYLOAD_OPTIONS_VALUES_SOURCES.join("|")} (service "${code}")`;
      }
      // Presentation hints — resolvers map them onto `_icon`/`_icon_color`/
      // `_icon_dashed` (the ComboSelect icon contract); declared per source,
      // applied to every resolved option.
      for (const k of ["icon", "icon_color"] as const) {
        if (opt[k] !== undefined && (typeof opt[k] !== "string" || !opt[k])) {
          return `${propPath}: x_options.${k} must be a non-empty string (service "${code}")`;
        }
      }
      if (opt["icon_dashed"] !== undefined && typeof opt["icon_dashed"] !== "boolean") {
        return `${propPath}: x_options.icon_dashed must be a boolean (service "${code}")`;
      }
      const unknownOpt = Object.keys(opt).filter(
        (k) => !["api_url", "api_verb", "value_field", "label_field", "values_source", "icon", "icon_color", "icon_dashed"].includes(k),
      );
      if (unknownOpt.length > 0) {
        return `${propPath}: x_options unknown key(s) ${unknownOpt.join(", ")} (service "${code}")`;
      }
    }
    if (p[PAYLOAD_X_MAP_KEYS] !== undefined) {
      const m = p[PAYLOAD_X_MAP_KEYS];
      if (
        typeof m !== "object" ||
        m === null ||
        Array.isArray(m) ||
        typeof (m as Record<string, unknown>)["from"] !== "string" ||
        typeof (m as Record<string, unknown>)["prop"] !== "string"
      ) {
        return `${propPath}: x_map_keys must be {from: string, prop: string} (service "${code}")`;
      }
    }
  }
  return null;
}

function validateCallableSubject(subject: unknown): string | null {
  if (typeof subject !== "string" || subject.length === 0) {
    return "every subject must be a non-empty string";
  }
  if (/\s/.test(subject)) return `subject "${subject}" contains whitespace`;
  const segs = subject.split(".");
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s === "") return `subject "${subject}" has an empty segment`;
    if (s === ">" || s === "*") {
      return `subject "${subject}": wildcards are not callable — destinations are concrete`;
    }
    if (!SEGMENT.test(s)) {
      return `subject "${subject}" has invalid segment "${s}"`;
    }
  }
  return null;
}

/**
 * Validate an `endpoints.callables` declaration — returns an error string or
 * `null` when valid (same contract as `validateEventsDeclaration`, enforced
 * at `service.register` enrollment).
 */
export function validateCallablesDeclaration(code: string, decl: unknown): string | null {
  if (decl === undefined || decl === null) return null; // optional axis
  if (typeof decl !== "object" || Array.isArray(decl)) {
    return `endpoints.callables must be an object {callables?} (service "${code}")`;
  }
  const d = decl as Record<string, unknown>;
  if (d["callables"] !== undefined) {
    if (!Array.isArray(d["callables"])) {
      return `endpoints.callables.callables must be an array of CallableDecl (service "${code}")`;
    }
    const seen = new Set<string>();
    for (const c of d["callables"] as unknown[]) {
      if (typeof c !== "object" || c === null || Array.isArray(c)) {
        return `endpoints.callables.callables: every entry must be a CallableDecl (service "${code}")`;
      }
      const callable = c as Record<string, unknown>;
      const err = validateCallableSubject(callable["subject"]);
      if (err) return `endpoints.callables.callables: ${err} (service "${code}")`;
      const subject = callable["subject"] as string;
      if (seen.has(subject)) {
        return `endpoints.callables.callables: duplicate subject "${subject}" (service "${code}")`;
      }
      seen.add(subject);
      if (callable["kind"] !== "pub" && callable["kind"] !== "request") {
        return `endpoints.callables.callables["${subject}"]: kind must be "pub" or "request" (service "${code}")`;
      }
      const schema = callable["payload_schema"];
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
        return `endpoints.callables.callables["${subject}"]: payload_schema is REQUIRED and must be an object (service "${code}")`;
      }
      const annErr = validatePayloadSchemaDeep(`endpoints.callables.callables["${subject}"]`, schema as Record<string, unknown>, code);
      if (annErr) return annErr;
      const perms = callable["permissions"];
      if (perms !== undefined && (!Array.isArray(perms) || perms.some((p) => typeof p !== "string"))) {
        return `endpoints.callables.callables["${subject}"]: permissions must be string[] (service "${code}")`;
      }
      for (const k of ["label_key", "description_key"] as const) {
        const v = callable[k];
        if (v !== undefined && (typeof v !== "string" || !I18N_KEY.test(v))) {
          return `endpoints.callables.callables["${subject}"]: ${k} must be an i18n key (service "${code}")`;
        }
      }
      const unknown = Object.keys(callable).filter((k) => !CALLABLE_KEYS.has(k));
      if (unknown.length > 0) {
        return `endpoints.callables.callables["${subject}"]: unknown key(s) ${unknown.join(", ")} (service "${code}")`;
      }
    }
  }
  const unknown = Object.keys(d).filter((k) => k !== "callables");
  if (unknown.length > 0) {
    return `endpoints.callables: unknown key(s) ${unknown.join(", ")} (service "${code}")`;
  }
  return null;
}

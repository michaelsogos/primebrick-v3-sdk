/**
 * Per-type capability matrix — the single source of truth for
 * "which type_config options apply to this ConfigType?".
 *
 * Design-time data (NOT persisted to DB): the vocabulary mirrors the rules
 * already enforced by `config-validator.ts` and drives:
 * - the FE right-column form (validation rules + widget sections)
 * - the Smart JSON config assistant (type-aware topics + pruned schema)
 *
 * `config-validator.ts` imports the family constants from this file so the
 * validation logic and the capability matrix can never drift apart.
 *
 * The BE exposes `TYPE_CAPABILITIES` via `GET /entities/config_entry/meta`
 * so browser clients (which cannot import this Node.js package) receive the
 * same contract at runtime.
 */
import type { ConfigType } from "./iconfig-entity.js";

/**
 * String-derived types — min/max mean LENGTH, regex rules apply.
 * Mirrors the `isStringDerived` check in `config-validator.ts`.
 */
export const STRING_DERIVED_TYPES = [
  "string",
  "text",
  "secret",
  "url",
  "email",
  "phone",
] as const satisfies readonly ConfigType[];

/**
 * Numeric types — min/max mean VALUE, `unsigned` flag applies.
 * Mirrors the numeric checks in `config-validator.ts`.
 */
export const NUMERIC_TYPES = [
  "bigint",
  "number",
  "money",
] as const satisfies readonly ConfigType[];

/** Whether min/max bounds are expressed as string length or numeric value. */
export type BoundsKind = "length" | "value";

/** Widget-level type_config capabilities (top-level type_config props). */
export type WidgetCapability =
  | "currency"       // type_config.currency + allowed_currencies (ISO 4217)
  | "country"        // type_config.country + allowed_countries (ISO 3166-1 alpha-2)
  | "badge_values"   // type_config.values — inline badge options
  | "select_source"  // type_config.api_url / values_source — select options source
  | "url_protocols"; // type_config.allowed_protocols + default_protocol

/** Validation-level capabilities (props under `type_config.validation`). */
export interface ValidationCapabilities {
  /** `validation.required` toggle — shown for every type. */
  required: boolean;
  /** `validation.unsigned` — numeric types only. */
  unsigned: boolean;
  /** `validation.rules.min` — 'length' for string-derived, 'value' for numeric, absent otherwise. */
  min?: BoundsKind;
  /** `validation.rules.max` — same semantics as `min`. */
  max?: BoundsKind;
  /** `validation.rules.regex` — string-derived types only. */
  regex: boolean;
}

/** Full capability record for one ConfigType. */
export interface TypeCapabilities {
  validation: ValidationCapabilities;
  /** Present widget-level type_config props for this type. */
  widget: Partial<Record<WidgetCapability, true>>;
}

const ALL_TYPES: ConfigType[] = [
  "string", "text", "boolean", "bigint", "number", "money", "badge",
  "single_select", "multi_select", "url", "secret", "json", "date",
  "datetime", "time", "email", "phone",
];

function buildCapabilities(): Record<ConfigType, TypeCapabilities> {
  const entries = {} as Record<ConfigType, TypeCapabilities>;
  for (const type of ALL_TYPES) {
    const isStringDerived = (STRING_DERIVED_TYPES as readonly ConfigType[]).includes(type);
    const isNumeric = (NUMERIC_TYPES as readonly ConfigType[]).includes(type);
    const widget: Partial<Record<WidgetCapability, true>> = {};
    if (type === "money") widget.currency = true;
    if (type === "phone") widget.country = true;
    if (type === "badge") widget.badge_values = true;
    if (type === "single_select" || type === "multi_select") widget.select_source = true;
    if (type === "url") widget.url_protocols = true;
    entries[type] = {
      validation: {
        required: true,
        unsigned: isNumeric,
        min: isNumeric ? "value" : isStringDerived ? "length" : undefined,
        max: isNumeric ? "value" : isStringDerived ? "length" : undefined,
        regex: isStringDerived,
      },
      widget,
    };
  }
  return entries;
}

/**
 * Capability matrix keyed by ConfigType. Frozen at module init — treat as
 * immutable. Example: `TYPE_CAPABILITIES.string.validation.min === "length"`.
 */
export const TYPE_CAPABILITIES: Record<ConfigType, TypeCapabilities> = Object.freeze(
  buildCapabilities(),
);

/** Accessor — returns the capability record for a type. */
export function typeCapabilities(type: ConfigType): TypeCapabilities {
  return TYPE_CAPABILITIES[type];
}

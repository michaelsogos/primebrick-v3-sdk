/**
 * entity-export — ONE entity-wide export pipeline.
 *
 * `streamEntityExport` owns everything that used to be hand-copied into each
 * entity's `exportXxx(query, res)` service method: response headers, file
 * naming, template selection, and — crucially — the `ExportConfig`, which is
 * DERIVED from entity meta instead of hand-listed:
 *
 *   - `fieldMapping`   → identity map over the export columns
 *   - `translations`   → `col_<key>` labels resolved from each column's
 *                        `label_key` via `dictResolver` (module-owned
 *                        translations, locale-aware)
 *   - `metadata.fields`→ export type derived from the meta column `type`,
 *                        with `datetime_iana_toggle` → `date` + `timezoneField`
 *   - `entity` labels  → `<entities_ns>.entities.<entity>.{singular,plural}` keys
 *   - `data`           → `service.stream(query)` — the SAME filter builder
 *                        as `list` (no third copy)
 *
 * Default export column set: every meta column EXCEPT audit-actor columns
 * (`*_by`), `version`, `deleted_at`, and columns that are the target of a
 * `datetime_iana_toggle.record_iana_field` (timezone helper fields). An
 * entity can override via `columns`.
 *
 * Templates resolve by convention: `templates/<entity>_export_template.<ext>`
 * under the SERVICE working directory (cwd = service root at runtime), each
 * overridable per entity via `templates`.
 */

import path from "node:path";
import type { ServerResponse } from "node:http";
import type { EntityMeta, MetaColumn } from "@primebrick/core";

import { exportDataWithTemplateToStream } from "../export/index.js";
import type { ExportConfig, ExportFieldMetadata, ExportFileType } from "../export/types.js";

export interface EntityExportQuery {
  file_type: ExportFileType;
  locale?: string;
  timezone?: string;
  [key: string]: unknown;
}

export interface EntityExportConfig {
  /** Explicit export column allowlist (order preserved). Default: derived
   *  from meta (see header comment). */
  columns?: string[];
  /** Template overrides — default `<cwd>/templates/<entity>_export_template.<ext>`. */
  templates?: { xlsx?: string; html?: string };
  /** Entity display labels — default: resolved from
   *  `<entities_ns>.entities.<entity>.{singular,plural}` translation keys. */
  entityLabels?: { singular: string; plural: string };
  /** Locale-aware dictionary resolver — the service wires its own
   *  `TranslationsService` (module-qualified table) here. Return `null`
   *  for "no dictionary" (labels fall back to humanized keys). */
  dictResolver?: (locale: string) => Promise<Record<string, string> | null>;
}

const NEVER_EXPORTED = new Set(["version", "deleted_at", "created_by", "updated_by", "deleted_by"]);

/** Columns that exist only to carry a record-level IANA timezone for a
 *  `datetime_iana_toggle` column — helper data, never a visible export column. */
export function ianaHelperFields(meta: EntityMeta): Set<string> {
  const s = new Set<string>();
  for (const c of meta.columns) {
    const f = (c as { datetime_iana_toggle?: { record_iana_field?: string } }).datetime_iana_toggle?.record_iana_field;
    if (f) s.add(f);
  }
  return s;
}

export function defaultExportColumns(meta: EntityMeta): MetaColumn[] {
  const helpers = ianaHelperFields(meta);
  return [...meta.columns]
    .filter((c) => !NEVER_EXPORTED.has(c.key) && !helpers.has(c.key))
    .sort((a, b) => a.order - b.order);
}

export function exportFieldMetadata(col: MetaColumn): ExportFieldMetadata {
  const tzField = (col as { datetime_iana_toggle?: { record_iana_field?: string } })
    .datetime_iana_toggle?.record_iana_field;
  switch (col.type) {
    case "datetime":
      return tzField
        ? { type: "date", timezoneField: tzField }
        : { type: "datetime", precision: "seconds" };
    case "number":
      return { type: "number" };
    default:
      return { type: "string" };
  }
}

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function streamEntityExport(
  opts: {
    entityName: string;
    meta: EntityMeta;
    /** `service.stream` — same query/filter contract as `list`. */
    stream: (query: EntityExportQuery) => AsyncIterable<Record<string, unknown>>;
    export?: EntityExportConfig;
  },
  query: EntityExportQuery,
  res: ServerResponse,
): Promise<void> {
  const { entityName, meta, stream } = opts;
  const cfg = opts.export ?? {};
  const { file_type } = query;
  const locale = query.locale || "en-GB";

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${entityName}-export-${timestamp}.${file_type}`;
  const contentType =
    file_type === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : file_type === "html"
        ? "text/html"
        : "text/csv";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  // --- meta-derived column set ---------------------------------------------
  const cols = cfg.columns
    ? meta.columns.filter((c) => cfg.columns!.includes(c.key))
        .sort((a, b) => cfg.columns!.indexOf(a.key) - cfg.columns!.indexOf(b.key))
    : defaultExportColumns(meta);

  // --- label resolution via the injected dictionary resolver ----------------
  const dict = (await cfg.dictResolver?.(locale).catch(() => null)) ?? {};

  const translations: Record<string, string> = {};
  const fieldMapping: Record<string, string> = {};
  const fields: Record<string, ExportFieldMetadata> = {};
  for (const c of cols) {
    fieldMapping[c.key] = c.key;
    fields[c.key] = exportFieldMetadata(c);
    translations[`col_${c.key}`] = dict[c.label_key] ?? humanize(c.key);
  }

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  // Entity-label keys live in the owning module's namespace (`crm` →
  // `crm.entities.<entity>.*`); `entities_ns` declares it on the meta.
  const ens = meta.entities_ns ?? "system";
  const entityLabels = cfg.entityLabels ?? {
    singular: cap(dict[`${ens}.entities.${entityName}.singular`] ?? humanize(entityName)),
    plural: cap(dict[`${ens}.entities.${entityName}.plural`] ?? `${humanize(entityName)}s`),
  };

  const config: ExportConfig = {
    locale,
    defaultTimezone: query.timezone || "Europe/Rome",
    entity: entityLabels,
    translations,
    fieldMapping,
    metadata: { fields },
    data: stream(query),
  };

  const templatePath =
    file_type === "html"
      ? (cfg.templates?.html ?? path.join(process.cwd(), "templates", `${entityName}_export_template.html`))
      : (cfg.templates?.xlsx ?? path.join(process.cwd(), "templates", `${entityName}_export_template.xlsx`));

  await exportDataWithTemplateToStream(templatePath, res, file_type, config);
}

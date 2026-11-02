/**
 * docs-gen — the prose renderer.
 *
 * A pure function over normalized facts: declared census routes + sheets,
 * evaluated entity context (meta + caps), merged translation dicts and the
 * extracted source facts. Emits one `.mdx` per documentable route/sheet
 * into `out_dir`, auto-deletes stale generated files (pipeline-owned dir —
 * a file not re-emitted this run is a ghost), and reports coverage so no
 * declared route loses its doc silently.
 *
 * The route universe is the DECLARED census — never an arbitrary directory
 * scan: entity/kind come from the declaration, not from endpoint-path
 * inference. Catch-all segments are rejected upstream (collectDocRoutes).
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type {
  DocRoute,
  DocSheet,
  EntityCaps,
  ExtractedField,
  SveltePageFacts,
} from "./types.js";
import type { CensusOption, ScannedRoute } from "./collect.js";
import { routeOp, scanRoutes } from "./collect.js";
import { extJsonStringify } from "../json/ext-json.js";

export interface RenderContext {
  /** Owning service/module code (report tags). */
  service_code: string;
  /** Declared routes (collectDocRoutes output + host statics merged). */
  routes: DocRoute[];
  /** Declared sheets. */
  sheets: DocSheet[];
  /** entity → served meta. */
  meta_by_entity: Record<string, Record<string, unknown>>;
  /** entity → caps (perms resolved, stepUp, duplicate, auditable). */
  caps_by_entity: Record<string, EntityCaps>;
  /** BE fallback — extra-scanned routes (empty for us services). */
  extra_routes?: ScannedRoute[];
  /** Permission enum values for the `<entity>.<op>` guess path. */
  perm_values?: Record<string, string>;
  /** Merged translation dict — own schema first (the T() source). */
  translations: Record<string, string>;
  /** Census option vocabularies for `options_source` fields. */
  census_options?: { emits: CensusOption[]; callables: CensusOption[] };
  /**
   * Entity names declared by OTHER services' nav/census — the ownership
   * boundary. A route declaring a foreign entity is skipped (its doc is
   * the owning service's job); an entity merely lacking local meta/caps
   * is still local (e.g. BE's own service_registry surface).
   */
  foreign_entities?: string[];
  /** Identity-provider display name (config-derived). */
  idp_name?: string;
  /** Access namespace of the module — nav.access (e.g. `access.system.job`). */
  access_namespace?: string;
  /** Output directory — pipeline-owned; ghosts are deleted. */
  out_dir: string;
  /**
   * `.mdx` filenames in `out_dir` that other generators own (reference
   * docs emitted into the same `generated/` dir — e.g. BE's
   * entity-api-catalog). Everything else not re-emitted this run is a
   * ghost and is deleted.
   */
  keep_files?: string[];
  /** Cross-doc link base for generated pages. */
  generated_base?: string;
  /** Cross-doc link base for hand-written dev-guide pages. */
  dev_guide_base?: string;
}

export interface RenderReport {
  emitted: string[];
  skipped: { route: string; reason: string }[];
  ghosts_deleted: string[];
}

// ── pure helpers (ported verbatim from the legacy renderer) ─────────────

const humanize = (s: string) =>
  s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
const art = (w: string) =>
  /^(u[sn]|eu|uni|use|user|one)/i.test(w) ? "a" : /^[aeiou]/i.test(w) ? "an" : "a";
const titleOf = (r: string) =>
  humanize(r.split("/").filter(Boolean).pop() ?? r).replace(/\b\w/g, (c) => c.toUpperCase());
const stripIdp = (s: string) => s.replace(/^idp/i, "");

const HANDWRITTEN_SLUGS = new Set(["entities-crud"]);

type MetaColumn = Record<string, unknown> & { key: string };
const columnsOf = (meta?: Record<string, unknown>): MetaColumn[] => {
  const c = meta?.columns;
  if (Array.isArray(c)) return c as MetaColumn[];
  if (c && typeof c === "object") return Object.values(c) as MetaColumn[];
  return [];
};

function constraintText(c: string[]): string {
  const parts: string[] = [];
  for (const x of c) {
    const m = x.match(/^(\w+)\(([^)]*)/); if (!m) continue;
    const [, fn, arg] = m;
    if (fn === "min") parts.push(`min ${arg.match(/\d+/)?.[0]}`);
    else if (fn === "max") parts.push(`max ${arg.match(/\d+/)?.[0]}`);
    else if (fn === "email") parts.push("must be a valid email");
    else if (fn === "url") parts.push("must be a valid URL");
    else if (fn === "regex") parts.push(arg.includes("0-9A-Fa-f") ? "hex color" : "custom format");
  }
  return parts.join("; ");
}

function constraintClause(c: string[], wt: string | undefined): string {
  const parts: string[] = [];
  const pick = /select|checkbox|button/i.test(wt ?? "");
  for (const x of c) {
    const m = x.match(/^(\w+)\(([^)]*)/); if (!m) continue;
    const [, fn, arg] = m;
    const n = arg.match(/\d+/)?.[0];
    if (fn === "min") parts.push(pick
      ? `requires at least ${n} ${n === "1" ? "selection" : "selections"}`
      : `requires at least ${n} ${n === "1" ? "character" : "characters"}`);
    else if (fn === "max") parts.push(`allows up to ${n} characters`);
    else if (fn === "email") parts.push("must be a valid email");
    else if (fn === "url") parts.push("must be a valid URL");
    else if (fn === "regex") parts.push(arg.includes("0-9A-Fa-f") ? "must be a hex color" : "must match a custom format");
  }
  return parts.join(" and ");
}

const RELATED: Record<string, string> = {
  idp_org: "organizations", organization: "organizations",
  roles: "roles", selected_permissions: "roles", permissions: "roles",
};

const STANDARD_OPS = [
  "list", "meta", "get", "create.single", "update.single", "delete.single",
  "purge.single", "restore.single", "read.audit", "export",
  "delete.bulk", "restore.bulk", "duplicate.bulk",
];
const CFG_TO_OP: Record<string, string> = {
  list: "list", meta: "meta", get: "get", create: "create.single",
  update: "update.single", delete: "delete.single", purge: "purge.single",
  restore: "restore.single", audit: "read.audit", export: "export",
  bulkDelete: "delete.bulk", bulkRestore: "restore.bulk", duplicate: "duplicate.bulk",
};
const SINGULAR: Record<string, string> = {
  users: "user", organizations: "organization", roles: "role",
};

/** Meta `format` → constraint prose (authored formats are the semantic layer). */
const FORMAT_PROSE: Record<string, string> = {
  "nats-subject": "must be a valid NATS subject",
  "schedule": "must be a schedule expression such as `@every 5m` or `immediate`",
  "cron": "must be a valid schedule expression",
  "email": "must be a valid email",
  "url": "must be a valid URL",
  "uuid": "must be a valid UUID",
  "json": "holds structured JSON",
};

/** Declared widget keys → control prose (host widget registry vocabulary). */
const WIDGET_PROSE: Record<string, string> = {
  payload_map: "interactive payload-map builder",
  json_editor: "JSON editor with schema assistance",
  password: "password input",
  combo: "select",
  select: "select",
  checkbox: "checkbox",
  textarea: "multi-line text input",
  date: "date picker",
  text: "text input",
};

// ── the renderer ────────────────────────────────────────────────────────

export function generatePageDocs(ctx: RenderContext): RenderReport {
  const T = (key?: string) => (key ? ctx.translations[key] : undefined);
  const IDP_NAME = ctx.idp_name;
  const extra_routes = ctx.extra_routes ?? [];
  const permValues = ctx.perm_values ?? {};
  const linkFor = (slug: string) =>
    HANDWRITTEN_SLUGS.has(slug)
      ? `${ctx.dev_guide_base ?? "/docs/dev-guide"}/${slug}`
      : `${ctx.generated_base ?? "/docs/user-guide/generated"}/${slug}`;

  const entPlural = (e?: string) => humanize(e ?? "") + (humanize(e ?? "").endsWith("s") ? "" : "s");
  const entSingular = (e: string | undefined, routeLeaf: string | undefined) =>
    (routeLeaf ? SINGULAR[routeLeaf] : undefined) ?? humanize(e ?? routeLeaf ?? "").replace(/s$/, "");

  // routes keyed by path — the doc universe (declared census + statics)
  const routes = new Map<string, DocRoute>();
  for (const r of ctx.routes) routes.set(r.route, r);
  const allFacts = (r: DocRoute) => r.facts ?? emptyFacts(r.route);

  function bestKey(name: string, keys: string[], suffixRe: RegExp): string | undefined {
    const norm = name.toLowerCase().replace(/_/g, "");
    return keys.filter((k) => !suffixRe.test(k)).find((k) => {
      const last = stripIdp((k.split(".").pop() ?? "").toLowerCase());
      return last === norm || last === norm.replace(/^idp/, "") || norm === last.replace(/^idp/, "");
    });
  }
  const fieldLabel = (name: string, keys: string[]) => {
    const k = bestKey(name, keys, /placeholder|tooltip/i);
    return k ? (T(k) ?? humanize(k.split(".").pop() ?? k)) : humanize(name).replace(/^idp /i, "");
  };
  const fieldTooltip = (name: string, keys: string[]) => {
    const norm = name.toLowerCase().replace(/_/g, "");
    const tip = keys.find((k) => /tooltip$/i.test(k) && norm.includes(stripIdp((k.split(".").pop() ?? "").toLowerCase().replace(/tooltip$/, ""))));
    return tip ? T(tip) : undefined;
  };

  const widgetType = (facts: SveltePageFacts, field: string): string | undefined => {
    const map: Record<string, string> = {
      TextInput: "text input", ComboSelect: "select", AsyncValidatedInput: "validated input",
      Checkbox: "checkbox", PasswordInput: "password input", Select: "select",
    };
    const pretty = (t?: string) => map[t ?? ""] ?? (t?.includes("Password") ? "password input" : t?.replace(/([A-Z])/g, " $1").toLowerCase().trim());
    const direct = facts.widgets.find((w) =>
      w.attrs.id === field || w.attrs["bind:value"] === field || w.attrs["bind:checked"] === field);
    if (direct) return pretty(direct.tag);
    const i = facts.widgets.findIndex((w) => w.tag === "FormField" && w.attrs.name === field);
    if (i === -1) return undefined;
    // the field's own widget is the first non-FormField INSIDE it — the
    // search must stop at the next FormField, never cross into it
    const stop = facts.widgets.findIndex((w, k) => k > i && w.tag === "FormField");
    const next = facts.widgets
      .slice(i + 1, stop === -1 ? undefined : stop)
      .find((w) => w.tag !== "FormField");
    return pretty(next?.tag);
  };

  // ── form-decl fields → the same ExtractedField shape the zod path emits ──
  interface FormFieldFacts extends ExtractedField {
    widget?: string;
    options_source?: "census.emits" | "census.callables";
    allow_create?: boolean;
    readonly?: boolean;
    col?: MetaColumn;
    section?: string;
  }
  function formDeclaredFields(r: DocRoute, meta?: Record<string, unknown>): [string, FormFieldFacts][] {
    const cols = columnsOf(meta);
    const out: [string, FormFieldFacts][] = [];
    for (const p of r.form?.fields ?? []) {
      const pl = p as Record<string, unknown>;
      const key = String(pl.key);
      const col = cols.find((c) => c.key === key);
      const constraints: string[] = [];
      if (typeof col?.max_length === "number") constraints.push(`max(${col.max_length})`);
      if (typeof col?.min_length === "number" && col.min_length > 0) constraints.push(`min(${col.min_length})`);
      if (typeof col?.format === "string") constraints.push(`format(${col.format})`);
      const required = typeof pl.required === "boolean"
        ? pl.required
        : col ? col.nullable === false : true;
      out.push([key, {
        type: String(col?.pg_type ?? col?.type ?? "unknown"),
        required,
        constraints,
        default: pl.default_value !== undefined ? extJsonStringify(pl.default_value) : undefined,
        widget: typeof pl.widget === "string" ? pl.widget : undefined,
        options_source: pl.options_source as FormFieldFacts["options_source"],
        allow_create: pl.allow_create === true,
        readonly: pl.readonly === true,
        col,
        section: typeof pl.section === "string" ? pl.section : undefined,
      }]);
    }
    return out;
  }

  /** Census options for an options_source — resolved subjects + labels. */
  const censusOptionsFor = (src: "census.emits" | "census.callables"): CensusOption[] =>
    src === "census.emits" ? (ctx.census_options?.emits ?? []) : (ctx.census_options?.callables ?? []);

  // ── field notes — semantic glue derived from page signals ──
  function fieldNotes(name: string, f: FormFieldFacts, facts: SveltePageFacts, isCreate: boolean): string {
    const notes: string[] = [];
    const paths = facts.endpoints.map((e) => e.path);
    switch (name) {
      case "idpUsername": case "username":
        if (paths.some((p) => p.includes("check-username")))
          notes.push("checked for availability in the selected organization while you type");
        break;
      case "password":
        if (facts.composables.includes("usePasswordPolicy"))
          notes.push("validated against the active password policy (live checklist)");
        if (facts.fields.send_invitation)
          notes.push("required unless *Send invitation* is enabled");
        break;
      case "idp_org": case "organization":
        if (paths.some((p) => p.includes("/organizations/active")))
          notes.push("only organizations backed by a real identity-provider organization are listed");
        break;
      case "roles":
        if (f.constraints.some((c) => /^min\(1\)/.test(c)))
          notes.push("at least one role is required");
        if (facts.composables.includes("useActiveRoles"))
          notes.push("administrator roles show a System Administrator badge");
        break;
      case "avatar_color":
        notes.push("shown when no avatar image is set");
        break;
      case "email":
        if (facts.fields.send_invitation) notes.push("also used for the invitation email");
        break;
    }
    if (f.options_source) {
      const opts = censusOptionsFor(f.options_source);
      const what = f.options_source === "census.emits" ? "event subjects published by the registered modules" : "callable work subjects declared by the registered modules";
      notes.push(opts.length
        ? `offers the ${what} (${opts.length} declared)`
        : `offers the ${what}`);
      if (f.allow_create === false) notes.push("only declared values can be selected");
    }
    if (f.col?.json_schema && !f.widget) notes.push("edited as structured JSON with schema assistance");
    if (f.readonly) notes.push("read-only on this page");
    return [...new Set(notes.map((n) => n.replace(/\.$/, "")))].join("; ");
  }

  // ── documentable precompute ──
  const documentable = new Map<string, boolean>();
  const skipped: { route: string; reason: string }[] = [];
  const docSlugs = new Set<string>();
  const slugFor = (route: string): string => {
    const pl = route.replace(/\/(create|\{[^}]+\})$/, "");
    const lf = pl.split("/").pop() ?? pl;
    return /\/create$/.test(route) ? lf + "-create" : /\{[^}]+\}$/.test(route) ? lf + "-edit" : lf;
  };
  const foreignSet = new Set(ctx.foreign_entities ?? []);
  for (const [route, r] of routes) {
    const declEntity = r.entity ?? r.facts?.entityDecl?.entity;
    // foreign = claimed by ANOTHER service's census — never "missing meta
    // locally" (a service's own surfaces may legitimately carry no meta)
    const foreign = !!declEntity && foreignSet.has(declEntity);
    // every DECLARED route is documentable (census is the truth); the only
    // skips are a foreign entity (ownership boundary) or an empty slug
    // (the "/" root is the app shell, never a documented page)
    const ok = !foreign && slugFor(route) !== "";
    documentable.set(route, ok);
    if (ok) docSlugs.add(slugFor(route));
    else skipped.push({ route, reason: `entity '${declEntity}' owned by another service` });
  }

  // ── cross-entity field links ──
  interface FieldLink { fromRoute: string; fname: string; relSlug: string; relListRoute?: string; relEntity?: string }
  const FIELD_LINKS: FieldLink[] = [];
  for (const [r, doc] of routes) {
    const facts = allFacts(doc);
    const fieldNames = new Set([...Object.keys(facts.fields), ...(doc.form?.fields ?? []).map((f) => String((f as Record<string, unknown>).key))]);
    for (const fname of fieldNames) {
      const relSlug = RELATED[fname];
      if (!relSlug) continue;
      const relListRoute = [...routes.keys()].find((x) => x === `/${relSlug}` || x.endsWith(`/${relSlug}`));
      const relDoc = relListRoute ? routes.get(relListRoute) : undefined;
      const relEntity = relDoc?.entity ?? relDoc?.facts?.entityDecl?.entity
        ?? relDoc?.facts?.endpoints.find((e) => e.path.includes("/entities/"))?.path.match(/entities\/(\w+)/)?.[1];
      FIELD_LINKS.push({ fromRoute: r, fname, relSlug, relListRoute, relEntity });
    }
  }
  const adminFlagOf = (relEntity?: string) =>
    columnsOf(ctx.meta_by_entity[relEntity ?? ""]).find((c) =>
      ["boolean", "badge"].includes(String(c.type)) && /admin/i.test(`${c.key} ${T(c.label_key as string) ?? ""}`));

  // ── sheet references: a page doc links the sheets it opens ──
  const sheetsByKey = new Map(ctx.sheets.map((s) => [s.key, s]));
  const sheetSlug = (key: string) => key.split(".").slice(1).join("-").replace(/([A-Z])/g, (m) => "-" + m.toLowerCase()).replace(/^-/, "");

  const emitted: string[] = [];
  const outDir = resolve(ctx.out_dir);

  function emitRoute(route: string, r: DocRoute): void {
    const facts = allFacts(r);
    const out: string[] = [];
    const parentList = route.replace(/\/(create|\{uuid\}|\{[^}]+\})$/, "");
    const entity = r.entity ?? facts.entityDecl?.entity
      ?? facts.endpoints.find((e) => e.path.includes("/entities/"))?.path.match(/entities\/(\w+)/)?.[1]
      ?? facts.endpoints.find((e) => e.method === "POST")?.path.match(/auth\/(\w+)/)?.[1];
    const meta: Record<string, unknown> | undefined =
      (entity ? ctx.meta_by_entity[entity] : undefined)
      ?? Object.values(ctx.meta_by_entity).find((m) =>
        typeof m.translation_key === "string" && m.translation_key.startsWith(entSingular(undefined, parentList.split("/").pop())));
    const isCreate = /\/create$/.test(route);
    const isEdit = /\{[^}]+\}$/.test(route);
    const hasList = facts.widgets.some((w) => w.tag === "EntityListTable" || w.tag === "EntityTablePage")
      || (r.kind === "list" && !isCreate && !isEdit);
    const routeLeaf = parentList.split("/").pop();
    const singular = entSingular(entity, routeLeaf);
    const plural = entity ? entPlural(entity) : titleOf(parentList).toLowerCase();
    const tkey = (meta?.translation_key as string | undefined) ?? entity;
    const leaf = parentList.split("/").pop() ?? "";
    const pick = (...keys: (string | undefined)[]) => keys.map((k) => T(k)).find(Boolean);
    const entPluralT = pick(`system.entities.${tkey}.plural`, `system.entities.${tkey}.title`, `${ctx.service_code}.entities.${tkey}.plural`, `${ctx.service_code}.entities.${tkey}.title`) ?? plural;
    const entSingularT = pick(`system.entities.${tkey}.singular`, `${ctx.service_code}.entities.${tkey}.singular`) ?? singular;
    const cap = (s?: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
    const interp = (tpl: string) => tpl
      .replaceAll("{entity_plural}", cap(entPluralT) ?? "")
      .replaceAll("{entity_singular}", cap(entSingularT) ?? "");
    const pageTitleTpl = (kind: string) => T(`system.entities.page_title.${kind}`) ??
      (kind === "list" ? `{entity_plural} List` : kind === "create" ? `Create {entity_singular}` : `Edit {entity_singular}`);
    const kind = isCreate ? "create" : isEdit ? "edit" : "list";
    const declaredLabel = T(r.label_key);
    const declaredDesc = T(r.description_key);
    const pageName = r.kind === "page"
      ? (declaredLabel ?? titleOf(route))
      : (declaredLabel && kind === "list" ? declaredLabel : interp(pageTitleTpl(kind)));
    const purpose = declaredDesc ?? (isCreate
      ? pick(`system.settings.${leaf}.createSubtitle`, `system.settings.${leaf}.create.subtitle`, `system.entities.${tkey}.create.description`, `${ctx.service_code}.entities.${tkey}.create.description`) ?? `Create a new ${entSingularT.toLowerCase()}.`
      : isEdit
        ? pick(`system.settings.${leaf}.editSubtitle`, `system.settings.${leaf}.update.subtitle`, `system.entities.${tkey}.update.description`, `${ctx.service_code}.entities.${tkey}.update.description`) ?? `View and edit an existing ${entSingularT.toLowerCase()}.`
        : pick(`system.settings.${leaf}.subtitle`, `system.entities.${tkey}.list.description`, `${ctx.service_code}.entities.${tkey}.list.description`) ?? `List, search and manage all ${entPluralT.toLowerCase()}.`);

    out.push("---");
    out.push(`title: ${pageName}`);
    out.push(`description: ${purpose}`);
    const docEntity = (meta?.entity as string | undefined) ?? entity;
    if (docEntity) out.push(`entity: ${docEntity}`);
    out.push("---\n");
    out.push(`${purpose}\n`);

    // remote-delivery note — the page is served by the owning module
    if (r.delivery === "remote" && r.component_url) {
      out.push(`This page is delivered by the owning module as a remote component — its content mounts inside the shared shell.\n`);
    }
    // presentation:"sheet" — standard CTAs open the same archetype in a sheet
    if (r.presentation === "sheet") {
      out.push(`Its standard actions open inside a side sheet instead of navigating away from the current page.\n`);
    }

    // discursive intro on list pages from meta columns
    const metaCols = columnsOf(meta);
    const joinAnd = (xs: string[]) => xs.length > 1 ? xs.slice(0, -1).join(", ") + ", and " + xs.at(-1) : (xs[0] ?? "");
    if (hasList && metaCols.length) {
      const visCols = metaCols.filter((c) => c.default_visible && c.type !== "boolean");
      const flagCols = metaCols.filter((c) => c.default_visible && c.type === "boolean");
      const named = visCols.map((c) => `the ${T(c.label_key as string) ?? humanize(c.key)}`);
      const flags = flagCols.map((c) => T(c.label_key as string) ?? humanize(c.key));
      if (named.length || flags.length)
        out.push(`Each row shows ${named.join(", ")}${flags.length ? `, plus the status flags ${joinAnd(flags)}` : ""}.\n`);
      if (metaCols.some((c) => /^idp_/.test(c.key)))
        out.push(`This ${entSingularT.toLowerCase()} is backed by the identity provider${IDP_NAME ? ` (${IDP_NAME})` : ""} — its identity fields are managed there.\n`);
    }

    // access note — the route is visible under its derived access key;
    // param segments never extend the leaf key (the leaf is the last
    // static segment)
    if (ctx.access_namespace) {
      const segs = route.replace(/^\//, "").split("/").filter((s) => s && !/^\{[^}]+\}$|^\[[^\]]+\]$/.test(s));
      const leafKey = segs.slice(2).join(".") || segs.at(-1) || "";
      out.push(`The page is visible with the \`${ctx.access_namespace}.${leafKey}\` grant.\n`);
    }

    // ── Pages Routes ──
    const sibs = [...routes.keys()].filter((x) => x === parentList || x.startsWith(parentList + "/"));
    if (sibs.length > 1) {
      out.push("## Pages routes\n");
      for (const x of sibs) {
        const k = /\/create$/.test(x) ? "create" : /\{[^}]+\}$/.test(x) ? "edit" : "list";
        const d = k === "create" ? `Create a new ${singular}.`
          : k === "edit" ? `View and edit an existing ${singular}.`
          : `List, search and manage all ${entPluralT.toLowerCase()}.`;
        out.push(`- \`${x}\` — ${d}${x === route ? " *(this page)*" : ""}`);
      }
      out.push("");
    }

    const wydAt = out.length;
    const capEntity2 = entity ?? (meta?.entity as string | undefined);
    const s3 = entSingularT.toLowerCase();
    const newBtn = T("system.entities.list.new") ?? "New";
    const allFieldsFor = (doc: DocRoute): [string, FormFieldFacts][] => {
      const facts2 = allFacts(doc);
      const docMeta = doc.entity ? ctx.meta_by_entity[doc.entity] : meta;
      if (doc.form?.fields?.length) return formDeclaredFields(doc, docMeta);
      return Object.entries(facts2.fields).map(([n, f]) => [n, { ...f }]);
    };
    // label resolution for a field: meta label_key first (the canonical
    // source — form-decl pages have no page-local i18n keys), then the
    // page's own keys, then humanize
    const labelOf = (name: string, f: FormFieldFacts, i18nKeys: string[]): string => {
      const fromCol = f.col?.label_key ? T(f.col.label_key as string) : undefined;
      const lbl = fieldLabel(name, i18nKeys);
      return lbl !== humanize(name).replace(/^idp /i, "") ? lbl : (fromCol ?? lbl);
    };
    const fields = allFieldsFor(r).filter(([, f]) => !(f.fromState && kind === "list"));
    const reqOf = (doc: DocRoute) => allFieldsFor(doc).filter(([, f]) => f.required)
      .map(([n, f]) => `**${labelOf(n, f, allFacts(doc).i18nKeys ?? [])}**`);

    const grantProc = (l: FieldLink, flag: MetaColumn, srcRoute: string) => {
      const flagLabel = T(flag.label_key as string) ?? humanize(flag.key);
      const srcDoc = routes.get(srcRoute);
      const fLabel = fieldLabel(l.fname, srcDoc?.facts?.i18nKeys ?? []);
      const relSing = titleOf(l.relSlug).replace(/s$/, "");
      const badge = srcDoc?.facts?.composables?.includes("useActiveRoles")
        ? "; administrator roles are marked with a **System Administrator** badge" : "";
      return {
        head: `### How to grant ${flagLabel.toLowerCase()} rights to ${art(s3)} ${s3}`,
        roleStep: `In **${fLabel}**, select a ${relSing.toLowerCase()} whose **${flagLabel}** flag is enabled${badge} — the flag is configured on the ${relSing.toLowerCase()} via **Edit ${relSing}**.`,
        saveStep: `Click **Save** — the ${s3} now has the permissions granted by the assigned ${titleOf(l.relSlug).toLowerCase()}.`,
      };
    };
    const pushGrant = (srcRoute: string, firstStep: string | null) => {
      for (const l of FIELD_LINKS.filter((x) => x.fromRoute === srcRoute && x.relEntity !== capEntity2)) {
        const flag = adminFlagOf(l.relEntity);
        if (!flag) continue;
        const g = grantProc(l, flag, srcRoute);
        out.push(g.head);
        let n = 1;
        if (firstStep) out.push(`${n++}. ${firstStep}`);
        out.push(`${n++}. ${g.roleStep}`, `${n}. ${g.saveStep}`, "");
      }
    };

    // ── What you can do here on form pages ──
    if (isCreate && fields.length) {
      const reqs = reqOf(r);
      out.push("## What you can do here\n");
      out.push(`### How to create a new ${s3}`);
      out.push(`1. On the **${titleOf(parentList)}** list page, click **${newBtn}** in the toolbar.`);
      out.push(`2. Fill in the fields below${reqs.length ? ` — required: ${reqs.join(", ")}` : ""}.`);
      out.push(`3. Click **Save** — the new ${s3} is created.`);
      out.push("");
      pushGrant(route, null);
    }
    if (isEdit) {
      const reqs = reqOf(r);
      out.push("## What you can do here\n");
      out.push(`### How to edit ${art(s3)} ${s3}`);
      out.push(`1. On the **${titleOf(parentList)}** list page, open the row actions menu on the ${s3} you want to edit and click **Edit**.`);
      out.push(`2. Update the fields below${reqs.length ? ` — required: ${reqs.join(", ")}` : ""}.`);
      out.push(`3. Click **Save** — the changes to the ${s3} are saved.`);
      out.push("");
      pushGrant(route, null);
      for (const [fname] of fields.filter(([n]) => /admin/i.test(n))) {
        const seenFlag = new Set<string>();
        for (const b of FIELD_LINKS.filter((x) => x.relEntity === capEntity2)) {
          const bLeaf = b.fromRoute.replace(/\/(create|\{[^}]+\})$/, "").split("/").pop() ?? "";
          if (bLeaf === leaf || seenFlag.has(bLeaf)) continue;
          seenFlag.add(bLeaf);
          const bSing = titleOf(bLeaf).replace(/s$/, "");
          const bFieldLabel = fieldLabel(b.fname, allFacts(routes.get(b.fromRoute) ?? r).i18nKeys ?? []);
          const ownLabel = fieldLabel(fname, facts.i18nKeys);
          out.push(`- The **${ownLabel}** flag on this ${s3} marks it as an administrator ${s3} — assign the ${s3} to ${art(bSing)} ${bSing.toLowerCase()} via **Edit ${bSing}** → **${bFieldLabel}**.`);
        }
      }
      out.push("");
      // detail-page invariants — the archetype owns them, narrate once
      if (ctx.caps_by_entity[capEntity2 ?? ""]?.auditable || metaCols.some((c) => c.audited)) {
        out.push(`The record opens in read mode first — click **Edit** to modify it. Concurrent edits are protected by optimistic locking: if someone else saves the ${s3} while you are editing it, the page tells you before overwriting their changes. The form warns before discarding unsaved changes.\n`);
      }
    }

    // ── columns table for list pages ──
    if (hasList && metaCols.length) {
      const visible = metaCols.filter((c) => !c.audited);
      out.push("## Columns\n");
      out.push("| Column | Visible | Sortable | Filterable | Notes |");
      out.push("|--------|---------|----------|------------|-------|");
      const inIdp = IDP_NAME ? `in ${IDP_NAME}` : "in the identity provider";
      const IDP_FIELD_NOTES: Record<string, string> = {
        idp_code: `the record's identifier code ${inIdp} — the link between this row and the IDP record`,
        idp_org: `the ${IDP_NAME ?? "identity-provider"} organization this row belongs to`,
        idp_username: `the login name ${inIdp}`,
        issuer: `the identity-provider issuer that owns this identity`,
      };
      const colRows = visible.map((c) => ({
        c,
        label: T(c.label_key as string) ?? humanize(c.key),
        tip: (c.tooltip ? (T(c.tooltip as string) ?? "") : "") || (IDP_FIELD_NOTES[c.key] ?? ""),
      }));
      for (const { c, label, tip } of colRows)
        out.push(`| **${label}** | ${c.default_visible ? "yes" : "no"} | ${c.sortable ? "yes" : "no"} | ${c.filterable ? "yes" : "no"} | ${tip} |`);
      out.push("");
      for (const { c, label, tip } of colRows) {
        const flags = c.sortable && c.filterable ? "can be sorted and filtered"
          : c.sortable ? "can be sorted but not filtered"
          : c.filterable ? "can be filtered but not sorted" : "cannot be sorted or filtered";
        out.push(`- The ${label} column is ${c.default_visible ? "shown" : "hidden"} by default and ${flags}${tip ? ` — ${tip.replace(/\.$/, "").replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())}` : ""}.`);
      }
      out.push("");
    }

    // ── fields table for form pages ──
    const fieldRows: { name: string; f: FormFieldFacts; label: string; wt?: string; notes: string; cons: string }[] = [];
    if (fields.length && !hasList) {
      out.push("## Fields\n");
      out.push("| Field | Required | Notes |");
      out.push("|-------|----------|-------|");
      for (const [name, f] of fields) {
        const snake = name.replace(/([A-Z])/g, (m) => "_" + m.toLowerCase());
        const col = f.col ?? metaCols.find((c) => c.key === snake || c.key === name || snake.endsWith(c.key));
        const metaTooltip = col?.tooltip ? T(col.tooltip as string) : undefined;
        const metaLabel = col?.label_key ? T(col.label_key as string) : undefined;
        const tooltip = fieldTooltip(name, facts.i18nKeys) ?? metaTooltip;
        const joinNotes = (...segs: (string | undefined)[]) =>
          segs.filter(Boolean).map((s) => (s as string).replace(/\.$/, "")).join("; ");
        const notes = joinNotes(tooltip, fieldNotes(name, f, facts, isCreate), constraintText(f.constraints));
        const wt = f.widget ? WIDGET_PROSE[f.widget] ?? humanize(f.widget) : widgetType(facts, name);
        const label = labelOf(name, { ...f, col }, facts.i18nKeys);
        const colFormat = col?.format as string | undefined;
        // `format:"json"` prose is redundant when a json_schema note already
        // narrates the structured-editor semantics — keep the richer one
        const fmtProse = colFormat && !(colFormat === "json" && col?.json_schema)
          ? FORMAT_PROSE[colFormat] : undefined;
        const fmtNotes = fmtProse && !notes.includes(fmtProse) ? [notes, fmtProse].filter(Boolean).join("; ") : notes;
        out.push(`| **${label}** | ${f.required ? "required" : "optional"} | ${[wt, fmtNotes].filter(Boolean).join(" — ") || "—"} |`);
        // digest notes: drop the raw constraintText (the `that …` clause
        // already narrates it) and strip the trailing period
        const cons = constraintClause(f.constraints, wt);
        const digestNotes = joinNotes(tooltip, fieldNotes(name, f, facts, isCreate))
          .replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()); // lowercase the lead only for real words — "JSON" stays
        fieldRows.push({ name, f, label, wt, notes: digestNotes, cons });
      }
      out.push("");
      for (const { label, f, wt, notes, cons } of fieldRows) {
        const w = wt ?? "field";
        const reqAdj = f.required ? "required" : "optional";
        out.push(`- The **${label}** field is ${art(reqAdj)} ${reqAdj} ${w}${cons ? ` that ${cons}` : ""}${notes ? ` — ${notes}` : ""}.`);
      }
      out.push("");
      // options_source enumeration — the selectable subjects with labels
      for (const { name, f, label } of fieldRows) {
        if (!f.options_source) continue;
        const opts = censusOptionsFor(f.options_source);
        if (!opts.length) continue;
        const what = f.options_source === "census.emits" ? "published event" : "callable work";
        out.push(`The **${label}** field offers these declared ${what} subjects:\n`);
        for (const o of opts) {
          const ol = o.label_key ? T(o.label_key) : undefined;
          const od = o.description_key ? T(o.description_key) : undefined;
          out.push(`- \`${o.subject}\`${ol ? ` — **${ol}**` : ""}${od ? ` — ${od.replace(/\.$/, "")}` : ""}`);
        }
        out.push("");
      }
    }

    // ── related entities ──
    const knownSlugExists = (slug: string) =>
      [...routes.keys()].some((x) => x.split("/").filter(Boolean).pop() === slug);
    {
      const rels: { slug: string; label: string }[] = [];
      for (const c of metaCols) {
        const slug = RELATED[c.key];
        if (slug && knownSlugExists(slug)) {
          const label = T(c.label_key as string) ?? humanize(c.key);
          if (!rels.some((x) => x.slug === slug)) rels.push({ slug, label });
        }
      }
      for (const [fname] of fields) {
        const slug = RELATED[fname];
        if (slug && knownSlugExists(slug) && !rels.some((x) => x.slug === slug))
          rels.push({ slug, label: fieldLabel(fname, facts.i18nKeys) });
      }
      if (rels.length) {
        out.push("## Related entities\n");
        for (const rel of rels)
          out.push(`- A **${cap(entSingularT)}** is linked to **${titleOf(rel.slug)}** through the **${rel.label[0].toUpperCase() + rel.label.slice(1)}** field — see [${titleOf(rel.slug)}](${linkFor(rel.slug)}).`);
        out.push("");
      }
    }

    // ── actions ──
    const caps = (entity ?? (meta?.entity as string | undefined)) ? ctx.caps_by_entity[entity ?? (meta?.entity as string)] : undefined;
    const capEntity = entity ?? (meta?.entity as string | undefined);
    const overrides = (meta?.actions_overrides ?? {}) as Record<string, { enabled?: boolean }>;
    const eps = facts.endpoints.map((e) => `${e.method} ${e.path}`);
    const has = (re: RegExp) => eps.some((e) => re.test(e));
    const declNavKind = facts.entityDecl?.navStrategy === "popup" ? "new-tab" : "same-tab";
    const createNav = facts.navigations.find((n) => /\/(create|new)$/.test(n.target ?? ""))
      ?? (facts.entityDecl?.createAction ? { kind: declNavKind, target: `${parentList}/create` } as const : undefined)
      ?? (sibs.some((x) => /\/create$/.test(x)) ? { kind: "same-tab" as const, target: `${parentList}/create` } : undefined);
    const editNav = facts.navigations.find((n) => /uuid|param|\{/i.test(n.target ?? ""))
      ?? (facts.entityDecl?.editAction ? { kind: declNavKind, target: `${parentList}/{uuid}` } as const : undefined)
      ?? (sibs.some((x) => /\{[^}]+\}$/.test(x)) ? { kind: "same-tab" as const, target: `${parentList}/{uuid}` } : undefined);
    const scanHit = (re: RegExp) => caps?.extraScans?.some((p) => eps.some((e) => e.includes(p) && re.test(e)));
    const scanned = scanRoutes(caps, extra_routes);
    const scanRoute = (op: string) => scanned.find((x) => routeOp(x, caps?.extraScans) === op);
    const registered: Record<string, boolean> = {
      "create.single": "create" in (caps?.perms ?? {}) || !!scanRoute("create.single") || !!scanHit(/POST/) || has(/POST/) || !!createNav,
      "update.single": "update" in (caps?.perms ?? {}) || !!scanRoute("update.single") || !!scanHit(/PUT|PATCH|UPDATE/) || has(/PUT|PATCH|UPDATE/) || !!editNav,
      "delete.single": "delete" in (caps?.perms ?? {}) || !!scanRoute("delete.single") || !!scanHit(/DELETE|REMOVE/) || has(/DELETE(?!.*purge)|REMOVE/),
      "purge.single": "purge" in (caps?.perms ?? {}) || !!scanRoute("purge.single") || !!scanHit(/purge/) || has(/purge/),
      "restore.single": "restore" in (caps?.perms ?? {}) || !!scanRoute("restore.single") || !!scanHit(/restore/) || has(/restore/),
      "read.audit": "audit" in (caps?.perms ?? {}) || !!scanRoute("read.audit") || !!scanHit(/audit/) || has(/audit/),
      export: "export" in (caps?.perms ?? {}) || !!scanRoute("export") || has(/export/),
      "delete.bulk": "bulkDelete" in (caps?.perms ?? {}) || !!scanRoute("delete.bulk") || has(/bulk-delete/),
      "restore.bulk": "bulkRestore" in (caps?.perms ?? {}) || !!scanRoute("restore.bulk") || has(/bulk-restore/),
      "duplicate.bulk": caps?.duplicate === false ? false : ("duplicate" in (caps?.perms ?? {}) || !!scanRoute("duplicate.bulk") || has(/duplicate/)),
    };
    const permValueSet = new Set(Object.values(permValues));
    const cfgKey = (op: string) => Object.keys(CFG_TO_OP).find((k) => CFG_TO_OP[k] === op);
    const permList = (op: string): string[] => {
      const v = caps?.perms?.[cfgKey(op) ?? ""];
      if (v?.length) return v;
      const x = scanRoute(op);
      if (x?.perms?.length) return x.perms;
      const guess = `${capEntity}.${op}`;
      return permValueSet.has(guess) ? [guess] : [];
    };
    const permsOf = (op: string) => { const v = permList(op); return v.length ? v.map((p) => `\`${p}\``).join(" or ") : "—"; };
    const stepUpOf = (op: string) => {
      const v = caps?.stepUp?.[cfgKey(op) ?? ""];
      if (v !== undefined) return v;
      return scanRoute(op)?.stepUp ?? false;
    };
    const status = (op: string, uiEvidence?: boolean) => {
      if (overrides[op]?.enabled === false) return "DISABLED";
      if (!registered[op]) return "DISABLED";
      return uiEvidence === false ? "DISABLED" : "ENABLED";
    };

    interface ActionRow { name: string; op: string; scope: string; st: string; desc: string; digest?: string; perms?: string[]; stepUp?: boolean; subject?: string; extra?: string | null }
    if (hasList) {
      const cta = (n?: { kind: string }) => n ? (n.kind === "new-tab" ? "opens in a new browser tab" : "opens in the same tab") : null;
      const s = entSingularT.toLowerCase();
      const pl = entPluralT.toLowerCase();
      const a = art(s);
      const GERUND: Record<string, string> = {
        "create.single": `Creating a new ${s}`,
        "update.single": `Editing ${a} ${s}`,
        "delete.single": `Soft-deleting ${a} ${s}`,
        "restore.single": `Restoring a soft-deleted ${s}`,
        "purge.single": `Permanently deleting ${a} ${s}`,
        "read.audit": `Viewing the change history of ${a} ${s}`,
        "delete.bulk": `Soft-deleting the selected ${pl}`,
        "restore.bulk": `Restoring the selected ${pl}`,
        "duplicate.bulk": `Duplicating the selected ${pl}`,
        export: `Exporting the list`,
      };
      const rows: ActionRow[] = [
        { name: "create", op: "create.single", scope: "row", st: status("create.single", !!createNav),
          desc: `creates a new ${s}`, digest: `the create action opens the create form${createNav ? ` ${cta(createNav)?.replace(/^opens /, "")}` : ""}` },
        { name: "update", op: "update.single", scope: "row", st: status("update.single", !!editNav || has(/PUT|PATCH/)),
          desc: `opens the ${s} for editing`, digest: `the row action opens the record${editNav ? ` ${cta(editNav)?.replace(/^opens /, "")}` : ""}` },
        { name: "delete", op: "delete.single", scope: "row", st: status("delete.single"),
          desc: `marks the ${s} as deleted but keeps it so it can be restored` },
        { name: "restore", op: "restore.single", scope: "row", st: status("restore.single"),
          desc: `brings a soft-deleted ${s} back` },
        { name: "purge", op: "purge.single", scope: "row", st: status("purge.single"),
          desc: `removes the ${s} forever` },
        { name: "audit history", op: "read.audit", scope: "row", st: status("read.audit"),
          desc: `shows the change history of the ${s}`, digest: `every ${s} keeps a full version history` },
        { name: "delete", op: "delete.bulk", scope: "bulk", st: status("delete.bulk"),
          desc: `marks the selected ${pl} as deleted` },
        { name: "restore", op: "restore.bulk", scope: "bulk", st: status("restore.bulk"),
          desc: `restores the selected ${pl}` },
        { name: "duplicate", op: "duplicate.bulk", scope: "bulk", st: status("duplicate.bulk"),
          desc: `duplicates the selected ${pl}` },
        { name: "export", op: "export", scope: "bulk", st: status("export"),
          desc: `exports the list` },
      ];
      const metaTable = (meta?.table ?? {}) as Record<string, unknown>;
      for (const ca of (metaTable.row_custom_actions ?? []) as Record<string, unknown>[]) {
        const bound = facts.customActions.includes(String(ca.action_name));
        const label = ca.translation_key ? (T(ca.translation_key as string) ?? humanize(String(ca.action_name))) : humanize(String(ca.action_name));
        const caDesc = ca.translation_key ? (T(`${ca.translation_key}Description`) ?? "") : "";
        const caRoute = scanned.find((x) => routeOp(x) === `custom:${String(ca.action_name).replace(/_/g, "-")}`);
        const caPerms = ca.required_permission ? [String(ca.required_permission)] : (caRoute?.perms ?? []);
        rows.splice(6, 0, {
          name: label, op: `custom:${String(ca.action_name).replace(/_/g, "-")}`, scope: "row",
          st: bound ? "ENABLED" : "DISABLED", perms: caPerms, stepUp: caRoute?.stepUp ?? false,
          desc: caDesc, subject: `The ${label} action`,
          extra: ca.disabled_when_deleted ? "it is unavailable on deleted rows" : null,
        });
      }
      const clause = (d?: string) => (d ?? "").replace(/\.\s+(\w)/g, (_m, c: string) => `; ${c.toLowerCase()}`).replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
      const digestOf = (x: ActionRow) => {
        const subj = x.subject ?? GERUND[x.op] ?? `The ${x.name} action`;
        const perms = x.perms ?? permList(x.op);
        const stepUp = x.stepUp ?? stepUpOf(x.op);
        const permTxt = perms.length ? perms.map((p) => `\`${p}\``).join(" or ") : null;
        const body = clause(x.digest ?? x.desc);
        if (x.st === "ENABLED")
          return `- ${subj} is available on this page${body ? ` — ${body}` : ""}${x.extra ? ` — ${x.extra}` : ""}${permTxt ? ` and it requires the ${permTxt} permission` : ""}${stepUp ? ", and step-up authentication is required" : ""}.`;
        const permClause = permTxt ? `if enabled, it would require the ${permTxt} permission` : `no permission is declared for it on ${pl}`;
        return `- ${subj} is not available on this page — ${permClause}.`;
      };
      const renderTable = (scope: string) => {
        out.push(`| Action | Status | Permission | What it does | Require Step-Up Auth |`);
        out.push("|--------|--------|------------|--------------|----------------------|");
        for (const x of rows.filter((x) => x.scope === scope))
          out.push(`| **${x.name}** | ${x.st} | ${x.perms?.length || permList(x.op).length ? (x.perms ?? permList(x.op)).map((p) => `\`${p}\``).join(" or ") : "—"} | ${x.desc ? x.desc[0].toUpperCase() + x.desc.slice(1) : "—"} | ${(x.stepUp ?? stepUpOf(x.op)) ? "yes" : "no"} |`);
        out.push("");
        for (const x of rows.filter((x) => x.scope === scope)) out.push(digestOf(x));
        out.push("");
      };
      out.push("## Actions\n");
      out.push("### Row actions\n");
      renderTable("row");
      out.push("### Bulk actions\n");
      renderTable("bulk");

      // ── What you can do here on list pages ──
      const wyd: string[] = [];
      const createRoute = sibs.find((x) => /\/create$/.test(x));
      const editRoute = sibs.find((x) => /\{[^}]+\}$/.test(x));
      if (createNav && createRoute) {
        const reqs = reqOf(routes.get(createRoute) ?? r);
        wyd.push(`### How to create a new ${s}`);
        wyd.push(`1. Click **${newBtn}** in the toolbar.`);
        wyd.push(`2. Fill in the form${reqs.length ? ` — required: ${reqs.join(", ")}` : " — required fields are marked"}.`);
        wyd.push(`3. Click **Save** — the new ${s} is created.`, "");
      }
      if (editNav && editRoute) {
        const reqs = reqOf(routes.get(editRoute) ?? r);
        wyd.push(`### How to edit ${art(s)} ${s}`);
        wyd.push(`1. Open the row actions menu on the ${s} and click **Edit**.`);
        wyd.push(`2. Update the fields${reqs.length ? ` — required: ${reqs.join(", ")}` : ""}.`);
        wyd.push(`3. Click **Save** — the changes to the ${s} are saved.`, "");
      }
      for (const x of rows.filter((x) => x.scope === "row" && x.st === "ENABLED")) {
        if (x.name === "create" || x.name === "update") continue;
        const stepUp = (x.stepUp ?? stepUpOf(x.op)) ? " (step-up authentication is required)" : "";
        if (x.name === "delete") {
          wyd.push(`### How to delete ${art(s)} ${s}`);
          wyd.push(`1. Open the row actions menu on the ${s} and click **Delete**${stepUp}.`);
          wyd.push(`2. Confirm the deletion in the dialog — the ${s} is soft-deleted and can be restored.`, "");
        } else if (x.name === "restore") {
          wyd.push(`### How to restore a deleted ${s}`);
          wyd.push("1. Set the deleted-records filter to **Deleted only** or **All records** to show recoverable records.");
          wyd.push(`2. Open the row actions menu on the ${s} and click **Restore**${stepUp}.`);
          wyd.push(`3. Confirm in the dialog — the ${s} is active again.`, "");
        } else if (/audit/i.test(x.name)) {
          wyd.push(`### How to view the change history of ${art(s)} ${s}`);
          wyd.push(`1. Open the row actions menu on the ${s} and click **Audit history**${stepUp}.`);
          wyd.push(`2. The version history of the ${s} will appear on the right sheet panel.`, "");
        } else if (x.op?.startsWith("custom:")) {
          const an = x.op.slice(7).replace(/-/g, "_");
          const m = an.match(/^(change|set|reset)_(.+)$/);
          const head = m ? `How to ${m[1]} the ${s}'s ${humanize(m[2]).toLowerCase()}` : x.name;
          wyd.push(`### ${head}`);
          wyd.push(`1. Open the row actions menu on the ${s} and click **${x.name}**${stepUp}.`);
          if (x.desc) wyd.push(`2. ${x.desc[0].toUpperCase() + clause(x.desc).slice(1)}.`, "");
        }
      }
      const gSeen = new Set<string>();
      for (const src of [editRoute, createRoute].filter(Boolean) as string[]) {
        for (const l of FIELD_LINKS.filter((x) => x.fromRoute === src && x.relEntity !== capEntity)) {
          const flag = adminFlagOf(l.relEntity);
          const key = `${l.relEntity}:${l.fname}`;
          if (!flag || gSeen.has(key)) continue;
          gSeen.add(key);
          const g = grantProc(l, flag, src);
          wyd.push(g.head);
          wyd.push(`1. Open the ${s} in its form (see *How to create a new ${s}* / *How to edit ${art(s)} ${s}* above).`);
          wyd.push(`2. ${g.roleStep}`, `3. ${g.saveStep}`, "");
        }
      }
      if (wyd.length) out.splice(wydAt, 0, "## What you can do here\n", ...wyd);
    } else {
      // form-page actions — Save/Cancel/customs
      const saveOp = isCreate ? "create.single" : "update.single";
      const post = facts.endpoints.find((e) => e.method === "POST" && !/restore/.test(e.path));
      const patch = facts.endpoints.find((e) => ["PUT", "PATCH", "UPDATE"].includes(e.method));
      const ep = post ?? patch;
      const s2 = entSingularT.toLowerCase();
      const verb = isCreate ? `creates the ${s2}` : `saves changes to the ${s2}`;
      const hasSubmit = facts.widgets.find((w) => /submit/i.test(String(w.attrs["data-testid"] ?? "")) || w.attrs.type === "submit")
        || isCreate || isEdit; // archetype form pages always offer Save
      const formRows: { name: string; op: string | null; st: string; desc: string }[] = [];
      if (hasSubmit || ep) formRows.push({ name: "Save", op: saveOp, st: "ENABLED", desc: `validates the form and ${verb}` });
      if (facts.i18nKeys.includes("app.common.cancel") || isCreate || isEdit)
        formRows.push({ name: "Cancel", op: null, st: "ENABLED", desc: "discards changes and returns to the previous page" });
      for (const ca of facts.customActions)
        formRows.push({ name: humanize(ca), op: `custom:${ca.replace(/_/g, "-")}`, st: "ENABLED", desc: "row action" });
      if (formRows.length) {
        out.push("## Actions\n");
        out.push("| Action | Status | Permission | What it does | Require Step-Up Auth |");
        out.push("|--------|--------|------------|--------------|----------------------|");
        for (const x of formRows)
          out.push(`| **${x.name}** | ${x.st} | ${x.op ? permsOf(x.op) : "—"} | ${x.desc[0].toUpperCase() + x.desc.slice(1)} | ${x.op ? (stepUpOf(x.op) ? "yes" : "no") : "no"} |`);
        out.push("");
        for (const x of formRows) {
          const permTxt = x.op && permList(x.op).length ? permList(x.op).map((p) => `\`${p}\``).join(" or ") : null;
          out.push(`- The **${x.name}** action ${x.st === "ENABLED" ? "is available" : "is not available"} on this page — ${x.desc}${permTxt ? ` and it requires the ${permTxt} permission` : ""}.`);
        }
        out.push("");
      }
    }

    // ── sheets this page opens ──
    const opened = (facts.sheetOpenings ?? []).filter((k) => sheetsByKey.has(k));
    if (opened.length) {
      out.push("## Related panels\n");
      for (const k of opened) {
        const s = sheetsByKey.get(k)!;
        out.push(`- [${T(s.label_key) ?? titleOf(k.split(".")[1] ?? k)} panel](${linkFor(sheetSlug(k))}) — opens in a side sheet from this page.`);
      }
      out.push("");
    }

    // ── doc references ──
    const related = new Set([leaf, `${leaf}-create`, `${leaf}-edit`].filter((s) => docSlugs.has(s)));
    const self = isCreate ? leaf + "-create" : isEdit ? leaf + "-edit" : leaf;
    for (const [fname] of fields) if (RELATED[fname]) related.add(RELATED[fname]);
    for (const c of metaCols) if (RELATED[c.key]) related.add(RELATED[c.key]);
    related.add("entities-crud");
    related.delete(self);
    out.push("## Doc references\n");
    for (const x of related) out.push(`- [${titleOf(x)}](${linkFor(x)})`);
    out.push("");

    const slug = slugFor(route);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, slug + ".mdx"), out.join("\n") + "\n");
    emitted.push(slug + ".mdx");
  }

  // ── sheet pages — declared surfaces with full prose ──
  function emitSheet(sheet: DocSheet): void {
    const out: string[] = [];
    const name = sheet.key.split(".")[1] ?? sheet.key;
    const label = T(sheet.label_key) ?? titleOf(name);
    const facts = sheet.facts;
    const openedBy = sheet.opened_by ?? [];
    const purpose = `Side panel — ${label}.`;
    out.push("---");
    out.push(`title: ${label}`);
    out.push(`description: ${purpose}`);
    out.push("---\n");
    out.push(`The **${label}** panel opens in a side sheet${sheet.default_options?.side ? ` on the ${sheet.default_options.side}` : ""}${sheet.default_options?.modal ? " and blocks interaction with the page behind it" : ""}. It is delivered by the owning module as a remote component mounted inside the host sheet surface.\n`);
    if (sheet.default_options?.content_class)
      out.push(`The panel uses a wider layout (\`${sheet.default_options.content_class}\`).\n`);
    if (facts?.sheetProps?.length) {
      out.push("## Inputs\n");
      out.push("| Input | Notes |");
      out.push("|-------|-------|");
      for (const p of facts.sheetProps)
        out.push(`| \`${p}\` | passed by the caller when the panel opens |`);
      out.push("");
    }
    if (facts?.endpoints?.length) {
      out.push("## What it reads\n");
      for (const e of [...new Set(facts.endpoints.map((x) => `${x.method} ${x.path}`))])
        out.push(`- \`${e}\``);
      out.push("");
    }
    if (openedBy.length) {
      out.push("## Opened from\n");
      for (const r of openedBy) {
        const slug = slugFor(r);
        if (docSlugs.has(slug)) out.push(`- [${titleOf(r)}](${linkFor(slug)}) — \`${r}\``);
        else out.push(`- \`${r}\``);
      }
      out.push("");
    } else {
      out.push("## Opened from\n");
      out.push(`No page currently opens this panel — it is a declared module surface and can be opened programmatically via \`openSheet('${sheet.key}')\` by any page holding the matching access grant.\n`);
    }
    out.push("## Doc references\n");
    out.push(`- [Entities Crud](${linkFor("entities-crud")})`);
    out.push("");
    const slug = sheetSlug(sheet.key);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, slug + ".mdx"), out.join("\n") + "\n");
    emitted.push(slug + ".mdx");
  }

  // ── run ──
  for (const [route, r] of routes) {
    if (!documentable.get(route)) continue;
    emitRoute(route, r);
  }
  for (const sheet of ctx.sheets) emitSheet(sheet);

  // ── ghost auto-delete — `out_dir` is pipeline-owned: any .mdx not
  // re-emitted this run and not listed in `keep_files` (reference docs
  // owned by sibling generators) is a stale ghost and is deleted.
  const keep = new Set((ctx.keep_files ?? []).map((k) => k.replace(/\.mdx$/, "")));
  const ghosts: string[] = [];
  try {
    for (const f of readdirSync(outDir)) {
      if (!f.endsWith(".mdx")) continue;
      if (!emitted.includes(f) && !keep.has(f.replace(/\.mdx$/, ""))) ghosts.push(f);
    }
  } catch { /* out dir may not exist yet */ }
  const ghosts_deleted: string[] = [];
  for (const g of ghosts) {
    rmSync(join(outDir, g));
    ghosts_deleted.push(g);
  }

  return { emitted, skipped, ghosts_deleted };
}

function emptyFacts(route: string): SveltePageFacts {
  return {
    route, fields: {}, endpoints: [], navigations: [], composables: [],
    schemaVar: null, superRefines: 0, customActions: [], constUrls: {},
    widgets: [], i18nKeys: [],
  };
}

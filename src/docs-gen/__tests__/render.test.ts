import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePageDocs } from "../render.js";
import type { RenderContext } from "../render.js";
import type { DocRoute, DocSheet } from "../types.js";

// A synthetic job_rule-shaped input — validates the new legs: form-decl
// fields from page_props.form × meta.columns, options_source census prose,
// declared-route titles, sheets as own pages, ghost auto-delete.

const JOB_META = {
  entity: "job_rule",
  translation_key: "job_rule",
  columns: [
    { key: "name", type: "varchar(200)", pg_type: "varchar(200)", nullable: false, max_length: 200, default_visible: true, sortable: true, filterable: true, label_key: "job.entities.job_rule.fields.name" },
    // Control/options contract lives on the COLUMN (MetaColumn) —
    // placements only position fields.
    { key: "event_subject", type: "varchar(200)", pg_type: "varchar(200)", nullable: false, max_length: 200, format: "nats-subject", default_visible: true, sortable: false, filterable: true, options_source: "census.emits", allow_create: false, label_key: "job.entities.job_rule.fields.event_subject" },
    { key: "payload_map", type: "jsonb", pg_type: "jsonb", nullable: true, json_schema: {}, default_visible: false, widget: "payload_map", label_key: "job.entities.job_rule.fields.payload_map" },
  ],
};

const TRANSLATIONS = {
  "job.entities.job_rule.plural": "Job rules",
  "job.entities.job_rule.singular": "Job rule",
  "job.entities.job_rule.fields.name": "Rule name",
  "job.entities.job_rule.fields.event_subject": "Event",
  "job.entities.job_rule.fields.payload_map": "Payload map",
  "crm.events.customerChanged.label": "Customer changed",
  "crm.events.customerChanged.description": "Published when a customer record changes.",
};

const ROUTES: DocRoute[] = [
  {
    route: "/system/job/rules", kind: "list", entity: "job_rule",
    label_key: "job.entities.job_rule.plural", delivery: "host-static",
  },
  {
    route: "/system/job/rules/create", kind: "create", entity: "job_rule",
    delivery: "archetype",
    form: {
      fields: [
        { key: "name" },
        { key: "event_subject" },
        { key: "payload_map", col: 2, row: 1, row_span: 7 },
      ],
    },
  },
  {
    route: "/system/job/rules/{uuid}", kind: "detail", entity: "job_rule",
    delivery: "archetype",
    form: { fields: [{ key: "name" }] },
  },
];

const SHEETS: DocSheet[] = [{
  key: "job.runDetail",
  label_key: "job.jobs.runDetail.title",
  component_url: "/svc/job/api/v1/module-assets/jobs-page.js",
  default_options: { side: "right", modal: true },
  facts: {
    route: "sheet:job.runDetail", fields: {}, navigations: [], composables: [],
    schemaVar: null, superRefines: 0, customActions: [], constUrls: {},
    widgets: [], i18nKeys: [],
    endpoints: [{ method: "GET", path: "/api/v1/entities/job_run/{uuid}" }],
    sheetProps: ["run_uuid"], sheetOpenings: [],
  },
}];

function ctx(outDir: string): RenderContext {
  return {
    service_code: "job",
    routes: ROUTES,
    sheets: SHEETS,
    meta_by_entity: { job_rule: JOB_META },
    caps_by_entity: {
      job_rule: {
        perms: {
          meta: ["_authenticated_user"], list: ["_authenticated_user"], get: ["_authenticated_user"],
          create: ["_authenticated_admin"], update: ["_authenticated_admin"],
          delete: ["_authenticated_admin"], restore: ["_authenticated_admin"],
          audit: ["_authenticated_user"],
        },
        extraScans: [], stepUp: {}, auditable: true,
      },
    },
    translations: TRANSLATIONS,
    census_options: {
      emits: [{ subject: "crm.customer.changed", label_key: "crm.events.customerChanged.label", description_key: "crm.events.customerChanged.description", service: "crm" }],
      callables: [],
    },
    access_namespace: "access.system.job",
    out_dir: outDir,
  };
}

describe("generatePageDocs", () => {
  it("renders list + form-decl create/edit + sheet pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsgen-"));
    const report = generatePageDocs(ctx(dir));
    expect(report.emitted).toContain("rules.mdx");
    expect(report.emitted).toContain("rules-create.mdx");
    expect(report.emitted).toContain("rules-edit.mdx");
    expect(report.emitted).toContain("run-detail.mdx");
    expect(report.skipped).toHaveLength(0);

    const create = readFileSync(join(dir, "rules-create.mdx"), "utf8");
    expect(create).toContain("entity: job_rule");
    expect(create).toContain("## Fields");
    expect(create).toContain("**Rule name**");
    // options_source → census enumeration with resolved labels
    expect(create).toContain("`crm.customer.changed`");
    expect(create).toContain("Customer changed");
    // widget prose
    expect(create).toContain("payload-map builder");
    // format prose from meta
    expect(create).toContain("NATS subject");
    // access grant note
    expect(create).toContain("access.system.job");

    const list = readFileSync(join(dir, "rules.mdx"), "utf8");
    expect(list).toContain("## Columns");
    expect(list).toContain("**Rule name**");
    // sibling links
    expect(list).toContain("/docs/user-guide/generated/rules-create");

    const edit = readFileSync(join(dir, "rules-edit.mdx"), "utf8");
    // auditable detail → optimistic-lock + read-mode prose
    expect(edit).toContain("optimistic locking");

    const sheet = readFileSync(join(dir, "run-detail.mdx"), "utf8");
    expect(sheet).toContain("side sheet");
    expect(sheet).toContain("run_uuid");
    // no caller → declared-surface fallback prose
    expect(sheet).toContain("openSheet('job.runDetail')");
  });

  it("auto-deletes ghost mdx files not re-emitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsgen-"));
    writeFileSync(join(dir, "rules.mdx"), "stale");
    writeFileSync(join(dir, "customers.mdx"), "ghost");
    writeFileSync(join(dir, "entity-api-catalog.mdx"), "reference doc");
    const c = ctx(dir);
    c.keep_files = ["entity-api-catalog.mdx"];
    const report = generatePageDocs(c);
    expect(report.ghosts_deleted).toContain("customers.mdx");
    expect(existsSync(join(dir, "customers.mdx"))).toBe(false);
    // reference docs owned by sibling generators survive
    expect(existsSync(join(dir, "entity-api-catalog.mdx"))).toBe(true);
    expect(report.emitted).toContain("rules.mdx");
  });

  it("flags foreign entities as skipped, never emits them", () => {
    const dir = mkdtempSync(join(tmpdir(), "docsgen-"));
    const c = ctx(dir);
    c.routes = [...ROUTES, { route: "/crm/customers", kind: "list", entity: "customer", delivery: "host-static" }];
    c.foreign_entities = ["customer"]; // claimed by the crm service's census
    const report = generatePageDocs(c);
    expect(report.skipped).toContainEqual({ route: "/crm/customers", reason: "entity 'customer' owned by another service" });
    expect(report.emitted).not.toContain("customers.mdx");
  });
});

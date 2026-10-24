import { describe, expect, it } from "vitest";

import { entityPaths, validateNavDeclaration } from "../nav-declaration.js";

const link = (
  href: string,
  label_key = "job.jobs.nav",
  extra: Record<string, unknown> = {},
) => ({ id: href, label_key, href, ...extra });

const baseDecl = (over: Record<string, unknown>) => ({
  route_prefixes: ["/system/job"],
  access: "access.system.job",
  nav: [link("/system/job/job-schedules", "job.jobs.nav", { default: true })],
  routes: [
    { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
  ],
  ...over,
});

describe("access — the module namespace is mandatory", () => {
  it("rejects a declaration without module-level access", () => {
    const decl = baseDecl({});
    delete (decl as Record<string, unknown>)["access"];
    expect(validateNavDeclaration("job", decl, "system")).toMatch(
      /module-level access is required.*'access\.system\.job'/,
    );
  });

  it("rejects a module-level access outside the derived namespace", () => {
    expect(
      validateNavDeclaration("job", baseDecl({ access: "access.system.settings" }), "system"),
    ).toMatch(/module-level access must be exactly 'access\.system\.job'/);
    expect(
      validateNavDeclaration("job", baseDecl({ access: "access.system.job.deeper" }), "system"),
    ).toMatch(/module-level access must be exactly 'access\.system\.job'/);
  });

  it("rejects item-level access entirely — leaf keys are derived, never declared", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [{ id: "x", label_key: "job.jobs.nav", href: "/system/job/job-schedules", default: true, access: "access.system.job.job-schedules" }],
      }), "system"),
    ).toMatch(/'access' is not declarable on items/);
    expect(
      validateNavDeclaration("job", baseDecl({
        routes: [{ route: "/system/job/job-schedules", kind: "list", entity: "job_schedule", access: "access.system.job.job-schedules" }],
      }), "system"),
    ).toMatch(/'access' is not declarable on items/);
    expect(
      validateNavDeclaration("job", baseDecl({
        sheets: [{ key: "job.runDetail", component_url: "/ws/job/api/v1/module-assets/s.js", access: "access.system.job.runDetail" }],
      }), "system"),
    ).toMatch(/'access' is not declarable on items/);
  });
});

describe("entityPaths — the only path builder", () => {
  it("derives list/create/detail from the leaf", () => {
    expect(entityPaths("/system/job", "job-schedules")).toEqual({
      list: "/system/job/job-schedules",
      create: "/system/job/job-schedules/create",
      detail: "/system/job/job-schedules/[uuid]",
    });
    expect(entityPaths("/crm", "customers", "code").detail).toBe("/crm/customers/[code]");
  });
});

describe("R1 — list routes must end in a plural segment", () => {
  it("rejects a singular list leaf (the /system/job bug)", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [link("/system/job/rule", "job.rule.nav", { default: true })],
        routes: [{ route: "/system/job/rule", kind: "list", entity: "job_schedule" }],
      }), "system"),
    ).toMatch(/must end in a plural segment/);
  });

  it("accepts plural leaves incl. kebab multi-word", () => {
    expect(
      validateNavDeclaration("job", baseDecl({}), "system"),
    ).toBeNull();
  });
});

describe("R4 — the bare prefix is a namespace, never a page", () => {
  it("rejects a route equal to a declared prefix", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        routes: [{ route: "/system/job", kind: "page" }],
      }), "system"),
    ).toMatch(/must live strictly under a declared route_prefix/);
  });

  it("rejects a nav href equal to a declared prefix — the /system/ai violation", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [link("/system/job", "job.jobs.nav", { default: true })],
      }), "system"),
    ).toMatch(/must live strictly under a declared route_prefix/);
  });

  it("rejects a child href outside the prefixes — containment applies recursively", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
          {
            id: "grp",
            label_key: "job.grp.nav",
            href: "/system/job/job-schedules",
            children: [link("/other/escape", "job.escape.nav")],
          },
        ],
      }), "system"),
    ).toMatch(/must live strictly under a declared route_prefix/);
  });
});

describe("R5 — exactly one leaf flags default", () => {
  it("rejects zero defaults", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [link("/system/job/job-schedules")],
      }), "system"),
    ).toMatch(/exactly one leaf item must flag/);
  });

  it("rejects two defaults", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
          link("/system/job/runs", "job.runs.nav", { default: true }),
        ],
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/runs", kind: "list", entity: "job_run" },
        ],
      }), "system"),
    ).toMatch(/exactly one leaf may be the module default/);
  });

  it("rejects a default on a parent with children", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [{
          id: "grp",
          label_key: "job.grp.nav",
          href: "/system/job/job-schedules",
          default: true,
          children: [link("/system/job/runs", "job.runs.nav")],
        }],
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/runs", kind: "list", entity: "job_run" },
        ],
      }), "system"),
    ).toMatch(/default can only flag a leaf item/);
  });

  it("rejects a default whose href resolves to no declared route", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/snapshots", "job.snapshots.nav", { default: true }),
          link("/system/job/job-schedules", "job.jobs.nav"),
        ],
      }), "system"),
    ).toMatch(/default leaf's href '\/system\/job\/snapshots' resolves to no declared route/);
  });

  it("accepts a default on a nested child leaf", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          {
            id: "grp",
            label_key: "job.grp.nav",
            href: "/system/job/job-schedules",
            children: [
              link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
              link("/system/job/runs", "job.runs.nav"),
            ],
          },
        ],
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/runs", kind: "list", entity: "job_run" },
        ],
      }), "system"),
    ).toBeNull();
  });
});

describe("R3 — create/detail leaf is derived, never free-chosen", () => {
  it("rejects /new — 'create' is the single convention", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/job-schedules/new", kind: "create", entity: "job_schedule" },
        ],
      }), "system"),
    ).toMatch(/must end in '\/create'/);
  });

  it("rejects a non-param detail leaf", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/job-schedules/edit", kind: "detail", entity: "job_schedule" },
        ],
      }), "system"),
    ).toMatch(/must end in a '\[param\]' segment/);
  });
});

describe("R2 — leaf nav hrefs resolve to declared routes or are plural", () => {
  it("accepts a nav link to a declared page route (singular ok)", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
          link("/system/job/dashboard", "job.dash.nav"),
        ],
        routes: [
          { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
          { route: "/system/job/dashboard", kind: "page" },
        ],
      }), "system"),
    ).toBeNull();
  });

  it("rejects an undeclared singular nav leaf", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
          link("/system/job/console", "job.console.nav"),
        ],
      }), "system"),
    ).toMatch(/resolves to no declared route/);
  });

  it("accepts an undeclared but plural nav leaf — but it cannot be the default", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [
          link("/system/job/job-schedules", "job.jobs.nav", { default: true }),
          link("/system/job/snapshots", "job.snapshots.nav"),
        ],
      }), "system"),
    ).toBeNull();
  });
});

describe("page_props.layout — section composition", () => {
  const sectioned = (layout: unknown) => baseDecl({
    routes: [
      { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
      {
        route: "/system/job/console",
        kind: "page",
        component_url: "/ws/job/api/v1/module-assets/console-page.js",
        page_props: { layout },
      },
    ],
  });

  it("accepts a grid layout with remote and host sections", () => {
    expect(
      validateNavDeclaration("job", sectioned({
        columns: "280px 1fr",
        gap: "1rem",
        sections: [
          { id: "nav", source: "host:entity_table", span: 1 },
          { id: "main", source: "remote:mountMain", col: 2, row: 1, props: { a: 1 } },
        ],
      }), "system"),
    ).toBeNull();
  });

  it("rejects empty sections and non-object layout", () => {
    expect(validateNavDeclaration("job", sectioned("grid"), "system"))
      .toMatch(/layout must be an object/);
    expect(validateNavDeclaration("job", sectioned({ sections: [] }), "system"))
      .toMatch(/sections: must be a non-empty array/);
  });

  it("rejects malformed source and duplicate ids", () => {
    expect(
      validateNavDeclaration("job", sectioned({
        sections: [{ id: "a", source: "chunk:mountX" }],
      }), "system"),
    ).toMatch(/source must be 'remote:<export>' or 'host:<key>'/);
    expect(
      validateNavDeclaration("job", sectioned({
        sections: [
          { id: "a", source: "remote:mountA" },
          { id: "a", source: "remote:mountB" },
        ],
      }), "system"),
    ).toMatch(/duplicate section id/);
  });

  it("rejects non-positive-integer placement", () => {
    expect(
      validateNavDeclaration("job", sectioned({
        sections: [{ id: "a", source: "remote:mountA", span: 0 }],
      }), "system"),
    ).toMatch(/span must be a positive integer/);
    expect(
      validateNavDeclaration("job", sectioned({
        sections: [{ id: "a", source: "remote:mountA", col: 1.5 }],
      }), "system"),
    ).toMatch(/col must be a positive integer/);
  });
});

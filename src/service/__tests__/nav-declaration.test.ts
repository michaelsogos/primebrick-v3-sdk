import { describe, expect, it } from "vitest";

import { entityPaths, validateNavDeclaration } from "../nav-declaration.js";

const link = (href: string, label_key = "job.jobs.nav") => ({ id: "x", label_key, href });

const baseDecl = (over: Record<string, unknown>) => ({
  route_prefixes: ["/system/job"],
  nav: [link("/system/job/job-schedules")],
  routes: [
    { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
  ],
  ...over,
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
        nav: [link("/system/job")],
        routes: [{ route: "/system/job", kind: "list", entity: "job_schedule" }],
      }), "system"),
    ).toMatch(/must end in a plural segment/);
  });

  it("accepts plural leaves incl. kebab multi-word", () => {
    expect(
      validateNavDeclaration("job", baseDecl({}), "system"),
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
        nav: [link("/system/job/job-schedules"), link("/system/job/dashboard", "job.dash.nav")],
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
        nav: [link("/system/job/job-schedules"), link("/system/job/console", "job.console.nav")],
      }), "system"),
    ).toMatch(/resolves to no declared route/);
  });

  it("accepts an undeclared but plural nav leaf", () => {
    expect(
      validateNavDeclaration("job", baseDecl({
        nav: [link("/system/job/job-schedules"), link("/system/job/snapshots", "job.snapshots.nav")],
      }), "system"),
    ).toBeNull();
  });
});

describe("page_props.layout — section composition", () => {
  const sectioned = (layout: unknown) => baseDecl({
    routes: [
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

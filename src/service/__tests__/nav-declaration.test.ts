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
        sheets: [{ key: "job.runDetail", component_url: "/svc/job/api/v1/module-assets/s.js", access: "access.system.job.runDetail" }],
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

describe("route-level description_key + chrome", () => {
  const decl = (extra: Record<string, unknown>) => baseDecl({
    routes: [
      { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
      { route: "/system/job/dashboard", kind: "page", ...extra },
    ],
  });

  it("accepts a route-level description_key", () => {
    expect(
      validateNavDeclaration("job", decl({ description_key: "job.dash.desc" }), "system"),
    ).toBeNull();
  });

  it("rejects a non-string description_key", () => {
    expect(validateNavDeclaration("job", decl({ description_key: 42 }), "system"))
      .toMatch(/description_key must be a non-empty i18n key/);
  });

  it("accepts chrome:'host' and chrome:'remote' on a remote route", () => {
    const remote = {
      description_key: "job.dash.desc",
      component_url: "/svc/job/api/v1/module-assets/console-page.js",
    };
    expect(validateNavDeclaration("job", decl({ ...remote, chrome: "host" }), "system")).toBeNull();
    expect(validateNavDeclaration("job", decl({ ...remote, chrome: "remote" }), "system")).toBeNull();
  });

  it("rejects an invalid chrome value and chrome:'remote' without component_url", () => {
    expect(validateNavDeclaration("job", decl({ chrome: "none" }), "system"))
      .toMatch(/chrome must be 'host' or 'remote'/);
    expect(validateNavDeclaration("job", decl({ chrome: "remote" }), "system"))
      .toMatch(/chrome:'remote' is only valid on remote routes/);
  });
});

describe("page_props.form — entity-form archetype declaration", () => {
  const formed = (form: unknown) => baseDecl({
    routes: [
      { route: "/system/job/job-schedules", kind: "list", entity: "job_schedule" },
      {
        route: "/system/job/rules/create",
        kind: "create",
        entity: "job_rule",
        page_props: { form },
      },
    ],
  });

  it("accepts a well-formed form declaration", () => {
    expect(
      validateNavDeclaration("job", formed({
        fields: [
          { key: "name", span: 2 },
          { key: "event_subject", options_source: "census.emits", placeholder_key: "job.ph" },
          { key: "enabled", default_value: true, required: true },
        ],
        validators: ["target_matches_lane"],
      }), "system"),
    ).toBeNull();
  });

  it("rejects a non-object form and a non-array fields", () => {
    expect(validateNavDeclaration("job", formed("x"), "system"))
      .toMatch(/form must be an object/);
    expect(validateNavDeclaration("job", formed({ fields: {} }), "system"))
      .toMatch(/fields: must be a non-empty array/);
  });

  it("rejects unknown form keys and unknown placement keys", () => {
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a" }], bogus: 1 }), "system"))
      .toMatch(/unknown key 'bogus'/);
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a", bogus: 1 }] }), "system"))
      .toMatch(/unknown placement key 'bogus'/);
  });

  it("rejects missing/duplicate keys and bad placement values", () => {
    expect(validateNavDeclaration("job", formed({ fields: [{ span: 2 }] }), "system"))
      .toMatch(/'key' is required/);
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a" }, { key: "a" }] }), "system"))
      .toMatch(/duplicate field placement/);
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a", span: 0 }] }), "system"))
      .toMatch(/span must be a positive integer/);
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a", required: "yes" }] }), "system"))
      .toMatch(/required must be a boolean/);
  });

  it("rejects an unknown options_source and non-string validators", () => {
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a", options_source: "api" }] }), "system"))
      .toMatch(/options_source must be one of census\.emits/);
    expect(validateNavDeclaration("job", formed({ fields: [{ key: "a" }], validators: [42] }), "system"))
      .toMatch(/validators: must be an array of non-empty validator keys/);
  });
});

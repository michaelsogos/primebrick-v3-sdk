import { describe, expect, it } from "vitest";
import { validateEventsDeclaration } from "../events-declaration.js";

describe("validateEventsDeclaration", () => {
  it("accepts undefined/null — optional axis", () => {
    expect(validateEventsDeclaration("svc", undefined)).toBeNull();
    expect(validateEventsDeclaration("svc", null)).toBeNull();
  });

  it("accepts a well-formed emits list incl. wildcards + label/description keys", () => {
    expect(
      validateEventsDeclaration("webhook", {
        emits: [
          { subject: "webhook.*.received" },
          {
            subject: "jobs.ctl.rules.changed",
            label_key: "job.events.rules_changed.name",
            description_key: "job.events.rules_changed.desc",
          },
          { subject: "a.b.>" },
        ],
      }),
    ).toBeNull();
  });

  it("rejects non-object declarations", () => {
    expect(validateEventsDeclaration("svc", "x")).toMatch(/must be an object/);
    expect(validateEventsDeclaration("svc", ["a.b"])).toMatch(/must be an object/);
  });

  it("rejects non-array emits and bare-string entries", () => {
    expect(validateEventsDeclaration("svc", { emits: "a.b" })).toMatch(/must be an array/);
    expect(validateEventsDeclaration("svc", { emits: ["a.b"] })).toMatch(
      /every entry must be \{subject, label_key\?, description_key\?\}/,
    );
    expect(validateEventsDeclaration("svc", { emits: [42] })).toMatch(/every entry must be/);
  });

  it("rejects malformed subjects", () => {
    for (const s of ["a..b", ".a.b", "a.b.", "a b.c", "a.>.b", "a-b c"]) {
      expect(validateEventsDeclaration("svc", { emits: [{ subject: s }] }), s).not.toBeNull();
    }
  });

  it("rejects malformed label_key/description_key", () => {
    for (const k of ["noDots", "has space.x", "a..b", 42]) {
      for (const field of ["label_key", "description_key"] as const) {
        expect(
          validateEventsDeclaration("svc", {
            emits: [{ subject: "a.b", [field]: k as never }],
          }),
          `${field}=${String(k)}`,
        ).toMatch(new RegExp(field));
      }
    }
  });

  it("rejects duplicates and unknown keys", () => {
    expect(
      validateEventsDeclaration("svc", {
        emits: [{ subject: "a.b" }, { subject: "a.b" }],
      }),
    ).toMatch(/duplicate/);
    expect(
      validateEventsDeclaration("svc", { emits: [{ subject: "a.b" }], subscribes: [] }),
    ).toMatch(/unknown key/);
    expect(
      validateEventsDeclaration("svc", { emits: [{ subject: "a.b", extra: 1 }] }),
    ).toMatch(/unknown key/);
  });
});

describe("emits entity pointer", () => {
  it("accepts a well-formed {key, entity, table} pointer", () => {
    expect(
      validateEventsDeclaration("svc", {
        emits: [
          { subject: "a.b", entity: { key: "customer", entity: "customer", table: "customers" } },
        ],
      }),
    ).toBeNull();
  });

  it("rejects non-object / partial / unknown-key pointers", () => {
    for (const bad of ["customer", { key: "c" }, { key: "c", entity: "e", table: "" }, { key: "c", entity: "e", table: "t", extra: 1 }]) {
      expect(
        validateEventsDeclaration("svc", { emits: [{ subject: "a.b", entity: bad }] }),
        JSON.stringify(bad),
      ).toMatch(/entity/);
    }
  });
});

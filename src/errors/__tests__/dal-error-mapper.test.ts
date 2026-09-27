import { describe, it, expect } from "vitest";
import { mapDalError } from "../dal-error-mapper.js";

describe("mapDalError", () => {
  it("maps ERR01 → 409 with bulk extra.issues", () => {
    const err = Object.assign(new Error("stale"), {
      code: "ERR01",
      detail: { entity: "CustomerEntity", table: "public.customers", stale: 2, rows: [{ uuid: "a" }, { uuid: "b" }] },
    });
    const mapped = mapDalError(err, "/api/v1/entities/customer/bulk-delete");
    expect(mapped).not.toBeNull();
    expect(mapped!.status).toBe(409);
    expect(mapped!.body.internal_code).toBe("ERR01");
    expect(mapped!.body.type).toBe("urn:primebrick:err01");
    expect(mapped!.body.instance).toBe("/api/v1/entities/customer/bulk-delete");
    expect(mapped!.body.extra?.stale).toBe(2);
    expect(mapped!.body.extra?.issues).toHaveLength(2);
  });

  it("maps ERR02 → 400 with missing count", () => {
    const err = Object.assign(new Error("missing"), {
      code: "ERR02",
      detail: { missing: 1, rows: [{ uuid: "x" }] },
    });
    const mapped = mapDalError(err);
    expect(mapped!.status).toBe(400);
    expect(mapped!.body.extra?.missing).toBe(1);
  });

  it("maps ERR03 → 404", () => {
    const mapped = mapDalError(Object.assign(new Error("gone"), { code: "ERR03" }));
    expect(mapped!.status).toBe(404);
    expect(mapped!.body.internal_code).toBe("ERR03");
  });

  it("maps ERR04 → 409 with uuid/constraint extras", () => {
    const err = Object.assign(new Error("dup"), {
      code: "ERR04",
      detail: JSON.stringify({ uuid: "u1", constraint: "email", entity: "CustomerEntity" }),
    });
    const mapped = mapDalError(err);
    expect(mapped!.status).toBe(409);
    expect(mapped!.body.extra?.uuid).toBe("u1");
    expect(mapped!.body.extra?.constraint).toBe("email");
  });

  it("maps ERR04 → 409 preserving attempted `keys`", () => {
    const err = Object.assign(new Error("dup"), {
      code: "ERR04",
      detail: { uuid: "u1", constraint: "email", keys: { email: "alice@x.com" } },
    });
    const mapped = mapDalError(err);
    expect(mapped!.status).toBe(409);
    expect(mapped!.body.extra?.keys).toEqual({ email: "alice@x.com" });
  });

  it("maps ERR05 → 409 with deleted flag", () => {
    const mapped = mapDalError(Object.assign(new Error("dup"), { code: "ERR05", detail: { uuid: "u" } }));
    expect(mapped!.status).toBe(409);
    expect(mapped!.body.extra?.deleted).toBe(true);
  });

  it("maps ERR06 → 408", () => {
    const mapped = mapDalError(Object.assign(new Error("slow"), { code: "ERR06" }));
    expect(mapped!.status).toBe(408);
    expect(mapped!.body.internal_code).toBe("ERR06");
  });

  it("maps PG 57014 → ERR07 500 typed", () => {
    const mapped = mapDalError(Object.assign(new Error("canceled"), { code: "57014" }));
    expect(mapped!.status).toBe(500);
    expect(mapped!.body.internal_code).toBe("ERR07");
    expect(mapped!.body.type).toBe("urn:primebrick:err07");
  });

  it("maps PG 23505 → ERR08 409", () => {
    const mapped = mapDalError(Object.assign(new Error("unique_violation"), { code: "23505" }));
    expect(mapped!.status).toBe(409);
    expect(mapped!.body.internal_code).toBe("ERR08");
    expect(mapped!.body.type).toBe("urn:primebrick:err08");
  });

  it("maps ERR09 → 422 invalid match selector", () => {
    const err = Object.assign(new Error("bad selector"), {
      code: "ERR09",
      detail: { selector: "name", entity: "SimpleTestEntity" },
    });
    const mapped = mapDalError(err);
    expect(mapped!.status).toBe(422);
    expect(mapped!.body.internal_code).toBe("ERR09");
    expect(mapped!.body.type).toBe("urn:primebrick:err09");
    expect(mapped!.body.extra?.selector).toBe("name");
  });

  it("maps ERR10 → 412 identity conflict with match extras", () => {
    const err = Object.assign(new Error("mismatch"), {
      code: "ERR10",
      detail: JSON.stringify({ table: "public.dal_test_simple", match: { id: 5, uuid: "u2" } }),
    });
    const mapped = mapDalError(err);
    expect(mapped!.status).toBe(412);
    expect(mapped!.body.internal_code).toBe("ERR10");
    expect(mapped!.body.extra?.match).toEqual({ id: 5, uuid: "u2" });
    expect(mapped!.body.extra?.table).toBe("public.dal_test_simple");
  });

  it("maps NOT_FOUND → 404 /errors/not-found", () => {
    const mapped = mapDalError(Object.assign(new Error("nf"), { code: "NOT_FOUND" }));
    expect(mapped!.status).toBe(404);
    expect(mapped!.body.type).toBe("/errors/not-found");
  });

  it("maps VALIDATION → 400", () => {
    const mapped = mapDalError(Object.assign(new Error("v"), { code: "VALIDATION" }));
    expect(mapped!.status).toBe(400);
  });

  it("returns null for non-DAL errors", () => {
    expect(mapDalError(new Error("boom"))).toBeNull();
    expect(mapDalError(null)).toBeNull();
    expect(mapDalError("str")).toBeNull();
    expect(mapDalError({ code: "ECONNREFUSED" })).toBeNull();
  });
});

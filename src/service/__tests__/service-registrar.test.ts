import { describe, it, expect, vi, beforeEach } from "vitest";
import { ServiceRegistrar } from "../service-registrar.js";
import type { ServiceRegistryPort } from "../../ports/service-registry-port.js";
import type { IServiceRegistry } from "../service-registry.js";

function makeRepo(): ServiceRegistryPort & {
  findByCode: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  updateByCode: ReturnType<typeof vi.fn>;
} {
  return {
    findByCode: vi.fn(),
    insert: vi.fn(async () => {}),
    updateByCode: vi.fn(async () => {}),
  };
}

const config = {
  serviceCode: "emailsender",
  baseUrl: "http://localhost:8081",
  endpoints: { send: "/send" },
};

describe("ServiceRegistrar", () => {
  let repo: ReturnType<typeof makeRepo>;
  let registrar: ServiceRegistrar;

  beforeEach(() => {
    repo = makeRepo();
    registrar = new ServiceRegistrar(repo, config);
  });

  it("inserts a new row when findByCode returns null", async () => {
    repo.findByCode.mockResolvedValue(null);
    await registrar.register();
    expect(repo.insert).toHaveBeenCalledWith({
      code: "emailsender",
      base_url: "http://localhost:8081",
      endpoints: { send: "/send" },
    });
    expect(repo.updateByCode).not.toHaveBeenCalled();
  });

  it("updates an existing row when findByCode returns a row", async () => {
    const existing: IServiceRegistry = {
      code: "emailsender",
      base_url: "http://old",
      endpoints: {},
    };
    repo.findByCode.mockResolvedValue(existing);
    await registrar.register();
    expect(repo.updateByCode).toHaveBeenCalledWith("emailsender", {
      code: "emailsender",
      base_url: "http://localhost:8081",
      endpoints: { send: "/send" },
    });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("updateHeartbeat calls updateByCode with base_url", async () => {
    await registrar.updateHeartbeat();
    expect(repo.updateByCode).toHaveBeenCalledWith("emailsender", {
      base_url: "http://localhost:8081",
    });
  });

  it("updateHeartbeat swallows errors", async () => {
    repo.updateByCode.mockRejectedValue(new Error("db down"));
    await expect(registrar.updateHeartbeat()).resolves.toBeUndefined();
  });

  it("startHeartbeat returns a timer and stopHeartbeat clears it", () => {
    const timer = registrar.startHeartbeat();
    expect(typeof timer).toBe("object");
    registrar.stopHeartbeat();
    // No throw — clearing twice is safe
    registrar.stopHeartbeat();
  });

  it("uses default heartbeatIntervalMs when not provided", () => {
    const r = new ServiceRegistrar(repo, {
      serviceCode: "x",
      baseUrl: "http://x",
      endpoints: {},
    });
    r.startHeartbeat();
    r.stopHeartbeat();
  });
});

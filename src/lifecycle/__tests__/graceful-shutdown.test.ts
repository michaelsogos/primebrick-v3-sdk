import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GracefulShutdown } from "../graceful-shutdown.js";

describe("GracefulShutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__EXIT__");
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("runs all cleanup functions in parallel", async () => {
    const gs = new GracefulShutdown("svc");
    const c1 = vi.fn(async () => {});
    const c2 = vi.fn(async () => {});
    gs.addCleanup(c1);
    gs.addCleanup(c2);
    await expect(gs.shutdown("SIGTERM", 130)).rejects.toThrow("__EXIT__");
    expect(c1).toHaveBeenCalled();
    expect(c2).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("re-entrancy guard: second shutdown is a no-op", async () => {
    const gs = new GracefulShutdown("svc");
    const c1 = vi.fn(async () => {});
    gs.addCleanup(c1);
    await expect(gs.shutdown("SIGTERM", 130)).rejects.toThrow("__EXIT__");
    // Second call should not run cleanup again and should not call exit again
    c1.mockClear();
    exitSpy.mockClear();
    await gs.shutdown("SIGINT", 130);
    expect(c1).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("install() registers signal handlers", () => {
    const gs = new GracefulShutdown("svc");
    const onSpy = vi.spyOn(process, "on");
    gs.install();
    expect(onSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("SIGHUP", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("uncaughtException", expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith("unhandledRejection", expect.any(Function));
  });
});

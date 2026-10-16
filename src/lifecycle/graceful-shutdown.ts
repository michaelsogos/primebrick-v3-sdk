import os from "node:os";
import { logger } from "./logger.js";
import { lifecycleRegistry } from "./process-registry.js";

export type CleanupFn = () => Promise<void>;

/**
 * Graceful shutdown manager. Extracted from emailsender's index.ts:55-95.
 *
 * - Re-entrancy guard: second signal is a no-op.
 * - Runs all cleanup functions in parallel (Promise.allSettled).
 * - Always calls process.exit() explicitly.
 * - Installs SIGTERM, SIGINT, SIGHUP + uncaughtException + unhandledRejection handlers.
 *
 * Pure Node.js — no DB dependency. The consumer registers cleanup functions
 * (e.g. getDal().close(), NatsClient.close()) via addCleanup().
 */
export class GracefulShutdown {
  private shuttingDown = false;
  private readonly cleanups: CleanupFn[] = [];
  private readonly serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  /** Register a cleanup function to run on shutdown. */
  addCleanup(fn: CleanupFn): void {
    this.cleanups.push(fn);
  }

  /**
   * Install signal + crash handlers. Hot-reload safe: a module reload
   * creates a NEW GracefulShutdown whose cleanups reference the NEW
   * service objects — the previous instance's listeners are removed via
   * the process registry instead of stacking (observed: N reloads → N
   * "shutting down" logs + N exit races on one signal).
   */
  install(): void {
    const registry = lifecycleRegistry();
    for (const { event, fn } of registry.signalListeners ?? []) {
      process.off(event as NodeJS.Signals, fn);
    }
    registry.signalListeners = [];

    const on = (event: string, fn: (...args: any[]) => void): void => {
      process.on(event, fn);
      registry.signalListeners!.push({ event, fn });
    };

    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    for (const sig of signals) {
      on(sig, () => {
        const code = 128 + (os.constants.signals[sig as keyof typeof os.constants.signals] ?? 0);
        void this.shutdown(sig, code);
      });
    }
    on("uncaughtException", (err: Error) => {
      logger.error("uncaughtException", { tags: ["core"], error: err });
      void this.shutdown("uncaughtException", 1);
    });
    on("unhandledRejection", (reason: unknown) => {
      logger.error("unhandledRejection", { tags: ["core"], error: reason });
      void this.shutdown("unhandledRejection", 1);
    });
  }

  async shutdown(reason: string, code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info(`shutting down (${reason})`, { tags: ["core"] });
    try {
      await Promise.allSettled(this.cleanups.map((fn) => fn()));
    } finally {
      process.exit(code);
    }
  }
}

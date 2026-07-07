import os from "node:os";

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

  /** Install signal + crash handlers. */
  install(): void {
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
    for (const sig of signals) {
      process.on(sig, () => {
        const code = 128 + (os.constants.signals[sig as keyof typeof os.constants.signals] ?? 0);
        void this.shutdown(sig, code);
      });
    }
    process.on("uncaughtException", (err) => {
      console.error(`[${this.serviceName}] uncaughtException`, err);
      void this.shutdown("uncaughtException", 1);
    });
    process.on("unhandledRejection", (reason) => {
      console.error(`[${this.serviceName}] unhandledRejection`, reason);
      void this.shutdown("unhandledRejection", 1);
    });
  }

  async shutdown(reason: string, code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`[${this.serviceName}] shutting down (${reason})`);
    try {
      await Promise.allSettled(this.cleanups.map((fn) => fn()));
    } finally {
      process.exit(code);
    }
  }
}

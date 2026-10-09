/**
 * Async structured logger — replaces synchronous `console.*` on the hot path.
 *
 * Design goals:
 * - Non-blocking: callers never wait for I/O. Lines are buffered and flushed
 *   in a single batched write per tick (`process.stdout.write` on Node,
 *   `Bun.write(Bun.stdout, …)` on Bun — runtime detected, zero branching in
 *   call sites).
 * - Trace-correlated: every line carries `trace_id`/`span_id`/`trace_flags`
 *   when an OpenTelemetry span context is active (same fields as
 *   `@opentelemetry/instrumentation-pino` injects for pino).
 * - UTC ISO 8601 timestamps — unambiguous for long-running processes.
 * - Two output formats: `pretty` (human/grep friendly, default) and `json`
 *   (NDJSON for SIEM pipelines). Hot-swappable via `setLogOptions`.
 * - ANSI colors on TTY (level-colored output, dim timestamp), honoring the
 *   NO_COLOR / FORCE_COLOR conventions. Compatible with PowerShell 7, cmd
 *   (Windows 10+ VT), Windows Terminal, Git Bash, bash/zsh/sh.
 * - `installConsoleBridge()` rebinds `console.*` to this logger so all
 *   existing call sites get timestamps + trace context + async writes for
 *   free. Skipped under vitest (`process.env.VITEST`).
 */

import { context, trace } from "@opentelemetry/api";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "done" | "warn" | "error";
export type LogFormat = "pretty" | "json";

export interface LogMeta {
  /**
   * Reserved key: textual tags rendered as `[tag1] [tag2]` right before the
   * message, in amber — visually distinct from level colors, timestamp and
   * the `[service#version]` tag. The message itself must carry ONLY the
   * message; subsystem labels belong here. In `json` format they appear as
   * a structured `tags` array.
   */
  tags?: string[];
  [key: string]: unknown;
}

interface LoggerState {
  level: LogLevel;
  format: LogFormat;
  service: string;
  version?: string;
}

// Service identity is derived once from the consuming project's package.json
// (cwd at startup) — deterministic, no manual tagging. setLogOptions can
// still override `service` for non-package contexts.
function detectService(): { service: string; version?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return { service: pkg.name ?? "app", version: pkg.version };
  } catch {
    return { service: "app" };
  }
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  done: 25,
  warn: 30,
  error: 40,
};

const state: LoggerState = {
  level: "info",
  format: "pretty",
  ...detectService(),
};

declare const Bun: { write: (dest: unknown, data: string) => Promise<unknown>; stdout: unknown; stderr: unknown } | undefined;

const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

// ─── Buffered async writer ──────────────────────────────────────────────────

let stdoutBuf: string[] = [];
let stderrBuf: string[] = [];
let flushScheduled = false;
let stdoutDrained = true;
let stderrDrained = true;

function writeTo(stream: "stdout" | "stderr", chunk: string): void {
  if (isBun && Bun) {
    // Bun.write is async and non-blocking; fire-and-forget.
    void Bun.write(stream === "stdout" ? Bun.stdout : Bun.stderr, chunk);
    return;
  }
  const target = stream === "stdout" ? process.stdout : process.stderr;
  const ok = target.write(chunk);
  if (!ok) {
    if (stream === "stdout") {
      stdoutDrained = false;
      target.once("drain", () => {
        stdoutDrained = true;
        scheduleFlush();
      });
    } else {
      stderrDrained = false;
      target.once("drain", () => {
        stderrDrained = true;
        scheduleFlush();
      });
    }
  }
}

function doFlush(): void {
  flushScheduled = false;
  if (stdoutBuf.length > 0 && stdoutDrained) {
    const chunk = stdoutBuf.join("");
    stdoutBuf = [];
    writeTo("stdout", chunk);
  }
  if (stderrBuf.length > 0 && stderrDrained) {
    const chunk = stderrBuf.join("");
    stderrBuf = [];
    writeTo("stderr", chunk);
  }
  // If a stream was backpressured, the drain handler re-schedules the flush.
  if ((stdoutBuf.length > 0 || stderrBuf.length > 0) && !flushScheduled) {
    scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(doFlush);
}

function enqueue(stream: "stdout" | "stderr", line: string): void {
  (stream === "stdout" ? stdoutBuf : stderrBuf).push(line);
  scheduleFlush();
}

/** Best-effort synchronous flush — called from graceful shutdown. */
export function flushLogsSync(): void {
  if (stdoutBuf.length > 0) {
    process.stdout.write(stdoutBuf.join(""));
    stdoutBuf = [];
  }
  if (stderrBuf.length > 0) {
    process.stderr.write(stderrBuf.join(""));
    stderrBuf = [];
  }
}

// ─── ANSI colors ────────────────────────────────────────────────────────────
// Emitted only on a real TTY (pipes/files stay clean) and honoring the
// NO_COLOR / FORCE_COLOR conventions. ESC is built via fromCharCode so the
// source file contains no raw control bytes.

const ESC = String.fromCharCode(27);

const COLOR_ENABLED =
  process.env.FORCE_COLOR === "1" ||
  (process.stdout.isTTY && process.env.NO_COLOR === undefined);

const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  gray: `${ESC}[90m`,
  green: `${ESC}[32m`,
  blue: `${ESC}[94m`,
  magenta: `${ESC}[95m`,
  magentaDark: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  yellow: `${ESC}[33m`,
  amber: `${ESC}[38;5;214m`,
  red: `${ESC}[31m`,
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: C.gray,
  info: C.cyan,
  done: C.green,
  warn: C.yellow,
  error: C.red,
};

const paint = (code: string, s: string): string =>
  COLOR_ENABLED ? `${code}${s}${C.reset}` : s;

/** Fixed width of the `[service#version]` column (shorter tags are right-padded). */
const TAG_COLUMN_WIDTH = 26;

// ─── Formatting ─────────────────────────────────────────────────────────────

function activeSpanIds(): { trace_id?: string; span_id?: string; trace_flags?: string } {
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return {
    trace_id: sc.traceId,
    span_id: sc.spanId,
    trace_flags: sc.traceFlags.toString(16).padStart(2, "0"),
  };
}

function safeSerialize(value: unknown): unknown {
  if (value instanceof Error) {
    // name/message/stack are non-enumerable on Error; spread first so custom
    // enumerable props (RFC7807 fields like status/title/type) survive.
    return { ...value, name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

// Meta objects render via util.inspect (console.dir's formatter): native
// ANSI colors, always-multiline (compact: false), and built-in truncation
// caps (maxArrayLength / maxStringLength) so a stray huge object can't
// flood the buffered writer.
const INSPECT_OPTS = {
  colors: COLOR_ENABLED,
  depth: null,
  compact: false as const,
  breakLength: 100,
  maxArrayLength: 50,
  maxStringLength: 2000,
};

/** Internal line formatter — exported for tests; use `logger.*` in app code. */
export function formatLine(level: LogLevel, msg: string, meta?: LogMeta): string {
  const ts = new Date().toISOString();
  const span = activeSpanIds();
  const tags = Array.isArray(meta?.tags) ? meta.tags.filter((t): t is string => typeof t === "string") : [];

  if (state.format === "json") {
    const { tags: _tags, ...restMeta } = meta ?? {};
    const record: Record<string, unknown> = {
      time: ts,
      level,
      msg,
      ...(tags.length > 0 ? { tags } : {}),
      ...span,
      service: state.service,
      ...(state.version ? { version: state.version } : {}),
      ...restMeta,
    };
    // BigInt-safe JSON via a replacer (extJson isn't needed — plain JSON + bigint replacer)
    return JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n";
  }

  const tracePart = span.trace_id ? ` trace=${span.trace_id} span=${span.span_id}` : "";
  let metaPart = "";
  const { tags: _tags, ...metaBody } = meta ?? {};
  if (Object.keys(metaBody).length > 0) {
    // safeSerialize the meta itself too — it may BE an Error instance, whose
    // message/stack are non-enumerable and would be dropped by Object.entries.
    const clean = Object.fromEntries(
      Object.entries(safeSerialize(metaBody) as LogMeta).map(([k, v]) => [k, safeSerialize(v)]),
    );
    // A serialized Error's `stack` would inspect as an escaped \n string —
    // print it as raw indented lines instead.
    const stack = typeof clean.stack === "string" ? clean.stack : null;
    const body = stack === null ? clean : Object.fromEntries(Object.entries(clean).filter(([k]) => k !== "stack"));
    if (Object.keys(body).length > 0) {
      metaPart += `\n${inspect(body, INSPECT_OPTS)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}`;
    }
    if (stack !== null) {
      metaPart += `\n${paint(C.gray, stack.split("\n").map((l) => `  ${l}`).join("\n"))}`;
    }
  }
  // Tag is mandatory and deterministic: [service#version] from package.json —
  // name in bright magenta, #version in dark magenta. The first three columns
  // (timestamp, level, service tag) are fixed-width so the message column
  // stays aligned; tags/message flow after it.
  const rawTag = `[${state.service}${state.version ? `#${state.version}` : ""}]`;
  const tag =
    `${paint(C.magenta, `[${state.service}`)}` +
    (state.version ? paint(C.magentaDark, `#${state.version}`) : "") +
    paint(C.magenta, "]") +
    " ".repeat(Math.max(0, TAG_COLUMN_WIDTH - rawTag.length));
  // Optional textual tags: [tag1] [tag2] in amber — distinct from level
  // colors, timestamp and service tag. The message carries only the message.
  const tagsPart = tags.length > 0 ? " " + tags.map((t) => paint(C.amber, `[${t}]`)).join(" ") : "";
  return `${paint(C.blue, ts)} ${paint(LEVEL_COLOR[level], level.padEnd(5))}${tracePart} ${tag}${tagsPart} ${msg}${metaPart}\n`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Optional sink invoked for every emitted record — registered by the
 * telemetry module to forward logs to the OTel Logs SDK (SIEM pipeline)
 * without a circular dependency (otel.ts imports logger.ts).
 */
type LogSink = (level: LogLevel, msg: string, meta?: LogMeta) => void;
let otelSink: LogSink | null = null;

export function setOtelLogSink(sink: LogSink | null): void {
  otelSink = sink;
}

function emit(level: LogLevel, msg: string, meta?: LogMeta): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;
  enqueue(level === "error" || level === "warn" ? "stderr" : "stdout", formatLine(level, msg, meta));
  otelSink?.(level, msg, meta);
}

export const logger = {
  debug: (msg: string, meta?: LogMeta) => emit("debug", msg, meta),
  info: (msg: string, meta?: LogMeta) => emit("info", msg, meta),
  done: (msg: string, meta?: LogMeta) => emit("done", msg, meta),
  warn: (msg: string, meta?: LogMeta) => emit("warn", msg, meta),
  error: (msg: string, meta?: LogMeta) => emit("error", msg, meta),
};

/** Hot-swap logging options (from config reload / `config.changed`). */
export function setLogOptions(opts: { level?: LogLevel; format?: LogFormat; service?: string; version?: string }): void {
  if (opts.level) state.level = opts.level;
  if (opts.format) state.format = opts.format;
  if (opts.service !== undefined) state.service = opts.service;
  if (opts.version !== undefined) state.version = opts.version;
}

export function getLogOptions(): Readonly<LoggerState> {
  return state;
}

// ─── console.* bridge ───────────────────────────────────────────────────────

let bridgeInstalled = false;

/** Internal arg parser used by the console bridge — exported for tests. */
export function argsToMsgAndMeta(args: unknown[]): { msg: string; meta?: LogMeta } {
  if (args.length === 0) return { msg: "" };
  const [first, ...rest] = args;
  // Objects go to structured meta (SIEM-queryable); scalars stay in the message.
  const scalarRest = rest.filter((a) => a === null || typeof a !== "object");
  const objectRest = rest.filter((a): a is Record<string, unknown> => a !== null && typeof a === "object");
  let msg: string;
  if (typeof first === "string") {
    msg = scalarRest.length === 0 ? first : `${first} ${scalarRest.map(stringifyArg).join(" ")}`;
  } else {
    msg = stringifyArg(first);
    if (scalarRest.length > 0) msg += " " + scalarRest.map(stringifyArg).join(" ");
  }
  // First arg being an object also goes to meta instead of the message.
  if (first !== null && typeof first === "object") objectRest.unshift(first as Record<string, unknown>);
  const meta: LogMeta = {};
  for (const a of objectRest) {
    // safeSerialize first: Error.message/stack are non-enumerable and would
    // be dropped by Object.entries on the raw instance.
    for (const [k, v] of Object.entries(safeSerialize(a) as Record<string, unknown>)) {
      meta[k] = safeSerialize(v);
    }
  }
  return { msg, meta: Object.keys(meta).length > 0 ? meta : undefined };
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(safeSerialize(v), (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Rebind console.log/info/warn/error/debug to the async logger.
 * Idempotent. Skipped under vitest (VITEST env) so test output is unaffected.
 */
export function installConsoleBridge(): void {
  if (bridgeInstalled) return;
  if (process.env.VITEST) return;
  bridgeInstalled = true;

  console.log = (...args: unknown[]) => {
    const { msg, meta } = argsToMsgAndMeta(args);
    emit("info", msg, meta);
  };
  console.info = console.log;
  console.debug = (...args: unknown[]) => {
    const { msg, meta } = argsToMsgAndMeta(args);
    emit("debug", msg, meta);
  };
  console.warn = (...args: unknown[]) => {
    const { msg, meta } = argsToMsgAndMeta(args);
    emit("warn", msg, meta);
  };
  console.error = (...args: unknown[]) => {
    const { msg, meta } = argsToMsgAndMeta(args);
    emit("error", msg, meta);
  };
}

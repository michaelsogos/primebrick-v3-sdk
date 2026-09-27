/**
 * Shared DAL → RFC 7807 error mapper. Pure function, runtime-agnostic:
 * zero `node:*` imports, no Express/Bun/Node HTTP types — usable from the
 * BE (Express errorHandler) and from every US microservice (Bun native
 * http route handlers / `createHttpServer` catch path).
 *
 * Contract: the DAL emits stable `code` values — PG-originated via
 * `pg_raise` (ERR01/ERR03/ERR04/ERR05, jsonb in `err.detail`) or
 * TS-originated DalError classes (ERR02/ERR06, object on `err.detail`).
 * `57014` is PG `query_canceled` (statement_timeout) → logical ERR07.
 */

export interface Rfc7807Body {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  internal_code?: string;
  severity?: string;
  /** Structured extras — `issues` is the key the FE RfcErrorDialog renders. */
  extra?: Record<string, unknown>;
}

export interface MappedDalError {
  status: number;
  body: Rfc7807Body;
}

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Parse `err.detail` — jsonb string (PG wire) or object (TS DalError). */
function parseDetail(err: unknown): Record<string, unknown> {
  const raw = (err as { detail?: unknown })?.detail;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Shared `extra` assembly for bulk-raise details ({entity, table, rows}). */
function bulkExtra(info: Record<string, unknown>, countKey: "conflicts" | "stale" | "missing"): Record<string, unknown> {
  return {
    ...(typeof info[countKey] === "number" ? { [countKey]: info[countKey] } : {}),
    ...(Array.isArray(info.rows) ? { issues: info.rows } : {}),
    ...(typeof info.entity === "string" ? { entity: info.entity } : {}),
    ...(typeof info.table === "string" ? { table: info.table } : {}),
  };
}

function body(
  code: string,
  status: number,
  title: string,
  detail: string,
  severity: Severity,
  instance?: string,
  extra?: Record<string, unknown>,
  typeOverride?: string,
): MappedDalError {
  return {
    status,
    body: {
      type: typeOverride ?? `urn:primebrick:${code.toLowerCase()}`,
      title,
      status,
      detail,
      instance,
      internal_code: code,
      severity,
      ...(extra && Object.keys(extra).length > 0 ? { extra } : {}),
    },
  };
}

/**
 * Map a DAL error to an RFC 7807 response `{status, body}`.
 * Returns `null` for errors the DAL does not own (caller falls back to its
 * own error path — ApiError, database-unavailable, generic 500…).
 */
export function mapDalError(err: unknown, instance?: string): MappedDalError | null {
  if (!err || typeof err !== "object") return null;
  const code = (err as Record<string, unknown>).code;

  switch (code) {
    // Optimistic concurrency — 409. Bulk raises carry {stale, rows[≤10]}.
    case "ERR01": {
      const info = parseDetail(err);
      return body(
        "ERR01",
        409,
        "Optimistic concurrency violation",
        messageOf(err, "The record was modified by another user. Please refresh and try again."),
        "HIGH",
        instance,
        bulkExtra(info, "stale"),
      );
    }
    // Missing version — 400. Bulk carries {missing, rows[≤10]}.
    case "ERR02": {
      const info = parseDetail(err);
      return body(
        "ERR02",
        400,
        "Missing version field",
        messageOf(err, "The version field is required for this operation."),
        "MEDIUM",
        instance,
        bulkExtra(info, "missing"),
      );
    }
    // Record vanished — 404. Bulk carries {stale, rows[≤10]} with code ERR03.
    case "ERR03": {
      const info = parseDetail(err);
      return body(
        "ERR03",
        404,
        "Record vanished",
        messageOf(err, "The record was deleted by another user."),
        "MEDIUM",
        instance,
        bulkExtra(info, "stale"),
      );
    }
    // Unique-constraint conflict — 409. ERR05 = every conflict hits a
    // soft-deleted row (caller can offer a direct restore).
    case "ERR04":
    case "ERR05": {
      const info = parseDetail(err);
      return body(
        code,
        409,
        code === "ERR05" ? "Record already exists (deleted)" : "Record already exists",
        messageOf(
          err,
          code === "ERR05"
            ? "A record with these unique fields already exists but is deleted. Restore it instead."
            : "A record with these unique fields already exists.",
        ),
        "MEDIUM",
        instance,
        {
          ...(typeof info.uuid === "string" ? { uuid: info.uuid } : {}),
          ...(typeof info.constraint === "string" ? { constraint: info.constraint } : {}),
          ...(info.keys && typeof info.keys === "object" ? { keys: info.keys } : {}),
          ...bulkExtra(info, "conflicts"),
          ...(code === "ERR05" ? { deleted: true } : {}),
        },
      );
    }
    // Bulk wall-clock timeout — 408. Whole transaction rolled back.
    case "ERR06":
      return body(
        "ERR06",
        408,
        "Bulk operation timeout",
        messageOf(err, "The bulk operation exceeded its maximum execution time and was rolled back."),
        "HIGH",
        instance,
      );
    // PG statement_timeout (57014 query_canceled) → logical ERR07, typed 500.
    case "57014":
      return body(
        "ERR07",
        500,
        "Statement timeout",
        messageOf(err, "A database statement exceeded the configured timeout."),
        "HIGH",
        instance,
      );
    // Raw PG unique violation that bypassed the DAL conflict CTEs
    // (constraint not declared as @Unique in entity metadata — manual,
    // deferred or partial index). Poor detail by definition; its appearance
    // signals a missing @Unique declaration. → logical ERR08, 409.
    case "23505":
      return body(
        "ERR08",
        409,
        "Unique constraint violation",
        messageOf(err, "A record with these unique fields already exists."),
        "MEDIUM",
        instance,
      );
    // Generic DAL codes — `/errors/*` type format (BE parity).
    case "NOT_FOUND":
      return body("NOT_FOUND", 404, "Not found", messageOf(err, "Not found"), "MEDIUM", instance, undefined, "/errors/not-found");
    case "VALIDATION":
    case "UNKNOWN_COLUMN":
    case "MULTIPLE_ROWS":
      return body(code, 400, "Validation error", messageOf(err, "Request validation failed"), "MEDIUM", instance, undefined, "/errors/validation-error");
    default:
      return null;
  }
}

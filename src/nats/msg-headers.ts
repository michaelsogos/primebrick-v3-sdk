/**
 * NATS message-header helper.
 *
 * Unlike the Fetch `Headers` API, `MsgHdrs` (nats.js) is CASE-SENSITIVE and
 * returns "" (empty string) — not null — for missing keys:
 * `set("User-Agent")` can only be read back via `get("User-Agent")` —
 * `get("user-agent")` returns "". Verified empirically against nats@2.x.
 *
 * Convention: Primebrick code writes NATS headers in lowercase and reads
 * them through `msgHeader`, which also tolerates the canonical MIME form
 * (e.g. "User-Agent") for compatibility with foreign publishers.
 */

import type { MsgHdrs } from "nats";

/**
 * Case-insensitive lookup over a case-sensitive MsgHdrs.
 * Tries the name as given first, then the canonical MIME form
 * (each dash segment capitalized). Returns null when absent.
 */
export function msgHeader(hdrs: MsgHdrs | undefined, name: string): string | null {
  if (!hdrs) return null;
  // MsgHdrs.get returns "" (empty string) for missing keys — not null.
  const exact = hdrs.get(name);
  if (exact) return exact;
  const canonicalName = name
    .split("-")
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join("-");
  const canonical = hdrs.get(canonicalName);
  if (canonical) return canonical;
  return hdrs.get(name.toLowerCase()) || null;
}

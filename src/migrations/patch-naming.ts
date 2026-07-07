import { createHash } from "node:crypto";

export function utcTimestampForFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function slugifyPatchSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase()
    .slice(0, 72) || "patch";
}

export function patchIdFromFilename(filename: string): string {
  return filename.replace(/\.sql$/i, "");
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

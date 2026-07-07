import type { DatabasePort } from "../ports/database-port.js";

export const PATCH_REGISTRY_FQNAME = "public.primebrick_database_patches";

export const PATCH_REGISTRY_DDL = `CREATE TABLE IF NOT EXISTS public.primebrick_database_patches (
  patch_id text PRIMARY KEY,
  content_sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS primebrick_database_patches_sha_idx
  ON public.primebrick_database_patches (content_sha256);
`;

export async function isPatchBodyAlreadyRecorded(db: DatabasePort, contentSha256: string): Promise<boolean> {
  const reg = await db.query<{ oid: string | null }>(
    `SELECT to_regclass('${PATCH_REGISTRY_FQNAME}')::text AS oid`
  );
  const oid = reg.rows[0]?.oid;
  if (!oid || oid === "") return false;
  const hit = await db.query(
    `SELECT 1 FROM ${PATCH_REGISTRY_FQNAME} WHERE content_sha256 = $1 LIMIT 1`,
    [contentSha256]
  );
  return hit.rows.length > 0;
}

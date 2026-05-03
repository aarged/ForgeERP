import { eq } from "drizzle-orm";
import { tenantsTable } from "@workspace/db";
import { withTenantDb } from "@workspace/db/rls";

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function formatTimestamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `_` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function sanitizeSlug(slug: string | null | undefined): string {
  if (!slug) return "tenant";
  return slug.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase() || "tenant";
}

/**
 * Build a tenant-scoped, timestamped export filename.
 * Format: `YYYYMMDD_HHmmss_<tenantSlug>_<baseName>.<ext>` (UTC time).
 */
export async function buildExportFilename(
  tenantId: number,
  baseName: string,
  ext: string,
): Promise<string> {
  const [t] = await withTenantDb(tenantId, (db) =>
    db
      .select({ slug: tenantsTable.slug })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1),
  );
  const slug = sanitizeSlug(t?.slug);
  const ts = formatTimestamp(new Date());
  const cleanBase = baseName.replace(/\.+$/, "");
  const cleanExt = ext.replace(/^\.+/, "");
  return `${ts}_${slug}_${cleanBase}.${cleanExt}`;
}

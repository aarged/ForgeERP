/**
 * Row-Level Security utilities.
 *
 * Forge ERP enforces multi-tenant data isolation at two levels:
 *   1. Application layer: All queries pass through `tenantContext` middleware
 *      which sets req.tenantId from the authenticated user's active membership.
 *      Route handlers filter every query with `.where(eq(table.tenantId, req.tenantId))`.
 *   2. Database layer: PostgreSQL RLS policies defined here ensure that even if
 *      application-layer filtering is bypassed, rows from other tenants cannot
 *      be read or written.
 *
 * RLS is enforced per table via the `app.tenant_id` session-local setting.
 * Before executing any tenant-scoped query, call `setTenantId(tenantId)`.
 */

import { pool } from "./index";

/**
 * Sets the current tenant ID as a session-local GUC variable.
 * This variable is read by RLS policies on all tenant-scoped tables.
 *
 * Usage: await setTenantId(client, tenantId);
 */
export async function setTenantId(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  tenantId: number,
): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [
    tenantId.toString(),
  ]);
}

/**
 * Applies RLS policies to all tenant-scoped tables.
 * Safe to run multiple times (idempotent via IF NOT EXISTS / OR REPLACE).
 *
 * This should be called once during DB setup / migration.
 */
export async function applyRLSPolicies(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Enable RLS on tenant-scoped tables
    const tenantScopedTables = ["tenants", "tenant_memberships", "audit_logs", "roles", "role_permissions"];
    for (const table of tenantScopedTables) {
      await client.query(`ALTER TABLE IF EXISTS "${table}" ENABLE ROW LEVEL SECURITY`);
    }

    // Drop and recreate RLS policies for tenants table
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON tenants;
      CREATE POLICY tenant_isolation ON tenants
        USING (id::text = current_setting('app.tenant_id', true))
        WITH CHECK (id::text = current_setting('app.tenant_id', true));
    `);

    // tenant_memberships
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON tenant_memberships;
      CREATE POLICY tenant_isolation ON tenant_memberships
        USING (tenant_id::text = current_setting('app.tenant_id', true))
        WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
    `);

    // audit_logs
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
      CREATE POLICY tenant_isolation ON audit_logs
        USING (tenant_id::text = current_setting('app.tenant_id', true))
        WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
    `);

    // roles (nullable tenant_id for system roles — allow when tenant_id is null OR matches)
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON roles;
      CREATE POLICY tenant_isolation ON roles
        USING (
          tenant_id IS NULL
          OR tenant_id::text = current_setting('app.tenant_id', true)
        )
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id::text = current_setting('app.tenant_id', true)
        );
    `);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Row-Level Security utilities for Forge ERP.
 *
 * Two-layer tenant isolation:
 * 1. Application layer (primary): all tenant-scoped queries must include
 *    `.where(eq(table.tenantId, tenantId))` in the route handler.
 * 2. DB layer (defense-in-depth): `withTenantDb()` executes queries inside a
 *    transaction where `SET LOCAL app.tenant_id = <id>` scopes the RLS policy.
 *    Always use `withTenantDb` for tenant-scoped mutations and reads.
 *
 * Bootstrap queries (e.g. tenant resolution) use `adminPool` directly since
 * `app.tenant_id` cannot be set before the tenant is known.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "./schema";
import { pool, adminPool } from "./index";

/**
 * Executes `callback` inside a transaction where `app.tenant_id` is set
 * locally, scoping RLS policies to the given tenant. Commits on success,
 * rolls back on error.
 */
export async function withTenantDb<T>(
  tenantId: number,
  callback: (txDb: NodePgDatabase<typeof schema> & { $client: PoolClient }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const txDb = drizzle(client, { schema });
    await client.query("BEGIN");
    await client.query("SET LOCAL row_security = on");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [tenantId.toString()],
    );
    const result = await callback(txDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Idempotent startup function: enables RLS on all tenant-scoped tables and
 * creates/replaces `tenant_isolation` policies. Called once at server boot.
 */
export async function applyRLSPolicies(): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");

    // Sync forge_app password if the env var is present (idempotent).
    const forgeAppPw = process.env.FORGE_APP_DB_PASSWORD;
    if (forgeAppPw) {
      const escapedPw = forgeAppPw.replace(/'/g, "''");
      await client.query(`ALTER ROLE forge_app WITH PASSWORD '${escapedPw}'`);
    }

    // Grant forge_app full DML on every user table and all sequences.
    // Running GRANT on every startup is idempotent and ensures newly-created
    // tables (e.g. after schema migrations) are always accessible.
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA public TO forge_app;
      GRANT USAGE, SELECT
        ON ALL SEQUENCES IN SCHEMA public TO forge_app;
    `);

    const tenantScopedTables = [
      // Core tables
      "tenants",
      "tenant_memberships",
      "audit_logs",
      "roles",
      // Procurement tables
      "approval_workflows",
      "approval_steps",
      "approval_decisions",
      "purchase_requisitions",
      "requisition_lines",
      "purchase_orders",
      "po_lines",
      "po_receipts",
      "receipt_lines",
      "po_returns",
      "po_return_lines",
      "inventory_stock",
      "inventory_movements",
      "gl_postings",
    ];

    for (const table of tenantScopedTables) {
      // ENABLE ROW LEVEL SECURITY activates RLS.
      // FORCE ROW LEVEL SECURITY ensures RLS applies even to the table owner
      // and superusers — required when the DB user has BYPASSRLS privilege.
      await client.query(`
        ALTER TABLE IF EXISTS "${table}" ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS "${table}" FORCE ROW LEVEL SECURITY;
      `);
    }

    // tenants: only the exact tenant row is visible
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON tenants;
      CREATE POLICY tenant_isolation ON tenants
        USING (id::text = COALESCE(current_setting('app.tenant_id', true), ''))
        WITH CHECK (id::text = COALESCE(current_setting('app.tenant_id', true), ''));
    `);

    // tenant_memberships
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON tenant_memberships;
      CREATE POLICY tenant_isolation ON tenant_memberships
        USING (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''))
        WITH CHECK (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''));
    `);

    // audit_logs
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
      CREATE POLICY tenant_isolation ON audit_logs
        USING (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''))
        WITH CHECK (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''));
    `);

    // roles: system roles (tenant_id IS NULL) are visible to all tenants
    await client.query(`
      DROP POLICY IF EXISTS tenant_isolation ON roles;
      CREATE POLICY tenant_isolation ON roles
        USING (
          tenant_id IS NULL
          OR tenant_id::text = COALESCE(current_setting('app.tenant_id', true), '')
        )
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id::text = COALESCE(current_setting('app.tenant_id', true), '')
        );
    `);

    // All procurement + inventory + GL tables use the standard tenant_id pattern
    const standardTenantTables = [
      "approval_workflows",
      "approval_steps",
      "approval_decisions",
      "purchase_requisitions",
      "requisition_lines",
      "purchase_orders",
      "po_lines",
      "po_receipts",
      "receipt_lines",
      "po_returns",
      "po_return_lines",
      "inventory_stock",
      "inventory_movements",
      "gl_postings",
    ];
    for (const table of standardTenantTables) {
      await client.query(`
        DROP POLICY IF EXISTS tenant_isolation ON "${table}";
        CREATE POLICY tenant_isolation ON "${table}"
          USING (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''))
          WITH CHECK (tenant_id::text = COALESCE(current_setting('app.tenant_id', true), ''));
      `);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

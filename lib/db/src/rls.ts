/**
 * Row-Level Security utilities for Forge ERP.
 *
 * ## Isolation strategy (two layers)
 *
 * ### Layer 1 — Application-layer filtering (PRIMARY)
 * Every tenant-scoped query MUST include `.where(eq(table.tenantId, req.tenantId))`.
 * `tenantContext` middleware resolves `req.tenantId` from the active JWT claim or
 * DB membership lookup before any route handler executes.
 * This is the primary, always-active enforcement mechanism.
 *
 * ### Layer 2 — PostgreSQL RLS (DEFENSE-IN-DEPTH)
 * RLS policies are applied to tenant-scoped tables via `applyRLSPolicies()`.
 * Policies read the `app.tenant_id` session GUC variable.
 * Because the API server uses a connection pool, callers MUST use `withTenantDb()`
 * to execute queries inside a transaction where the GUC is SET LOCAL before any
 * query runs. This prevents stale context from one request bleeding into another.
 *
 * ⚠️  Never call `set_config('app.tenant_id', ..., false)` on a pooled connection
 *     outside of a transaction — it persists on the connection after the request
 *     ends, creating a cross-request data leakage risk.
 *
 * ### Usage pattern for tenant-scoped route handlers
 *
 * ```typescript
 * router.get("/example", tenantContext, async (req, res) => {
 *   const { tenantId } = req as TenantRequest;
 *   await withTenantDb(tenantId, async (txDb) => {
 *     const rows = await txDb
 *       .select()
 *       .from(someTable)
 *       .where(eq(someTable.tenantId, tenantId)); // app-layer filter (always)
 *     res.json(rows);
 *   });
 * });
 * ```
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "./schema";
import { pool, adminPool } from "./index";

/**
 * withTenantDb
 *
 * Executes `callback` inside a READ-COMMITTED transaction on a dedicated
 * connection. Before any query runs, `SET LOCAL app.tenant_id = tenantId`
 * scopes the RLS policy to the current tenant for the duration of the
 * transaction. The setting is automatically cleared when the transaction
 * ends (LOCAL = transaction-scoped only).
 *
 * All queries in `callback` MUST still include explicit `.where(tenantId)`
 * clauses — RLS is defense-in-depth, not a substitute for app-layer filters.
 */
export async function withTenantDb<T>(
  tenantId: number,
  callback: (txDb: NodePgDatabase<typeof schema> & { $client: PoolClient }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const txDb = drizzle(client, { schema });
    await client.query("BEGIN");
    // Reset row_security in case a previous session on this pooled connection
    // had SET row_security = off. This ensures RLS is always enforced.
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
 * applyRLSPolicies
 *
 * Idempotent: enables RLS on all tenant-scoped tables and creates/replaces
 * `tenant_isolation` policies. Safe to run at server startup.
 *
 * Called once during `artifacts/api-server/src/index.ts` boot sequence.
 */
export async function applyRLSPolicies(): Promise<void> {
  // Use adminPool (superuser) to manage RLS policies
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");

    const tenantScopedTables = [
      "tenants",
      "tenant_memberships",
      "audit_logs",
      "roles",
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

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

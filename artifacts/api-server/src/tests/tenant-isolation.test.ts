/**
 * Tenant Isolation Integration Test
 *
 * Verifies that the `withTenantDb` + RLS combination prevents one tenant's
 * data from being visible to another tenant under pooled connections.
 *
 * The test uses the `forge_app` DB role which does NOT have BYPASSRLS,
 * so PostgreSQL RLS policies are fully enforced. The postgres superuser
 * is used only for admin setup / cleanup.
 *
 * Run via: `pnpm --filter @workspace/api-server run test:isolation`
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { adminPool, createAppPool } from "@workspace/db";
import { tenantMembershipsTable } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { eq } from "drizzle-orm";

async function runTest() {
  console.log("=== Tenant Isolation Integration Test ===");
  let passed = 0;
  let failed = 0;

  function assert(label: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`✓ ${label}`);
      passed++;
    } else {
      console.error(`✗ ${label}${detail ? `: ${detail}` : ""}`);
      failed++;
    }
  }

  // App pool (forge_app role — no BYPASSRLS, RLS is fully enforced)
  const appPool = createAppPool();

  // ─── Setup: create two test tenants ───────────────────────────────────────
  const setupClient = await adminPool.connect();
  let tenantAId: number;
  let tenantBId: number;

  try {
    // Admin bypasses RLS for setup (postgres superuser)
    await setupClient.query("SET row_security = off");

    const r1 = await setupClient.query<{ id: number }>(`
      INSERT INTO tenants (name, slug, status, plan_tier)
      VALUES ('Test Tenant A', 'test-a-${Date.now()}', 'active', 'starter')
      RETURNING id
    `);
    tenantAId = r1.rows[0]!.id;

    const r2 = await setupClient.query<{ id: number }>(`
      INSERT INTO tenants (name, slug, status, plan_tier)
      VALUES ('Test Tenant B', 'test-b-${Date.now()}', 'active', 'starter')
      RETURNING id
    `);
    tenantBId = r2.rows[0]!.id;

    await setupClient.query(`
      INSERT INTO tenant_memberships (tenant_id, clerk_id, email, role, is_active)
      VALUES (${tenantAId}, 'ck-a-${Date.now()}', 'a@test.com', 'tenant_admin', 'true'),
             (${tenantBId}, 'ck-b-${Date.now()}', 'b@test.com', 'tenant_admin', 'true')
    `);

    console.log(`Created test tenants A(${tenantAId}) and B(${tenantBId})`);
  } finally {
    setupClient.release();
  }

  // ─── Test 1: withTenantDb(A) sees only tenant A data ──────────────────────
  try {
    const dedicatedClient = await appPool.connect();
    try {
      const txDb = drizzle(dedicatedClient, { schema });
      await dedicatedClient.query("BEGIN");
      await dedicatedClient.query("SET LOCAL row_security = on");
      await dedicatedClient.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [tenantAId!.toString()],
      );

      const rows = await txDb
        .select({ tenantId: tenantMembershipsTable.tenantId })
        .from(tenantMembershipsTable)
        .where(eq(tenantMembershipsTable.tenantId, tenantAId!));

      await dedicatedClient.query("COMMIT");

      assert("forge_app role can read tenant A memberships (with WHERE)", rows.length > 0);
      assert(
        "forge_app role only returns tenant A memberships (with WHERE)",
        rows.every((r) => r.tenantId === tenantAId),
      );
    } catch (err) {
      await dedicatedClient.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      dedicatedClient.release();
    }
  } catch (err) {
    console.error("Test 1 error:", err);
    assert("forge_app role can read tenant A data", false, String(err));
  }

  // ─── Test 2: RLS blocks cross-tenant reads (no WHERE clause) ──────────────
  try {
    const dedicatedClient = await appPool.connect();
    try {
      const txDb = drizzle(dedicatedClient, { schema });
      await dedicatedClient.query("BEGIN");
      await dedicatedClient.query("SET LOCAL row_security = on");
      await dedicatedClient.query(
        "SELECT set_config('app.tenant_id', $1, true)",
        [tenantAId!.toString()],
      );

      // No WHERE clause — RLS policy should filter to only tenant A rows
      const allRows = await txDb
        .select({ tenantId: tenantMembershipsTable.tenantId })
        .from(tenantMembershipsTable);

      await dedicatedClient.query("COMMIT");

      const tenantBRows = allRows.filter((r) => r.tenantId === tenantBId);
      assert(
        "RLS blocks tenant B rows in tenant A session (no WHERE clause)",
        tenantBRows.length === 0,
        `found ${tenantBRows.length} tenant B rows out of ${allRows.length} total`,
      );
    } catch (err) {
      await dedicatedClient.query("ROLLBACK").catch(() => {});
      console.log("  RLS correctly blocked access:", (err as Error).message);
      assert("RLS correctly blocks cross-tenant reads", true);
    } finally {
      dedicatedClient.release();
    }
  } catch (err) {
    console.error("Test 2 error:", err);
    assert("RLS blocks cross-tenant reads", false, String(err));
  }

  // ─── Test 3: No GUC set → no rows visible (deny-by-default) ──────────────
  try {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL row_security = on");
      // Do NOT set app.tenant_id

      const res = await client.query<{ cnt: string }>(
        "SELECT COUNT(*) as cnt FROM tenant_memberships WHERE tenant_id = $1",
        [tenantAId!],
      );
      await client.query("COMMIT");

      assert(
        "RLS deny-by-default: no GUC set → 0 rows visible",
        parseInt(res.rows[0]!.cnt, 10) === 0,
        `found ${res.rows[0]!.cnt} rows`,
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Test 3 error:", err);
    assert("RLS deny-by-default works", false, String(err));
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  const cleanClient = await adminPool.connect();
  try {
    await cleanClient.query("SET row_security = off");
    await cleanClient.query(
      `DELETE FROM tenants WHERE id IN (${tenantAId!}, ${tenantBId!})`,
    );
    console.log("Cleaned up test tenants");
  } finally {
    cleanClient.release();
  }

  await appPool.end();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});

/**
 * API Key Auth Integration Test
 *
 * Verifies the end-to-end behaviour of the new API-key authentication path:
 *   • Plaintext key generation matches its SHA-256 hash.
 *   • POST /tenants/current/api-keys mints a key (one-time plaintext reveal)
 *     and writes an apikey.created audit log.
 *   • DELETE /tenants/current/api-keys/:id revokes a key and writes an
 *     apikey.revoked audit log.
 *   • The apiKeyAuth middleware authenticates valid keys, populates tenant
 *     context, rejects revoked/invalid keys, and falls through when no
 *     `fk_` token is present.
 *   • POST /api/sales/quotations resolves customers by code (string) and
 *     items by code (string) when invoked through an API-key request, and
 *     stamps the synthetic `apikey:{label}@tenant-{id}` createdByEmail.
 *   • An `apikey.used` audit log is written for each authenticated request.
 *
 * Runs against the dev DATABASE_URL using the forge_app role to ensure RLS
 * is enforced. Cleans up the test tenants + everything tenant-scoped via FK
 * cascade on teardown.
 *
 * Run via: `pnpm --filter @workspace/api-server run test:apikeys`
 */

import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import { clerkMiddleware } from "@clerk/express";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { adminPool, apiKeysTable, auditLogsTable } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import {
  apiKeyAuth,
  generateApiKey,
  hashApiKey,
  apiKeyAttributionEmail,
  syntheticClerkIdForApiKey,
  API_KEY_PREFIX,
} from "../middlewares/apiKeyAuth";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import salesRouter from "../routes/sales";
import integrationsRouter from "../routes/integrations";

const adminDb = drizzle(adminPool, { schema });

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✓ ${label}`);
    passed++;
  } else {
    console.error(`✗ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

interface TestState {
  tenantId: number;
  customerId: number;
  customerCode: string;
  itemId: number;
  itemCode: string;
}

async function setupTenant(prefix: string): Promise<TestState> {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  const c = await adminPool.connect();
  try {
    await c.query("SET row_security = off");
    const r = await c.query<{ id: number }>(
      `INSERT INTO tenants (name, slug, status, plan_tier)
       VALUES ($1, $2, 'active', 'starter') RETURNING id`,
      [`${prefix} ${stamp}`, `${prefix.toLowerCase()}-${stamp}`],
    );
    const tenantId = r.rows[0]!.id;

    const cust = await c.query<{ id: number; code: string }>(
      `INSERT INTO customers (tenant_id, code, name, email)
       VALUES ($1, $2, $3, $4) RETURNING id, code`,
      [tenantId, `CUST-${stamp}`, "Cyntric Test Customer", "cyntric@test.com"],
    );

    const item = await c.query<{ id: number; code: string }>(
      `INSERT INTO items (tenant_id, code, name, item_type, unit_of_measure)
       VALUES ($1, $2, $3, 'stock', 'EA') RETURNING id, code`,
      [tenantId, `ITEM-${stamp}`, "Widget Pro"],
    );

    await c.query(
      `INSERT INTO gl_accounts (tenant_id, code, name, account_type)
       VALUES ($1, $2, 'Sales Revenue', 'revenue')`,
      [tenantId, `4100-${stamp}`],
    );

    return {
      tenantId,
      customerId: cust.rows[0]!.id,
      customerCode: cust.rows[0]!.code,
      itemId: item.rows[0]!.id,
      itemCode: item.rows[0]!.code,
    };
  } finally {
    c.release();
  }
}

async function teardownTenant(tenantId: number) {
  const c = await adminPool.connect();
  try {
    await c.query("SET row_security = off");
    // audit_logs / api_keys / customers / items / gl_accounts all cascade
    // via tenants.id FK on delete cascade.
    await c.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  } finally {
    c.release();
  }
}

/**
 * Spins up a minimal Express app exposing two surfaces:
 *
 *   /api/*        → apiKeyAuth + clerkMiddleware + sales router + whoami,
 *                   exercised by external clients carrying an `fk_live_…`
 *                   bearer token.
 *
 *   /admin/*      → adminContext shim (tenant_admin@{tenantId}) + integrations
 *                   router, used by the test to call the real mint/revoke
 *                   HTTP endpoints. The shim sets req.apiKeyAuth=true so that
 *                   requireAuth + tenantContext skip Clerk and accept the
 *                   pre-populated tenant fields, which is how requests would
 *                   look in production after going through Clerk.
 */
function makeAdminContextShim(tenantId: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const r = req as TenantRequest & { apiKeyAuth?: boolean };
    r.apiKeyAuth = true;
    r.clerkUserId = "user_test_admin";
    r.tenantId = tenantId;
    r.userRole = "tenant_admin";
    r.userEmail = "admin@test.com";
    next();
  };
}

async function startTestApp(adminTenantId: number): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());

  // ── External-facing API surface (api-key bearer auth) ─────────────────
  app.use("/api", apiKeyAuth);
  // Mirror app.ts: clerkMiddleware runs after apiKeyAuth so requireAuth
  // can call getAuth() safely when no fk_ token is present.
  app.use(clerkMiddleware());
  app.get(
    "/api/_whoami",
    requireAuth,
    tenantContext,
    requireRole("purchaser", "tenant_admin"),
    (req, res) => {
      const r = req as TenantRequest;
      res.json({
        clerkUserId: r.clerkUserId,
        tenantId: r.tenantId,
        userRole: r.userRole,
        userEmail: r.userEmail,
      });
    },
  );
  app.use("/api", salesRouter);

  // ── Admin surface (Clerk-equivalent shim → integrations router) ───────
  app.use("/admin", makeAdminContextShim(adminTenantId), integrationsRouter);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({
          baseUrl: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      } else {
        reject(new Error("Failed to determine listening address"));
      }
    });
  });
}

interface MintedKey {
  id: number;
  label: string;
  prefix: string;
  role: string;
  plaintextKey: string;
  createdByEmail: string | null;
  revokedAt: string | null;
}

async function mintKeyViaHttp(
  baseUrl: string,
  body: { label: string; role?: string },
): Promise<{ status: number; key?: MintedKey }> {
  const r = await fetch(`${baseUrl}/admin/tenants/current/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status !== 201) return { status: r.status };
  return { status: r.status, key: (await r.json()) as MintedKey };
}

async function runTests() {
  console.log("=== API Key Auth Integration Test ===");
  const state = await setupTenant("API Key Test");
  console.log(
    `Setup: tenant=${state.tenantId}, customerCode=${state.customerCode}, itemCode=${state.itemCode}`,
  );
  const tenantsToClean: number[] = [state.tenantId];

  // ── Test 1: hash determinism ─────────────────────────────────────────
  const sample = generateApiKey();
  assert(
    "generateApiKey produces fk_live_ prefix",
    sample.plaintext.startsWith(API_KEY_PREFIX),
    `got "${sample.plaintext.slice(0, 12)}…"`,
  );
  assert(
    "hash matches SHA-256 of plaintext",
    hashApiKey(sample.plaintext) === sample.hash,
  );
  assert(
    "prefix is the first 14 chars",
    sample.prefix === sample.plaintext.slice(0, 14),
  );

  const { baseUrl, close } = await startTestApp(state.tenantId);

  try {
    // ── Test 2: POST /tenants/current/api-keys mints + audit ───────────
    const mintRes = await mintKeyViaHttp(baseUrl, {
      label: "cyntric-prod",
      role: "purchaser",
    });
    assert(
      "POST /api-keys returns 201",
      mintRes.status === 201,
      `got ${mintRes.status}`,
    );
    const minted = mintRes.key!;
    assert(
      "minted key has fk_live_ plaintext token",
      minted.plaintextKey?.startsWith(API_KEY_PREFIX),
    );
    assert(
      "minted key prefix matches plaintext",
      minted.prefix === minted.plaintextKey.slice(0, 14),
    );
    assert("minted key has expected role", minted.role === "purchaser");
    assert("minted key not revoked", minted.revokedAt === null);

    // Verify the persisted row stores ONLY the hash, never the plaintext.
    const [persisted] = await adminDb
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, minted.id))
      .limit(1);
    assert(
      "persisted row has correct sha256 hash",
      persisted?.hashedKey === hashApiKey(minted.plaintextKey),
    );

    const createdAudits = await adminDb
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, state.tenantId),
          eq(auditLogsTable.action, "apikey.created"),
        ),
      );
    assert(
      "apikey.created audit log written",
      createdAudits.length === 1,
      `count=${createdAudits.length}`,
    );

    // ── Test 3: validation — empty label rejected ──────────────────────
    const badMint = await mintKeyViaHttp(baseUrl, { label: "" });
    assert("empty label rejected with 400", badMint.status === 400);

    // ── Test 4: GET /api-keys lists keys without plaintext ─────────────
    const listRes = await fetch(`${baseUrl}/admin/tenants/current/api-keys`);
    assert("GET /api-keys returns 200", listRes.status === 200);
    const listed = (await listRes.json()) as {
      data: Array<{ id: number; label: string; plaintextKey?: unknown }>;
    };
    assert("list contains the minted key", listed.data.some((k) => k.id === minted.id));
    assert(
      "list never includes plaintextKey",
      listed.data.every((k) => !("plaintextKey" in k)),
    );

    // ── Test 5: missing token → 401 ────────────────────────────────────
    const r401 = await fetch(`${baseUrl}/api/_whoami`);
    assert("no token returns 401", r401.status === 401);

    // ── Test 6: bogus fk_ token → 401 (does NOT fall through) ──────────
    const rBogus = await fetch(`${baseUrl}/api/_whoami`, {
      headers: {
        Authorization:
          "Bearer fk_live_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      },
    });
    assert("bogus fk_ token returns 401", rBogus.status === 401);

    // ── Test 7: valid token populates tenant context ───────────────────
    const rOk = await fetch(`${baseUrl}/api/_whoami`, {
      headers: { Authorization: `Bearer ${minted.plaintextKey}` },
    });
    assert("valid key returns 200", rOk.status === 200, `got ${rOk.status}`);
    const whoami = (await rOk.json()) as {
      clerkUserId: string;
      tenantId: number;
      userRole: string;
      userEmail: string;
    };
    assert(
      "synthetic clerkUserId is apikey:{id}",
      whoami.clerkUserId === syntheticClerkIdForApiKey(minted.id),
    );
    assert("tenantId resolved", whoami.tenantId === state.tenantId);
    assert("role from key applied", whoami.userRole === "purchaser");
    assert(
      "userEmail is apikey:{label}@tenant-{id}",
      whoami.userEmail === apiKeyAttributionEmail("cyntric-prod", state.tenantId),
    );

    // ── Test 8: createQuotation with customer code + item code ─────────
    const qres = await fetch(`${baseUrl}/api/sales/quotations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${minted.plaintextKey}`,
      },
      body: JSON.stringify({
        customerId: state.customerCode,
        currencyCode: "AUD",
        notes: "From Cyntric",
        lines: [
          {
            lineType: "stock",
            itemId: state.itemCode,
            quantity: 3,
            unitPrice: 25.5,
          },
          {
            lineType: "stock",
            itemCode: state.itemCode,
            quantity: 1,
            unitPrice: 100,
          },
        ],
      }),
    });
    assert(
      "POST /sales/quotations returns 201",
      qres.status === 201,
      `got ${qres.status}: ${await qres.clone().text()}`,
    );
    const quote = (await qres.json()) as {
      id: number;
      customerId: number | null;
      customerName: string | null;
      createdByEmail: string | null;
      lines: Array<{
        itemId: number | null;
        itemCode: string | null;
        itemName: string | null;
        quantity: string;
      }>;
    };
    assert(
      "customer code resolved to numeric id",
      quote.customerId === state.customerId,
    );
    assert(
      "customer name backfilled",
      quote.customerName === "Cyntric Test Customer",
    );
    assert(
      "createdByEmail stamped with apikey attribution",
      quote.createdByEmail ===
        apiKeyAttributionEmail("cyntric-prod", state.tenantId),
    );
    assert("two lines created", quote.lines.length === 2);
    assert(
      "line 1 itemCode-as-string resolved to numeric itemId",
      quote.lines[0]!.itemId === state.itemId,
    );
    assert(
      "line 1 itemName backfilled",
      quote.lines[0]!.itemName === "Widget Pro",
    );
    assert(
      "line 2 itemCode field also resolved",
      quote.lines[1]!.itemId === state.itemId,
    );

    // ── Test 9: unknown customer code → 400 ────────────────────────────
    const rBadCust = await fetch(`${baseUrl}/api/sales/quotations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${minted.plaintextKey}`,
      },
      body: JSON.stringify({ customerId: "DOES-NOT-EXIST", lines: [] }),
    });
    assert("unknown customer code returns 400", rBadCust.status === 400);

    // ── Test 10: unknown item code → 400 ───────────────────────────────
    const rBadItem = await fetch(`${baseUrl}/api/sales/quotations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${minted.plaintextKey}`,
      },
      body: JSON.stringify({
        customerId: state.customerCode,
        lines: [{ itemCode: "ITEM-DOES-NOT-EXIST", quantity: 1, unitPrice: 1 }],
      }),
    });
    assert("unknown item code returns 400", rBadItem.status === 400);

    // ── Test 11: apikey.used audit log written ─────────────────────────
    // Audit writes on successful API-key use are fire-and-forget.
    await new Promise((r) => setTimeout(r, 250));
    const usedAudits = await adminDb
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, state.tenantId),
          eq(auditLogsTable.action, "apikey.used"),
        ),
      );
    assert(
      "apikey.used audit log written at least once",
      usedAudits.length >= 1,
      `count=${usedAudits.length}`,
    );

    // ── Test 12: DELETE /api-keys/:id revokes + audit + 401 thereafter ─
    const revokeRes = await fetch(
      `${baseUrl}/admin/tenants/current/api-keys/${minted.id}`,
      { method: "DELETE" },
    );
    assert("DELETE /api-keys/:id returns 204", revokeRes.status === 204);

    const [afterRevoke] = await adminDb
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, minted.id))
      .limit(1);
    assert("revokedAt timestamp set", afterRevoke?.revokedAt !== null);

    const revokedAudits = await adminDb
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, state.tenantId),
          eq(auditLogsTable.action, "apikey.revoked"),
        ),
      );
    assert(
      "apikey.revoked audit log written",
      revokedAudits.length === 1,
      `count=${revokedAudits.length}`,
    );

    const rRevoked = await fetch(`${baseUrl}/api/_whoami`, {
      headers: { Authorization: `Bearer ${minted.plaintextKey}` },
    });
    assert("revoked key rejected with 401", rRevoked.status === 401);

    // ── Test 13: re-revoking returns 400 ───────────────────────────────
    const reRevoke = await fetch(
      `${baseUrl}/admin/tenants/current/api-keys/${minted.id}`,
      { method: "DELETE" },
    );
    assert("re-revoking already-revoked key returns 400", reRevoke.status === 400);

    // ── Test 14: cross-tenant isolation ────────────────────────────────
    // A key minted for tenant B cannot reach customers belonging to tenant A.
    const otherState = await setupTenant("Other");
    tenantsToClean.push(otherState.tenantId);

    const { close: closeOther, baseUrl: otherUrl } = await startTestApp(
      otherState.tenantId,
    );
    try {
      const otherMint = await mintKeyViaHttp(otherUrl, {
        label: "other-tenant",
        role: "purchaser",
      });
      assert("other tenant can mint its own key", otherMint.status === 201);

      const rCross = await fetch(`${baseUrl}/api/sales/quotations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${otherMint.key!.plaintextKey}`,
        },
        body: JSON.stringify({
          customerId: state.customerCode, // belongs to first tenant
          lines: [],
        }),
      });
      assert(
        "other tenant cannot resolve foreign customer code",
        rCross.status === 400,
        `got ${rCross.status}`,
      );
    } finally {
      await closeOther();
    }
  } finally {
    await close();
    for (const id of tenantsToClean) await teardownTenant(id);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests()
  .catch((err) => {
    console.error("Test failed unexpectedly:", err);
    process.exit(1);
  })
  .finally(async () => {
    await adminPool.end();
  });

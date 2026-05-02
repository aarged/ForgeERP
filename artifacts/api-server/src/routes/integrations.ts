import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import { adminPool, apiKeysTable } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { generateApiKey } from "../middlewares/apiKeyAuth";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const adminMiddleware = [requireAuth, tenantContext, requireRole("tenant_admin")];

const tenantApiRoles = z.enum([
  "tenant_admin",
  "purchaser",
  "warehouse",
  "approver",
  "accountant",
  "viewer",
]);

/**
 * Public-facing API key summary. The plaintext key is NEVER returned by the
 * list endpoint — only the prefix (first 14 chars) so admins can identify
 * which key is which without leaking the secret.
 */
function toSummary(row: typeof apiKeysTable.$inferSelect) {
  return {
    id: row.id,
    label: row.label,
    prefix: row.prefix,
    role: row.role,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedByEmail: row.revokedByEmail,
  };
}

// ── GET /tenants/current/api-keys — list keys for the current tenant ────────
router.get(
  "/tenants/current/api-keys",
  ...adminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;
    const rows = await adminDb
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.tenantId, tenantId))
      .orderBy(desc(apiKeysTable.createdAt));
    res.json({ data: rows.map(toSummary) });
  },
);

// ── POST /tenants/current/api-keys — mint a new key (one-time reveal) ───────
router.post(
  "/tenants/current/api-keys",
  ...adminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const schema = z.object({
      label: z.string().min(1).max(100),
      role: tenantApiRoles.default("purchaser"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }
    const { label, role } = parsed.data;

    const { plaintext, hash, prefix } = generateApiKey();
    const [created] = await adminDb
      .insert(apiKeysTable)
      .values({
        tenantId,
        label,
        prefix,
        hashedKey: hash,
        role,
        createdByClerkId: clerkUserId,
        createdByEmail: userEmail,
      })
      .returning();

    await writeAuditLog({
      req,
      actorClerkId: clerkUserId,
      actorEmail: userEmail,
      tenantId,
      action: "apikey.created",
      entityType: "api_key",
      entityId: String(created!.id),
      newValues: { label, role, prefix },
    });

    // The plaintext key is returned exactly once — the client surfaces a
    // copy-to-clipboard dialog and the value is never persisted server-side
    // anywhere except as a SHA-256 hash.
    res.status(201).json({
      ...toSummary(created!),
      plaintextKey: plaintext,
    });
  },
);

// ── DELETE /tenants/current/api-keys/:id — revoke a key ─────────────────────
router.delete(
  "/tenants/current/api-keys/:id",
  ...adminMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid key id" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(apiKeysTable)
      .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.tenantId, tenantId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    if (existing.revokedAt) {
      res.status(400).json({ error: "API key is already revoked" });
      return;
    }

    await adminDb
      .update(apiKeysTable)
      .set({
        revokedAt: new Date(),
        revokedByClerkId: clerkUserId,
        revokedByEmail: userEmail,
      })
      .where(eq(apiKeysTable.id, id));

    await writeAuditLog({
      req,
      actorClerkId: clerkUserId,
      actorEmail: userEmail,
      tenantId,
      action: "apikey.revoked",
      entityType: "api_key",
      entityId: String(id),
      newValues: { label: existing.label, prefix: existing.prefix },
    });

    res.status(204).send();
  },
);

export default router;

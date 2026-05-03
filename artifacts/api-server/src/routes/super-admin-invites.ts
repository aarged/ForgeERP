import { Router, type IRouter } from "express";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  adminPool,
  superAdminInvitesTable,
  tenantMembershipsTable,
  tenantsTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import type { Request, Response } from "express";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const superAdminOnly = [requireAuth, tenantContext, requireRole("super_admin")];

// ── URL helpers ───────────────────────────────────────────────────────────────

function buildAllowedOrigins(): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      out.add(new URL(raw).origin);
    } catch {
      /* ignore */
    }
  };
  add(process.env.FRONTEND_URL);
  for (const v of (process.env.FRONTEND_URLS ?? "").split(",")) add(v.trim());
  if (process.env.REPLIT_DEV_DOMAIN)
    add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  return [...out];
}

function resolveFrontendOrigin(req: Request): string | undefined {
  const allowed = buildAllowedOrigins();
  const candidates: string[] = [];
  if (req.headers.origin) candidates.push(req.headers.origin as string);
  if (req.headers.referer) {
    try {
      candidates.push(new URL(req.headers.referer as string).origin);
    } catch {
      /* ignore */
    }
  }
  for (const c of candidates) {
    if (allowed.includes(c)) return c;
  }
  if (allowed.length > 0 && process.env.FRONTEND_URL) {
    try {
      return new URL(process.env.FRONTEND_URL).origin;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function buildInviteUrl(req: Request, token: string): string {
  const origin = resolveFrontendOrigin(req);
  // Forge ERP is mounted at the root of its artifact; the invite landing page
  // path (configured in App.tsx) is /super-admin-invite/:token.
  if (origin) {
    try {
      return new URL(`/super-admin-invite/${token}`, origin).toString();
    } catch {
      /* fallthrough */
    }
  }
  // Fallback: relative path so caller can prefix as needed.
  return `/super-admin-invite/${token}`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const createInviteSchema = z.object({
  email: z.string().email().max(254).optional(),
  ttlHours: z.number().int().min(1).max(24 * 30).optional(),
});

const redeemInviteSchema = z.object({
  token: z.string().min(16).max(128),
});

// ── POST /admin/super-admin-invites ──────────────────────────────────────────

router.post(
  "/admin/super-admin-invites",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const parsed = createInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }

    const ttlHours = parsed.data.ttlHours ?? 72;
    const email = parsed.data.email?.trim().toLowerCase() || null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const [invite] = await adminDb
      .insert(superAdminInvitesTable)
      .values({
        token,
        email,
        createdByClerkId: actor.clerkUserId,
        createdByEmail: actor.userEmail,
        expiresAt,
      })
      .returning();

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      action: "super_admin.invite_created",
      entityType: "super_admin_invite",
      entityId: invite!.id,
      newValues: {
        email,
        expiresAt: expiresAt.toISOString(),
        ttlHours,
      },
    });

    res.status(201).json({
      id: invite!.id,
      token: invite!.token,
      url: buildInviteUrl(req, invite!.token),
      email: invite!.email,
      expiresAt: invite!.expiresAt.toISOString(),
      createdAt: invite!.createdAt.toISOString(),
      createdByEmail: invite!.createdByEmail,
    });
  },
);

// ── GET /admin/super-admin-invites ───────────────────────────────────────────

router.get(
  "/admin/super-admin-invites",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const rows = await adminDb
      .select()
      .from(superAdminInvitesTable)
      .orderBy(desc(superAdminInvitesTable.createdAt))
      .limit(100);

    res.json(
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        url: buildInviteUrl(req, r.token),
        createdAt: r.createdAt.toISOString(),
        createdByEmail: r.createdByEmail,
        expiresAt: r.expiresAt.toISOString(),
        usedAt: r.usedAt?.toISOString() ?? null,
        usedByEmail: r.usedByEmail,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        status: r.usedAt
          ? "used"
          : r.revokedAt
            ? "revoked"
            : r.expiresAt.getTime() < Date.now()
              ? "expired"
              : "active",
      })),
    );
  },
);

// ── DELETE /admin/super-admin-invites/:id ────────────────────────────────────

router.delete(
  "/admin/super-admin-invites/:id",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid invite id" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(superAdminInvitesTable)
      .where(eq(superAdminInvitesTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }

    if (existing.usedAt) {
      res.status(409).json({
        error: "This invite has already been redeemed and cannot be revoked.",
        code: "INVITE_USED",
      });
      return;
    }

    if (existing.revokedAt) {
      res.json({ id: existing.id, alreadyRevoked: true });
      return;
    }

    await adminDb
      .update(superAdminInvitesTable)
      .set({
        revokedAt: new Date(),
        revokedByClerkId: actor.clerkUserId,
      })
      .where(eq(superAdminInvitesTable.id, id));

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      action: "super_admin.invite_revoked",
      entityType: "super_admin_invite",
      entityId: id,
      oldValues: { email: existing.email },
    });

    res.json({ id, revoked: true });
  },
);

// ── GET /super-admin-invites/:token (public preview) ─────────────────────────
//
// Allows the frontend invite landing page to validate a token before asking
// the user to sign in. No auth required — token itself is the secret.
router.get(
  "/super-admin-invites/:token",
  async (req: Request, res: Response): Promise<void> => {
    const token = String(req.params.token ?? "");
    if (!token || token.length < 16) {
      res.status(400).json({ error: "Invalid token", code: "INVALID_TOKEN" });
      return;
    }

    const [invite] = await adminDb
      .select()
      .from(superAdminInvitesTable)
      .where(eq(superAdminInvitesTable.token, token))
      .limit(1);

    if (!invite) {
      res.status(404).json({ error: "Invite not found", code: "NOT_FOUND" });
      return;
    }

    let status: "active" | "used" | "revoked" | "expired";
    if (invite.usedAt) status = "used";
    else if (invite.revokedAt) status = "revoked";
    else if (invite.expiresAt.getTime() < Date.now()) status = "expired";
    else status = "active";

    res.json({
      email: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
      createdByEmail: invite.createdByEmail,
      status,
    });
  },
);

// ── POST /auth/super-admin-invites/redeem ────────────────────────────────────

router.post(
  "/auth/super-admin-invites/redeem",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;
    const parsed = redeemInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }
    const token = parsed.data.token;

    const txResult = await adminDb.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(superAdminInvitesTable)
        .where(eq(superAdminInvitesTable.token, token))
        .for("update")
        .limit(1);

      if (!invite) return { kind: "not_found" as const };
      if (invite.usedAt) return { kind: "used" as const };
      if (invite.revokedAt) return { kind: "revoked" as const };
      if (invite.expiresAt.getTime() < Date.now())
        return { kind: "expired" as const };

      // Find the user's active membership (must have completed onboarding).
      const [membership] = await tx
        .select({
          id: tenantMembershipsTable.id,
          tenantId: tenantMembershipsTable.tenantId,
          email: tenantMembershipsTable.email,
          role: tenantMembershipsTable.role,
        })
        .from(tenantMembershipsTable)
        .where(
          and(
            eq(tenantMembershipsTable.clerkId, clerkId),
            eq(tenantMembershipsTable.isActive, "true"),
          ),
        )
        .limit(1);

      if (!membership) {
        return { kind: "no_membership" as const };
      }

      // If invite is bound to a specific email, enforce it.
      if (
        invite.email &&
        invite.email.toLowerCase() !== membership.email.toLowerCase()
      ) {
        return {
          kind: "email_mismatch" as const,
          expected: invite.email,
          got: membership.email,
        };
      }

      // Promote to super_admin if not already.
      const wasSuperAdmin = membership.role === "super_admin";
      if (!wasSuperAdmin) {
        await tx
          .update(tenantMembershipsTable)
          .set({ role: "super_admin" })
          .where(eq(tenantMembershipsTable.id, membership.id));
      }

      // Mark invite consumed (even if user was already super_admin —
      // single-use semantics are clearer that way).
      await tx
        .update(superAdminInvitesTable)
        .set({
          usedAt: new Date(),
          usedByClerkId: clerkId,
          usedByEmail: membership.email,
        })
        .where(eq(superAdminInvitesTable.id, invite.id));

      return {
        kind: "ok" as const,
        invite,
        membership,
        wasSuperAdmin,
      };
    });

    if (txResult.kind === "not_found") {
      res
        .status(404)
        .json({ error: "Invite not found", code: "NOT_FOUND" });
      return;
    }
    if (txResult.kind === "used") {
      res.status(409).json({
        error: "This invite has already been redeemed.",
        code: "INVITE_USED",
      });
      return;
    }
    if (txResult.kind === "revoked") {
      res
        .status(409)
        .json({ error: "This invite has been revoked.", code: "INVITE_REVOKED" });
      return;
    }
    if (txResult.kind === "expired") {
      res
        .status(409)
        .json({ error: "This invite has expired.", code: "INVITE_EXPIRED" });
      return;
    }
    if (txResult.kind === "no_membership") {
      res.status(412).json({
        error:
          "Finish onboarding first — your invite will activate once you have a workspace.",
        code: "NO_MEMBERSHIP",
      });
      return;
    }
    if (txResult.kind === "email_mismatch") {
      res.status(403).json({
        error: `This invite is bound to ${txResult.expected}, but you are signed in as ${txResult.got}.`,
        code: "EMAIL_MISMATCH",
      });
      return;
    }

    const { invite, membership, wasSuperAdmin } = txResult;

    await writeAuditLog({
      req,
      actorClerkId: clerkId,
      actorEmail: membership.email,
      tenantId: membership.tenantId,
      action: "super_admin.invite_redeemed",
      entityType: "super_admin_invite",
      entityId: invite.id,
      oldValues: { role: membership.role },
      newValues: {
        role: "super_admin",
        membershipId: membership.id,
        tenantId: membership.tenantId,
        wasAlreadySuperAdmin: wasSuperAdmin,
      },
    });

    logger.info(
      {
        clerkId,
        inviteId: invite.id,
        membershipId: membership.id,
        wasSuperAdmin,
      },
      "Super-admin invite redeemed",
    );

    res.json({
      ok: true,
      wasAlreadySuperAdmin: wasSuperAdmin,
      role: "super_admin",
      tenantId: membership.tenantId,
    });
  },
);

// Suppress unused-import linter in case of future refactors.
void isNull;
void tenantsTable;
void sql;

export default router;

import { Router, type IRouter } from "express";
import { eq, and, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  adminPool,
  tenantsTable,
  tenantMembershipsTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { withTenantDb } from "@workspace/db/rls";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import {
  clerkClient,
  pendingClerkIdForEmail,
  isPendingClerkId,
  resolveInviteRedirectUrl,
  TENANT_ROLES,
} from "../lib/invites";
import type { Request, Response } from "express";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const tenantAdminOnly = [tenantContext, requireRole("tenant_admin")];

const tenantRoleEnum = z.enum(TENANT_ROLES);

router.get(
  "/tenants/current",
  tenantContext,
  requireRole(
    "viewer",
    "purchaser",
    "warehouse",
    "approver",
    "accountant",
    "tenant_admin",
    "super_admin",
  ),
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;

    const tenant = await withTenantDb(tenantId, (txDb) =>
      txDb
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1),
    );

    if (tenant.length === 0) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const t = tenant[0]!;
    res.json({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      planTier: t.planTier,
      currency: t.currency ?? null,
      timezone: t.timezone ?? null,
      fiscalYearStart: t.fiscalYearStart ?? null,
      industryType: t.industryType ?? null,
      onboardingCompletedAt: t.onboardingCompletedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    });
  },
);

// ── GET /tenants/current/members ─────────────────────────────────────────────
// Returns active + pending members. Pending rows have isActive='false' and
// clerkId beginning with `pending:` (per onboarding invite convention).
router.get(
  "/tenants/current/members",
  tenantContext,
  requireRole("tenant_admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { tenantId } = req as TenantRequest;

    const members = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(eq(tenantMembershipsTable.tenantId, tenantId))
      .orderBy(tenantMembershipsTable.joinedAt);

    res.json(
      members.map((m) => {
        const isActive = m.isActive === "true";
        const pending = !isActive && isPendingClerkId(m.clerkId);
        return {
          id: m.id,
          clerkId: m.clerkId,
          email: m.email,
          firstName: m.firstName ?? null,
          lastName: m.lastName ?? null,
          role: m.role,
          isActive,
          status: pending ? "pending" : isActive ? "active" : "inactive",
          joinedAt: m.joinedAt.toISOString(),
        };
      }),
    );
  },
);

// ── POST /tenants/current/invites ────────────────────────────────────────────
// Creates a pending membership row + dispatches a Clerk invitation.
const createInviteSchema = z.object({
  email: z.string().email().max(254),
  role: tenantRoleEnum,
});

router.post(
  "/tenants/current/invites",
  ...tenantAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const role = parsed.data.role;

    // Check for existing membership (active OR pending) on this tenant
    const existing = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(
        and(
          eq(tenantMembershipsTable.tenantId, actor.tenantId),
          eq(tenantMembershipsTable.email, email),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const m = existing[0]!;
      const isPending = m.isActive !== "true" && isPendingClerkId(m.clerkId);
      res.status(409).json({
        error: isPending
          ? "An invitation is already pending for this email."
          : "This email is already a member of this workspace.",
        code: isPending ? "INVITE_ALREADY_PENDING" : "MEMBER_ALREADY_EXISTS",
      });
      return;
    }

    const pendingClerkId = pendingClerkIdForEmail(email);

    // Insert pending membership row first so we have a stable id even if
    // Clerk dispatch fails — caller can resend from the row.
    let inserted: typeof tenantMembershipsTable.$inferSelect;
    try {
      const [row] = await adminDb
        .insert(tenantMembershipsTable)
        .values({
          tenantId: actor.tenantId,
          clerkId: pendingClerkId,
          email,
          role,
          isActive: "false",
        })
        .returning();
      if (!row) throw new Error("Insert returned no row");
      inserted = row;
    } catch (err) {
      logger.error(
        { err, tenantId: actor.tenantId, email },
        "Failed to insert pending membership for invite",
      );
      res.status(500).json({ error: "Failed to create invite" });
      return;
    }

    // Dispatch Clerk invitation (best-effort)
    let delivered = false;
    let clerkInvitationId: string | undefined;
    let reason: string | undefined;
    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        redirectUrl: resolveInviteRedirectUrl(req),
        publicMetadata: {
          pendingTenantId: actor.tenantId,
          pendingRole: role,
        },
        ignoreExisting: true,
        notify: true,
      });
      delivered = true;
      clerkInvitationId = invitation.id;
    } catch (err) {
      reason = err instanceof Error ? err.message : "Unknown invite error";
      logger.error(
        { err, tenantId: actor.tenantId, email },
        "Clerk invitation dispatch failed",
      );
    }

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: actor.tenantId,
      action: "tenant.invite_sent",
      entityType: "tenant_membership",
      entityId: inserted.id,
      newValues: { email, role, delivered, clerkInvitationId, reason },
    });

    res.status(201).json({
      id: inserted.id,
      email,
      role,
      delivered,
      clerkInvitationId: clerkInvitationId ?? null,
      reason: reason ?? null,
    });
  },
);

// ── PATCH /tenants/current/members/:membershipId ─────────────────────────────
// Update role and/or active status. Tenant-scoped roles only (no super_admin).
const updateMemberSchema = z.object({
  role: tenantRoleEnum.optional(),
  isActive: z.boolean().optional(),
});

router.patch(
  "/tenants/current/members/:membershipId",
  ...tenantAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const membershipId = Number(req.params.membershipId);
    if (Number.isNaN(membershipId)) {
      res.status(400).json({ error: "Invalid membership id" });
      return;
    }

    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    if (parsed.data.role === undefined && parsed.data.isActive === undefined) {
      res
        .status(400)
        .json({ error: "Provide at least one of: role, isActive" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(
        and(
          eq(tenantMembershipsTable.id, membershipId),
          eq(tenantMembershipsTable.tenantId, actor.tenantId),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    // Cannot modify super_admin via tenant API
    if (existing.role === "super_admin") {
      res
        .status(403)
        .json({ error: "Super admin members cannot be modified here" });
      return;
    }

    // Cannot modify your own membership (prevent self-lockout / self-demote)
    if (existing.clerkId === actor.clerkUserId) {
      res.status(400).json({
        error:
          "You cannot change your own role or active status. Ask another admin.",
        code: "CANNOT_MODIFY_SELF",
      });
      return;
    }

    // Guard: prevent removing the last active tenant_admin
    const willDemote =
      parsed.data.role !== undefined &&
      parsed.data.role !== "tenant_admin" &&
      existing.role === "tenant_admin";
    const willDeactivate =
      parsed.data.isActive === false && existing.isActive === "true";

    if (
      (willDemote || willDeactivate) &&
      existing.role === "tenant_admin" &&
      existing.isActive === "true"
    ) {
      const [{ count: remaining }] = await adminDb
        .select({ count: sql<number>`count(*)::int` })
        .from(tenantMembershipsTable)
        .where(
          and(
            eq(tenantMembershipsTable.tenantId, actor.tenantId),
            eq(tenantMembershipsTable.role, "tenant_admin"),
            eq(tenantMembershipsTable.isActive, "true"),
            ne(tenantMembershipsTable.id, membershipId),
          ),
        );
      if (Number(remaining) === 0) {
        res.status(400).json({
          error:
            "Cannot demote or deactivate the last active tenant admin. Promote another member first.",
          code: "LAST_ADMIN",
        });
        return;
      }
    }

    const updateFields: Partial<typeof tenantMembershipsTable.$inferInsert> = {};
    if (parsed.data.role !== undefined) updateFields.role = parsed.data.role;
    if (parsed.data.isActive !== undefined)
      updateFields.isActive = parsed.data.isActive ? "true" : "false";

    const [updated] = await adminDb
      .update(tenantMembershipsTable)
      .set(updateFields)
      .where(eq(tenantMembershipsTable.id, membershipId))
      .returning();

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: actor.tenantId,
      action: "tenant_member.updated",
      entityType: "tenant_membership",
      entityId: membershipId,
      oldValues: { role: existing.role, isActive: existing.isActive === "true" },
      newValues: parsed.data,
    });

    const isActiveBool = updated!.isActive === "true";
    const pending = !isActiveBool && isPendingClerkId(updated!.clerkId);
    res.json({
      id: updated!.id,
      clerkId: updated!.clerkId,
      email: updated!.email,
      firstName: updated!.firstName ?? null,
      lastName: updated!.lastName ?? null,
      role: updated!.role,
      isActive: isActiveBool,
      status: pending ? "pending" : isActiveBool ? "active" : "inactive",
      joinedAt: updated!.joinedAt.toISOString(),
    });
  },
);

// ── POST /tenants/current/invites/:membershipId/resend ───────────────────────
router.post(
  "/tenants/current/invites/:membershipId/resend",
  ...tenantAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const membershipId = Number(req.params.membershipId);
    if (Number.isNaN(membershipId)) {
      res.status(400).json({ error: "Invalid membership id" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(
        and(
          eq(tenantMembershipsTable.id, membershipId),
          eq(tenantMembershipsTable.tenantId, actor.tenantId),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (existing.isActive === "true" || !isPendingClerkId(existing.clerkId)) {
      res.status(400).json({
        error: "Only pending invites can be resent.",
        code: "NOT_PENDING",
      });
      return;
    }

    let delivered = false;
    let clerkInvitationId: string | undefined;
    let reason: string | undefined;
    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: existing.email,
        redirectUrl: resolveInviteRedirectUrl(req),
        publicMetadata: {
          pendingTenantId: actor.tenantId,
          pendingRole: existing.role,
        },
        ignoreExisting: true,
        notify: true,
      });
      delivered = true;
      clerkInvitationId = invitation.id;
    } catch (err) {
      reason = err instanceof Error ? err.message : "Unknown invite error";
      logger.error(
        { err, tenantId: actor.tenantId, email: existing.email },
        "Clerk invitation resend failed",
      );
    }

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: actor.tenantId,
      action: "tenant.invite_resent",
      entityType: "tenant_membership",
      entityId: membershipId,
      newValues: {
        email: existing.email,
        role: existing.role,
        delivered,
        clerkInvitationId,
        reason,
      },
    });

    res.json({
      id: existing.id,
      email: existing.email,
      role: existing.role,
      delivered,
      clerkInvitationId: clerkInvitationId ?? null,
      reason: reason ?? null,
    });
  },
);

// ── DELETE /tenants/current/invites/:membershipId ────────────────────────────
// Revokes a pending invite (deletes the membership row + revokes any pending
// Clerk invitations for that email).
router.delete(
  "/tenants/current/invites/:membershipId",
  ...tenantAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const membershipId = Number(req.params.membershipId);
    if (Number.isNaN(membershipId)) {
      res.status(400).json({ error: "Invalid membership id" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(
        and(
          eq(tenantMembershipsTable.id, membershipId),
          eq(tenantMembershipsTable.tenantId, actor.tenantId),
        ),
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (existing.isActive === "true" || !isPendingClerkId(existing.clerkId)) {
      res.status(400).json({
        error:
          "Only pending invites can be revoked. Use deactivate for active members.",
        code: "NOT_PENDING",
      });
      return;
    }

    // Best-effort: revoke any pending Clerk invitations for this email
    try {
      const list = await clerkClient.invitations.getInvitationList({
        status: "pending",
      });
      const matches = list.data.filter(
        (inv: { emailAddress: string }) =>
          inv.emailAddress.toLowerCase() === existing.email.toLowerCase(),
      );
      for (const inv of matches) {
        try {
          await clerkClient.invitations.revokeInvitation(inv.id);
        } catch (err) {
          logger.warn(
            { err, invitationId: inv.id },
            "Failed to revoke Clerk invitation",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, email: existing.email },
        "Failed to list Clerk invitations for revoke",
      );
    }

    await adminDb
      .delete(tenantMembershipsTable)
      .where(eq(tenantMembershipsTable.id, membershipId));

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: actor.tenantId,
      action: "tenant.invite_revoked",
      entityType: "tenant_membership",
      entityId: membershipId,
      oldValues: { email: existing.email, role: existing.role },
    });

    res.status(204).end();
  },
);

export default router;

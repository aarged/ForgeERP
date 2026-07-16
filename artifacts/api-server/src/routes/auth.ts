import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { adminPool, tenantsTable, tenantMembershipsTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { withTenantDb } from "@workspace/db/rls";
import { createClerkClient } from "@clerk/express";

import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { tenantContext, type TenantRequest } from "../middlewares/tenantContext";
import { logger } from "../lib/logger";
import { writeAuditLog } from "../lib/audit";
import type { Request, Response } from "express";

const adminDb = drizzle(adminPool, { schema });

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

const router: IRouter = Router();

/**
 * Convert any pending tenant_memberships rows for this user (matched by
 * verified email or by `pendingTenantId` in Clerk publicMetadata) into a
 * real, active membership tied to their Clerk id.
 *
 * This is the "acceptance path" for the onboarding invite flow: when a
 * teammate clicks the email Clerk sent and finishes signing up, their first
 * /auth/me call lands here and they're automatically attached to the tenant
 * they were invited to. Idempotent — safe to call on every request.
 */
async function claimPendingInvitesForUser(clerkId: string): Promise<void> {
  let email: string | undefined;
  let firstName: string | null | undefined;
  let lastName: string | null | undefined;
  let publicMetadata: Record<string, unknown> = {};
  try {
    const u = await clerk.users.getUser(clerkId);
    const primary =
      u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ??
      u.emailAddresses[0];
    email = primary?.emailAddress?.toLowerCase();
    firstName = u.firstName ?? null;
    lastName = u.lastName ?? null;
    publicMetadata = (u.publicMetadata ?? {}) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { err, clerkId },
      "claimPendingInvitesForUser: failed to fetch Clerk user",
    );
    return;
  }
  if (!email) return;

  const placeholderClerkId = `pending:${email}`;
  const pending = await adminDb
    .select({
      id: tenantMembershipsTable.id,
      tenantId: tenantMembershipsTable.tenantId,
      role: tenantMembershipsTable.role,
      email: tenantMembershipsTable.email,
    })
    .from(tenantMembershipsTable)
    .where(
      and(
        eq(tenantMembershipsTable.clerkId, placeholderClerkId),
        eq(tenantMembershipsTable.isActive, "false"),
      ),
    );

  if (pending.length === 0) return;

  for (const row of pending) {
    await adminDb
      .update(tenantMembershipsTable)
      .set({
        clerkId,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        isActive: "true",
      })
      .where(eq(tenantMembershipsTable.id, row.id));

    await writeAuditLog({
      actorClerkId: clerkId,
      actorEmail: email,
      tenantId: row.tenantId,
      action: "tenant.invite_accepted",
      entityType: "tenant_membership",
      entityId: row.id,
      newValues: { role: row.role, email },
    });
    logger.info(
      { clerkId, tenantId: row.tenantId, email, role: row.role },
      "Pending invite accepted and membership activated",
    );
  }

  // Backfill tenantId into Clerk publicMetadata so future JWTs carry it.
  // If the user has multiple pending invites (rare), the first one wins.
  const targetTenantId = pending[0]!.tenantId;
  const currentTenantId = publicMetadata.tenantId;
  if (currentTenantId !== targetTenantId) {
    clerk.users
      .updateUser(clerkId, {
        publicMetadata: { ...publicMetadata, tenantId: targetTenantId },
      })
      .catch((err: unknown) => {
        logger.warn(
          { err, clerkId, tenantId: targetTenantId },
          "Failed to backfill tenantId into Clerk publicMetadata after invite acceptance",
        );
      });
  }
}

/**
 * GET /auth/me — current user profile + tenant + role.
 * Uses adminPool so RLS does not block the lookup (no tenant context yet).
 */
router.get("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const clerkId = (req as AuthenticatedRequest).clerkUserId;

  // Lazy-claim any pending invites for this user before reading membership.
  // Errors here are logged but do not block the read (we still want /auth/me
  // to respond even if Clerk is briefly unavailable).
  try {
    await claimPendingInvitesForUser(clerkId);
  } catch (err) {
    logger.error({ err, clerkId }, "claimPendingInvitesForUser threw");
  }

  const membership = await adminDb
    .select({
      clerkId: tenantMembershipsTable.clerkId,
      email: tenantMembershipsTable.email,
      firstName: tenantMembershipsTable.firstName,
      lastName: tenantMembershipsTable.lastName,
      role: tenantMembershipsTable.role,
      tenantId: tenantMembershipsTable.tenantId,
      tenantName: tenantsTable.name,
      onboardingCompletedAt: tenantsTable.onboardingCompletedAt,
    })
    .from(tenantMembershipsTable)
    .leftJoin(tenantsTable, eq(tenantMembershipsTable.tenantId, tenantsTable.id))
    .where(and(
      eq(tenantMembershipsTable.clerkId, clerkId),
      eq(tenantMembershipsTable.isActive, "true"),
    ))
    .limit(1);

  if (membership.length === 0) {
    res.json({
      clerkId,
      email: "",
      firstName: null,
      lastName: null,
      role: null,
      tenantId: null,
      tenantName: null,
      onboardingCompleted: false,
    });
    return;
  }

  const m = membership[0]!;
  res.json({
    clerkId: m.clerkId,
    email: m.email,
    firstName: m.firstName ?? null,
    lastName: m.lastName ?? null,
    role: m.role,
    tenantId: m.tenantId,
    tenantName: m.tenantName ?? null,
    onboardingCompleted: m.onboardingCompletedAt !== null,
  });
});

/**
 * PATCH /auth/me
 * Update the current user's profile. Uses tenantContext for full tenant isolation.
 */
router.patch("/auth/me", tenantContext, async (req: Request, res: Response): Promise<void> => {
  const { clerkUserId: clerkId, tenantId } = req as TenantRequest;
  const { firstName, lastName } = (req.body ?? {}) as { firstName?: string; lastName?: string };

  const membership = await withTenantDb(tenantId, async (txDb) => {
    await txDb
      .update(tenantMembershipsTable)
      .set({
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
      })
      .where(and(
        eq(tenantMembershipsTable.clerkId, clerkId),
        eq(tenantMembershipsTable.tenantId, tenantId),
      ));

    return txDb
      .select({
        clerkId: tenantMembershipsTable.clerkId,
        email: tenantMembershipsTable.email,
        firstName: tenantMembershipsTable.firstName,
        lastName: tenantMembershipsTable.lastName,
        role: tenantMembershipsTable.role,
        tenantId: tenantMembershipsTable.tenantId,
        tenantName: tenantsTable.name,
        onboardingCompletedAt: tenantsTable.onboardingCompletedAt,
      })
      .from(tenantMembershipsTable)
      .leftJoin(tenantsTable, eq(tenantMembershipsTable.tenantId, tenantsTable.id))
      .where(and(
        eq(tenantMembershipsTable.clerkId, clerkId),
        eq(tenantMembershipsTable.tenantId, tenantId),
      ))
      .limit(1);
  });

  if (membership.length === 0) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const m = membership[0]!;
  res.json({
    clerkId: m.clerkId,
    email: m.email,
    firstName: m.firstName ?? null,
    lastName: m.lastName ?? null,
    role: m.role,
    tenantId: m.tenantId,
    tenantName: m.tenantName ?? null,
    onboardingCompleted: m.onboardingCompletedAt !== null,
  });
});

export default router;

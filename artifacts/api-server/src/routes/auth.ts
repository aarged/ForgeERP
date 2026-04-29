import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { adminPool, tenantsTable, tenantMembershipsTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { withTenantDb } from "@workspace/db/rls";

import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import { tenantContext, type TenantRequest } from "../middlewares/tenantContext";
import type { Request, Response } from "express";

const adminDb = drizzle(adminPool, { schema });

const router: IRouter = Router();

/**
 * GET /auth/me — current user profile + tenant + role.
 * Uses adminPool so RLS does not block the lookup (no tenant context yet).
 */
router.get("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const clerkId = (req as AuthenticatedRequest).clerkUserId;

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
  const { firstName, lastName } = req.body as { firstName?: string; lastName?: string };

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

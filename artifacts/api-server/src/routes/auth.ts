import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, tenantsTable, tenantMembershipsTable } from "@workspace/db";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import type { Request, Response } from "express";

const router: IRouter = Router();

router.get("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const clerkId = (req as AuthenticatedRequest).clerkUserId;

  const membership = await db
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

router.patch("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const clerkId = (req as AuthenticatedRequest).clerkUserId;
  const { firstName, lastName } = req.body as { firstName?: string; lastName?: string };

  await db
    .update(tenantMembershipsTable)
    .set({
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
    })
    .where(eq(tenantMembershipsTable.clerkId, clerkId));

  const membership = await db
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
    .where(eq(tenantMembershipsTable.clerkId, clerkId))
    .limit(1);

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

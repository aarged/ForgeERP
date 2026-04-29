import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, tenantsTable, tenantMembershipsTable } from "@workspace/db";
import { tenantContext, type TenantRequest } from "../middlewares/tenantContext";
import type { Request, Response } from "express";

const router: IRouter = Router();

router.get("/tenants/current", tenantContext, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;

  const tenant = await db
    .select()
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);

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
});

router.get("/tenants/current/members", tenantContext, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;

  const members = await db
    .select()
    .from(tenantMembershipsTable)
    .where(and(
      eq(tenantMembershipsTable.tenantId, tenantId),
      eq(tenantMembershipsTable.isActive, "true"),
    ));

  res.json(
    members.map((m) => ({
      clerkId: m.clerkId,
      email: m.email,
      firstName: m.firstName ?? null,
      lastName: m.lastName ?? null,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  );
});

export default router;

import { Router, type IRouter } from "express";
import { eq, isNull, count, sql } from "drizzle-orm";
import {
  adminPool,
  tenantsTable,
  tenantMembershipsTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { getUncachableStripeClient, isStripeConfigured } from "../lib/stripe";
import { logger } from "../lib/logger";
import type { Request, Response } from "express";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const superAdminOnly = [
  requireAuth,
  tenantContext,
  requireRole("super_admin"),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function ensureUniqueSlug(base: string): Promise<string> {
  let slug = base;
  let i = 1;
  while (true) {
    const existing = await adminDb
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
    slug = `${base}-${i++}`;
  }
}

// ── GET /admin/kpi ────────────────────────────────────────────────────────────

router.get(
  "/admin/kpi",
  ...superAdminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const [totals] = await adminDb
      .select({
        total: count(),
        active: sql<number>`COUNT(*) FILTER (WHERE status = 'active')`,
        trial: sql<number>`COUNT(*) FILTER (WHERE status = 'trial')`,
        suspended: sql<number>`COUNT(*) FILTER (WHERE status = 'suspended')`,
        withStripe: sql<number>`COUNT(*) FILTER (WHERE stripe_customer_id IS NOT NULL)`,
      })
      .from(tenantsTable)
      .where(isNull(tenantsTable.deletedAt));

    res.json({
      totalTenants: Number(totals!.total),
      activeTenants: Number(totals!.active),
      trialTenants: Number(totals!.trial),
      suspendedTenants: Number(totals!.suspended),
      stripeConnectedTenants: Number(totals!.withStripe),
      stripeConfigured: isStripeConfigured(),
    });
  },
);

// ── GET /admin/tenants ────────────────────────────────────────────────────────

router.get(
  "/admin/tenants",
  ...superAdminOnly,
  async (_req: Request, res: Response): Promise<void> => {
    const tenants = await adminDb
      .select({
        id: tenantsTable.id,
        name: tenantsTable.name,
        slug: tenantsTable.slug,
        status: tenantsTable.status,
        planTier: tenantsTable.planTier,
        currency: tenantsTable.currency,
        email: tenantsTable.email,
        stripeCustomerId: tenantsTable.stripeCustomerId,
        stripeSubscriptionId: tenantsTable.stripeSubscriptionId,
        onboardingCompletedAt: tenantsTable.onboardingCompletedAt,
        createdAt: tenantsTable.createdAt,
        memberCount: sql<number>`(
          SELECT COUNT(*) FROM tenant_memberships
          WHERE tenant_id = tenants.id AND is_active = 'true'
        )`,
      })
      .from(tenantsTable)
      .where(isNull(tenantsTable.deletedAt))
      .orderBy(tenantsTable.createdAt);

    res.json(
      tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        planTier: t.planTier,
        currency: t.currency ?? null,
        email: t.email ?? null,
        stripeCustomerId: t.stripeCustomerId ?? null,
        stripeSubscriptionId: t.stripeSubscriptionId ?? null,
        onboardingCompletedAt: t.onboardingCompletedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        memberCount: Number(t.memberCount),
      })),
    );
  },
);

// ── GET /admin/tenants/:id ────────────────────────────────────────────────────

router.get(
  "/admin/tenants/:id",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    const [tenant] = await adminDb
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!tenant || tenant.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const [memberCount] = await adminDb
      .select({ count: count() })
      .from(tenantMembershipsTable)
      .where(eq(tenantMembershipsTable.tenantId, id));

    res.json({
      id: tenant.id,
      name: tenant.name,
      tradingName: tenant.tradingName ?? null,
      slug: tenant.slug,
      status: tenant.status,
      planTier: tenant.planTier,
      legalName: tenant.legalName ?? null,
      taxId: tenant.taxId ?? null,
      phone: tenant.phone ?? null,
      email: tenant.email ?? null,
      website: tenant.website ?? null,
      addressLine1: tenant.addressLine1 ?? null,
      addressLine2: tenant.addressLine2 ?? null,
      city: tenant.city ?? null,
      state: tenant.state ?? null,
      postalCode: tenant.postalCode ?? null,
      country: tenant.country ?? null,
      currency: tenant.currency ?? null,
      timezone: tenant.timezone ?? null,
      fiscalYearStart: tenant.fiscalYearStart ?? null,
      industryType: tenant.industryType ?? null,
      stripeCustomerId: tenant.stripeCustomerId ?? null,
      stripeSubscriptionId: tenant.stripeSubscriptionId ?? null,
      onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString() ?? null,
      createdAt: tenant.createdAt.toISOString(),
      updatedAt: tenant.updatedAt.toISOString(),
      memberCount: Number(memberCount?.count ?? 0),
    });
  },
);

// ── POST /admin/tenants ───────────────────────────────────────────────────────

const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
  status: z.enum(["active", "suspended", "trial", "pending"]).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  slug: z.string().optional(),
});

router.post(
  "/admin/tenants",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const slug = data.slug ?? (await ensureUniqueSlug(slugify(data.name)));

    const [tenant] = await adminDb
      .insert(tenantsTable)
      .values({
        name: data.name,
        slug,
        email: data.email,
        planTier: data.planTier ?? "starter",
        status: data.status ?? "trial",
        currency: data.currency ?? "USD",
        timezone: data.timezone ?? "UTC",
      })
      .returning();

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      action: "tenant.created",
      entityType: "tenant",
      entityId: tenant!.id,
      newValues: { name: tenant!.name, slug: tenant!.slug, planTier: tenant!.planTier },
    });

    res.status(201).json({
      id: tenant!.id,
      name: tenant!.name,
      slug: tenant!.slug,
      status: tenant!.status,
      planTier: tenant!.planTier,
      createdAt: tenant!.createdAt.toISOString(),
    });
  },
);

// ── PATCH /admin/tenants/:id ──────────────────────────────────────────────────

const updateTenantSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "suspended", "trial", "pending"]).optional(),
  planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
  email: z.string().email().optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  industryType: z.string().optional(),
});

router.patch(
  "/admin/tenants/:id",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!existing || existing.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const updateFields: Partial<typeof tenantsTable.$inferInsert> = {};
    if (parsed.data.name !== undefined) updateFields.name = parsed.data.name;
    if (parsed.data.status !== undefined) updateFields.status = parsed.data.status;
    if (parsed.data.planTier !== undefined) updateFields.planTier = parsed.data.planTier;
    if (parsed.data.email !== undefined) updateFields.email = parsed.data.email;
    if (parsed.data.currency !== undefined) updateFields.currency = parsed.data.currency;
    if (parsed.data.timezone !== undefined) updateFields.timezone = parsed.data.timezone;
    if (parsed.data.industryType !== undefined) updateFields.industryType = parsed.data.industryType;

    const [updated] = await adminDb
      .update(tenantsTable)
      .set(updateFields)
      .where(eq(tenantsTable.id, id))
      .returning();

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: id,
      action: "tenant.updated",
      entityType: "tenant",
      entityId: id,
      oldValues: {
        status: existing.status,
        planTier: existing.planTier,
        name: existing.name,
      },
      newValues: parsed.data,
    });

    res.json({
      id: updated!.id,
      name: updated!.name,
      slug: updated!.slug,
      status: updated!.status,
      planTier: updated!.planTier,
      email: updated!.email ?? null,
      updatedAt: updated!.updatedAt.toISOString(),
    });
  },
);

// ── DELETE /admin/tenants/:id ─────────────────────────────────────────────────

router.delete(
  "/admin/tenants/:id",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    const [existing] = await adminDb
      .select({ id: tenantsTable.id, name: tenantsTable.name, deletedAt: tenantsTable.deletedAt })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!existing || existing.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    await adminDb
      .update(tenantsTable)
      .set({ deletedAt: new Date(), status: "suspended" })
      .where(eq(tenantsTable.id, id));

    await writeAuditLog({
      req,
      actorClerkId: actor.clerkUserId,
      actorEmail: actor.userEmail,
      tenantId: id,
      action: "tenant.deleted",
      entityType: "tenant",
      entityId: id,
      oldValues: { name: existing.name },
    });

    res.status(204).end();
  },
);

// ── POST /admin/tenants/:id/stripe-sync ───────────────────────────────────────

router.post(
  "/admin/tenants/:id/stripe-sync",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    if (!isStripeConfigured()) {
      res.status(503).json({
        error: "Stripe integration not configured",
        code: "STRIPE_NOT_CONFIGURED",
      });
      return;
    }

    const [tenant] = await adminDb
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!tenant || tenant.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    try {
      const stripe = await getUncachableStripeClient();

      let customerId = tenant.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: tenant.name,
          email: tenant.email ?? undefined,
          metadata: { tenantId: String(tenant.id), slug: tenant.slug },
        });
        customerId = customer.id;

        await adminDb
          .update(tenantsTable)
          .set({ stripeCustomerId: customerId })
          .where(eq(tenantsTable.id, id));

        await writeAuditLog({
          req,
          actorClerkId: actor.clerkUserId,
          actorEmail: actor.userEmail,
          tenantId: id,
          action: "tenant.stripe_customer_created",
          entityType: "tenant",
          entityId: id,
          newValues: { stripeCustomerId: customerId },
        });
      }

      res.json({ stripeCustomerId: customerId });
    } catch (err) {
      logger.error({ err }, "Stripe sync failed");
      res.status(502).json({ error: "Stripe API error" });
    }
  },
);

// ── GET /admin/tenants/:id/invoices ───────────────────────────────────────────

router.get(
  "/admin/tenants/:id/invoices",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    if (!isStripeConfigured()) {
      res.json({ invoices: [], stripeConfigured: false });
      return;
    }

    const [tenant] = await adminDb
      .select({
        stripeCustomerId: tenantsTable.stripeCustomerId,
        deletedAt: tenantsTable.deletedAt,
      })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!tenant || tenant.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (!tenant.stripeCustomerId) {
      res.json({ invoices: [], stripeConfigured: true });
      return;
    }

    try {
      const stripe = await getUncachableStripeClient();
      const invoices = await stripe.invoices.list({
        customer: tenant.stripeCustomerId,
        limit: 20,
      });

      res.json({
        stripeConfigured: true,
        invoices: invoices.data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amountDue: inv.amount_due,
          amountPaid: inv.amount_paid,
          currency: inv.currency,
          created: new Date(inv.created * 1000).toISOString(),
          hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        })),
      });
    } catch (err) {
      logger.error({ err }, "Failed to fetch Stripe invoices");
      res.status(502).json({ error: "Stripe API error" });
    }
  },
);

// ── GET /admin/audit-logs ─────────────────────────────────────────────────────

router.get(
  "/admin/audit-logs",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.query.tenantId ? Number(req.query.tenantId) : undefined;

    const logs = await adminDb.query.auditLogsTable.findMany({
      where: tenantId
        ? (t, { eq }) => eq(t.tenantId, tenantId)
        : undefined,
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 100,
    });

    res.json(
      logs.map((l) => ({
        id: l.id,
        tenantId: l.tenantId,
        actorClerkId: l.actorClerkId,
        actorEmail: l.actorEmail,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        oldValues: l.oldValues,
        newValues: l.newValues,
        createdAt: l.createdAt.toISOString(),
      })),
    );
  },
);

export default router;

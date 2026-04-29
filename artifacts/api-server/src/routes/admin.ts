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

// ── Plan pricing (cents/month) — used for local MRR estimate ─────────────────

const PLAN_MRR_CENTS: Record<string, number> = {
  starter: 0,
  growth: 29900,
  enterprise: 99900,
};

// ── Stripe subscription helpers ───────────────────────────────────────────────

function getPriceIdForPlan(planTier: string): string | undefined {
  const map: Record<string, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER,
    growth: process.env.STRIPE_PRICE_GROWTH,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
  };
  return map[planTier];
}

/** Compute approximate MRR in cents from a single active Stripe subscription */
function subToMonthlyCents(sub: { items: { data: Array<{ price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null }; quantity?: number | null }> } }): number {
  return sub.items.data.reduce((sum, item) => {
    const amount = item.price.unit_amount ?? 0;
    const qty = item.quantity ?? 1;
    const interval = item.price.recurring?.interval ?? "month";
    const intervalCount = item.price.recurring?.interval_count ?? 1;
    const monthlyFactor =
      interval === "year" ? 1 / (12 * intervalCount) :
      interval === "week" ? 4.333 / intervalCount :
      interval === "day" ? 30 / intervalCount : 1 / intervalCount;
    return sum + Math.round(amount * qty * monthlyFactor);
  }, 0);
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

    // Try to compute live MRR from Stripe active subscriptions
    let estimatedMrrCents = 0;
    let mrrIsEstimate = true;

    if (isStripeConfigured()) {
      try {
        const stripe = await getUncachableStripeClient();
        // Fetch active subscriptions — paginate up to 500 for accuracy
        let hasMore = true;
        let startingAfter: string | undefined;
        let stripeMrr = 0;

        while (hasMore) {
          const batch = await stripe.subscriptions.list({
            status: "active",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const sub of batch.data) {
            stripeMrr += subToMonthlyCents(sub as Parameters<typeof subToMonthlyCents>[0]);
          }
          hasMore = batch.has_more;
          startingAfter = batch.data[batch.data.length - 1]?.id;
        }

        estimatedMrrCents = stripeMrr;
        mrrIsEstimate = false;
      } catch (err) {
        logger.warn({ err }, "Failed to fetch Stripe MRR, falling back to plan-tier estimate");
        // Fall back to local estimate below
      }
    }

    // Local plan-tier estimate (used as fallback or when Stripe not configured)
    if (mrrIsEstimate) {
      const allTenants = await adminDb
        .select({ planTier: tenantsTable.planTier, status: tenantsTable.status })
        .from(tenantsTable)
        .where(isNull(tenantsTable.deletedAt));

      estimatedMrrCents = allTenants
        .filter((t) => t.status === "active")
        .reduce((sum, t) => sum + (PLAN_MRR_CENTS[t.planTier] ?? 0), 0);
    }

    res.json({
      totalTenants: Number(totals!.total),
      activeTenants: Number(totals!.active),
      trialTenants: Number(totals!.trial),
      suspendedTenants: Number(totals!.suspended),
      stripeConnectedTenants: Number(totals!.withStripe),
      stripeConfigured: isStripeConfigured(),
      estimatedMrrCents,
      mrrIsEstimate,
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
        // Storage metering: count rows in key tables per tenant, estimate bytes
        auditLogCount: sql<number>`(
          SELECT COUNT(*) FROM audit_logs WHERE tenant_id = tenants.id
        )`,
      })
      .from(tenantsTable)
      .where(isNull(tenantsTable.deletedAt))
      .orderBy(tenantsTable.createdAt);

    res.json(
      tenants.map((t) => {
        // Estimate storage: ~500 bytes per audit log entry + 2KB base per membership
        const auditBytes = Number(t.auditLogCount) * 500;
        const memberBytes = Number(t.memberCount) * 2048;
        const storageUsageMb = Math.max(
          0,
          Math.round((auditBytes + memberBytes) / (1024 * 1024) * 100) / 100,
        );

        return {
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
          storageUsageMb: Math.round(storageUsageMb),
          subscriptionStatus: null as string | null,
        };
      }),
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

    // Fetch live Stripe subscription status if available
    let subscriptionStatus: string | null = null;
    let currentPeriodEnd: string | null = null;
    if (tenant.stripeSubscriptionId && isStripeConfigured()) {
      try {
        const stripe = await getUncachableStripeClient();
        const sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
        subscriptionStatus = sub.status;
        const subAny = sub as unknown as { current_period_end: number };
        currentPeriodEnd = subAny.current_period_end
          ? new Date(subAny.current_period_end * 1000).toISOString()
          : null;
      } catch (err) {
        logger.warn({ err, tenantId: id }, "Failed to retrieve Stripe subscription for detail");
      }
    }

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
      subscriptionStatus,
      currentPeriodEnd,
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

    // If caller supplied a custom slug, check it isn't already taken
    if (data.slug) {
      const conflict = await adminDb
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.slug, data.slug))
        .limit(1);
      if (conflict.length > 0) {
        res.status(409).json({ error: `Slug "${data.slug}" is already in use`, code: "SLUG_CONFLICT" });
        return;
      }
    }

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

    // If plan tier changed and Stripe is configured, sync subscription
    if (
      parsed.data.planTier !== undefined &&
      parsed.data.planTier !== existing.planTier &&
      isStripeConfigured()
    ) {
      try {
        const newPriceId = getPriceIdForPlan(parsed.data.planTier);
        if (newPriceId) {
          const stripe = await getUncachableStripeClient();

          if (existing.stripeSubscriptionId) {
            // Update existing subscription
            const sub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
            const itemId = sub.items.data[0]?.id;
            if (itemId) {
              await stripe.subscriptions.update(existing.stripeSubscriptionId, {
                items: [{ id: itemId, price: newPriceId }],
                proration_behavior: "always_invoice",
              });
              logger.info({ tenantId: id, planTier: parsed.data.planTier }, "Stripe subscription updated");
            }
          } else if (existing.stripeCustomerId) {
            // Create new subscription for existing customer
            const sub = await stripe.subscriptions.create({
              customer: existing.stripeCustomerId,
              items: [{ price: newPriceId }],
              metadata: { tenantId: String(id), planTier: parsed.data.planTier },
            });
            await adminDb
              .update(tenantsTable)
              .set({ stripeSubscriptionId: sub.id })
              .where(eq(tenantsTable.id, id));
            logger.info({ tenantId: id, subscriptionId: sub.id }, "Stripe subscription created on plan change");
          }
        } else {
          logger.warn(
            { planTier: parsed.data.planTier },
            "No Stripe price ID configured for plan tier — skipping subscription sync",
          );
        }
      } catch (err) {
        logger.error({ err }, "Failed to sync Stripe subscription on plan change");
      }
    }

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

// ── POST /admin/tenants/:id/stripe-subscription ───────────────────────────────

const createSubscriptionSchema = z.object({
  planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
});

router.post(
  "/admin/tenants/:id/stripe-subscription",
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

    const parsed = createSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
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

    const planTier = parsed.data.planTier ?? tenant.planTier;
    const priceId = getPriceIdForPlan(planTier);

    if (!priceId) {
      res.status(400).json({
        error: `No Stripe price configured for plan tier "${planTier}". Set STRIPE_PRICE_${planTier.toUpperCase()} environment variable.`,
        code: "STRIPE_PRICE_NOT_CONFIGURED",
      });
      return;
    }

    try {
      const stripe = await getUncachableStripeClient();

      // Ensure Stripe customer exists
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

      let wasCreated = false;
      let subscription;

      if (tenant.stripeSubscriptionId) {
        // Update existing subscription to new plan price
        const existing = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
        const itemId = existing.items.data[0]?.id;
        if (itemId) {
          subscription = await stripe.subscriptions.update(tenant.stripeSubscriptionId, {
            items: [{ id: itemId, price: priceId }],
            proration_behavior: "always_invoice",
          });
        } else {
          // No items — create fresh
          subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: priceId }],
            metadata: { tenantId: String(id), planTier },
          });
          wasCreated = true;
        }
      } else {
        // Create new subscription
        subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          metadata: { tenantId: String(id), planTier },
        });
        wasCreated = true;
      }

      // Persist subscription ID and plan tier to DB
      await adminDb
        .update(tenantsTable)
        .set({
          stripeSubscriptionId: subscription.id,
          planTier,
        })
        .where(eq(tenantsTable.id, id));

      await writeAuditLog({
        req,
        actorClerkId: actor.clerkUserId,
        actorEmail: actor.userEmail,
        tenantId: id,
        action: wasCreated ? "tenant.stripe_subscription_created" : "tenant.stripe_subscription_updated",
        entityType: "tenant",
        entityId: id,
        newValues: { stripeSubscriptionId: subscription.id, planTier, status: subscription.status },
      });

      res.json({
        subscriptionId: subscription.id,
        status: subscription.status,
        planTier,
        currentPeriodEnd: (() => {
          const s = subscription as unknown as { current_period_end?: number };
          return s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null;
        })(),
        created: wasCreated,
      });
    } catch (err) {
      logger.error({ err }, "Stripe subscription create/update failed");
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

// ── GET /admin/tenants/:id/members ────────────────────────────────────────────

router.get(
  "/admin/tenants/:id/members",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    const [tenant] = await adminDb
      .select({ id: tenantsTable.id, deletedAt: tenantsTable.deletedAt })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!tenant || tenant.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const members = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(eq(tenantMembershipsTable.tenantId, id))
      .orderBy(tenantMembershipsTable.joinedAt);

    res.json(
      members.map((m) => ({
        id: m.id,
        clerkId: m.clerkId,
        email: m.email,
        firstName: m.firstName ?? null,
        lastName: m.lastName ?? null,
        role: m.role,
        isActive: m.isActive === "true",
        joinedAt: m.joinedAt.toISOString(),
      })),
    );
  },
);

// ── PATCH /admin/tenants/:id/members/:membershipId ────────────────────────────

const updateMemberSchema = z.object({
  role: z
    .enum([
      "super_admin",
      "tenant_admin",
      "purchaser",
      "warehouse",
      "approver",
      "accountant",
      "viewer",
    ])
    .optional(),
  isActive: z.boolean().optional(),
});

router.patch(
  "/admin/tenants/:id/members/:membershipId",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const actor = req as TenantRequest;
    const id = Number(req.params.id);
    const membershipId = Number(req.params.membershipId);
    if (isNaN(id) || isNaN(membershipId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
      return;
    }

    if (parsed.data.role === undefined && parsed.data.isActive === undefined) {
      res.status(400).json({ error: "At least one of role or isActive must be provided" });
      return;
    }

    const [existing] = await adminDb
      .select()
      .from(tenantMembershipsTable)
      .where(
        sql`${tenantMembershipsTable.id} = ${membershipId} AND ${tenantMembershipsTable.tenantId} = ${id}`,
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Member not found" });
      return;
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
      tenantId: id,
      action: "tenant_member.updated",
      entityType: "tenant_membership",
      entityId: membershipId,
      oldValues: { role: existing.role, isActive: existing.isActive === "true" },
      newValues: parsed.data,
    });

    res.json({
      id: updated!.id,
      clerkId: updated!.clerkId,
      email: updated!.email,
      firstName: updated!.firstName ?? null,
      lastName: updated!.lastName ?? null,
      role: updated!.role,
      isActive: updated!.isActive === "true",
      joinedAt: updated!.joinedAt.toISOString(),
    });
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

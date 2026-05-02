import { Router, type IRouter } from "express";
import { eq, isNull, count, sql, and, gte } from "drizzle-orm";
import {
  adminPool,
  tenantsTable,
  tenantMembershipsTable,
  auditLogsTable,
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
          storageUsageMb,
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

    if (Object.keys(updateFields).length === 0) {
      res.status(400).json({
        error: "No fields provided. Supply at least one of: name, status, planTier, email, currency, timezone, industryType.",
        code: "EMPTY_UPDATE",
      });
      return;
    }

    const [updated] = await adminDb
      .update(tenantsTable)
      .set(updateFields)
      .where(eq(tenantsTable.id, id))
      .returning();

    // If plan tier changed and Stripe is configured, sync subscription.
    // Capture sync outcome so we can surface partial failure to the caller
    // (DB plan persists, but billing state may be diverged).
    let billingSyncStatus: "ok" | "skipped" | "failed" | null = null;
    let billingSyncReason: string | null = null;

    if (
      parsed.data.planTier !== undefined &&
      parsed.data.planTier !== existing.planTier &&
      isStripeConfigured()
    ) {
      try {
        const newPriceId = getPriceIdForPlan(parsed.data.planTier);
        if (!newPriceId) {
          billingSyncStatus = "skipped";
          billingSyncReason = `No Stripe price configured for "${parsed.data.planTier}" — set STRIPE_PRICE_${parsed.data.planTier.toUpperCase()}`;
          logger.warn({ planTier: parsed.data.planTier }, billingSyncReason);
        } else {
          const stripe = await getUncachableStripeClient();

          if (existing.stripeSubscriptionId) {
            const sub = await stripe.subscriptions.retrieve(existing.stripeSubscriptionId);
            const itemId = sub.items.data[0]?.id;
            if (itemId) {
              await stripe.subscriptions.update(existing.stripeSubscriptionId, {
                items: [{ id: itemId, price: newPriceId }],
                proration_behavior: "always_invoice",
              });
              billingSyncStatus = "ok";
              logger.info({ tenantId: id, planTier: parsed.data.planTier }, "Stripe subscription updated");
            } else {
              billingSyncStatus = "skipped";
              billingSyncReason = "Existing subscription has no items to update";
            }
          } else if (existing.stripeCustomerId) {
            const sub = await stripe.subscriptions.create({
              customer: existing.stripeCustomerId,
              items: [{ price: newPriceId }],
              metadata: { tenantId: String(id), planTier: parsed.data.planTier },
            });
            await adminDb
              .update(tenantsTable)
              .set({ stripeSubscriptionId: sub.id })
              .where(eq(tenantsTable.id, id));
            billingSyncStatus = "ok";
            logger.info({ tenantId: id, subscriptionId: sub.id }, "Stripe subscription created on plan change");
          } else {
            billingSyncStatus = "skipped";
            billingSyncReason = "Tenant has no Stripe customer — run Stripe sync first";
          }
        }
      } catch (err) {
        billingSyncStatus = "failed";
        billingSyncReason = err instanceof Error ? err.message : "Unknown Stripe error";
        logger.error({ err, tenantId: id }, "Failed to sync Stripe subscription on plan change");
        // Audit the divergence so it can be reconciled
        await writeAuditLog({
          req,
          actorClerkId: actor.clerkUserId,
          actorEmail: actor.userEmail,
          tenantId: id,
          action: "tenant.billing_sync_failed",
          entityType: "tenant",
          entityId: id,
          oldValues: { planTier: existing.planTier },
          newValues: { planTier: parsed.data.planTier, error: billingSyncReason },
        });
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
      billingSyncStatus,
      billingSyncReason,
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

    // Atomic guard + update.
    //
    // To prevent locking the platform out by removing the last active
    // super_admin, we wrap the read-check-update in a transaction and take
    // row-level locks (SELECT ... FOR UPDATE) on every currently active
    // super_admin row plus the target membership. Any concurrent request
    // that also touches an active super_admin will block on the same lock
    // set and re-evaluate the invariant after the first transaction commits,
    // so two simultaneous demotions/deactivations cannot both succeed.
    const txResult = await adminDb.transaction(async (tx) => {
      // Lock the union of (a) all currently active super_admin rows and
      // (b) the target membership row. Returning `id` is enough — we just
      // need the locks; we re-read state below.
      await tx
        .select({ id: tenantMembershipsTable.id })
        .from(tenantMembershipsTable)
        .where(
          sql`(${tenantMembershipsTable.role} = 'super_admin'
                AND ${tenantMembershipsTable.isActive} = 'true')
              OR ${tenantMembershipsTable.id} = ${membershipId}`,
        )
        .for("update");

      // Re-read the target membership inside the transaction to get the
      // freshest committed state.
      const [current] = await tx
        .select()
        .from(tenantMembershipsTable)
        .where(
          sql`${tenantMembershipsTable.id} = ${membershipId}
              AND ${tenantMembershipsTable.tenantId} = ${id}`,
        )
        .limit(1);

      if (!current) {
        return { kind: "not_found" as const };
      }

      const isCurrentlyActiveSuperAdmin =
        current.role === "super_admin" && current.isActive === "true";
      const willRemainSuperAdmin =
        parsed.data.role === undefined
          ? current.role === "super_admin"
          : parsed.data.role === "super_admin";
      const willRemainActive =
        parsed.data.isActive === undefined
          ? current.isActive === "true"
          : parsed.data.isActive;
      const wouldLoseSuperAdminStatus =
        isCurrentlyActiveSuperAdmin &&
        (!willRemainSuperAdmin || !willRemainActive);

      if (wouldLoseSuperAdminStatus) {
        // Count other active super_admins under the lock taken above.
        const [{ remaining } = { remaining: 0 }] = await tx
          .select({ remaining: sql<number>`COUNT(*)::int` })
          .from(tenantMembershipsTable)
          .where(
            sql`${tenantMembershipsTable.role} = 'super_admin'
                AND ${tenantMembershipsTable.isActive} = 'true'
                AND ${tenantMembershipsTable.id} <> ${membershipId}`,
          );

        if (Number(remaining) === 0) {
          return { kind: "last_super_admin" as const };
        }
      }

      const updateFields: Partial<typeof tenantMembershipsTable.$inferInsert> =
        {};
      if (parsed.data.role !== undefined) updateFields.role = parsed.data.role;
      if (parsed.data.isActive !== undefined)
        updateFields.isActive = parsed.data.isActive ? "true" : "false";

      const [updated] = await tx
        .update(tenantMembershipsTable)
        .set(updateFields)
        .where(eq(tenantMembershipsTable.id, membershipId))
        .returning();

      return { kind: "ok" as const, existing: current, updated: updated! };
    });

    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (txResult.kind === "last_super_admin") {
      res.status(409).json({
        error:
          "Cannot remove the last active super admin — at least one active super admin must remain on the platform.",
        code: "LAST_SUPER_ADMIN",
      });
      return;
    }

    const { existing, updated } = txResult;

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

// ── GET /admin/trends ─────────────────────────────────────────────────────────

/** Returns the Monday-aligned UTC start of the week containing `d`. */
function startOfWeekUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  // JS getUTCDay: 0=Sun..6=Sat. We want Monday-aligned weeks.
  const dow = out.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  out.setUTCDate(out.getUTCDate() + offset);
  return out;
}

router.get(
  "/admin/trends",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const rawWeeks = Number(req.query.weeks);
    const weeks = Number.isFinite(rawWeeks)
      ? Math.max(1, Math.min(52, Math.trunc(rawWeeks)))
      : 12;

    // Build week buckets (oldest → newest), Monday-aligned UTC.
    const currentWeekStart = startOfWeekUtc(new Date());
    const buckets: { weekStart: Date; weekEnd: Date }[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const weekStart = new Date(currentWeekStart);
      weekStart.setUTCDate(weekStart.getUTCDate() - i * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
      buckets.push({ weekStart, weekEnd });
    }

    // Pull all non-deleted tenants — fine for typical platform sizes.
    const allTenants = await adminDb
      .select({
        createdAt: tenantsTable.createdAt,
        status: tenantsTable.status,
        planTier: tenantsTable.planTier,
      })
      .from(tenantsTable)
      .where(isNull(tenantsTable.deletedAt));

    const signupsPerWeek = buckets.map((b) => ({
      weekStart: b.weekStart.toISOString(),
      value: allTenants.filter(
        (t) => t.createdAt >= b.weekStart && t.createdAt < b.weekEnd,
      ).length,
    }));

    // Cumulative count of non-suspended tenants that existed by end of week.
    // Note: status reflects current status, so historical accuracy degrades
    // for tenants whose status changed; this is documented in the schema.
    const activeTenantsOverTime = buckets.map((b) => ({
      weekStart: b.weekStart.toISOString(),
      value: allTenants.filter(
        (t) => t.createdAt < b.weekEnd && t.status !== "suspended",
      ).length,
    }));

    // Try Stripe MRR over time first: bucket active subs by their `created`.
    let mrrCentsOverTime: { weekStart: string; value: number }[] = [];
    let mrrIsEstimate = true;

    if (isStripeConfigured()) {
      try {
        const stripe = await getUncachableStripeClient();
        type SubLite = {
          created: number;
          status: string;
          monthly: number;
          canceledAt: number | null;
        };
        const subs: SubLite[] = [];
        let hasMore = true;
        let startingAfter: string | undefined;

        while (hasMore) {
          const batch = await stripe.subscriptions.list({
            status: "all",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const sub of batch.data) {
            const monthly = subToMonthlyCents(
              sub as Parameters<typeof subToMonthlyCents>[0],
            );
            const subAny = sub as unknown as { canceled_at: number | null };
            subs.push({
              created: sub.created,
              status: sub.status,
              monthly,
              canceledAt: subAny.canceled_at,
            });
          }
          hasMore = batch.has_more;
          startingAfter = batch.data[batch.data.length - 1]?.id;
        }

        mrrCentsOverTime = buckets.map((b) => {
          const weekEndUnix = Math.floor(b.weekEnd.getTime() / 1000);
          const mrr = subs
            .filter(
              (s) =>
                s.created < weekEndUnix &&
                (s.canceledAt === null || s.canceledAt > weekEndUnix) &&
                s.status !== "incomplete_expired",
            )
            .reduce((sum, s) => sum + s.monthly, 0);
          return { weekStart: b.weekStart.toISOString(), value: mrr };
        });
        mrrIsEstimate = false;
      } catch (err) {
        logger.warn(
          { err },
          "Failed to fetch Stripe historical MRR, falling back to plan-tier estimate",
        );
      }
    }

    if (mrrIsEstimate) {
      mrrCentsOverTime = buckets.map((b) => ({
        weekStart: b.weekStart.toISOString(),
        value: allTenants
          .filter(
            (t) => t.createdAt < b.weekEnd && t.status === "active",
          )
          .reduce(
            (sum, t) => sum + (PLAN_MRR_CENTS[t.planTier] ?? 0),
            0,
          ),
      }));
    }

    res.json({
      weeks,
      signupsPerWeek,
      activeTenantsOverTime,
      mrrCentsOverTime,
      mrrIsEstimate,
    });
  },
);

// ── GET /admin/tenants/:id/activity ───────────────────────────────────────────

router.get(
  "/admin/tenants/:id/activity",
  ...superAdminOnly,
  async (req: Request, res: Response): Promise<void> => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid tenant id" });
      return;
    }

    const rawDays = Number(req.query.days);
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(90, Math.trunc(rawDays)))
      : 30;

    const [tenant] = await adminDb
      .select({ id: tenantsTable.id, deletedAt: tenantsTable.deletedAt })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1);

    if (!tenant || tenant.deletedAt) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Window starts `days-1` days before today (UTC), midnight-aligned.
    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

    const logs = await adminDb
      .select({ createdAt: auditLogsTable.createdAt })
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.tenantId, id),
          gte(auditLogsTable.createdAt, startDate),
        ),
      );

    const buckets = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setUTCDate(d.getUTCDate() + i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const l of logs) {
      const day = l.createdAt.toISOString().slice(0, 10);
      if (buckets.has(day)) {
        buckets.set(day, (buckets.get(day) ?? 0) + 1);
      }
    }

    const activity = Array.from(buckets.entries()).map(([date, count]) => ({
      date,
      count,
    }));

    res.json({
      days,
      activity,
      totalEvents: logs.length,
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

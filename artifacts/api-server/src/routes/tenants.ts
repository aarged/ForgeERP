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
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { isStripeConfigured, getUncachableStripeClient } from "../lib/stripe";
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
// ── POST /tenants/onboard ─────────────────────────────────────────────────────
//
// Self-serve tenant onboarding endpoint used by the /onboarding wizard.
// - Creates the tenant
// - Assigns the calling Clerk user as tenant_admin
// - For paid plans, creates a Stripe Checkout Session in subscription mode
//   and returns its URL. For "starter", the user is sent straight to
//   /dashboard.
// - Idempotent: if the user already has an active membership, returns the
//   existing tenant unchanged with `alreadyOnboarded: true` and
//   `redirectTo: "/dashboard"`.

const SLUG_PATTERN = /^[a-z0-9-]+$/;

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function ensureUniqueSlug(base: string): Promise<string> {
  const root = base || "company";
  let slug = root;
  let i = 1;
  while (true) {
    const existing = await adminDb
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.slug, slug))
      .limit(1);
    if (existing.length === 0) return slug;
    slug = `${root}-${i++}`;
  }
}

const onboardTenantSchema = z.object({
  companyName: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(SLUG_PATTERN, "Slug must contain only lowercase letters, numbers, and hyphens")
    .optional(),
  planTier: z.enum(["starter", "growth", "enterprise"]),
  billingEmail: z.string().email(),
});

function resolveFrontendOrigin(req: Request): string {
  const fromHeader = req.headers.origin;
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  if (process.env.FRONTEND_URL) {
    try {
      return new URL(process.env.FRONTEND_URL).origin;
    } catch {
      /* fall through */
    }
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "https").split(",")[0]!;
  return `${proto}://${host}`;
}

router.post(
  "/tenants/onboard",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;

    const parsed = onboardTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }
    const { companyName, slug: requestedSlug, planTier, billingEmail } = parsed.data;

    // ── Idempotency: already has a membership? Return that tenant ──────────
    const existing = await adminDb
      .select({
        tenantId: tenantMembershipsTable.tenantId,
        role: tenantMembershipsTable.role,
        name: tenantsTable.name,
        slug: tenantsTable.slug,
        planTier: tenantsTable.planTier,
        status: tenantsTable.status,
      })
      .from(tenantMembershipsTable)
      .leftJoin(
        tenantsTable,
        eq(tenantMembershipsTable.tenantId, tenantsTable.id),
      )
      .where(
        and(
          eq(tenantMembershipsTable.clerkId, clerkId),
          eq(tenantMembershipsTable.isActive, "true"),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const m = existing[0]!;
      res.status(200).json({
        tenantId: m.tenantId,
        slug: m.slug ?? "",
        name: m.name ?? "",
        planTier: m.planTier ?? "starter",
        status: m.status ?? "active",
        role: m.role,
        redirectTo: "/dashboard",
        checkoutUrl: null,
        checkoutSessionId: null,
        alreadyOnboarded: true,
      });
      return;
    }

    // ── Resolve Clerk user (for membership profile + email fallback) ───────
    let userEmail = billingEmail;
    let firstName: string | null = null;
    let lastName: string | null = null;
    try {
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const primary =
        clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId,
        ) ?? clerkUser.emailAddresses[0];
      if (primary?.emailAddress) userEmail = primary.emailAddress;
      firstName = clerkUser.firstName ?? null;
      lastName = clerkUser.lastName ?? null;
    } catch (err) {
      logger.warn(
        { err, clerkId },
        "Failed to fetch Clerk user during /tenants/onboard",
      );
    }

    // ── Pre-flight checks for paid plans ───────────────────────────────────
    // Fail closed BEFORE creating the tenant so the user can retry without
    // an orphan workspace. Paid plans require both an initialised Stripe
    // client and a configured price id for the chosen tier.
    let priceIdForPlan: string | undefined;
    if (planTier !== "starter") {
      if (!isStripeConfigured()) {
        res.status(503).json({
          error:
            "Billing is not configured on this server. Please choose the Starter plan or contact support.",
          code: "STRIPE_NOT_CONFIGURED",
        });
        return;
      }
      const priceLookup: Record<string, string | undefined> = {
        growth: process.env.STRIPE_PRICE_GROWTH,
        enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
      };
      priceIdForPlan = priceLookup[planTier];
      if (!priceIdForPlan) {
        logger.error(
          { planTier },
          "Onboarding requested paid plan but no Stripe price ID is configured",
        );
        res.status(503).json({
          error:
            "This plan is not available for self-serve checkout right now. Please choose a different plan or contact support.",
          code: "STRIPE_PRICE_NOT_CONFIGURED",
        });
        return;
      }
    }

    // ── Slug: explicit slug must be unique; otherwise auto-suffix ──────────
    let slug: string;
    if (requestedSlug) {
      const cleaned = slugifyName(requestedSlug);
      if (!cleaned) {
        res
          .status(400)
          .json({ error: "Slug is empty after normalization", code: "INVALID_SLUG" });
        return;
      }
      const dup = await adminDb
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.slug, cleaned))
        .limit(1);
      if (dup.length > 0) {
        res.status(409).json({
          error: "That workspace URL is already taken. Please choose another.",
          code: "SLUG_TAKEN",
          slug: cleaned,
        });
        return;
      }
      slug = cleaned;
    } else {
      slug = await ensureUniqueSlug(slugifyName(companyName));
    }

    // ── Create tenant + tenant_admin membership in a single transaction ────
    const now = new Date();
    let tenant: typeof tenantsTable.$inferSelect;
    try {
      tenant = await adminDb.transaction(async (tx) => {
        const [newTenant] = await tx
          .insert(tenantsTable)
          .values({
            name: companyName,
            slug,
            email: billingEmail,
            status: planTier === "starter" ? "active" : "trial",
            planTier,
            onboardingCompletedAt: now,
          })
          .returning();
        if (!newTenant) throw new Error("Failed to create tenant");

        await tx.insert(tenantMembershipsTable).values({
          tenantId: newTenant.id,
          clerkId,
          email: userEmail,
          firstName,
          lastName,
          role: "tenant_admin",
          isActive: "true",
        });

        return newTenant;
      });
    } catch (err) {
      logger.error({ err }, "Failed to create tenant in /tenants/onboard");
      res
        .status(500)
        .json({ error: "Failed to set up your workspace. Please try again." });
      return;
    }

    // ── Stripe Checkout Session for paid plans ─────────────────────────────
    // Pre-flight checks above already guarantee Stripe is initialised and a
    // priceId exists for paid plans. If anything still fails here we MUST
    // fail closed: roll back the tenant + membership we just created so the
    // user is not left with a fully provisioned but unpaid workspace, and
    // return an explicit error.
    let checkoutUrl: string | null = null;
    let checkoutSessionId: string | null = null;

    if (planTier !== "starter") {
      try {
        const stripe = await getUncachableStripeClient();

        const customer = await stripe.customers.create({
          email: billingEmail,
          name: companyName,
          metadata: {
            tenantId: String(tenant.id),
            clerkUserId: clerkId,
            planTier,
          },
        });
        await adminDb
          .update(tenantsTable)
          .set({ stripeCustomerId: customer.id })
          .where(eq(tenantsTable.id, tenant.id));

        const origin = resolveFrontendOrigin(req);
        const successUrl = `${origin}/forge-erp/dashboard?onboarding=success&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${origin}/forge-erp/onboarding?cancelled=1`;

        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: customer.id,
          line_items: [{ price: priceIdForPlan!, quantity: 1 }],
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: String(tenant.id),
          subscription_data: {
            metadata: {
              tenantId: String(tenant.id),
              clerkUserId: clerkId,
              planTier,
            },
          },
          metadata: {
            tenantId: String(tenant.id),
            clerkUserId: clerkId,
            planTier,
          },
        });

        if (!session.url) {
          throw new Error("Stripe Checkout Session was created without a URL");
        }

        checkoutUrl = session.url;
        checkoutSessionId = session.id;

        await writeAuditLog({
          req,
          actorClerkId: clerkId,
          actorEmail: userEmail,
          tenantId: tenant.id,
          action: "tenant.checkout_session_created",
          entityType: "tenant",
          entityId: tenant.id,
          newValues: {
            stripeCustomerId: customer.id,
            checkoutSessionId: session.id,
            planTier,
          },
        });
      } catch (err) {
        logger.error(
          { err, tenantId: tenant.id, planTier },
          "Stripe Checkout Session creation failed during /tenants/onboard — rolling back tenant",
        );

        // Roll back tenant + membership so the user can retry cleanly.
        try {
          await adminDb.transaction(async (tx) => {
            await tx
              .delete(tenantMembershipsTable)
              .where(eq(tenantMembershipsTable.tenantId, tenant.id));
            await tx
              .delete(tenantsTable)
              .where(eq(tenantsTable.id, tenant.id));
          });
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, tenantId: tenant.id },
            "Failed to roll back tenant after Stripe failure",
          );
        }

        res.status(502).json({
          error:
            "We couldn't reach our billing provider to start your checkout. Your workspace was not created — please try again in a moment.",
          code: "CHECKOUT_SESSION_FAILED",
        });
        return;
      }
    }

    // ── Audit + Clerk metadata backfill ────────────────────────────────────
    await writeAuditLog({
      req,
      actorClerkId: clerkId,
      actorEmail: userEmail,
      tenantId: tenant.id,
      action: "tenant.onboarded",
      entityType: "tenant",
      entityId: tenant.id,
      newValues: {
        name: tenant.name,
        slug: tenant.slug,
        planTier: tenant.planTier,
        billingEmail,
        checkoutSessionId,
      },
    });

    void (async () => {
      try {
        const u = await clerkClient.users.getUser(clerkId);
        const existingMeta = (u.publicMetadata ?? {}) as Record<string, unknown>;
        await clerkClient.users.updateUser(clerkId, {
          publicMetadata: { ...existingMeta, tenantId: tenant.id },
        });
      } catch (err) {
        logger.warn(
          { err, clerkId, tenantId: tenant.id },
          "Failed to backfill Clerk metadata after onboarding",
        );
      }
    })();

    res.status(201).json({
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      planTier: tenant.planTier,
      status: tenant.status,
      role: "tenant_admin",
      redirectTo: checkoutUrl ?? "/dashboard",
      checkoutUrl,
      checkoutSessionId,
      alreadyOnboarded: false,
    });
  },
);

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

import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  adminPool,
  tenantsTable,
  tenantMembershipsTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { z } from "zod";
import { createClerkClient } from "@clerk/express";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middlewares/requireAuth";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";
import type { Request, Response } from "express";

const router: IRouter = Router();
const adminDb = drizzle(adminPool, { schema });

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

// Resolve the frontend sign-up URL Clerk should redirect invitees to once
// they click the email link. We prefer the explicit FRONTEND_URL env var.
// If absent, we'll accept the request's Origin/Referer ONLY if it matches
// an allowlist (FRONTEND_URL, FRONTEND_URLS comma-list, or the dev-only
// REPLIT_DEV_DOMAIN). This prevents an authenticated caller from coercing
// Clerk into emitting invitation emails that point to an attacker-controlled
// origin.
function buildAllowedOrigins(): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      out.add(new URL(raw).origin);
    } catch {
      // ignore malformed values
    }
  };
  add(process.env.FRONTEND_URL);
  for (const v of (process.env.FRONTEND_URLS ?? "").split(",")) {
    add(v.trim());
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  return [...out];
}

function resolveInviteRedirectUrl(req: Request): string | undefined {
  const allowed = buildAllowedOrigins();

  const candidates: string[] = [];
  if (req.headers.origin) candidates.push(req.headers.origin as string);
  if (req.headers.referer) {
    try {
      candidates.push(new URL(req.headers.referer as string).origin);
    } catch {
      // ignore
    }
  }

  let chosenOrigin: string | undefined;
  for (const c of candidates) {
    if (allowed.includes(c)) {
      chosenOrigin = c;
      break;
    }
  }
  // If nothing matched but we have an explicit FRONTEND_URL, fall back to it.
  if (!chosenOrigin && allowed.length > 0 && process.env.FRONTEND_URL) {
    try {
      chosenOrigin = new URL(process.env.FRONTEND_URL).origin;
    } catch {
      // ignore
    }
  }
  if (!chosenOrigin) return undefined;
  try {
    return new URL("/sign-up", chosenOrigin).toString();
  } catch {
    return undefined;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
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

// Stable per-email placeholder so we don't collide across multiple invites
function pendingClerkIdForEmail(email: string): string {
  // Simple stable identifier for invite rows. When the invitee signs up
  // through Clerk, an admin (or a future webhook) can replace this with the
  // real Clerk user id.
  return `pending:${email.toLowerCase()}`;
}

// ── Schema ────────────────────────────────────────────────────────────────────

const inviteRoleEnum = z.enum([
  "tenant_admin",
  "purchaser",
  "warehouse",
  "approver",
  "accountant",
  "viewer",
]);

const createOnboardingTenantSchema = z.object({
  companyName: z.string().min(1).max(200),
  industryType: z.string().max(100).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(80).optional(),
  planTier: z.enum(["starter", "growth", "enterprise"]).optional(),
  invites: z
    .array(
      z.object({
        email: z.string().email(),
        role: inviteRoleEnum,
      }),
    )
    .max(25)
    .optional(),
});

// ── POST /onboarding/create-tenant ────────────────────────────────────────────

router.post(
  "/onboarding/create-tenant",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const clerkId = (req as AuthenticatedRequest).clerkUserId;

    const parsed = createOnboardingTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }

    const data = parsed.data;

    // ── 1. If the user already has an active membership, return it ──────────
    const existing = await adminDb
      .select({
        tenantId: tenantMembershipsTable.tenantId,
        role: tenantMembershipsTable.role,
        tenantName: tenantsTable.name,
        slug: tenantsTable.slug,
        status: tenantsTable.status,
        planTier: tenantsTable.planTier,
        onboardingCompletedAt: tenantsTable.onboardingCompletedAt,
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
        name: m.tenantName ?? "",
        planTier: m.planTier ?? "starter",
        status: m.status ?? "trial",
        role: m.role,
        onboardingCompletedAt: m.onboardingCompletedAt?.toISOString(),
        invitesSent: 0,
        alreadyOnboarded: true,
      });
      return;
    }

    // ── 2. Resolve the user's Clerk profile (email + name) ──────────────────
    let userEmail = "";
    let firstName: string | null = null;
    let lastName: string | null = null;

    try {
      const clerkUser = await clerk.users.getUser(clerkId);
      const primary =
        clerkUser.emailAddresses.find(
          (e) => e.id === clerkUser.primaryEmailAddressId,
        ) ?? clerkUser.emailAddresses[0];
      userEmail = primary?.emailAddress ?? "";
      firstName = clerkUser.firstName ?? null;
      lastName = clerkUser.lastName ?? null;
    } catch (err) {
      logger.warn(
        { err, clerkId },
        "Failed to fetch Clerk user during onboarding; proceeding without profile",
      );
    }

    if (!userEmail) {
      res.status(400).json({
        error:
          "Your Clerk account has no verified email address. Please add one before creating a workspace.",
        code: "MISSING_EMAIL",
      });
      return;
    }

    // ── 3. Create the tenant ───────────────────────────────────────────────
    const slug = await ensureUniqueSlug(slugify(data.companyName));
    const now = new Date();

    const [tenant] = await adminDb
      .insert(tenantsTable)
      .values({
        name: data.companyName,
        slug,
        status: "trial",
        planTier: data.planTier ?? "starter",
        currency: data.currency ?? "USD",
        timezone: data.timezone ?? "UTC",
        industryType: data.industryType ?? null,
        email: userEmail,
        onboardingCompletedAt: now,
      })
      .returning();

    if (!tenant) {
      res.status(500).json({ error: "Failed to create tenant" });
      return;
    }

    // ── 4. Create the user's tenant_admin membership ────────────────────────
    await adminDb.insert(tenantMembershipsTable).values({
      tenantId: tenant.id,
      clerkId,
      email: userEmail,
      firstName,
      lastName,
      role: "tenant_admin",
      isActive: "true",
    });

    // ── 5. Persist invites as pending memberships and dispatch via Clerk ────
    // We use Clerk's Invitations API which sends a real, branded email and
    // generates a tokenized accept link. When the invitee signs up via that
    // link, the publicMetadata we attach (tenantId, role) survives onto the
    // new Clerk user; on their first call to GET /auth/me the lazy
    // claim-pending-invites step (see routes/auth.ts) flips the pending
    // membership row into an active one.
    let invitesSent = 0;
    const inviteResults: Array<{
      email: string;
      role: string;
      delivered: boolean;
      reason?: string;
      clerkInvitationId?: string;
    }> = [];

    if (data.invites && data.invites.length > 0) {
      // Deduplicate invites by email and skip the inviter themselves
      const seen = new Set<string>([userEmail.toLowerCase()]);
      const inviteRows: Array<typeof tenantMembershipsTable.$inferInsert> = [];

      for (const invite of data.invites) {
        const lower = invite.email.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        inviteRows.push({
          tenantId: tenant.id,
          clerkId: pendingClerkIdForEmail(lower),
          email: lower,
          role: invite.role,
          isActive: "false",
        });
      }

      if (inviteRows.length > 0) {
        await adminDb.insert(tenantMembershipsTable).values(inviteRows);

        const redirectUrl = resolveInviteRedirectUrl(req);

        // Dispatch each invite via Clerk. We catch per-invite errors so a
        // single failure doesn't roll back the whole onboarding (the pending
        // membership row is preserved either way, so an admin can resend).
        for (const row of inviteRows) {
          try {
            const invitation = await clerk.invitations.createInvitation({
              emailAddress: row.email!,
              redirectUrl,
              publicMetadata: {
                pendingTenantId: tenant.id,
                pendingRole: row.role,
              },
              ignoreExisting: true,
              notify: true,
            });
            invitesSent += 1;
            inviteResults.push({
              email: row.email!,
              role: row.role!,
              delivered: true,
              clerkInvitationId: invitation.id,
            });
            logger.info(
              {
                tenantId: tenant.id,
                tenantName: tenant.name,
                inviteEmail: row.email,
                role: row.role,
                clerkInvitationId: invitation.id,
              },
              "Onboarding invite dispatched via Clerk",
            );
          } catch (err) {
            const reason =
              err instanceof Error ? err.message : "Unknown invite error";
            inviteResults.push({
              email: row.email!,
              role: row.role!,
              delivered: false,
              reason,
            });
            logger.error(
              {
                err,
                tenantId: tenant.id,
                inviteEmail: row.email,
              },
              "Onboarding invite dispatch failed (pending row preserved for retry)",
            );
          }
        }

        await writeAuditLog({
          req,
          actorClerkId: clerkId,
          actorEmail: userEmail,
          tenantId: tenant.id,
          action: "tenant.invites_sent",
          entityType: "tenant",
          entityId: tenant.id,
          newValues: {
            invites: inviteResults,
          },
        });
      }
    }

    // ── 6. Audit log + Clerk metadata backfill ─────────────────────────────
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
        invitesSent,
      },
    });

    // Backfill tenantId into Clerk publicMetadata so future JWTs carry it.
    // Merge with any existing metadata so we don't clobber unrelated keys
    // (e.g. an `isSuperAdmin` flag set elsewhere).
    void (async () => {
      try {
        const u = await clerk.users.getUser(clerkId);
        const existing = (u.publicMetadata ?? {}) as Record<string, unknown>;
        await clerk.users.updateUser(clerkId, {
          publicMetadata: { ...existing, tenantId: tenant.id },
        });
      } catch (err: unknown) {
        logger.warn(
          { err, clerkId, tenantId: tenant.id },
          "Failed to backfill tenantId into Clerk publicMetadata after onboarding",
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
      onboardingCompletedAt: tenant.onboardingCompletedAt?.toISOString(),
      invitesSent,
      invitesAttempted: inviteResults.length,
      invites: inviteResults,
      alreadyOnboarded: false,
    });
  },
);

export default router;

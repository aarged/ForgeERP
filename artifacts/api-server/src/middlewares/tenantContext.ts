import type { Request, Response, NextFunction } from "express";
import { getAuth, createClerkClient } from "@clerk/express";
import { eq, and } from "drizzle-orm";
import { adminPool, tenantMembershipsTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { logger } from "../lib/logger";

const adminDb = drizzle(adminPool, { schema });

export interface TenantRequest extends Request {
  clerkUserId: string;
  tenantId: number;
  userRole: string;
  userEmail: string;
}

/**
 * Clerk backend client — used to sync tenantId into publicMetadata
 * so future JWTs carry the claim natively.
 */
const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

/**
 * tenantContext middleware
 *
 * Resolves the active tenant for an authenticated request:
 * 1. Reads `tenantId` from the JWT session claim (backfilled via Clerk publicMetadata).
 * 2. Falls back to a DB membership lookup by clerkId when the claim is missing.
 *    On success, backfills `publicMetadata.tenantId` for future requests.
 * 3. Attaches clerkUserId / tenantId / userRole / userEmail to the request.
 *
 * Uses adminPool (superuser) for membership lookups so RLS does not block
 * bootstrapping — app.tenant_id cannot be set before the tenant is resolved.
 */
export async function tenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth?.userId;

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // ── 1. Try reading tenantId from JWT session claims ───────────────────
    const claimedTenantId =
      (auth.sessionClaims?.tenantId as number | string | undefined) ??
      (auth.sessionClaims?.pub_metadata as Record<string, unknown> | undefined)
        ?.tenantId;

    let tenantId: number | null = null;
    let role: string | null = null;
    let email: string | null = null;

    if (claimedTenantId) {
      const numericTenantId = Number(claimedTenantId);
      if (!Number.isNaN(numericTenantId)) {
        const rows = await adminDb
          .select({
            role: tenantMembershipsTable.role,
            email: tenantMembershipsTable.email,
          })
          .from(tenantMembershipsTable)
          .where(
            and(
              eq(tenantMembershipsTable.clerkId, userId),
              eq(tenantMembershipsTable.tenantId, numericTenantId),
              eq(tenantMembershipsTable.isActive, "true"),
            ),
          )
          .limit(1);

        if (rows.length > 0) {
          tenantId = numericTenantId;
          role = rows[0]!.role;
          email = rows[0]!.email;
        }
      }
    }

    // ── 2. Fall back to DB lookup if JWT claim was absent or invalid ──────
    if (tenantId === null) {
      const memberships = await adminDb
        .select({
          tenantId: tenantMembershipsTable.tenantId,
          role: tenantMembershipsTable.role,
          email: tenantMembershipsTable.email,
        })
        .from(tenantMembershipsTable)
        .where(
          and(
            eq(tenantMembershipsTable.clerkId, userId),
            eq(tenantMembershipsTable.isActive, "true"),
          ),
        )
        .limit(1);

      if (memberships.length === 0) {
        res.status(403).json({
          error:
            "No active tenant membership found. Please complete onboarding.",
          code: "NO_TENANT_MEMBERSHIP",
        });
        return;
      }

      const membership = memberships[0]!;
      tenantId = membership.tenantId;
      role = membership.role;
      email = membership.email;

      // Backfill Clerk publicMetadata so future JWTs carry the tenantId claim.
      // Fire-and-forget: do not block the request on this.
      clerk.users
        .updateUser(userId, { publicMetadata: { tenantId } })
        .catch((err: unknown) => {
          logger.warn(
            { err },
            "Failed to backfill tenantId into Clerk publicMetadata",
          );
        });
    }

    (req as TenantRequest).clerkUserId = userId;
    (req as TenantRequest).tenantId = tenantId;
    (req as TenantRequest).userRole = role!;
    (req as TenantRequest).userEmail = email!;

    next();
  } catch (err) {
    logger.error({ err }, "Failed to resolve tenant context");
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * requireRole: Use after tenantContext to gate a route by one or more roles.
 * super_admin always passes.
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantReq = req as TenantRequest;
    if (!tenantReq.userRole) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (
      tenantReq.userRole !== "super_admin" &&
      !allowedRoles.includes(tenantReq.userRole)
    ) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

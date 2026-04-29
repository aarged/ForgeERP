import type { Request, Response, NextFunction } from "express";
import { getAuth, createClerkClient } from "@clerk/express";
import { eq, and, sql } from "drizzle-orm";
import { db, tenantMembershipsTable } from "@workspace/db";
import { logger } from "../lib/logger";

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
 * Multi-tenant isolation is enforced at two levels:
 *   1. JWT claims  — After tenant assignment, `tenantId` is stored in
 *      Clerk publicMetadata and surfaced via the `pub_metadata.tenantId`
 *      session claim (requires the "Forge ERP" JWT template to be active).
 *      Reading from claims avoids a DB round-trip on every request.
 *   2. DB membership lookup — When the JWT claim is absent or stale (e.g.
 *      first login after being invited), we fall back to querying
 *      `tenant_memberships`. On success the claim is backfilled in Clerk.
 *
 * After the tenant is resolved, the middleware:
 *   - Sets `req.clerkUserId`, `req.tenantId`, `req.userRole`, `req.userEmail`
 *   - Runs `SELECT set_config('app.tenant_id', ?, false)` on the pool to
 *     prime the PostgreSQL RLS session variable for all queries in this handler.
 *
 * Returns 401 if not authenticated, 403 if no active tenant membership.
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
    // ── 1. Try reading tenantId from JWT session claims ─────────────────
    // Clerk includes publicMetadata in the JWT when a custom JWT template
    // with `{"tenantId": "{{user.public_metadata.tenantId}}"}` is active.
    // The claim is a string in JWT; coerce to number.
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
        // Verify the claim is still valid (membership active in DB)
        const rows = await db
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

    // ── 2. Fall back to DB lookup if JWT claim was absent or invalid ─────
    if (tenantId === null) {
      const memberships = await db
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
          error: "No active tenant membership found. Please complete onboarding.",
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
        .updateUser(userId, {
          publicMetadata: { tenantId },
        })
        .catch((err: unknown) => {
          logger.warn({ err }, "Failed to backfill tenantId into Clerk publicMetadata");
        });
    }

    // ── 3. Set PostgreSQL RLS session variable ────────────────────────────
    // `set_config(name, value, is_local = false)` persists for the pool
    // connection's lifetime, providing defense-in-depth alongside
    // application-layer tenant_id filtering.
    try {
      await db.execute(
        sql`SELECT set_config('app.tenant_id', ${tenantId.toString()}, false)`,
      );
    } catch (rlsErr) {
      logger.warn({ rlsErr }, "Could not set RLS tenant GUC — continuing");
    }

    // ── 4. Attach context to request ──────────────────────────────────────
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

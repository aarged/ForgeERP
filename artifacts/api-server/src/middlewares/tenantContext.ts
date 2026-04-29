import type { Request, Response, NextFunction } from "express";
import { getAuth, createClerkClient } from "@clerk/express";
import { eq, and } from "drizzle-orm";
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
 * ## What it does
 * 1. Verifies Clerk JWT and extracts clerkId.
 * 2. Resolves the active tenant:
 *    a. First tries the `tenantId` session claim (populated via Clerk publicMetadata
 *       and a "Forge ERP" JWT template in the Clerk dashboard: `{"tenantId": "{{user.public_metadata.tenantId}}"}`).
 *    b. Falls back to a DB membership lookup when the claim is absent or stale.
 *       On DB-lookup success, backfills `publicMetadata.tenantId` in Clerk so
 *       the next token refresh will carry the claim.
 * 3. Sets `req.clerkUserId`, `req.tenantId`, `req.userRole`, `req.userEmail`.
 * 4. Returns 401 if not authenticated, 403 + `NO_TENANT_MEMBERSHIP` code if
 *    the user is authenticated but has no active tenant (→ onboarding flow).
 *
 * ## Multi-tenant isolation
 * - Application-layer (PRIMARY): route handlers MUST filter every query with
 *   `.where(eq(table.tenantId, req.tenantId))`.
 * - Database-layer (DEFENSE-IN-DEPTH): for queries executed inside `withTenantDb()`
 *   the PostgreSQL RLS GUC is set transaction-locally. Do NOT call `set_config`
 *   with `is_local=false` on a pooled connection — this middleware does not do so.
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

    // ── 2. Fall back to DB lookup if JWT claim was absent or invalid ──────
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

    // ── 3. Attach context to request ──────────────────────────────────────
    // NOTE: Do NOT call set_config('app.tenant_id', ...) here on the shared
    // pool. For RLS-enforced queries, use withTenantDb(tenantId, ...) in the
    // route handler which sets the GUC transaction-locally on a dedicated
    // connection, preventing cross-request context leakage.
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

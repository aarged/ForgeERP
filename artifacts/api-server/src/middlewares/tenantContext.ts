import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
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
 * tenantContext middleware:
 * 1. Verifies Clerk JWT and extracts clerkId
 * 2. Looks up the active tenant membership to get tenantId and role
 * 3. Sets req.clerkUserId, req.tenantId, req.userRole, req.userEmail
 * 4. Returns 401 if not authenticated, 403 if no active tenant membership
 *
 * This is the primary enforcement point for multi-tenant data isolation.
 * All routes that access tenant-scoped data must use this middleware and
 * filter queries by req.tenantId.
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
      res.status(403).json({ error: "No active tenant membership found. Please complete onboarding." });
      return;
    }

    const membership = memberships[0]!;
    (req as TenantRequest).clerkUserId = userId;
    (req as TenantRequest).tenantId = membership.tenantId;
    (req as TenantRequest).userRole = membership.role;
    (req as TenantRequest).userEmail = membership.email;

    next();
  } catch (err) {
    logger.error({ err }, "Failed to resolve tenant context");
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * requireRole: Use after tenantContext to gate a route by one or more roles.
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

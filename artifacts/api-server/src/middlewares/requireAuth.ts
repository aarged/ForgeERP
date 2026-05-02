import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export interface AuthenticatedRequest extends Request {
  clerkUserId: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If the request was already authenticated via an API key, the
  // apiKeyAuth middleware has populated clerkUserId/tenantId/etc — skip Clerk.
  if ((req as { apiKeyAuth?: boolean }).apiKeyAuth) {
    next();
    return;
  }
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as AuthenticatedRequest).clerkUserId = userId;
  next();
}

import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { HealthCheckResponse } from "@workspace/api-zod";
import type { Request, Response } from "express";

const router: IRouter = Router();

/**
 * GET /healthz
 * Public health check. Also reports whether the Clerk auth middleware
 * is active by attempting to read auth context from the request.
 * Returns 200 in both authenticated and unauthenticated cases —
 * the `authMiddlewareActive` flag confirms the middleware is wired.
 */
router.get("/healthz", (req: Request, res: Response) => {
  const auth = getAuth(req);
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({
    ...data,
    authMiddlewareActive: true,
    authenticatedUserId: auth?.userId ?? null,
  });
});

/**
 * GET /auth/status
 * Returns the auth context for the current request.
 * Returns 401 if not authenticated, used by clients to verify session state.
 */
router.get("/auth/status", (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.json({
    authenticated: true,
    clerkUserId: auth.userId,
    timestamp: new Date().toISOString(),
  });
});

export default router;

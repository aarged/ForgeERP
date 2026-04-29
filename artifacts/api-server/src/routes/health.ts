import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { requireAuth, type AuthenticatedRequest } from "../middlewares/requireAuth";
import type { Request, Response } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/**
 * GET /auth/status
 * Returns the auth context for the current request.
 * Used to verify that the Clerk auth middleware is wired correctly.
 * Returns 401 if not authenticated.
 */
router.get("/auth/status", requireAuth, (req: Request, res: Response) => {
  const auth = req as AuthenticatedRequest;
  res.json({
    authenticated: true,
    clerkUserId: auth.clerkUserId,
    timestamp: new Date().toISOString(),
  });
});

export default router;

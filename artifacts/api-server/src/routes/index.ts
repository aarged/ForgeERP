import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import tenantsRouter from "./tenants";
import adminRouter from "./admin";
import onboardingRouter from "./onboarding";
import masterDataRouter from "./master-data";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(tenantsRouter);
router.use(adminRouter);
router.use(onboardingRouter);
router.use(masterDataRouter);

export default router;

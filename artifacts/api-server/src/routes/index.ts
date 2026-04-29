import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import tenantsRouter from "./tenants";
import adminRouter from "./admin";
import onboardingRouter from "./onboarding";
import masterDataRouter from "./master-data";
import procurementRouter from "./procurement";
import salesRouter from "./sales";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(tenantsRouter);
router.use(adminRouter);
router.use(onboardingRouter);
router.use(masterDataRouter);
router.use(procurementRouter);
router.use(salesRouter);

export default router;

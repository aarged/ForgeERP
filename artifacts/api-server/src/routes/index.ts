import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import tenantsRouter from "./tenants";
import adminRouter from "./admin";
import onboardingRouter from "./onboarding";
import masterDataRouter from "./master-data";
import procurementRouter from "./procurement";
import salesRouter from "./sales";
import inventoryRouter from "./inventory";
import financeRouter from "./finance";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import integrationsRouter from "./integrations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(tenantsRouter);
router.use(adminRouter);
router.use(onboardingRouter);
router.use(masterDataRouter);
router.use(procurementRouter);
router.use(salesRouter);
router.use(inventoryRouter);
router.use(financeRouter);
router.use(dashboardRouter);
router.use(storageRouter);
router.use(integrationsRouter);

export default router;

import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  purchaseRequisitionsTable,
  purchaseOrdersTable,
  approvalStepsTable,
  notificationsTable,
  tenantsTable,
} from "@workspace/db";
import { withTenantDb } from "@workspace/db/rls";
import { logger } from "./logger";

const ESCALATION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly

function genCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(6, "0")}`;
}

async function createEscalationNotification(
  tenantId: number,
  recipientClerkId: string,
  title: string,
  message: string,
  entityType: string,
  entityId: number,
  entityCode: string,
): Promise<void> {
  try {
    await withTenantDb(tenantId, (db) =>
      db.insert(notificationsTable).values({
        tenantId,
        recipientClerkId,
        type: "escalation",
        title,
        message,
        entityType,
        entityId,
        entityCode,
        isRead: false,
      }),
    );
  } catch (err) {
    logger.warn({ err }, "[escalation] Failed to create notification");
  }
}

async function processRequisitionEscalations(tenantId: number): Promise<void> {
  const overdue = await withTenantDb(tenantId, (db) =>
    db
      .select({
        id: purchaseRequisitionsTable.id,
        currentApprovalStep: purchaseRequisitionsTable.currentApprovalStep,
        approvalWorkflowId: purchaseRequisitionsTable.approvalWorkflowId,
        updatedAt: purchaseRequisitionsTable.updatedAt,
        requestedByClerkId: purchaseRequisitionsTable.requestedByClerkId,
        escalationDays: approvalStepsTable.escalationDays,
        approverUserIds: approvalStepsTable.approverUserIds,
      })
      .from(purchaseRequisitionsTable)
      .leftJoin(
        approvalStepsTable,
        and(
          eq(approvalStepsTable.workflowId, purchaseRequisitionsTable.approvalWorkflowId!),
          eq(approvalStepsTable.stepNumber, purchaseRequisitionsTable.currentApprovalStep!),
          eq(approvalStepsTable.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseRequisitionsTable.tenantId, tenantId),
          eq(purchaseRequisitionsTable.status, "pending_approval"),
          isNull(purchaseRequisitionsTable.deletedAt),
        ),
      ),
  );

  for (const req of overdue) {
    const escalationDays = req.escalationDays ?? 3;
    const stepAge = Date.now() - new Date(req.updatedAt).getTime();
    const escalationMs = escalationDays * 24 * 60 * 60 * 1000;
    if (stepAge < escalationMs) continue;

    const code = genCode("REQ", req.id);
    logger.info({ tenantId, reqId: req.id, code }, "[escalation] Requisition overdue for approval");

    const adminUserIds = (req.approverUserIds as string[]) ?? [];
    const notifyIds = adminUserIds.length > 0 ? adminUserIds : [req.requestedByClerkId ?? ""].filter(Boolean);

    for (const uid of notifyIds) {
      await createEscalationNotification(
        tenantId,
        uid,
        "Approval Escalation — Requisition Overdue",
        `Purchase Requisition ${code} has been awaiting approval for over ${escalationDays} day(s). Please review and take action.`,
        "purchase_requisition",
        req.id,
        code,
      );
    }
  }
}

async function processPurchaseOrderEscalations(tenantId: number): Promise<void> {
  const overdue = await withTenantDb(tenantId, (db) =>
    db
      .select({
        id: purchaseOrdersTable.id,
        currentApprovalStep: purchaseOrdersTable.currentApprovalStep,
        approvalWorkflowId: purchaseOrdersTable.approvalWorkflowId,
        updatedAt: purchaseOrdersTable.updatedAt,
        createdByClerkId: purchaseOrdersTable.createdByClerkId,
        escalationDays: approvalStepsTable.escalationDays,
        approverUserIds: approvalStepsTable.approverUserIds,
      })
      .from(purchaseOrdersTable)
      .leftJoin(
        approvalStepsTable,
        and(
          eq(approvalStepsTable.workflowId, purchaseOrdersTable.approvalWorkflowId!),
          eq(approvalStepsTable.stepNumber, purchaseOrdersTable.currentApprovalStep!),
          eq(approvalStepsTable.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(purchaseOrdersTable.tenantId, tenantId),
          eq(purchaseOrdersTable.status, "pending_approval"),
          isNull(purchaseOrdersTable.deletedAt),
        ),
      ),
  );

  for (const po of overdue) {
    const escalationDays = po.escalationDays ?? 3;
    const stepAge = Date.now() - new Date(po.updatedAt).getTime();
    const escalationMs = escalationDays * 24 * 60 * 60 * 1000;
    if (stepAge < escalationMs) continue;

    const code = genCode("PO", po.id);
    logger.info({ tenantId, poId: po.id, code }, "[escalation] Purchase Order overdue for approval");

    const adminUserIds = (po.approverUserIds as string[]) ?? [];
    const notifyIds = adminUserIds.length > 0 ? adminUserIds : [po.createdByClerkId ?? ""].filter(Boolean);

    for (const uid of notifyIds) {
      await createEscalationNotification(
        tenantId,
        uid,
        "Approval Escalation — Purchase Order Overdue",
        `Purchase Order ${code} has been awaiting approval for over ${escalationDays} day(s). Please review and take action.`,
        "purchase_order",
        po.id,
        code,
      );
    }
  }
}

async function runEscalationCheck(): Promise<void> {
  logger.info("[escalation] Running approval escalation check");
  try {
    // Collect active tenant IDs from the master DB
    const tenants = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.status, "active"));

    await Promise.allSettled(
      tenants.map(async (t) => {
        try {
          await Promise.all([
            processRequisitionEscalations(t.id),
            processPurchaseOrderEscalations(t.id),
          ]);
        } catch (err) {
          logger.warn({ err, tenantId: t.id }, "[escalation] Error processing tenant escalations");
        }
      }),
    );
  } catch (err) {
    logger.warn({ err }, "[escalation] Failed to fetch tenants for escalation check");
  }
}

export function startEscalationWorker(): NodeJS.Timeout {
  logger.info("[escalation] Approval escalation worker started");
  // Run once shortly after startup, then on interval
  setTimeout(() => runEscalationCheck().catch((e) => logger.warn({ e }, "[escalation] Initial check failed")), 30_000);
  return setInterval(() => runEscalationCheck().catch((e) => logger.warn({ e }, "[escalation] Interval check failed")), ESCALATION_CHECK_INTERVAL_MS);
}

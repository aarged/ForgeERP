import { Router, type IRouter } from "express";
import { eq, and, ilike, or, isNull, desc, asc, sql, inArray } from "drizzle-orm";
import {
  approvalWorkflowsTable,
  approvalStepsTable,
  approvalDecisionsTable,
  purchaseRequisitionsTable,
  requisitionLinesTable,
  purchaseOrdersTable,
  poLinesTable,
  poReceiptsTable,
  receiptLinesTable,
  poReturnsTable,
  poReturnLinesTable,
  glPostingsTable,
  inventoryStockTable,
  inventoryMovementsTable,
  suppliersTable,
  warehousesTable,
  itemsTable,
  glAccountsTable,
  notificationsTable,
} from "@workspace/db";
import { withTenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import type { Request, Response } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";

const router: IRouter = Router();

const tenantUserMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("viewer", "purchaser", "warehouse", "approver", "accountant", "tenant_admin", "super_admin"),
];

const tenantWriteMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("purchaser", "warehouse", "approver", "accountant", "tenant_admin", "super_admin"),
];

const tenantAdminMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("tenant_admin", "super_admin"),
];

// Approval actions are restricted to designated approvers, admins, and super-admins
const approverMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("approver", "tenant_admin", "super_admin"),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createNotification(
  tenantId: number,
  recipientClerkId: string,
  type: string,
  title: string,
  message: string,
  opts: { entityType?: string; entityId?: number; entityCode?: string } = {},
): Promise<void> {
  try {
    await withTenantDb(tenantId, (db) =>
      db.insert(notificationsTable).values({
        tenantId,
        recipientClerkId,
        type,
        title,
        message,
        entityType: opts.entityType,
        entityId: opts.entityId,
        entityCode: opts.entityCode,
        isRead: false,
      }),
    );
  } catch {
    // Notification failures are non-blocking — never let them crash a business transaction
  }
}

function genCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(6, "0")}`;
}

async function updatePoTotals(tenantId: number, poId: number) {
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poLinesTable)
      .where(and(eq(poLinesTable.poId, poId), eq(poLinesTable.tenantId, tenantId))),
  );
  let subtotal = 0;
  let taxAmount = 0;
  for (const l of lines) {
    const qty = Number(l.quantity);
    const up = Number(l.unitPrice);
    const disc = Number(l.discountPct ?? 0) / 100;
    const tax = Number(l.taxPct ?? 0) / 100;
    const lineBase = qty * up * (1 - disc);
    subtotal += lineBase;
    taxAmount += lineBase * tax;
  }
  const total = subtotal + taxAmount;
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable)
      .set({
        subtotal: subtotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: total.toFixed(2),
      })
      .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.tenantId, tenantId))),
  );
  return { subtotal, taxAmount, total };
}

async function updateReqTotals(tenantId: number, reqId: number) {
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(requisitionLinesTable)
      .where(and(eq(requisitionLinesTable.requisitionId, reqId), eq(requisitionLinesTable.tenantId, tenantId))),
  );
  const total = lines.reduce((sum, l) => sum + Number(l.estimatedTotal ?? 0), 0);
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({ totalEstimated: total.toFixed(2) })
      .where(and(eq(purchaseRequisitionsTable.id, reqId), eq(purchaseRequisitionsTable.tenantId, tenantId))),
  );
  return total;
}

async function postInventoryReceipt(tenantId: number, receiptId: number, postedByClerkId: string) {
  const receiptLines = await withTenantDb(tenantId, (db) =>
    db.select().from(receiptLinesTable)
      .where(and(eq(receiptLinesTable.receiptId, receiptId), eq(receiptLinesTable.tenantId, tenantId))),
  );
  const receipt = await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.id, receiptId), eq(poReceiptsTable.tenantId, tenantId)))
      .limit(1),
  );
  const rcpt = receipt[0];
  if (!rcpt) return;
  // A valid warehouse is required for inventory posting; skip posting if missing
  if (!rcpt.warehouseId) return;

  for (const line of receiptLines) {
    if (!line.itemId || Number(line.receivedQty) <= 0) continue;

    const warehouseId = rcpt.warehouseId;
    const locationId = line.locationId ?? rcpt.locationId;
    const qty = Number(line.receivedQty);

    const existing = await withTenantDb(tenantId, (db) =>
      db.select().from(inventoryStockTable)
        .where(and(
          eq(inventoryStockTable.tenantId, tenantId),
          eq(inventoryStockTable.itemId, line.itemId!),
          eq(inventoryStockTable.warehouseId, warehouseId),
          locationId ? eq(inventoryStockTable.locationId, locationId) : isNull(inventoryStockTable.locationId),
          line.lotNumber ? eq(inventoryStockTable.lotNumber, line.lotNumber) : isNull(inventoryStockTable.lotNumber),
          line.batchNumber ? eq(inventoryStockTable.batchNumber, line.batchNumber) : isNull(inventoryStockTable.batchNumber),
        ))
        .limit(1),
    );

    if (existing.length > 0) {
      const cur = existing[0]!;
      const newQty = Number(cur.qtyOnHand) + qty;
      // curCost = existing average cost (used only when qtyOnHand > 0; newAvgCost handles the 0-stock case)
      const curCost = Number(cur.averageCost ?? 0);
      const newAvgCost = Number(cur.qtyOnHand) === 0
        ? Number(line.unitCost ?? 0)
        : (Number(cur.qtyOnHand) * curCost + qty * Number(line.unitCost ?? 0)) / newQty;
      await withTenantDb(tenantId, (db) =>
        db.update(inventoryStockTable)
          .set({
            qtyOnHand: newQty.toFixed(4),
            averageCost: newAvgCost.toFixed(4),
            lastMovementAt: new Date(),
          })
          .where(and(eq(inventoryStockTable.id, cur.id), eq(inventoryStockTable.tenantId, tenantId))),
      );
    } else {
      await withTenantDb(tenantId, (db) =>
        db.insert(inventoryStockTable).values({
          tenantId,
          itemId: line.itemId!,
          warehouseId,
          locationId: locationId ?? undefined,
          lotNumber: line.lotNumber ?? undefined,
          batchNumber: line.batchNumber ?? undefined,
          serialNumber: line.serialNumber ?? undefined,
          expiryDate: line.expiryDate ?? undefined,
          qtyOnHand: qty.toFixed(4),
          averageCost: line.unitCost ?? undefined,
          lastMovementAt: new Date(),
        } as typeof inventoryStockTable.$inferInsert),
      );
    }

    // Record movement
    await withTenantDb(tenantId, (db) =>
      db.insert(inventoryMovementsTable).values({
        tenantId,
        itemId: line.itemId!,
        warehouseId,
        locationId: locationId ?? undefined,
        movementType: "receipt",
        quantity: qty.toFixed(4),
        unitCost: line.unitCost ?? undefined,
        refType: "po_receipt",
        refId: receiptId,
        lotNumber: line.lotNumber ?? undefined,
        batchNumber: line.batchNumber ?? undefined,
        serialNumber: line.serialNumber ?? undefined,
        postedByClerkId,
      } as typeof inventoryMovementsTable.$inferInsert),
    );

    // Update po_line received qty
    await withTenantDb(tenantId, (db) =>
      db.update(poLinesTable)
        .set({ receivedQty: sql`${poLinesTable.receivedQty} + ${qty.toFixed(4)}` })
        .where(and(eq(poLinesTable.id, line.poLineId), eq(poLinesTable.tenantId, tenantId))),
    );
  }
}

/**
 * Select the most specific matching approval workflow for an entity.
 * Evaluates triggerRules: valueAbove, supplierIds, warehouseIds, itemCategories.
 * Returns the first workflow whose rules all match, or null if no workflow matches.
 */
async function selectWorkflow(
  tenantId: number,
  entityType: "purchase_requisition" | "purchase_order",
  context: {
    totalValue?: number | string | null;
    supplierId?: number | null;
    warehouseId?: number | null;
    /** Item categories from lines */
    lineCategories?: string[];
  },
): Promise<typeof approvalWorkflowsTable.$inferSelect | null> {
  const workflows = await withTenantDb(tenantId, (db) =>
    db.select().from(approvalWorkflowsTable)
      .where(and(
        eq(approvalWorkflowsTable.tenantId, tenantId),
        eq(approvalWorkflowsTable.entityType, entityType),
        eq(approvalWorkflowsTable.isActive, true),
      )));

  for (const w of workflows) {
    const rules = (w.triggerRules ?? {}) as {
      valueAbove?: number;
      supplierIds?: number[];
      warehouseIds?: number[];
      itemCategories?: string[];
    };

    // Value threshold filter
    if (rules.valueAbove !== undefined && (context.totalValue === undefined || context.totalValue === null || Number(context.totalValue) < rules.valueAbove)) continue;
    // Supplier filter
    if (rules.supplierIds && rules.supplierIds.length > 0 && (!context.supplierId || !rules.supplierIds.includes(context.supplierId))) continue;
    // Warehouse filter
    if (rules.warehouseIds && rules.warehouseIds.length > 0 && (!context.warehouseId || !rules.warehouseIds.includes(context.warehouseId))) continue;
    // Item category filter — any line's category must be in the list
    if (rules.itemCategories && rules.itemCategories.length > 0) {
      const hasMatchingCategory = (context.lineCategories ?? []).some((cat) => rules.itemCategories!.includes(cat));
      if (!hasMatchingCategory) continue;
    }

    return w;
  }
  // No rule-matching workflow found — fall back to any unconstrained active workflow
  const unconstrained = workflows.find((w) => {
    const rules = (w.triggerRules ?? {}) as { valueAbove?: number; supplierIds?: number[]; warehouseIds?: number[]; itemCategories?: string[] };
    return !rules.valueAbove && (!rules.supplierIds?.length) && (!rules.warehouseIds?.length) && (!rules.itemCategories?.length);
  });
  return unconstrained ?? null;
}

/** Resolve a GL account for a tenant by ID (with fallback code/name when not configured). */
async function resolveGlAccount(tenantId: number, glAccountId: number | null | undefined, fallbackCode: string, fallbackName: string) {
  if (glAccountId) {
    const [acct] = await withTenantDb(tenantId, (db) =>
      db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.id, glAccountId), eq(glAccountsTable.tenantId, tenantId)))
        .limit(1));
    if (acct) return { accountCode: acct.code, accountName: acct.name };
  }
  // Try to find account by code in the tenant's chart of accounts
  const [byCode] = await withTenantDb(tenantId, (db) =>
    db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
      .from(glAccountsTable)
      .where(and(eq(glAccountsTable.code, fallbackCode), eq(glAccountsTable.tenantId, tenantId)))
      .limit(1));
  return { accountCode: byCode?.code ?? fallbackCode, accountName: byCode?.name ?? fallbackName };
}

async function createGlPosting(tenantId: number, receiptId: number, postedByClerkId: string, postedByEmail?: string) {
  const receipt = (await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.id, receiptId), eq(poReceiptsTable.tenantId, tenantId))).limit(1),
  ))[0];
  if (!receipt) return null;

  const po = (await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, receipt.poId), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1),
  ))[0];
  if (!po) return null;

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(receiptLinesTable)
      .where(and(eq(receiptLinesTable.receiptId, receiptId), eq(receiptLinesTable.tenantId, tenantId))),
  );

  // Look up PO lines to get per-line GL account assignments from the master chart of accounts
  const poLineIds = lines.map((l) => l.poLineId).filter(Boolean) as number[];
  const poLineRows = poLineIds.length > 0
    ? await withTenantDb(tenantId, (db) =>
        db.select({ id: poLinesTable.id, glAccountId: poLinesTable.glAccountId })
          .from(poLinesTable).where(inArray(poLinesTable.id, poLineIds)))
    : [];
  const poLineGlMap = new Map(poLineRows.map((pl) => [pl.id, pl.glAccountId]));

  // Resolve the AP account from the chart of accounts (default code 2100)
  const apAccount = await resolveGlAccount(tenantId, null, "2100", "Accounts Payable");

  // Build GL lines: Dr Inventory Account (per PO line) / Cr Accounts Payable
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

  let totalValue = 0;
  for (const rl of lines) {
    const lineVal = Number(rl.receivedQty) * Number(rl.unitCost ?? 0);
    totalValue += lineVal;
    // Derive inventory account from the PO line's glAccountId assignment
    const invAccount = await resolveGlAccount(tenantId, poLineGlMap.get(rl.poLineId) ?? null, "1300", "Inventory");
    glLines.push({
      ...invAccount,
      debit: lineVal, credit: 0,
      description: `Receipt of ${rl.itemCode ?? rl.itemName ?? "item"}`,
    });
  }
  glLines.push({
    ...apAccount,
    debit: 0, credit: totalValue,
    description: `AP for PO ${po.code}`,
  });

  const [posting] = await withTenantDb(tenantId, (db) =>
    db.insert(glPostingsTable).values({
      tenantId,
      code: `GL-${Date.now()}`,
      entityType: "po_receipt",
      entityId: receiptId,
      status: "posted",
      postedByClerkId,
      postedByEmail: postedByEmail ?? undefined,
      postedAt: new Date(),
      lines: glLines,
      totalDebit: totalValue.toFixed(2),
      totalCredit: totalValue.toFixed(2),
    } as typeof glPostingsTable.$inferInsert).returning(),
  );

  return posting;
}

// ── Return / RTV Credit-Note GL Posting ───────────────────────────────────────

async function createReturnGlPosting(tenantId: number, returnId: number, postedByClerkId: string, postedByEmail?: string) {
  const [ret] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnsTable).where(and(eq(poReturnsTable.id, returnId), eq(poReturnsTable.tenantId, tenantId))).limit(1));
  if (!ret) return null;

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnLinesTable).where(and(eq(poReturnLinesTable.returnId, returnId), eq(poReturnLinesTable.tenantId, tenantId))));

  // Credit note: Dr AP / Cr Inventory (reverse of goods receipt)
  // Resolve AP and Inventory accounts from tenant's chart of accounts
  const apAccount = await resolveGlAccount(tenantId, null, "2100", "Accounts Payable");

  let totalValue = 0;
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];
  for (const rl of lines) {
    if (Number(rl.quantity) <= 0) continue;
    const lineVal = Number(rl.quantity) * Number(rl.unitCost ?? 0);
    totalValue += lineVal;
    // Look up the inventory account via item's GL account if set, otherwise fall back to "1300"
    const invAccount = await resolveGlAccount(tenantId, null, "1300", "Inventory");
    glLines.push({
      ...invAccount,
      debit: 0, credit: lineVal,
      description: `RTV of ${rl.itemCode ?? rl.itemName ?? "item"}`,
    });
  }
  if (totalValue === 0) return null;
  glLines.push({
    ...apAccount,
    debit: totalValue, credit: 0,
    description: `AP credit note for return ${returnId}`,
  });

  const [posting] = await withTenantDb(tenantId, (db) =>
    db.insert(glPostingsTable).values({
      tenantId,
      code: `GL-RTV-${Date.now()}`,
      entityType: "po_return",
      entityId: returnId,
      status: "posted",
      postedByClerkId,
      postedByEmail: postedByEmail ?? undefined,
      postedAt: new Date(),
      lines: glLines,
      totalDebit: totalValue.toFixed(2),
      totalCredit: totalValue.toFixed(2),
    } as typeof glPostingsTable.$inferInsert).returning());

  return posting;
}

// ── Step-Based Approval Engine ────────────────────────────────────────────────

/**
 * Execute an approval decision, enforcing:
 * - Entity must be in `pending_approval` state.
 * - Actor must match the step's approverRoles/approverUserIds for ALL decision types (approved/rejected/returned).
 * - For "approved" decisions: additionally enforces the step's valueLimit authority constraint.
 * - On approval, advances to the next step or finalises to "approved".
 *
 * Returns `{ newStatus, newStepNum }` — callers must persist these to the entity.
 */
async function executeApprovalDecision(opts: {
  tenantId: number;
  entityType: "purchase_requisition" | "purchase_order";
  entityId: number;
  workflowId: number | null | undefined;
  currentStepNum: number;
  entityTotal: string | null | undefined;
  actorClerkId: string;
  actorEmail: string;
  actorRole: string;
  decision: "approved" | "rejected" | "returned";
  comment?: string;
}): Promise<{ newStatus: string; newStepNum: number }> {
  const { tenantId, entityType, entityId, workflowId, currentStepNum, entityTotal, actorClerkId, actorEmail, actorRole, decision, comment } = opts;

  // Load and validate the current step for ALL decision types
  if (workflowId) {
    const [step] = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(
          eq(approvalStepsTable.workflowId, workflowId),
          eq(approvalStepsTable.tenantId, tenantId),
          eq(approvalStepsTable.stepNumber, currentStepNum),
        ))
        .limit(1));

    if (step) {
      const approverRoles = (step.approverRoles as string[]) ?? [];
      const approverUserIds = (step.approverUserIds as string[]) ?? [];
      const hasRoleConstraint = approverRoles.length > 0;
      const hasUserConstraint = approverUserIds.length > 0;

      // Eligibility rules:
      // • No constraints → any approver-role user is eligible (open step)
      // • Role constraint only → actor's role must be in the list
      // • User constraint only → actor's clerk ID must be in the list
      // • Both constraints → either role OR user match is sufficient
      if (hasRoleConstraint || hasUserConstraint) {
        const roleOk = hasRoleConstraint && approverRoles.includes(actorRole);
        const userOk = hasUserConstraint && approverUserIds.includes(actorClerkId);
        if (!roleOk && !userOk) {
          throw Object.assign(
            new Error("You are not an eligible approver for this step"),
            { statusCode: 403 },
          );
        }
      }

      // Authority / value limit — only enforced for "approved" decisions
      if (decision === "approved" && step.valueLimit != null && entityTotal != null) {
        if (Number(entityTotal) > Number(step.valueLimit)) {
          throw Object.assign(
            new Error(`Your authority limit for this step is ${step.valueLimit}. The document value exceeds this limit.`),
            { statusCode: 403 },
          );
        }
      }
    }
  }

  // Record and return non-approval decisions (rejected / returned)
  if (decision !== "approved") {
    await withTenantDb(tenantId, (db) =>
      db.insert(approvalDecisionsTable).values({
        tenantId,
        workflowId: workflowId ?? undefined,
        stepNumber: currentStepNum,
        entityType,
        entityId,
        approverClerkId: actorClerkId,
        approverEmail: actorEmail,
        decision,
        comment,
      } as typeof approvalDecisionsTable.$inferInsert));
    return { newStatus: decision === "rejected" ? "rejected" : "returned", newStepNum: currentStepNum };
  }

  // Record the decision
  await withTenantDb(tenantId, (db) =>
    db.insert(approvalDecisionsTable).values({
      tenantId,
      workflowId: workflowId ?? undefined,
      stepNumber: currentStepNum,
      entityType,
      entityId,
      approverClerkId: actorClerkId,
      approverEmail: actorEmail,
      decision: "approved",
      comment,
    } as typeof approvalDecisionsTable.$inferInsert));

  // For "all" mode with explicit user list: check if all required approvers have now approved
  if (workflowId) {
    const [step] = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(
          eq(approvalStepsTable.workflowId, workflowId),
          eq(approvalStepsTable.tenantId, tenantId),
          eq(approvalStepsTable.stepNumber, currentStepNum),
        ))
        .limit(1));

    if (step && step.approvalMode === "all") {
      const requiredUserIds = (step.approverUserIds as string[]) ?? [];
      if (requiredUserIds.length > 0) {
        // Fetch all distinct approvals at this step (including the one just recorded)
        const existingApprovals = await withTenantDb(tenantId, (db) =>
          db.select({ approverClerkId: approvalDecisionsTable.approverClerkId })
            .from(approvalDecisionsTable)
            .where(and(
              eq(approvalDecisionsTable.tenantId, tenantId),
              eq(approvalDecisionsTable.entityType, entityType),
              eq(approvalDecisionsTable.entityId, entityId),
              eq(approvalDecisionsTable.stepNumber, currentStepNum),
              eq(approvalDecisionsTable.decision, "approved"),
            )));
        const approvedIds = new Set(existingApprovals.map((d) => d.approverClerkId));
        const allApproved = requiredUserIds.every((uid) => approvedIds.has(uid));
        if (!allApproved) {
          // Still waiting for more approvers — stay in pending_approval at the same step
          return { newStatus: "pending_approval", newStepNum: currentStepNum };
        }
      }
      // Role-only "all" mode: best-effort — treat as "any" (can't enumerate all users with a role)
    }
  }

  // Check for subsequent steps
  if (workflowId) {
    const [nextStep] = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(
          eq(approvalStepsTable.workflowId, workflowId),
          eq(approvalStepsTable.tenantId, tenantId),
          sql`${approvalStepsTable.stepNumber} > ${currentStepNum}`,
        ))
        .orderBy(asc(approvalStepsTable.stepNumber))
        .limit(1));

    if (nextStep) {
      return { newStatus: "pending_approval", newStepNum: nextStep.stepNumber };
    }
  }

  return { newStatus: "approved", newStepNum: 0 };
}

// ── Approval Workflows ────────────────────────────────────────────────────────

router.get("/procurement/approval-workflows", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(approvalWorkflowsTable)
      .where(eq(approvalWorkflowsTable.tenantId, tenantId))
      .orderBy(asc(approvalWorkflowsTable.name)),
  );
  res.json(rows);
});

router.post("/procurement/approval-workflows", ...tenantAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    entityType: z.enum(["purchase_requisition", "purchase_order"]).default("purchase_order"),
    isActive: z.boolean().default(true),
    triggerRules: z.record(z.unknown()).default({}),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [wf] = await withTenantDb(tenantId, (db) =>
    db.insert(approvalWorkflowsTable).values({ ...parsed.data, tenantId } as typeof approvalWorkflowsTable.$inferInsert).returning(),
  );
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "approval_workflow.created", entityType: "approval_workflow", entityId: String(wf!.id), newValues: parsed.data });
  res.status(201).json(wf);
});

router.patch("/procurement/approval-workflows/:id", ...tenantAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    entityType: z.enum(["purchase_requisition", "purchase_order"]).optional(),
    isActive: z.boolean().optional(),
    triggerRules: z.record(z.unknown()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [wf] = await withTenantDb(tenantId, (db) =>
    db.update(approvalWorkflowsTable).set(parsed.data as Record<string, unknown>)
      .where(and(eq(approvalWorkflowsTable.id, id), eq(approvalWorkflowsTable.tenantId, tenantId))).returning(),
  );
  if (!wf) { res.status(404).json({ error: "Workflow not found" }); return; }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "approval_workflow.updated", entityType: "approval_workflow", entityId: String(id), newValues: parsed.data });
  res.json(wf);
});

router.get("/procurement/approval-workflows/:id/steps", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const steps = await withTenantDb(tenantId, (db) =>
    db.select().from(approvalStepsTable)
      .where(and(eq(approvalStepsTable.workflowId, id), eq(approvalStepsTable.tenantId, tenantId)))
      .orderBy(asc(approvalStepsTable.stepNumber)),
  );
  res.json(steps);
});

router.post("/procurement/approval-workflows/:id/steps", ...tenantAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const workflowId = Number(req.params.id);
  const schema = z.object({
    stepNumber: z.number().int().positive(),
    stepName: z.string().min(1),
    approverType: z.enum(["role", "user"]).default("role"),
    approverRoles: z.array(z.string()).default([]),
    approverUserIds: z.array(z.string()).default([]),
    approvalMode: z.enum(["any", "all"]).default("any"),
    valueLimit: z.number().optional(),
    escalationDays: z.number().int().default(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [step] = await withTenantDb(tenantId, (db) =>
    db.insert(approvalStepsTable).values({
      ...parsed.data,
      workflowId,
      tenantId,
      valueLimit: parsed.data.valueLimit != null ? String(parsed.data.valueLimit) : undefined,
    } as typeof approvalStepsTable.$inferInsert).returning(),
  );
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "approval_step.created", entityType: "approval_workflow", entityId: String(workflowId), newValues: parsed.data });
  res.status(201).json(step);
});

router.delete("/procurement/approval-workflows/:wfId/steps/:stepId", ...tenantAdminMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const stepId = Number(req.params.stepId);
  await withTenantDb(tenantId, (db) =>
    db.delete(approvalStepsTable).where(and(eq(approvalStepsTable.id, stepId), eq(approvalStepsTable.tenantId, tenantId))),
  );
  res.status(204).send();
});

// ── Purchase Requisitions ─────────────────────────────────────────────────────

const reqLineSchema = z.object({
  lineNumber: z.number().int(),
  itemId: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().optional(),
  estimatedUnitPrice: z.number().optional(),
  glAccountId: z.number().int().optional(),
  notes: z.string().optional(),
});

router.get("/procurement/requisitions", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, q, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) => {
    let query = db.select().from(purchaseRequisitionsTable)
      .where(and(
        eq(purchaseRequisitionsTable.tenantId, tenantId),
        isNull(purchaseRequisitionsTable.deletedAt),
        status ? eq(purchaseRequisitionsTable.status, status) : undefined,
        q ? or(
          ilike(purchaseRequisitionsTable.code, `%${q}%`),
          ilike(purchaseRequisitionsTable.title, `%${q}%`),
        ) : undefined,
      ))
      .orderBy(desc(purchaseRequisitionsTable.createdAt))
      .limit(lim + 1)
      .offset(offset);
    return query;
  });

  const hasMore = rows.length > lim;
  res.json({ requisitions: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/procurement/requisitions/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [req_, lines, decisions] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(purchaseRequisitionsTable)
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(requisitionLinesTable)
      .where(and(eq(requisitionLinesTable.requisitionId, id), eq(requisitionLinesTable.tenantId, tenantId)))
      .orderBy(asc(requisitionLinesTable.lineNumber))),
    withTenantDb(tenantId, (db) => db.select().from(approvalDecisionsTable)
      .where(and(eq(approvalDecisionsTable.entityType, "purchase_requisition"), eq(approvalDecisionsTable.entityId, id), eq(approvalDecisionsTable.tenantId, tenantId)))
      .orderBy(asc(approvalDecisionsTable.createdAt))),
  ]);
  if (!req_[0]) { res.status(404).json({ error: "Requisition not found" }); return; }
  res.json({ ...req_[0], lines, approvalDecisions: decisions });
});

router.post("/procurement/requisitions", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    preferredSupplierId: z.number().int().optional(),
    deliverToWarehouseId: z.number().int().optional(),
    currencyCode: z.string().default("AUD"),
    priority: z.enum(["low", "normal", "urgent"]).default("normal"),
    requiredByDate: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(reqLineSchema).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const { lines, ...header } = parsed.data;
  const [requisition] = await withTenantDb(tenantId, (db) =>
    db.insert(purchaseRequisitionsTable).values({
      ...header,
      tenantId,
      code: `REQ-TEMP`,
      requestedByClerkId: clerkUserId,
      requestedByEmail: userEmail,
      status: "draft",
    } as typeof purchaseRequisitionsTable.$inferInsert).returning(),
  );

  const reqId = requisition!.id;
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable).set({ code: genCode("REQ", reqId) })
      .where(eq(purchaseRequisitionsTable.id, reqId)),
  );

  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(requisitionLinesTable).values(
        lines.map((l) => ({
          ...l,
          requisitionId: reqId,
          tenantId,
          quantity: String(l.quantity),
          estimatedUnitPrice: l.estimatedUnitPrice != null ? String(l.estimatedUnitPrice) : undefined,
          estimatedTotal: l.estimatedUnitPrice != null ? String(l.quantity * l.estimatedUnitPrice) : undefined,
        }) as typeof requisitionLinesTable.$inferInsert),
      ),
    );
    await updateReqTotals(tenantId, reqId);
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.created", entityType: "purchase_requisition", entityId: String(reqId), newValues: header });

  const full = await withTenantDb(tenantId, (db) => db.select().from(purchaseRequisitionsTable)
    .where(eq(purchaseRequisitionsTable.id, reqId)).limit(1));
  res.status(201).json(full[0]);
});

router.patch("/procurement/requisitions/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  // Status transitions are only permitted via dedicated action endpoints
  // (submit, decision, convert-to-po). Direct status mutation is rejected.
  const schema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    preferredSupplierId: z.number().int().optional().nullable(),
    deliverToWarehouseId: z.number().int().optional().nullable(),
    currencyCode: z.string().optional(),
    priority: z.enum(["low", "normal", "urgent"]).optional(),
    requiredByDate: z.string().optional().nullable(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  // Only allow edits on draft/returned requisitions (cannot edit once in-flight)
  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: purchaseRequisitionsTable.status }).from(purchaseRequisitionsTable)
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt)))
      .limit(1));
  if (!existing) { res.status(404).json({ error: "Requisition not found" }); return; }
  if (!["draft", "returned"].includes(existing.status)) {
    res.status(400).json({ error: `Requisition cannot be edited in status: ${existing.status}` });
    return;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable).set(parsed.data as Record<string, unknown>)
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt)))
      .returning(),
  );
  if (!updated) { res.status(404).json({ error: "Requisition not found" }); return; }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.updated", entityType: "purchase_requisition", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/procurement/requisitions/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable).set({ deletedAt: new Date() })
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))),
  );
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.deleted", entityType: "purchase_requisition", entityId: String(id) });
  res.status(204).send();
});

// Requisition lines CRUD
router.put("/procurement/requisitions/:id/lines", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [req_] = await withTenantDb(tenantId, (db) =>
    db.select({ status: purchaseRequisitionsTable.status }).from(purchaseRequisitionsTable)
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))).limit(1));
  if (!req_) { res.status(404).json({ error: "Requisition not found" }); return; }
  if (!["draft", "returned"].includes(req_.status)) { res.status(400).json({ error: `Cannot modify lines on a requisition with status: ${req_.status}` }); return; }
  const schema = z.array(reqLineSchema);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  await withTenantDb(tenantId, async (db) => {
    await db.delete(requisitionLinesTable).where(and(eq(requisitionLinesTable.requisitionId, id), eq(requisitionLinesTable.tenantId, tenantId)));
    if (parsed.data.length > 0) {
      await db.insert(requisitionLinesTable).values(parsed.data.map((l) => ({
        ...l,
        requisitionId: id,
        tenantId,
        quantity: String(l.quantity),
        estimatedUnitPrice: l.estimatedUnitPrice != null ? String(l.estimatedUnitPrice) : undefined,
        estimatedTotal: l.estimatedUnitPrice != null ? String(l.quantity * l.estimatedUnitPrice) : undefined,
      }) as typeof requisitionLinesTable.$inferInsert));
    }
  });
  await updateReqTotals(tenantId, id);
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition_lines.updated", entityType: "purchase_requisition", entityId: String(id), newValues: { count: parsed.data.length } });
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(requisitionLinesTable).where(and(eq(requisitionLinesTable.requisitionId, id), eq(requisitionLinesTable.tenantId, tenantId))).orderBy(asc(requisitionLinesTable.lineNumber)));
  res.json(lines);
});

// Submit for approval
router.post("/procurement/requisitions/:id/submit", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [req_] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseRequisitionsTable).where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))).limit(1));
  if (!req_) { res.status(404).json({ error: "Requisition not found" }); return; }
  if (!["draft", "returned"].includes(req_.status)) { res.status(400).json({ error: `Cannot submit a requisition with status: ${req_.status}` }); return; }

  // Gather line item categories for workflow rule matching
  const reqLines = await withTenantDb(tenantId, (db) =>
    db.select({ itemId: requisitionLinesTable.itemId }).from(requisitionLinesTable)
      .where(and(eq(requisitionLinesTable.requisitionId, id), eq(requisitionLinesTable.tenantId, tenantId))));
  const lineItemIds = reqLines.map((l) => l.itemId).filter(Boolean) as number[];
  const lineItems = lineItemIds.length > 0
    ? await withTenantDb(tenantId, (db) =>
        db.select({ category: itemsTable.category }).from(itemsTable)
          .where(and(inArray(itemsTable.id, lineItemIds), eq(itemsTable.tenantId, tenantId))))
    : [];
  const lineCategories = lineItems.map((i) => i.category).filter(Boolean) as string[];

  // Select workflow based on trigger rules (value, supplier, warehouse, category)
  const workflow = await selectWorkflow(tenantId, "purchase_requisition", {
    totalValue: req_.totalEstimated,
    supplierId: req_.preferredSupplierId,
    warehouseId: req_.deliverToWarehouseId,
    lineCategories,
  });

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({
        status: workflow ? "pending_approval" : "approved",
        approvalWorkflowId: workflow?.id ?? undefined,
        currentApprovalStep: workflow ? 1 : 0,
      })
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId)))
      .returning(),
  );
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.submitted", entityType: "purchase_requisition", entityId: String(id) });

  // Notify: if a workflow was assigned, tell step-1 approvers; otherwise confirm auto-approval to submitter
  if (workflow) {
    const step1 = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, workflow.id), eq(approvalStepsTable.stepNumber, 1), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (step1[0]) {
      const approverIds: string[] = (step1[0].approverUserIds ?? []) as string[];
      await Promise.all(approverIds.map((uid) =>
        createNotification(tenantId, uid, "approval_required",
          "Requisition requires your approval",
          `Purchase Requisition ${genCode("REQ", id)} has been submitted and is awaiting your approval.`,
          { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) }),
      ));
    }
  } else {
    await createNotification(tenantId, clerkUserId, "decision_made",
      "Requisition auto-approved",
      `Purchase Requisition ${genCode("REQ", id)} was auto-approved (no approval workflow required).`,
      { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) });
  }

  res.json(updated);
});

// Approve/reject/return — restricted to approver, tenant_admin, super_admin
router.post("/procurement/requisitions/:id/decision", ...approverMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail, userRole } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    decision: z.enum(["approved", "rejected", "returned"]),
    comment: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const [req_] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseRequisitionsTable).where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))).limit(1));
  if (!req_) { res.status(404).json({ error: "Requisition not found" }); return; }
  if (req_.status !== "pending_approval") {
    res.status(400).json({ error: `Requisition is not awaiting approval (current status: ${req_.status})` });
    return;
  }

  let result: { newStatus: string; newStepNum: number };
  try {
    result = await executeApprovalDecision({
      tenantId,
      entityType: "purchase_requisition",
      entityId: id,
      workflowId: req_.approvalWorkflowId,
      currentStepNum: req_.currentApprovalStep ?? 1,
      entityTotal: req_.totalEstimated,
      actorClerkId: clerkUserId,
      actorEmail: userEmail,
      actorRole: userRole,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
    });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message: string };
    res.status(e.statusCode ?? 500).json({ error: e.message });
    return;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({ status: result.newStatus, currentApprovalStep: result.newStepNum || undefined })
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId)))
      .returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: `requisition.${parsed.data.decision}`, entityType: "purchase_requisition", entityId: String(id), newValues: { decision: parsed.data.decision, comment: parsed.data.comment, newStatus: result.newStatus } });

  // Notify requester of the decision outcome
  if (req_.requestedByClerkId) {
    const decisionLabel = parsed.data.decision === "approved" ? "approved" : parsed.data.decision === "rejected" ? "rejected" : "returned for revision";
    await createNotification(tenantId, req_.requestedByClerkId, "decision_made",
      `Requisition ${decisionLabel}`,
      `Purchase Requisition ${genCode("REQ", id)} has been ${decisionLabel}.${parsed.data.comment ? ` Comment: ${parsed.data.comment}` : ""}`,
      { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) });
  }

  // If advancing to next step (still pending_approval), notify next step approvers
  if (result.newStatus === "pending_approval" && result.newStepNum > 0 && req_.approvalWorkflowId) {
    const nextStep = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, req_.approvalWorkflowId!), eq(approvalStepsTable.stepNumber, result.newStepNum), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (nextStep[0]) {
      const approverIds: string[] = (nextStep[0].approverUserIds ?? []) as string[];
      await Promise.all(approverIds.map((uid) =>
        createNotification(tenantId, uid, "approval_required",
          "Requisition requires your approval",
          `Purchase Requisition ${genCode("REQ", id)} has advanced to step ${result.newStepNum} and is awaiting your approval.`,
          { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) }),
      ));
    }
  }

  // Auto-convert to a draft PO when the requisition reaches final "approved" state
  let autoPo: { id: number } | undefined;
  if (result.newStatus === "approved") {
    const poId = await createPoFromRequisition(tenantId, id, clerkUserId, userEmail);
    if (poId) {
      await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.auto_converted_to_po", entityType: "purchase_requisition", entityId: String(id), newValues: { poId } });
      // Notify requester that a PO was auto-created
      if (req_.requestedByClerkId) {
        await createNotification(tenantId, req_.requestedByClerkId, "po_auto_created",
          "Purchase Order auto-created",
          `Purchase Order was automatically created from approved Requisition ${genCode("REQ", id)}.`,
          { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) });
      }
      autoPo = { id: poId };
    }
  }

  res.json({ ...updated, autoPo });
});

/** Shared helper: create a draft PO from an approved requisition.
 *  Returns the new PO id, or null if the requisition is not approved or already converted. */
async function createPoFromRequisition(
  tenantId: number,
  requisitionId: number,
  createdByClerkId: string,
  createdByEmail: string,
): Promise<number | null> {
  const [req_] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseRequisitionsTable)
      .where(and(eq(purchaseRequisitionsTable.id, requisitionId), eq(purchaseRequisitionsTable.tenantId, tenantId)))
      .limit(1));
  if (!req_ || !["approved"].includes(req_.status)) return null;

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(requisitionLinesTable)
      .where(and(eq(requisitionLinesTable.requisitionId, requisitionId), eq(requisitionLinesTable.tenantId, tenantId))));

  const [po] = await withTenantDb(tenantId, (db) =>
    db.insert(purchaseOrdersTable).values({
      tenantId,
      code: `PO-TEMP`,
      supplierId: req_.preferredSupplierId ?? undefined,
      deliverToWarehouseId: req_.deliverToWarehouseId ?? undefined,
      currencyCode: req_.currencyCode,
      requisitionId,
      status: "draft",
      createdByClerkId,
      createdByEmail,
    } as typeof purchaseOrdersTable.$inferInsert).returning());
  const poId = po!.id;
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable).set({ code: genCode("PO", poId) }).where(eq(purchaseOrdersTable.id, poId)));

  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(poLinesTable).values(lines.map((l, i) => ({
        tenantId,
        poId,
        lineNumber: i + 1,
        lineType: "stock",
        itemId: l.itemId ?? undefined,
        itemCode: l.itemCode ?? undefined,
        itemName: l.itemName ?? undefined,
        description: l.description ?? undefined,
        quantity: l.quantity,
        unitOfMeasure: l.unitOfMeasure ?? undefined,
        unitPrice: l.estimatedUnitPrice ?? "0",
        lineTotal: l.estimatedTotal ?? "0",
        glAccountId: l.glAccountId ?? undefined,
        requisitionLineId: l.id,
        notes: l.notes ?? undefined,
      }) as typeof poLinesTable.$inferInsert)));
  }

  await updatePoTotals(tenantId, poId);
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({ status: "converted", convertedPoId: poId })
      .where(eq(purchaseRequisitionsTable.id, requisitionId)));

  return poId;
}

// Convert requisition to PO (manual trigger — auto-conversion also fires on final approval)
router.post("/procurement/requisitions/:id/convert-to-po", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [req_] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseRequisitionsTable).where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))).limit(1));
  if (!req_) { res.status(404).json({ error: "Requisition not found" }); return; }
  if (req_.status !== "approved") { res.status(400).json({ error: "Requisition must be approved before converting to PO" }); return; }

  const poId = await createPoFromRequisition(tenantId, id, clerkUserId, userEmail);
  if (!poId) { res.status(400).json({ error: "Could not create PO from requisition" }); return; }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.converted_to_po", entityType: "purchase_requisition", entityId: String(id), newValues: { poId } });

  const fullPo = (await withTenantDb(tenantId, (db) => db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, poId)).limit(1)))[0];
  res.status(201).json(fullPo);
});

// ── Purchase Orders ───────────────────────────────────────────────────────────

const poLineSchema = z.object({
  lineNumber: z.number().int(),
  lineType: z.enum(["stock", "service", "charge", "comment"]).default("stock"),
  itemId: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().default(0),
  unitOfMeasure: z.string().optional(),
  unitPrice: z.number().default(0),
  discountPct: z.number().default(0),
  taxPct: z.number().default(0),
  glAccountId: z.number().int().optional(),
  requisitionLineId: z.number().int().optional(),
  notes: z.string().optional(),
});

router.get("/procurement/purchase-orders", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, supplierId, q, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.tenantId, tenantId),
        isNull(purchaseOrdersTable.deletedAt),
        status ? eq(purchaseOrdersTable.status, status) : undefined,
        supplierId ? eq(purchaseOrdersTable.supplierId, Number(supplierId)) : undefined,
        q ? or(ilike(purchaseOrdersTable.code, `%${q}%`), ilike(purchaseOrdersTable.supplierName, `%${q}%`)) : undefined,
      ))
      .orderBy(desc(purchaseOrdersTable.createdAt))
      .limit(lim + 1)
      .offset(offset),
  );
  const hasMore = rows.length > lim;
  res.json({ purchaseOrders: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/procurement/purchase-orders/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [po, lines, receipts, decisions] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(poLinesTable)
      .where(and(eq(poLinesTable.poId, id), eq(poLinesTable.tenantId, tenantId)))
      .orderBy(asc(poLinesTable.lineNumber))),
    withTenantDb(tenantId, (db) => db.select().from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.poId, id), eq(poReceiptsTable.tenantId, tenantId)))
      .orderBy(desc(poReceiptsTable.createdAt))),
    withTenantDb(tenantId, (db) => db.select().from(approvalDecisionsTable)
      .where(and(eq(approvalDecisionsTable.entityType, "purchase_order"), eq(approvalDecisionsTable.entityId, id), eq(approvalDecisionsTable.tenantId, tenantId)))
      .orderBy(asc(approvalDecisionsTable.createdAt))),
  ]);
  if (!po[0]) { res.status(404).json({ error: "Purchase order not found" }); return; }
  res.json({ ...po[0], lines, receipts, approvalDecisions: decisions });
});

router.post("/procurement/purchase-orders", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    supplierId: z.number().int().optional(),
    supplierRef: z.string().optional(),
    deliverToWarehouseId: z.number().int().optional(),
    deliveryDate: z.string().optional(),
    currencyCode: z.string().default("AUD"),
    exchangeRate: z.number().default(1),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    requisitionId: z.number().int().optional(),
    lines: z.array(poLineSchema).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const { lines, ...header } = parsed.data;

  // Denormalize supplier name
  let supplierName: string | undefined;
  if (header.supplierId) {
    const sup = (await withTenantDb(tenantId, (db) => db.select({ name: suppliersTable.name }).from(suppliersTable).where(and(eq(suppliersTable.id, header.supplierId!), eq(suppliersTable.tenantId, tenantId))).limit(1)))[0];
    supplierName = sup?.name ?? undefined;
  }

  const [po] = await withTenantDb(tenantId, (db) =>
    db.insert(purchaseOrdersTable).values({
      ...header,
      supplierName,
      tenantId,
      code: "PO-TEMP",
      status: "draft",
      createdByClerkId: clerkUserId,
      createdByEmail: userEmail,
      exchangeRate: header.exchangeRate != null ? String(header.exchangeRate) : undefined,
    } as typeof purchaseOrdersTable.$inferInsert).returning(),
  );
  const poId = po!.id;
  await withTenantDb(tenantId, (db) => db.update(purchaseOrdersTable).set({ code: genCode("PO", poId) }).where(eq(purchaseOrdersTable.id, poId)));

  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(poLinesTable).values(lines.map((l) => {
        const qty = l.quantity;
        const up = l.unitPrice;
        const disc = (l.discountPct ?? 0) / 100;
        const lineBase = qty * up * (1 - disc);
        const tax = (l.taxPct ?? 0) / 100;
        return {
          ...l,
          poId,
          tenantId,
          quantity: String(qty),
          unitPrice: String(up),
          discountPct: String(l.discountPct ?? 0),
          taxPct: String(l.taxPct ?? 0),
          lineTotal: (lineBase * (1 + tax)).toFixed(2),
          glAccountId: l.glAccountId ?? undefined,
          requisitionLineId: l.requisitionLineId ?? undefined,
        } as typeof poLinesTable.$inferInsert;
      })),
    );
    await updatePoTotals(tenantId, poId);
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.created", entityType: "purchase_order", entityId: String(poId), newValues: header });
  const fullPo = (await withTenantDb(tenantId, (db) => db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, poId)).limit(1)))[0];
  res.status(201).json(fullPo);
});

router.patch("/procurement/purchase-orders/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  // Status transitions are only permitted via dedicated action endpoints (submit, decision, send, receive, cancel).
  const schema = z.object({
    supplierId: z.number().int().optional().nullable(),
    supplierName: z.string().optional(),
    supplierRef: z.string().optional(),
    deliverToWarehouseId: z.number().int().optional().nullable(),
    deliveryDate: z.string().optional().nullable(),
    currencyCode: z.string().optional(),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  // Only allow edits on draft/returned POs
  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: purchaseOrdersTable.status }).from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .limit(1));
  if (!existing) { res.status(404).json({ error: "Purchase order not found" }); return; }
  if (!["draft", "returned"].includes(existing.status)) {
    res.status(400).json({ error: `Purchase order cannot be edited in status: ${existing.status}` });
    return;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable).set(parsed.data as Record<string, unknown>)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt))).returning());
  if (!updated) { res.status(404).json({ error: "Purchase order not found" }); return; }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.updated", entityType: "purchase_order", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/procurement/purchase-orders/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable).set({ deletedAt: new Date() })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.deleted", entityType: "purchase_order", entityId: String(id) });
  res.status(204).send();
});

// PO Lines
router.put("/procurement/purchase-orders/:id/lines", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const poId = Number(req.params.id);
  const [po_] = await withTenantDb(tenantId, (db) =>
    db.select({ status: purchaseOrdersTable.status }).from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1));
  if (!po_) { res.status(404).json({ error: "Purchase order not found" }); return; }
  if (!["draft", "returned"].includes(po_.status)) { res.status(400).json({ error: `Cannot modify lines on a PO with status: ${po_.status}` }); return; }
  const schema = z.array(poLineSchema);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  await withTenantDb(tenantId, async (db) => {
    await db.delete(poLinesTable).where(and(eq(poLinesTable.poId, poId), eq(poLinesTable.tenantId, tenantId)));
    if (parsed.data.length > 0) {
      await db.insert(poLinesTable).values(parsed.data.map((l) => {
        const qty = l.quantity;
        const up = l.unitPrice;
        const disc = (l.discountPct ?? 0) / 100;
        const lineBase = qty * up * (1 - disc);
        const tax = (l.taxPct ?? 0) / 100;
        return {
          ...l,
          poId,
          tenantId,
          quantity: String(qty),
          unitPrice: String(up),
          discountPct: String(l.discountPct ?? 0),
          taxPct: String(l.taxPct ?? 0),
          lineTotal: (lineBase * (1 + tax)).toFixed(2),
        } as typeof poLinesTable.$inferInsert;
      }));
    }
  });
  const totals = await updatePoTotals(tenantId, poId);
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_lines.updated", entityType: "purchase_order", entityId: String(poId), newValues: { count: parsed.data.length, ...totals } });
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poLinesTable).where(and(eq(poLinesTable.poId, poId), eq(poLinesTable.tenantId, tenantId))).orderBy(asc(poLinesTable.lineNumber)));
  res.json(lines);
});

// Submit PO for approval
router.post("/procurement/purchase-orders/:id/submit", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [po] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }
  if (!["draft", "returned"].includes(po.status)) { res.status(400).json({ error: `Cannot submit a PO with status: ${po.status}` }); return; }

  // Gather line item categories for workflow rule matching
  const poLinesForWf = await withTenantDb(tenantId, (db) =>
    db.select({ itemId: poLinesTable.itemId }).from(poLinesTable)
      .where(and(eq(poLinesTable.poId, id), eq(poLinesTable.tenantId, tenantId))));
  const poLineItemIds = poLinesForWf.map((l) => l.itemId).filter(Boolean) as number[];
  const poLineItems = poLineItemIds.length > 0
    ? await withTenantDb(tenantId, (db) =>
        db.select({ category: itemsTable.category }).from(itemsTable)
          .where(and(inArray(itemsTable.id, poLineItemIds), eq(itemsTable.tenantId, tenantId))))
    : [];
  const poLineCategories = poLineItems.map((i) => i.category).filter(Boolean) as string[];

  // Select workflow based on trigger rules (value, supplier, warehouse, category)
  const workflow = await selectWorkflow(tenantId, "purchase_order", {
    totalValue: po.total,
    supplierId: po.supplierId,
    warehouseId: po.deliverToWarehouseId,
    lineCategories: poLineCategories,
  });

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable)
      .set({ status: workflow ? "pending_approval" : "approved", approvalWorkflowId: workflow?.id ?? undefined, currentApprovalStep: workflow ? 1 : 0 })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.submitted", entityType: "purchase_order", entityId: String(id) });

  // Notify step-1 approvers or confirm auto-approval to submitter
  if (workflow) {
    const step1 = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, workflow.id), eq(approvalStepsTable.stepNumber, 1), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (step1[0]) {
      const approverIds: string[] = (step1[0].approverUserIds ?? []) as string[];
      await Promise.all(approverIds.map((uid) =>
        createNotification(tenantId, uid, "approval_required",
          "Purchase Order requires your approval",
          `Purchase Order ${genCode("PO", id)} has been submitted and is awaiting your approval.`,
          { entityType: "purchase_order", entityId: id, entityCode: genCode("PO", id) }),
      ));
    }
  } else {
    await createNotification(tenantId, clerkUserId, "decision_made",
      "Purchase Order auto-approved",
      `Purchase Order ${genCode("PO", id)} was auto-approved (no approval workflow required).`,
      { entityType: "purchase_order", entityId: id, entityCode: genCode("PO", id) });
  }

  res.json(updated);
});

// Approve/reject/return PO — restricted to approver, tenant_admin, super_admin
router.post("/procurement/purchase-orders/:id/decision", ...approverMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail, userRole } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    decision: z.enum(["approved", "rejected", "returned"]),
    comment: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const [po] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }
  if (po.status !== "pending_approval") {
    res.status(400).json({ error: `Purchase order is not awaiting approval (current status: ${po.status})` });
    return;
  }

  let result: { newStatus: string; newStepNum: number };
  try {
    result = await executeApprovalDecision({
      tenantId,
      entityType: "purchase_order",
      entityId: id,
      workflowId: po.approvalWorkflowId,
      currentStepNum: po.currentApprovalStep ?? 1,
      entityTotal: po.total,
      actorClerkId: clerkUserId,
      actorEmail: userEmail,
      actorRole: userRole,
      decision: parsed.data.decision,
      comment: parsed.data.comment,
    });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message: string };
    res.status(e.statusCode ?? 500).json({ error: e.message });
    return;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable)
      .set({ status: result.newStatus, currentApprovalStep: result.newStepNum || undefined })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId)))
      .returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: `purchase_order.${parsed.data.decision}`, entityType: "purchase_order", entityId: String(id), newValues: { decision: parsed.data.decision, comment: parsed.data.comment, newStatus: result.newStatus } });

  // Notify PO creator of the decision outcome
  if (po.createdByClerkId) {
    const decisionLabel = parsed.data.decision === "approved" ? "approved" : parsed.data.decision === "rejected" ? "rejected" : "returned for revision";
    await createNotification(tenantId, po.createdByClerkId, "decision_made",
      `Purchase Order ${decisionLabel}`,
      `Purchase Order ${genCode("PO", id)} has been ${decisionLabel}.${parsed.data.comment ? ` Comment: ${parsed.data.comment}` : ""}`,
      { entityType: "purchase_order", entityId: id, entityCode: genCode("PO", id) });
  }

  // If advancing to next step, notify next step approvers
  if (result.newStatus === "pending_approval" && result.newStepNum > 0 && po.approvalWorkflowId) {
    const nextStep = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, po.approvalWorkflowId!), eq(approvalStepsTable.stepNumber, result.newStepNum), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (nextStep[0]) {
      const approverIds: string[] = (nextStep[0].approverUserIds ?? []) as string[];
      await Promise.all(approverIds.map((uid) =>
        createNotification(tenantId, uid, "approval_required",
          "Purchase Order requires your approval",
          `Purchase Order ${genCode("PO", id)} has advanced to step ${result.newStepNum} and is awaiting your approval.`,
          { entityType: "purchase_order", entityId: id, entityCode: genCode("PO", id) }),
      ));
    }
  }

  res.json(updated);
});

// Mark PO as sent
router.post("/procurement/purchase-orders/:id/send", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  // Enforce state machine: PO must be in "approved" status before it can be sent
  const [po] = await withTenantDb(tenantId, (db) =>
    db.select({ status: purchaseOrdersTable.status }).from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }
  if (po.status !== "approved") {
    res.status(400).json({ error: `PO cannot be sent in status: ${po.status}. Only approved POs can be sent to suppliers.` });
    return;
  }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable).set({ status: "sent", sentAt: new Date() })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "PO not found" }); return; }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.sent", entityType: "purchase_order", entityId: String(id) });
  res.json(updated);
});

// Generate PO PDF document for supplier dispatch
router.post("/procurement/purchase-orders/:id/pdf", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const { dispatchEmail } = req.body as { dispatchEmail?: string };

  const [po] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poLinesTable)
      .where(and(eq(poLinesTable.poId, id), eq(poLinesTable.tenantId, tenantId))));

  // Generate a real PDF using PDFKit
  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 100; // account for margins

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("PURCHASE ORDER", 50, 50);
    doc.fontSize(12).font("Helvetica").text(po.code, 50, 76);
    doc.fontSize(10).text(`Status: ${po.status.toUpperCase()}`, 400, 50, { align: "right" });
    doc.text(`Date: ${new Date(po.createdAt).toLocaleDateString()}`, 400, 65, { align: "right" });

    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);

    // Supplier details
    doc.fontSize(11).font("Helvetica-Bold").text("Supplier:");
    doc.font("Helvetica").text(po.supplierName ?? "—");
    if (po.supplierRef) doc.text(`Ref: ${po.supplierRef}`);
    if (po.deliveryDate) doc.text(`Delivery Date: ${po.deliveryDate}`);
    if (po.paymentTerms) doc.text(`Payment Terms: ${po.paymentTerms}`);
    doc.moveDown(1);

    // Lines table header
    const colX = { num: 50, item: 70, desc: 150, qty: 340, uom: 380, price: 430, total: 500 };
    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("#", colX.num, doc.y, { width: 20 });
    const headerY = doc.y - doc.currentLineHeight();
    doc.text("Item", colX.item, headerY, { width: 80 });
    doc.text("Description", colX.desc, headerY, { width: 185 });
    doc.text("Qty", colX.qty, headerY, { width: 40 });
    doc.text("UoM", colX.uom, headerY, { width: 50 });
    doc.text("Price", colX.price, headerY, { width: 70 });
    doc.text("Total", colX.total, headerY, { width: 60 });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.3);

    // Lines
    doc.font("Helvetica").fontSize(9);
    lines.forEach((l, i) => {
      const rowY = doc.y;
      doc.text(String(i + 1), colX.num, rowY, { width: 20 });
      doc.text(l.itemCode ?? "—", colX.item, rowY, { width: 80 });
      doc.text(l.description ?? l.itemName ?? "", colX.desc, rowY, { width: 185 });
      doc.text(String(l.quantity), colX.qty, rowY, { width: 40 });
      doc.text(l.unitOfMeasure ?? "", colX.uom, rowY, { width: 50 });
      doc.text(`${Number(l.unitPrice).toFixed(2)}`, colX.price, rowY, { width: 70 });
      doc.text(`${Number(l.lineTotal).toFixed(2)}`, colX.total, rowY, { width: 60 });
      doc.moveDown(0.8);
    });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);

    // Total
    doc.font("Helvetica-Bold").fontSize(11);
    doc.text(`Total: ${Number(po.total).toFixed(2)} ${po.currencyCode}`, { align: "right" });

    if (po.notes) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").text("Notes:");
      doc.font("Helvetica").text(po.notes);
    }

    doc.end();
  });

  const pdfBase64 = pdfBuffer.toString("base64");
  const filename = `${po.code}.pdf`;

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.pdf_generated", entityType: "purchase_order", entityId: String(id), newValues: { dispatchEmail: dispatchEmail ?? null } });

  // Note: actual email dispatch requires an email provider integration (e.g., SendGrid, SES).
  // The pdfBase64 payload can be forwarded to an email API by the caller.
  res.json({
    pdfBase64,
    filename,
    dispatched: false, // email dispatch requires email provider integration
    dispatchEmail: dispatchEmail ?? null,
  });
});

// ── Goods Receipt ──────────────────────────────────────────────────────────────

router.get("/procurement/receipts", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { poId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable)
      .where(and(
        eq(poReceiptsTable.tenantId, tenantId),
        poId ? eq(poReceiptsTable.poId, Number(poId)) : undefined,
        status ? eq(poReceiptsTable.status, status) : undefined,
      ))
      .orderBy(desc(poReceiptsTable.createdAt))
      .limit(lim + 1).offset(offset),
  );
  const hasMore = rows.length > lim;
  res.json({ receipts: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/procurement/receipts/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [receipt, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(receiptLinesTable)
      .where(and(eq(receiptLinesTable.receiptId, id), eq(receiptLinesTable.tenantId, tenantId)))),
  ]);
  if (!receipt[0]) { res.status(404).json({ error: "Receipt not found" }); return; }
  res.json({ ...receipt[0], lines });
});

const receiptLineSchema = z.object({
  poLineId: z.number().int(),
  itemId: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  orderedQty: z.number(),
  receivedQty: z.number(),
  unitCost: z.number().optional(),
  locationId: z.number().int().optional(),
  lotNumber: z.string().optional(),
  batchNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  expiryDate: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/procurement/receipts", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    poId: z.number().int(),
    warehouseId: z.number().int().optional(),
    locationId: z.number().int().optional(),
    supplierDeliveryRef: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(receiptLineSchema).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const { lines, ...header } = parsed.data;

  // Ensure the PO is in a receivable state before creating any records
  const [receivingPo] = await withTenantDb(tenantId, (db) =>
    db.select({ id: purchaseOrdersTable.id, status: purchaseOrdersTable.status })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, parsed.data.poId), eq(purchaseOrdersTable.tenantId, tenantId)))
      .limit(1));
  if (!receivingPo) { res.status(404).json({ error: "Purchase order not found" }); return; }
  if (!["approved", "sent", "partially_received"].includes(receivingPo.status)) {
    res.status(400).json({ error: `Cannot receive goods against a PO with status: ${receivingPo.status}` });
    return;
  }

  // Validate all poLineIds BEFORE creating any records (transactional integrity)
  if (lines.length > 0) {
    const poLineIds = lines.map((l) => l.poLineId).filter(Boolean) as number[];
    if (poLineIds.length > 0) {
      const validPoLines = await withTenantDb(tenantId, (db) =>
        db.select({ id: poLinesTable.id }).from(poLinesTable)
          .where(and(inArray(poLinesTable.id, poLineIds), eq(poLinesTable.poId, parsed.data.poId), eq(poLinesTable.tenantId, tenantId))));
      const validIds = new Set(validPoLines.map((pl) => pl.id));
      const invalidLine = poLineIds.find((lid) => !validIds.has(lid));
      if (invalidLine) {
        res.status(400).json({ error: `Line poLineId ${invalidLine} does not belong to PO ${parsed.data.poId}` });
        return;
      }
    }
  }

  // All validations passed — now persist header + lines atomically
  const [receipt] = await withTenantDb(tenantId, (db) =>
    db.insert(poReceiptsTable).values({
      ...header,
      tenantId,
      code: `RCV-TEMP`,
      status: "draft",
      receivedByClerkId: clerkUserId,
      receivedByEmail: userEmail,
    } as typeof poReceiptsTable.$inferInsert).returning(),
  );
  const receiptId = receipt!.id;
  await withTenantDb(tenantId, (db) => db.update(poReceiptsTable).set({ code: genCode("RCV", receiptId) }).where(eq(poReceiptsTable.id, receiptId)));

  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(receiptLinesTable).values(lines.map((l) => ({
        ...l,
        receiptId,
        tenantId,
        orderedQty: String(l.orderedQty),
        receivedQty: String(l.receivedQty),
        unitCost: l.unitCost != null ? String(l.unitCost) : undefined,
      }) as typeof receiptLinesTable.$inferInsert)),
    );
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.created", entityType: "po_receipt", entityId: String(receiptId), newValues: header });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(poReceiptsTable).where(eq(poReceiptsTable.id, receiptId)).limit(1)))[0];
  res.status(201).json(full);
});

// GL preview: return what would be posted for a receipt WITHOUT committing
router.get("/procurement/receipts/:id/gl-preview", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [receipt] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1));
  if (!receipt) { res.status(404).json({ error: "Receipt not found" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(receiptLinesTable)
      .where(and(eq(receiptLinesTable.receiptId, id), eq(receiptLinesTable.tenantId, tenantId))));

  const poLineIds = lines.map((l) => l.poLineId).filter(Boolean) as number[];
  const poLineRows = poLineIds.length > 0
    ? await withTenantDb(tenantId, (db) =>
        db.select({ id: poLinesTable.id, glAccountId: poLinesTable.glAccountId })
          .from(poLinesTable).where(inArray(poLinesTable.id, poLineIds)))
    : [];
  const poLineGlMap = new Map(poLineRows.map((pl) => [pl.id, pl.glAccountId]));
  const apAccount = await resolveGlAccount(tenantId, null, "2100", "Accounts Payable");

  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];
  let totalValue = 0;
  for (const rl of lines) {
    const lineVal = Number(rl.receivedQty) * Number(rl.unitCost ?? 0);
    totalValue += lineVal;
    const invAccount = await resolveGlAccount(tenantId, poLineGlMap.get(rl.poLineId) ?? null, "1300", "Inventory");
    glLines.push({ ...invAccount, debit: lineVal, credit: 0, description: `Receipt of ${rl.itemCode ?? rl.itemName ?? "item"}` });
  }
  glLines.push({ ...apAccount, debit: 0, credit: totalValue, description: `AP for PO receipt ${id}` });
  res.json({ lines: glLines, totalDebit: totalValue.toFixed(2), totalCredit: totalValue.toFixed(2) });
});

router.patch("/procurement/receipts/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    warehouseId: z.number().int().optional().nullable(),
    locationId: z.number().int().optional().nullable(),
    supplierDeliveryRef: z.string().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: poReceiptsTable.status }).from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (existing.status !== "draft") { res.status(400).json({ error: "Only draft receipts can be edited" }); return; }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(poReceiptsTable).set(parsed.data as Record<string, unknown>)
      .where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.updated", entityType: "po_receipt", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/procurement/receipts/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: poReceiptsTable.status }).from(poReceiptsTable)
      .where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (existing.status !== "draft") { res.status(400).json({ error: "Only draft receipts can be deleted" }); return; }
  await withTenantDb(tenantId, (db) =>
    db.delete(poReceiptsTable).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.deleted", entityType: "po_receipt", entityId: String(id) });
  res.status(204).send();
});

router.post("/procurement/receipts/:id/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [receipt] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1));
  if (!receipt) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (receipt.status !== "draft") { res.status(400).json({ error: "Receipt is already confirmed" }); return; }

  // Post inventory movements
  await postInventoryReceipt(tenantId, id, clerkUserId);

  // Create GL posting
  const posting = await createGlPosting(tenantId, id, clerkUserId, userEmail);

  // Update receipt status
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(poReceiptsTable).set({
      status: "confirmed",
      receivedAt: new Date(),
      glPostingId: posting?.id ?? undefined,
    }).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).returning());

  // Update PO status and create backorder receipt for partially-received lines
  const po = (await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.id, receipt.poId), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1)))[0];
  if (po) {
    const poLines = await withTenantDb(tenantId, (db) =>
      db.select().from(poLinesTable).where(and(eq(poLinesTable.poId, po.id), eq(poLinesTable.tenantId, tenantId))));
    const allReceived = poLines.every((l) => Number(l.receivedQty) >= Number(l.quantity));
    const anyReceived = poLines.some((l) => Number(l.receivedQty) > 0);
    const newPoStatus = allReceived ? "received" : anyReceived ? "partially_received" : "approved";
    await withTenantDb(tenantId, (db) =>
      db.update(purchaseOrdersTable).set({ status: newPoStatus }).where(eq(purchaseOrdersTable.id, po.id)));

    // Create a backorder draft receipt for lines with remaining quantity
    if (!allReceived && anyReceived) {
      const backorderLines = poLines.filter((l) => Number(l.receivedQty) < Number(l.quantity));
      if (backorderLines.length > 0) {
        const [backorderReceipt] = await withTenantDb(tenantId, (db) =>
          db.insert(poReceiptsTable).values({
            tenantId,
            poId: po.id,
            warehouseId: receipt.warehouseId ?? undefined,
            locationId: receipt.locationId ?? undefined,
            status: "draft",
            receivedByClerkId: clerkUserId,
            receivedByEmail: userEmail,
            notes: `Backorder from receipt #${id}`,
          } as typeof poReceiptsTable.$inferInsert).returning());
        if (backorderReceipt) {
          await withTenantDb(tenantId, (db) =>
            db.insert(receiptLinesTable).values(backorderLines.map((l) => ({
              tenantId,
              receiptId: backorderReceipt.id,
              poLineId: l.id,
              itemId: l.itemId ?? undefined,
              itemCode: l.itemCode ?? undefined,
              itemName: l.itemName ?? undefined,
              orderedQty: (Number(l.quantity) - Number(l.receivedQty)).toFixed(4),
              receivedQty: "0",
              unitCost: l.unitPrice,
            }) as typeof receiptLinesTable.$inferInsert)));
          await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.backorder_created", entityType: "po_receipt", entityId: String(backorderReceipt.id), newValues: { parentReceiptId: id, backorderLines: backorderLines.length } });
        }
      }
    }
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.confirmed", entityType: "po_receipt", entityId: String(id) });
  res.json(updated);
});

// ── Returns to Vendor ─────────────────────────────────────────────────────────

router.get("/procurement/returns", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { poId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnsTable)
      .where(and(
        eq(poReturnsTable.tenantId, tenantId),
        poId ? eq(poReturnsTable.poId, Number(poId)) : undefined,
        status ? eq(poReturnsTable.status, status) : undefined,
      ))
      .orderBy(desc(poReturnsTable.createdAt)).limit(lim + 1).offset(offset),
  );
  const hasMore = rows.length > lim;
  res.json({ returns: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/procurement/returns/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [ret, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(poReturnsTable).where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(poReturnLinesTable).where(and(eq(poReturnLinesTable.returnId, id), eq(poReturnLinesTable.tenantId, tenantId)))),
  ]);
  if (!ret[0]) { res.status(404).json({ error: "Return not found" }); return; }
  res.json({ ...ret[0], lines });
});

router.post("/procurement/returns", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    poId: z.number().int(),
    receiptId: z.number().int().optional(),
    supplierId: z.number().int().optional(),
    warehouseId: z.number().int().optional(),
    returnType: z.enum(["credit", "replace"]).default("credit"),
    reason: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(z.object({
      poLineId: z.number().int().optional(),
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      quantity: z.number().positive(),
      unitCost: z.number().optional(),
      lotNumber: z.string().optional(),
      serialNumber: z.string().optional(),
      batchNumber: z.string().optional(),
      reason: z.string().optional(),
      notes: z.string().optional(),
    })).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const { lines, ...header } = parsed.data;
  const total = lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0);

  const [ret] = await withTenantDb(tenantId, (db) =>
    db.insert(poReturnsTable).values({
      ...header,
      tenantId,
      code: `RTV-TEMP`,
      status: "draft",
      total: total.toFixed(2),
      createdByClerkId: clerkUserId,
      createdByEmail: userEmail,
    } as typeof poReturnsTable.$inferInsert).returning(),
  );
  const retId = ret!.id;
  await withTenantDb(tenantId, (db) => db.update(poReturnsTable).set({ code: genCode("RTV", retId) }).where(eq(poReturnsTable.id, retId)));
  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(poReturnLinesTable).values(lines.map((l) => ({
        ...l,
        returnId: retId,
        tenantId,
        quantity: String(l.quantity),
        unitCost: l.unitCost != null ? String(l.unitCost) : undefined,
      }) as typeof poReturnLinesTable.$inferInsert)),
    );
  }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_return.created", entityType: "po_return", entityId: String(retId), newValues: header });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(poReturnsTable).where(eq(poReturnsTable.id, retId)).limit(1)))[0];
  res.status(201).json(full);
});

router.patch("/procurement/returns/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    warehouseId: z.number().int().optional().nullable(),
    reason: z.string().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: poReturnsTable.status }).from(poReturnsTable)
      .where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Return not found" }); return; }
  if (existing.status !== "draft") { res.status(400).json({ error: "Only draft returns can be edited" }); return; }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(poReturnsTable).set(parsed.data as Record<string, unknown>)
      .where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_return.updated", entityType: "po_return", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/procurement/returns/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ status: poReturnsTable.status }).from(poReturnsTable)
      .where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Return not found" }); return; }
  if (existing.status !== "draft") { res.status(400).json({ error: "Only draft returns can be deleted" }); return; }
  await withTenantDb(tenantId, (db) =>
    db.delete(poReturnsTable).where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_return.deleted", entityType: "po_return", entityId: String(id) });
  res.status(204).send();
});

router.post("/procurement/returns/:id/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [ret] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnsTable).where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).limit(1));
  if (!ret) { res.status(404).json({ error: "Return not found" }); return; }
  if (ret.status !== "draft") { res.status(400).json({ error: "Return is already confirmed" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnLinesTable).where(and(eq(poReturnLinesTable.returnId, id), eq(poReturnLinesTable.tenantId, tenantId))));

  // A valid warehouse is required for inventory reversal
  if (!ret.warehouseId) {
    res.status(400).json({ error: "Return has no warehouse assigned; cannot reverse inventory" });
    return;
  }

  // Reverse inventory
  for (const line of lines) {
    if (!line.itemId || Number(line.quantity) <= 0) continue;
    const qty = Number(line.quantity);
    const warehouseId = ret.warehouseId;
    await withTenantDb(tenantId, (db) =>
      db.insert(inventoryMovementsTable).values({
        tenantId,
        itemId: line.itemId!,
        warehouseId,
        movementType: "return",
        quantity: (-qty).toFixed(4),
        unitCost: line.unitCost ?? undefined,
        refType: "po_return",
        refId: id,
        lotNumber: line.lotNumber ?? undefined,
        serialNumber: line.serialNumber ?? undefined,
        batchNumber: line.batchNumber ?? undefined,
        postedByClerkId: clerkUserId,
      } as typeof inventoryMovementsTable.$inferInsert),
    );

    const [stock] = await withTenantDb(tenantId, (db) =>
      db.select().from(inventoryStockTable)
        .where(and(eq(inventoryStockTable.itemId, line.itemId!), eq(inventoryStockTable.warehouseId, warehouseId), eq(inventoryStockTable.tenantId, tenantId)))
        .limit(1));
    if (stock) {
      await withTenantDb(tenantId, (db) =>
        db.update(inventoryStockTable)
          .set({ qtyOnHand: (Math.max(0, Number(stock.qtyOnHand) - qty)).toFixed(4), lastMovementAt: new Date() })
          .where(and(eq(inventoryStockTable.id, stock.id), eq(inventoryStockTable.tenantId, tenantId))));
    }
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(poReturnsTable).set({ status: "confirmed" }).where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).returning());

  // Post credit-note GL entry (Dr AP / Cr Inventory derived from chart of accounts)
  await createReturnGlPosting(tenantId, id, clerkUserId, userEmail);

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_return.confirmed", entityType: "po_return", entityId: String(id) });
  res.json(updated);
});

// ── GL Postings ───────────────────────────────────────────────────────────────

router.get("/procurement/gl-postings", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { entityType, entityId, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(glPostingsTable)
      .where(and(
        eq(glPostingsTable.tenantId, tenantId),
        entityType ? eq(glPostingsTable.entityType, entityType) : undefined,
        entityId ? eq(glPostingsTable.entityId, Number(entityId)) : undefined,
      ))
      .orderBy(desc(glPostingsTable.createdAt)).limit(lim + 1).offset(offset),
  );
  const hasMore = rows.length > lim;
  res.json({ postings: rows.slice(0, lim), hasMore, page: pg });
});

// ── Inventory Stock ───────────────────────────────────────────────────────────

router.get("/procurement/inventory-stock", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, warehouseId, q, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryStockTable.id,
      itemId: inventoryStockTable.itemId,
      warehouseId: inventoryStockTable.warehouseId,
      locationId: inventoryStockTable.locationId,
      lotNumber: inventoryStockTable.lotNumber,
      batchNumber: inventoryStockTable.batchNumber,
      serialNumber: inventoryStockTable.serialNumber,
      expiryDate: inventoryStockTable.expiryDate,
      qtyOnHand: inventoryStockTable.qtyOnHand,
      qtyReserved: inventoryStockTable.qtyReserved,
      averageCost: inventoryStockTable.averageCost,
      lastMovementAt: inventoryStockTable.lastMovementAt,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      warehouseName: warehousesTable.name,
    })
      .from(inventoryStockTable)
      .leftJoin(itemsTable, eq(inventoryStockTable.itemId, itemsTable.id))
      .leftJoin(warehousesTable, eq(inventoryStockTable.warehouseId, warehousesTable.id))
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        itemId ? eq(inventoryStockTable.itemId, Number(itemId)) : undefined,
        warehouseId ? eq(inventoryStockTable.warehouseId, Number(warehouseId)) : undefined,
      ))
      .orderBy(desc(inventoryStockTable.lastMovementAt))
      .limit(lim + 1).offset(offset),
  );
  const hasMore = rows.length > lim;
  res.json({ stock: rows.slice(0, lim), hasMore, page: pg });
});

// ── Reports ───────────────────────────────────────────────────────────────────

// Open POs
router.get("/procurement/reports/open-pos", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.tenantId, tenantId),
        isNull(purchaseOrdersTable.deletedAt),
        or(
          eq(purchaseOrdersTable.status, "approved"),
          eq(purchaseOrdersTable.status, "sent"),
          eq(purchaseOrdersTable.status, "receiving"),
          eq(purchaseOrdersTable.status, "partially_received"),
        ),
      ))
      .orderBy(asc(purchaseOrdersTable.deliveryDate)),
  );
  res.json(rows);
});

// Approval dashboard — pending items for the current user
router.get("/procurement/reports/pending-approvals", ...approverMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userRole } = req as TenantRequest;

  // Fetch all pending entities for this tenant
  const [allReqs, allPos] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select().from(purchaseRequisitionsTable)
        .where(and(eq(purchaseRequisitionsTable.tenantId, tenantId), eq(purchaseRequisitionsTable.status, "pending_approval"), isNull(purchaseRequisitionsTable.deletedAt)))),
    withTenantDb(tenantId, (db) =>
      db.select().from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.tenantId, tenantId), eq(purchaseOrdersTable.status, "pending_approval"), isNull(purchaseOrdersTable.deletedAt)))),
  ]);

  // Admins and super_admin see all pending items; approvers see only items on steps they can act on
  if (userRole === "tenant_admin" || userRole === "super_admin") {
    return void res.json({
      pendingRequisitions: allReqs,
      pendingPurchaseOrders: allPos,
      totalPending: allReqs.length + allPos.length,
    });
  }

  // Collect workflow IDs for filtering by step eligibility
  const workflowIds = [
    ...new Set([
      ...allReqs.map((r) => r.approvalWorkflowId).filter(Boolean),
      ...allPos.map((p) => p.approvalWorkflowId).filter(Boolean),
    ]),
  ] as number[];

  let eligibleSteps: Array<{ workflowId: number; stepNumber: number }> = [];
  if (workflowIds.length > 0) {
    const steps = await withTenantDb(tenantId, (db) =>
      db.select({
        workflowId: approvalStepsTable.workflowId,
        stepNumber: approvalStepsTable.stepNumber,
        approverRoles: approvalStepsTable.approverRoles,
        approverUserIds: approvalStepsTable.approverUserIds,
      })
        .from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.tenantId, tenantId), inArray(approvalStepsTable.workflowId, workflowIds))));

    eligibleSteps = steps.filter((s) => {
      const roles = (s.approverRoles as string[]) ?? [];
      const userIds = (s.approverUserIds as string[]) ?? [];
      return (roles.length === 0 || roles.includes(userRole)) &&
             (userIds.length === 0 || userIds.includes(clerkUserId));
    });
  }

  const isEligible = (workflowId: number | null | undefined, stepNum: number | null | undefined) => {
    if (!workflowId) return true; // No workflow = open to any approver
    return eligibleSteps.some((s) => s.workflowId === workflowId && s.stepNumber === (stepNum ?? 1));
  };

  const pendingRequisitions = allReqs.filter((r) => isEligible(r.approvalWorkflowId, r.currentApprovalStep));
  const pendingPurchaseOrders = allPos.filter((p) => isEligible(p.approvalWorkflowId, p.currentApprovalStep));

  res.json({
    pendingRequisitions,
    pendingPurchaseOrders,
    totalPending: pendingRequisitions.length + pendingPurchaseOrders.length,
  });
});

// Supplier performance
router.get("/procurement/reports/supplier-performance", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      supplierId: purchaseOrdersTable.supplierId,
      supplierName: purchaseOrdersTable.supplierName,
      totalOrders: sql<number>`count(*)::int`,
      totalValue: sql<number>`sum(${purchaseOrdersTable.total})`,
      avgOrderValue: sql<number>`avg(${purchaseOrdersTable.total})`,
    })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .groupBy(purchaseOrdersTable.supplierId, purchaseOrdersTable.supplierName)
      .orderBy(desc(sql`sum(${purchaseOrdersTable.total})`)),
  );
  res.json(rows);
});

// PO summary report
router.get("/procurement/reports/po-summary", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { from, to } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      status: purchaseOrdersTable.status,
      count: sql<number>`count(*)::int`,
      total: sql<number>`sum(${purchaseOrdersTable.total})`,
    })
      .from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.tenantId, tenantId),
        isNull(purchaseOrdersTable.deletedAt),
        from ? sql`${purchaseOrdersTable.createdAt} >= ${from}::timestamptz` : undefined,
        to ? sql`${purchaseOrdersTable.createdAt} <= ${to}::timestamptz` : undefined,
      ))
      .groupBy(purchaseOrdersTable.status),
  );
  res.json(rows);
});

// Goods-in-transit: POs sent to supplier but not yet fully received
router.get("/procurement/reports/goods-in-transit", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { supplierId, from, to } = req.query as Record<string, string>;

  const pos = await withTenantDb(tenantId, (db) =>
    db.select({
      id: purchaseOrdersTable.id,
      code: purchaseOrdersTable.code,
      supplierId: purchaseOrdersTable.supplierId,
      supplierName: purchaseOrdersTable.supplierName,
      status: purchaseOrdersTable.status,
      total: purchaseOrdersTable.total,
      currencyCode: purchaseOrdersTable.currencyCode,
      deliveryDate: purchaseOrdersTable.deliveryDate,
      createdAt: purchaseOrdersTable.createdAt,
    })
      .from(purchaseOrdersTable)
      .where(and(
        eq(purchaseOrdersTable.tenantId, tenantId),
        isNull(purchaseOrdersTable.deletedAt),
        sql`${purchaseOrdersTable.status} IN ('sent', 'partially_received')`,
        supplierId ? eq(purchaseOrdersTable.supplierId, Number(supplierId)) : undefined,
        from ? sql`${purchaseOrdersTable.createdAt} >= ${from}::timestamptz` : undefined,
        to ? sql`${purchaseOrdersTable.createdAt} <= ${to}::timestamptz` : undefined,
      ))
      .orderBy(asc(purchaseOrdersTable.deliveryDate)));

  if (pos.length === 0) { res.json([]); return; }

  // For each PO, calculate total ordered qty vs total received qty across all lines
  const poIds = pos.map((p) => p.id);
  const orderedQtys = await withTenantDb(tenantId, (db) =>
    db.select({
      poId: poLinesTable.poId,
      totalOrdered: sql<number>`sum(${poLinesTable.quantity}::numeric)`,
    })
      .from(poLinesTable)
      .where(and(eq(poLinesTable.tenantId, tenantId), inArray(poLinesTable.poId, poIds)))
      .groupBy(poLinesTable.poId));

  const receivedQtys = await withTenantDb(tenantId, (db) =>
    db.select({
      poId: poLinesTable.poId,
      totalReceived: sql<number>`sum(${receiptLinesTable.receivedQty}::numeric)`,
    })
      .from(receiptLinesTable)
      .innerJoin(poLinesTable, and(eq(receiptLinesTable.poLineId, poLinesTable.id), eq(receiptLinesTable.tenantId, tenantId)))
      .innerJoin(poReceiptsTable, and(eq(receiptLinesTable.receiptId, poReceiptsTable.id), sql`${poReceiptsTable.status} = 'confirmed'`))
      .where(and(eq(receiptLinesTable.tenantId, tenantId), inArray(poLinesTable.poId, poIds)))
      .groupBy(poLinesTable.poId));

  const orderedMap = new Map(orderedQtys.map((r) => [r.poId, Number(r.totalOrdered)]));
  const receivedMap = new Map(receivedQtys.map((r) => [r.poId, Number(r.totalReceived)]));

  const result = pos.map((po) => {
    const totalOrdered = orderedMap.get(po.id) ?? 0;
    const totalReceived = receivedMap.get(po.id) ?? 0;
    const outstandingQty = Math.max(0, totalOrdered - totalReceived);
    return {
      ...po,
      totalOrdered,
      totalReceived,
      outstandingQty,
      outstandingPct: totalOrdered > 0 ? Math.round((outstandingQty / totalOrdered) * 100) : 0,
    };
  });

  res.json(result);
});

// ── Notifications ─────────────────────────────────────────────────────────────

router.get("/notifications", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const { unreadOnly, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.recipientClerkId, clerkUserId),
        unreadOnly === "true" ? eq(notificationsTable.isRead, false) : undefined,
      ))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(lim).offset(offset));
  const [countRow] = await withTenantDb(tenantId, (db) =>
    db.select({ count: sql<number>`count(*)` }).from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.recipientClerkId, clerkUserId),
        unreadOnly === "true" ? eq(notificationsTable.isRead, false) : undefined,
      )));
  const [unreadRow] = await withTenantDb(tenantId, (db) =>
    db.select({ count: sql<number>`count(*)` }).from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, tenantId),
        eq(notificationsTable.recipientClerkId, clerkUserId),
        eq(notificationsTable.isRead, false),
      )));
  res.json({ notifications: rows, total: Number(countRow?.count ?? 0), unreadCount: Number(unreadRow?.count ?? 0), page: pg, limit: lim });
});

router.patch("/notifications/:id/read", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(notificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notificationsTable.id, id), eq(notificationsTable.tenantId, tenantId), eq(notificationsTable.recipientClerkId, clerkUserId)))
      .returning());
  if (!updated) { res.status(404).json({ error: "Notification not found" }); return; }
  res.json(updated);
});

router.patch("/notifications/read-all", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  await withTenantDb(tenantId, (db) =>
    db.update(notificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(and(eq(notificationsTable.tenantId, tenantId), eq(notificationsTable.recipientClerkId, clerkUserId), eq(notificationsTable.isRead, false))));
  res.json({ ok: true });
});

export default router;

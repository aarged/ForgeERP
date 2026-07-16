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
  tenantMembershipsTable,
  backordersTable,
} from "@workspace/db";
import { withTenantDb, type TenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { buildExportFilename } from "../lib/exportFilename";
import { sendEmail } from "../lib/email";
import type { Request, Response } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";

const router: IRouter = Router();

const tenantUserMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("viewer", "purchaser", "warehouse", "approver", "accountant", "tenant_admin", "global_admin"),
];

const tenantWriteMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("purchaser", "warehouse", "approver", "accountant", "tenant_admin", "global_admin"),
];

const tenantAdminMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("tenant_admin", "global_admin"),
];

// Approval actions are restricted to designated approvers, admins, and global-admins
const approverMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("approver", "tenant_admin", "global_admin"),
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
  // Warehouse is mandatory — receipt creation now enforces this, but guard defensively
  if (!rcpt.warehouseId) throw new Error(`Receipt ${receiptId} has no warehouseId; cannot post inventory. Set a warehouse on the receipt or PO before confirming.`);

  // Defensive: resolve itemId from poLine for any lines already stored without it
  const missingItemIdPoLineIds = receiptLines.filter((l) => !l.itemId && l.poLineId != null).map((l) => l.poLineId as number);
  const poLineItemMap = new Map<number, number>();
  if (missingItemIdPoLineIds.length > 0) {
    const poLineRows = await withTenantDb(tenantId, (db) =>
      db.select({ id: poLinesTable.id, itemId: poLinesTable.itemId }).from(poLinesTable).where(inArray(poLinesTable.id, missingItemIdPoLineIds)));
    for (const pl of poLineRows) { if (pl.itemId) poLineItemMap.set(pl.id, pl.itemId); }
  }

  for (const line of receiptLines) {
    const resolvedItemId = line.itemId ?? (line.poLineId != null ? poLineItemMap.get(line.poLineId) ?? null : null);
    if (!resolvedItemId || Number(line.receivedQty) <= 0) continue;
    const itemId = resolvedItemId;

    const warehouseId = rcpt.warehouseId;
    const locationId = line.locationId ?? rcpt.locationId;
    const qty = Number(line.receivedQty);

    const existing = await withTenantDb(tenantId, (db) =>
      db.select().from(inventoryStockTable)
        .where(and(
          eq(inventoryStockTable.tenantId, tenantId),
          eq(inventoryStockTable.itemId, itemId),
          eq(inventoryStockTable.warehouseId, warehouseId),
          locationId ? eq(inventoryStockTable.locationId, locationId) : isNull(inventoryStockTable.locationId),
          line.lotNumber ? eq(inventoryStockTable.lotNumber, line.lotNumber) : isNull(inventoryStockTable.lotNumber),
          line.batchNumber ? eq(inventoryStockTable.batchNumber, line.batchNumber) : isNull(inventoryStockTable.batchNumber),
          line.serialNumber ? eq(inventoryStockTable.serialNumber, line.serialNumber) : isNull(inventoryStockTable.serialNumber),
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
          itemId,
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
        itemId,
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

/** DB-transactional variant: posts inventory/movements for a receipt inside an already-open TenantDb transaction. */
async function postInventoryReceiptInTx(db: TenantDb, tenantId: number, receiptId: number, postedByClerkId: string) {
  const receiptLines = await db.select().from(receiptLinesTable)
    .where(and(eq(receiptLinesTable.receiptId, receiptId), eq(receiptLinesTable.tenantId, tenantId)));
  const receipt = (await db.select().from(poReceiptsTable)
    .where(and(eq(poReceiptsTable.id, receiptId), eq(poReceiptsTable.tenantId, tenantId))).limit(1))[0];
  if (!receipt) return;
  if (!receipt.warehouseId) throw new Error(`Receipt ${receiptId} has no warehouseId; cannot post inventory. Set a warehouse on the receipt or PO before confirming.`);

  // Defensive: resolve itemId from poLine for any lines already stored without it (legacy or UI-omitted)
  const missingItemIdPoLineIds = receiptLines.filter((l) => !l.itemId && l.poLineId != null).map((l) => l.poLineId as number);
  const poLineItemMap = new Map<number, number>();
  if (missingItemIdPoLineIds.length > 0) {
    const poLineRows = await db.select({ id: poLinesTable.id, itemId: poLinesTable.itemId })
      .from(poLinesTable).where(inArray(poLinesTable.id, missingItemIdPoLineIds));
    for (const pl of poLineRows) { if (pl.itemId) poLineItemMap.set(pl.id, pl.itemId); }
  }

  for (const line of receiptLines) {
    const resolvedItemId = line.itemId ?? (line.poLineId != null ? poLineItemMap.get(line.poLineId) ?? null : null);
    if (!resolvedItemId || Number(line.receivedQty) <= 0) continue;
    // Shadow line.itemId with resolved value for the rest of the loop body
    const itemId = resolvedItemId;
    const warehouseId = receipt.warehouseId;
    const locationId = line.locationId ?? receipt.locationId;
    const qty = Number(line.receivedQty);

    const existing = (await db.select().from(inventoryStockTable)
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        eq(inventoryStockTable.itemId, itemId),
        eq(inventoryStockTable.warehouseId, warehouseId),
        locationId ? eq(inventoryStockTable.locationId, locationId) : isNull(inventoryStockTable.locationId),
        line.lotNumber ? eq(inventoryStockTable.lotNumber, line.lotNumber) : isNull(inventoryStockTable.lotNumber),
        line.batchNumber ? eq(inventoryStockTable.batchNumber, line.batchNumber) : isNull(inventoryStockTable.batchNumber),
        line.serialNumber ? eq(inventoryStockTable.serialNumber, line.serialNumber) : isNull(inventoryStockTable.serialNumber),
      )).limit(1))[0];

    if (existing) {
      const newQty = Number(existing.qtyOnHand) + qty;
      const curCost = Number(existing.averageCost ?? 0);
      const newAvgCost = Number(existing.qtyOnHand) === 0
        ? Number(line.unitCost ?? 0)
        : (Number(existing.qtyOnHand) * curCost + qty * Number(line.unitCost ?? 0)) / newQty;
      await db.update(inventoryStockTable).set({ qtyOnHand: newQty.toFixed(4), averageCost: newAvgCost.toFixed(4), lastMovementAt: new Date() })
        .where(and(eq(inventoryStockTable.id, existing.id), eq(inventoryStockTable.tenantId, tenantId)));
    } else {
      await db.insert(inventoryStockTable).values({
        tenantId, itemId, warehouseId,
        locationId: locationId ?? undefined,
        lotNumber: line.lotNumber ?? undefined, batchNumber: line.batchNumber ?? undefined,
        serialNumber: line.serialNumber ?? undefined, expiryDate: line.expiryDate ?? undefined,
        qtyOnHand: qty.toFixed(4), averageCost: line.unitCost ?? undefined, lastMovementAt: new Date(),
      } as typeof inventoryStockTable.$inferInsert);
    }

    await db.insert(inventoryMovementsTable).values({
      tenantId, itemId, warehouseId,
      locationId: locationId ?? undefined,
      movementType: "receipt", quantity: qty.toFixed(4), unitCost: line.unitCost ?? undefined,
      refType: "po_receipt", refId: receiptId,
      lotNumber: line.lotNumber ?? undefined, batchNumber: line.batchNumber ?? undefined,
      serialNumber: line.serialNumber ?? undefined, postedByClerkId,
    } as typeof inventoryMovementsTable.$inferInsert);

    await db.update(poLinesTable)
      .set({ receivedQty: sql`${poLinesTable.receivedQty} + ${qty.toFixed(4)}` })
      .where(and(eq(poLinesTable.id, line.poLineId), eq(poLinesTable.tenantId, tenantId)));
  }
}

/** DB-transactional variant: creates a GL posting for a receipt inside an already-open TenantDb transaction. */
async function createGlPostingInTx(db: TenantDb, tenantId: number, receiptId: number, postedByClerkId: string, postedByEmail?: string) {
  const receipt = (await db.select().from(poReceiptsTable)
    .where(and(eq(poReceiptsTable.id, receiptId), eq(poReceiptsTable.tenantId, tenantId))).limit(1))[0];
  if (!receipt) return null;
  const po = (await db.select().from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.id, receipt.poId), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1))[0];
  if (!po) return null;
  const lines = await db.select().from(receiptLinesTable)
    .where(and(eq(receiptLinesTable.receiptId, receiptId), eq(receiptLinesTable.tenantId, tenantId)));

  const poLineIds = lines.map((l) => l.poLineId).filter(Boolean) as number[];
  const poLineRows = poLineIds.length > 0
    ? await db.select({ id: poLinesTable.id, glAccountId: poLinesTable.glAccountId })
        .from(poLinesTable).where(inArray(poLinesTable.id, poLineIds))
    : [];
  const poLineGlMap = new Map(poLineRows.map((pl) => [pl.id, pl.glAccountId]));

  // Resolve AP account
  async function resolveGlInTx(glAccountId: number | null | undefined, fallbackCode: string, fallbackName: string) {
    if (glAccountId) {
      const [acct] = await db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
        .from(glAccountsTable).where(and(eq(glAccountsTable.id, glAccountId), eq(glAccountsTable.tenantId, tenantId))).limit(1);
      if (acct) return { accountCode: acct.code, accountName: acct.name };
    }
    const [byCode] = await db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
      .from(glAccountsTable).where(and(eq(glAccountsTable.code, fallbackCode), eq(glAccountsTable.tenantId, tenantId))).limit(1);
    return { accountCode: byCode?.code ?? fallbackCode, accountName: byCode?.name ?? fallbackName };
  }

  const apAccount = await resolveGlInTx(null, "2100", "Accounts Payable");
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];
  let totalValue = 0;
  for (const rl of lines) {
    const lineVal = Number(rl.receivedQty) * Number(rl.unitCost ?? 0);
    totalValue += lineVal;
    const invAccount = await resolveGlInTx(poLineGlMap.get(rl.poLineId) ?? null, "1300", "Inventory");
    glLines.push({ ...invAccount, debit: lineVal, credit: 0, description: `Receipt of ${rl.itemCode ?? rl.itemName ?? "item"}` });
  }
  glLines.push({ ...apAccount, debit: 0, credit: totalValue, description: `AP for PO ${po.code}` });

  const [posting] = await db.insert(glPostingsTable).values({
    tenantId, code: `GL-${Date.now()}`, entityType: "po_receipt", entityId: receiptId,
    status: "posted", postedByClerkId, postedByEmail: postedByEmail ?? undefined,
    postedAt: new Date(), lines: glLines, totalDebit: totalValue.toFixed(2), totalCredit: totalValue.toFixed(2),
  } as typeof glPostingsTable.$inferInsert).returning();
  return posting;
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

  type WfRules = { valueAbove?: number; supplierIds?: number[]; warehouseIds?: number[]; itemCategories?: string[] };

  // Filter to workflows whose rules are satisfied by the current context
  const matching = workflows.filter((w) => {
    const rules = (w.triggerRules ?? {}) as WfRules;
    if (rules.valueAbove !== undefined && (context.totalValue === undefined || context.totalValue === null || Number(context.totalValue) < rules.valueAbove)) return false;
    if (rules.supplierIds && rules.supplierIds.length > 0 && (!context.supplierId || !rules.supplierIds.includes(context.supplierId))) return false;
    if (rules.warehouseIds && rules.warehouseIds.length > 0 && (!context.warehouseId || !rules.warehouseIds.includes(context.warehouseId))) return false;
    if (rules.itemCategories && rules.itemCategories.length > 0) {
      const hasMatchingCategory = (context.lineCategories ?? []).some((cat) => rules.itemCategories!.includes(cat));
      if (!hasMatchingCategory) return false;
    }
    return true;
  });

  if (matching.length === 0) return null;

  // Deterministic selection: prefer the most-specific workflow (highest constraint count).
  // If two workflows have equal specificity, prefer the one with the higher ID (created later).
  const specificity = (w: typeof approvalWorkflowsTable.$inferSelect): number => {
    const rules = (w.triggerRules ?? {}) as WfRules;
    let score = 0;
    if (rules.valueAbove !== undefined) score++;
    if (rules.supplierIds && rules.supplierIds.length > 0) score++;
    if (rules.warehouseIds && rules.warehouseIds.length > 0) score++;
    if (rules.itemCategories && rules.itemCategories.length > 0) score++;
    return score;
  };

  matching.sort((a, b) => {
    const diff = specificity(b) - specificity(a);
    return diff !== 0 ? diff : b.id - a.id;
  });

  return matching[0];
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

/** Transaction-local variant: resolves GL account using an already-open TenantDb connection. */
async function resolveGlAccountInTx(db: TenantDb, tenantId: number, glAccountId: number | null | undefined, fallbackCode: string, fallbackName: string) {
  if (glAccountId) {
    const [acct] = await db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
      .from(glAccountsTable)
      .where(and(eq(glAccountsTable.id, glAccountId), eq(glAccountsTable.tenantId, tenantId)))
      .limit(1);
    if (acct) return { accountCode: acct.code, accountName: acct.name };
  }
  const [byCode] = await db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
    .from(glAccountsTable)
    .where(and(eq(glAccountsTable.code, fallbackCode), eq(glAccountsTable.tenantId, tenantId)))
    .limit(1);
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

/**
 * Resolve the full set of Clerk user IDs that are eligible approvers for a step.
 * Merges explicit approverUserIds with members whose role matches approverRoles.
 */
async function resolveApproverClerkIds(
  tenantId: number,
  step: typeof approvalStepsTable.$inferSelect,
): Promise<string[]> {
  const explicit: string[] = (step.approverUserIds as string[] | null) ?? [];
  const roles: string[] = (step.approverRoles as string[] | null) ?? [];

  let fromRoles: string[] = [];
  if (roles.length > 0) {
    const members = await withTenantDb(tenantId, (db) =>
      db.select({ clerkId: tenantMembershipsTable.clerkId })
        .from(tenantMembershipsTable)
        .where(and(
          eq(tenantMembershipsTable.tenantId, tenantId),
          inArray(tenantMembershipsTable.role, roles as ("global_admin" | "tenant_admin" | "purchaser" | "warehouse" | "approver" | "accountant" | "viewer")[]),
        )));
    fromRoles = members.map((m) => m.clerkId);
  }

  // Deduplicate
  return [...new Set([...explicit, ...fromRoles])];
}

/** DB-transactional variant: posts GL credit-note for a return inside an already-open TenantDb transaction. */
async function createReturnGlPostingInTx(db: TenantDb, tenantId: number, returnId: number, postedByClerkId: string, postedByEmail?: string) {
  const [ret] = await db.select().from(poReturnsTable).where(and(eq(poReturnsTable.id, returnId), eq(poReturnsTable.tenantId, tenantId))).limit(1);
  if (!ret) return null;

  const lines = await db.select().from(poReturnLinesTable)
    .where(and(eq(poReturnLinesTable.returnId, returnId), eq(poReturnLinesTable.tenantId, tenantId)));

  const apAccount = await resolveGlAccountInTx(db, tenantId, null, "2100", "Accounts Payable");

  let totalValue = 0;
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];
  for (const rl of lines) {
    if (Number(rl.quantity) <= 0) continue;
    const lineVal = Number(rl.quantity) * Number(rl.unitCost ?? 0);
    totalValue += lineVal;
    const invAccount = await resolveGlAccountInTx(db, tenantId, null, "1300", "Inventory");
    glLines.push({ ...invAccount, debit: 0, credit: lineVal, description: `RTV of ${rl.itemCode ?? rl.itemName ?? "item"}` });
  }
  if (totalValue === 0) return null;
  glLines.push({ ...apAccount, debit: totalValue, credit: 0, description: `AP credit note for return ${returnId}` });

  const [posting] = await db.insert(glPostingsTable).values({
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
  } as typeof glPostingsTable.$inferInsert).returning();

  if (posting) {
    await db.update(poReturnsTable).set({ glPostingId: posting.id }).where(and(eq(poReturnsTable.id, returnId), eq(poReturnsTable.tenantId, tenantId)));
  }
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

      // Eligibility rules — hard baseline: actor must have approver|tenant_admin|global_admin role.
      // • No constraints (open step) → baseline role check applies (any baseline-role user may act)
      // • Role constraint only → actor's role must be in the configured list
      // • User constraint only → actor's clerk ID must be in the list AND role is baseline
      // • Both constraints → either role OR user match is sufficient (role still baseline enforced at route level)
      const baselineApproverRoles = ["approver", "tenant_admin", "global_admin"];
      if (!baselineApproverRoles.includes(actorRole)) {
        // Strict baseline: even explicit approverUserIds must hold a baseline approver role
        throw Object.assign(
          new Error("You do not have the required role to perform approval actions"),
          { statusCode: 403 },
        );
      }
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
      // Resolve all required approvers (explicit user IDs + role-based members)
      const requiredUserIds = await resolveApproverClerkIds(tenantId, step);
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
    // Only roles that are authorised to reach /decision endpoints
    approverRoles: z.array(z.enum(["approver", "tenant_admin", "global_admin"])).default([]),
    approverUserIds: z.array(z.string()).default([]),
    approvalMode: z.enum(["any", "all"]).default("any"),
    valueLimit: z.number().nonnegative().optional(),
    escalationDays: z.number().int().positive().default(3),
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
  let workflow = await selectWorkflow(tenantId, "purchase_requisition", {
    totalValue: req_.totalEstimated,
    supplierId: req_.preferredSupplierId,
    warehouseId: req_.deliverToWarehouseId,
    lineCategories,
  });

  // Guard: if selected workflow has no step 1, treat it as "no workflow" (auto-approve)
  let step1: (typeof approvalStepsTable.$inferSelect)[] = [];
  if (workflow) {
    step1 = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, workflow!.id), eq(approvalStepsTable.stepNumber, 1), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (step1.length === 0) workflow = null;
  }

  // Always advance to pending_approval on submit. The status only moves to "approved"
  // after an approver explicitly acts via the /decision endpoint — even when no workflow
  // matches, an eligible approver (approver | tenant_admin | global_admin) must take action.
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({
        status: "pending_approval",
        approvalWorkflowId: workflow?.id ?? undefined,
        currentApprovalStep: workflow ? 1 : 0,
      })
      .where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId)))
      .returning(),
  );
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "requisition.submitted", entityType: "purchase_requisition", entityId: String(id) });

  // Notify eligible approvers that the requisition is awaiting their decision.
  // With a workflow: notify step-1 approvers. Without: notify all baseline approvers in the tenant.
  if (workflow && step1[0]) {
    const approverIds = await resolveApproverClerkIds(tenantId, step1[0]);
    await Promise.all(approverIds.map((uid) =>
      createNotification(tenantId, uid, "approval_required",
        "Requisition requires your approval",
        `Purchase Requisition ${genCode("REQ", id)} has been submitted and is awaiting your approval.`,
        { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) }),
    ));
  } else {
    const baselineApprovers = await withTenantDb(tenantId, (db) =>
      db.select({ clerkId: tenantMembershipsTable.clerkId })
        .from(tenantMembershipsTable)
        .where(and(
          eq(tenantMembershipsTable.tenantId, tenantId),
          inArray(tenantMembershipsTable.role, ["approver", "tenant_admin", "global_admin"]),
        )));
    const approverIds = [...new Set(baselineApprovers.map((m) => m.clerkId))];
    await Promise.all(approverIds.map((uid) =>
      createNotification(tenantId, uid, "approval_required",
        "Requisition requires your approval",
        `Purchase Requisition ${genCode("REQ", id)} has been submitted and is awaiting your approval.`,
        { entityType: "purchase_requisition", entityId: id, entityCode: genCode("REQ", id) }),
    ));
  }

  res.json(updated);
});

// Approve/reject/return — restricted to approver, tenant_admin, global_admin
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

  // Optimistic lock: only advance if the entity is still in the same step we read
  // (prevents duplicate PO creation / duplicate step advances on concurrent approvals)
  const updatedRows = await withTenantDb(tenantId, (db) =>
    db.update(purchaseRequisitionsTable)
      .set({ status: result.newStatus, currentApprovalStep: result.newStepNum || undefined })
      .where(and(
        eq(purchaseRequisitionsTable.id, id),
        eq(purchaseRequisitionsTable.tenantId, tenantId),
        eq(purchaseRequisitionsTable.status, "pending_approval"),
        eq(purchaseRequisitionsTable.currentApprovalStep, req_.currentApprovalStep ?? 1),
      ))
      .returning());
  if (updatedRows.length === 0) {
    // Another concurrent request already advanced this entity — return current state
    const [cur] = await withTenantDb(tenantId, (db) =>
      db.select().from(purchaseRequisitionsTable).where(and(eq(purchaseRequisitionsTable.id, id), eq(purchaseRequisitionsTable.tenantId, tenantId))).limit(1));
    res.json(cur);
    return;
  }
  const [updated] = updatedRows;
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
      const approverIds = await resolveApproverClerkIds(tenantId, nextStep[0]);
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
  // Idempotency: if this requisition was already converted, return the existing PO id
  if (req_.convertedPoId) return req_.convertedPoId;

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
  let poWorkflow = await selectWorkflow(tenantId, "purchase_order", {
    totalValue: po.total,
    supplierId: po.supplierId,
    warehouseId: po.deliverToWarehouseId,
    lineCategories: poLineCategories,
  });

  // Guard: if selected workflow has no step 1, treat it as "no workflow" (auto-approve)
  let poStep1: (typeof approvalStepsTable.$inferSelect)[] = [];
  if (poWorkflow) {
    poStep1 = await withTenantDb(tenantId, (db) =>
      db.select().from(approvalStepsTable)
        .where(and(eq(approvalStepsTable.workflowId, poWorkflow!.id), eq(approvalStepsTable.stepNumber, 1), eq(approvalStepsTable.tenantId, tenantId)))
        .limit(1));
    if (poStep1.length === 0) poWorkflow = null;
  }
  const workflow = poWorkflow;

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable)
      .set({ status: workflow ? "pending_approval" : "approved", approvalWorkflowId: workflow?.id ?? undefined, currentApprovalStep: workflow ? 1 : 0 })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.submitted", entityType: "purchase_order", entityId: String(id) });

  // Notify step-1 approvers or confirm auto-approval to submitter
  if (workflow) {
    // poStep1 was already fetched above (guaranteed non-empty)
    if (poStep1[0]) {
      const approverIds = await resolveApproverClerkIds(tenantId, poStep1[0]);
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

// Approve/reject/return PO — restricted to approver, tenant_admin, global_admin
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

  // Optimistic lock: only advance if the PO is still in the same step we read
  const poUpdatedRows = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable)
      .set({ status: result.newStatus, currentApprovalStep: result.newStepNum || undefined })
      .where(and(
        eq(purchaseOrdersTable.id, id),
        eq(purchaseOrdersTable.tenantId, tenantId),
        eq(purchaseOrdersTable.status, "pending_approval"),
        eq(purchaseOrdersTable.currentApprovalStep, po.currentApprovalStep ?? 1),
      ))
      .returning());
  if (poUpdatedRows.length === 0) {
    const [cur] = await withTenantDb(tenantId, (db) =>
      db.select().from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1));
    res.json(cur);
    return;
  }
  const [updated] = poUpdatedRows;
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
      const approverIds = await resolveApproverClerkIds(tenantId, nextStep[0]);
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

// ── PDF generation helper ─────────────────────────────────────────────────────

type PoRecord = typeof purchaseOrdersTable.$inferSelect;
type PoLineRecord = typeof poLinesTable.$inferSelect;

function generatePoPdf(po: PoRecord, lines: PoLineRecord[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

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
}

function buildPoEmailHtml(po: PoRecord): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f8fafc;padding:32px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:24px 32px">
      <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">Forge ERP</span>
    </div>
    <div style="padding:32px">
      <p style="font-size:16px;color:#1e293b;margin-top:0">Dear ${po.supplierName ?? "Supplier"},</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Please find attached Purchase Order <strong>${po.code}</strong> from our team.
        Total value: <strong>${Number(po.total).toFixed(2)} ${po.currencyCode}</strong>.
      </p>
      ${po.deliveryDate ? `<p style="font-size:15px;color:#475569">Requested delivery date: <strong>${po.deliveryDate}</strong></p>` : ""}
      ${po.paymentTerms ? `<p style="font-size:15px;color:#475569">Payment terms: <strong>${po.paymentTerms}</strong></p>` : ""}
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        Please reply to this email to confirm receipt or raise any queries.<br>The Forge ERP Team
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Mark PO as sent — transitions to "sent" and dispatches PDF to supplier email
router.post("/procurement/purchase-orders/:id/send", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const { supplierEmail: bodyEmail } = (req.body ?? {}) as { supplierEmail?: string };

  const [po] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }
  if (po.status !== "approved") {
    res.status(400).json({ error: `PO cannot be sent in status: ${po.status}. Only approved POs can be sent to suppliers.` });
    return;
  }

  // Resolve supplier email: body param → supplier record → required (must be resolvable to dispatch)
  let resolvedEmail = bodyEmail ?? null;
  if (!resolvedEmail && po.supplierId) {
    const [supplier] = await withTenantDb(tenantId, (db) =>
      db.select({ email: suppliersTable.email }).from(suppliersTable)
        .where(and(eq(suppliersTable.id, po.supplierId!), eq(suppliersTable.tenantId, tenantId)))
        .limit(1));
    resolvedEmail = supplier?.email ?? null;
  }

  // Require a resolvable email before transitioning to "sent" — prevents misleading status
  if (!resolvedEmail) {
    res.status(400).json({ error: "No supplier email address available. Provide a supplierEmail in the request body or set an email on the supplier record." });
    return;
  }

  // Send PDF email to supplier — PO transitions to "sent" only after email dispatch attempt
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poLinesTable)
      .where(and(eq(poLinesTable.poId, id), eq(poLinesTable.tenantId, tenantId))));
  const pdfBuffer = await generatePoPdf(po, lines);
  let emailSent = false;
  try {
    emailSent = await sendEmail({
      to: resolvedEmail,
      subject: `Purchase Order ${po.code} from Forge ERP`,
      html: buildPoEmailHtml(po),
      text: `Dear ${po.supplierName ?? "Supplier"},\n\nPlease find attached Purchase Order ${po.code}.\nTotal: ${Number(po.total).toFixed(2)} ${po.currencyCode}.\n\nThe Forge ERP Team`,
      attachments: [{ filename: `${po.code}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    });
  } catch (err) {
    console.warn("PO email dispatch failed:", err);
    res.status(502).json({ error: "Email dispatch failed. PO status was not changed.", supplierEmail: resolvedEmail });
    return;
  }

  // Gate status transition on confirmed dispatch — sendEmail returns false when SMTP is not configured
  if (!emailSent) {
    res.status(502).json({ error: "Email could not be dispatched (mail transport unavailable). PO status was not changed.", supplierEmail: resolvedEmail, emailSent: false });
    return;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(purchaseOrdersTable).set({ status: "sent", sentAt: new Date() })
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "PO not found" }); return; }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.sent", entityType: "purchase_order", entityId: String(id), newValues: { supplierEmail: resolvedEmail, emailSent } });
  res.json({ ...updated, supplierEmail: resolvedEmail, emailSent });
});

// Generate PO PDF and optionally dispatch to a given email address
router.post("/procurement/purchase-orders/:id/pdf", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const { dispatchEmail } = (req.body ?? {}) as { dispatchEmail?: string };

  const [po] = await withTenantDb(tenantId, (db) =>
    db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, id), eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .limit(1));
  if (!po) { res.status(404).json({ error: "PO not found" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poLinesTable)
      .where(and(eq(poLinesTable.poId, id), eq(poLinesTable.tenantId, tenantId))));

  const pdfBuffer = await generatePoPdf(po, lines);
  const pdfBase64 = pdfBuffer.toString("base64");
  // Email attachment keeps the PO code as filename (per spec: emails out of scope).
  const emailAttachmentFilename = `${po.code}.pdf`;
  // Browser download filename gets the timestamped tenant-prefixed format.
  const filename = await buildExportFilename(tenantId, po.code, "pdf");

  let emailSent = false;
  if (dispatchEmail) {
    emailSent = await sendEmail({
      to: dispatchEmail,
      subject: `Purchase Order ${po.code} from Forge ERP`,
      html: buildPoEmailHtml(po),
      text: `Dear ${po.supplierName ?? "Supplier"},\n\nPlease find attached Purchase Order ${po.code}.\nTotal: ${Number(po.total).toFixed(2)} ${po.currencyCode}.\n\nThe Forge ERP Team`,
      attachments: [{ filename: emailAttachmentFilename, content: pdfBuffer, contentType: "application/pdf" }],
    });
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "purchase_order.pdf_generated", entityType: "purchase_order", entityId: String(id), newValues: { dispatchEmail: dispatchEmail ?? null, emailSent } });

  res.json({ pdfBase64, filename, dispatchEmail: dispatchEmail ?? null, emailSent });
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
  orderedQty: z.number().nonnegative("orderedQty must be >= 0"),
  receivedQty: z.number().positive("receivedQty must be > 0"),
  unitCost: z.number().nonnegative("unitCost must be >= 0").optional(),
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
    db.select({ id: purchaseOrdersTable.id, status: purchaseOrdersTable.status, deliverToWarehouseId: purchaseOrdersTable.deliverToWarehouseId })
      .from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, parsed.data.poId), eq(purchaseOrdersTable.tenantId, tenantId)))
      .limit(1));
  if (!receivingPo) { res.status(404).json({ error: "Purchase order not found" }); return; }
  if (!["approved", "sent", "partially_received"].includes(receivingPo.status)) {
    res.status(400).json({ error: `Cannot receive goods against a PO with status: ${receivingPo.status}` });
    return;
  }

  // Warehouse is required for inventory posting; default from PO's deliver-to warehouse
  const resolvedWarehouseId = parsed.data.warehouseId ?? receivingPo.deliverToWarehouseId ?? null;
  if (!resolvedWarehouseId) {
    res.status(400).json({ error: "warehouseId is required for goods receipt. Provide it in the request or set a deliver-to warehouse on the PO." });
    return;
  }

  // Validate all poLineIds and load PO line data to fill in missing item details
  let poLineMap = new Map<number, { id: number; itemId: number | null; itemCode: string | null; itemName: string | null; unitPrice: string | null }>();
  if (lines.length > 0) {
    const poLineIds = lines.map((l) => l.poLineId).filter(Boolean) as number[];
    if (poLineIds.length > 0) {
      const validPoLines = await withTenantDb(tenantId, (db) =>
        db.select({ id: poLinesTable.id, itemId: poLinesTable.itemId, itemCode: poLinesTable.itemCode, itemName: poLinesTable.itemName, unitPrice: poLinesTable.unitPrice })
          .from(poLinesTable)
          .where(and(inArray(poLinesTable.id, poLineIds), eq(poLinesTable.poId, parsed.data.poId), eq(poLinesTable.tenantId, tenantId))));
      poLineMap = new Map(validPoLines.map((pl) => [pl.id, pl]));
      const invalidLine = poLineIds.find((lid) => !poLineMap.has(lid));
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
      warehouseId: resolvedWarehouseId, // resolved: body param or PO default
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
      db.insert(receiptLinesTable).values(lines.map((l) => {
        const poLine = poLineMap.get(l.poLineId);
        return {
          ...l,
          receiptId,
          tenantId,
          // Auto-populate item details from PO line when not explicitly provided by caller
          itemId: l.itemId ?? poLine?.itemId ?? undefined,
          itemCode: l.itemCode ?? poLine?.itemCode ?? undefined,
          itemName: l.itemName ?? poLine?.itemName ?? undefined,
          unitCost: l.unitCost != null ? String(l.unitCost) : (poLine?.unitPrice ?? undefined),
          orderedQty: String(l.orderedQty),
          receivedQty: String(l.receivedQty),
        } as typeof receiptLinesTable.$inferInsert;
      })),
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

  // Pre-flight checks — read-only, outside the main transaction so we can return early cleanly
  const [receipt] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReceiptsTable).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).limit(1));
  if (!receipt) { res.status(404).json({ error: "Receipt not found" }); return; }
  if (receipt.status !== "draft") { res.status(400).json({ error: "Receipt is already confirmed" }); return; }

  // Run the entire confirmation atomically in a single database transaction
  const result = await withTenantDb(tenantId, async (db) => {
    // 1. Post inventory movements and update received quantities
    await postInventoryReceiptInTx(db, tenantId, id, clerkUserId);

    // 2. Create GL posting
    const posting = await createGlPostingInTx(db, tenantId, id, clerkUserId, userEmail);

    // 3. Confirm the receipt (stamp status, timestamp, GL reference)
    const [confirmed] = await db.update(poReceiptsTable).set({
      status: "confirmed",
      receivedAt: new Date(),
      glPostingId: posting?.id ?? undefined,
    }).where(and(eq(poReceiptsTable.id, id), eq(poReceiptsTable.tenantId, tenantId))).returning();

    // 4. Recalculate PO fulfillment status and conditionally create a backorder receipt
    const po = (await db.select().from(purchaseOrdersTable)
      .where(and(eq(purchaseOrdersTable.id, receipt.poId), eq(purchaseOrdersTable.tenantId, tenantId))).limit(1))[0];

    let backorderId: number | undefined;
    if (po) {
      // Re-fetch PO lines AFTER receivedQty has been updated by postInventoryReceiptInTx
      const poLines = await db.select().from(poLinesTable)
        .where(and(eq(poLinesTable.poId, po.id), eq(poLinesTable.tenantId, tenantId)));

      const allReceived = poLines.every((l) => Number(l.receivedQty) >= Number(l.quantity));
      const anyReceived = poLines.some((l) => Number(l.receivedQty) > 0);
      const newPoStatus = allReceived ? "received" : anyReceived ? "partially_received" : "approved";

      await db.update(purchaseOrdersTable).set({ status: newPoStatus })
        .where(and(eq(purchaseOrdersTable.id, po.id), eq(purchaseOrdersTable.tenantId, tenantId)));

      // Auto-create a draft backorder receipt for lines with remaining open quantity
      if (!allReceived && anyReceived) {
        const backorderLines = poLines.filter((l) => Number(l.receivedQty) < Number(l.quantity));
        if (backorderLines.length > 0) {
          // Two-step insert: create with placeholder code, then stamp the real generated code
          const [backorderReceipt] = await db.insert(poReceiptsTable).values({
            tenantId,
            poId: po.id,
            code: "BACKORDER-PENDING",
            warehouseId: receipt.warehouseId ?? undefined,
            locationId: receipt.locationId ?? undefined,
            status: "draft",
            receivedByClerkId: clerkUserId,
            receivedByEmail: userEmail,
            notes: `Backorder from receipt ${receipt.code ?? `#${id}`}`,
          } as typeof poReceiptsTable.$inferInsert).returning();

          if (backorderReceipt) {
            // Stamp real code based on auto-generated ID
            await db.update(poReceiptsTable)
              .set({ code: genCode("RCV", backorderReceipt.id) })
              .where(eq(poReceiptsTable.id, backorderReceipt.id));

            await db.insert(receiptLinesTable).values(backorderLines.map((l) => ({
              tenantId,
              receiptId: backorderReceipt.id,
              poLineId: l.id,
              itemId: l.itemId ?? undefined,
              itemCode: l.itemCode ?? undefined,
              itemName: l.itemName ?? undefined,
              orderedQty: (Number(l.quantity) - Number(l.receivedQty)).toFixed(4),
              receivedQty: "0",
              unitCost: l.unitPrice,
            }) as typeof receiptLinesTable.$inferInsert));

            backorderId = backorderReceipt.id;
          }
        }
      }
    }

    return { confirmed, backorderId };
  });

  // Auto-release open sales backorders for items that just arrived via this PO receipt
  // Uses FIFO quantity-aware allocation: receipt qty is consumed across backorders in order
  try {
    const receiptLines = await withTenantDb(tenantId, (db) =>
      db.select({ itemId: receiptLinesTable.itemId, receivedQty: receiptLinesTable.receivedQty })
        .from(receiptLinesTable)
        .where(and(eq(receiptLinesTable.receiptId, id), eq(receiptLinesTable.tenantId, tenantId))));

    // Aggregate received qty by itemId
    const arrivedQtyByItem = new Map<number, number>();
    for (const line of receiptLines) {
      if (!line.itemId) continue;
      const qty = Number(line.receivedQty ?? 0);
      if (qty > 0) arrivedQtyByItem.set(line.itemId, (arrivedQtyByItem.get(line.itemId) ?? 0) + qty);
    }

    if (arrivedQtyByItem.size > 0) {
      const arrivedItemIds = [...arrivedQtyByItem.keys()];
      // Load open backorders sorted FIFO (oldest first) so oldest demand is fulfilled first
      const openBackorders = await withTenantDb(tenantId, (db) =>
        db.select().from(backordersTable)
          .where(and(
            eq(backordersTable.tenantId, tenantId),
            eq(backordersTable.status, "open"),
            isNull(backordersTable.deletedAt),
            inArray(backordersTable.itemId, arrivedItemIds),
          ))
          .orderBy(backordersTable.createdAt));

      // Track remaining receipt qty available per item as we consume across backorders
      const remainingByItem = new Map<number, number>(arrivedQtyByItem);

      await withTenantDb(tenantId, async (db) => {
        for (const bo of openBackorders) {
          if (!bo.itemId) continue;
          const remainingReceipt = remainingByItem.get(bo.itemId) ?? 0;
          if (remainingReceipt <= 0) continue;

          const backorderQty = Number(bo.backorderQty);
          if (backorderQty <= 0) continue;

          const canRelease = Math.min(remainingReceipt, backorderQty);
          const newReleasedQty = Number(bo.releasedQty) + canRelease;
          const newBackorderQty = backorderQty - canRelease;
          const newStatus = newBackorderQty <= 0 ? "released" : "open";

          await db.update(backordersTable)
            .set({
              status: newStatus,
              releasedQty: newReleasedQty.toFixed(4),
              backorderQty: newBackorderQty.toFixed(4),
              releasedAt: newStatus === "released" ? new Date() : bo.releasedAt,
              releasedByClerkId: newStatus === "released" ? clerkUserId : bo.releasedByClerkId,
              notes: (bo.notes ? bo.notes + "; " : "") + `Auto-released ${canRelease.toFixed(4)} on PO receipt #${id}`,
            })
            .where(and(eq(backordersTable.id, bo.id), eq(backordersTable.tenantId, tenantId)));

          // Reduce available receipt qty for this item
          remainingByItem.set(bo.itemId, remainingReceipt - canRelease);
        }
      });
    }
  } catch { /* non-blocking — backorder release failures must not roll back the confirmed receipt */ }

  // Audit logs outside the transaction (non-blocking; failure won't corrupt business state)
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.confirmed", entityType: "po_receipt", entityId: String(id) });
  if (result.backorderId) {
    await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "po_receipt.backorder_created", entityType: "po_receipt", entityId: String(result.backorderId), newValues: { parentReceiptId: id } });
  }

  res.json(result.confirmed);
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
      unitCost: z.number().nonnegative().optional(),
      locationId: z.number().int().optional(),
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

  // Resolve item details from PO lines for any line that has a poLineId but is missing itemId
  let returnPoLineMap = new Map<number, { id: number; itemId: number | null; itemCode: string | null; itemName: string | null; unitPrice: string | null }>();
  if (lines.length > 0) {
    const returnPoLineIds = lines.map((l) => l.poLineId).filter((id): id is number => id != null);
    if (returnPoLineIds.length > 0) {
      const returnPoLines = await withTenantDb(tenantId, (db) =>
        db.select({ id: poLinesTable.id, itemId: poLinesTable.itemId, itemCode: poLinesTable.itemCode, itemName: poLinesTable.itemName, unitPrice: poLinesTable.unitPrice })
          .from(poLinesTable)
          .where(and(inArray(poLinesTable.id, returnPoLineIds), eq(poLinesTable.poId, parsed.data.poId), eq(poLinesTable.tenantId, tenantId))));
      returnPoLineMap = new Map(returnPoLines.map((pl) => [pl.id, pl]));
    }
  }

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
      db.insert(poReturnLinesTable).values(lines.map((l) => {
        const poLine = l.poLineId != null ? returnPoLineMap.get(l.poLineId) : undefined;
        return {
          ...l,
          returnId: retId,
          tenantId,
          // Auto-populate item details from PO line when not explicitly provided
          itemId: l.itemId ?? poLine?.itemId ?? undefined,
          itemCode: l.itemCode ?? poLine?.itemCode ?? undefined,
          itemName: l.itemName ?? poLine?.itemName ?? undefined,
          unitCost: l.unitCost != null ? String(l.unitCost) : (poLine?.unitPrice ?? undefined),
          quantity: String(l.quantity),
        } as typeof poReturnLinesTable.$inferInsert;
      })),
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

  // Pre-flight checks outside the transaction (read-only, fast)
  const [ret] = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnsTable).where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId))).limit(1));
  if (!ret) { res.status(404).json({ error: "Return not found" }); return; }
  if (ret.status !== "draft") { res.status(400).json({ error: "Return is already confirmed" }); return; }
  if (!ret.warehouseId) {
    res.status(400).json({ error: "Return has no warehouse assigned; cannot reverse inventory" });
    return;
  }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(poReturnLinesTable).where(and(eq(poReturnLinesTable.returnId, id), eq(poReturnLinesTable.tenantId, tenantId))));

  const warehouseId = ret.warehouseId;

  // Defensive: resolve itemId from poLine for any lines already stored without it
  const rtvMissingItemIdPoLineIds = lines.filter((l) => !l.itemId && l.poLineId != null).map((l) => l.poLineId as number);
  const rtvPoLineItemMap = new Map<number, number>();
  if (rtvMissingItemIdPoLineIds.length > 0) {
    const rtvPoLineRows = await withTenantDb(tenantId, (db) =>
      db.select({ id: poLinesTable.id, itemId: poLinesTable.itemId }).from(poLinesTable).where(inArray(poLinesTable.id, rtvMissingItemIdPoLineIds)));
    for (const pl of rtvPoLineRows) { if (pl.itemId) rtvPoLineItemMap.set(pl.id, pl.itemId); }
  }
  // Helper to resolve itemId for a return line
  const resolveRtvItemId = (line: typeof lines[number]): number | null =>
    line.itemId ?? (line.poLineId != null ? rtvPoLineItemMap.get(line.poLineId) ?? null : null);

  // Quantity validation: each return line must not exceed available on-hand stock
  // in the same traceability bucket (warehouse + location + lot/batch/serial)
  for (const line of lines) {
    const resolvedItemId = resolveRtvItemId(line);
    if (!resolvedItemId || Number(line.quantity) <= 0) continue;
    const qty = Number(line.quantity);
    const lineLocId = line.locationId ?? null;
    const [stock] = await withTenantDb(tenantId, (db) =>
      db.select({ qtyOnHand: inventoryStockTable.qtyOnHand }).from(inventoryStockTable)
        .where(and(
          eq(inventoryStockTable.tenantId, tenantId),
          eq(inventoryStockTable.itemId, resolvedItemId),
          eq(inventoryStockTable.warehouseId, warehouseId),
          lineLocId ? eq(inventoryStockTable.locationId, lineLocId) : isNull(inventoryStockTable.locationId),
          line.lotNumber ? eq(inventoryStockTable.lotNumber, line.lotNumber) : isNull(inventoryStockTable.lotNumber),
          line.batchNumber ? eq(inventoryStockTable.batchNumber, line.batchNumber) : isNull(inventoryStockTable.batchNumber),
          line.serialNumber ? eq(inventoryStockTable.serialNumber, line.serialNumber) : isNull(inventoryStockTable.serialNumber),
        ))
        .limit(1));
    const available = Number(stock?.qtyOnHand ?? 0);
    if (qty > available) {
      res.status(400).json({
        error: `Return quantity ${qty} for item ${line.itemCode ?? resolvedItemId} exceeds available on-hand stock (${available}) in the specified traceability bucket.`,
      });
      return;
    }
  }

  // Fully atomic: inventory movements + stock decrements + status update + GL posting in one transaction
  const updated = await withTenantDb(tenantId, async (db) => {
    for (const line of lines) {
      const resolvedItemId = resolveRtvItemId(line);
      if (!resolvedItemId || Number(line.quantity) <= 0) continue;
      const qty = Number(line.quantity);
      const lineLocId = line.locationId ?? null;

      await db.insert(inventoryMovementsTable).values({
        tenantId,
        itemId: resolvedItemId,
        warehouseId,
        locationId: lineLocId ?? undefined,
        movementType: "return",
        quantity: (-qty).toFixed(4),
        unitCost: line.unitCost ?? undefined,
        refType: "po_return",
        refId: id,
        lotNumber: line.lotNumber ?? undefined,
        serialNumber: line.serialNumber ?? undefined,
        batchNumber: line.batchNumber ?? undefined,
        postedByClerkId: clerkUserId,
      } as typeof inventoryMovementsTable.$inferInsert);

      // Decrement stock in the exact bucket (warehouse + location + lot/batch/serial)
      const [stock] = await db.select().from(inventoryStockTable)
        .where(and(
          eq(inventoryStockTable.tenantId, tenantId),
          eq(inventoryStockTable.itemId, resolvedItemId),
          eq(inventoryStockTable.warehouseId, warehouseId),
          lineLocId ? eq(inventoryStockTable.locationId, lineLocId) : isNull(inventoryStockTable.locationId),
          line.lotNumber ? eq(inventoryStockTable.lotNumber, line.lotNumber) : isNull(inventoryStockTable.lotNumber),
          line.batchNumber ? eq(inventoryStockTable.batchNumber, line.batchNumber) : isNull(inventoryStockTable.batchNumber),
          line.serialNumber ? eq(inventoryStockTable.serialNumber, line.serialNumber) : isNull(inventoryStockTable.serialNumber),
        ))
        .limit(1);
      if (stock) {
        await db.update(inventoryStockTable)
          .set({ qtyOnHand: (Math.max(0, Number(stock.qtyOnHand) - qty)).toFixed(4), lastMovementAt: new Date() })
          .where(and(eq(inventoryStockTable.id, stock.id), eq(inventoryStockTable.tenantId, tenantId)));
      }
    }

    const [u] = await db.update(poReturnsTable)
      .set({ status: "confirmed" })
      .where(and(eq(poReturnsTable.id, id), eq(poReturnsTable.tenantId, tenantId)))
      .returning();

    // Post credit-note GL entry inside the same transaction
    await createReturnGlPostingInTx(db, tenantId, id, clerkUserId, userEmail);

    return u;
  });

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

  // Admins and global_admin see all pending items; approvers see only items on steps they can act on
  if (userRole === "tenant_admin" || userRole === "global_admin") {
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
      const hasRoleConstraint = roles.length > 0;
      const hasUserConstraint = userIds.length > 0;
      if (!hasRoleConstraint && !hasUserConstraint) return true; // open step — any approver-role user
      if (hasRoleConstraint && !hasUserConstraint) return roles.includes(userRole);
      if (!hasRoleConstraint && hasUserConstraint) return userIds.includes(clerkUserId);
      return roles.includes(userRole) || userIds.includes(clerkUserId); // both constraints: OR semantics
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

// Supplier performance — joins to suppliers master so the report shows the
// current canonical supplier name, falling back to the denormalized name on
// the PO when the supplier link is missing (legacy/free-text POs) or the
// supplier record has been deleted.
router.get("/procurement/reports/supplier-performance", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      supplierId: purchaseOrdersTable.supplierId,
      supplierName: sql<string | null>`coalesce(${suppliersTable.name}, ${purchaseOrdersTable.supplierName})`,
      supplierCode: suppliersTable.code,
      totalOrders: sql<number>`count(*)::int`,
      totalValue: sql<number>`sum(${purchaseOrdersTable.total})`,
      avgOrderValue: sql<number>`avg(${purchaseOrdersTable.total})`,
    })
      .from(purchaseOrdersTable)
      .leftJoin(
        suppliersTable,
        and(
          eq(suppliersTable.id, purchaseOrdersTable.supplierId),
          eq(suppliersTable.tenantId, tenantId),
        ),
      )
      .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
      .groupBy(purchaseOrdersTable.supplierId, suppliersTable.name, suppliersTable.code, purchaseOrdersTable.supplierName)
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

// ── GRN (Goods Received Note) Summary Report ──────────────────────────────────

/**
 * GET /procurement/reports/grn
 * Summarise confirmed goods receipts for a period.
 */
router.get("/procurement/reports/grn", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { from, to, supplierId } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        gr.id AS "id",
        gr.code AS "grnCode",
        po.code AS "poCode",
        po.supplier_name AS "supplierName",
        gr.status AS "status",
        gr.received_at AS "receivedAt",
        gr.received_by_email AS "receivedByEmail",
        COALESCE(SUM(rl.received_qty::numeric), 0) AS "totalReceivedQty",
        COALESCE(SUM(rl.received_qty::numeric * COALESCE(rl.unit_cost::numeric, 0)), 0) AS "totalValue",
        COUNT(DISTINCT rl.item_id) AS "lineCount"
      FROM po_receipts gr
      JOIN purchase_orders po ON po.id = gr.po_id AND po.tenant_id = ${tenantId}
      LEFT JOIN receipt_lines rl ON rl.receipt_id = gr.id AND rl.tenant_id = ${tenantId}
      WHERE gr.tenant_id = ${tenantId}
        AND gr.status = 'confirmed'
        ${from ? sql`AND gr.received_at >= ${new Date(from)}` : sql``}
        ${to ? sql`AND gr.received_at <= ${new Date(to)}` : sql``}
        ${supplierId ? sql`AND po.supplier_id = ${Number(supplierId)}` : sql``}
      GROUP BY gr.id, gr.code, po.code, po.supplier_name, gr.status, gr.received_at, gr.received_by_email
      ORDER BY gr.received_at DESC NULLS LAST
      LIMIT 500
    `)
  );

  res.json(qr.rows);
});

/**
 * GET /procurement/reports/grn/export/pdf
 * Export GRN summary as PDF.
 */
router.get("/procurement/reports/grn/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { from, to } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT gr.code AS "grnCode", po.code AS "poCode", po.supplier_name AS "supplierName",
             gr.received_at AS "receivedAt", gr.received_by_email AS "receivedByEmail",
             COALESCE(SUM(rl.received_qty::numeric), 0) AS "totalReceivedQty",
             COALESCE(SUM(rl.received_qty::numeric * COALESCE(rl.unit_cost::numeric, 0)), 0) AS "totalValue"
      FROM po_receipts gr
      JOIN purchase_orders po ON po.id = gr.po_id AND po.tenant_id = ${tenantId}
      LEFT JOIN receipt_lines rl ON rl.receipt_id = gr.id AND rl.tenant_id = ${tenantId}
      WHERE gr.tenant_id = ${tenantId} AND gr.status = 'confirmed'
        ${from ? sql`AND gr.received_at >= ${new Date(from)}` : sql``}
        ${to ? sql`AND gr.received_at <= ${new Date(to)}` : sql``}
      GROUP BY gr.id, gr.code, po.code, po.supplier_name, gr.received_at, gr.received_by_email
      ORDER BY gr.received_at DESC NULLS LAST LIMIT 2000
    `)
  );
  const rows = qr.rows as Array<{ grnCode: string; poCode: string; supplierName: string; receivedAt: string | null; receivedByEmail: string | null; totalReceivedQty: number; totalValue: number }>;

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="grn-report.pdf"`);
  doc.pipe(res);

  doc.fontSize(16).font("Helvetica-Bold").text("Goods Received Note Report", { align: "center" });
  doc.fontSize(9).font("Helvetica").text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.moveDown();

  const colX = [40, 110, 180, 310, 390, 470];
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("GRN Code", colX[0], doc.y, { continued: true })
     .text("PO Code", colX[1], undefined, { continued: true })
     .text("Supplier", colX[2], undefined, { continued: true })
     .text("Received At", colX[3], undefined, { continued: true })
     .text("Qty", colX[4], undefined, { continued: true })
     .text("Value", colX[5]);
  doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(7);
  for (const r of rows) {
    if (doc.y > 750) { doc.addPage(); }
    doc.text(r.grnCode, colX[0], doc.y, { continued: true })
       .text(r.poCode, colX[1], undefined, { continued: true })
       .text(r.supplierName, colX[2], undefined, { continued: true })
       .text(r.receivedAt ? new Date(r.receivedAt).toLocaleDateString() : "", colX[3], undefined, { continued: true })
       .text(Number(r.totalReceivedQty).toFixed(2), colX[4], undefined, { continued: true })
       .text(Number(r.totalValue).toFixed(2), colX[5]);
  }
  doc.end();
});

/**
 * GET /procurement/reports/grn/export/csv
 * Export GRN summary as CSV.
 */
router.get("/procurement/reports/grn/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { from, to } = req.query as Record<string, string>;

  const qr2 = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT gr.code AS "grnCode", po.code AS "poCode", po.supplier_name AS "supplierName",
             gr.received_at AS "receivedAt", gr.received_by_email AS "receivedByEmail",
             COALESCE(SUM(rl.received_qty::numeric), 0) AS "totalReceivedQty",
             COALESCE(SUM(rl.received_qty::numeric * COALESCE(rl.unit_cost::numeric, 0)), 0) AS "totalValue"
      FROM po_receipts gr
      JOIN purchase_orders po ON po.id = gr.po_id AND po.tenant_id = ${tenantId}
      LEFT JOIN receipt_lines rl ON rl.receipt_id = gr.id AND rl.tenant_id = ${tenantId}
      WHERE gr.tenant_id = ${tenantId} AND gr.status = 'confirmed'
        ${from ? sql`AND gr.received_at >= ${new Date(from)}` : sql``}
        ${to ? sql`AND gr.received_at <= ${new Date(to)}` : sql``}
      GROUP BY gr.id, gr.code, po.code, po.supplier_name, gr.received_at, gr.received_by_email
      ORDER BY gr.received_at DESC NULLS LAST LIMIT 5000
    `)
  );
  const rows = qr2.rows as Array<{ grnCode: string; poCode: string; supplierName: string; receivedAt: string | null; receivedByEmail: string | null; totalReceivedQty: number; totalValue: number }>;

  const escape = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    ["GRN Code", "PO Code", "Supplier", "Received At", "Received By", "Total Qty", "Total Value"].join(","),
    ...rows.map(r => [r.grnCode, r.poCode, r.supplierName, r.receivedAt ?? "", r.receivedByEmail ?? "", Number(r.totalReceivedQty).toFixed(2), Number(r.totalValue).toFixed(2)].map(escape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="grn-report.csv"`);
  res.send(lines.join("\r\n"));
});

/** PO Summary CSV Export */
router.get("/procurement/reports/po-summary/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
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

  const lines = ["Status,Count,Total Value"];
  for (const r of rows) {
    lines.push([r.status, r.count, Number(r.total ?? 0).toFixed(2)].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="po-summary.csv"`);
  res.send(lines.join("\n"));
});

/** PO Summary PDF Export */
router.get("/procurement/reports/po-summary/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
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

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="po-summary.pdf"`);
  doc.pipe(res);
  doc.fontSize(16).text("Purchase Order Summary", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [200, 100, 150];
  const headers = ["Status", "Count", "Total Value"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(9).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  const grandTotal = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [String(r.status), String(r.count), Number(r.total ?? 0).toFixed(2)].forEach((v, i) => {
      doc.fontSize(9).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.7);
  }
  doc.moveDown(0.3);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.2);
  doc.fontSize(9).font("Helvetica-Bold").text(`Grand Total: ${grandTotal.toFixed(2)}`, doc.page.margins.left);
  doc.end();
});

/** Supplier Performance CSV Export */
router.get("/procurement/reports/supplier-performance/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
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

  const lines = ["Supplier,Total Orders,Total Value,Avg Order Value"];
  for (const r of rows) {
    lines.push([`"${r.supplierName ?? ""}"`, r.totalOrders, Number(r.totalValue ?? 0).toFixed(2), Number(r.avgOrderValue ?? 0).toFixed(2)].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="supplier-performance.csv"`);
  res.send(lines.join("\n"));
});

/** Supplier Performance PDF Export */
router.get("/procurement/reports/supplier-performance/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
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

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="supplier-performance.pdf"`);
  doc.pipe(res);
  doc.fontSize(16).text("Supplier Performance Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [200, 80, 110, 110];
  const headers = ["Supplier", "Orders", "Total Value", "Avg Order"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(9).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [String(r.supplierName ?? "").slice(0, 35), String(r.totalOrders), Number(r.totalValue ?? 0).toFixed(2), Number(r.avgOrderValue ?? 0).toFixed(2)].forEach((v, i) => {
      doc.fontSize(9).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.7);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** Goods in Transit CSV Export */
router.get("/procurement/reports/goods-in-transit/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { supplierId, from, to } = req.query as Record<string, string>;
  const pos = await withTenantDb(tenantId, (db) =>
    db.select({
      code: purchaseOrdersTable.code,
      supplierName: purchaseOrdersTable.supplierName,
      status: purchaseOrdersTable.status,
      total: purchaseOrdersTable.total,
      currencyCode: purchaseOrdersTable.currencyCode,
      deliveryDate: purchaseOrdersTable.deliveryDate,
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
      .orderBy(asc(purchaseOrdersTable.deliveryDate))
  );

  const lines = ["PO Code,Supplier,Status,Total,Currency,Expected Delivery"];
  for (const r of pos) {
    lines.push([r.code, `"${r.supplierName ?? ""}"`, r.status, Number(r.total ?? 0).toFixed(2), r.currencyCode ?? "", r.deliveryDate ? String(r.deliveryDate).split("T")[0] : ""].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="goods-in-transit.csv"`);
  res.send(lines.join("\n"));
});

/** Goods in Transit PDF Export */
router.get("/procurement/reports/goods-in-transit/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { supplierId, from, to } = req.query as Record<string, string>;
  const pos = await withTenantDb(tenantId, (db) =>
    db.select({
      code: purchaseOrdersTable.code,
      supplierName: purchaseOrdersTable.supplierName,
      status: purchaseOrdersTable.status,
      total: purchaseOrdersTable.total,
      currencyCode: purchaseOrdersTable.currencyCode,
      deliveryDate: purchaseOrdersTable.deliveryDate,
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
      .orderBy(asc(purchaseOrdersTable.deliveryDate))
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="goods-in-transit.pdf"`);
  doc.pipe(res);
  doc.fontSize(16).text("Goods In Transit Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [80, 160, 100, 80, 70, 90];
  const headers = ["PO Code", "Supplier", "Status", "Total", "Currency", "Delivery"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(8).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of pos) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [r.code, String(r.supplierName ?? "").slice(0, 28), r.status, Number(r.total ?? 0).toFixed(2), r.currencyCode ?? "", r.deliveryDate ? String(r.deliveryDate).split("T")[0] : ""].forEach((v, i) => {
      doc.fontSize(8).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** PO Aging report — open POs grouped by delivery-date age buckets */
router.get("/procurement/reports/po-aging", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { supplierId } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT po.id, po.code, po.supplier_name AS "supplierName", po.status,
             po.total::numeric AS "total", po.delivery_date AS "deliveryDate",
             CASE WHEN po.delivery_date IS NULL THEN NULL
                  ELSE (CURRENT_DATE - po.delivery_date::date)::int END AS "daysOverdue",
             CASE
               WHEN po.delivery_date IS NULL OR po.delivery_date::date >= CURRENT_DATE THEN 'current'
               WHEN CURRENT_DATE - po.delivery_date::date <= 30 THEN '1_to_30'
               WHEN CURRENT_DATE - po.delivery_date::date <= 60 THEN '31_to_60'
               WHEN CURRENT_DATE - po.delivery_date::date <= 90 THEN '61_to_90'
               ELSE 'over_90'
             END AS "agingBucket"
      FROM purchase_orders po
      WHERE po.tenant_id = ${tenantId}
        AND po.deleted_at IS NULL
        AND po.status IN ('approved', 'sent', 'receiving', 'partially_received')
        ${supplierId ? sql`AND po.supplier_id = ${Number(supplierId)}` : sql``}
      ORDER BY po.delivery_date ASC NULLS LAST
      LIMIT 5000
    `)
  );
  const rows = qr.rows as Array<{ id: number; code: string; supplierName: string | null; status: string; total: number; deliveryDate: string | null; daysOverdue: number | null; agingBucket: string }>;

  const summary: Record<string, { count: number; total: number }> = {};
  for (const r of rows) {
    const b = r.agingBucket;
    if (!summary[b]) summary[b] = { count: 0, total: 0 };
    summary[b].count += 1;
    summary[b].total += Number(r.total ?? 0);
  }

  res.json({ rows, summary });
});

/** PO Aging CSV Export */
router.get("/procurement/reports/po-aging/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { supplierId } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT po.code, po.supplier_name AS "supplierName", po.status,
             po.total::numeric AS "total", po.delivery_date AS "deliveryDate",
             CASE WHEN po.delivery_date IS NULL THEN NULL
                  ELSE (CURRENT_DATE - po.delivery_date::date)::int END AS "daysOverdue",
             CASE
               WHEN po.delivery_date IS NULL OR po.delivery_date::date >= CURRENT_DATE THEN 'Current'
               WHEN CURRENT_DATE - po.delivery_date::date <= 30 THEN '1-30 Days'
               WHEN CURRENT_DATE - po.delivery_date::date <= 60 THEN '31-60 Days'
               WHEN CURRENT_DATE - po.delivery_date::date <= 90 THEN '61-90 Days'
               ELSE '90+ Days'
             END AS "agingBucket"
      FROM purchase_orders po
      WHERE po.tenant_id = ${tenantId}
        AND po.deleted_at IS NULL
        AND po.status IN ('approved', 'sent', 'receiving', 'partially_received')
        ${supplierId ? sql`AND po.supplier_id = ${Number(supplierId)}` : sql``}
      ORDER BY po.delivery_date ASC NULLS LAST
      LIMIT 5000
    `)
  );
  const rows = qr.rows as Array<{ code: string; supplierName: string | null; status: string; total: number; deliveryDate: string | null; daysOverdue: number | null; agingBucket: string }>;

  const escape = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    ["PO Code", "Supplier", "Status", "Total", "Delivery Date", "Days Overdue", "Aging Bucket"].join(","),
    ...rows.map(r => [r.code, r.supplierName ?? "", r.status, Number(r.total ?? 0).toFixed(2), r.deliveryDate ? String(r.deliveryDate).split("T")[0] : "", r.daysOverdue ?? 0, r.agingBucket].map(escape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="po-aging.csv"`);
  res.send(lines.join("\r\n"));
});

export default router;

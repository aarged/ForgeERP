import { Router, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import { eq, and, isNull, desc, sql, or, ilike, asc, gt, inArray, ne } from "drizzle-orm";
import {
  inventoryStockTable,
  inventoryMovementsTable,
  itemsTable,
  warehousesTable,
  warehouseLocationsTable,
  glAccountsTable,
  costLayersTable,
  lotNumbersTable,
  inventoryAdjustmentsTable,
  inventoryAdjustmentLinesTable,
  stocktakeRunsTable,
  stocktakeLinesTable,
  cycleCountTasksTable,
  cycleCountLinesTable,
  landedCostAllocationsTable,
  serialNumbersTable,
  inventoryTransfersTable,
  glPostingsTable,
  poLinesTable,
  purchaseOrdersTable,
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
import { z } from "zod";
import { logger } from "../lib/logger";

const router = Router();
const tenantUserMiddleware = [requireAuth, tenantContext] as const;
const tenantWriteMiddleware = [
  requireAuth,
  tenantContext,
  requireRole("tenant_admin", "warehouse", "purchaser", "approver", "accountant"),
] as const;

// ── Helper: generate code ─────────────────────────────────────────────────────
function genCode(prefix: string, id: number) { return `${prefix}-${String(id).padStart(5, "0")}`; }

// ── Helper: create GL posting for an inventory movement ───────────────────────
async function createInventoryGlPosting(
  db: TenantDb,
  tenantId: number,
  entityType: string,
  entityId: number,
  entityCode: string,
  clerkUserId: string,
  userEmail: string | undefined,
  lines: Array<{ accountId?: number; accountCode: string; accountName: string; debit: number; credit: number; description: string }>,
): Promise<number | null> {
  if (lines.length === 0) return null;
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  const [posting] = await db.insert(glPostingsTable).values({
    tenantId,
    code: "GLP-PENDING",
    entityType,
    entityId,
    status: "posted",
    postedByClerkId: clerkUserId,
    postedByEmail: userEmail ?? undefined,
    postedAt: new Date(),
    notes: `Auto-posted for ${entityCode}`,
    lines: lines as unknown as typeof glPostingsTable.$inferInsert["lines"],
    totalDebit: String(totalDebit.toFixed(2)),
    totalCredit: String(totalCredit.toFixed(2)),
  } as typeof glPostingsTable.$inferInsert).returning();
  await db.update(glPostingsTable).set({ code: genCode("GLP", posting.id) }).where(eq(glPostingsTable.id, posting.id));
  return posting.id;
}

// ── Helper: update inventory stock atomically (costing-method aware) ──────────
async function updateStockLevel(
  db: TenantDb,
  tenantId: number,
  itemId: number,
  warehouseId: number,
  locationId: number | null,
  quantity: number, // positive = in, negative = out
  unitCost: number | null,
  lotNumber: string | null,
  movementId: number,
  costingMethod: "fifo" | "avco" | "standard" = "avco",
): Promise<{ computedUnitCost: number | null }> {
  // Find existing stock bucket or create one
  const existing = await db.select()
    .from(inventoryStockTable)
    .where(and(
      eq(inventoryStockTable.tenantId, tenantId),
      eq(inventoryStockTable.itemId, itemId),
      eq(inventoryStockTable.warehouseId, warehouseId),
      locationId ? eq(inventoryStockTable.locationId, locationId) : isNull(inventoryStockTable.locationId),
      lotNumber ? eq(inventoryStockTable.lotNumber, lotNumber) : isNull(inventoryStockTable.lotNumber),
    ))
    .limit(1);

  const qty = quantity.toFixed(4);
  // Capture AVCO cost BEFORE updating (used for outbound cost reporting)
  const avcoCostBefore = existing[0]?.averageCost ? Number(existing[0].averageCost) : null;

  // Cost calculation branched by method
  let newAvgCost: string | undefined = undefined;
  if (quantity > 0 && unitCost !== null) {
    if (costingMethod === "fifo") {
      // FIFO: don't update average cost; use existing as-is (FIFO pulls from layers on outbound)
      newAvgCost = existing[0]?.averageCost ?? String(unitCost);
    } else if (costingMethod === "standard") {
      // Standard cost: keep the item master cost, ignore receipt cost
      newAvgCost = existing[0]?.averageCost ?? String(unitCost);
    } else {
      // AVCO (weighted average): re-compute rolling average on each inbound
      const prevQty = Number(existing[0]?.qtyOnHand ?? 0);
      const prevCost = Number(existing[0]?.averageCost ?? unitCost);
      const newAvg = prevQty + quantity > 0
        ? (prevQty * prevCost + quantity * unitCost) / (prevQty + quantity)
        : unitCost;
      newAvgCost = newAvg.toFixed(4);
    }
  }

  if (existing.length > 0) {
    // Hard-fail on over-consumption: do not silently clamp to zero
    if (quantity < 0 && Number(existing[0].qtyOnHand) + quantity < -0.0001) {
      throw new Error(
        `Insufficient stock for item ${itemId} in warehouse ${warehouseId}${locationId ? `/loc:${locationId}` : ""}${lotNumber ? `/lot:${lotNumber}` : ""}: available ${Number(existing[0].qtyOnHand).toFixed(4)}, requested ${Math.abs(quantity).toFixed(4)}`
      );
    }
    await db.update(inventoryStockTable)
      .set({
        qtyOnHand: sql`${inventoryStockTable.qtyOnHand} + ${qty}::numeric`,
        ...(newAvgCost !== undefined ? { averageCost: newAvgCost } : {}),
        lastMovementAt: new Date(),
      })
      .where(eq(inventoryStockTable.id, existing[0].id));
  } else if (quantity > 0) {
    await db.insert(inventoryStockTable).values({
      tenantId, itemId, warehouseId,
      locationId: locationId ?? undefined,
      lotNumber: lotNumber ?? undefined,
      qtyOnHand: qty,
      qtyReserved: "0",
      averageCost: unitCost != null ? String(unitCost) : undefined,
      lastMovementAt: new Date(),
    } as typeof inventoryStockTable.$inferInsert);
  } else {
    // quantity < 0 but no stock bucket exists at all — hard-fail
    throw new Error(
      `No stock bucket for item ${itemId} in warehouse ${warehouseId}${locationId ? `/loc:${locationId}` : ""}${lotNumber ? `/lot:${lotNumber}` : ""}: cannot consume from non-existent stock`
    );
  }

  // Maintain FIFO cost layers for inbound (all methods track layers; FIFO consumes them on outbound)
  if (quantity > 0 && unitCost !== null) {
    await db.insert(costLayersTable).values({
      tenantId, itemId, warehouseId,
      locationId: locationId ?? undefined,
      lotNumber: lotNumber ?? undefined,
      qtyOriginal: qty,
      qtyRemaining: qty,
      unitCost: String(unitCost),
      movementId,
      receivedAt: new Date(),
    } as typeof costLayersTable.$inferInsert);
  }

  // FIFO outbound: consume oldest cost layers first; compute weighted-average cost of consumed qty
  let fifoComputedCost: number | null = null;
  if (quantity < 0 && costingMethod === "fifo") {
    let remaining = Math.abs(quantity);
    let totalCostConsumed = 0;
    let totalQtyConsumed = 0;
    const layers = await db.select()
      .from(costLayersTable)
      .where(and(
        eq(costLayersTable.tenantId, tenantId),
        eq(costLayersTable.itemId, itemId),
        eq(costLayersTable.warehouseId, warehouseId),
        locationId ? eq(costLayersTable.locationId, locationId) : isNull(costLayersTable.locationId),
        lotNumber ? eq(costLayersTable.lotNumber, lotNumber) : isNull(costLayersTable.lotNumber),
        gt(costLayersTable.qtyRemaining, "0"),
      ))
      .orderBy(asc(costLayersTable.receivedAt));
    for (const layer of layers) {
      if (remaining <= 0) break;
      const consume = Math.min(remaining, Number(layer.qtyRemaining));
      const newRemaining = Number(layer.qtyRemaining) - consume;
      totalCostConsumed += consume * Number(layer.unitCost);
      totalQtyConsumed += consume;
      await db.update(costLayersTable)
        .set({ qtyRemaining: newRemaining.toFixed(4) })
        .where(eq(costLayersTable.id, layer.id));
      remaining -= consume;
    }
    if (totalQtyConsumed > 0) fifoComputedCost = totalCostConsumed / totalQtyConsumed;
  }

  // Update lot number on-hand qty
  if (lotNumber) {
    const existingLot = await db.select().from(lotNumbersTable)
      .where(and(eq(lotNumbersTable.tenantId, tenantId), eq(lotNumbersTable.itemId, itemId), eq(lotNumbersTable.lotNumber, lotNumber)))
      .limit(1);
    if (existingLot.length > 0) {
      await db.update(lotNumbersTable)
        .set({ qtyOnHand: sql`${lotNumbersTable.qtyOnHand} + ${qty}::numeric` })
        .where(eq(lotNumbersTable.id, existingLot[0].id));
    } else if (quantity > 0) {
      await db.insert(lotNumbersTable).values({
        tenantId, itemId, lotNumber,
        qtyReceived: qty, qtyOnHand: qty,
        status: "active",
      } as typeof lotNumbersTable.$inferInsert);
    }
  }

  // Determine effective unit cost for caller's GL use
  let computedUnitCost: number | null = null;
  if (quantity > 0) {
    computedUnitCost = unitCost; // Inbound: use provided cost
    if (computedUnitCost == null && costingMethod === "standard") {
      const [stdItem] = await db.select({ unitCost: itemsTable.unitCost })
        .from(itemsTable).where(and(eq(itemsTable.id, itemId), eq(itemsTable.tenantId, tenantId))).limit(1);
      computedUnitCost = stdItem?.unitCost != null ? Number(stdItem.unitCost) : 0;
    }
  } else if (costingMethod === "fifo") {
    computedUnitCost = fifoComputedCost; // FIFO: weighted avg of consumed layers
  } else if (costingMethod === "avco") {
    computedUnitCost = avcoCostBefore; // AVCO: cost at time of outbound
  } else {
    // Standard outbound: caller may supply, else look up item standard cost (fallback 0)
    if (unitCost != null) {
      computedUnitCost = unitCost;
    } else {
      const [stdItem] = await db.select({ unitCost: itemsTable.unitCost })
        .from(itemsTable).where(and(eq(itemsTable.id, itemId), eq(itemsTable.tenantId, tenantId))).limit(1);
      computedUnitCost = stdItem?.unitCost != null ? Number(stdItem.unitCost) : 0;
    }
  }

  return { computedUnitCost };
}

// ── Helper: look up default inventory asset GL account for a tenant ────────────
async function lookupInventoryGlAccount(db: TenantDb, tenantId: number) {
  const [byName] = await db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name })
    .from(glAccountsTable)
    .where(and(eq(glAccountsTable.tenantId, tenantId), eq(glAccountsTable.accountType, "asset"), ilike(glAccountsTable.name, "%inventor%")))
    .limit(1);
  if (byName) return byName;
  const [byType] = await db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name })
    .from(glAccountsTable)
    .where(and(eq(glAccountsTable.tenantId, tenantId), eq(glAccountsTable.accountType, "asset")))
    .orderBy(asc(glAccountsTable.code))
    .limit(1);
  return byType ?? null;
}

// ── Helper: track serial number state on movement ─────────────────────────────
async function trackSerialNumber(
  db: TenantDb,
  tenantId: number,
  serialNumber: string,
  itemId: number,
  warehouseId: number,
  locationId: number | null,
  movementId: number,
  direction: "inbound" | "outbound",
) {
  const [existing] = await db.select().from(serialNumbersTable)
    .where(and(eq(serialNumbersTable.tenantId, tenantId), eq(serialNumbersTable.itemId, itemId), eq(serialNumbersTable.serialNumber, serialNumber)))
    .limit(1);

  if (direction === "inbound") {
    if (existing) {
      await db.update(serialNumbersTable)
        .set({ status: "available", warehouseId, locationId: locationId ?? undefined, inboundMovementId: movementId, updatedAt: new Date() })
        .where(eq(serialNumbersTable.id, existing.id));
    } else {
      await db.insert(serialNumbersTable).values({
        tenantId, itemId, serialNumber, warehouseId,
        locationId: locationId ?? undefined,
        status: "available",
        inboundMovementId: movementId,
      } as typeof serialNumbersTable.$inferInsert);
    }
  } else {
    if (existing) {
      await db.update(serialNumbersTable)
        .set({ status: "sold", outboundMovementId: movementId, updatedAt: new Date() })
        .where(eq(serialNumbersTable.id, existing.id));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Stock Visibility ──────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Multi-warehouse stock dashboard */
router.get("/inventory/stock", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, locationId, itemId, category, search, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryStockTable.id,
      itemId: inventoryStockTable.itemId,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      category: itemsTable.category,
      warehouseId: inventoryStockTable.warehouseId,
      warehouseName: warehousesTable.name,
      locationId: inventoryStockTable.locationId,
      locationCode: warehouseLocationsTable.code,
      locationName: warehouseLocationsTable.name,
      lotNumber: inventoryStockTable.lotNumber,
      serialNumber: inventoryStockTable.serialNumber,
      batchNumber: inventoryStockTable.batchNumber,
      expiryDate: inventoryStockTable.expiryDate,
      qtyOnHand: inventoryStockTable.qtyOnHand,
      qtyReserved: inventoryStockTable.qtyReserved,
      qtyAvailable: sql<string>`${inventoryStockTable.qtyOnHand} - ${inventoryStockTable.qtyReserved}`,
      averageCost: inventoryStockTable.averageCost,
      stockValue: sql<string>`CASE
        WHEN ${itemsTable.costingMethod} = 'fifo' THEN COALESCE((
          SELECT SUM(cl.qty_remaining::numeric * cl.unit_cost::numeric)
          FROM cost_layers cl
          WHERE cl.tenant_id = ${inventoryStockTable.tenantId}
            AND cl.item_id = ${inventoryStockTable.itemId}
            AND cl.warehouse_id = ${inventoryStockTable.warehouseId}
            AND (cl.location_id IS NULL AND ${inventoryStockTable.locationId} IS NULL OR cl.location_id = ${inventoryStockTable.locationId})
            AND (cl.lot_number IS NULL AND ${inventoryStockTable.lotNumber} IS NULL OR cl.lot_number = ${inventoryStockTable.lotNumber})
        ), 0)
        WHEN ${itemsTable.costingMethod} = 'standard' THEN ${inventoryStockTable.qtyOnHand}::numeric * COALESCE(${itemsTable.unitCost}::numeric, 0)
        ELSE ${inventoryStockTable.qtyOnHand}::numeric * COALESCE(${inventoryStockTable.averageCost}::numeric, ${itemsTable.unitCost}::numeric, 0)
      END`,
      lastMovementAt: inventoryStockTable.lastMovementAt,
    })
    .from(inventoryStockTable)
    .innerJoin(itemsTable, eq(itemsTable.id, inventoryStockTable.itemId))
    .innerJoin(warehousesTable, eq(warehousesTable.id, inventoryStockTable.warehouseId))
    .leftJoin(warehouseLocationsTable, eq(warehouseLocationsTable.id, inventoryStockTable.locationId))
    .where(and(
      eq(inventoryStockTable.tenantId, tenantId),
      isNull(itemsTable.deletedAt),
      warehouseId ? eq(inventoryStockTable.warehouseId, Number(warehouseId)) : undefined,
      locationId ? eq(inventoryStockTable.locationId, Number(locationId)) : undefined,
      itemId ? eq(inventoryStockTable.itemId, Number(itemId)) : undefined,
      category ? eq(itemsTable.category, category) : undefined,
      search ? or(ilike(itemsTable.code, `%${search}%`), ilike(itemsTable.name, `%${search}%`)) : undefined,
    ))
    .orderBy(itemsTable.code, warehousesTable.name)
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim).map((r) => ({ ...r, qtyOnHand: Number(r.qtyOnHand), qtyReserved: Number(r.qtyReserved), qtyAvailable: Number(r.qtyAvailable), stockValue: Number(r.stockValue) })), hasMore, page: pg });
});

/** Item availability summary — on-hand, reserved, available, on-order, in-transit */
router.get("/inventory/stock/:itemId", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const itemId = Number(req.params.itemId);
  const { warehouseId } = req.query as Record<string, string>;

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select().from(itemsTable)
      .where(and(eq(itemsTable.id, itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }

  const [stockRows, onOrderRows, inTransitRows] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({
        warehouseId: inventoryStockTable.warehouseId,
        warehouseName: warehousesTable.name,
        qtyOnHand: sql<string>`coalesce(sum(${inventoryStockTable.qtyOnHand}),0)`,
        qtyReserved: sql<string>`coalesce(sum(${inventoryStockTable.qtyReserved}),0)`,
      })
      .from(inventoryStockTable)
      .innerJoin(warehousesTable, eq(warehousesTable.id, inventoryStockTable.warehouseId))
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        eq(inventoryStockTable.itemId, itemId),
        warehouseId ? eq(inventoryStockTable.warehouseId, Number(warehouseId)) : undefined,
      ))
      .groupBy(inventoryStockTable.warehouseId, warehousesTable.name)),
    // On-order: qty on open/approved PO lines for this item
    withTenantDb(tenantId, (db) =>
      db.select({ qty: sql<string>`coalesce(sum(${poLinesTable.quantity} - ${poLinesTable.receivedQty}),0)` })
        .from(poLinesTable)
        .innerJoin(purchaseOrdersTable, eq(purchaseOrdersTable.id, poLinesTable.poId))
        .where(and(
          eq(purchaseOrdersTable.tenantId, tenantId),
          eq(poLinesTable.itemId, itemId),
          inArray(purchaseOrdersTable.status, ["approved", "sent", "partial"]),
        ))),
    // In-transit: qty from transfers dispatched but not yet received
    withTenantDb(tenantId, (db) =>
      db.select({ qty: sql<string>`coalesce(sum(${inventoryTransfersTable.quantity}),0)` })
        .from(inventoryTransfersTable)
        .where(and(
          eq(inventoryTransfersTable.tenantId, tenantId),
          eq(inventoryTransfersTable.itemId, itemId),
          inArray(inventoryTransfersTable.status, ["pending", "in_transit"]),
        ))),
  ]);

  const totalOnHand = stockRows.reduce((s, r) => s + Number(r.qtyOnHand), 0);
  const totalReserved = stockRows.reduce((s, r) => s + Number(r.qtyReserved), 0);
  const totalOnOrder = Number(onOrderRows[0]?.qty ?? 0);
  const totalInTransit = Number(inTransitRows[0]?.qty ?? 0);

  res.json({
    item: { id: item.id, code: item.code, name: item.name, unitCost: item.unitCost, costingMethod: item.costingMethod },
    totalOnHand, totalReserved,
    totalAvailable: totalOnHand - totalReserved,
    totalOnOrder,
    totalInTransit,
    byWarehouse: stockRows.map((r) => ({
      ...r,
      qtyOnHand: Number(r.qtyOnHand),
      qtyReserved: Number(r.qtyReserved),
      qtyAvailable: Number(r.qtyOnHand) - Number(r.qtyReserved),
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Movement Log ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/movements", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, itemId, movementType, fromDate, toDate, search, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryMovementsTable.id,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      unitCost: inventoryMovementsTable.unitCost,
      itemId: inventoryMovementsTable.itemId,
      itemCode: inventoryMovementsTable.itemCode,
      itemName: inventoryMovementsTable.itemName,
      warehouseId: inventoryMovementsTable.warehouseId,
      warehouseName: warehousesTable.name,
      locationId: inventoryMovementsTable.locationId,
      toWarehouseId: inventoryMovementsTable.toWarehouseId,
      toLocationId: inventoryMovementsTable.toLocationId,
      refType: inventoryMovementsTable.refType,
      refId: inventoryMovementsTable.refId,
      refCode: inventoryMovementsTable.refCode,
      lotNumber: inventoryMovementsTable.lotNumber,
      adjReason: inventoryMovementsTable.adjReason,
      notes: inventoryMovementsTable.notes,
      postedByClerkId: inventoryMovementsTable.postedByClerkId,
      postedByEmail: inventoryMovementsTable.postedByEmail,
      glPostingId: inventoryMovementsTable.glPostingId,
      createdAt: inventoryMovementsTable.createdAt,
    })
    .from(inventoryMovementsTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, inventoryMovementsTable.warehouseId))
    .where(and(
      eq(inventoryMovementsTable.tenantId, tenantId),
      warehouseId ? eq(inventoryMovementsTable.warehouseId, Number(warehouseId)) : undefined,
      itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
      movementType ? eq(inventoryMovementsTable.movementType, movementType) : undefined,
      fromDate ? sql`${inventoryMovementsTable.createdAt}::date >= ${fromDate}` : undefined,
      toDate ? sql`${inventoryMovementsTable.createdAt}::date <= ${toDate}` : undefined,
      search ? or(ilike(inventoryMovementsTable.itemCode, `%${search}%`), ilike(inventoryMovementsTable.itemName, `%${search}%`), ilike(inventoryMovementsTable.refCode, `%${search}%`)) : undefined,
    ))
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim).map((r) => ({ ...r, quantity: Number(r.quantity) })), hasMore, page: pg });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Manual Adjustment ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const adjustmentLineSchema = z.object({
  itemId: z.number().int().positive(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  lotNumber: z.string().optional(),
  qtyAdjusted: z.number(), // positive = increase, negative = decrease
  unitCost: z.number().optional(),
});

const createAdjustmentSchema = z.object({
  adjustmentType: z.enum(["increase", "decrease", "recount"]).default("increase"),
  reason: z.string().min(1),
  glAccountId: z.number().int().positive({ message: "A GL account is required for stock adjustments" }),
  glAccountCode: z.string().optional(),
  glAccountName: z.string().optional(),
  warehouseId: z.number().int().optional(),
  notes: z.string().optional(),
  lines: z.array(adjustmentLineSchema).min(1),
});

router.post("/inventory/adjust", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = createAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn({ tenantId, body: req.body, issues: parsed.error.issues }, "[adjust] validation failed");
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }

  const result = await withTenantDb(tenantId, async (db) => {
    // Create adjustment document header
    const [adj] = await db.insert(inventoryAdjustmentsTable).values({
      tenantId, code: "ADJ-PENDING",
      adjustmentType: parsed.data.adjustmentType,
      reason: parsed.data.reason,
      glAccountId: parsed.data.glAccountId ?? undefined,
      glAccountCode: parsed.data.glAccountCode ?? undefined,
      glAccountName: parsed.data.glAccountName ?? undefined,
      warehouseId: parsed.data.warehouseId ?? undefined,
      status: "posted",
      postedAt: new Date(),
      postedByClerkId: clerkUserId,
      postedByEmail: userEmail ?? undefined,
      notes: parsed.data.notes ?? undefined,
    } as typeof inventoryAdjustmentsTable.$inferInsert).returning();

    const adjCode = genCode("ADJ", adj.id);
    await db.update(inventoryAdjustmentsTable).set({ code: adjCode }).where(eq(inventoryAdjustmentsTable.id, adj.id));

    // Resolve GL adjustment account
    const glAcc = parsed.data.glAccountId
      ? (await db.select({ code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, parsed.data.glAccountId), eq(glAccountsTable.tenantId, tenantId))).limit(1))[0]
      : null;

    // Resolve tenant's configured inventory asset account (shared lookup)
    const invGlAcc = await lookupInventoryGlAccount(db, tenantId);

    // Process each line with costing-method awareness
    const lineIds: number[] = [];
    const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

    for (const line of parsed.data.lines) {
      const [item] = await db.select({ code: itemsTable.code, name: itemsTable.name, costingMethod: itemsTable.costingMethod })
        .from(itemsTable).where(and(eq(itemsTable.id, line.itemId), eq(itemsTable.tenantId, tenantId))).limit(1);
      const costingMethod = (item?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

      const [movement] = await db.insert(inventoryMovementsTable).values({
        tenantId,
        itemId: line.itemId,
        itemCode: line.itemCode ?? item?.code,
        itemName: line.itemName ?? item?.name,
        warehouseId: line.warehouseId,
        locationId: line.locationId ?? undefined,
        movementType: "adjustment",
        quantity: String(line.qtyAdjusted),
        unitCost: line.unitCost != null ? String(line.unitCost) : undefined,
        adjReason: parsed.data.reason,
        refType: "adjustment",
        refId: adj.id,
        refCode: adjCode,
        lotNumber: line.lotNumber ?? undefined,
        postedByClerkId: clerkUserId,
        postedByEmail: userEmail ?? undefined,
        notes: parsed.data.notes ?? undefined,
      } as typeof inventoryMovementsTable.$inferInsert).returning();

      await updateStockLevel(db, tenantId, line.itemId, line.warehouseId, line.locationId ?? null, line.qtyAdjusted, line.unitCost ?? null, line.lotNumber ?? null, movement.id, costingMethod);

      const [adjLine] = await db.insert(inventoryAdjustmentLinesTable).values({
        tenantId, adjustmentId: adj.id,
        itemId: line.itemId,
        itemCode: line.itemCode ?? item?.code,
        itemName: line.itemName ?? item?.name,
        warehouseId: line.warehouseId,
        locationId: line.locationId ?? undefined,
        lotNumber: line.lotNumber ?? undefined,
        qtyAdjusted: String(line.qtyAdjusted),
        unitCost: line.unitCost != null ? String(line.unitCost) : undefined,
        movementId: movement.id,
      } as typeof inventoryAdjustmentLinesTable.$inferInsert).returning();
      lineIds.push(adjLine.id);

      // Accumulate GL lines: stock account Dr/Cr, adjustment account as offset
      if (glAcc && invGlAcc && line.unitCost) {
        const value = Math.abs(line.qtyAdjusted * line.unitCost);
        const isIncrease = line.qtyAdjusted > 0;
        glLines.push({
          accountCode: invGlAcc.code, accountName: invGlAcc.name,
          debit: isIncrease ? value : 0,
          credit: isIncrease ? 0 : value,
          description: `${item?.code ?? "Item"} qty adj ${line.qtyAdjusted}`,
        });
        glLines.push({
          accountCode: glAcc.code, accountName: glAcc.name,
          debit: isIncrease ? 0 : value,
          credit: isIncrease ? value : 0,
          description: parsed.data.reason,
        });
      }
    }

    // Create GL posting for the entire adjustment document
    let glPostingId: number | null = null;
    if (glLines.length > 0) {
      glPostingId = await createInventoryGlPosting(db, tenantId, "inventory_adjustment", adj.id, adjCode, clerkUserId, userEmail, glLines);
      if (glPostingId) {
        await db.update(inventoryAdjustmentsTable).set({ glPostingId }).where(eq(inventoryAdjustmentsTable.id, adj.id));
      }
    }

    return { adjId: adj.id, lineCount: lineIds.length, glPostingId };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.adjusted", entityType: "inventory_adjustment", entityId: String(result.adjId), newValues: { lines: result.lineCount } });
  res.status(201).json({ id: result.adjId, code: genCode("ADJ", result.adjId), lines: result.lineCount, glPostingId: result.glPostingId });
});

// List adjustments
router.get("/inventory/adjustments", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(inventoryAdjustmentsTable)
      .where(and(
        eq(inventoryAdjustmentsTable.tenantId, tenantId),
        isNull(inventoryAdjustmentsTable.deletedAt),
        warehouseId ? eq(inventoryAdjustmentsTable.warehouseId, Number(warehouseId)) : undefined,
        status ? eq(inventoryAdjustmentsTable.status, status) : undefined,
      ))
      .orderBy(desc(inventoryAdjustmentsTable.createdAt))
      .limit(lim + 1).offset((pg - 1) * lim));
  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/inventory/adjustments/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [adj] = await withTenantDb(tenantId, (db) =>
    db.select().from(inventoryAdjustmentsTable)
      .where(and(eq(inventoryAdjustmentsTable.id, id), eq(inventoryAdjustmentsTable.tenantId, tenantId))).limit(1));
  if (!adj) { res.status(404).json({ error: "Adjustment not found" }); return; }
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(inventoryAdjustmentLinesTable)
      .where(and(eq(inventoryAdjustmentLinesTable.adjustmentId, id), eq(inventoryAdjustmentLinesTable.tenantId, tenantId))));
  res.json({ ...adj, lines });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Inter-Warehouse / Inter-Location Transfer ─────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const transferSchema = z.object({
  itemId: z.number().int().positive(),
  fromWarehouseId: z.number().int().positive(),
  fromLocationId: z.number().int().optional(),
  toWarehouseId: z.number().int().positive(),
  toLocationId: z.number().int().optional(),
  quantity: z.number().positive(),
  lotNumber: z.string().optional(),
  unitCost: z.number().optional(),
  glAccountId: z.number().int().optional(),
  notes: z.string().optional(),
});

/** Create a transfer request — goods leave source immediately (in_transit state) */
router.post("/inventory/transfer", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const d = parsed.data;
  // Validate source stock
  const [sourceStock] = await withTenantDb(tenantId, (db) =>
    db.select({ qtyOnHand: inventoryStockTable.qtyOnHand, qtyReserved: inventoryStockTable.qtyReserved })
      .from(inventoryStockTable)
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        eq(inventoryStockTable.itemId, d.itemId),
        eq(inventoryStockTable.warehouseId, d.fromWarehouseId),
        d.fromLocationId ? eq(inventoryStockTable.locationId, d.fromLocationId) : isNull(inventoryStockTable.locationId),
        d.lotNumber ? eq(inventoryStockTable.lotNumber, d.lotNumber) : isNull(inventoryStockTable.lotNumber),
      )).limit(1));

  const available = Number(sourceStock?.qtyOnHand ?? 0) - Number(sourceStock?.qtyReserved ?? 0);
  if (available < d.quantity) {
    res.status(400).json({ error: `Insufficient available stock. Available: ${available.toFixed(4)}, Requested: ${d.quantity}` });
    return;
  }

  const [[item], itemFull] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select({ costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1)),
  ]);
  const costingMethod = ((itemFull[0]?.costingMethod) ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    // Create transfer record (pending → in_transit after dispatch)
    const [transfer] = await db.insert(inventoryTransfersTable).values({
      tenantId, code: "TRF-PENDING",
      itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      fromWarehouseId: d.fromWarehouseId, fromLocationId: d.fromLocationId ?? undefined,
      toWarehouseId: d.toWarehouseId, toLocationId: d.toLocationId ?? undefined,
      quantity: String(d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.lotNumber ?? undefined,
      status: "in_transit",
      requestedByClerkId: clerkUserId,
      requestedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryTransfersTable.$inferInsert).returning();

    const transferCode = genCode("TRF", transfer.id);
    await db.update(inventoryTransfersTable).set({ code: transferCode }).where(eq(inventoryTransfersTable.id, transfer.id));

    // Out movement at source — removes stock immediately
    const [outMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.fromWarehouseId, locationId: d.fromLocationId ?? undefined,
      toWarehouseId: d.toWarehouseId, toLocationId: d.toLocationId ?? undefined,
      movementType: "transfer",
      quantity: String(-d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.lotNumber ?? undefined,
      refType: "transfer", refId: transfer.id, refCode: transferCode,
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    await db.update(inventoryTransfersTable).set({ outMovementId: outMovement.id }).where(eq(inventoryTransfersTable.id, transfer.id));
    const { computedUnitCost: transferOutCost } = await updateStockLevel(db, tenantId, d.itemId, d.fromWarehouseId, d.fromLocationId ?? null, -d.quantity, d.unitCost ?? null, d.lotNumber ?? null, outMovement.id, costingMethod);

    // Serial number tracking: mark serial as in-transit on transfer out
    if (d.lotNumber && item?.code) { /* lot tracked, no serial update needed */ }

    // GL posting for transfer outbound
    const reqGlAccId = d.glAccountId;
    const glAcc = reqGlAccId
      ? (await db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, reqGlAccId), eq(glAccountsTable.tenantId, tenantId))).limit(1))[0]
      : await lookupInventoryGlAccount(db, tenantId);
    if (glAcc && transferOutCost !== null) {
      const outValue = d.quantity * transferOutCost;
      const glPostingId = await createInventoryGlPosting(db, tenantId, "inventory_transfer", outMovement.id, transferCode,
        clerkUserId, userEmail ?? undefined,
        [
          { accountCode: glAcc.code, accountName: `${glAcc.name} (In-Transit)`, debit: outValue, credit: 0, description: `Transfer out: ${item?.code} × ${d.quantity} to WH-${d.toWarehouseId}` },
          { accountCode: glAcc.code, accountName: glAcc.name, debit: 0, credit: outValue, description: `Inventory cleared for transfer ${transferCode}` },
        ]);
      if (glPostingId) await db.update(inventoryMovementsTable).set({ glPostingId }).where(eq(inventoryMovementsTable.id, outMovement.id));
    }

    return { transferId: transfer.id, transferCode, outMovementId: outMovement.id, status: "in_transit" };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.transfer_dispatched", entityType: "inventory_transfer", entityId: String(result.transferId), newValues: d });
  res.status(201).json(result);
});

/** List transfers */
router.get("/inventory/transfers", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, warehouseId, itemId, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryTransfersTable.id,
      code: inventoryTransfersTable.code,
      itemId: inventoryTransfersTable.itemId,
      itemCode: inventoryTransfersTable.itemCode,
      itemName: inventoryTransfersTable.itemName,
      fromWarehouseId: inventoryTransfersTable.fromWarehouseId,
      fromWarehouseName: sql<string>`fw.name`,
      toWarehouseId: inventoryTransfersTable.toWarehouseId,
      toWarehouseName: sql<string>`tw.name`,
      quantity: inventoryTransfersTable.quantity,
      unitCost: inventoryTransfersTable.unitCost,
      lotNumber: inventoryTransfersTable.lotNumber,
      status: inventoryTransfersTable.status,
      requestedByEmail: inventoryTransfersTable.requestedByEmail,
      receivedByClerkId: inventoryTransfersTable.receivedByClerkId,
      receivedAt: inventoryTransfersTable.receivedAt,
      notes: inventoryTransfersTable.notes,
      createdAt: inventoryTransfersTable.createdAt,
    })
    .from(inventoryTransfersTable)
    .leftJoin(sql`warehouses fw`, sql`fw.id = ${inventoryTransfersTable.fromWarehouseId}`)
    .leftJoin(sql`warehouses tw`, sql`tw.id = ${inventoryTransfersTable.toWarehouseId}`)
    .where(and(
      eq(inventoryTransfersTable.tenantId, tenantId),
      isNull(inventoryTransfersTable.deletedAt),
      status ? eq(inventoryTransfersTable.status, status) : undefined,
      warehouseId ? or(eq(inventoryTransfersTable.fromWarehouseId, Number(warehouseId)), eq(inventoryTransfersTable.toWarehouseId, Number(warehouseId))) : undefined,
      itemId ? eq(inventoryTransfersTable.itemId, Number(itemId)) : undefined,
    ))
    .orderBy(desc(inventoryTransfersTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim).map((r) => ({ ...r, quantity: Number(r.quantity) })), hasMore, page: pg });
});

/** Receive a transfer — creates in movement at destination, marks transfer as received */
router.post("/inventory/transfers/:id/receive", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const transferId = Number(req.params.id);
  const { notes, toLocationId } = req.body as { notes?: string; toLocationId?: number };

  const [transfer] = await withTenantDb(tenantId, (db) =>
    db.select().from(inventoryTransfersTable)
      .where(and(eq(inventoryTransfersTable.id, transferId), eq(inventoryTransfersTable.tenantId, tenantId))).limit(1));

  if (!transfer) { res.status(404).json({ error: "Transfer not found" }); return; }
  if (transfer.status === "received") { res.status(400).json({ error: "Transfer already received" }); return; }
  if (transfer.status === "cancelled") { res.status(400).json({ error: "Transfer has been cancelled" }); return; }

  const itemFull = await withTenantDb(tenantId, (db) =>
    db.select({ costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, transfer.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const costingMethod = ((itemFull[0]?.costingMethod) ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    const destLocationId = toLocationId ?? transfer.toLocationId;
    // In movement at destination
    const [inMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId,
      itemId: transfer.itemId,
      itemCode: transfer.itemCode ?? undefined,
      itemName: transfer.itemName ?? undefined,
      warehouseId: transfer.toWarehouseId,
      locationId: destLocationId ?? undefined,
      movementType: "transfer",
      quantity: transfer.quantity,
      unitCost: transfer.unitCost ?? undefined,
      lotNumber: transfer.lotNumber ?? undefined,
      refType: "transfer", refId: transfer.id, refCode: transfer.code,
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: notes ?? transfer.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    const { computedUnitCost: transferInCost } = await updateStockLevel(
      db, tenantId, transfer.itemId, transfer.toWarehouseId,
      destLocationId ?? null,
      Number(transfer.quantity),
      transfer.unitCost ? Number(transfer.unitCost) : null,
      transfer.lotNumber ?? null,
      inMovement.id,
      costingMethod,
    );

    // Serial number tracking: update serial to available at destination on receive
    if (transfer.lotNumber) { /* lot-tracked, no serial update */ }

    // GL posting for transfer receive (inbound leg) — fall back to outbound movement cost,
    // then transfer.unitCost, then 0, so a posting is always attempted when an inv account exists.
    const receiveInvGl = await lookupInventoryGlAccount(db, tenantId);
    let resolvedInCost = transferInCost;
    if (resolvedInCost == null && transfer.outMovementId != null) {
      const [srcMv] = await db.select({ unitCost: inventoryMovementsTable.unitCost })
        .from(inventoryMovementsTable)
        .where(and(eq(inventoryMovementsTable.id, transfer.outMovementId), eq(inventoryMovementsTable.tenantId, tenantId))).limit(1);
      if (srcMv?.unitCost != null) resolvedInCost = Number(srcMv.unitCost);
    }
    if (resolvedInCost == null && transfer.unitCost != null) resolvedInCost = Number(transfer.unitCost);
    if (receiveInvGl && resolvedInCost != null && resolvedInCost > 0) {
      const inValue = Number(transfer.quantity) * resolvedInCost;
      const glPostingId = await createInventoryGlPosting(db, tenantId, "inventory_transfer", inMovement.id, transfer.code ?? `TRF-${transferId}`,
        clerkUserId, userEmail ?? undefined,
        [
          { accountCode: receiveInvGl.code, accountName: receiveInvGl.name, debit: inValue, credit: 0, description: `Transfer received at WH-${transfer.toWarehouseId}` },
          { accountCode: receiveInvGl.code, accountName: `${receiveInvGl.name} (In-Transit)`, debit: 0, credit: inValue, description: `Clear in-transit for transfer ${transfer.code}` },
        ]);
      if (glPostingId) await db.update(inventoryMovementsTable).set({ glPostingId }).where(eq(inventoryMovementsTable.id, inMovement.id));
    }

    await db.update(inventoryTransfersTable).set({
      status: "received",
      inMovementId: inMovement.id,
      receivedByClerkId: clerkUserId,
      receivedAt: new Date(),
    }).where(eq(inventoryTransfersTable.id, transferId));

    return { inboundMovementId: inMovement.id, transferId, status: "received" };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.transfer_received", entityType: "inventory_transfer", entityId: String(transferId) });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Direct / Manual Receive ───────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const directReceiveSchema = z.object({
  itemId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  quantity: z.number().positive(),
  unitCost: z.number().optional(),
  lotNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  glAccountId: z.number().int({ message: "A GL clearing/AP account is required for direct receives" }),
  refCode: z.string().optional(),
  refType: z.string().optional().default("direct"),
  notes: z.string().optional(),
});

/** POST /inventory/receive — Direct/manual inbound receipt (not from a PO) */
router.post("/inventory/receive", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = directReceiveSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name, costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }
  const costingMethod = (item.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

  const [glAcc] = await withTenantDb(tenantId, (db) =>
    db.select({ code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, d.glAccountId), eq(glAccountsTable.tenantId, tenantId))).limit(1));
  if (!glAcc) { res.status(404).json({ error: "GL account not found" }); return; }

  const result = await withTenantDb(tenantId, async (db) => {
    const [movement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item.code, itemName: item.name,
      warehouseId: d.warehouseId, locationId: d.locationId ?? undefined,
      movementType: "receipt",
      quantity: String(d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.lotNumber ?? undefined,
      serialNumber: d.serialNumber ?? undefined,
      refType: d.refType, refCode: d.refCode ?? undefined,
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, d.quantity, d.unitCost ?? null, d.lotNumber ?? null, movement.id, costingMethod);

    // GL posting: Dr tenant inventory asset account, Cr AP/Clearing account
    let glPostingId: number | null | undefined;
    if (d.unitCost) {
      const value = d.quantity * d.unitCost;
      const invGlAcc = await lookupInventoryGlAccount(db, tenantId);
      if (invGlAcc) {
        glPostingId = await createInventoryGlPosting(
          db, tenantId, "inventory_receive", movement.id,
          d.refCode ?? `RECV-${movement.id}`, clerkUserId, userEmail,
          [
            { accountCode: invGlAcc.code, accountName: invGlAcc.name, debit: value, credit: 0, description: `${item.code} received ${d.quantity} × ${d.unitCost}` },
            { accountCode: glAcc.code, accountName: glAcc.name, debit: 0, credit: value, description: `Direct receive clearing` },
          ],
        );
      }
    }

    return { movementId: movement.id, glPostingId };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.received", entityType: "inventory_movement", entityId: String(result.movementId) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Issue to GL Account / Project ─────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const issueSchema = z.object({
  itemId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  quantity: z.number().positive(),
  lotNumber: z.string().optional(),
  glAccountId: z.number().int().positive(),
  glAccountCode: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/inventory/issue", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const [sourceStock] = await withTenantDb(tenantId, (db) =>
    db.select({ qtyOnHand: inventoryStockTable.qtyOnHand, qtyReserved: inventoryStockTable.qtyReserved, averageCost: inventoryStockTable.averageCost })
      .from(inventoryStockTable)
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        eq(inventoryStockTable.itemId, d.itemId),
        eq(inventoryStockTable.warehouseId, d.warehouseId),
        d.locationId ? eq(inventoryStockTable.locationId, d.locationId) : isNull(inventoryStockTable.locationId),
      )).limit(1));

  const available = Number(sourceStock?.qtyOnHand ?? 0) - Number(sourceStock?.qtyReserved ?? 0);
  if (available < d.quantity) { res.status(400).json({ error: `Insufficient stock. Available: ${available.toFixed(4)}` }); return; }

  const unitCost = Number(sourceStock?.averageCost ?? 0);
  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const [glAcc] = await withTenantDb(tenantId, (db) =>
    db.select({ code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, d.glAccountId), eq(glAccountsTable.tenantId, tenantId))).limit(1));

  const itemFull = await withTenantDb(tenantId, (db) =>
    db.select({ costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const costingMethod = ((itemFull[0]?.costingMethod) ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    const [movement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.warehouseId, locationId: d.locationId ?? undefined,
      movementType: "issue",
      quantity: String(-d.quantity),
      unitCost: unitCost > 0 ? String(unitCost) : undefined,
      issueAccountId: d.glAccountId,
      issueAccountCode: d.glAccountCode ?? glAcc?.code,
      lotNumber: d.lotNumber ?? undefined,
      refType: "issue",
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    const issueCode = genCode("ISS", movement.id);
    await db.update(inventoryMovementsTable).set({ refCode: issueCode }).where(eq(inventoryMovementsTable.id, movement.id));
    const { computedUnitCost: issueCost } = await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, -d.quantity, null, d.lotNumber ?? null, movement.id, costingMethod);

    // Persist consumed-layer cost (FIFO weighted avg / AVCO pre-move avg / standard) on the movement
    const effectiveIssueCost = issueCost ?? unitCost;
    if (effectiveIssueCost > 0) {
      await db.update(inventoryMovementsTable).set({ unitCost: String(effectiveIssueCost) }).where(eq(inventoryMovementsTable.id, movement.id));
    }

    // Create GL posting: Debit issue account, Credit inventory (use real consumed cost)
    let glPostingId: number | null = null;
    const invGlAcc = await lookupInventoryGlAccount(db, tenantId);
    if (effectiveIssueCost > 0 && glAcc && invGlAcc) {
      const value = d.quantity * effectiveIssueCost;
      glPostingId = await createInventoryGlPosting(db, tenantId, "inventory_issue", movement.id, issueCode, clerkUserId, userEmail, [
        { accountCode: glAcc.code, accountName: glAcc.name, debit: value, credit: 0, description: `Issue: ${item?.code} x${d.quantity}` },
        { accountCode: invGlAcc.code, accountName: invGlAcc.name, debit: 0, credit: value, description: `Stock issued to ${glAcc.name}` },
      ]);
      if (glPostingId) {
        await db.update(inventoryMovementsTable).set({ glPostingId }).where(eq(inventoryMovementsTable.id, movement.id));
      }
    }

    return { movementId: movement.id, glPostingId };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.issued", entityType: "inventory_movement", entityId: String(result.movementId) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Customer / Internal Return ────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const returnSchema = z.object({
  itemId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  quantity: z.number().positive(),
  lotNumber: z.string().optional(),
  unitCost: z.number().optional(),
  glAccountId: z.number().int().optional(),
  serialNumber: z.string().optional(),
  refType: z.enum(["customer_return", "internal_return"]).default("customer_return"),
  refId: z.number().int().optional(),
  refCode: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/inventory/return", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = returnSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name, unitCost: itemsTable.unitCost, costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const costingMethod = (item?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    const [movement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.warehouseId, locationId: d.locationId ?? undefined,
      movementType: "return",
      quantity: String(d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : (item?.unitCost ?? undefined),
      lotNumber: d.lotNumber ?? undefined,
      refType: d.refType, refId: d.refId ?? undefined, refCode: d.refCode ?? undefined,
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    const { computedUnitCost: returnCost } = await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, d.quantity, d.unitCost ?? Number(item?.unitCost ?? 0), d.lotNumber ?? null, movement.id, costingMethod);

    // Serial number tracking: mark returned serial as available again
    if (d.serialNumber) {
      await trackSerialNumber(db, tenantId, d.serialNumber, d.itemId, d.warehouseId, d.locationId ?? null, movement.id, "inbound");
    }

    // GL posting for return: DR Inventory, CR Returns/COGS account
    const returnGlAccId = d.glAccountId;
    const returnGlAcc = returnGlAccId
      ? (await db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, returnGlAccId), eq(glAccountsTable.tenantId, tenantId))).limit(1))[0]
      : await lookupInventoryGlAccount(db, tenantId);
    if (returnGlAcc) {
      const returnValue = d.quantity * (returnCost ?? d.unitCost ?? Number(item?.unitCost ?? 0));
      const returnCode = `RET-${movement.id}`;
      const glPostingId = await createInventoryGlPosting(db, tenantId, "inventory_return", movement.id, returnCode, clerkUserId, userEmail ?? undefined, [
        { accountCode: returnGlAcc.code, accountName: returnGlAcc.name, debit: returnValue, credit: 0, description: `Return received: ${item?.code} × ${d.quantity} (${d.refType})` },
        { accountCode: returnGlAcc.code, accountName: `${returnGlAcc.name} (Returns)`, debit: 0, credit: returnValue, description: `Return credit for ${d.refType}` },
      ]);
      if (glPostingId) await db.update(inventoryMovementsTable).set({ glPostingId }).where(eq(inventoryMovementsTable.id, movement.id));
    }

    return { movementId: movement.id };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.returned", entityType: "inventory_movement", entityId: String(result.movementId) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Repack / Split ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const repackSchema = z.object({
  itemId: z.number().int().positive(),
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  fromLotNumber: z.string().optional(),
  toLotNumber: z.string().optional(),
  qtyIn: z.number().positive(),  // qty going OUT of original lot
  qtyOut: z.number().positive(), // qty coming IN to new lot (may differ if pack size changes)
  unitCost: z.number().optional(),
  notes: z.string().optional(),
});

router.post("/inventory/repack", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = repackSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name, costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const costingMethod = (item?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    // Out movement from original lot
    const [outMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.warehouseId, locationId: d.locationId ?? undefined,
      movementType: "repack", quantity: String(-d.qtyIn),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.fromLotNumber ?? undefined,
      refType: "repack",
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();
    const { computedUnitCost: repackOutCost } = await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, -d.qtyIn, null, d.fromLotNumber ?? null, outMovement.id, costingMethod);

    // In movement to new lot
    const [inMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.warehouseId, locationId: d.locationId ?? undefined,
      movementType: "repack", quantity: String(d.qtyOut),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.toLotNumber ?? undefined,
      refType: "repack", refId: outMovement.id,
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();
    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, d.qtyOut, d.unitCost ?? null, d.toLotNumber ?? null, inMovement.id, costingMethod);

    // GL posting for repack: inventory cost reclassification (from-lot → to-lot)
    const repackGlAcc = await lookupInventoryGlAccount(db, tenantId);
    if (repackGlAcc && repackOutCost !== null) {
      const repackValue = d.qtyIn * repackOutCost;
      const repackRef = `RPK-${outMovement.id}`;
      const outGlId = await createInventoryGlPosting(db, tenantId, "inventory_repack", outMovement.id, repackRef, clerkUserId, userEmail ?? undefined, [
        { accountCode: repackGlAcc.code, accountName: `${repackGlAcc.name} (From Lot)`, debit: 0, credit: repackValue, description: `Repack out: ${item?.code} lot ${d.fromLotNumber ?? "–"}` },
        { accountCode: repackGlAcc.code, accountName: `${repackGlAcc.name} (To Lot)`, debit: repackValue, credit: 0, description: `Repack in: ${item?.code} lot ${d.toLotNumber ?? "–"}` },
      ]);
      if (outGlId) {
        await db.update(inventoryMovementsTable).set({ glPostingId: outGlId }).where(eq(inventoryMovementsTable.id, outMovement.id));
        await db.update(inventoryMovementsTable).set({ glPostingId: outGlId }).where(eq(inventoryMovementsTable.id, inMovement.id));
      }
    }

    return { outMovementId: outMovement.id, inMovementId: inMovement.id };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.repacked", entityType: "inventory_movement", entityId: String(result.outMovementId) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Kit Build / Merge ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const buildSchema = z.object({
  finishedItemId: z.number().int().positive(),
  finishedQty: z.number().positive(),
  finishedWarehouseId: z.number().int().positive(),
  finishedLocationId: z.number().int().optional(),
  finishedLotNumber: z.string().optional(),
  finishedSerialNumber: z.string().optional(),
  components: z.array(z.object({
    itemId: z.number().int().positive(),
    qty: z.number().positive(),
    warehouseId: z.number().int().positive(),
    locationId: z.number().int().optional(),
    lotNumber: z.string().optional(),
    serialNumber: z.string().optional(),
  })).min(1),
  notes: z.string().optional(),
});

router.post("/inventory/build", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = buildSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  // Validate component stock
  for (const comp of d.components) {
    const [stock] = await withTenantDb(tenantId, (db) =>
      db.select({ qtyOnHand: inventoryStockTable.qtyOnHand, qtyReserved: inventoryStockTable.qtyReserved })
        .from(inventoryStockTable)
        .where(and(
          eq(inventoryStockTable.tenantId, tenantId),
          eq(inventoryStockTable.itemId, comp.itemId),
          eq(inventoryStockTable.warehouseId, comp.warehouseId),
          comp.locationId ? eq(inventoryStockTable.locationId, comp.locationId) : isNull(inventoryStockTable.locationId),
        )).limit(1));
    const available = Number(stock?.qtyOnHand ?? 0) - Number(stock?.qtyReserved ?? 0);
    if (available < comp.qty) {
      const [it] = await withTenantDb(tenantId, (db) => db.select({ code: itemsTable.code }).from(itemsTable).where(and(eq(itemsTable.id, comp.itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
      res.status(400).json({ error: `Insufficient stock for component ${it?.code ?? comp.itemId}. Available: ${available.toFixed(4)}` });
      return;
    }
  }

  const [finishedItem] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name, unitCost: itemsTable.unitCost, costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, d.finishedItemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  const finishedCostingMethod = (finishedItem?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

  const result = await withTenantDb(tenantId, async (db) => {
    let totalComponentCost = 0;
    const movementIds: number[] = [];

    // Consume each component (resolve per-component costing method)
    for (const comp of d.components) {
      const [compItem] = await db.select({ code: itemsTable.code, name: itemsTable.name, costingMethod: itemsTable.costingMethod }).from(itemsTable).where(and(eq(itemsTable.id, comp.itemId), eq(itemsTable.tenantId, tenantId))).limit(1);
      const compCostingMethod = (compItem?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";
      const [movement] = await db.insert(inventoryMovementsTable).values({
        tenantId, itemId: comp.itemId, itemCode: compItem?.code, itemName: compItem?.name,
        warehouseId: comp.warehouseId, locationId: comp.locationId ?? undefined,
        movementType: "build",
        quantity: String(-comp.qty),
        lotNumber: comp.lotNumber ?? undefined,
        refType: "build",
        postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
        notes: d.notes ?? undefined,
      } as typeof inventoryMovementsTable.$inferInsert).returning();
      const { computedUnitCost: compCost } = await updateStockLevel(db, tenantId, comp.itemId, comp.warehouseId, comp.locationId ?? null, -comp.qty, null, comp.lotNumber ?? null, movement.id, compCostingMethod);
      totalComponentCost += comp.qty * (compCost ?? 0);

      // Serial tracking: outbound component serial
      if (comp.serialNumber) {
        await trackSerialNumber(db, tenantId, comp.serialNumber, comp.itemId, comp.warehouseId, comp.locationId ?? null, movement.id, "outbound");
      }
      movementIds.push(movement.id);
    }

    // Produce finished good
    const [finMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.finishedItemId, itemCode: finishedItem?.code, itemName: finishedItem?.name,
      warehouseId: d.finishedWarehouseId, locationId: d.finishedLocationId ?? undefined,
      movementType: "build",
      quantity: String(d.finishedQty),
      unitCost: finishedItem?.unitCost ?? undefined,
      lotNumber: d.finishedLotNumber ?? undefined,
      refType: "build",
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    await updateStockLevel(db, tenantId, d.finishedItemId, d.finishedWarehouseId, d.finishedLocationId ?? null, d.finishedQty, Number(finishedItem?.unitCost ?? 0), d.finishedLotNumber ?? null, finMovement.id, finishedCostingMethod);
    movementIds.push(finMovement.id);

    // Serial tracking: inbound finished good serial
    if (d.finishedSerialNumber) {
      await trackSerialNumber(db, tenantId, d.finishedSerialNumber, d.finishedItemId, d.finishedWarehouseId, d.finishedLocationId ?? null, finMovement.id, "inbound");
    }

    // GL posting for build: DR finished goods inventory, CR component inventory.
    // Stamp glPostingId on EVERY movement (components + finished) for full traceability.
    const buildGlAcc = await lookupInventoryGlAccount(db, tenantId);
    if (buildGlAcc && totalComponentCost > 0) {
      const buildRef = `BLD-${finMovement.id}`;
      const finGlId = await createInventoryGlPosting(db, tenantId, "inventory_build", finMovement.id, buildRef, clerkUserId, userEmail ?? undefined, [
        { accountCode: buildGlAcc.code, accountName: `${buildGlAcc.name} (Finished Goods)`, debit: totalComponentCost, credit: 0, description: `Build output: ${finishedItem?.code} × ${d.finishedQty}` },
        { accountCode: buildGlAcc.code, accountName: `${buildGlAcc.name} (Components)`, debit: 0, credit: totalComponentCost, description: `Component consumption for build ${buildRef}` },
      ]);
      if (finGlId) {
        for (const mvId of movementIds) {
          await db.update(inventoryMovementsTable).set({ glPostingId: finGlId })
            .where(and(eq(inventoryMovementsTable.id, mvId), eq(inventoryMovementsTable.tenantId, tenantId)));
        }
      }
    }

    return { finishedMovementId: finMovement.id, componentMovementIds: movementIds.slice(0, -1) };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.built", entityType: "inventory_movement", entityId: String(result.finishedMovementId) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Lot Traceability ──────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/lots", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, status, search, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: lotNumbersTable.id,
      lotNumber: lotNumbersTable.lotNumber,
      batchNumber: lotNumbersTable.batchNumber,
      expiryDate: lotNumbersTable.expiryDate,
      status: lotNumbersTable.status,
      qtyOnHand: lotNumbersTable.qtyOnHand,
      qtyReceived: lotNumbersTable.qtyReceived,
      itemId: lotNumbersTable.itemId,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      createdAt: lotNumbersTable.createdAt,
    })
    .from(lotNumbersTable)
    .innerJoin(itemsTable, eq(itemsTable.id, lotNumbersTable.itemId))
    .where(and(
      eq(lotNumbersTable.tenantId, tenantId),
      itemId ? eq(lotNumbersTable.itemId, Number(itemId)) : undefined,
      status ? eq(lotNumbersTable.status, status) : undefined,
      search ? or(ilike(lotNumbersTable.lotNumber, `%${search}%`), ilike(itemsTable.code, `%${search}%`)) : undefined,
    ))
    .orderBy(desc(lotNumbersTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

/**
 * Lot trace — forward (where did this lot go?) or backward (what lots came into this SO/receipt?)
 * direction=forward (default) | backward
 * backward requires refType + refId query params to find which lot arrived for a given source doc
 */
router.get("/inventory/lots/:lotNumber/trace", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lotNumber = req.params.lotNumber as string;
  const { itemId, direction = "forward", refType, refId } = req.query as Record<string, string>;

  // Backward trace: given a reference doc (e.g. SO despatch), find which lots were consumed
  if (direction === "backward" && refType) {
    const consumed = await withTenantDb(tenantId, (db) =>
      db.select({
        id: inventoryMovementsTable.id,
        movementType: inventoryMovementsTable.movementType,
        quantity: inventoryMovementsTable.quantity,
        lotNumber: inventoryMovementsTable.lotNumber,
        warehouseId: inventoryMovementsTable.warehouseId,
        warehouseName: warehousesTable.name,
        refType: inventoryMovementsTable.refType,
        refId: inventoryMovementsTable.refId,
        refCode: inventoryMovementsTable.refCode,
        itemCode: inventoryMovementsTable.itemCode,
        itemName: inventoryMovementsTable.itemName,
        createdAt: inventoryMovementsTable.createdAt,
      })
      .from(inventoryMovementsTable)
      .leftJoin(warehousesTable, eq(warehousesTable.id, inventoryMovementsTable.warehouseId))
      .where(and(
        eq(inventoryMovementsTable.tenantId, tenantId),
        eq(inventoryMovementsTable.refType, refType),
        refId ? eq(inventoryMovementsTable.refId, Number(refId)) : undefined,
        itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
      ))
      .orderBy(asc(inventoryMovementsTable.createdAt)));

    res.json({
      direction: "backward",
      refType,
      refId: refId ?? null,
      movements: consumed.map((m) => ({ ...m, quantity: Number(m.quantity) })),
    });
    return;
  }

  // Forward trace: all movements for this specific lot number (where did it go?)
  const movements = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryMovementsTable.id,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      warehouseId: inventoryMovementsTable.warehouseId,
      warehouseName: warehousesTable.name,
      refType: inventoryMovementsTable.refType,
      refId: inventoryMovementsTable.refId,
      refCode: inventoryMovementsTable.refCode,
      itemCode: inventoryMovementsTable.itemCode,
      itemName: inventoryMovementsTable.itemName,
      createdAt: inventoryMovementsTable.createdAt,
      postedByEmail: inventoryMovementsTable.postedByEmail,
    })
    .from(inventoryMovementsTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, inventoryMovementsTable.warehouseId))
    .where(and(
      eq(inventoryMovementsTable.tenantId, tenantId),
      eq(inventoryMovementsTable.lotNumber, lotNumber),
      itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
    ))
    .orderBy(asc(inventoryMovementsTable.createdAt)));

  const [lotRecord] = await withTenantDb(tenantId, (db) =>
    db.select().from(lotNumbersTable)
      .where(and(eq(lotNumbersTable.tenantId, tenantId), eq(lotNumbersTable.lotNumber, lotNumber),
        itemId ? eq(lotNumbersTable.itemId, Number(itemId)) : undefined))
      .limit(1));

  res.json({
    direction: "forward",
    lotNumber,
    lot: lotRecord ?? null,
    movements: movements.map((m) => ({ ...m, quantity: Number(m.quantity) })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Serial Number Ledger ──────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** List serial numbers (filterable by item, warehouse, status) */
router.get("/inventory/serials", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, warehouseId, status, search, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: serialNumbersTable.id,
      serialNumber: serialNumbersTable.serialNumber,
      itemId: serialNumbersTable.itemId,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      warehouseId: serialNumbersTable.warehouseId,
      warehouseName: warehousesTable.name,
      locationId: serialNumbersTable.locationId,
      lotNumber: serialNumbersTable.lotNumber,
      status: serialNumbersTable.status,
      inboundMovementId: serialNumbersTable.inboundMovementId,
      outboundMovementId: serialNumbersTable.outboundMovementId,
      notes: serialNumbersTable.notes,
      createdAt: serialNumbersTable.createdAt,
    })
    .from(serialNumbersTable)
    .innerJoin(itemsTable, eq(itemsTable.id, serialNumbersTable.itemId))
    .leftJoin(warehousesTable, eq(warehousesTable.id, serialNumbersTable.warehouseId))
    .where(and(
      eq(serialNumbersTable.tenantId, tenantId),
      itemId ? eq(serialNumbersTable.itemId, Number(itemId)) : undefined,
      warehouseId ? eq(serialNumbersTable.warehouseId, Number(warehouseId)) : undefined,
      status ? eq(serialNumbersTable.status, status) : undefined,
      search ? or(ilike(serialNumbersTable.serialNumber, `%${search}%`), ilike(itemsTable.code, `%${search}%`), ilike(itemsTable.name, `%${search}%`)) : undefined,
    ))
    .orderBy(desc(serialNumbersTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

/** Get serial number detail + full movement trace */
router.get("/inventory/serials/:serialNumber", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const serialNumber = String(req.params.serialNumber);

  const [sn] = await withTenantDb(tenantId, (db) =>
    db.select({
      id: serialNumbersTable.id,
      serialNumber: serialNumbersTable.serialNumber,
      itemId: serialNumbersTable.itemId,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      warehouseId: serialNumbersTable.warehouseId,
      locationId: serialNumbersTable.locationId,
      lotNumber: serialNumbersTable.lotNumber,
      status: serialNumbersTable.status,
      inboundMovementId: serialNumbersTable.inboundMovementId,
      outboundMovementId: serialNumbersTable.outboundMovementId,
      reservedForRefType: serialNumbersTable.reservedForRefType,
      reservedForRefId: serialNumbersTable.reservedForRefId,
      notes: serialNumbersTable.notes,
      createdAt: serialNumbersTable.createdAt,
    })
    .from(serialNumbersTable)
    .innerJoin(itemsTable, eq(itemsTable.id, serialNumbersTable.itemId))
    .where(and(eq(serialNumbersTable.tenantId, tenantId), eq(serialNumbersTable.serialNumber, serialNumber)))
    .limit(1));

  if (!sn) { res.status(404).json({ error: "Serial number not found" }); return; }

  // Full movement history for this serial number
  const movements = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryMovementsTable.id,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      warehouseId: inventoryMovementsTable.warehouseId,
      warehouseName: warehousesTable.name,
      refType: inventoryMovementsTable.refType,
      refCode: inventoryMovementsTable.refCode,
      createdAt: inventoryMovementsTable.createdAt,
    })
    .from(inventoryMovementsTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, inventoryMovementsTable.warehouseId))
    .where(and(
      eq(inventoryMovementsTable.tenantId, tenantId),
      eq(inventoryMovementsTable.serialNumber, serialNumber),
    ))
    .orderBy(asc(inventoryMovementsTable.createdAt)));

  res.json({ ...sn, movements: movements.map((m) => ({ ...m, quantity: Number(m.quantity) })) });
});

/** Register a new serial number manually (or on receipt) */
router.post("/inventory/serials", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const schema = z.object({
    serialNumber: z.string().min(1),
    itemId: z.number().int().positive(),
    warehouseId: z.number().int().optional(),
    locationId: z.number().int().optional(),
    lotNumber: z.string().optional(),
    status: z.enum(["available", "reserved", "sold", "scrapped", "in_transit"]).default("available"),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  // Check for duplicate within tenant
  const existing = await withTenantDb(tenantId, (db) =>
    db.select({ id: serialNumbersTable.id }).from(serialNumbersTable)
      .where(and(eq(serialNumbersTable.tenantId, tenantId), eq(serialNumbersTable.itemId, d.itemId), eq(serialNumbersTable.serialNumber, d.serialNumber)))
      .limit(1));
  if (existing.length > 0) { res.status(409).json({ error: "Serial number already registered for this item" }); return; }

  const [sn] = await withTenantDb(tenantId, (db) =>
    db.insert(serialNumbersTable).values({
      tenantId,
      serialNumber: d.serialNumber,
      itemId: d.itemId,
      warehouseId: d.warehouseId ?? undefined,
      locationId: d.locationId ?? undefined,
      lotNumber: d.lotNumber ?? undefined,
      status: d.status,
      notes: d.notes ?? undefined,
    } as typeof serialNumbersTable.$inferInsert).returning());

  res.status(201).json(sn);
});

/** Update serial number status (e.g. mark scrapped, sold, available) */
router.patch("/inventory/serials/:serialNumber", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const serialNumber = String(req.params.serialNumber);
  const { status, warehouseId, locationId, notes } = req.body as { status?: string; warehouseId?: number; locationId?: number; notes?: string };

  const [existing] = await withTenantDb(tenantId, (db) =>
    db.select({ id: serialNumbersTable.id }).from(serialNumbersTable)
      .where(and(eq(serialNumbersTable.tenantId, tenantId), eq(serialNumbersTable.serialNumber, serialNumber))).limit(1));
  if (!existing) { res.status(404).json({ error: "Serial number not found" }); return; }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(serialNumbersTable)
      .set({
        ...(status ? { status } : {}),
        ...(warehouseId !== undefined ? { warehouseId } : {}),
        ...(locationId !== undefined ? { locationId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      })
      .where(and(eq(serialNumbersTable.tenantId, tenantId), eq(serialNumbersTable.serialNumber, serialNumber)))
      .returning());
  res.json(updated);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Stocktake Runs ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/stocktakes", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: stocktakeRunsTable.id,
      code: stocktakeRunsTable.code,
      warehouseId: stocktakeRunsTable.warehouseId,
      warehouseName: warehousesTable.name,
      status: stocktakeRunsTable.status,
      countedAt: stocktakeRunsTable.countedAt,
      postedAt: stocktakeRunsTable.postedAt,
      notes: stocktakeRunsTable.notes,
      createdAt: stocktakeRunsTable.createdAt,
    })
    .from(stocktakeRunsTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, stocktakeRunsTable.warehouseId))
    .where(and(
      eq(stocktakeRunsTable.tenantId, tenantId),
      isNull(stocktakeRunsTable.deletedAt),
      warehouseId ? eq(stocktakeRunsTable.warehouseId, Number(warehouseId)) : undefined,
      status ? eq(stocktakeRunsTable.status, status) : undefined,
    ))
    .orderBy(desc(stocktakeRunsTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

const createStocktakeSchema = z.object({
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  category: z.string().optional(),
  countedAt: z.string().optional(),
  notes: z.string().optional(),
});

/** Create a stocktake run — freezes current system quantities into lines */
router.post("/inventory/stocktakes", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = createStocktakeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const result = await withTenantDb(tenantId, async (db) => {
    const [run] = await db.insert(stocktakeRunsTable).values({
      tenantId, code: "ST-PENDING",
      warehouseId: d.warehouseId,
      status: "open",
      countedAt: d.countedAt ?? undefined,
      createdByClerkId: clerkUserId,
      notes: d.notes ?? undefined,
    } as typeof stocktakeRunsTable.$inferInsert).returning();

    await db.update(stocktakeRunsTable).set({ code: genCode("ST", run.id) }).where(eq(stocktakeRunsTable.id, run.id));

    // Freeze current stock quantities into lines
    const stocks = await db.select({
      itemId: inventoryStockTable.itemId,
      itemCode: itemsTable.code,
      itemName: itemsTable.name,
      locationId: inventoryStockTable.locationId,
      lotNumber: inventoryStockTable.lotNumber,
      qtyOnHand: inventoryStockTable.qtyOnHand,
      averageCost: inventoryStockTable.averageCost,
      itemUnitCost: itemsTable.unitCost,
    })
    .from(inventoryStockTable)
    .innerJoin(itemsTable, eq(itemsTable.id, inventoryStockTable.itemId))
    .where(and(
      eq(inventoryStockTable.tenantId, tenantId),
      eq(inventoryStockTable.warehouseId, d.warehouseId),
      d.locationId ? eq(inventoryStockTable.locationId, d.locationId) : undefined,
      d.category ? eq(itemsTable.category, d.category) : undefined,
    ));

    if (stocks.length > 0) {
      await db.insert(stocktakeLinesTable).values(stocks.map((s) => ({
        tenantId, stocktakeId: run.id,
        itemId: s.itemId, itemCode: s.itemCode ?? undefined, itemName: s.itemName ?? undefined,
        locationId: s.locationId ?? undefined,
        lotNumber: s.lotNumber ?? undefined,
        systemQty: s.qtyOnHand,
        unitCost: s.averageCost ?? s.itemUnitCost ?? undefined,
      }) as typeof stocktakeLinesTable.$inferInsert));
    }

    return { runId: run.id, lineCount: stocks.length };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "stocktake.created", entityType: "stocktake_run", entityId: String(result.runId) });
  res.status(201).json({ id: result.runId, code: genCode("ST", result.runId), lineCount: result.lineCount });
});

/** Get stocktake run with lines */
router.get("/inventory/stocktakes/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [run] = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeRunsTable)
      .where(and(eq(stocktakeRunsTable.id, id), eq(stocktakeRunsTable.tenantId, tenantId))).limit(1));
  if (!run) { res.status(404).json({ error: "Stocktake run not found" }); return; }
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeLinesTable)
      .where(and(eq(stocktakeLinesTable.stocktakeId, id), eq(stocktakeLinesTable.tenantId, tenantId))));
  res.json({ ...run, lines });
});

/** Enter counted quantity for a stocktake line */
router.patch("/inventory/stocktakes/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const { id, lineId } = req.params;
  const { countedQty } = z.object({ countedQty: z.number() }).parse(req.body);

  const [run] = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeRunsTable).where(and(eq(stocktakeRunsTable.id, Number(id)), eq(stocktakeRunsTable.tenantId, tenantId))).limit(1));
  if (!run) { res.status(404).json({ error: "Run not found" }); return; }
  if (!["open", "counting"].includes(run.status)) { res.status(400).json({ error: "Run is not in an editable state" }); return; }

  const [line] = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeLinesTable).where(and(eq(stocktakeLinesTable.id, Number(lineId)), eq(stocktakeLinesTable.stocktakeId, Number(id)))).limit(1));
  if (!line) { res.status(404).json({ error: "Line not found" }); return; }

  const variance = countedQty - Number(line.systemQty);
  const varianceValue = variance * Number(line.unitCost ?? 0);

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(stocktakeLinesTable)
      .set({ countedQty: String(countedQty), varianceQty: String(variance), varianceValue: String(varianceValue), countedByClerkId: clerkUserId, countedAt: new Date() })
      .where(eq(stocktakeLinesTable.id, Number(lineId))).returning());

  // Move run to counting status
  if (run.status === "open") {
    await withTenantDb(tenantId, (db) =>
      db.update(stocktakeRunsTable).set({ status: "counting" }).where(eq(stocktakeRunsTable.id, Number(id))));
  }

  res.json(updated);
});

/** Post stocktake variances as inventory adjustments */
router.post("/inventory/stocktakes/:id/post", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const { glAccountId } = req.body as { glAccountId?: number };

  const [run] = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeRunsTable).where(and(eq(stocktakeRunsTable.id, id), eq(stocktakeRunsTable.tenantId, tenantId))).limit(1));
  if (!run) { res.status(404).json({ error: "Stocktake run not found" }); return; }
  if (!["counting", "variance"].includes(run.status)) { res.status(400).json({ error: "Run must be in counting or variance status to post" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeLinesTable).where(and(eq(stocktakeLinesTable.stocktakeId, id), eq(stocktakeLinesTable.tenantId, tenantId))));

  const varianceLines = lines.filter((l) => l.countedQty !== null && Number(l.varianceQty ?? 0) !== 0);
  let movementsPosted = 0;
  let glPostingId: number | undefined;

  await withTenantDb(tenantId, async (db) => {
    // Resolve GL account for variance posting
    const glAcc = glAccountId
      ? (await db.select({ code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(and(eq(glAccountsTable.id, glAccountId), eq(glAccountsTable.tenantId, tenantId))).limit(1))[0]
      : null;

    // Resolve tenant's configured inventory asset account (shared lookup)
    const invGlAcc = await lookupInventoryGlAccount(db, tenantId);

    // Build GL lines for all variances, create single GL posting
    const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

    for (const line of varianceLines) {
      const varianceQty = Number(line.varianceQty ?? 0);
      const unitCost = Number(line.unitCost ?? 0);

      // Resolve item costing method
      const [itemRow] = await db.select({ costingMethod: itemsTable.costingMethod })
        .from(itemsTable).where(and(eq(itemsTable.id, line.itemId), eq(itemsTable.tenantId, tenantId))).limit(1);
      const costingMethod = (itemRow?.costingMethod ?? "avco") as "fifo" | "avco" | "standard";

      const [movement] = await db.insert(inventoryMovementsTable).values({
        tenantId, itemId: line.itemId, itemCode: line.itemCode ?? undefined, itemName: line.itemName ?? undefined,
        warehouseId: run.warehouseId,
        locationId: line.locationId ?? undefined,
        movementType: "adjustment",
        quantity: String(varianceQty),
        unitCost: line.unitCost ?? undefined,
        adjReason: `Stocktake ${run.code}`,
        lotNumber: line.lotNumber ?? undefined,
        refType: "stocktake", refId: id, refCode: run.code,
        postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      } as typeof inventoryMovementsTable.$inferInsert).returning();

      await updateStockLevel(db, tenantId, line.itemId, run.warehouseId, line.locationId ?? null, varianceQty, unitCost, line.lotNumber ?? null, movement.id, costingMethod);

      await db.update(stocktakeLinesTable).set({ movementId: movement.id })
        .where(eq(stocktakeLinesTable.id, line.id));
      movementsPosted++;

      // Accumulate GL lines for variance posting
      if (glAcc && invGlAcc && unitCost > 0) {
        const value = Math.abs(varianceQty * unitCost);
        const isIncrease = varianceQty > 0;
        glLines.push({
          accountCode: invGlAcc.code, accountName: invGlAcc.name,
          debit: isIncrease ? value : 0,
          credit: isIncrease ? 0 : value,
          description: `Stocktake ${run.code} – ${line.itemCode ?? ""} variance ${varianceQty > 0 ? "+" : ""}${varianceQty.toFixed(4)}`,
        });
        glLines.push({
          accountCode: glAcc.code, accountName: glAcc.name,
          debit: isIncrease ? 0 : value,
          credit: isIncrease ? value : 0,
          description: `Stocktake variance offset`,
        });
      }
    }

    // Create a single GL posting for the entire stocktake run
    if (glLines.length > 0) {
      glPostingId = await createInventoryGlPosting(
        db, tenantId, "stocktake", id, run.code, clerkUserId, userEmail, glLines,
      ) ?? undefined;
    }

    await db.update(stocktakeRunsTable)
      .set({ status: "posted", postedAt: new Date(), postedByClerkId: clerkUserId })
      .where(eq(stocktakeRunsTable.id, id));
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "stocktake.posted", entityType: "stocktake_run", entityId: String(id), newValues: { movementsPosted } });
  res.json({ id, status: "posted", movementsPosted, glPostingId });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Cycle Counts ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/cycle-counts", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, status, assignedTo, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: cycleCountTasksTable.id,
      code: cycleCountTasksTable.code,
      warehouseId: cycleCountTasksTable.warehouseId,
      warehouseName: warehousesTable.name,
      locationId: cycleCountTasksTable.locationId,
      category: cycleCountTasksTable.category,
      assignedToClerkId: cycleCountTasksTable.assignedToClerkId,
      assignedToName: cycleCountTasksTable.assignedToName,
      dueDate: cycleCountTasksTable.dueDate,
      status: cycleCountTasksTable.status,
      completedAt: cycleCountTasksTable.completedAt,
      createdAt: cycleCountTasksTable.createdAt,
    })
    .from(cycleCountTasksTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, cycleCountTasksTable.warehouseId))
    .where(and(
      eq(cycleCountTasksTable.tenantId, tenantId),
      isNull(cycleCountTasksTable.deletedAt),
      warehouseId ? eq(cycleCountTasksTable.warehouseId, Number(warehouseId)) : undefined,
      status ? eq(cycleCountTasksTable.status, status) : undefined,
      assignedTo ? eq(cycleCountTasksTable.assignedToClerkId, assignedTo) : undefined,
    ))
    .orderBy(desc(cycleCountTasksTable.createdAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

const createCycleCountSchema = z.object({
  warehouseId: z.number().int().positive(),
  locationId: z.number().int().optional(),
  category: z.string().optional(),
  assignedToClerkId: z.string().optional(),
  assignedToName: z.string().optional(),
  dueDate: z.string().optional(),
  notes: z.string().optional(),
});

router.post("/inventory/cycle-counts", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = createCycleCountSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const result = await withTenantDb(tenantId, async (db) => {
    const [task] = await db.insert(cycleCountTasksTable).values({
      tenantId, code: "CC-PENDING",
      warehouseId: d.warehouseId,
      locationId: d.locationId ?? undefined,
      category: d.category ?? undefined,
      assignedToClerkId: d.assignedToClerkId ?? undefined,
      assignedToName: d.assignedToName ?? undefined,
      dueDate: d.dueDate ?? undefined,
      status: "pending",
      notes: d.notes ?? undefined,
    } as typeof cycleCountTasksTable.$inferInsert).returning();

    await db.update(cycleCountTasksTable).set({ code: genCode("CC", task.id) }).where(eq(cycleCountTasksTable.id, task.id));

    // Pre-populate lines from current stock at the location/category
    const stocks = await db.select({
      itemId: inventoryStockTable.itemId, itemCode: itemsTable.code, itemName: itemsTable.name,
      lotNumber: inventoryStockTable.lotNumber, qtyOnHand: inventoryStockTable.qtyOnHand,
    })
    .from(inventoryStockTable)
    .innerJoin(itemsTable, eq(itemsTable.id, inventoryStockTable.itemId))
    .where(and(
      eq(inventoryStockTable.tenantId, tenantId),
      eq(inventoryStockTable.warehouseId, d.warehouseId),
      d.locationId ? eq(inventoryStockTable.locationId, d.locationId) : undefined,
      d.category ? eq(itemsTable.category, d.category) : undefined,
    ));

    if (stocks.length > 0) {
      await db.insert(cycleCountLinesTable).values(stocks.map((s) => ({
        tenantId, taskId: task.id,
        itemId: s.itemId, itemCode: s.itemCode ?? undefined, itemName: s.itemName ?? undefined,
        lotNumber: s.lotNumber ?? undefined, systemQty: s.qtyOnHand,
      }) as typeof cycleCountLinesTable.$inferInsert));
    }

    return { taskId: task.id, lineCount: stocks.length };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "cycle_count.created", entityType: "cycle_count_task", entityId: String(result.taskId) });
  res.status(201).json({ id: result.taskId, code: genCode("CC", result.taskId), lineCount: result.lineCount });
});

router.get("/inventory/cycle-counts/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [task] = await withTenantDb(tenantId, (db) =>
    db.select().from(cycleCountTasksTable).where(and(eq(cycleCountTasksTable.id, id), eq(cycleCountTasksTable.tenantId, tenantId))).limit(1));
  if (!task) { res.status(404).json({ error: "Cycle count task not found" }); return; }
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(cycleCountLinesTable).where(and(eq(cycleCountLinesTable.taskId, id), eq(cycleCountLinesTable.tenantId, tenantId))));
  res.json({ ...task, lines });
});

router.patch("/inventory/cycle-counts/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
    assignedToClerkId: z.string().optional(),
    assignedToName: z.string().optional(),
    dueDate: z.string().optional(),
    notes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed" }); return; }

  const updates: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.status === "completed") {
    updates.completedAt = new Date();
    updates.completedByClerkId = clerkUserId;
  }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(cycleCountTasksTable).set(updates as Partial<typeof cycleCountTasksTable.$inferInsert>)
      .where(and(eq(cycleCountTasksTable.id, id), eq(cycleCountTasksTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "Task not found" }); return; }
  res.json(updated);
});

/** Enter counted quantity for a cycle count line */
router.patch("/inventory/cycle-counts/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { id, lineId } = req.params;
  const { countedQty } = z.object({ countedQty: z.number() }).parse(req.body);

  const [line] = await withTenantDb(tenantId, (db) =>
    db.select().from(cycleCountLinesTable)
      .where(and(eq(cycleCountLinesTable.id, Number(lineId)), eq(cycleCountLinesTable.taskId, Number(id)))).limit(1));
  if (!line) { res.status(404).json({ error: "Line not found" }); return; }

  const variance = countedQty - Number(line.systemQty);
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(cycleCountLinesTable)
      .set({ countedQty: String(countedQty), varianceQty: String(variance), countedAt: new Date() })
      .where(eq(cycleCountLinesTable.id, Number(lineId))).returning());

  // Move task to in_progress
  await withTenantDb(tenantId, (db) =>
    db.update(cycleCountTasksTable).set({ status: "in_progress" })
      .where(and(eq(cycleCountTasksTable.id, Number(id)), eq(cycleCountTasksTable.status, "pending"))));

  res.json(updated);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Landed Cost Allocations ───────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/landed-costs", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { receiptId, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(landedCostAllocationsTable)
      .where(and(
        eq(landedCostAllocationsTable.tenantId, tenantId),
        receiptId ? eq(landedCostAllocationsTable.receiptId, Number(receiptId)) : undefined,
      ))
      .orderBy(desc(landedCostAllocationsTable.createdAt))
      .limit(lim + 1).offset((pg - 1) * lim));
  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

router.post("/inventory/landed-costs", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const schema = z.object({
    receiptId: z.number().int().positive(),
    receiptLineId: z.number().int().optional(),
    costType: z.enum(["freight", "duty", "insurance", "other"]),
    description: z.string().optional(),
    totalLandedCost: z.number().positive(),
    allocationMethod: z.enum(["value", "qty", "weight"]).default("value"),
    allocatedAmount: z.number().optional(),
    glAccountId: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  const d = parsed.data;
  const allocatedAmount = d.allocatedAmount ?? d.totalLandedCost;

  const result = await withTenantDb(tenantId, async (db) => {
    const [lc] = await db.insert(landedCostAllocationsTable).values({
      tenantId, ...d,
      totalLandedCost: String(d.totalLandedCost),
      allocatedAmount: String(allocatedAmount),
      isPosted: true,
      postedAt: new Date(),
    } as typeof landedCostAllocationsTable.$inferInsert).returning();

    // ── Apply landed cost to cost layers from the receipt movement ────────────
    const layers = await db.select().from(costLayersTable)
      .where(and(
        eq(costLayersTable.tenantId, tenantId),
        eq(costLayersTable.movementId, d.receiptId),
        gt(costLayersTable.qtyOriginal, "0"),
      ));

    if (layers.length > 0) {
      if (d.allocationMethod === "qty") {
        const totalQty = layers.reduce((s, l) => s + Number(l.qtyOriginal), 0);
        for (const layer of layers) {
          const proportion = Number(layer.qtyOriginal) / totalQty;
          const addedPerUnit = (allocatedAmount * proportion) / Number(layer.qtyOriginal);
          await db.update(costLayersTable)
            .set({ unitCost: sql`(${costLayersTable.unitCost}::numeric + ${String(addedPerUnit.toFixed(6))}::numeric)` })
            .where(eq(costLayersTable.id, layer.id));
        }
      } else {
        // value-based (default): proportional to layer value
        const totalValue = layers.reduce((s, l) => s + Number(l.qtyOriginal) * Number(l.unitCost), 0);
        for (const layer of layers) {
          if (totalValue === 0) break;
          const layerValue = Number(layer.qtyOriginal) * Number(layer.unitCost);
          const proportion = layerValue / totalValue;
          const addedPerUnit = (allocatedAmount * proportion) / Number(layer.qtyOriginal);
          await db.update(costLayersTable)
            .set({ unitCost: sql`(${costLayersTable.unitCost}::numeric + ${String(addedPerUnit.toFixed(6))}::numeric)` })
            .where(eq(costLayersTable.id, layer.id));
        }
      }
    }

    // ── GL posting for landed cost accrual ───────────────────────────────────
    if (d.glAccountId) {
      const [glAcc] = await db.select({ code: glAccountsTable.code, name: glAccountsTable.name })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.id, d.glAccountId), eq(glAccountsTable.tenantId, tenantId)))
        .limit(1);
      if (glAcc) {
        const amount = Number(allocatedAmount);
        await createInventoryGlPosting(
          db, tenantId, "landed_cost", lc.id, `LC-${lc.id}`,
          clerkUserId, undefined,
          [{ accountCode: glAcc.code, accountName: glAcc.name, debit: amount, credit: 0, description: `Landed cost (${d.costType}): ${d.description ?? ""}`.trim() }],
        );
      }
    }

    return lc;
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: undefined, tenantId, action: "landed_cost.created", entityType: "landed_cost_allocation", entityId: String(result.id) });
  res.status(201).json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Cost Layers (FIFO) ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

router.get("/inventory/cost-layers", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, warehouseId, page = "1", limit = "50" } = req.query as Record<string, string>;
  if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: costLayersTable.id,
      itemId: costLayersTable.itemId,
      warehouseId: costLayersTable.warehouseId,
      warehouseName: warehousesTable.name,
      locationId: costLayersTable.locationId,
      lotNumber: costLayersTable.lotNumber,
      qtyOriginal: costLayersTable.qtyOriginal,
      qtyRemaining: costLayersTable.qtyRemaining,
      unitCost: costLayersTable.unitCost,
      receivedAt: costLayersTable.receivedAt,
    })
    .from(costLayersTable)
    .leftJoin(warehousesTable, eq(warehousesTable.id, costLayersTable.warehouseId))
    .where(and(
      eq(costLayersTable.tenantId, tenantId),
      eq(costLayersTable.itemId, Number(itemId)),
      warehouseId ? eq(costLayersTable.warehouseId, Number(warehouseId)) : undefined,
      gt(costLayersTable.qtyRemaining, "0"),
    ))
    .orderBy(asc(costLayersTable.receivedAt))
    .limit(lim + 1).offset((pg - 1) * lim));

  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim).map((r) => ({ ...r, qtyOriginal: Number(r.qtyOriginal), qtyRemaining: Number(r.qtyRemaining), unitCost: Number(r.unitCost) })), hasMore, page: pg });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Inventory Reports ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Stock Valuation Report — current stock on hand with cost per item/warehouse */
router.get("/inventory/reports/stock-valuation", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, itemId, groupBy = "item" } = req.query as Record<string, string>;

  type StockValRow = { itemId: number; itemCode: string; itemName: string; warehouseId: number; warehouseName: string; qtyOnHand: number; averageCost: number; totalValue: number; };
  const qrSV = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        s.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName",
        s.warehouse_id AS "warehouseId", w.name AS "warehouseName",
        SUM(s.qty_on_hand::numeric) AS "qtyOnHand",
        AVG(COALESCE(s.average_cost::numeric, 0)) AS "averageCost",
        SUM(s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric, 0)) AS "totalValue"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId}
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
        ${itemId ? sql`AND s.item_id = ${Number(itemId)}` : sql``}
      GROUP BY s.item_id, i.code, i.name, s.warehouse_id, w.name
      ORDER BY "totalValue" DESC
    `)
  );
  const rows = qrSV.rows as unknown as StockValRow[];

  const grandTotal = rows.reduce((sum, r) => sum + Number(r.totalValue ?? 0), 0);
  res.json({
    groupBy,
    grandTotal,
    rows: rows.map(r => ({
      ...r,
      qtyOnHand: Number(r.qtyOnHand ?? 0),
      averageCost: Number(r.averageCost ?? 0),
      totalValue: Number(r.totalValue ?? 0),
    })),
  });
});

/** Movement History Report — detailed inventory movements with filters */
router.get("/inventory/reports/movement-history", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate, warehouseId, itemId, movementType, page = "1", limit = "100" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(500, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: inventoryMovementsTable.id,
      itemCode: inventoryMovementsTable.itemCode,
      itemName: inventoryMovementsTable.itemName,
      warehouseId: inventoryMovementsTable.warehouseId,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      unitCost: inventoryMovementsTable.unitCost,
      lotNumber: inventoryMovementsTable.lotNumber,
      refType: inventoryMovementsTable.refType,
      refCode: inventoryMovementsTable.refCode,
      postedByEmail: inventoryMovementsTable.postedByEmail,
      createdAt: inventoryMovementsTable.createdAt,
    }).from(inventoryMovementsTable)
      .where(and(
        eq(inventoryMovementsTable.tenantId, tenantId),
        fromDate ? sql`${inventoryMovementsTable.createdAt} >= ${new Date(fromDate)}` : undefined,
        toDate ? sql`${inventoryMovementsTable.createdAt} <= ${new Date(toDate)}` : undefined,
        warehouseId ? eq(inventoryMovementsTable.warehouseId, Number(warehouseId)) : undefined,
        itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
        movementType ? eq(inventoryMovementsTable.movementType, movementType) : undefined,
      ))
      .orderBy(desc(inventoryMovementsTable.createdAt))
      .limit(lim).offset(offset)
  );

  const [countRow] = await withTenantDb(tenantId, (db) =>
    db.select({ count: sql<number>`count(*)` }).from(inventoryMovementsTable)
      .where(and(
        eq(inventoryMovementsTable.tenantId, tenantId),
        fromDate ? sql`${inventoryMovementsTable.createdAt} >= ${new Date(fromDate)}` : undefined,
        toDate ? sql`${inventoryMovementsTable.createdAt} <= ${new Date(toDate)}` : undefined,
        warehouseId ? eq(inventoryMovementsTable.warehouseId, Number(warehouseId)) : undefined,
        itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
        movementType ? eq(inventoryMovementsTable.movementType, movementType) : undefined,
      ))
  );

  res.json({
    data: rows.map(r => ({ ...r, quantity: Number(r.quantity), unitCost: r.unitCost ? Number(r.unitCost) : null })),
    total: Number(countRow?.count ?? 0),
    page: pg,
    limit: lim,
    pages: Math.ceil(Number(countRow?.count ?? 0) / lim),
  });
});

/** Slow-Moving Items Report — items with no outbound movement in N days */
router.get("/inventory/reports/slow-moving", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { days = "90", warehouseId } = req.query as Record<string, string>;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(days));

  type SlowMoveRow = { itemId: number; itemCode: string; itemName: string; warehouseId: number; warehouseName: string; qtyOnHand: number; totalValue: number; lastMovementAt: Date | null; daysSinceMovement: number; };
  const qrSM = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        s.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName",
        s.warehouse_id AS "warehouseId", w.name AS "warehouseName",
        s.qty_on_hand::numeric AS "qtyOnHand",
        (s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric, 0)) AS "totalValue",
        s.last_movement_at AS "lastMovementAt",
        EXTRACT(DAY FROM NOW() - COALESCE(s.last_movement_at, s.created_at)) AS "daysSinceMovement"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId}
        AND s.qty_on_hand::numeric > 0
        AND (s.last_movement_at IS NULL OR s.last_movement_at < ${cutoff})
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY "daysSinceMovement" DESC
      LIMIT 500
    `)
  );
  const rows = qrSM.rows as unknown as SlowMoveRow[];

  res.json({
    cutoffDays: Number(days),
    cutoffDate: cutoff.toISOString().split("T")[0],
    rows: rows.map(r => ({
      ...r,
      qtyOnHand: Number(r.qtyOnHand ?? 0),
      totalValue: Number(r.totalValue ?? 0),
      daysSinceMovement: Number(r.daysSinceMovement ?? 0),
    })),
  });
});

/** Stocktake Variance Report — variance by last completed stocktake run */
router.get("/inventory/reports/stocktake-variance", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { stocktakeRunId, warehouseId } = req.query as Record<string, string>;

  type StocktakeVarianceRow = { runId: number; runCode: string; itemCode: string; itemName: string; qtyExpected: number; qtyActual: number; variance: number; varianceValue: number; };
  const qrVar = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        sr.id AS "runId", sr.code AS "runCode",
        sl.item_code AS "itemCode", sl.item_name AS "itemName",
        sl.expected_qty::numeric AS "qtyExpected",
        sl.actual_qty::numeric AS "qtyActual",
        (sl.actual_qty::numeric - sl.expected_qty::numeric) AS "variance",
        ((sl.actual_qty::numeric - sl.expected_qty::numeric) * COALESCE(sl.unit_cost::numeric, 0)) AS "varianceValue"
      FROM stocktake_runs sr
      JOIN stocktake_lines sl ON sl.run_id = sr.id AND sl.tenant_id = ${tenantId}
      WHERE sr.tenant_id = ${tenantId}
        AND sr.status = 'posted'
        ${stocktakeRunId ? sql`AND sr.id = ${Number(stocktakeRunId)}` : sql``}
        ${warehouseId ? sql`AND sr.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY ABS(sl.actual_qty::numeric - sl.expected_qty::numeric) DESC
      LIMIT 1000
    `)
  );
  const rows = qrVar.rows as unknown as StocktakeVarianceRow[];

  const totalVarianceValue = rows.reduce((s, r) => s + Number(r.varianceValue ?? 0), 0);
  res.json({
    stocktakeRunId: stocktakeRunId ? Number(stocktakeRunId) : null,
    totalVarianceValue,
    rows: rows.map(r => ({
      ...r,
      qtyExpected: Number(r.qtyExpected ?? 0),
      qtyActual: Number(r.qtyActual ?? 0),
      variance: Number(r.variance ?? 0),
      varianceValue: Number(r.varianceValue ?? 0),
    })),
  });
});

/** Stock Valuation CSV Export */
router.get("/inventory/reports/stock-valuation/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, itemId } = req.query as Record<string, string>;

  type CsvStockRow = { itemCode: string; itemName: string; warehouseName: string; qtyOnHand: number; averageCost: number; totalValue: number };
  const qrCSV = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT i.code AS "itemCode", i.name AS "itemName", w.name AS "warehouseName",
             SUM(s.qty_on_hand::numeric) AS "qtyOnHand",
             AVG(COALESCE(s.average_cost::numeric,0)) AS "averageCost",
             SUM(s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric,0)) AS "totalValue"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId}
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
        ${itemId ? sql`AND s.item_id = ${Number(itemId)}` : sql``}
      GROUP BY i.code, i.name, w.name ORDER BY "totalValue" DESC
    `)
  );
  const rows = qrCSV.rows as unknown as CsvStockRow[];

  const lines = ["Item Code,Item Name,Warehouse,Qty On Hand,Average Cost,Total Value"];
  for (const r of rows) {
    lines.push([r.itemCode, `"${r.itemName}"`, `"${r.warehouseName}"`, Number(r.qtyOnHand).toFixed(4), Number(r.averageCost).toFixed(4), Number(r.totalValue).toFixed(2)].join(","));
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "stock-valuation", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Stock Valuation PDF Export */
router.get("/inventory/reports/stock-valuation/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, itemId } = req.query as Record<string, string>;

  type CsvStockRow = { itemCode: string; itemName: string; warehouseName: string; qtyOnHand: number; averageCost: number; totalValue: number };
  const qrPDF = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT i.code AS "itemCode", i.name AS "itemName", w.name AS "warehouseName",
             SUM(s.qty_on_hand::numeric) AS "qtyOnHand",
             AVG(COALESCE(s.average_cost::numeric,0)) AS "averageCost",
             SUM(s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric,0)) AS "totalValue"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId}
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
        ${itemId ? sql`AND s.item_id = ${Number(itemId)}` : sql``}
      GROUP BY i.code, i.name, w.name ORDER BY "totalValue" DESC
    `)
  );
  const rows = qrPDF.rows as unknown as CsvStockRow[];

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "stock-valuation", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Stock Valuation Report", { align: "center" });
  doc.moveDown();
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [80, 160, 110, 70, 80, 80];
  const headers = ["Item Code", "Item Name", "Warehouse", "Qty On Hand", "Avg Cost", "Total Value"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(8).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    const vals = [r.itemCode, String(r.itemName).slice(0, 30), String(r.warehouseName).slice(0, 20), Number(r.qtyOnHand).toFixed(2), Number(r.averageCost).toFixed(2), Number(r.totalValue).toFixed(2)];
    vals.forEach((v, i) => { doc.fontSize(8).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i]; });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** Movement History CSV Export */
router.get("/inventory/reports/movement-history/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate, warehouseId, itemId, movementType } = req.query as Record<string, string>;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      itemCode: inventoryMovementsTable.itemCode,
      itemName: inventoryMovementsTable.itemName,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      unitCost: inventoryMovementsTable.unitCost,
      refType: inventoryMovementsTable.refType,
      refCode: inventoryMovementsTable.refCode,
      createdAt: inventoryMovementsTable.createdAt,
    }).from(inventoryMovementsTable)
      .where(and(
        eq(inventoryMovementsTable.tenantId, tenantId),
        fromDate ? sql`${inventoryMovementsTable.createdAt} >= ${new Date(fromDate)}` : undefined,
        toDate ? sql`${inventoryMovementsTable.createdAt} <= ${new Date(toDate)}` : undefined,
        warehouseId ? eq(inventoryMovementsTable.warehouseId, Number(warehouseId)) : undefined,
        itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
        movementType ? eq(inventoryMovementsTable.movementType, movementType) : undefined,
      ))
      .orderBy(desc(inventoryMovementsTable.createdAt)).limit(5000)
  );

  const lines = ["Item Code,Item Name,Movement Type,Quantity,Unit Cost,Ref Type,Ref Code,Date"];
  for (const r of rows) {
    lines.push([r.itemCode ?? "", `"${r.itemName ?? ""}"`, r.movementType ?? "", Number(r.quantity).toFixed(4), r.unitCost ? Number(r.unitCost).toFixed(4) : "", r.refType ?? "", r.refCode ?? "", r.createdAt ? new Date(r.createdAt).toISOString().split("T")[0] : ""].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "movement-history", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Movement History PDF Export */
router.get("/inventory/reports/movement-history/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate, warehouseId, itemId, movementType } = req.query as Record<string, string>;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      itemCode: inventoryMovementsTable.itemCode,
      itemName: inventoryMovementsTable.itemName,
      movementType: inventoryMovementsTable.movementType,
      quantity: inventoryMovementsTable.quantity,
      unitCost: inventoryMovementsTable.unitCost,
      refCode: inventoryMovementsTable.refCode,
      createdAt: inventoryMovementsTable.createdAt,
    }).from(inventoryMovementsTable)
      .where(and(
        eq(inventoryMovementsTable.tenantId, tenantId),
        fromDate ? sql`${inventoryMovementsTable.createdAt} >= ${new Date(fromDate)}` : undefined,
        toDate ? sql`${inventoryMovementsTable.createdAt} <= ${new Date(toDate)}` : undefined,
        warehouseId ? eq(inventoryMovementsTable.warehouseId, Number(warehouseId)) : undefined,
        itemId ? eq(inventoryMovementsTable.itemId, Number(itemId)) : undefined,
        movementType ? eq(inventoryMovementsTable.movementType, movementType) : undefined,
      ))
      .orderBy(desc(inventoryMovementsTable.createdAt)).limit(1000)
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "movement-history", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Inventory Movement History", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [70, 130, 90, 60, 70, 80, 90];
  const headers = ["Item Code", "Item Name", "Type", "Qty", "Unit Cost", "Ref", "Date"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(8).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    const vals = [r.itemCode ?? "", String(r.itemName ?? "").slice(0, 22), r.movementType ?? "", Number(r.quantity).toFixed(2), r.unitCost ? Number(r.unitCost).toFixed(2) : "", r.refCode ?? "", r.createdAt ? new Date(r.createdAt).toISOString().split("T")[0] : ""];
    vals.forEach((v, i) => { doc.fontSize(8).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i]; });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** Slow-Moving Items CSV Export */
router.get("/inventory/reports/slow-moving/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { days = "90", warehouseId } = req.query as Record<string, string>;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(days));

  type SlowRow = { itemCode: string; itemName: string; warehouseName: string; qtyOnHand: number; totalValue: number; daysSinceMovement: number };
  const qrSlowCsv = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT i.code AS "itemCode", i.name AS "itemName", w.name AS "warehouseName",
             s.qty_on_hand::numeric AS "qtyOnHand",
             (s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric, 0)) AS "totalValue",
             EXTRACT(DAY FROM NOW() - COALESCE(s.last_movement_at, s.created_at)) AS "daysSinceMovement"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId} AND s.qty_on_hand::numeric > 0
        AND (s.last_movement_at IS NULL OR s.last_movement_at < ${cutoff})
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY "daysSinceMovement" DESC LIMIT 500
    `)
  );
  const rows = qrSlowCsv.rows as unknown as SlowRow[];

  const lines = ["Item Code,Item Name,Warehouse,Qty On Hand,Total Value,Days Since Movement"];
  for (const r of rows) {
    lines.push([r.itemCode, `"${r.itemName}"`, `"${r.warehouseName}"`, Number(r.qtyOnHand).toFixed(2), Number(r.totalValue).toFixed(2), Number(r.daysSinceMovement).toFixed(0)].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "slow-moving", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Slow-Moving Items PDF Export */
router.get("/inventory/reports/slow-moving/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { days = "90", warehouseId } = req.query as Record<string, string>;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Number(days));

  type SlowRow = { itemCode: string; itemName: string; warehouseName: string; qtyOnHand: number; totalValue: number; daysSinceMovement: number };
  const qrSlowPdf = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT i.code AS "itemCode", i.name AS "itemName", w.name AS "warehouseName",
             s.qty_on_hand::numeric AS "qtyOnHand",
             (s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric, 0)) AS "totalValue",
             EXTRACT(DAY FROM NOW() - COALESCE(s.last_movement_at, s.created_at)) AS "daysSinceMovement"
      FROM inventory_stock s
      JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
      JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
      WHERE s.tenant_id = ${tenantId} AND s.qty_on_hand::numeric > 0
        AND (s.last_movement_at IS NULL OR s.last_movement_at < ${cutoff})
        ${warehouseId ? sql`AND s.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY "daysSinceMovement" DESC LIMIT 500
    `)
  );
  const rows = qrSlowPdf.rows as unknown as SlowRow[];

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, `slow-moving-${days}d`, "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text(`Slow-Moving Items Report (${days}+ Days)`, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Cutoff: ${cutoff.toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [80, 160, 110, 80, 90, 80];
  const headers = ["Item Code", "Item Name", "Warehouse", "Qty On Hand", "Total Value", "Days Idle"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(8).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    const vals = [r.itemCode, String(r.itemName).slice(0, 28), String(r.warehouseName).slice(0, 20), Number(r.qtyOnHand).toFixed(2), Number(r.totalValue).toFixed(2), Number(r.daysSinceMovement).toFixed(0)];
    vals.forEach((v, i) => { doc.fontSize(8).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i]; });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** Stocktake Variance CSV Export */
router.get("/inventory/reports/stocktake-variance/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { stocktakeRunId, warehouseId } = req.query as Record<string, string>;

  type VarRow = { runCode: string; itemCode: string; itemName: string; qtyExpected: number; qtyActual: number; variance: number; varianceValue: number };
  const qrVarCsv = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT sr.code AS "runCode", sl.item_code AS "itemCode", sl.item_name AS "itemName",
             sl.expected_qty::numeric AS "qtyExpected", sl.actual_qty::numeric AS "qtyActual",
             (sl.actual_qty::numeric - sl.expected_qty::numeric) AS "variance",
             ((sl.actual_qty::numeric - sl.expected_qty::numeric) * COALESCE(sl.unit_cost::numeric, 0)) AS "varianceValue"
      FROM stocktake_runs sr
      JOIN stocktake_lines sl ON sl.run_id = sr.id AND sl.tenant_id = ${tenantId}
      WHERE sr.tenant_id = ${tenantId} AND sr.status = 'posted'
        ${stocktakeRunId ? sql`AND sr.id = ${Number(stocktakeRunId)}` : sql``}
        ${warehouseId ? sql`AND sr.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY ABS(sl.actual_qty::numeric - sl.expected_qty::numeric) DESC LIMIT 1000
    `)
  );
  const rows = qrVarCsv.rows as unknown as VarRow[];

  const lines = ["Run Code,Item Code,Item Name,Expected Qty,Actual Qty,Variance,Variance Value"];
  for (const r of rows) {
    lines.push([r.runCode, r.itemCode, `"${r.itemName}"`, Number(r.qtyExpected).toFixed(2), Number(r.qtyActual).toFixed(2), Number(r.variance).toFixed(2), Number(r.varianceValue).toFixed(2)].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "stocktake-variance", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Stocktake Variance PDF Export */
router.get("/inventory/reports/stocktake-variance/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { stocktakeRunId, warehouseId } = req.query as Record<string, string>;

  type VarRow = { runCode: string; itemCode: string; itemName: string; qtyExpected: number; qtyActual: number; variance: number; varianceValue: number };
  const qrVarPdf = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT sr.code AS "runCode", sl.item_code AS "itemCode", sl.item_name AS "itemName",
             sl.expected_qty::numeric AS "qtyExpected", sl.actual_qty::numeric AS "qtyActual",
             (sl.actual_qty::numeric - sl.expected_qty::numeric) AS "variance",
             ((sl.actual_qty::numeric - sl.expected_qty::numeric) * COALESCE(sl.unit_cost::numeric, 0)) AS "varianceValue"
      FROM stocktake_runs sr
      JOIN stocktake_lines sl ON sl.run_id = sr.id AND sl.tenant_id = ${tenantId}
      WHERE sr.tenant_id = ${tenantId} AND sr.status = 'posted'
        ${stocktakeRunId ? sql`AND sr.id = ${Number(stocktakeRunId)}` : sql``}
        ${warehouseId ? sql`AND sr.warehouse_id = ${Number(warehouseId)}` : sql``}
      ORDER BY ABS(sl.actual_qty::numeric - sl.expected_qty::numeric) DESC LIMIT 1000
    `)
  );
  const rows = qrVarPdf.rows as unknown as VarRow[];

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "stocktake-variance", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Stocktake Variance Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [70, 70, 150, 70, 70, 65, 75];
  const headers = ["Run", "Item Code", "Item Name", "Expected", "Actual", "Variance", "Var Value"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(8).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    const vals = [r.runCode, r.itemCode, String(r.itemName).slice(0, 25), Number(r.qtyExpected).toFixed(2), Number(r.qtyActual).toFixed(2), Number(r.variance).toFixed(2), Number(r.varianceValue).toFixed(2)];
    vals.forEach((v, i) => { doc.fontSize(8).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i]; });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

export default router;

import { Router, type Request, type Response } from "express";
import { eq, and, isNull, desc, sql, or, ilike, asc, gt } from "drizzle-orm";
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
} from "@workspace/db";
import { withTenantDb, type TenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { z } from "zod";

const router = Router();
const tenantUserMiddleware = [requireAuth, tenantContext] as const;
const tenantWriteMiddleware = [requireAuth, tenantContext, requireRole("admin", "manager", "warehouse")] as const;

// ── Helper: generate code ─────────────────────────────────────────────────────
function genCode(prefix: string, id: number) { return `${prefix}-${String(id).padStart(5, "0")}`; }

// ── Helper: update inventory stock atomically ─────────────────────────────────
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
) {
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
  if (existing.length > 0) {
    const avgCost = existing[0].averageCost
      ? ((Number(existing[0].averageCost) * Number(existing[0].qtyOnHand) + (unitCost ?? 0) * Math.max(0, quantity)) /
         Math.max(0.0001, Number(existing[0].qtyOnHand) + Math.max(0, quantity)))
      : unitCost;
    await db.update(inventoryStockTable)
      .set({
        qtyOnHand: sql`GREATEST(0, ${inventoryStockTable.qtyOnHand} + ${qty}::numeric)`,
        averageCost: quantity > 0 && unitCost !== null ? String(avgCost?.toFixed(4) ?? unitCost) : existing[0].averageCost,
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
  }

  // Update FIFO cost layer if inbound
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

  // Consume FIFO layers for outbound movements
  if (quantity < 0) {
    let remaining = Math.abs(quantity);
    const layers = await db.select()
      .from(costLayersTable)
      .where(and(
        eq(costLayersTable.tenantId, tenantId),
        eq(costLayersTable.itemId, itemId),
        eq(costLayersTable.warehouseId, warehouseId),
        gt(costLayersTable.qtyRemaining, "0"),
      ))
      .orderBy(asc(costLayersTable.receivedAt));
    for (const layer of layers) {
      if (remaining <= 0) break;
      const consume = Math.min(remaining, Number(layer.qtyRemaining));
      const newRemaining = Number(layer.qtyRemaining) - consume;
      await db.update(costLayersTable)
        .set({ qtyRemaining: newRemaining.toFixed(4) })
        .where(eq(costLayersTable.id, layer.id));
      remaining -= consume;
    }
  }

  // Update lot number on-hand qty
  if (lotNumber) {
    const existingLot = await db.select().from(lotNumbersTable)
      .where(and(eq(lotNumbersTable.tenantId, tenantId), eq(lotNumbersTable.itemId, itemId), eq(lotNumbersTable.lotNumber, lotNumber)))
      .limit(1);
    if (existingLot.length > 0) {
      await db.update(lotNumbersTable)
        .set({ qtyOnHand: sql`GREATEST(0, ${lotNumbersTable.qtyOnHand} + ${qty}::numeric)` })
        .where(eq(lotNumbersTable.id, existingLot[0].id));
    } else if (quantity > 0) {
      await db.insert(lotNumbersTable).values({
        tenantId, itemId, lotNumber,
        qtyReceived: qty, qtyOnHand: qty,
        status: "active",
      } as typeof lotNumbersTable.$inferInsert);
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
      stockValue: sql<string>`${inventoryStockTable.qtyOnHand} * COALESCE(${inventoryStockTable.averageCost}, ${itemsTable.unitCost}, 0)`,
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

/** Item availability summary — on-hand, reserved, available, on-order */
router.get("/inventory/stock/:itemId", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const itemId = Number(req.params.itemId);
  const { warehouseId } = req.query as Record<string, string>;

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select().from(itemsTable)
      .where(and(eq(itemsTable.id, itemId), eq(itemsTable.tenantId, tenantId))).limit(1));
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }

  const stockRows = await withTenantDb(tenantId, (db) =>
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
    .groupBy(inventoryStockTable.warehouseId, warehousesTable.name));

  const totalOnHand = stockRows.reduce((s, r) => s + Number(r.qtyOnHand), 0);
  const totalReserved = stockRows.reduce((s, r) => s + Number(r.qtyReserved), 0);

  res.json({
    item: { id: item.id, code: item.code, name: item.name, unitCost: item.unitCost },
    totalOnHand, totalReserved, totalAvailable: totalOnHand - totalReserved,
    byWarehouse: stockRows.map((r) => ({ ...r, qtyOnHand: Number(r.qtyOnHand), qtyReserved: Number(r.qtyReserved), qtyAvailable: Number(r.qtyOnHand) - Number(r.qtyReserved) })),
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
  glAccountId: z.number().int().optional(),
  glAccountCode: z.string().optional(),
  glAccountName: z.string().optional(),
  warehouseId: z.number().int().optional(),
  notes: z.string().optional(),
  lines: z.array(adjustmentLineSchema).min(1),
});

router.post("/inventory/adjust", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const parsed = createAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

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

    await db.update(inventoryAdjustmentsTable).set({ code: genCode("ADJ", adj.id) }).where(eq(inventoryAdjustmentsTable.id, adj.id));

    // Process each line
    const lineIds: number[] = [];
    for (const line of parsed.data.lines) {
      const [item] = await db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.id, line.itemId)).limit(1);
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
        refCode: genCode("ADJ", adj.id),
        lotNumber: line.lotNumber ?? undefined,
        postedByClerkId: clerkUserId,
        postedByEmail: userEmail ?? undefined,
        notes: parsed.data.notes ?? undefined,
      } as typeof inventoryMovementsTable.$inferInsert).returning();

      await updateStockLevel(db, tenantId, line.itemId, line.warehouseId, line.locationId ?? null, line.qtyAdjusted, line.unitCost ?? null, line.lotNumber ?? null, movement.id);

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
    }
    return { adjId: adj.id, lineCount: lineIds.length };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.adjusted", entityType: "inventory_adjustment", entityId: String(result.adjId), newValues: { lines: result.lineCount } });
  res.status(201).json({ id: result.adjId, code: genCode("ADJ", result.adjId), lines: result.lineCount });
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
  notes: z.string().optional(),
});

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

  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.id, d.itemId)).limit(1));

  const result = await withTenantDb(tenantId, async (db) => {
    // Out movement at source
    const [outMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.fromWarehouseId, locationId: d.fromLocationId ?? undefined,
      toWarehouseId: d.toWarehouseId, toLocationId: d.toLocationId ?? undefined,
      movementType: "transfer",
      quantity: String(-d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.lotNumber ?? undefined,
      refType: "transfer",
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    await db.update(inventoryMovementsTable).set({ refCode: genCode("TRF", outMovement.id) }).where(eq(inventoryMovementsTable.id, outMovement.id));
    await updateStockLevel(db, tenantId, d.itemId, d.fromWarehouseId, d.fromLocationId ?? null, -d.quantity, d.unitCost ?? null, d.lotNumber ?? null, outMovement.id);

    // In movement at destination
    const [inMovement] = await db.insert(inventoryMovementsTable).values({
      tenantId, itemId: d.itemId, itemCode: item?.code, itemName: item?.name,
      warehouseId: d.toWarehouseId, locationId: d.toLocationId ?? undefined,
      movementType: "transfer",
      quantity: String(d.quantity),
      unitCost: d.unitCost != null ? String(d.unitCost) : undefined,
      lotNumber: d.lotNumber ?? undefined,
      refType: "transfer", refId: outMovement.id, refCode: genCode("TRF", outMovement.id),
      postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined,
      notes: d.notes ?? undefined,
    } as typeof inventoryMovementsTable.$inferInsert).returning();

    await updateStockLevel(db, tenantId, d.itemId, d.toWarehouseId, d.toLocationId ?? null, d.quantity, d.unitCost ?? null, d.lotNumber ?? null, inMovement.id);

    return { transferCode: genCode("TRF", outMovement.id), outMovementId: outMovement.id, inMovementId: inMovement.id };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "inventory.transferred", entityType: "inventory_movement", entityId: String(result.outMovementId), newValues: d });
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
    db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.id, d.itemId)).limit(1));
  const [glAcc] = await withTenantDb(tenantId, (db) =>
    db.select({ code: glAccountsTable.code, name: glAccountsTable.name }).from(glAccountsTable).where(eq(glAccountsTable.id, d.glAccountId)).limit(1));

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

    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, -d.quantity, null, d.lotNumber ?? null, movement.id);
    return { movementId: movement.id };
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
    db.select({ code: itemsTable.code, name: itemsTable.name, unitCost: itemsTable.unitCost }).from(itemsTable).where(eq(itemsTable.id, d.itemId)).limit(1));

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

    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, d.quantity, d.unitCost ?? Number(item?.unitCost ?? 0), d.lotNumber ?? null, movement.id);
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
    db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.id, d.itemId)).limit(1));

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
    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, -d.qtyIn, null, d.fromLotNumber ?? null, outMovement.id);

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
    await updateStockLevel(db, tenantId, d.itemId, d.warehouseId, d.locationId ?? null, d.qtyOut, d.unitCost ?? null, d.toLotNumber ?? null, inMovement.id);
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
  components: z.array(z.object({
    itemId: z.number().int().positive(),
    qty: z.number().positive(),
    warehouseId: z.number().int().positive(),
    locationId: z.number().int().optional(),
    lotNumber: z.string().optional(),
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
      const [it] = await withTenantDb(tenantId, (db) => db.select({ code: itemsTable.code }).from(itemsTable).where(eq(itemsTable.id, comp.itemId)).limit(1));
      res.status(400).json({ error: `Insufficient stock for component ${it?.code ?? comp.itemId}. Available: ${available.toFixed(4)}` });
      return;
    }
  }

  const [finishedItem] = await withTenantDb(tenantId, (db) =>
    db.select({ code: itemsTable.code, name: itemsTable.name, unitCost: itemsTable.unitCost }).from(itemsTable).where(eq(itemsTable.id, d.finishedItemId)).limit(1));

  const result = await withTenantDb(tenantId, async (db) => {
    const movementIds: number[] = [];

    // Consume each component
    for (const comp of d.components) {
      const [compItem] = await db.select({ code: itemsTable.code, name: itemsTable.name }).from(itemsTable).where(eq(itemsTable.id, comp.itemId)).limit(1);
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
      await updateStockLevel(db, tenantId, comp.itemId, comp.warehouseId, comp.locationId ?? null, -comp.qty, null, comp.lotNumber ?? null, movement.id);
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

    await updateStockLevel(db, tenantId, d.finishedItemId, d.finishedWarehouseId, d.finishedLocationId ?? null, d.finishedQty, Number(finishedItem?.unitCost ?? 0), d.finishedLotNumber ?? null, finMovement.id);
    movementIds.push(finMovement.id);

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

/** Forward trace — all movements for a given lot number */
router.get("/inventory/lots/:lotNumber/trace", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lotNumber = req.params.lotNumber as string;
  const { itemId } = req.query as Record<string, string>;

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
    lotNumber,
    lot: lotRecord ?? null,
    movements: movements.map((m) => ({ ...m, quantity: Number(m.quantity) })),
  });
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

  const [run] = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeRunsTable).where(and(eq(stocktakeRunsTable.id, id), eq(stocktakeRunsTable.tenantId, tenantId))).limit(1));
  if (!run) { res.status(404).json({ error: "Stocktake run not found" }); return; }
  if (!["counting", "variance"].includes(run.status)) { res.status(400).json({ error: "Run must be in counting or variance status to post" }); return; }

  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(stocktakeLinesTable).where(and(eq(stocktakeLinesTable.stocktakeId, id), eq(stocktakeLinesTable.tenantId, tenantId))));

  const varianceLines = lines.filter((l) => l.countedQty !== null && Number(l.varianceQty ?? 0) !== 0);
  let movementsPosted = 0;

  await withTenantDb(tenantId, async (db) => {
    for (const line of varianceLines) {
      const varianceQty = Number(line.varianceQty ?? 0);
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

      await updateStockLevel(db, tenantId, line.itemId, run.warehouseId, line.locationId ?? null, varianceQty, Number(line.unitCost ?? 0), line.lotNumber ?? null, movement.id);

      await db.update(stocktakeLinesTable).set({ movementId: movement.id })
        .where(eq(stocktakeLinesTable.id, line.id));
      movementsPosted++;
    }

    await db.update(stocktakeRunsTable)
      .set({ status: "posted", postedAt: new Date(), postedByClerkId: clerkUserId })
      .where(eq(stocktakeRunsTable.id, id));
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "stocktake.posted", entityType: "stocktake_run", entityId: String(id), newValues: { movementsPosted } });
  res.json({ id, status: "posted", movementsPosted });
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

  const [lc] = await withTenantDb(tenantId, (db) =>
    db.insert(landedCostAllocationsTable).values({
      tenantId, ...parsed.data,
      totalLandedCost: String(parsed.data.totalLandedCost),
      allocatedAmount: parsed.data.allocatedAmount != null ? String(parsed.data.allocatedAmount) : undefined,
    } as typeof landedCostAllocationsTable.$inferInsert).returning());

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: undefined, tenantId, action: "landed_cost.created", entityType: "landed_cost_allocation", entityId: String(lc.id) });
  res.status(201).json(lc);
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

export default router;

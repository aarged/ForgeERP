import { Router, type IRouter } from "express";
import { eq, and, isNull, desc, sql, inArray, or, ilike, lte } from "drizzle-orm";
import {
  quotationsTable,
  quotationLinesTable,
  salesOrdersTable,
  soLinesTable,
  soAllocationsTable,
  pickSlipsTable,
  pickSlipLinesTable,
  despatchesTable,
  despatchLinesTable,
  customerInvoicesTable,
  customerInvoiceLinesTable,
  creditNotesTable,
  creditNoteLinesTable,
  rmaOrdersTable,
  rmaLinesTable,
  backordersTable,
  glPostingsTable,
  inventoryStockTable,
  inventoryMovementsTable,
  customersTable,
  warehousesTable,
  itemsTable,
  glAccountsTable,
  notificationsTable,
} from "@workspace/db";
import { withTenantDb, type TenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { sendEmail } from "../lib/email";
import type { Request, Response } from "express";
import { z } from "zod";

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function genCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(6, "0")}`;
}

async function resolveGlAccount(tenantId: number, db: TenantDb | null, fallbackCode: string, fallbackName: string) {
  const query = (d: TenantDb) =>
    d.select({ code: glAccountsTable.code, name: glAccountsTable.name })
      .from(glAccountsTable)
      .where(and(eq(glAccountsTable.tenantId, tenantId), eq(glAccountsTable.code, fallbackCode), isNull(glAccountsTable.deletedAt)))
      .limit(1);
  const rows = db ? await query(db) : await withTenantDb(tenantId, query);
  return rows[0] ? { accountCode: rows[0].code, accountName: rows[0].name } : { accountCode: fallbackCode, accountName: fallbackName };
}

async function updateQuotationTotals(tenantId: number, quotationId: number) {
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(quotationLinesTable)
      .where(and(eq(quotationLinesTable.quotationId, quotationId), eq(quotationLinesTable.tenantId, tenantId))));
  let subtotal = 0; let taxAmount = 0;
  for (const l of lines) {
    const qty = Number(l.quantity); const up = Number(l.unitPrice);
    const disc = Number(l.discountPct ?? 0) / 100; const tax = Number(l.taxPct ?? 0) / 100;
    const lineBase = qty * up * (1 - disc);
    subtotal += lineBase; taxAmount += lineBase * tax;
  }
  await withTenantDb(tenantId, (db) =>
    db.update(quotationsTable).set({ subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: (subtotal + taxAmount).toFixed(2) })
      .where(eq(quotationsTable.id, quotationId)));
}

async function updateSoTotals(tenantId: number, soId: number) {
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(soLinesTable).where(and(eq(soLinesTable.soId, soId), eq(soLinesTable.tenantId, tenantId))));
  let subtotal = 0; let taxAmount = 0;
  for (const l of lines) {
    const qty = Number(l.quantity); const up = Number(l.unitPrice);
    const disc = Number(l.discountPct ?? 0) / 100; const tax = Number(l.taxPct ?? 0) / 100;
    const lineBase = qty * up * (1 - disc);
    subtotal += lineBase; taxAmount += lineBase * tax;
  }
  await withTenantDb(tenantId, (db) =>
    db.update(salesOrdersTable).set({ subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: (subtotal + taxAmount).toFixed(2) })
      .where(eq(salesOrdersTable.id, soId)));
}

async function recalcSoStatus(db: TenantDb, tenantId: number, soId: number) {
  const lines = await db.select().from(soLinesTable)
    .where(and(eq(soLinesTable.soId, soId), eq(soLinesTable.tenantId, tenantId)));
  const [so] = await db.select({ status: salesOrdersTable.status }).from(salesOrdersTable)
    .where(and(eq(salesOrdersTable.id, soId), eq(salesOrdersTable.tenantId, tenantId))).limit(1);
  if (!so || so.status === "cancelled" || so.status === "draft") return;
  const stockLines = lines.filter((l) => l.lineType === "stock");
  if (stockLines.length === 0) return;
  const allDespatched = stockLines.every((l) => Number(l.despatched_qty) >= Number(l.quantity));
  const anyDespatched = stockLines.some((l) => Number(l.despatched_qty) > 0);
  const allInvoiced = stockLines.every((l) => Number(l.invoiced_qty) >= Number(l.quantity));
  let newStatus = so.status;
  if (allInvoiced) newStatus = "invoiced";
  else if (allDespatched) newStatus = "despatched";
  else if (anyDespatched) newStatus = "partially_despatched";
  if (newStatus !== so.status) {
    await db.update(salesOrdersTable).set({ status: newStatus })
      .where(and(eq(salesOrdersTable.id, soId), eq(salesOrdersTable.tenantId, tenantId)));
  }
}

/** ATP: available = on_hand - reserved (across all SOs), returns qty available for new allocation */
async function getAtpQty(tenantId: number, itemId: number, warehouseId: number | null): Promise<number> {
  const stockRows = await withTenantDb(tenantId, (db) => {
    const base = db.select({ onHand: inventoryStockTable.qtyOnHand, reserved: inventoryStockTable.qtyReserved })
      .from(inventoryStockTable)
      .where(and(eq(inventoryStockTable.tenantId, tenantId), eq(inventoryStockTable.itemId, itemId),
        warehouseId ? eq(inventoryStockTable.warehouseId, warehouseId) : sql`1=1`));
    return base;
  });
  let totalOnHand = 0; let totalReserved = 0;
  for (const r of stockRows) { totalOnHand += Number(r.onHand); totalReserved += Number(r.reserved); }
  return Math.max(0, totalOnHand - totalReserved);
}

/** Soft-allocate stock for all stock lines of a confirmed SO */
async function allocateStockForSo(db: TenantDb, tenantId: number, soId: number) {
  const so = (await db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, soId), eq(salesOrdersTable.tenantId, tenantId))).limit(1))[0];
  const lines = await db.select().from(soLinesTable).where(and(eq(soLinesTable.soId, soId), eq(soLinesTable.tenantId, tenantId)));
  for (const line of lines) {
    if (line.lineType !== "stock" || !line.itemId) continue;
    const qty = Number(line.quantity);
    const warehouseId = so?.warehouseId ?? null;
    // Find the best stock bucket
    const stockRows = await db.select().from(inventoryStockTable)
      .where(and(eq(inventoryStockTable.tenantId, tenantId), eq(inventoryStockTable.itemId, line.itemId),
        warehouseId ? eq(inventoryStockTable.warehouseId, warehouseId) : sql`1=1`))
      .orderBy(desc(inventoryStockTable.qtyOnHand)).limit(1);
    const stock = stockRows[0];
    if (!stock) continue;
    const canAllocate = Math.min(qty, Math.max(0, Number(stock.qtyOnHand) - Number(stock.qtyReserved)));
    if (canAllocate <= 0) continue;
    await db.update(inventoryStockTable)
      .set({ qtyReserved: sql`${inventoryStockTable.qtyReserved} + ${canAllocate.toFixed(4)}` })
      .where(and(eq(inventoryStockTable.id, stock.id), eq(inventoryStockTable.tenantId, tenantId)));
    await db.insert(soAllocationsTable).values({
      tenantId, soId, soLineId: line.id, itemId: line.itemId,
      warehouseId: stock.warehouseId, locationId: stock.locationId ?? undefined,
      allocatedQty: canAllocate.toFixed(4), isReleased: false,
    } as typeof soAllocationsTable.$inferInsert);
  }
}

/** Release all non-released allocations for an SO */
async function releaseAllocations(db: TenantDb, tenantId: number, soId: number) {
  const allocs = await db.select().from(soAllocationsTable)
    .where(and(eq(soAllocationsTable.soId, soId), eq(soAllocationsTable.tenantId, tenantId), eq(soAllocationsTable.isReleased, false)));
  for (const alloc of allocs) {
    const qty = Number(alloc.allocatedQty);
    await db.update(inventoryStockTable)
      .set({ qtyReserved: sql`GREATEST(0, ${inventoryStockTable.qtyReserved} - ${qty.toFixed(4)})` })
      .where(and(eq(inventoryStockTable.warehouseId, alloc.warehouseId), eq(inventoryStockTable.itemId, alloc.itemId), eq(inventoryStockTable.tenantId, tenantId)));
    await db.update(soAllocationsTable).set({ isReleased: true, releasedAt: new Date() })
      .where(and(eq(soAllocationsTable.id, alloc.id), eq(soAllocationsTable.tenantId, tenantId)));
  }
}

/** Post despatch GL: Dr AR / Cr Revenue + Dr COGS / Cr Inventory */
async function createDespatchGlPosting(db: TenantDb, tenantId: number, despatchId: number, postedByClerkId: string, postedByEmail?: string) {
  const despatch = (await db.select().from(despatchesTable).where(and(eq(despatchesTable.id, despatchId), eq(despatchesTable.tenantId, tenantId))).limit(1))[0];
  if (!despatch) return null;
  const lines = await db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, despatchId), eq(despatchLinesTable.tenantId, tenantId)));

  const arAccount = await resolveGlAccount(tenantId, db, "1100", "Accounts Receivable");
  const revenueAccount = await resolveGlAccount(tenantId, db, "4000", "Sales Revenue");
  const cogsAccount = await resolveGlAccount(tenantId, db, "5000", "Cost of Goods Sold");
  const inventoryAccount = await resolveGlAccount(tenantId, db, "1300", "Inventory");

  let totalRevenue = 0; let totalCogs = 0;
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

  for (const line of lines) {
    if (Number(line.quantity) <= 0) continue;
    const lineRevenue = Number(line.quantity) * Number(line.unitPrice ?? 0);
    const lineCogs = Number(line.quantity) * Number(line.unitCost ?? 0);
    totalRevenue += lineRevenue;
    totalCogs += lineCogs;
    glLines.push({ ...revenueAccount, debit: 0, credit: lineRevenue, description: `Revenue: ${line.itemCode ?? line.itemName ?? "item"}` });
    if (lineCogs > 0) {
      glLines.push({ ...cogsAccount, debit: lineCogs, credit: 0, description: `COGS: ${line.itemCode ?? line.itemName ?? "item"}` });
      glLines.push({ ...inventoryAccount, debit: 0, credit: lineCogs, description: `Inventory out: ${line.itemCode ?? line.itemName ?? "item"}` });
    }
  }
  if (totalRevenue === 0) return null;
  glLines.unshift({ ...arAccount, debit: totalRevenue, credit: 0, description: `AR for despatch ${despatchId}` });

  const totalDebit = glLines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = glLines.reduce((s, l) => s + l.credit, 0);

  const [posting] = await db.insert(glPostingsTable).values({
    tenantId, code: `GL-SO-${Date.now()}`, entityType: "so_despatch", entityId: despatchId,
    status: "posted", postedByClerkId, postedByEmail: postedByEmail ?? undefined, postedAt: new Date(),
    lines: glLines, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2),
  } as typeof glPostingsTable.$inferInsert).returning();
  return posting;
}

/** Post credit note GL: Dr Revenue / Cr AR */
async function createCreditNoteGlPosting(db: TenantDb, tenantId: number, creditNoteId: number, postedByClerkId: string, postedByEmail?: string) {
  const cn = (await db.select().from(creditNotesTable).where(and(eq(creditNotesTable.id, creditNoteId), eq(creditNotesTable.tenantId, tenantId))).limit(1))[0];
  if (!cn) return null;
  const total = Number(cn.total);
  if (total <= 0) return null;
  const arAccount = await resolveGlAccount(tenantId, db, "1100", "Accounts Receivable");
  const revenueAccount = await resolveGlAccount(tenantId, db, "4000", "Sales Revenue");
  const glLines = [
    { ...revenueAccount, debit: total, credit: 0, description: `Revenue reversal for credit note ${cn.code}` },
    { ...arAccount, debit: 0, credit: total, description: `AR credit for credit note ${cn.code}` },
  ];
  const [posting] = await db.insert(glPostingsTable).values({
    tenantId, code: `GL-CN-${Date.now()}`, entityType: "credit_note", entityId: creditNoteId,
    status: "posted", postedByClerkId, postedByEmail: postedByEmail ?? undefined, postedAt: new Date(),
    lines: glLines, totalDebit: total.toFixed(2), totalCredit: total.toFixed(2),
  } as typeof glPostingsTable.$inferInsert).returning();
  return posting;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ATP Endpoint ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/atp", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, warehouseId } = req.query as Record<string, string>;
  if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }
  const qty = await getAtpQty(tenantId, Number(itemId), warehouseId ? Number(warehouseId) : null);
  const stockRows = await withTenantDb(tenantId, (db) =>
    db.select({ warehouseId: inventoryStockTable.warehouseId, qtyOnHand: inventoryStockTable.qtyOnHand, qtyReserved: inventoryStockTable.qtyReserved, averageCost: inventoryStockTable.averageCost })
      .from(inventoryStockTable)
      .where(and(eq(inventoryStockTable.tenantId, tenantId), eq(inventoryStockTable.itemId, Number(itemId)),
        warehouseId ? eq(inventoryStockTable.warehouseId, Number(warehouseId)) : sql`1=1`)));
  res.json({ itemId: Number(itemId), warehouseId: warehouseId ? Number(warehouseId) : null, atpQty: qty, stockDetails: stockRows });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Quotations ────────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/quotations", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, customerId, search, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(quotationsTable)
      .where(and(
        eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt),
        status ? eq(quotationsTable.status, status) : undefined,
        customerId ? eq(quotationsTable.customerId, Number(customerId)) : undefined,
        search ? or(ilike(quotationsTable.code, `%${search}%`), ilike(quotationsTable.customerName, `%${search}%`)) : undefined,
      ))
      .orderBy(desc(quotationsTable.createdAt)).limit(lim + 1).offset(offset));
  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/sales/quotations/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [quotation, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable).where(and(eq(quotationLinesTable.quotationId, id), eq(quotationLinesTable.tenantId, tenantId))).orderBy(quotationLinesTable.lineNumber)),
  ]);
  if (!quotation[0]) { res.status(404).json({ error: "Quotation not found" }); return; }
  res.json({ ...quotation[0], lines });
});

const quotationLineSchema = z.object({
  lineNumber: z.number().int().optional(),
  lineType: z.enum(["stock", "service", "charge", "comment"]).default("stock"),
  itemId: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().nonnegative().default(1),
  unitOfMeasure: z.string().optional(),
  unitPrice: z.number().nonnegative().default(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).default(0),
  glAccountId: z.number().int().optional(),
  notes: z.string().optional(),
});

router.post("/sales/quotations", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    customerId: z.number().int().optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().email().optional(),
    customerRef: z.string().optional(),
    expiryDate: z.string().optional(),
    requestedDate: z.string().optional(),
    currencyCode: z.string().default("AUD"),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    lines: z.array(quotationLineSchema).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const { lines, ...header } = parsed.data;

  // Resolve customer details if customerId provided
  let resolvedCustomerName = header.customerName;
  let resolvedCustomerEmail = header.customerEmail;
  if (header.customerId) {
    const [cust] = await withTenantDb(tenantId, (db) => db.select({ name: customersTable.name, email: customersTable.email }).from(customersTable).where(and(eq(customersTable.id, header.customerId!), eq(customersTable.tenantId, tenantId))).limit(1));
    resolvedCustomerName = resolvedCustomerName ?? cust?.name;
    resolvedCustomerEmail = resolvedCustomerEmail ?? cust?.email ?? undefined;
  }

  const [quot] = await withTenantDb(tenantId, (db) =>
    db.insert(quotationsTable).values({ ...header, tenantId, code: "QT-TEMP", status: "draft", customerName: resolvedCustomerName, customerEmail: resolvedCustomerEmail, createdByClerkId: clerkUserId, createdByEmail: userEmail } as typeof quotationsTable.$inferInsert).returning());
  const quotId = quot!.id;
  await withTenantDb(tenantId, (db) => db.update(quotationsTable).set({ code: genCode("QT", quotId) }).where(eq(quotationsTable.id, quotId)));
  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(quotationLinesTable).values(lines.map((l, i) => ({
        ...l, quotationId: quotId, tenantId, lineNumber: l.lineNumber ?? i + 1,
        quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct),
        lineTotal: (l.quantity * l.unitPrice * (1 - l.discountPct / 100)).toFixed(2),
      }) as typeof quotationLinesTable.$inferInsert)));
    await updateQuotationTotals(tenantId, quotId);
  }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.created", entityType: "quotation", entityId: String(quotId), newValues: header });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(eq(quotationsTable.id, quotId)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable).where(eq(quotationLinesTable.quotationId, quotId)).orderBy(quotationLinesTable.lineNumber));
  res.status(201).json({ ...full, lines: fullLines });
});

router.patch("/sales/quotations/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    customerName: z.string().optional(),
    customerEmail: z.string().email().optional(),
    customerRef: z.string().optional(),
    expiryDate: z.string().optional().nullable(),
    requestedDate: z.string().optional().nullable(),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [existing] = await withTenantDb(tenantId, (db) => db.select({ status: quotationsTable.status }).from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!["draft", "sent"].includes(existing.status)) { res.status(400).json({ error: "Cannot edit a quotation that is accepted, rejected, or converted" }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(quotationsTable).set(parsed.data as Record<string, unknown>).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.updated", entityType: "quotation", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/sales/quotations/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [existing] = await withTenantDb(tenantId, (db) => db.select({ status: quotationsTable.status }).from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (existing.status === "converted") { res.status(400).json({ error: "Cannot delete a converted quotation" }); return; }
  await withTenantDb(tenantId, (db) => db.update(quotationsTable).set({ deletedAt: new Date() }).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.deleted", entityType: "quotation", entityId: String(id) });
  res.status(204).send();
});

router.post("/sales/quotations/:id/send", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [quot] = await withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt))).limit(1));
  if (!quot) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!["draft", "sent"].includes(quot.status)) { res.status(400).json({ error: `Cannot send quotation in status: ${quot.status}` }); return; }
  const toEmail = (req.body as { email?: string }).email ?? quot.customerEmail;
  if (!toEmail) { res.status(400).json({ error: "No customer email available. Provide email in request body or set on quotation." }); return; }
  let emailSent = false;
  try {
    emailSent = await sendEmail({ to: toEmail, subject: `Quotation ${quot.code}`, html: `<p>Please find attached quotation <strong>${quot.code}</strong> for your review.</p>`, text: `Quotation ${quot.code} is ready for your review.` });
  } catch { emailSent = false; }
  if (!emailSent) { res.status(502).json({ error: "Email dispatch failed. Quotation status not changed." }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(quotationsTable).set({ status: "sent", sentAt: new Date() }).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.sent", entityType: "quotation", entityId: String(id) });
  res.json({ ...updated, emailSent, sentTo: toEmail });
});

router.post("/sales/quotations/:id/convert", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [quot] = await withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt))).limit(1));
  if (!quot) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!["draft", "sent", "accepted"].includes(quot.status)) { res.status(400).json({ error: `Cannot convert quotation in status: ${quot.status}` }); return; }
  // Idempotency guard
  if (quot.convertedSoId) {
    const [existingSo] = await withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, quot.convertedSoId!), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
    if (existingSo) { res.json({ so: existingSo, alreadyConverted: true }); return; }
  }
  const quotLines = await withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable).where(and(eq(quotationLinesTable.quotationId, id), eq(quotationLinesTable.tenantId, tenantId))).orderBy(quotationLinesTable.lineNumber));
  const so = await withTenantDb(tenantId, async (db) => {
    const [newSo] = await db.insert(salesOrdersTable).values({
      tenantId, code: "SO-TEMP", quotationId: id, customerId: quot.customerId ?? undefined,
      customerName: quot.customerName, customerEmail: quot.customerEmail ?? undefined, customerRef: quot.customerRef ?? undefined,
      currencyCode: quot.currencyCode, paymentTerms: quot.paymentTerms ?? undefined,
      subtotal: quot.subtotal, taxAmount: quot.taxAmount, total: quot.total,
      notes: quot.notes ?? undefined, status: "draft", createdByClerkId: clerkUserId, createdByEmail: userEmail,
    } as typeof salesOrdersTable.$inferInsert).returning();
    const soId = newSo!.id;
    await db.update(salesOrdersTable).set({ code: genCode("SO", soId) }).where(eq(salesOrdersTable.id, soId));
    if (quotLines.length > 0) {
      await db.insert(soLinesTable).values(quotLines.map((l) => ({
        tenantId, soId, lineNumber: l.lineNumber, lineType: l.lineType,
        itemId: l.itemId ?? undefined, itemCode: l.itemCode ?? undefined, itemName: l.itemName ?? undefined,
        description: l.description ?? undefined, quantity: l.quantity, unitOfMeasure: l.unitOfMeasure ?? undefined,
        unitPrice: l.unitPrice, discountPct: l.discountPct ?? "0", taxPct: l.taxPct ?? "0",
        lineTotal: l.lineTotal, glAccountId: l.glAccountId ?? undefined, quotationLineId: l.id, notes: l.notes ?? undefined,
      }) as typeof soLinesTable.$inferInsert));
    }
    await db.update(quotationsTable).set({ status: "converted", convertedSoId: soId }).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId)));
    return (await db.select().from(salesOrdersTable).where(eq(salesOrdersTable.id, soId)).limit(1))[0];
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.converted", entityType: "quotation", entityId: String(id), newValues: { soId: so?.id } });
  res.status(201).json({ so, alreadyConverted: false });
});

// Quotation lines CRUD
router.post("/sales/quotations/:id/lines", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const parsed = quotationLineSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const existing = await withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable).where(and(eq(quotationLinesTable.quotationId, id), eq(quotationLinesTable.tenantId, tenantId))));
  const lineNumber = parsed.data.lineNumber ?? (existing.length > 0 ? Math.max(...existing.map((l) => l.lineNumber)) + 1 : 1);
  const l = parsed.data;
  const [line] = await withTenantDb(tenantId, (db) =>
    db.insert(quotationLinesTable).values({ ...l, quotationId: id, tenantId, lineNumber, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct), lineTotal: (l.quantity * l.unitPrice * (1 - l.discountPct / 100)).toFixed(2) } as typeof quotationLinesTable.$inferInsert).returning());
  await updateQuotationTotals(tenantId, id);
  res.status(201).json(line);
});

router.patch("/sales/quotations/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lineId = Number(req.params.lineId);
  const parsed = quotationLineSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(quotationLinesTable).set({ ...parsed.data, quantity: parsed.data.quantity != null ? String(parsed.data.quantity) : undefined, unitPrice: parsed.data.unitPrice != null ? String(parsed.data.unitPrice) : undefined } as Record<string, unknown>).where(and(eq(quotationLinesTable.id, lineId), eq(quotationLinesTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "Line not found" }); return; }
  await updateQuotationTotals(tenantId, updated.quotationId);
  res.json(updated);
});

router.delete("/sales/quotations/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lineId = Number(req.params.lineId);
  const [deleted] = await withTenantDb(tenantId, (db) => db.delete(quotationLinesTable).where(and(eq(quotationLinesTable.id, lineId), eq(quotationLinesTable.tenantId, tenantId))).returning());
  if (!deleted) { res.status(404).json({ error: "Line not found" }); return; }
  await updateQuotationTotals(tenantId, deleted.quotationId);
  res.status(204).send();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Sales Orders ──────────────────────────────────════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/orders", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, customerId, search, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(salesOrdersTable)
      .where(and(
        eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt),
        status ? eq(salesOrdersTable.status, status) : undefined,
        customerId ? eq(salesOrdersTable.customerId, Number(customerId)) : undefined,
        search ? or(ilike(salesOrdersTable.code, `%${search}%`), ilike(salesOrdersTable.customerName, `%${search}%`)) : undefined,
      ))
      .orderBy(desc(salesOrdersTable.createdAt)).limit(lim + 1).offset(offset));
  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/sales/orders/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [so, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(and(eq(soLinesTable.soId, id), eq(soLinesTable.tenantId, tenantId))).orderBy(soLinesTable.lineNumber)),
  ]);
  if (!so[0]) { res.status(404).json({ error: "Sales order not found" }); return; }
  res.json({ ...so[0], lines });
});

const soLineSchema = z.object({
  lineNumber: z.number().int().optional(),
  lineType: z.enum(["stock", "service", "charge", "comment"]).default("stock"),
  itemId: z.number().int().optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive().default(1),
  unitOfMeasure: z.string().optional(),
  unitPrice: z.number().nonnegative().default(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxPct: z.number().min(0).max(100).default(0),
  glAccountId: z.number().int().optional(),
  notes: z.string().optional(),
});

router.post("/sales/orders", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    customerId: z.number().int().optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().email().optional(),
    customerRef: z.string().optional(),
    warehouseId: z.number().int().optional(),
    requestedDate: z.string().optional(),
    scheduledDate: z.string().optional(),
    currencyCode: z.string().default("AUD"),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
    lines: z.array(soLineSchema).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const { lines, ...header } = parsed.data;

  let resolvedCustomerName = header.customerName;
  let resolvedCustomerEmail = header.customerEmail;
  let creditCheckPassed = true;
  if (header.customerId) {
    const [cust] = await withTenantDb(tenantId, (db) =>
      db.select({ name: customersTable.name, email: customersTable.email, creditLimit: customersTable.creditLimit })
        .from(customersTable)
        .where(and(eq(customersTable.id, header.customerId!), eq(customersTable.tenantId, tenantId)))
        .limit(1));
    resolvedCustomerName = resolvedCustomerName ?? cust?.name;
    resolvedCustomerEmail = resolvedCustomerEmail ?? cust?.email ?? undefined;

    // Hard credit limit enforcement: block SO if customer would exceed their credit limit
    const creditLimit = cust?.creditLimit ? Number(cust.creditLimit) : 0;
    if (creditLimit > 0) {
      // Sum outstanding invoices (total - paid) for non-cancelled/paid statuses
      const [invoiceBalance] = await withTenantDb(tenantId, (db) =>
        db.select({ outstanding: sql<string>`coalesce(sum(total - paid_amount), 0)` })
          .from(customerInvoicesTable)
          .where(and(
            eq(customerInvoicesTable.tenantId, tenantId),
            eq(customerInvoicesTable.customerId, header.customerId!),
            isNull(customerInvoicesTable.deletedAt),
            sql`status NOT IN ('paid','cancelled','void')`,
          )));
      // Sum confirmed/in-progress SO totals (exclude drafts and cancelled)
      const [soBalance] = await withTenantDb(tenantId, (db) =>
        db.select({ outstanding: sql<string>`coalesce(sum(total), 0)` })
          .from(salesOrdersTable)
          .where(and(
            eq(salesOrdersTable.tenantId, tenantId),
            eq(salesOrdersTable.customerId, header.customerId!),
            isNull(salesOrdersTable.deletedAt),
            sql`status NOT IN ('draft','cancelled')`,
          )));
      // Estimate new SO value from lines
      const newSoValue = lines.reduce((acc, l) => acc + (l.quantity * l.unitPrice * (1 - (l.discountPct ?? 0) / 100)), 0);
      const totalExposure = Number(invoiceBalance?.outstanding ?? 0) + Number(soBalance?.outstanding ?? 0) + newSoValue;
      if (totalExposure > creditLimit) {
        creditCheckPassed = false;
        res.status(422).json({
          error: "Credit limit exceeded",
          detail: `Customer credit limit is ${creditLimit.toFixed(2)}. Current exposure including this order would be ${totalExposure.toFixed(2)}.`,
          creditLimit,
          currentExposure: Number(invoiceBalance?.outstanding ?? 0) + Number(soBalance?.outstanding ?? 0),
          newOrderValue: newSoValue,
        });
        return;
      }
    }
  }

  const [so] = await withTenantDb(tenantId, (db) =>
    db.insert(salesOrdersTable).values({ ...header, tenantId, code: "SO-TEMP", status: "draft", customerName: resolvedCustomerName, customerEmail: resolvedCustomerEmail, creditCheckPassed, createdByClerkId: clerkUserId, createdByEmail: userEmail } as typeof salesOrdersTable.$inferInsert).returning());
  const soId = so!.id;
  await withTenantDb(tenantId, (db) => db.update(salesOrdersTable).set({ code: genCode("SO", soId) }).where(eq(salesOrdersTable.id, soId)));
  if (lines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(soLinesTable).values(lines.map((l, i) => ({
        ...l, soId, tenantId, lineNumber: l.lineNumber ?? i + 1,
        quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct),
        lineTotal: (l.quantity * l.unitPrice * (1 - l.discountPct / 100)).toFixed(2),
      }) as typeof soLinesTable.$inferInsert)));
    await updateSoTotals(tenantId, soId);
  }
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "sales_order.created", entityType: "sales_order", entityId: String(soId), newValues: header });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(eq(salesOrdersTable.id, soId)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(eq(soLinesTable.soId, soId)).orderBy(soLinesTable.lineNumber));
  res.status(201).json({ ...full, lines: fullLines });
});

router.patch("/sales/orders/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    customerName: z.string().optional(),
    customerEmail: z.string().email().optional(),
    customerRef: z.string().optional(),
    warehouseId: z.number().int().optional().nullable(),
    requestedDate: z.string().optional().nullable(),
    scheduledDate: z.string().optional().nullable(),
    paymentTerms: z.string().optional(),
    notes: z.string().optional(),
    internalNotes: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [existing] = await withTenantDb(tenantId, (db) => db.select({ status: salesOrdersTable.status }).from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (!["draft", "confirmed"].includes(existing.status)) { res.status(400).json({ error: `Cannot edit SO in status: ${existing.status}` }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(salesOrdersTable).set(parsed.data as Record<string, unknown>).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "sales_order.updated", entityType: "sales_order", entityId: String(id), newValues: parsed.data });
  res.json(updated);
});

router.delete("/sales/orders/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [existing] = await withTenantDb(tenantId, (db) => db.select({ status: salesOrdersTable.status }).from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (!["draft", "cancelled"].includes(existing.status)) { res.status(400).json({ error: "Only draft or cancelled SOs can be deleted" }); return; }
  await withTenantDb(tenantId, (db) => db.update(salesOrdersTable).set({ deletedAt: new Date() }).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "sales_order.deleted", entityType: "sales_order", entityId: String(id) });
  res.status(204).send();
});

router.post("/sales/orders/:id/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [so] = await withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (so.status !== "draft") { res.status(400).json({ error: `SO is already ${so.status}` }); return; }
  const result = await withTenantDb(tenantId, async (db) => {
    const [confirmed] = await db.update(salesOrdersTable).set({ status: "confirmed", confirmedAt: new Date() }).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).returning();
    await allocateStockForSo(db, tenantId, id);
    return confirmed;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "sales_order.confirmed", entityType: "sales_order", entityId: String(id) });
  res.json(result);
});

router.post("/sales/orders/:id/cancel", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [so] = await withTenantDb(tenantId, (db) => db.select({ status: salesOrdersTable.status }).from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (["cancelled", "invoiced", "despatched"].includes(so.status)) { res.status(400).json({ error: `Cannot cancel SO in status: ${so.status}` }); return; }
  const result = await withTenantDb(tenantId, async (db) => {
    await releaseAllocations(db, tenantId, id);
    const [cancelled] = await db.update(salesOrdersTable).set({ status: "cancelled" }).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).returning();
    return cancelled;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "sales_order.cancelled", entityType: "sales_order", entityId: String(id) });
  res.json(result);
});

// SO lines CRUD
router.post("/sales/orders/:id/lines", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const parsed = soLineSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [so] = await withTenantDb(tenantId, (db) => db.select({ status: salesOrdersTable.status }).from(salesOrdersTable).where(and(eq(salesOrdersTable.id, id), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (!["draft", "confirmed"].includes(so.status)) { res.status(400).json({ error: "Cannot add lines to SO in this status" }); return; }
  const existing = await withTenantDb(tenantId, (db) => db.select({ lineNumber: soLinesTable.lineNumber }).from(soLinesTable).where(and(eq(soLinesTable.soId, id), eq(soLinesTable.tenantId, tenantId))));
  const lineNumber = parsed.data.lineNumber ?? (existing.length > 0 ? Math.max(...existing.map((l) => l.lineNumber)) + 1 : 1);
  const l = parsed.data;
  const [line] = await withTenantDb(tenantId, (db) =>
    db.insert(soLinesTable).values({ ...l, soId: id, tenantId, lineNumber, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct), lineTotal: (l.quantity * l.unitPrice * (1 - l.discountPct / 100)).toFixed(2) } as typeof soLinesTable.$inferInsert).returning());
  await updateSoTotals(tenantId, id);
  res.status(201).json(line);
});

router.patch("/sales/orders/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lineId = Number(req.params.lineId);
  const parsed = soLineSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(soLinesTable).set({ ...parsed.data, quantity: parsed.data.quantity != null ? String(parsed.data.quantity) : undefined, unitPrice: parsed.data.unitPrice != null ? String(parsed.data.unitPrice) : undefined } as Record<string, unknown>).where(and(eq(soLinesTable.id, lineId), eq(soLinesTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "Line not found" }); return; }
  await updateSoTotals(tenantId, updated.soId);
  res.json(updated);
});

router.delete("/sales/orders/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const lineId = Number(req.params.lineId);
  const [deleted] = await withTenantDb(tenantId, (db) => db.delete(soLinesTable).where(and(eq(soLinesTable.id, lineId), eq(soLinesTable.tenantId, tenantId))).returning());
  if (!deleted) { res.status(404).json({ error: "Line not found" }); return; }
  await updateSoTotals(tenantId, deleted.soId);
  res.status(204).send();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Pick Slips ────────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/pick-slips", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { soId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable)
      .where(and(eq(pickSlipsTable.tenantId, tenantId),
        soId ? eq(pickSlipsTable.soId, Number(soId)) : undefined,
        status ? eq(pickSlipsTable.status, status) : undefined))
      .orderBy(desc(pickSlipsTable.createdAt)).limit(lim + 1).offset((pg - 1) * lim));
  res.json({ data: rows.slice(0, lim), hasMore: rows.length > lim, page: pg });
});

router.get("/sales/pick-slips/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [slip, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(pickSlipsTable).where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(pickSlipLinesTable).where(and(eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId)))),
  ]);
  if (!slip[0]) { res.status(404).json({ error: "Pick slip not found" }); return; }
  res.json({ ...slip[0], lines });
});

router.post("/sales/pick-slips", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int(),
    warehouseId: z.number().int().optional(),
    notes: z.string().optional(),
    lines: z.array(z.object({
      soLineId: z.number().int(),
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      locationId: z.number().int().optional(),
      requiredQty: z.number().positive(),
      lotNumber: z.string().optional(),
      serialNumber: z.string().optional(),
      batchNumber: z.string().optional(),
      notes: z.string().optional(),
    })).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [so] = await withTenantDb(tenantId, (db) => db.select({ status: salesOrdersTable.status, warehouseId: salesOrdersTable.warehouseId }).from(salesOrdersTable).where(and(eq(salesOrdersTable.id, parsed.data.soId), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (!["confirmed", "picking", "partially_despatched"].includes(so.status)) { res.status(400).json({ error: `Cannot generate pick slip for SO in status: ${so.status}` }); return; }

  // Auto-generate lines from SO if not provided
  let pickLines = parsed.data.lines;
  if (pickLines.length === 0) {
    const soLines = await withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(and(eq(soLinesTable.soId, parsed.data.soId), eq(soLinesTable.tenantId, tenantId))));
    pickLines = soLines.filter((l) => l.lineType === "stock" && Number(l.quantity) > Number(l.despatched_qty)).map((l) => ({
      soLineId: l.id, itemId: l.itemId ?? undefined, itemCode: l.itemCode ?? undefined, itemName: l.itemName ?? undefined,
      requiredQty: Number(l.quantity) - Number(l.despatched_qty),
    }));
  }

  const [slip] = await withTenantDb(tenantId, (db) =>
    db.insert(pickSlipsTable).values({ tenantId, soId: parsed.data.soId, code: "PS-TEMP", status: "pending", warehouseId: parsed.data.warehouseId ?? so.warehouseId ?? undefined, notes: parsed.data.notes, createdByClerkId: clerkUserId } as typeof pickSlipsTable.$inferInsert).returning());
  const slipId = slip!.id;
  await withTenantDb(tenantId, (db) => db.update(pickSlipsTable).set({ code: genCode("PS", slipId) }).where(eq(pickSlipsTable.id, slipId)));
  if (pickLines.length > 0) {
    await withTenantDb(tenantId, (db) => db.insert(pickSlipLinesTable).values(pickLines.map((l) => ({ ...l, tenantId, pickSlipId: slipId, requiredQty: String(l.requiredQty), pickedQty: "0" }) as typeof pickSlipLinesTable.$inferInsert)));
  }
  // Update SO status to "picking"
  await withTenantDb(tenantId, (db) => db.update(salesOrdersTable).set({ status: "picking" }).where(and(eq(salesOrdersTable.id, parsed.data.soId), eq(salesOrdersTable.tenantId, tenantId), eq(salesOrdersTable.status, "confirmed"))));
  const full = (await withTenantDb(tenantId, (db) => db.select().from(pickSlipsTable).where(eq(pickSlipsTable.id, slipId)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(pickSlipLinesTable).where(eq(pickSlipLinesTable.pickSlipId, slipId)));
  res.status(201).json({ ...full, lines: fullLines });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Despatches ────────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/despatches", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { soId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(despatchesTable)
      .where(and(eq(despatchesTable.tenantId, tenantId),
        soId ? eq(despatchesTable.soId, Number(soId)) : undefined,
        status ? eq(despatchesTable.status, status) : undefined))
      .orderBy(desc(despatchesTable.createdAt)).limit(lim + 1).offset((pg - 1) * lim));
  res.json({ data: rows.slice(0, lim), hasMore: rows.length > lim, page: pg });
});

router.get("/sales/despatches/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [despatch, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, id), eq(despatchLinesTable.tenantId, tenantId)))),
  ]);
  if (!despatch[0]) { res.status(404).json({ error: "Despatch not found" }); return; }
  res.json({ ...despatch[0], lines });
});

router.post("/sales/despatches", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int(),
    warehouseId: z.number().int().optional(),
    despatchDate: z.string().optional(),
    trackingNumber: z.string().optional(),
    carrier: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(z.object({
      soLineId: z.number().int(),
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative().optional(),
      locationId: z.number().int().optional(),
      lotNumber: z.string().optional(),
      serialNumber: z.string().optional(),
      batchNumber: z.string().optional(),
      notes: z.string().optional(),
    })).min(1, "At least one line required"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [so] = await withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, parsed.data.soId), eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }
  if (!["confirmed", "picking", "partially_despatched"].includes(so.status)) { res.status(400).json({ error: `Cannot despatch SO in status: ${so.status}` }); return; }

  // Resolve soLine data for any lines missing itemId
  const soLineIds = parsed.data.lines.map((l) => l.soLineId);
  const soLineMap = new Map<number, typeof soLinesTable.$inferSelect>();
  if (soLineIds.length > 0) {
    const soLineRows = await withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(and(inArray(soLinesTable.id, soLineIds), eq(soLinesTable.tenantId, tenantId))));
    for (const sl of soLineRows) soLineMap.set(sl.id, sl);
  }

  const result = await withTenantDb(tenantId, async (db) => {
    const [despatch] = await db.insert(despatchesTable).values({
      tenantId, soId: parsed.data.soId, code: "DSP-TEMP", status: "draft",
      warehouseId: parsed.data.warehouseId ?? so.warehouseId ?? undefined,
      despatchDate: parsed.data.despatchDate ?? undefined,
      trackingNumber: parsed.data.trackingNumber ?? undefined, carrier: parsed.data.carrier ?? undefined,
      notes: parsed.data.notes ?? undefined, despatcedByClerkId: clerkUserId,
    } as typeof despatchesTable.$inferInsert).returning();
    const despatchId = despatch!.id;
    await db.update(despatchesTable).set({ code: genCode("DSP", despatchId) }).where(eq(despatchesTable.id, despatchId));
    await db.insert(despatchLinesTable).values(parsed.data.lines.map((l) => {
      const soLine = soLineMap.get(l.soLineId);
      return {
        tenantId, despatchId, soLineId: l.soLineId,
        itemId: l.itemId ?? soLine?.itemId ?? undefined,
        itemCode: l.itemCode ?? soLine?.itemCode ?? undefined,
        itemName: l.itemName ?? soLine?.itemName ?? undefined,
        quantity: String(l.quantity), unitPrice: String(l.unitPrice ?? soLine?.unitPrice ?? 0),
        locationId: l.locationId ?? undefined, lotNumber: l.lotNumber ?? undefined,
        serialNumber: l.serialNumber ?? undefined, batchNumber: l.batchNumber ?? undefined, notes: l.notes ?? undefined,
      } as typeof despatchLinesTable.$inferInsert;
    }));
    return { despatchId };
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "despatch.created", entityType: "despatch", entityId: String(result.despatchId), newValues: { soId: parsed.data.soId } });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(eq(despatchesTable.id, result.despatchId)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(despatchLinesTable).where(eq(despatchLinesTable.despatchId, result.despatchId)));
  res.status(201).json({ ...full, lines: fullLines });
});

router.post("/sales/despatches/:id/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [despatch] = await withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).limit(1));
  if (!despatch) { res.status(404).json({ error: "Despatch not found" }); return; }
  if (despatch.status !== "draft") { res.status(400).json({ error: "Despatch is already confirmed" }); return; }
  if (!despatch.warehouseId) { res.status(400).json({ error: "Despatch has no warehouse; cannot post inventory" }); return; }

  const lines = await withTenantDb(tenantId, (db) => db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, id), eq(despatchLinesTable.tenantId, tenantId))));

  const result = await withTenantDb(tenantId, async (db) => {
    // 1. Decrement inventory stock and create movements
    for (const line of lines) {
      const resolvedItemId = line.itemId;
      if (!resolvedItemId || Number(line.quantity) <= 0) continue;
      const qty = Number(line.quantity);
      const warehouseId = despatch.warehouseId!;
      const locationId = line.locationId ?? null;

      // Find stock bucket
      const [stock] = await db.select().from(inventoryStockTable)
        .where(and(eq(inventoryStockTable.tenantId, tenantId), eq(inventoryStockTable.itemId, resolvedItemId),
          eq(inventoryStockTable.warehouseId, warehouseId),
          locationId ? eq(inventoryStockTable.locationId, locationId) : isNull(inventoryStockTable.locationId)))
        .limit(1);

      if (stock) {
        const unitCostForMovement = line.unitCost ?? stock.averageCost ?? undefined;
        await db.update(inventoryStockTable)
          .set({ qtyOnHand: sql`GREATEST(0, ${inventoryStockTable.qtyOnHand} - ${qty.toFixed(4)})`, qtyReserved: sql`GREATEST(0, ${inventoryStockTable.qtyReserved} - ${qty.toFixed(4)})`, lastMovementAt: new Date() })
          .where(and(eq(inventoryStockTable.id, stock.id), eq(inventoryStockTable.tenantId, tenantId)));
        // Update despatch line unit cost from average cost if missing
        if (!line.unitCost && stock.averageCost) {
          await db.update(despatchLinesTable).set({ unitCost: stock.averageCost }).where(and(eq(despatchLinesTable.id, line.id), eq(despatchLinesTable.tenantId, tenantId)));
        }
        await db.insert(inventoryMovementsTable).values({
          tenantId, itemId: resolvedItemId, warehouseId, locationId: locationId ?? undefined,
          movementType: "issue", quantity: (-qty).toFixed(4), unitCost: unitCostForMovement ?? undefined,
          refType: "so_despatch", refId: id, lotNumber: line.lotNumber ?? undefined,
          serialNumber: line.serialNumber ?? undefined, batchNumber: line.batchNumber ?? undefined, postedByClerkId: clerkUserId,
        } as typeof inventoryMovementsTable.$inferInsert);
      }

      // Update SO line despatched_qty
      await db.update(soLinesTable).set({ despatched_qty: sql`${soLinesTable.despatched_qty} + ${qty.toFixed(4)}` })
        .where(and(eq(soLinesTable.id, line.soLineId), eq(soLinesTable.tenantId, tenantId)));
    }

    // 2. Post GL
    const posting = await createDespatchGlPosting(db, tenantId, id, clerkUserId, userEmail);

    // 3. Confirm despatch
    const [confirmed] = await db.update(despatchesTable).set({ status: "confirmed", despatchedAt: new Date(), glPostingId: posting?.id ?? undefined })
      .where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).returning();

    // 4. Recalculate SO status
    await recalcSoStatus(db, tenantId, despatch.soId);

    // 5. Auto-create backorder records for SO lines still partially unfulfilled
    const soLines = await db.select().from(soLinesTable)
      .where(and(eq(soLinesTable.soId, despatch.soId), eq(soLinesTable.tenantId, tenantId)));
    const [so] = await db.select({ customerId: salesOrdersTable.customerId, customerName: salesOrdersTable.customerName })
      .from(salesOrdersTable).where(eq(salesOrdersTable.id, despatch.soId)).limit(1);
    for (const soLine of soLines) {
      if (soLine.lineType !== "stock") continue;
      const ordered = Number(soLine.quantity);
      const despatched = Number(soLine.despatched_qty ?? 0);
      const remainingQty = ordered - despatched;
      if (remainingQty <= 0.0001) continue;
      // Check if an open backorder already exists for this SO line to avoid duplicates
      const [existingBo] = await db.select({ id: backordersTable.id, backorderQty: backordersTable.backorderQty })
        .from(backordersTable)
        .where(and(eq(backordersTable.soLineId, soLine.id), eq(backordersTable.tenantId, tenantId), eq(backordersTable.status, "open")))
        .limit(1);
      if (existingBo) {
        // Update existing backorder quantity to reflect new remaining amount
        await db.update(backordersTable)
          .set({ backorderQty: remainingQty.toFixed(4), updatedAt: new Date() })
          .where(and(eq(backordersTable.id, existingBo.id), eq(backordersTable.tenantId, tenantId)));
      } else {
        const [maxBo] = await db.select({ maxId: sql<number>`coalesce(max(id),0)` }).from(backordersTable);
        const boSeq = (maxBo?.maxId ?? 0) + 1;
        await db.insert(backordersTable).values({
          tenantId, code: `BO-${String(boSeq).padStart(5, "0")}`,
          soId: despatch.soId, soLineId: soLine.id,
          customerId: so?.customerId ?? undefined, customerName: so?.customerName ?? undefined,
          itemId: soLine.itemId ?? undefined, itemCode: soLine.itemCode ?? undefined, itemName: soLine.itemName ?? undefined,
          orderedQty: ordered.toFixed(4), backorderQty: remainingQty.toFixed(4), releasedQty: despatched.toFixed(4),
          unitPrice: soLine.unitPrice ?? undefined, status: "open",
        } as typeof backordersTable.$inferInsert);
      }
    }

    return confirmed;
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "despatch.confirmed", entityType: "despatch", entityId: String(id) });
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Customer Invoices ─────────────────────────────════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/invoices", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { soId, status, customerId, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(customerInvoicesTable)
      .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt),
        soId ? eq(customerInvoicesTable.soId, Number(soId)) : undefined,
        status ? eq(customerInvoicesTable.status, status) : undefined,
        customerId ? eq(customerInvoicesTable.customerId, Number(customerId)) : undefined))
      .orderBy(desc(customerInvoicesTable.createdAt)).limit(lim + 1).offset((pg - 1) * lim));
  res.json({ data: rows.slice(0, lim), hasMore: rows.length > lim, page: pg });
});

router.get("/sales/invoices/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [invoice, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(customerInvoicesTable).where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(customerInvoiceLinesTable).where(and(eq(customerInvoiceLinesTable.invoiceId, id), eq(customerInvoiceLinesTable.tenantId, tenantId)))),
  ]);
  if (!invoice[0]) { res.status(404).json({ error: "Invoice not found" }); return; }
  res.json({ ...invoice[0], lines });
});

router.get("/sales/invoices/:id/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [[invoice], lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(customerInvoicesTable).where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(customerInvoiceLinesTable).where(and(eq(customerInvoiceLinesTable.invoiceId, id), eq(customerInvoiceLinesTable.tenantId, tenantId)))),
  ]);
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  const linesHtml = lines.map((l) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${l.itemCode ?? ""}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${l.description ?? l.itemName ?? ""}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.quantity).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.unitPrice).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.discountPct ?? 0).toFixed(1)}%</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.taxPct ?? 0).toFixed(1)}%</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:500">${Number(l.lineTotal ?? 0).toFixed(2)}</td>
    </tr>`).join("");
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invoice ${invoice.code ?? id}</title>
  <style>
    body{font-family:Arial,sans-serif;color:#111;margin:0;padding:32px;font-size:14px}
    .header{display:flex;justify-content:space-between;margin-bottom:32px}
    .title{font-size:28px;font-weight:700;color:#1e40af;letter-spacing:-1px}
    .badge{display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:600;background:#dbeafe;color:#1d4ed8}
    table{width:100%;border-collapse:collapse;margin-top:24px}
    th{background:#f8fafc;padding:8px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;border-bottom:2px solid #e5e7eb}
    th:not(:first-child){text-align:right}
    .totals td{padding:6px 8px;border-bottom:1px solid #f3f4f6}
    .grand{font-size:16px;font-weight:700}
    @media print{body{padding:16px}}
  </style></head><body>
  <div class="header">
    <div>
      <div class="title">TAX INVOICE</div>
      <div style="margin-top:8px;font-size:20px;font-weight:600">${invoice.code ?? "INV-" + id}</div>
      <div style="margin-top:4px;color:#6b7280">Date: ${invoice.invoiceDate ?? invoice.createdAt?.toString().slice(0, 10) ?? ""}</div>
      ${invoice.dueDate ? `<div style="color:#6b7280">Due: ${invoice.dueDate}</div>` : ""}
    </div>
    <div style="text-align:right">
      <span class="badge">${invoice.status?.toUpperCase() ?? "ISSUED"}</span>
      ${invoice.soId ? `<div style="margin-top:8px;color:#6b7280">Sales Order: SO-${invoice.soId}</div>` : ""}
    </div>
  </div>
  <div style="display:flex;gap:48px;margin-bottom:24px">
    <div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Bill To</div>
      <div style="font-weight:600">${invoice.customerName ?? ""}</div>
      ${invoice.customerName ? `<div style="color:#6b7280;font-size:12px">SO-${invoice.soId ?? ""}</div>` : ""}
    </div>
  </div>
  <table>
    <thead><tr>
      <th>Code</th><th>Description</th>
      <th style="text-align:right">Qty</th><th style="text-align:right">Unit Price</th>
      <th style="text-align:right">Disc%</th><th style="text-align:right">Tax%</th>
      <th style="text-align:right">Line Total</th>
    </tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>
  <div style="margin-top:24px;display:flex;justify-content:flex-end">
    <table style="width:280px" class="totals">
      <tr><td>Subtotal</td><td style="text-align:right">${invoice.currencyCode ?? "AUD"} ${Number(invoice.subtotal ?? 0).toFixed(2)}</td></tr>
      <tr><td>Tax</td><td style="text-align:right">${invoice.currencyCode ?? "AUD"} ${Number(invoice.taxAmount ?? 0).toFixed(2)}</td></tr>
      <tr class="grand"><td>Total</td><td style="text-align:right">${invoice.currencyCode ?? "AUD"} ${Number(invoice.total ?? 0).toFixed(2)}</td></tr>
      ${Number(invoice.paidAmount ?? 0) > 0 ? `<tr><td>Paid</td><td style="text-align:right">${invoice.currencyCode ?? "AUD"} ${Number(invoice.paidAmount).toFixed(2)}</td></tr>
      <tr class="grand" style="color:#dc2626"><td>Balance Due</td><td style="text-align:right">${invoice.currencyCode ?? "AUD"} ${(Number(invoice.total ?? 0) - Number(invoice.paidAmount ?? 0)).toFixed(2)}</td></tr>` : ""}
    </table>
  </div>
  ${invoice.notes ? `<div style="margin-top:32px;padding:16px;background:#f8fafc;border-radius:8px"><strong>Notes:</strong> ${invoice.notes}</div>` : ""}
  <div style="margin-top:40px;text-align:center;font-size:11px;color:#9ca3af">Generated by Forge ERP</div>
  <script>window.onload = () => window.print();</script>
</body></html>`;
  res.setHeader("Content-Type", "text/html");
  res.send(html);
});

router.post("/sales/invoices", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int(),
    despatchId: z.number().int().optional(),
    invoiceDate: z.string().optional(),
    dueDate: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(z.object({
      soLineId: z.number().int().optional(),
      despatchLineId: z.number().int().optional(),
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative(),
      discountPct: z.number().min(0).max(100).default(0),
      taxPct: z.number().min(0).max(100).default(0),
      notes: z.string().optional(),
    })).min(1, "At least one line required"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [so] = await withTenantDb(tenantId, (db) => db.select().from(salesOrdersTable).where(and(eq(salesOrdersTable.id, parsed.data.soId), eq(salesOrdersTable.tenantId, tenantId))).limit(1));
  if (!so) { res.status(404).json({ error: "Sales order not found" }); return; }

  let subtotal = 0; let taxAmount = 0;
  const lineValues = parsed.data.lines.map((l) => {
    const base = l.quantity * l.unitPrice * (1 - l.discountPct / 100);
    const tax = base * (l.taxPct / 100);
    subtotal += base; taxAmount += tax;
    return { ...l, lineTotal: (base + tax).toFixed(2) };
  });
  const total = subtotal + taxAmount;

  const result = await withTenantDb(tenantId, async (db) => {
    const [invoice] = await db.insert(customerInvoicesTable).values({
      tenantId, soId: parsed.data.soId, despatchId: parsed.data.despatchId ?? undefined,
      code: "INV-TEMP", status: "draft", customerId: so.customerId ?? undefined,
      customerName: so.customerName ?? undefined, customerEmail: so.customerEmail ?? undefined,
      invoiceDate: parsed.data.invoiceDate ?? new Date().toISOString().split("T")[0],
      dueDate: parsed.data.dueDate ?? undefined, currencyCode: so.currencyCode,
      subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: total.toFixed(2),
      notes: parsed.data.notes ?? undefined, createdByClerkId: clerkUserId, createdByEmail: userEmail,
    } as typeof customerInvoicesTable.$inferInsert).returning();
    const invoiceId = invoice!.id;
    await db.update(customerInvoicesTable).set({ code: genCode("INV", invoiceId) }).where(eq(customerInvoicesTable.id, invoiceId));
    await db.insert(customerInvoiceLinesTable).values(lineValues.map((l) => ({ ...l, tenantId, invoiceId, quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct) }) as typeof customerInvoiceLinesTable.$inferInsert));
    // Update SO line invoiced_qty
    for (const l of parsed.data.lines) {
      if (l.soLineId) {
        await db.update(soLinesTable).set({ invoiced_qty: sql`${soLinesTable.invoiced_qty} + ${String(l.quantity)}` })
          .where(and(eq(soLinesTable.id, l.soLineId), eq(soLinesTable.tenantId, tenantId)));
      }
    }
    await recalcSoStatus(db, tenantId, parsed.data.soId);
    return invoiceId;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "invoice.created", entityType: "customer_invoice", entityId: String(result), newValues: { soId: parsed.data.soId } });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(customerInvoicesTable).where(eq(customerInvoicesTable.id, result)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(customerInvoiceLinesTable).where(eq(customerInvoiceLinesTable.invoiceId, result)));
  res.status(201).json({ ...full, lines: fullLines });
});

router.post("/sales/invoices/:id/send", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [invoice] = await withTenantDb(tenantId, (db) => db.select().from(customerInvoicesTable).where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId))).limit(1));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (!["draft", "sent"].includes(invoice.status)) { res.status(400).json({ error: `Cannot send invoice in status: ${invoice.status}` }); return; }
  const toEmail = (req.body as { email?: string }).email ?? invoice.customerEmail;
  if (!toEmail) { res.status(400).json({ error: "No customer email available" }); return; }
  let emailSent = false;
  try {
    emailSent = await sendEmail({ to: toEmail, subject: `Invoice ${invoice.code} - ${invoice.total}`, html: `<p>Please find your invoice <strong>${invoice.code}</strong> for amount <strong>${invoice.currencyCode} ${Number(invoice.total).toFixed(2)}</strong>.</p>`, text: `Invoice ${invoice.code} for ${invoice.currencyCode} ${Number(invoice.total).toFixed(2)}` });
  } catch { emailSent = false; }
  if (!emailSent) { res.status(502).json({ error: "Email dispatch failed. Invoice status not changed." }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(customerInvoicesTable).set({ status: "sent", sentAt: new Date() }).where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "invoice.sent", entityType: "customer_invoice", entityId: String(id) });
  res.json({ ...updated, emailSent, sentTo: toEmail });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Credit Notes ──────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/credit-notes", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { soId, status, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(creditNotesTable)
      .where(and(eq(creditNotesTable.tenantId, tenantId),
        soId ? eq(creditNotesTable.soId, Number(soId)) : undefined,
        status ? eq(creditNotesTable.status, status) : undefined))
      .orderBy(desc(creditNotesTable.createdAt)).limit(lim + 1).offset((pg - 1) * lim));
  res.json({ data: rows.slice(0, lim), hasMore: rows.length > lim, page: pg });
});

router.post("/sales/credit-notes", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int().optional(),
    invoiceId: z.number().int().optional(),
    rmaId: z.number().int().optional(),
    customerId: z.number().int().optional(),
    customerName: z.string().optional(),
    reason: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(z.object({
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      description: z.string().optional(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative(),
      taxPct: z.number().min(0).max(100).default(0),
      notes: z.string().optional(),
    })).min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  let subtotal = 0; let taxAmount = 0;
  const lineValues = parsed.data.lines.map((l) => {
    const base = l.quantity * l.unitPrice; const tax = base * (l.taxPct / 100);
    subtotal += base; taxAmount += tax;
    return { ...l, lineTotal: (base + tax).toFixed(2) };
  });
  const result = await withTenantDb(tenantId, async (db) => {
    const [cn] = await db.insert(creditNotesTable).values({ tenantId, code: "CN-TEMP", status: "draft", soId: parsed.data.soId ?? undefined, invoiceId: parsed.data.invoiceId ?? undefined, rmaId: parsed.data.rmaId ?? undefined, customerId: parsed.data.customerId ?? undefined, customerName: parsed.data.customerName ?? undefined, reason: parsed.data.reason ?? undefined, notes: parsed.data.notes ?? undefined, subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: (subtotal + taxAmount).toFixed(2), createdByClerkId: clerkUserId, createdByEmail: userEmail } as typeof creditNotesTable.$inferInsert).returning();
    const cnId = cn!.id;
    await db.update(creditNotesTable).set({ code: genCode("CN", cnId) }).where(eq(creditNotesTable.id, cnId));
    await db.insert(creditNoteLinesTable).values(lineValues.map((l) => ({ ...l, tenantId, creditNoteId: cnId, quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxPct: String(l.taxPct) }) as typeof creditNoteLinesTable.$inferInsert));
    return cnId;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "credit_note.created", entityType: "credit_note", entityId: String(result) });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(creditNotesTable).where(eq(creditNotesTable.id, result)).limit(1)))[0];
  res.status(201).json(full);
});

router.post("/sales/credit-notes/:id/issue", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [cn] = await withTenantDb(tenantId, (db) => db.select().from(creditNotesTable).where(and(eq(creditNotesTable.id, id), eq(creditNotesTable.tenantId, tenantId))).limit(1));
  if (!cn) { res.status(404).json({ error: "Credit note not found" }); return; }
  if (cn.status !== "draft") { res.status(400).json({ error: "Credit note is not in draft status" }); return; }
  const result = await withTenantDb(tenantId, async (db) => {
    const posting = await createCreditNoteGlPosting(db, tenantId, id, clerkUserId, userEmail);
    const [updated] = await db.update(creditNotesTable).set({ status: "issued", issuedAt: new Date(), glPostingId: posting?.id ?? undefined }).where(and(eq(creditNotesTable.id, id), eq(creditNotesTable.tenantId, tenantId))).returning();
    return updated;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "credit_note.issued", entityType: "credit_note", entityId: String(id) });
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── RMA (Returns) ─────────────────────────────════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/rma", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, customerId, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(rmaOrdersTable)
      .where(and(eq(rmaOrdersTable.tenantId, tenantId), isNull(rmaOrdersTable.deletedAt),
        status ? eq(rmaOrdersTable.status, status) : undefined,
        customerId ? eq(rmaOrdersTable.customerId, Number(customerId)) : undefined))
      .orderBy(desc(rmaOrdersTable.createdAt)).limit(lim + 1).offset((pg - 1) * lim));
  res.json({ data: rows.slice(0, lim), hasMore: rows.length > lim, page: pg });
});

router.get("/sales/rma/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [rma, lines] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).limit(1)),
    withTenantDb(tenantId, (db) => db.select().from(rmaLinesTable).where(and(eq(rmaLinesTable.rmaId, id), eq(rmaLinesTable.tenantId, tenantId)))),
  ]);
  if (!rma[0]) { res.status(404).json({ error: "RMA not found" }); return; }
  res.json({ ...rma[0], lines });
});

router.post("/sales/rma", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int().optional(),
    invoiceId: z.number().int().optional(),
    customerId: z.number().int().optional(),
    customerName: z.string().optional(),
    customerEmail: z.string().email().optional(),
    warehouseId: z.number().int().optional(),
    reason: z.string().optional(),
    resolution: z.enum(["credit", "exchange", "repair"]).default("credit"),
    notes: z.string().optional(),
    lines: z.array(z.object({
      soLineId: z.number().int().optional(),
      itemId: z.number().int().optional(),
      itemCode: z.string().optional(),
      itemName: z.string().optional(),
      quantity: z.number().positive(),
      unitPrice: z.number().nonnegative().optional(),
      condition: z.enum(["good", "damaged", "unknown"]).default("unknown"),
      disposition: z.enum(["restock", "scrap", "return_to_supplier"]).default("restock"),
      warehouseId: z.number().int().optional(),
      locationId: z.number().int().optional(),
      reason: z.string().optional(),
      notes: z.string().optional(),
    })).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const { lines, ...header } = parsed.data;
  const result = await withTenantDb(tenantId, async (db) => {
    const [rma] = await db.insert(rmaOrdersTable).values({ ...header, tenantId, code: "RMA-TEMP", status: "draft", createdByClerkId: clerkUserId, createdByEmail: userEmail } as typeof rmaOrdersTable.$inferInsert).returning();
    const rmaId = rma!.id;
    await db.update(rmaOrdersTable).set({ code: genCode("RMA", rmaId) }).where(eq(rmaOrdersTable.id, rmaId));
    if (lines.length > 0) {
      await db.insert(rmaLinesTable).values(lines.map((l) => ({ ...l, tenantId, rmaId, quantity: String(l.quantity), unitPrice: l.unitPrice != null ? String(l.unitPrice) : undefined }) as typeof rmaLinesTable.$inferInsert));
    }
    return rmaId;
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "rma.created", entityType: "rma_order", entityId: String(result) });
  const full = (await withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(eq(rmaOrdersTable.id, result)).limit(1)))[0];
  const fullLines = await withTenantDb(tenantId, (db) => db.select().from(rmaLinesTable).where(eq(rmaLinesTable.rmaId, result)));
  res.status(201).json({ ...full, lines: fullLines });
});

router.post("/sales/rma/:id/authorize", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [rma] = await withTenantDb(tenantId, (db) => db.select({ status: rmaOrdersTable.status }).from(rmaOrdersTable).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).limit(1));
  if (!rma) { res.status(404).json({ error: "RMA not found" }); return; }
  if (rma.status !== "draft") { res.status(400).json({ error: "RMA is not in draft status" }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(rmaOrdersTable).set({ status: "authorized", authorizedAt: new Date() }).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "rma.authorized", entityType: "rma_order", entityId: String(id) });
  res.json(updated);
});

router.post("/sales/rma/:id/receive", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [rma] = await withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).limit(1));
  if (!rma) { res.status(404).json({ error: "RMA not found" }); return; }
  if (rma.status !== "authorized") { res.status(400).json({ error: "RMA must be authorized before receiving" }); return; }

  const schema = z.object({
    lines: z.array(z.object({ rmaLineId: z.number().int(), receivedQty: z.number().nonnegative() })).default([]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }

  await withTenantDb(tenantId, async (db) => {
    const rmaLines = await db.select().from(rmaLinesTable).where(and(eq(rmaLinesTable.rmaId, id), eq(rmaLinesTable.tenantId, tenantId)));
    for (const update of parsed.data.lines) {
      const rmaLine = rmaLines.find((l) => l.id === update.rmaLineId);
      if (!rmaLine) continue;
      await db.update(rmaLinesTable).set({ receivedQty: String(update.receivedQty) }).where(and(eq(rmaLinesTable.id, update.rmaLineId), eq(rmaLinesTable.tenantId, tenantId)));
      // Return to stock if disposition is "restock" and itemId is set
      if (rmaLine.disposition === "restock" && rmaLine.itemId && rmaLine.warehouseId && update.receivedQty > 0) {
        const [existing] = await db.select().from(inventoryStockTable)
          .where(and(eq(inventoryStockTable.tenantId, tenantId), eq(inventoryStockTable.itemId, rmaLine.itemId), eq(inventoryStockTable.warehouseId, rmaLine.warehouseId),
            rmaLine.locationId ? eq(inventoryStockTable.locationId, rmaLine.locationId) : isNull(inventoryStockTable.locationId))).limit(1);
        if (existing) {
          await db.update(inventoryStockTable).set({ qtyOnHand: sql`${inventoryStockTable.qtyOnHand} + ${String(update.receivedQty)}`, lastMovementAt: new Date() }).where(and(eq(inventoryStockTable.id, existing.id), eq(inventoryStockTable.tenantId, tenantId)));
        } else {
          await db.insert(inventoryStockTable).values({ tenantId, itemId: rmaLine.itemId, warehouseId: rmaLine.warehouseId, locationId: rmaLine.locationId ?? undefined, qtyOnHand: String(update.receivedQty), lastMovementAt: new Date() } as typeof inventoryStockTable.$inferInsert);
        }
        await db.insert(inventoryMovementsTable).values({ tenantId, itemId: rmaLine.itemId, warehouseId: rmaLine.warehouseId, locationId: rmaLine.locationId ?? undefined, movementType: "receipt", quantity: String(update.receivedQty), refType: "rma", refId: id, postedByClerkId: clerkUserId } as typeof inventoryMovementsTable.$inferInsert);
      }
    }
    await db.update(rmaOrdersTable).set({ status: "received", receivedAt: new Date() }).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId)));
  });
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "rma.received", entityType: "rma_order", entityId: String(id) });
  const [updated] = await withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(eq(rmaOrdersTable.id, id)).limit(1));
  res.json(updated);
});

router.post("/sales/rma/:id/process", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [rma] = await withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).limit(1));
  if (!rma) { res.status(404).json({ error: "RMA not found" }); return; }
  if (rma.status !== "received") { res.status(400).json({ error: "RMA must be received before processing" }); return; }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(rmaOrdersTable).set({ status: "processed" }).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "rma.processed", entityType: "rma_order", entityId: String(id) });
  res.json(updated);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Backorders ──────────────────────────────────────────────────────────────

router.get("/sales/backorders", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { status, soId, customerId, limit = "50", page = "1" } = req.query as Record<string, string>;
  const lim = Math.min(Number(limit), 200);
  const pg = Math.max(Number(page), 1);
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(backordersTable)
      .where(and(
        eq(backordersTable.tenantId, tenantId),
        isNull(backordersTable.deletedAt),
        status ? eq(backordersTable.status, status) : undefined,
        soId ? eq(backordersTable.soId, Number(soId)) : undefined,
        customerId ? eq(backordersTable.customerId, Number(customerId)) : undefined,
      ))
      .orderBy(desc(backordersTable.createdAt))
      .limit(lim + 1).offset((pg - 1) * lim));
  const hasMore = rows.length > lim;
  res.json({ data: rows.slice(0, lim), hasMore, page: pg });
});

router.get("/sales/backorders/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [bo] = await withTenantDb(tenantId, (db) =>
    db.select().from(backordersTable).where(and(eq(backordersTable.id, id), eq(backordersTable.tenantId, tenantId))).limit(1));
  if (!bo) { res.status(404).json({ error: "Backorder not found" }); return; }
  res.json(bo);
});

router.post("/sales/backorders/:id/release", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({ releaseQty: z.number().positive().optional(), notes: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [bo] = await withTenantDb(tenantId, (db) =>
    db.select().from(backordersTable).where(and(eq(backordersTable.id, id), eq(backordersTable.tenantId, tenantId))).limit(1));
  if (!bo) { res.status(404).json({ error: "Backorder not found" }); return; }
  if (bo.status !== "open") { res.status(400).json({ error: `Backorder is already ${bo.status}` }); return; }
  const currentBackorder = Number(bo.backorderQty);
  const releaseQty = parsed.data.releaseQty ?? currentBackorder;
  if (releaseQty > currentBackorder) { res.status(400).json({ error: `Release qty (${releaseQty}) exceeds outstanding backorder qty (${currentBackorder})` }); return; }
  const newBackorderQty = currentBackorder - releaseQty;
  const newStatus = newBackorderQty <= 0.0001 ? "released" : "open";
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(backordersTable).set({
      backorderQty: newBackorderQty.toFixed(4),
      releasedQty: sql`${backordersTable.releasedQty} + ${releaseQty.toFixed(4)}`,
      status: newStatus,
      releasedAt: newStatus === "released" ? new Date() : undefined,
      releasedByClerkId: newStatus === "released" ? clerkUserId : undefined,
      notes: parsed.data.notes ?? bo.notes ?? undefined,
    }).where(and(eq(backordersTable.id, id), eq(backordersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "backorder.released", entityType: "backorder", entityId: String(id), newValues: { releaseQty, newStatus } });
  res.json(updated);
});

router.patch("/sales/backorders/:id/cancel", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [bo] = await withTenantDb(tenantId, (db) =>
    db.select().from(backordersTable).where(and(eq(backordersTable.id, id), eq(backordersTable.tenantId, tenantId))).limit(1));
  if (!bo) { res.status(404).json({ error: "Backorder not found" }); return; }
  if (!["open"].includes(bo.status)) { res.status(400).json({ error: `Cannot cancel backorder in status: ${bo.status}` }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(backordersTable).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(backordersTable.id, id), eq(backordersTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "backorder.cancelled", entityType: "backorder", entityId: String(id) });
  res.json(updated);
});

// ── Reports ───────────────────────────────────────────────────════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/reports/summary", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const [totalOrders, totalDespatched, totalInvoiced, openQuotes, pendingRma] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(salesOrdersTable).where(and(eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt), fromDate ? sql`created_at >= ${fromDate}` : undefined, toDate ? sql`created_at <= ${toDate}` : undefined))),
    withTenantDb(tenantId, (db) => db.select({ count: sql<number>`count(*)` }).from(despatchesTable).where(and(eq(despatchesTable.tenantId, tenantId), eq(despatchesTable.status, "confirmed"), fromDate ? sql`created_at >= ${fromDate}` : undefined, toDate ? sql`created_at <= ${toDate}` : undefined))),
    withTenantDb(tenantId, (db) => db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(customerInvoicesTable).where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), fromDate ? sql`created_at >= ${fromDate}` : undefined, toDate ? sql`created_at <= ${toDate}` : undefined))),
    withTenantDb(tenantId, (db) => db.select({ count: sql<number>`count(*)` }).from(quotationsTable).where(and(eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt), eq(quotationsTable.status, "sent")))),
    withTenantDb(tenantId, (db) => db.select({ count: sql<number>`count(*)` }).from(rmaOrdersTable).where(and(eq(rmaOrdersTable.tenantId, tenantId), isNull(rmaOrdersTable.deletedAt), sql`status NOT IN ('processed','closed')`))),
  ]);
  res.json({
    orders: { count: Number(totalOrders[0]?.count ?? 0), total: Number(totalOrders[0]?.total ?? 0) },
    despatches: { count: Number(totalDespatched[0]?.count ?? 0) },
    invoices: { count: Number(totalInvoiced[0]?.count ?? 0), total: Number(totalInvoiced[0]?.total ?? 0) },
    openQuotations: Number(openQuotes[0]?.count ?? 0),
    pendingRma: Number(pendingRma[0]?.count ?? 0),
  });
});

router.get("/sales/reports/backorders", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({ soId: soLinesTable.soId, soLineId: soLinesTable.id, itemCode: soLinesTable.itemCode, itemName: soLinesTable.itemName, qty: soLinesTable.quantity, despatched: soLinesTable.despatched_qty, backorderQty: sql<string>`${soLinesTable.quantity} - ${soLinesTable.despatched_qty}` })
      .from(soLinesTable)
      .where(and(eq(soLinesTable.tenantId, tenantId), eq(soLinesTable.lineType, "stock"), sql`${soLinesTable.despatched_qty} < ${soLinesTable.quantity}`))
      .orderBy(soLinesTable.soId));
  res.json(rows);
});

router.get("/sales/reports/outstanding-invoices", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(customerInvoicesTable)
      .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), or(eq(customerInvoicesTable.status, "sent"), eq(customerInvoicesTable.status, "draft"))))
      .orderBy(customerInvoicesTable.dueDate));
  res.json(rows);
});

export default router;

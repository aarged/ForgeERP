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
  warehouseLocationsTable,
  itemsTable,
  glAccountsTable,
  notificationsTable,
  tenantsTable,
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
import { logger } from "../lib/logger";
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function genCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(6, "0")}`;
}

/** Escape user-supplied strings before embedding in HTML to prevent stored XSS. */
function escapeHtml(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/** Release all non-released allocations for an SO.
 *  Each allocation is released against the exact stock bucket
 *  (tenant + warehouse + item + location) so multi-bin setups cannot
 *  over-release a wrong bucket.
 */
async function releaseAllocations(db: TenantDb, tenantId: number, soId: number) {
  const allocs = await db.select().from(soAllocationsTable)
    .where(and(eq(soAllocationsTable.soId, soId), eq(soAllocationsTable.tenantId, tenantId), eq(soAllocationsTable.isReleased, false)));
  for (const alloc of allocs) {
    const qty = Number(alloc.allocatedQty);
    const locationPredicate = alloc.locationId != null
      ? eq(inventoryStockTable.locationId, alloc.locationId)
      : isNull(inventoryStockTable.locationId);
    await db.update(inventoryStockTable)
      .set({ qtyReserved: sql`GREATEST(0, ${inventoryStockTable.qtyReserved} - ${qty.toFixed(4)})` })
      .where(and(
        eq(inventoryStockTable.tenantId, tenantId),
        eq(inventoryStockTable.warehouseId, alloc.warehouseId),
        eq(inventoryStockTable.itemId, alloc.itemId),
        locationPredicate,
      ));
    await db.update(soAllocationsTable).set({ isReleased: true, releasedAt: new Date() })
      .where(and(eq(soAllocationsTable.id, alloc.id), eq(soAllocationsTable.tenantId, tenantId)));
  }
}

/**
 * Post despatch GL: Dr COGS / Cr Inventory (inventory movement only).
 * Revenue/AR recognition is deferred to invoice creation to correctly handle
 * service items that may be invoiced without a physical despatch.
 */
async function createDespatchGlPosting(db: TenantDb, tenantId: number, despatchId: number, postedByClerkId: string, postedByEmail?: string) {
  const despatch = (await db.select().from(despatchesTable).where(and(eq(despatchesTable.id, despatchId), eq(despatchesTable.tenantId, tenantId))).limit(1))[0];
  if (!despatch) return null;
  const lines = await db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, despatchId), eq(despatchLinesTable.tenantId, tenantId)));

  const cogsAccount = await resolveGlAccount(tenantId, db, "5000", "Cost of Goods Sold");
  const inventoryAccount = await resolveGlAccount(tenantId, db, "1300", "Inventory");

  let totalCogs = 0;
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

  for (const line of lines) {
    if (Number(line.quantity) <= 0) continue;
    const lineCogs = Number(line.quantity) * Number(line.unitCost ?? 0);
    if (lineCogs <= 0) continue;
    totalCogs += lineCogs;
    glLines.push({ ...cogsAccount, debit: lineCogs, credit: 0, description: `COGS: ${line.itemCode ?? line.itemName ?? "item"}` });
    glLines.push({ ...inventoryAccount, debit: 0, credit: lineCogs, description: `Inventory out: ${line.itemCode ?? line.itemName ?? "item"}` });
  }
  if (totalCogs === 0) return null;

  const [posting] = await db.insert(glPostingsTable).values({
    tenantId, code: `GL-DSP-${Date.now()}`, entityType: "so_despatch", entityId: despatchId,
    status: "posted", postedByClerkId, postedByEmail: postedByEmail ?? undefined, postedAt: new Date(),
    lines: glLines, totalDebit: totalCogs.toFixed(2), totalCredit: totalCogs.toFixed(2),
  } as typeof glPostingsTable.$inferInsert).returning();
  return posting;
}

/**
 * Post invoice GL: Dr AR / Cr Revenue + Cr Tax Liability (if any).
 * Handles both stock-item lines (despatched first) and service/charge lines
 * (invoiced directly without despatch).
 */
async function createInvoiceGlPosting(db: TenantDb, tenantId: number, invoiceId: number, postedByClerkId: string, postedByEmail?: string) {
  const invoice = (await db.select().from(customerInvoicesTable).where(and(eq(customerInvoicesTable.id, invoiceId), eq(customerInvoicesTable.tenantId, tenantId))).limit(1))[0];
  if (!invoice) return null;
  const lines = await db.select().from(customerInvoiceLinesTable).where(and(eq(customerInvoiceLinesTable.invoiceId, invoiceId), eq(customerInvoiceLinesTable.tenantId, tenantId)));

  const arAccount = await resolveGlAccount(tenantId, db, "1100", "Accounts Receivable");
  const revenueAccount = await resolveGlAccount(tenantId, db, "4000", "Sales Revenue");
  const taxLiabilityAccount = await resolveGlAccount(tenantId, db, "2200", "GST/Tax Collected");

  let totalRevenue = 0; let totalTax = 0;
  const glLines: Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }> = [];

  for (const line of lines) {
    const qty = Number(line.quantity ?? 0);
    if (qty <= 0) continue;
    const unitPrice = Number(line.unitPrice ?? 0);
    const discountFactor = 1 - Number(line.discountPct ?? 0) / 100;
    const taxRate = Number(line.taxPct ?? 0) / 100;
    const lineBase = qty * unitPrice * discountFactor;
    const lineTax = lineBase * taxRate;
    totalRevenue += lineBase;
    totalTax += lineTax;
    glLines.push({ ...revenueAccount, debit: 0, credit: lineBase, description: `Revenue: ${line.itemCode ?? line.description ?? line.itemName ?? "item"}` });
    if (lineTax > 0) {
      glLines.push({ ...taxLiabilityAccount, debit: 0, credit: lineTax, description: `Tax: ${line.itemCode ?? line.description ?? line.itemName ?? "item"}` });
    }
  }
  if (totalRevenue === 0) return null;

  const totalAr = totalRevenue + totalTax;
  glLines.unshift({ ...arAccount, debit: totalAr, credit: 0, description: `AR for invoice ${invoice.code ?? invoiceId}` });

  const totalDebit = glLines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = glLines.reduce((s, l) => s + l.credit, 0);

  const [posting] = await db.insert(glPostingsTable).values({
    tenantId, code: `GL-INV-${Date.now()}`, entityType: "customer_invoice", entityId: invoiceId,
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

// ── Quotation/Invoice PDF + Email helpers ────────────────────────────────────

type QuotationRecord = typeof quotationsTable.$inferSelect;
type QuotationLineRecord = typeof quotationLinesTable.$inferSelect;
type InvoiceRecord = typeof customerInvoicesTable.$inferSelect;
type InvoiceLineRecord = typeof customerInvoiceLinesTable.$inferSelect;
type TenantRecord = typeof tenantsTable.$inferSelect;

async function loadTenantHeader(tenantId: number): Promise<TenantRecord | null> {
  const [t] = await withTenantDb(tenantId, (db) =>
    db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1));
  return t ?? null;
}

function formatTenantAddress(t: TenantRecord | null): string[] {
  if (!t) return [];
  const out: string[] = [];
  if (t.tradingName || t.name) out.push(t.tradingName ?? t.name);
  if (t.legalName && t.legalName !== (t.tradingName ?? t.name)) out.push(t.legalName);
  if (t.addressLine1) out.push(t.addressLine1);
  if (t.addressLine2) out.push(t.addressLine2);
  const cityLine = [t.city, t.state, t.postalCode].filter(Boolean).join(" ");
  if (cityLine) out.push(cityLine);
  if (t.country) out.push(t.country);
  if (t.taxId) out.push(`Tax ID: ${t.taxId}`);
  if (t.email) out.push(t.email);
  if (t.phone) out.push(t.phone);
  return out;
}

function generateQuotationPdf(quot: QuotationRecord, lines: QuotationLineRecord[], tenant: TenantRecord | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("QUOTATION", 50, 50);
    doc.fontSize(12).font("Helvetica").text(quot.code, 50, 76);
    doc.fontSize(10).text(`Status: ${quot.status.toUpperCase()}`, 400, 50, { align: "right" });
    doc.text(`Date: ${new Date(quot.createdAt).toLocaleDateString()}`, 400, 65, { align: "right" });
    if (quot.expiryDate) doc.text(`Expires: ${quot.expiryDate}`, 400, 80, { align: "right" });

    // Tenant block (top-right under date)
    const tenantLines = formatTenantAddress(tenant);
    let tY = 95;
    doc.fontSize(8).font("Helvetica");
    for (const line of tenantLines) {
      doc.text(line, 350, tY, { width: 200, align: "right" });
      tY += 11;
    }

    doc.moveDown(2);
    const sepY = Math.max(doc.y, tY + 10);
    doc.moveTo(50, sepY).lineTo(doc.page.width - 50, sepY).stroke();
    doc.y = sepY + 8;

    // Customer block
    doc.fontSize(11).font("Helvetica-Bold").text("Quotation For:", 50, doc.y);
    doc.font("Helvetica").fontSize(10).text(quot.customerName ?? "—");
    if (quot.customerEmail) doc.text(quot.customerEmail);
    if (quot.customerRef) doc.text(`Customer Ref: ${quot.customerRef}`);
    if (quot.requestedDate) doc.text(`Requested Date: ${quot.requestedDate}`);
    if (quot.paymentTerms) doc.text(`Payment Terms: ${quot.paymentTerms}`);
    doc.moveDown(1);

    // Lines table
    const colX = { num: 50, item: 70, desc: 150, qty: 340, uom: 380, price: 430, total: 500 };
    doc.font("Helvetica-Bold").fontSize(10);
    const headerY = doc.y;
    doc.text("#", colX.num, headerY, { width: 20 });
    doc.text("Item", colX.item, headerY, { width: 80 });
    doc.text("Description", colX.desc, headerY, { width: 185 });
    doc.text("Qty", colX.qty, headerY, { width: 40 });
    doc.text("UoM", colX.uom, headerY, { width: 50 });
    doc.text("Price", colX.price, headerY, { width: 70 });
    doc.text("Total", colX.total, headerY, { width: 60 });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(9);
    lines.forEach((l, i) => {
      const rowY = doc.y;
      doc.text(String(l.lineNumber ?? i + 1), colX.num, rowY, { width: 20 });
      doc.text(l.itemCode ?? "—", colX.item, rowY, { width: 80 });
      doc.text(l.description ?? l.itemName ?? "", colX.desc, rowY, { width: 185 });
      doc.text(String(l.quantity), colX.qty, rowY, { width: 40 });
      doc.text(l.unitOfMeasure ?? "", colX.uom, rowY, { width: 50 });
      doc.text(Number(l.unitPrice).toFixed(2), colX.price, rowY, { width: 70 });
      doc.text(Number(l.lineTotal).toFixed(2), colX.total, rowY, { width: 60 });
      doc.moveDown(0.8);
      if (doc.y > doc.page.height - 120) doc.addPage();
    });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);

    // Totals
    doc.font("Helvetica").fontSize(10);
    doc.text(`Subtotal: ${Number(quot.subtotal).toFixed(2)} ${quot.currencyCode}`, { align: "right" });
    doc.text(`Tax: ${Number(quot.taxAmount).toFixed(2)} ${quot.currencyCode}`, { align: "right" });
    doc.font("Helvetica-Bold").fontSize(11);
    doc.text(`Total: ${Number(quot.total).toFixed(2)} ${quot.currencyCode}`, { align: "right" });

    if (quot.notes) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(10).text("Notes:");
      doc.font("Helvetica").fontSize(9).text(quot.notes);
    }

    doc.end();
  });
}

function generateInvoicePdf(invoice: InvoiceRecord, lines: InvoiceLineRecord[], tenant: TenantRecord | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("TAX INVOICE", 50, 50);
    doc.fontSize(12).font("Helvetica").text(invoice.code, 50, 76);
    doc.fontSize(10).text(`Status: ${invoice.status.toUpperCase()}`, 400, 50, { align: "right" });
    doc.text(`Invoice Date: ${invoice.invoiceDate ?? new Date(invoice.createdAt).toLocaleDateString()}`, 400, 65, { align: "right" });
    if (invoice.dueDate) doc.text(`Due Date: ${invoice.dueDate}`, 400, 80, { align: "right" });

    // Tenant block
    const tenantLines = formatTenantAddress(tenant);
    let tY = 95;
    doc.fontSize(8).font("Helvetica");
    for (const line of tenantLines) {
      doc.text(line, 350, tY, { width: 200, align: "right" });
      tY += 11;
    }

    doc.moveDown(2);
    const sepY = Math.max(doc.y, tY + 10);
    doc.moveTo(50, sepY).lineTo(doc.page.width - 50, sepY).stroke();
    doc.y = sepY + 8;

    // Bill-to block
    doc.fontSize(11).font("Helvetica-Bold").text("Bill To:", 50, doc.y);
    doc.font("Helvetica").fontSize(10).text(invoice.customerName ?? "—");
    if (invoice.customerEmail) doc.text(invoice.customerEmail);
    doc.moveDown(1);

    // Lines table
    const colX = { num: 50, item: 70, desc: 150, qty: 340, price: 400, tax: 460, total: 510 };
    doc.font("Helvetica-Bold").fontSize(10);
    const headerY = doc.y;
    doc.text("#", colX.num, headerY, { width: 20 });
    doc.text("Item", colX.item, headerY, { width: 80 });
    doc.text("Description", colX.desc, headerY, { width: 185 });
    doc.text("Qty", colX.qty, headerY, { width: 50 });
    doc.text("Price", colX.price, headerY, { width: 60 });
    doc.text("Tax%", colX.tax, headerY, { width: 50 });
    doc.text("Total", colX.total, headerY, { width: 60 });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(9);
    lines.forEach((l, i) => {
      const rowY = doc.y;
      doc.text(String(i + 1), colX.num, rowY, { width: 20 });
      doc.text(l.itemCode ?? "—", colX.item, rowY, { width: 80 });
      doc.text(l.description ?? l.itemName ?? "", colX.desc, rowY, { width: 185 });
      doc.text(String(l.quantity), colX.qty, rowY, { width: 50 });
      doc.text(Number(l.unitPrice).toFixed(2), colX.price, rowY, { width: 60 });
      doc.text(Number(l.taxPct ?? 0).toFixed(2), colX.tax, rowY, { width: 50 });
      doc.text(Number(l.lineTotal).toFixed(2), colX.total, rowY, { width: 60 });
      doc.moveDown(0.8);
      if (doc.y > doc.page.height - 160) doc.addPage();
    });

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);

    // Totals
    const balance = Number(invoice.total) - Number(invoice.paidAmount ?? 0);
    doc.font("Helvetica").fontSize(10);
    doc.text(`Subtotal: ${Number(invoice.subtotal).toFixed(2)} ${invoice.currencyCode}`, { align: "right" });
    doc.text(`Tax: ${Number(invoice.taxAmount).toFixed(2)} ${invoice.currencyCode}`, { align: "right" });
    doc.font("Helvetica-Bold").fontSize(11);
    doc.text(`Total: ${Number(invoice.total).toFixed(2)} ${invoice.currencyCode}`, { align: "right" });
    if (Number(invoice.paidAmount ?? 0) > 0) {
      doc.font("Helvetica").fontSize(10);
      doc.text(`Paid: ${Number(invoice.paidAmount).toFixed(2)} ${invoice.currencyCode}`, { align: "right" });
      doc.font("Helvetica-Bold").fontSize(11);
      doc.text(`Balance Due: ${balance.toFixed(2)} ${invoice.currencyCode}`, { align: "right" });
    }

    // Payment details
    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(10).text("Payment Details");
    doc.font("Helvetica").fontSize(9);
    if (invoice.dueDate) doc.text(`Payment is due by ${invoice.dueDate}.`);
    doc.text(`Please reference invoice number ${invoice.code} when remitting payment.`);
    if (tenant?.email) doc.text(`Remit confirmation to: ${tenant.email}`);
    if (tenant?.taxId) doc.text(`Our Tax ID / ABN: ${tenant.taxId}`);

    if (invoice.notes) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(10).text("Notes:");
      doc.font("Helvetica").fontSize(9).text(invoice.notes);
    }

    doc.end();
  });
}

function buildQuotationEmailHtml(quot: QuotationRecord, tenant: TenantRecord | null): string {
  const companyName = tenant?.tradingName ?? tenant?.name ?? "Forge ERP";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f8fafc;padding:32px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:24px 32px">
      <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">${escapeHtml(companyName)}</span>
    </div>
    <div style="padding:32px">
      <p style="font-size:16px;color:#1e293b;margin-top:0">Dear ${escapeHtml(quot.customerName ?? "Customer")},</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Please find attached quotation <strong>${escapeHtml(quot.code)}</strong> for your review.
        Total value: <strong>${Number(quot.total).toFixed(2)} ${escapeHtml(quot.currencyCode)}</strong>.
      </p>
      ${quot.expiryDate ? `<p style="font-size:15px;color:#475569">This quotation is valid until <strong>${escapeHtml(String(quot.expiryDate))}</strong>.</p>` : ""}
      ${quot.paymentTerms ? `<p style="font-size:15px;color:#475569">Payment terms: <strong>${escapeHtml(quot.paymentTerms)}</strong></p>` : ""}
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        Reply to this email to accept the quotation or raise any queries.<br>${escapeHtml(companyName)}
      </p>
    </div>
  </div>
</body>
</html>`;
}

function buildInvoiceEmailHtml(invoice: InvoiceRecord, tenant: TenantRecord | null): string {
  const companyName = tenant?.tradingName ?? tenant?.name ?? "Forge ERP";
  const balance = Number(invoice.total) - Number(invoice.paidAmount ?? 0);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f8fafc;padding:32px;margin:0">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:24px 32px">
      <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">${escapeHtml(companyName)}</span>
    </div>
    <div style="padding:32px">
      <p style="font-size:16px;color:#1e293b;margin-top:0">Dear ${escapeHtml(invoice.customerName ?? "Customer")},</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Please find attached invoice <strong>${escapeHtml(invoice.code)}</strong>.
        Amount due: <strong>${balance.toFixed(2)} ${escapeHtml(invoice.currencyCode)}</strong>.
      </p>
      ${invoice.dueDate ? `<p style="font-size:15px;color:#475569">Payment is due by <strong>${escapeHtml(String(invoice.dueDate))}</strong>.</p>` : ""}
      <div style="margin:24px 0;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#0f172a">Payment Details</p>
        <p style="margin:0;font-size:13px;color:#475569;line-height:1.6">
          Please reference invoice <strong>${escapeHtml(invoice.code)}</strong> when remitting payment.<br>
          ${tenant?.email ? `Remit confirmation to: <a href="mailto:${escapeHtml(tenant.email)}" style="color:#ea580c">${escapeHtml(tenant.email)}</a><br>` : ""}
          ${tenant?.taxId ? `Our Tax ID / ABN: <strong>${escapeHtml(tenant.taxId)}</strong>` : ""}
        </p>
      </div>
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        Questions? Reply to this email and we'll get right back to you.<br>${escapeHtml(companyName)}
      </p>
    </div>
  </div>
</body>
</html>`;
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
        search ? or(
          ilike(quotationsTable.code, `%${search}%`),
          ilike(quotationsTable.customerName, `%${search}%`),
          ilike(quotationsTable.notes, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM quotation_lines ql WHERE ql.quotation_id = ${quotationsTable.id} AND ql.tenant_id = ${quotationsTable.tenantId} AND ql.notes ILIKE ${`%${search}%`})`,
        ) : undefined,
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
  // itemId accepts either the numeric primary key or the items.code string
  // (the latter being how external systems like Cyntric reference items).
  itemId: z.union([z.number().int(), z.string().min(1)]).optional(),
  itemCode: z.string().optional(),
  itemName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.coerce.number().nonnegative().default(1),
  unitOfMeasure: z.string().optional(),
  unitPrice: z.coerce.number().nonnegative().default(0),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  taxPct: z.coerce.number().min(0).max(100).default(0),
  glAccountId: z.number().int().optional(),
  notes: z.string().optional(),
});

router.post("/sales/quotations", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const schema = z.object({
    // customerId accepts either the numeric primary key or the customers.code
    // string (e.g. "CUST-001") so external systems can reference customers by
    // their human-readable code.
    customerId: z.union([z.number().int(), z.string().min(1)]).optional(),
    customerName: z.string().optional(),
    customerEmail: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
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
  if (!parsed.success) {
    req.log.warn({ issues: parsed.error.issues, body: req.body }, "[quotation.create] validation failed");
    res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
    return;
  }
  const { lines, customerId: rawCustomerId, ...rest } = parsed.data;

  // ── Resolve customerId (number-or-code) ─────────────────────────────────
  let resolvedCustomerId: number | undefined;
  let resolvedCustomerName = rest.customerName;
  let resolvedCustomerEmail = rest.customerEmail;
  if (rawCustomerId !== undefined) {
    const customerLookup = await withTenantDb(tenantId, (db) => {
      if (typeof rawCustomerId === "number") {
        return db.select({ id: customersTable.id, name: customersTable.name, email: customersTable.email })
          .from(customersTable)
          .where(and(eq(customersTable.id, rawCustomerId), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
          .limit(1);
      }
      return db.select({ id: customersTable.id, name: customersTable.name, email: customersTable.email })
        .from(customersTable)
        .where(and(eq(customersTable.code, rawCustomerId), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
        .limit(1);
    });
    if (customerLookup.length === 0) {
      res.status(400).json({
        error: typeof rawCustomerId === "string"
          ? `Customer with code "${rawCustomerId}" not found`
          : `Customer with id ${rawCustomerId} not found`,
      });
      return;
    }
    const cust = customerLookup[0]!;
    resolvedCustomerId = cust.id;
    resolvedCustomerName = resolvedCustomerName ?? cust.name;
    resolvedCustomerEmail = resolvedCustomerEmail ?? cust.email ?? undefined;
  }

  // ── Resolve each line's itemId / itemCode ────────────────────────────────
  const resolvedLines: Array<typeof lines[number] & { itemId?: number }> = [];
  for (const line of lines) {
    let lineItemId: number | undefined;
    let lineItemCode = line.itemCode;
    let lineItemName = line.itemName;

    // Either itemId-as-string or explicit itemCode resolves via items.code.
    const codeRef = typeof line.itemId === "string" ? line.itemId : line.itemCode;
    const numericId = typeof line.itemId === "number" ? line.itemId : undefined;

    if (numericId !== undefined) {
      const [item] = await withTenantDb(tenantId, (db) =>
        db.select({ id: itemsTable.id, code: itemsTable.code, name: itemsTable.name })
          .from(itemsTable)
          .where(and(eq(itemsTable.id, numericId), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
          .limit(1));
      if (!item) { res.status(400).json({ error: `Item with id ${numericId} not found` }); return; }
      lineItemId = item.id;
      lineItemCode = lineItemCode ?? item.code;
      lineItemName = lineItemName ?? item.name;
    } else if (codeRef) {
      const [item] = await withTenantDb(tenantId, (db) =>
        db.select({ id: itemsTable.id, code: itemsTable.code, name: itemsTable.name })
          .from(itemsTable)
          .where(and(eq(itemsTable.code, codeRef), eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))
          .limit(1));
      if (!item) { res.status(400).json({ error: `Item with code "${codeRef}" not found` }); return; }
      lineItemId = item.id;
      lineItemCode = item.code;
      lineItemName = lineItemName ?? item.name;
    }

    resolvedLines.push({ ...line, itemId: lineItemId, itemCode: lineItemCode, itemName: lineItemName });
  }

  const header = { ...rest, customerId: resolvedCustomerId };

  const [quot] = await withTenantDb(tenantId, (db) =>
    db.insert(quotationsTable).values({ ...header, tenantId, code: "QT-TEMP", status: "draft", customerName: resolvedCustomerName, customerEmail: resolvedCustomerEmail, createdByClerkId: clerkUserId, createdByEmail: userEmail } as typeof quotationsTable.$inferInsert).returning());
  const quotId = quot!.id;
  await withTenantDb(tenantId, (db) => db.update(quotationsTable).set({ code: genCode("QT", quotId) }).where(eq(quotationsTable.id, quotId)));
  if (resolvedLines.length > 0) {
    await withTenantDb(tenantId, (db) =>
      db.insert(quotationLinesTable).values(resolvedLines.map((l, i) => ({
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
    customerId: z.number().int().positive().optional(),
    customerName: z.string().optional(),
    customerEmail: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
    customerRef: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryAddressLine1: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryAddressLine2: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryCity: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryState: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryPostalCode: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    deliveryCountry: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    expiryDate: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    requestedDate: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    paymentTerms: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    notes: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
    internalNotes: z.preprocess((v) => (v === "" ? null : v), z.string().optional().nullable()),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [existing] = await withTenantDb(tenantId, (db) => db.select({ status: quotationsTable.status }).from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).limit(1));
  if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!["draft", "sent"].includes(existing.status)) { res.status(400).json({ error: "Cannot edit a quotation that is accepted, rejected, or converted" }); return; }
  // Customer identity must come from Master Data: if customerId is supplied,
  // verify it and derive customerName/customerEmail from the master record so
  // free-text values cannot drift. If customerId is not supplied, strip any
  // customerName/customerEmail in the payload to prevent bypassing Master Data.
  const updatePayload: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.customerId !== undefined) {
    const [cust] = await withTenantDb(tenantId, (db) =>
      db.select({ id: customersTable.id, name: customersTable.name, email: customersTable.email }).from(customersTable)
        .where(and(eq(customersTable.id, parsed.data.customerId!), eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)))
        .limit(1));
    if (!cust) { res.status(400).json({ error: `Customer with id ${parsed.data.customerId} not found` }); return; }
    updatePayload.customerName = cust.name;
    updatePayload.customerEmail = cust.email ?? null;
  } else {
    delete updatePayload.customerName;
    delete updatePayload.customerEmail;
  }
  const [updated] = await withTenantDb(tenantId, (db) => db.update(quotationsTable).set(updatePayload).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.updated", entityType: "quotation", entityId: String(id), newValues: updatePayload });
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

router.get("/sales/quotations/:id/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [quot] = await withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt))).limit(1));
  if (!quot) { res.status(404).json({ error: "Quotation not found" }); return; }
  const [lines, tenant] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable)
      .where(and(eq(quotationLinesTable.quotationId, id), eq(quotationLinesTable.tenantId, tenantId)))
      .orderBy(quotationLinesTable.lineNumber)),
    loadTenantHeader(tenantId),
  ]);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateQuotationPdf(quot, lines, tenant);
  } catch (err) {
    logger.warn({ err, quotationId: id }, "Quotation PDF generation failed");
    res.status(500).json({ error: "Failed to render quotation PDF" });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${quot.code}.pdf"`);
  res.send(pdfBuffer);
});

router.post("/sales/quotations/:id/send", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [quot] = await withTenantDb(tenantId, (db) => db.select().from(quotationsTable).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId), isNull(quotationsTable.deletedAt))).limit(1));
  if (!quot) { res.status(404).json({ error: "Quotation not found" }); return; }
  if (!["draft", "sent"].includes(quot.status)) { res.status(400).json({ error: `Cannot send quotation in status: ${quot.status}` }); return; }

  // Resolve recipient: explicit body param → quotation customer email → fallback to customer record
  let toEmail = (req.body as { email?: string }).email ?? quot.customerEmail ?? null;
  if (!toEmail && quot.customerId) {
    const [cust] = await withTenantDb(tenantId, (db) =>
      db.select({ email: customersTable.email }).from(customersTable)
        .where(and(eq(customersTable.id, quot.customerId!), eq(customersTable.tenantId, tenantId))).limit(1));
    toEmail = cust?.email ?? null;
  }
  if (!toEmail) { res.status(400).json({ error: "No customer email available. Provide email in request body or set on quotation." }); return; }

  // Build PDF attachment + branded HTML
  const [lines, tenant] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(quotationLinesTable)
      .where(and(eq(quotationLinesTable.quotationId, id), eq(quotationLinesTable.tenantId, tenantId)))
      .orderBy(quotationLinesTable.lineNumber)),
    loadTenantHeader(tenantId),
  ]);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateQuotationPdf(quot, lines, tenant);
  } catch (err) {
    logger.warn({ err, quotationId: id }, "Quotation PDF generation failed");
    res.status(500).json({ error: "Failed to render quotation PDF. Quotation status was not changed." });
    return;
  }
  const companyName = tenant?.tradingName ?? tenant?.name ?? "Forge ERP";

  let emailSent = false;
  try {
    emailSent = await sendEmail({
      to: toEmail,
      subject: `Quotation ${quot.code} from ${companyName}`,
      html: buildQuotationEmailHtml(quot, tenant),
      text: `Dear ${quot.customerName ?? "Customer"},\n\nPlease find attached quotation ${quot.code} for your review.\nTotal: ${Number(quot.total).toFixed(2)} ${quot.currencyCode}.${quot.expiryDate ? `\nValid until: ${quot.expiryDate}.` : ""}\n\n${companyName}`,
      attachments: [{ filename: `${quot.code}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    });
  } catch (err) {
    logger.warn({ err, quotationId: id, toEmail }, "Quotation email dispatch failed");
    res.status(502).json({ error: "Email dispatch failed. Quotation status was not changed.", customerEmail: toEmail });
    return;
  }
  if (!emailSent) { res.status(502).json({ error: "Email could not be dispatched (mail transport unavailable). Quotation status was not changed.", customerEmail: toEmail, emailSent: false }); return; }

  const [updated] = await withTenantDb(tenantId, (db) => db.update(quotationsTable).set({ status: "sent", sentAt: new Date() }).where(and(eq(quotationsTable.id, id), eq(quotationsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "quotation.sent", entityType: "quotation", entityId: String(id), newValues: { customerEmail: toEmail, emailSent } });
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
  const quotationId = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const parsed = quotationLineSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(quotationLinesTable).set({ ...parsed.data, quantity: parsed.data.quantity != null ? String(parsed.data.quantity) : undefined, unitPrice: parsed.data.unitPrice != null ? String(parsed.data.unitPrice) : undefined } as Record<string, unknown>)
      .where(and(eq(quotationLinesTable.id, lineId), eq(quotationLinesTable.quotationId, quotationId), eq(quotationLinesTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "Line not found" }); return; }
  await updateQuotationTotals(tenantId, updated.quotationId);
  res.json(updated);
});

router.delete("/sales/quotations/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const quotationId = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const [deleted] = await withTenantDb(tenantId, (db) =>
    db.delete(quotationLinesTable).where(and(eq(quotationLinesTable.id, lineId), eq(quotationLinesTable.quotationId, quotationId), eq(quotationLinesTable.tenantId, tenantId))).returning());
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
        search ? or(
          ilike(salesOrdersTable.code, `%${search}%`),
          ilike(salesOrdersTable.customerName, `%${search}%`),
          ilike(salesOrdersTable.notes, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM so_lines sl WHERE sl.so_id = ${salesOrdersTable.id} AND sl.tenant_id = ${salesOrdersTable.tenantId} AND sl.notes ILIKE ${`%${search}%`})`,
        ) : undefined,
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
  lineType: z.enum(["stock", "service", "charge", "comment", "kit"]).default("stock"),
  parentLineId: z.number().int().optional(), // for kit component lines — references the parent kit header line id
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
    customerEmail: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
    customerRef: z.string().optional(),
    salesRepId: z.string().optional(),
    salesRepName: z.string().optional(),
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
      // Sum outstanding invoices (total - paid_amount) — exclude settled and voided invoices
      // Use 'voided' (schema) and 'void' (legacy) to cover both naming patterns
      const [invoiceBalance] = await withTenantDb(tenantId, (db) =>
        db.select({ outstanding: sql<string>`coalesce(sum(GREATEST(0, total - paid_amount)), 0)` })
          .from(customerInvoicesTable)
          .where(and(
            eq(customerInvoicesTable.tenantId, tenantId),
            eq(customerInvoicesTable.customerId, header.customerId!),
            isNull(customerInvoicesTable.deletedAt),
            sql`status NOT IN ('paid','cancelled','voided','void')`,
          )));
      // Sum active SO totals (confirmed and in-progress only, not yet fully invoiced)
      // Exclude draft, cancelled, and fully invoiced SOs to avoid double-counting with invoice balance
      const [soBalance] = await withTenantDb(tenantId, (db) =>
        db.select({ outstanding: sql<string>`coalesce(sum(total), 0)` })
          .from(salesOrdersTable)
          .where(and(
            eq(salesOrdersTable.tenantId, tenantId),
            eq(salesOrdersTable.customerId, header.customerId!),
            isNull(salesOrdersTable.deletedAt),
            sql`status NOT IN ('draft','cancelled','invoiced')`,
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
    customerEmail: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
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
  const soId = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const parsed = soLineSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(soLinesTable).set({ ...parsed.data, quantity: parsed.data.quantity != null ? String(parsed.data.quantity) : undefined, unitPrice: parsed.data.unitPrice != null ? String(parsed.data.unitPrice) : undefined } as Record<string, unknown>)
      .where(and(eq(soLinesTable.id, lineId), eq(soLinesTable.soId, soId), eq(soLinesTable.tenantId, tenantId))).returning());
  if (!updated) { res.status(404).json({ error: "Line not found" }); return; }
  await updateSoTotals(tenantId, updated.soId);
  res.json(updated);
});

router.delete("/sales/orders/:id/lines/:lineId", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const soId = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const [deleted] = await withTenantDb(tenantId, (db) =>
    db.delete(soLinesTable).where(and(eq(soLinesTable.id, lineId), eq(soLinesTable.soId, soId), eq(soLinesTable.tenantId, tenantId))).returning());
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
  const visible = rows.slice(0, lim);
  // Aggregate per-slip line counts so the supervisor table can show progress
  // (x/y confirmed, short count) without a per-row detail fetch.
  const slipIds = visible.map((s) => s.id);
  const counts = new Map<number, { total: number; confirmed: number; short: number }>();
  if (slipIds.length > 0) {
    const lineRows = await withTenantDb(tenantId, (db) =>
      db.select({
        pickSlipId: pickSlipLinesTable.pickSlipId,
        confirmStatus: pickSlipLinesTable.confirmStatus,
      }).from(pickSlipLinesTable)
        .where(and(eq(pickSlipLinesTable.tenantId, tenantId), inArray(pickSlipLinesTable.pickSlipId, slipIds))));
    for (const l of lineRows) {
      const bucket = counts.get(l.pickSlipId) ?? { total: 0, confirmed: 0, short: 0 };
      bucket.total += 1;
      if (l.confirmStatus === "picked") bucket.confirmed += 1;
      else if (l.confirmStatus === "short") bucket.short += 1;
      counts.set(l.pickSlipId, bucket);
    }
  }
  const data = visible.map((s) => {
    const c = counts.get(s.id) ?? { total: 0, confirmed: 0, short: 0 };
    return { ...s, totalLines: c.total, confirmedLines: c.confirmed, shortLines: c.short };
  });
  res.json({ data, hasMore: rows.length > lim, page: pg });
});

router.post("/sales/pick-slips", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const schema = z.object({
    soId: z.number().int(),
    warehouseId: z.number().int().optional(),
    warehouseZone: z.string().optional(), // e.g. "ZONE-A" — filters auto-generated lines to that zone
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
    const effectiveWarehouseId = parsed.data.warehouseId ?? so.warehouseId;
    let soLines = await withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(and(eq(soLinesTable.soId, parsed.data.soId), eq(soLinesTable.tenantId, tenantId))));
    const unfulfilled = soLines.filter((l) => l.lineType === "stock" && Number(l.quantity) > Number(l.despatched_qty));

    // If a zone is specified, resolve location IDs in that zone and filter lines by their allocated location
    if (parsed.data.warehouseZone && effectiveWarehouseId) {
      const zoneLocations = await withTenantDb(tenantId, (db) =>
        db.select({ id: warehouseLocationsTable.id }).from(warehouseLocationsTable)
          .where(and(eq(warehouseLocationsTable.tenantId, tenantId), eq(warehouseLocationsTable.warehouseId, effectiveWarehouseId),
            ilike(warehouseLocationsTable.code, `${parsed.data.warehouseZone!}%`))));
      const zoneLocationIds = new Set(zoneLocations.map((loc) => loc.id));
      // Filter to lines that have a stock allocation in the given zone
      const allocations = await withTenantDb(tenantId, (db) =>
        db.select({ soLineId: soAllocationsTable.soLineId, locationId: soAllocationsTable.locationId })
          .from(soAllocationsTable)
          .where(and(eq(soAllocationsTable.soId, parsed.data.soId), eq(soAllocationsTable.tenantId, tenantId), eq(soAllocationsTable.isReleased, false))));
      const lineIdsInZone = new Set(allocations.filter((a) => a.locationId != null && zoneLocationIds.has(a.locationId)).map((a) => a.soLineId));
      soLines = unfulfilled.filter((l) => lineIdsInZone.has(l.id));
    } else {
      soLines = unfulfilled;
    }

    pickLines = soLines.map((l) => ({
      soLineId: l.id, itemId: l.itemId ?? undefined, itemCode: l.itemCode ?? undefined, itemName: l.itemName ?? undefined,
      requiredQty: Number(l.quantity) - Number(l.despatched_qty),
    }));
  }

  const [slip] = await withTenantDb(tenantId, (db) =>
    db.insert(pickSlipsTable).values({ tenantId, soId: parsed.data.soId, code: "PS-TEMP", status: "pending", warehouseId: parsed.data.warehouseId ?? so.warehouseId ?? undefined, warehouseZone: parsed.data.warehouseZone ?? undefined, notes: parsed.data.notes, createdByClerkId: clerkUserId } as typeof pickSlipsTable.$inferInsert).returning());
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
// ── Pick Slips — Picker workflow (PWA) + Supervisor board ─────════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// Slips assigned to the current picker (by Clerk user id).
// IMPORTANT: this route must come BEFORE `/sales/pick-slips/:id` so Express
// does not interpret "mine" / "queue" as an :id.
router.get("/sales/pick-slips/mine", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId } = req as TenantRequest;
  const { status, limit = "50" } = req.query as Record<string, string>;
  const lim = Math.min(200, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable)
      .where(and(
        eq(pickSlipsTable.tenantId, tenantId),
        eq(pickSlipsTable.assignedToClerkId, clerkUserId),
        status ? eq(pickSlipsTable.status, status) : undefined,
      ))
      .orderBy(desc(pickSlipsTable.priority), desc(pickSlipsTable.createdAt))
      .limit(lim));
  res.json({ data: rows, hasMore: false, page: 1 });
});

// Unassigned / pending pick slips available for any picker to claim.
router.get("/sales/pick-slips/queue", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { warehouseId, limit = "50" } = req.query as Record<string, string>;
  const lim = Math.min(200, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable)
      .where(and(
        eq(pickSlipsTable.tenantId, tenantId),
        isNull(pickSlipsTable.assignedToClerkId),
        inArray(pickSlipsTable.status, ["pending", "picking"]),
        warehouseId ? eq(pickSlipsTable.warehouseId, Number(warehouseId)) : undefined,
      ))
      .orderBy(desc(pickSlipsTable.priority), desc(pickSlipsTable.createdAt))
      .limit(lim));
  res.json({ data: rows, hasMore: false, page: 1 });
});

// Aggregated pick progress summary for the supervisor board.
router.get("/sales/pick-progress", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const slips = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable)
      .where(and(eq(pickSlipsTable.tenantId, tenantId)))
      .orderBy(desc(pickSlipsTable.createdAt))
      .limit(100));
  const slipIds = slips.map((s) => s.id);
  const linesBySlip = new Map<number, { total: number; confirmed: number; short: number; pending: number }>();
  if (slipIds.length > 0) {
    const lineRows = await withTenantDb(tenantId, (db) =>
      db.select({
        pickSlipId: pickSlipLinesTable.pickSlipId,
        confirmStatus: pickSlipLinesTable.confirmStatus,
      }).from(pickSlipLinesTable)
        .where(and(eq(pickSlipLinesTable.tenantId, tenantId), inArray(pickSlipLinesTable.pickSlipId, slipIds))));
    for (const l of lineRows) {
      const bucket = linesBySlip.get(l.pickSlipId) ?? { total: 0, confirmed: 0, short: 0, pending: 0 };
      bucket.total += 1;
      if (l.confirmStatus === "picked") bucket.confirmed += 1;
      else if (l.confirmStatus === "short") bucket.short += 1;
      else bucket.pending += 1;
      linesBySlip.set(l.pickSlipId, bucket);
    }
  }
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  let unassigned = 0, inProgress = 0, completedToday = 0, shortPickedToday = 0;
  const slipSummaries = slips.map((s) => {
    const counts = linesBySlip.get(s.id) ?? { total: 0, confirmed: 0, short: 0, pending: 0 };
    if (!s.assignedToClerkId && (s.status === "pending" || s.status === "picking")) unassigned += 1;
    if (s.status === "picking") inProgress += 1;
    if (s.completedAt && s.completedAt >= startOfDay) {
      completedToday += 1;
      if (counts.short > 0) shortPickedToday += 1;
    }
    const denom = counts.total || 1;
    return {
      id: s.id, code: s.code, soId: s.soId, status: s.status,
      priority: s.priority ?? null,
      assignedToName: s.assignedToName ?? null,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      dueAt: s.dueAt ?? null,
      totalLines: counts.total,
      confirmedLines: counts.confirmed,
      shortLines: counts.short,
      pendingLines: counts.pending,
      progressPct: Math.round((counts.confirmed / denom) * 100),
      createdAt: s.createdAt,
    };
  });
  res.json({ unassigned, inProgress, completedToday, shortPickedToday, slips: slipSummaries });
});

// NOTE: must be registered AFTER the static `/mine`, `/queue`, `/pick-progress`
// routes above so Express does not interpret those path segments as `:id`.
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

// Claim or reassign a pick slip. With no body, the caller claims the slip themselves.
router.post("/sales/pick-slips/:id/assign", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const schema = z.object({
    clerkUserId: z.string().optional(),
    name: z.string().optional(),
    email: z.string().email().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const targetClerk = parsed.data.clerkUserId ?? clerkUserId;
  const targetEmail = parsed.data.email ?? (parsed.data.clerkUserId ? null : userEmail);
  const targetName = parsed.data.name ?? targetEmail ?? targetClerk;
  const [slip] = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable).where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).limit(1));
  if (!slip) { res.status(404).json({ error: "Pick slip not found" }); return; }
  if (slip.status === "picked" || slip.status === "cancelled") {
    res.status(400).json({ error: `Cannot assign slip in status: ${slip.status}` }); return;
  }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(pickSlipsTable)
      .set({
        assignedToClerkId: targetClerk,
        assignedToName: targetName,
        assignedToEmail: targetEmail,
      })
      .where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId)))
      .returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "pick_slip.assigned", entityType: "pick_slip", entityId: String(id), newValues: { assignedTo: targetClerk } });
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipLinesTable).where(and(eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId))));
  res.json({ ...updated, lines });
});

// Mark slip as started — the picker has begun walking the route.
router.post("/sales/pick-slips/:id/start", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [slip] = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable).where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).limit(1));
  if (!slip) { res.status(404).json({ error: "Pick slip not found" }); return; }
  if (slip.status === "picked" || slip.status === "cancelled") {
    res.status(400).json({ error: `Cannot start slip in status: ${slip.status}` }); return;
  }
  const update: Record<string, unknown> = { status: "picking" };
  if (!slip.startedAt) update.startedAt = new Date();
  if (!slip.assignedToClerkId) {
    update.assignedToClerkId = clerkUserId;
    update.assignedToEmail = userEmail;
    update.assignedToName = userEmail;
  }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(pickSlipsTable).set(update).where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "pick_slip.started", entityType: "pick_slip", entityId: String(id) });
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipLinesTable).where(and(eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId))));
  res.json({ ...updated, lines });
});

// Confirm a single picked line — quantity, lot/serial/batch, optional photo.
router.post("/sales/pick-slips/:id/lines/:lineId/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const schema = z.object({
    pickedQty: z.number().nonnegative(),
    lotNumber: z.string().optional(),
    serialNumber: z.string().optional(),
    batchNumber: z.string().optional(),
    photoObjectPath: z.string().optional(),
    notes: z.string().optional(),
    scannedBarcode: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [line] = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipLinesTable)
      .where(and(eq(pickSlipLinesTable.id, lineId), eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId)))
      .limit(1));
  if (!line) { res.status(404).json({ error: "Pick slip line not found" }); return; }
  if (parsed.data.scannedBarcode && line.barcode && parsed.data.scannedBarcode !== line.barcode) {
    res.status(409).json({ error: "Scanned barcode does not match the expected item barcode" }); return;
  }
  const required = Number(line.requiredQty);
  const picked = parsed.data.pickedQty;
  if (picked > required) {
    res.status(400).json({ error: `Picked qty ${picked} exceeds required qty ${required}` }); return;
  }
  const isShort = picked < required;
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(pickSlipLinesTable).set({
      pickedQty: String(picked),
      lotNumber: parsed.data.lotNumber ?? line.lotNumber,
      serialNumber: parsed.data.serialNumber ?? line.serialNumber,
      batchNumber: parsed.data.batchNumber ?? line.batchNumber,
      photoObjectPath: parsed.data.photoObjectPath ?? line.photoObjectPath,
      notes: parsed.data.notes ?? line.notes,
      confirmStatus: isShort ? "short" : "picked",
      confirmedByClerkId: clerkUserId,
      confirmedByName: userEmail,
      confirmedAt: new Date(),
    } as Record<string, unknown>).where(and(eq(pickSlipLinesTable.id, lineId), eq(pickSlipLinesTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "pick_slip_line.confirmed", entityType: "pick_slip_line", entityId: String(lineId), newValues: { pickedQty: picked, lotNumber: parsed.data.lotNumber } });
  await maybeMarkSlipPicked(tenantId, id);
  res.json(updated);
});

// Mark a line as short-picked with reason.
router.post("/sales/pick-slips/:id/lines/:lineId/short-pick", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const lineId = Number(req.params.lineId);
  const schema = z.object({
    reason: z.enum(["out_of_stock", "wrong_location", "damaged", "other"]),
    pickedQty: z.number().nonnegative().optional(),
    note: z.string().optional(),
    photoObjectPath: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const [line] = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipLinesTable)
      .where(and(eq(pickSlipLinesTable.id, lineId), eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId)))
      .limit(1));
  if (!line) { res.status(404).json({ error: "Pick slip line not found" }); return; }
  const picked = parsed.data.pickedQty ?? 0;
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(pickSlipLinesTable).set({
      pickedQty: String(picked),
      shortReason: parsed.data.reason,
      shortNote: parsed.data.note ?? null,
      photoObjectPath: parsed.data.photoObjectPath ?? line.photoObjectPath,
      confirmStatus: "short",
      confirmedByClerkId: clerkUserId,
      confirmedByName: userEmail,
      confirmedAt: new Date(),
    } as Record<string, unknown>).where(and(eq(pickSlipLinesTable.id, lineId), eq(pickSlipLinesTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "pick_slip_line.short_picked", entityType: "pick_slip_line", entityId: String(lineId), newValues: parsed.data });
  await maybeMarkSlipPicked(tenantId, id);
  res.json(updated);
});

// Mark the slip as fully picked.
router.post("/sales/pick-slips/:id/complete", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [slip] = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipsTable).where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).limit(1));
  if (!slip) { res.status(404).json({ error: "Pick slip not found" }); return; }
  if (slip.status === "cancelled") { res.status(400).json({ error: "Slip is cancelled" }); return; }
  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(pickSlipsTable).set({ status: "picked", completedAt: new Date() })
      .where(and(eq(pickSlipsTable.id, id), eq(pickSlipsTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "pick_slip.completed", entityType: "pick_slip", entityId: String(id) });
  const lines = await withTenantDb(tenantId, (db) =>
    db.select().from(pickSlipLinesTable).where(and(eq(pickSlipLinesTable.pickSlipId, id), eq(pickSlipLinesTable.tenantId, tenantId))));
  res.json({ ...updated, lines });
});

// Helper — auto-mark slip as picked when every line has been confirmed/short.
async function maybeMarkSlipPicked(tenantId: number, slipId: number): Promise<void> {
  const lines = await withTenantDb(tenantId, (db) =>
    db.select({ confirmStatus: pickSlipLinesTable.confirmStatus })
      .from(pickSlipLinesTable)
      .where(and(eq(pickSlipLinesTable.pickSlipId, slipId), eq(pickSlipLinesTable.tenantId, tenantId))));
  if (lines.length === 0) return;
  const allDone = lines.every((l) => l.confirmStatus === "picked" || l.confirmStatus === "short");
  if (!allDone) return;
  await withTenantDb(tenantId, (db) =>
    db.update(pickSlipsTable).set({ status: "picked", completedAt: new Date() })
      .where(and(eq(pickSlipsTable.id, slipId), eq(pickSlipsTable.tenantId, tenantId), sql`${pickSlipsTable.status} <> 'picked'`)));
}

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

  // Resolve soLine data and validate each line belongs to this SO
  const soLineIds = parsed.data.lines.map((l) => l.soLineId);
  const soLineMap = new Map<number, typeof soLinesTable.$inferSelect>();
  if (soLineIds.length > 0) {
    const soLineRows = await withTenantDb(tenantId, (db) => db.select().from(soLinesTable).where(and(inArray(soLinesTable.id, soLineIds), eq(soLinesTable.tenantId, tenantId))));
    for (const sl of soLineRows) soLineMap.set(sl.id, sl);
  }

  // Validate: each line must belong to the provided soId, and qty must not exceed remaining
  for (const l of parsed.data.lines) {
    const soLine = soLineMap.get(l.soLineId);
    if (!soLine) { res.status(400).json({ error: `soLineId ${l.soLineId} does not exist or does not belong to this sales order` }); return; }
    if (soLine.soId !== parsed.data.soId) { res.status(400).json({ error: `soLineId ${l.soLineId} belongs to a different sales order` }); return; }
    const remaining = Number(soLine.quantity) - Number(soLine.despatched_qty ?? 0);
    if (l.quantity > remaining + 0.0001) {
      res.status(400).json({ error: `Despatch quantity ${l.quantity} for line ${l.soLineId} exceeds remaining unfulfilled quantity ${remaining.toFixed(4)}` });
      return;
    }
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

/** Error carrying a user-facing reason for a failed despatch confirmation */
class DespatchConfirmError extends Error {}

/** Format a quantity without trailing zeros (e.g. 1 instead of 1.0000) */
function fmtQty(n: number): string {
  return String(Number(n.toFixed(4)));
}

router.post("/sales/despatches/:id/confirm", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [despatch] = await withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).limit(1));
  if (!despatch) { res.status(404).json({ error: "Despatch not found" }); return; }
  if (despatch.status !== "draft") { res.status(400).json({ error: "Despatch is already confirmed" }); return; }
  if (!despatch.warehouseId) { res.status(400).json({ error: "No warehouse assigned to this despatch. Assign a warehouse before confirming." }); return; }

  const lines = await withTenantDb(tenantId, (db) => db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, id), eq(despatchLinesTable.tenantId, tenantId))));
  const [warehouse] = await withTenantDb(tenantId, (db) => db.select({ name: warehousesTable.name, code: warehousesTable.code }).from(warehousesTable).where(and(eq(warehousesTable.id, despatch.warehouseId!), eq(warehousesTable.tenantId, tenantId))).limit(1));
  const warehouseLabel = warehouse?.name ?? warehouse?.code ?? `#${despatch.warehouseId}`;

  let result;
  try {
    result = await withTenantDb(tenantId, async (db) => {
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

      const itemLabel = line.itemCode ?? line.itemName ?? `item #${resolvedItemId}`;
      if (!stock) {
        // No matching stock bucket — fail the transaction to prevent phantom inventory movement
        throw new DespatchConfirmError(
          `No stock record found for ${itemLabel} in warehouse ${warehouseLabel}` +
          (locationId ? ` / location ${locationId}` : "") +
          `. Receive the item into inventory before despatching.`,
        );
      }

      const currentQty = Number(stock.qtyOnHand ?? 0);
      if (currentQty < qty - 0.0001) {
        throw new DespatchConfirmError(`Insufficient stock for ${itemLabel} in warehouse ${warehouseLabel}: ${fmtQty(currentQty)} on hand, ${fmtQty(qty)} required. Adjust stock or reduce the despatch quantity.`);
      }
      const unitCostForMovement = line.unitCost ?? stock.averageCost ?? undefined;
      await db.update(inventoryStockTable)
        .set({ qtyOnHand: sql`${inventoryStockTable.qtyOnHand} - ${qty.toFixed(4)}`, qtyReserved: sql`GREATEST(0, ${inventoryStockTable.qtyReserved} - ${qty.toFixed(4)})`, lastMovementAt: new Date() })
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

      // Consume the matching SO allocation so releaseAllocations only frees the unconsumed remainder.
      // This prevents over-release when an SO is partially despatched then cancelled.
      const [matchingAlloc] = await db.select().from(soAllocationsTable)
        .where(and(
          eq(soAllocationsTable.soId, despatch.soId),
          eq(soAllocationsTable.soLineId, line.soLineId),
          eq(soAllocationsTable.itemId, resolvedItemId),
          eq(soAllocationsTable.warehouseId, warehouseId),
          eq(soAllocationsTable.tenantId, tenantId),
          eq(soAllocationsTable.isReleased, false),
        )).limit(1);
      if (matchingAlloc) {
        const remainingAlloc = Math.max(0, Number(matchingAlloc.allocatedQty) - qty);
        if (remainingAlloc <= 0.0001) {
          // Fully consumed — mark released so releaseAllocations skips it
          await db.update(soAllocationsTable)
            .set({ allocatedQty: "0", isReleased: true, releasedAt: new Date() })
            .where(and(eq(soAllocationsTable.id, matchingAlloc.id), eq(soAllocationsTable.tenantId, tenantId)));
        } else {
          // Partially consumed — reduce outstanding allocated qty to the remainder
          await db.update(soAllocationsTable)
            .set({ allocatedQty: remainingAlloc.toFixed(4) })
            .where(and(eq(soAllocationsTable.id, matchingAlloc.id), eq(soAllocationsTable.tenantId, tenantId)));
        }
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
  } catch (err) {
    if (err instanceof DespatchConfirmError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "despatch.confirmed", entityType: "despatch", entityId: String(id) });
  res.json(result);
});

/** Delivery Docket PDF: print-ready HTML for a confirmed despatch */
router.get("/sales/despatches/:id/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  const [despatch] = await withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).limit(1));
  if (!despatch) { res.status(404).json({ error: "Despatch not found" }); return; }
  const lines = await withTenantDb(tenantId, (db) => db.select().from(despatchLinesTable).where(and(eq(despatchLinesTable.despatchId, id), eq(despatchLinesTable.tenantId, tenantId))));
  const lineRows = lines.map((l) => `<tr><td>${escapeHtml(l.itemCode)}</td><td>${escapeHtml(l.itemName)}</td><td style="text-align:right">${Number(l.quantity).toFixed(2)}</td><td>${escapeHtml(l.lotNumber)}</td><td>${escapeHtml(l.serialNumber)}</td><td>${escapeHtml(l.notes)}</td></tr>`).join("");
  const safeCode = escapeHtml(despatch.code);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Delivery Docket ${safeCode}</title>
  <style>body{font-family:Arial,sans-serif;font-size:13px;margin:32px}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:16px}th{background:#f3f4f6;text-align:left;padding:6px 8px;border:1px solid #e5e7eb}td{padding:6px 8px;border:1px solid #e5e7eb}@media print{body{margin:16px}}</style>
  </head><body onload="window.print()">
  <h1>Delivery Docket</h1>
  <div style="display:flex;gap:48px;margin-bottom:24px">
    <div><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Docket No.</div><div style="font-weight:600">${safeCode}</div></div>
    <div><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Despatch Date</div><div>${escapeHtml(despatch.despatchDate ?? new Date().toISOString().split("T")[0])}</div></div>
    <div><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Sales Order</div><div>SO-${Number(despatch.soId)}</div></div>
    <div><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Carrier</div><div>${escapeHtml(despatch.carrier) || "—"}</div></div>
    <div><div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Tracking</div><div>${escapeHtml(despatch.trackingNumber) || "—"}</div></div>
  </div>
  <table><thead><tr><th>Item Code</th><th>Description</th><th style="text-align:right">Qty</th><th>Lot/Batch</th><th>Serial</th><th>Notes</th></tr></thead>
  <tbody>${lineRows}</tbody></table>
  <div style="margin-top:40px;display:flex;gap:64px">
    <div><div style="border-top:1px solid #374151;width:200px;padding-top:4px">Despatched by / Date</div></div>
    <div><div style="border-top:1px solid #374151;width:200px;padding-top:4px">Received by / Date</div></div>
  </div>
  </body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/** Cancel (delete) a draft despatch */
router.delete("/sales/despatches/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [despatch] = await withTenantDb(tenantId, (db) => db.select().from(despatchesTable).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))).limit(1));
  if (!despatch) { res.status(404).json({ error: "Despatch not found" }); return; }
  if (despatch.status !== "draft") { res.status(400).json({ error: "Only draft despatches can be cancelled" }); return; }
  await withTenantDb(tenantId, (db) => db.update(despatchesTable).set({ status: "cancelled" }).where(and(eq(despatchesTable.id, id), eq(despatchesTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "despatch.cancelled", entityType: "despatch", entityId: String(id) });
  res.status(204).send();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Customer Invoices ─────────────────────────────════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/sales/invoices", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { soId, status, customerId, search, page = "1", limit = "25" } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page)); const lim = Math.min(100, Math.max(1, Number(limit)));
  const rows = await withTenantDb(tenantId, (db) =>
    db.select().from(customerInvoicesTable)
      .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt),
        soId ? eq(customerInvoicesTable.soId, Number(soId)) : undefined,
        status ? eq(customerInvoicesTable.status, status) : undefined,
        customerId ? eq(customerInvoicesTable.customerId, Number(customerId)) : undefined,
        search ? or(
          ilike(customerInvoicesTable.code, `%${search}%`),
          ilike(customerInvoicesTable.customerName, `%${search}%`),
          ilike(customerInvoicesTable.notes, `%${search}%`),
          sql`EXISTS (SELECT 1 FROM customer_invoice_lines il WHERE il.invoice_id = ${customerInvoicesTable.id} AND il.tenant_id = ${customerInvoicesTable.tenantId} AND il.notes ILIKE ${`%${search}%`})`,
        ) : undefined))
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
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(l.itemCode)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${escapeHtml(l.description ?? l.itemName)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.quantity).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.unitPrice).toFixed(2)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.discountPct ?? 0).toFixed(1)}%</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right">${Number(l.taxPct ?? 0).toFixed(1)}%</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:500">${Number(l.lineTotal ?? 0).toFixed(2)}</td>
    </tr>`).join("");
  const safeInvoiceCode = escapeHtml(invoice.code ?? `INV-${id}`);
  const safeCurrency = escapeHtml(invoice.currencyCode ?? "AUD");
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invoice ${safeInvoiceCode}</title>
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
      <div style="margin-top:8px;font-size:20px;font-weight:600">${safeInvoiceCode}</div>
      <div style="margin-top:4px;color:#6b7280">Date: ${escapeHtml(invoice.invoiceDate ?? invoice.createdAt?.toString().slice(0, 10))}</div>
      ${invoice.dueDate ? `<div style="color:#6b7280">Due: ${escapeHtml(invoice.dueDate)}</div>` : ""}
    </div>
    <div style="text-align:right">
      <span class="badge">${escapeHtml(invoice.status?.toUpperCase() ?? "ISSUED")}</span>
      ${invoice.soId ? `<div style="margin-top:8px;color:#6b7280">Sales Order: SO-${Number(invoice.soId)}</div>` : ""}
    </div>
  </div>
  <div style="display:flex;gap:48px;margin-bottom:24px">
    <div>
      <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Bill To</div>
      <div style="font-weight:600">${escapeHtml(invoice.customerName)}</div>
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
      <tr><td>Subtotal</td><td style="text-align:right">${safeCurrency} ${Number(invoice.subtotal ?? 0).toFixed(2)}</td></tr>
      <tr><td>Tax</td><td style="text-align:right">${safeCurrency} ${Number(invoice.taxAmount ?? 0).toFixed(2)}</td></tr>
      <tr class="grand"><td>Total</td><td style="text-align:right">${safeCurrency} ${Number(invoice.total ?? 0).toFixed(2)}</td></tr>
      ${Number(invoice.paidAmount ?? 0) > 0 ? `<tr><td>Paid</td><td style="text-align:right">${safeCurrency} ${Number(invoice.paidAmount).toFixed(2)}</td></tr>
      <tr class="grand" style="color:#dc2626"><td>Balance Due</td><td style="text-align:right">${safeCurrency} ${(Number(invoice.total ?? 0) - Number(invoice.paidAmount ?? 0)).toFixed(2)}</td></tr>` : ""}
    </table>
  </div>
  ${invoice.notes ? `<div style="margin-top:32px;padding:16px;background:#f8fafc;border-radius:8px"><strong>Notes:</strong> ${escapeHtml(invoice.notes)}</div>` : ""}
  <div style="margin-top:40px;text-align:center;font-size:11px;color:#9ca3af">Generated by Forge ERP</div>
  <script>window.onload = () => window.print();</script>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
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

  // Credit limit enforcement at invoice creation
  if (so.customerId) {
    const [cust] = await withTenantDb(tenantId, (db) =>
      db.select({ creditLimit: customersTable.creditLimit }).from(customersTable).where(and(eq(customersTable.id, so.customerId!), eq(customersTable.tenantId, tenantId))).limit(1));
    const creditLimit = cust?.creditLimit ? Number(cust.creditLimit) : 0;
    if (creditLimit > 0) {
      const [outstanding] = await withTenantDb(tenantId, (db) =>
        db.select({ total: sql<string>`coalesce(sum(total),0)` }).from(customerInvoicesTable)
          .where(and(eq(customerInvoicesTable.tenantId, tenantId), eq(customerInvoicesTable.customerId, so.customerId!),
            isNull(customerInvoicesTable.deletedAt), sql`status NOT IN ('paid','voided')`)));
      const outstandingBalance = Number(outstanding?.total ?? 0);
      const newInvSubtotal = parsed.data.lines.reduce((s, l) => s + l.quantity * l.unitPrice * (1 - l.discountPct / 100) * (1 + l.taxPct / 100), 0);
      if (outstandingBalance + newInvSubtotal > creditLimit) {
        res.status(422).json({
          error: "Credit limit exceeded",
          detail: `Customer credit limit is ${creditLimit.toFixed(2)}. Outstanding balance ${outstandingBalance.toFixed(2)} plus this invoice ${newInvSubtotal.toFixed(2)} would exceed the limit.`,
          creditLimit, outstandingBalance, newInvoiceTotal: newInvSubtotal,
        });
        return;
      }
    }
  }

  // Validate invoice quantities against despatched (but not yet invoiced) quantities
  const soLineIdsToCheck = [...new Set(parsed.data.lines.filter((l) => l.soLineId).map((l) => l.soLineId!))];
  if (soLineIdsToCheck.length > 0) {
    const soLineRows = await withTenantDb(tenantId, (db) =>
      db.select({ id: soLinesTable.id, soId: soLinesTable.soId, itemCode: soLinesTable.itemCode, despatched_qty: soLinesTable.despatched_qty, invoiced_qty: soLinesTable.invoiced_qty })
        .from(soLinesTable)
        .where(and(inArray(soLinesTable.id, soLineIdsToCheck), eq(soLinesTable.tenantId, tenantId))));
    // Group requested quantities by soLineId
    const requestedByLine = new Map<number, number>();
    for (const l of parsed.data.lines) {
      if (l.soLineId) requestedByLine.set(l.soLineId, (requestedByLine.get(l.soLineId) ?? 0) + l.quantity);
    }
    for (const row of soLineRows) {
      // Enforce that invoice lines belong to the invoice's own SO
      if (row.soId !== parsed.data.soId) {
        res.status(422).json({
          error: "Line belongs to a different sales order",
          detail: `SO line ${row.id} belongs to SO ${row.soId}, not SO ${parsed.data.soId}. Invoice lines must reference lines from the same sales order.`,
        });
        return;
      }
      const despatchedQty = Number(row.despatched_qty ?? 0);
      const invoicedQty = Number(row.invoiced_qty ?? 0);
      const invoiceable = despatchedQty - invoicedQty;
      const requested = requestedByLine.get(row.id) ?? 0;
      if (requested > invoiceable + 0.0001) {
        res.status(422).json({
          error: "Invoice quantity exceeds despatched quantity",
          detail: `Item ${row.itemCode ?? row.id}: despatched ${despatchedQty.toFixed(4)}, already invoiced ${invoicedQty.toFixed(4)}, invoiceable ${invoiceable.toFixed(4)}, requested ${requested.toFixed(4)}. Despatch the goods before invoicing.`,
        });
        return;
      }
    }
  }

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
  // Post GL: Dr AR / Cr Revenue + Cr Tax Liability; persist glPostingId back to invoice for traceability
  const posting = await withTenantDb(tenantId, (db) => createInvoiceGlPosting(db, tenantId, result, clerkUserId, userEmail));
  if (posting?.id) {
    await withTenantDb(tenantId, (db) => db.update(customerInvoicesTable).set({ glPostingId: posting.id }).where(eq(customerInvoicesTable.id, result)));
  }
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

  // Resolve recipient: explicit body param → invoice customer email → fallback to customer record
  let toEmail = (req.body as { email?: string }).email ?? invoice.customerEmail ?? null;
  if (!toEmail && invoice.customerId) {
    const [cust] = await withTenantDb(tenantId, (db) =>
      db.select({ email: customersTable.email }).from(customersTable)
        .where(and(eq(customersTable.id, invoice.customerId!), eq(customersTable.tenantId, tenantId))).limit(1));
    toEmail = cust?.email ?? null;
  }
  if (!toEmail) { res.status(400).json({ error: "No customer email available. Provide email in request body or set on invoice/customer." }); return; }

  // Build PDF attachment + branded HTML
  // customerInvoiceLinesTable has no lineNumber column — order by id for stable ordering.
  const [lines, tenant] = await Promise.all([
    withTenantDb(tenantId, (db) => db.select().from(customerInvoiceLinesTable)
      .where(and(eq(customerInvoiceLinesTable.invoiceId, id), eq(customerInvoiceLinesTable.tenantId, tenantId)))
      .orderBy(customerInvoiceLinesTable.id)),
    loadTenantHeader(tenantId),
  ]);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateInvoicePdf(invoice, lines, tenant);
  } catch (err) {
    logger.warn({ err, invoiceId: id }, "Invoice PDF generation failed");
    res.status(500).json({ error: "Failed to render invoice PDF. Invoice status was not changed." });
    return;
  }
  const companyName = tenant?.tradingName ?? tenant?.name ?? "Forge ERP";
  const balance = Number(invoice.total) - Number(invoice.paidAmount ?? 0);

  let emailSent = false;
  try {
    emailSent = await sendEmail({
      to: toEmail,
      subject: `Invoice ${invoice.code} from ${companyName} — ${invoice.currencyCode} ${Number(invoice.total).toFixed(2)}`,
      html: buildInvoiceEmailHtml(invoice, tenant),
      text: `Dear ${invoice.customerName ?? "Customer"},\n\nPlease find attached invoice ${invoice.code} for ${balance.toFixed(2)} ${invoice.currencyCode}.${invoice.dueDate ? `\nPayment is due by ${invoice.dueDate}.` : ""}\nPlease reference invoice ${invoice.code} when remitting payment.\n\n${companyName}`,
      attachments: [{ filename: `${invoice.code}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
    });
  } catch (err) {
    logger.warn({ err, invoiceId: id, toEmail }, "Invoice email dispatch failed");
    res.status(502).json({ error: "Email dispatch failed. Invoice status was not changed.", customerEmail: toEmail });
    return;
  }
  if (!emailSent) { res.status(502).json({ error: "Email could not be dispatched (mail transport unavailable). Invoice status was not changed.", customerEmail: toEmail, emailSent: false }); return; }

  const [updated] = await withTenantDb(tenantId, (db) => db.update(customerInvoicesTable).set({ status: "sent", sentAt: new Date() }).where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId))).returning());
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "invoice.sent", entityType: "customer_invoice", entityId: String(id), newValues: { customerEmail: toEmail, emailSent } });
  res.json({ ...updated, emailSent, sentTo: toEmail });
});

/** Void (delete) a draft invoice */
router.delete("/sales/invoices/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [invoice] = await withTenantDb(tenantId, (db) =>
    db.select().from(customerInvoicesTable)
      .where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt))).limit(1));
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (!["draft"].includes(invoice.status)) { res.status(400).json({ error: "Only draft invoices can be voided; for sent invoices create a credit note" }); return; }

  // Fetch invoice lines so we can reverse their invoiced_qty contributions
  const invoiceLines = await withTenantDb(tenantId, (db) =>
    db.select({ soLineId: customerInvoiceLinesTable.soLineId, quantity: customerInvoiceLinesTable.quantity })
      .from(customerInvoiceLinesTable)
      .where(and(eq(customerInvoiceLinesTable.invoiceId, id), eq(customerInvoiceLinesTable.tenantId, tenantId))));

  await withTenantDb(tenantId, async (db) => {
    // Soft-delete the invoice
    await db.update(customerInvoicesTable)
      .set({ status: "voided", deletedAt: new Date() })
      .where(and(eq(customerInvoicesTable.id, id), eq(customerInvoicesTable.tenantId, tenantId)));

    // Reverse invoiced_qty on every SO line that was referenced
    for (const line of invoiceLines) {
      if (line.soLineId) {
        const qty = Number(line.quantity ?? 0);
        await db.update(soLinesTable)
          .set({ invoiced_qty: sql`GREATEST(0, ${soLinesTable.invoiced_qty} - ${qty.toFixed(4)})` })
          .where(and(eq(soLinesTable.id, line.soLineId), eq(soLinesTable.tenantId, tenantId)));
      }
    }

    // Recalculate SO status after reversals
    if (invoice.soId) {
      await recalcSoStatus(db, tenantId, invoice.soId);
    }

    // Reverse the original GL posting (Dr Revenue+Tax / Cr AR) to keep ledger balanced
    if (invoice.glPostingId) {
      const [origPosting] = await db.select().from(glPostingsTable)
        .where(and(eq(glPostingsTable.id, invoice.glPostingId), eq(glPostingsTable.tenantId, tenantId))).limit(1);
      if (origPosting && origPosting.lines) {
        const origLines = origPosting.lines as Array<{ accountCode: string; accountName: string; debit: number; credit: number; description: string }>;
        const reversalLines = origLines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, description: `VOID: ${l.description}` }));
        const totalDebit = reversalLines.reduce((s, l) => s + Number(l.debit), 0);
        const totalCredit = reversalLines.reduce((s, l) => s + Number(l.credit), 0);
        await db.insert(glPostingsTable).values({
          tenantId, code: `GL-VOID-INV-${Date.now()}`, entityType: "customer_invoice", entityId: id,
          status: "posted", postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined, postedAt: new Date(),
          lines: reversalLines, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2),
        } as typeof glPostingsTable.$inferInsert);
        // Mark original posting as voided
        await db.update(glPostingsTable).set({ status: "voided" } as Partial<typeof glPostingsTable.$inferInsert>)
          .where(eq(glPostingsTable.id, invoice.glPostingId));
      }
    }
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "invoice.voided", entityType: "customer_invoice", entityId: String(id) });
  res.status(204).send();
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
// ── Legacy invoice / credit-note bulk import ────────────════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// Imports historical customer invoices AND credit notes from legacy systems in a
// single upload (discriminated by docType). These documents are standalone: no
// sales order, no despatch, no stock movement, and the credit limit is bypassed.
// The original document number is used VERBATIM as the Forge code (no INV-/CN-
// prefix) so legacy documents are visually distinct from Forge-generated ones.
// Backdated dates are honored. Accounting integrity is preserved by routing
// through the same GL posting helpers as the standard endpoints
// (createInvoiceGlPosting / createCreditNoteGlPosting).
router.post("/sales/invoices/import", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;

  const lineSchema = z.object({
    itemCode: z.string().optional(),
    itemName: z.string().optional(),
    description: z.string().optional(),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    discountPct: z.number().min(0).max(100).default(0),
    taxPct: z.number().min(0).max(100).default(0),
    notes: z.string().optional(),
  });
  const docSchema = z.object({
    docType: z.enum(["invoice", "credit"]),
    documentNumber: z.string().trim().min(1, "documentNumber is required"),
    customerCode: z.string().trim().min(1, "customerCode is required"),
    documentDate: z.string().trim().min(1, "documentDate is required"),
    dueDate: z.string().trim().optional(),
    reason: z.string().optional(),
    notes: z.string().optional(),
    lines: z.array(lineSchema).min(1, "At least one line required"),
  });
  // Validate the envelope loosely so one bad document does not abort the whole
  // import — per-document validation happens in the loop and bad rows are
  // reported in errors[].
  const envelopeSchema = z.object({
    documents: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  });
  const envelope = envelopeSchema.safeParse(req.body);
  if (!envelope.success) { res.status(400).json({ error: "Validation failed", details: envelope.error.issues }); return; }

  // Pre-fetch existing codes (across BOTH invoice + credit-note tables) and
  // tenant customers once so the per-document loop stays in memory.
  const [existingInvCodes, existingCnCodes, customers] = await withTenantDb(tenantId, async (db) => {
    const inv = await db.select({ code: customerInvoicesTable.code }).from(customerInvoicesTable).where(eq(customerInvoicesTable.tenantId, tenantId));
    const cn = await db.select({ code: creditNotesTable.code }).from(creditNotesTable).where(eq(creditNotesTable.tenantId, tenantId));
    const custs = await db.select({ id: customersTable.id, code: customersTable.code, name: customersTable.name, email: customersTable.email })
      .from(customersTable).where(and(eq(customersTable.tenantId, tenantId), isNull(customersTable.deletedAt)));
    return [inv, cn, custs] as const;
  });
  const usedCodes = new Set<string>([...existingInvCodes.map((r) => r.code), ...existingCnCodes.map((r) => r.code)]);
  const customerByCode = new Map(customers.map((c) => [c.code, c]));

  // Normalize a legacy date to ISO YYYY-MM-DD. Legacy CSVs use day-first
  // DD/MM/YYYY (or DD-MM-YYYY); ISO YYYY-MM-DD is passed through. Returns null
  // for anything that is not a real calendar date so the row errors cleanly
  // instead of relying on Date.parse (which assumes US MM/DD and silently swaps
  // day/month or rejects day > 12).
  const normalizeImportDate = (input: string): string | null => {
    const s = input.trim();
    let y: number, m: number, d: number;
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (match) {
      y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
    } else {
      match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
      if (!match) return null;
      d = Number(match[1]); m = Number(match[2]); y = Number(match[3]);
    }
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    // Reject impossible days (e.g. 31/02) by round-tripping through UTC.
    const dt = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(dt.getTime()) || dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return null;
    return iso;
  };

  const documents = envelope.data.documents;
  let created = 0;
  const errors: { row: number; code: string; error: string }[] = [];

  for (let i = 0; i < documents.length; i++) {
    const raw = documents[i]!;
    const rowNum = i + 1;
    const rawCode = typeof raw.documentNumber === "string" ? raw.documentNumber : "";
    const parsed = docSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ row: rowNum, code: rawCode, error: parsed.error.issues.map((iss) => `${iss.path.join(".") || "row"}: ${iss.message}`).join("; ") });
      continue;
    }
    const doc = parsed.data;
    const code = doc.documentNumber;

    // Document number must be unique within the tenant (across both tables) and
    // within this batch — numbers are used verbatim as the Forge code.
    if (usedCodes.has(code)) {
      errors.push({ row: rowNum, code, error: `Document number "${code}" already exists or is duplicated in this file` });
      continue;
    }
    const customer = customerByCode.get(doc.customerCode);
    if (!customer) {
      errors.push({ row: rowNum, code, error: `Customer code "${doc.customerCode}" not found` });
      continue;
    }
    // Validate + normalize (backdated) dates up front. Legacy dates are
    // day-first DD/MM/YYYY; normalize to ISO so they store correctly and bad
    // dates give a clear per-document error instead of a silent day/month swap.
    const isoDocDate = normalizeImportDate(doc.documentDate);
    if (!isoDocDate) {
      errors.push({ row: rowNum, code, error: `Invalid documentDate "${doc.documentDate}" — use DD/MM/YYYY` });
      continue;
    }
    let isoDueDate: string | undefined;
    if (doc.dueDate) {
      const normalizedDue = normalizeImportDate(doc.dueDate);
      if (!normalizedDue) {
        errors.push({ row: rowNum, code, error: `Invalid dueDate "${doc.dueDate}" — use DD/MM/YYYY` });
        continue;
      }
      isoDueDate = normalizedDue;
    }

    // Header totals (discount + tax) computed the same way as the standard
    // invoice/credit-note endpoints.
    let subtotal = 0; let taxAmount = 0;
    const lineValues = doc.lines.map((l) => {
      const base = l.quantity * l.unitPrice * (1 - l.discountPct / 100);
      const tax = base * (l.taxPct / 100);
      subtotal += base; taxAmount += tax;
      return { ...l, lineTotal: (base + tax).toFixed(2) };
    });
    const total = subtotal + taxAmount;

    try {
      if (doc.docType === "invoice") {
        await withTenantDb(tenantId, async (db) => {
          const [invoice] = await db.insert(customerInvoicesTable).values({
            tenantId, code, status: "draft", source: "migration",
            customerId: customer.id, customerName: customer.name, customerEmail: customer.email ?? undefined,
            invoiceDate: isoDocDate, dueDate: isoDueDate ?? undefined,
            subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: total.toFixed(2),
            notes: doc.notes ?? undefined, createdByClerkId: clerkUserId, createdByEmail: userEmail,
          } as typeof customerInvoicesTable.$inferInsert).returning();
          const id = invoice!.id;
          await db.insert(customerInvoiceLinesTable).values(lineValues.map((l) => ({
            tenantId, invoiceId: id, itemCode: l.itemCode, itemName: l.itemName, description: l.description,
            quantity: String(l.quantity), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), taxPct: String(l.taxPct),
            lineTotal: l.lineTotal, notes: l.notes,
          }) as typeof customerInvoiceLinesTable.$inferInsert));
          // Dr AR / Cr Revenue (+Cr Tax) — matches the standard create, which posts GL on draft.
          const posting = await createInvoiceGlPosting(db, tenantId, id, clerkUserId, userEmail);
          if (posting?.id) await db.update(customerInvoicesTable).set({ glPostingId: posting.id }).where(eq(customerInvoicesTable.id, id));
        });
      } else {
        await withTenantDb(tenantId, async (db) => {
          const [cn] = await db.insert(creditNotesTable).values({
            // Backdated: issuedAt carries the legacy document date (credit notes have no separate date column).
            tenantId, code, status: "issued", source: "migration", issuedAt: new Date(`${isoDocDate}T00:00:00Z`),
            customerId: customer.id, customerName: customer.name, reason: doc.reason ?? undefined,
            subtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), total: total.toFixed(2),
            notes: doc.notes ?? undefined, createdByClerkId: clerkUserId, createdByEmail: userEmail,
          } as typeof creditNotesTable.$inferInsert).returning();
          const id = cn!.id;
          await db.insert(creditNoteLinesTable).values(lineValues.map((l) => ({
            tenantId, creditNoteId: id, itemCode: l.itemCode, itemName: l.itemName, description: l.description,
            quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxPct: String(l.taxPct),
            lineTotal: l.lineTotal, notes: l.notes,
          }) as typeof creditNoteLinesTable.$inferInsert));
          // Dr Revenue / Cr AR — CN GL only posts on issue, so imported credits are issued immediately.
          const posting = await createCreditNoteGlPosting(db, tenantId, id, clerkUserId, userEmail);
          if (posting?.id) await db.update(creditNotesTable).set({ glPostingId: posting.id }).where(eq(creditNotesTable.id, id));
        });
      }
      usedCodes.add(code);
      created++;
    } catch (err) {
      errors.push({ row: rowNum, code, error: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "invoice.bulk_import", entityType: "customer_invoice", entityId: tenantId, newValues: { created, failed: errors.length } });
  res.json({ created, failed: errors.length, errors });
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
    customerEmail: z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional()),
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

/** Cancel (delete) a draft/pending RMA */
router.delete("/sales/rma/:id", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  const [rma] = await withTenantDb(tenantId, (db) => db.select().from(rmaOrdersTable).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId), isNull(rmaOrdersTable.deletedAt))).limit(1));
  if (!rma) { res.status(404).json({ error: "RMA not found" }); return; }
  if (["received", "processed", "closed"].includes(rma.status)) { res.status(400).json({ error: `Cannot cancel RMA in status: ${rma.status}` }); return; }
  await withTenantDb(tenantId, (db) => db.update(rmaOrdersTable).set({ status: "cancelled", deletedAt: new Date() }).where(and(eq(rmaOrdersTable.id, id), eq(rmaOrdersTable.tenantId, tenantId))));
  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "rma.cancelled", entityType: "rma_order", entityId: String(id) });
  res.status(204).send();
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

// ── Sales Dashboard ────────────────────────────────────────────────────────────

/**
 * Consolidated dashboard endpoint for the Sales module. Returns:
 *  - openQuotationsCount        quotations not yet accepted/rejected/converted
 *  - openSalesOrders            count + dollar value of SOs still in pipeline
 *  - pendingDespatchCount       confirmed/picking/partially_despatched SOs
 *  - outstandingInvoices        count + remaining balance of unpaid invoices
 *  - overdueInvoices            count + remaining balance past dueDate
 *  - monthlySeries              last 12 months of revenue + invoice/order counts
 */
router.get("/sales/dashboard", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const today = new Date().toISOString().slice(0, 10);

  const [
    openQuotes,
    openSos,
    pendingDespatch,
    outstandingInv,
    overdueInv,
    monthly,
  ] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` })
        .from(quotationsTable)
        .where(and(
          eq(quotationsTable.tenantId, tenantId),
          isNull(quotationsTable.deletedAt),
          sql`${quotationsTable.status} IN ('draft','sent')`,
        ))),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(${salesOrdersTable.total}::numeric),0)` })
        .from(salesOrdersTable)
        .where(and(
          eq(salesOrdersTable.tenantId, tenantId),
          isNull(salesOrdersTable.deletedAt),
          sql`${salesOrdersTable.status} IN ('confirmed','picking','partially_despatched','despatched')`,
        ))),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` })
        .from(salesOrdersTable)
        .where(and(
          eq(salesOrdersTable.tenantId, tenantId),
          isNull(salesOrdersTable.deletedAt),
          sql`${salesOrdersTable.status} IN ('confirmed','picking','partially_despatched')`,
        ))),
    withTenantDb(tenantId, (db) =>
      db.select({
        count: sql<number>`count(*)`,
        balance: sql<string>`coalesce(sum((${customerInvoicesTable.total}::numeric - ${customerInvoicesTable.paidAmount}::numeric)),0)`,
      })
        .from(customerInvoicesTable)
        .where(and(
          eq(customerInvoicesTable.tenantId, tenantId),
          isNull(customerInvoicesTable.deletedAt),
          sql`${customerInvoicesTable.status} IN ('draft','sent')`,
          sql`(${customerInvoicesTable.total}::numeric - ${customerInvoicesTable.paidAmount}::numeric) > 0`,
        ))),
    withTenantDb(tenantId, (db) =>
      db.select({
        count: sql<number>`count(*)`,
        balance: sql<string>`coalesce(sum((${customerInvoicesTable.total}::numeric - ${customerInvoicesTable.paidAmount}::numeric)),0)`,
      })
        .from(customerInvoicesTable)
        .where(and(
          eq(customerInvoicesTable.tenantId, tenantId),
          isNull(customerInvoicesTable.deletedAt),
          sql`${customerInvoicesTable.status} IN ('draft','sent')`,
          sql`(${customerInvoicesTable.total}::numeric - ${customerInvoicesTable.paidAmount}::numeric) > 0`,
          sql`${customerInvoicesTable.dueDate} IS NOT NULL`,
          lte(customerInvoicesTable.dueDate, today),
        ))),
    withTenantDb(tenantId, async (db) => {
      const qr = await db.execute(sql`
        WITH months AS (
          SELECT to_char(date_trunc('month', (CURRENT_DATE - (n || ' months')::interval)), 'YYYY-MM') AS period
          FROM generate_series(0, 11) AS n
        ),
        invoice_agg AS (
          SELECT to_char(invoice_date::date, 'YYYY-MM') AS period,
                 COALESCE(SUM(total::numeric), 0)        AS revenue,
                 COUNT(*)                                AS invoice_count
          FROM customer_invoices
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND status NOT IN ('voided','cancelled')
            AND invoice_date IS NOT NULL
            AND invoice_date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '11 months')
          GROUP BY 1
        ),
        order_agg AS (
          SELECT to_char(created_at::date, 'YYYY-MM') AS period,
                 COUNT(*) AS order_count
          FROM sales_orders
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND status NOT IN ('cancelled')
            AND created_at >= (date_trunc('month', CURRENT_DATE) - INTERVAL '11 months')
          GROUP BY 1
        )
        SELECT m.period,
               COALESCE(i.revenue, 0)         AS revenue,
               COALESCE(o.order_count, 0)     AS "orderCount",
               COALESCE(i.invoice_count, 0)   AS "invoiceCount"
        FROM months m
        LEFT JOIN invoice_agg i ON i.period = m.period
        LEFT JOIN order_agg o ON o.period = m.period
        ORDER BY m.period ASC
      `);
      return qr.rows as unknown as Array<{ period: string; revenue: string; orderCount: string; invoiceCount: string }>;
    }),
  ]);

  res.json({
    openQuotationsCount: Number(openQuotes[0]?.count ?? 0),
    openSalesOrders: {
      count: Number(openSos[0]?.count ?? 0),
      value: Number(openSos[0]?.total ?? 0),
    },
    pendingDespatchCount: Number(pendingDespatch[0]?.count ?? 0),
    outstandingInvoices: {
      count: Number(outstandingInv[0]?.count ?? 0),
      total: Number(outstandingInv[0]?.balance ?? 0),
    },
    overdueInvoices: {
      count: Number(overdueInv[0]?.count ?? 0),
      total: Number(overdueInv[0]?.balance ?? 0),
    },
    monthlySeries: monthly.map((r) => ({
      period: r.period,
      revenue: Number(r.revenue ?? 0),
      orderCount: Number(r.orderCount ?? 0),
      invoiceCount: Number(r.invoiceCount ?? 0),
    })),
  });
});

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

// ── Extended Sales Reports ─────────────────────────────────────────────────────

/** Sales analysis by item: revenue, cost, qty sold, gross margin per item */
router.get("/sales/reports/by-item", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      itemId: customerInvoiceLinesTable.itemId,
      itemCode: customerInvoiceLinesTable.itemCode,
      itemName: customerInvoiceLinesTable.itemName,
      totalQty: sql<string>`coalesce(sum(${customerInvoiceLinesTable.quantity}::numeric), 0)`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoiceLinesTable.lineTotal}::numeric), 0)`,
      invoiceCount: sql<number>`count(distinct ${customerInvoiceLinesTable.invoiceId})`,
    })
    .from(customerInvoiceLinesTable)
    .innerJoin(customerInvoicesTable, eq(customerInvoiceLinesTable.invoiceId, customerInvoicesTable.id))
    .where(and(
      eq(customerInvoiceLinesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(customerInvoiceLinesTable.itemId, customerInvoiceLinesTable.itemCode, customerInvoiceLinesTable.itemName)
    .orderBy(sql`sum(${customerInvoiceLinesTable.lineTotal}::numeric) desc`));
  res.json(rows);
});

/** Sales analysis by customer: revenue, invoice count, average order value */
router.get("/sales/reports/by-customer", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      customerId: customerInvoicesTable.customerId,
      customerName: customerInvoicesTable.customerName,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
      avgInvoiceValue: sql<string>`coalesce(avg(${customerInvoicesTable.total}::numeric), 0)`,
    })
    .from(customerInvoicesTable)
    .where(and(
      eq(customerInvoicesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(customerInvoicesTable.customerId, customerInvoicesTable.customerName)
    .orderBy(sql`sum(${customerInvoicesTable.total}::numeric) desc`));
  res.json(rows);
});

/** Sales analysis by period (month/year): revenue and invoice count per month */
router.get("/sales/reports/by-period", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      period: sql<string>`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
      orderCount: sql<number>`count(distinct ${customerInvoicesTable.soId})`,
    })
    .from(customerInvoicesTable)
    .where(and(
      eq(customerInvoicesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM') asc`));
  res.json(rows);
});

/** Customer statement: all invoices vs payments (amounts) for a customer */
router.get("/sales/reports/customer-statement", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { customerId, fromDate, toDate } = req.query as Record<string, string>;
  if (!customerId) { res.status(400).json({ error: "customerId is required" }); return; }
  const invoices = await withTenantDb(tenantId, (db) =>
    db.select({
      id: customerInvoicesTable.id, code: customerInvoicesTable.code,
      invoiceDate: customerInvoicesTable.invoiceDate, dueDate: customerInvoicesTable.dueDate,
      total: customerInvoicesTable.total, status: customerInvoicesTable.status,
      currencyCode: customerInvoicesTable.currencyCode,
    })
    .from(customerInvoicesTable)
    .where(and(
      eq(customerInvoicesTable.tenantId, tenantId),
      eq(customerInvoicesTable.customerId, Number(customerId)),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .orderBy(customerInvoicesTable.invoiceDate));
  const totalBilled = invoices.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const totalPaid = invoices.filter((i) => i.status === "paid").reduce((s, i) => s + Number(i.total ?? 0), 0);
  res.json({ customerId: Number(customerId), invoices, totalBilled, totalPaid, balance: totalBilled - totalPaid });
});

/** Sales analysis by sales rep: total orders, revenue, and invoiced amount grouped by salesRepName */
router.get("/sales/reports/by-rep", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      salesRepId: salesOrdersTable.salesRepId,
      salesRepName: salesOrdersTable.salesRepName,
      orderCount: sql<string>`count(distinct ${salesOrdersTable.id})`,
      totalOrders: sql<string>`coalesce(sum(${salesOrdersTable.total}), 0)`,
    })
    .from(salesOrdersTable)
    .where(and(
      eq(salesOrdersTable.tenantId, tenantId),
      isNull(salesOrdersTable.deletedAt),
      sql`${salesOrdersTable.status} NOT IN ('cancelled')`,
      fromDate ? sql`${salesOrdersTable.createdAt}::date >= ${fromDate}` : undefined,
      toDate ? sql`${salesOrdersTable.createdAt}::date <= ${toDate}` : undefined,
    ))
    .groupBy(salesOrdersTable.salesRepId, salesOrdersTable.salesRepName)
    .orderBy(sql`sum(${salesOrdersTable.total}) desc`));
  // Merge un-assigned rep rows under a single "Unassigned" entry
  const unassigned = rows.filter((r) => !r.salesRepName);
  const assigned = rows.filter((r) => !!r.salesRepName);
  const result = [
    ...assigned.map((r) => ({ salesRepId: r.salesRepId, salesRepName: r.salesRepName ?? "Unknown", orderCount: Number(r.orderCount), totalOrders: Number(r.totalOrders) })),
    ...(unassigned.length > 0 ? [{ salesRepId: null, salesRepName: "Unassigned", orderCount: unassigned.reduce((s, r) => s + Number(r.orderCount), 0), totalOrders: unassigned.reduce((s, r) => s + Number(r.totalOrders), 0) }] : []),
  ];
  res.json(result);
});

/** Alternative item suggestions: items in the same category with available stock */
router.get("/sales/alternatives", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { itemId, warehouseId } = req.query as Record<string, string>;
  if (!itemId) { res.status(400).json({ error: "itemId is required" }); return; }
  // Look up the reference item's category
  const [item] = await withTenantDb(tenantId, (db) =>
    db.select({ category: itemsTable.category, code: itemsTable.code })
      .from(itemsTable)
      .where(and(eq(itemsTable.id, Number(itemId)), eq(itemsTable.tenantId, tenantId)))
      .limit(1));
  if (!item) { res.status(404).json({ error: "Item not found" }); return; }

  // Find alternative items in the same category that have available ATP
  const alternatives = await withTenantDb(tenantId, (db) =>
    db.select({
      id: itemsTable.id, code: itemsTable.code, name: itemsTable.name,
      qtyOnHand: sql<string>`coalesce(sum(${inventoryStockTable.qtyOnHand}), 0)`,
      qtyAvailable: sql<string>`coalesce(sum(${inventoryStockTable.qtyOnHand} - ${inventoryStockTable.qtyReserved}), 0)`,
    })
    .from(itemsTable)
    .leftJoin(inventoryStockTable, and(
      eq(inventoryStockTable.itemId, itemsTable.id),
      eq(inventoryStockTable.tenantId, tenantId),
      warehouseId ? eq(inventoryStockTable.warehouseId, Number(warehouseId)) : sql`1=1`,
    ))
    .where(and(
      eq(itemsTable.tenantId, tenantId),
      isNull(itemsTable.deletedAt),
      sql`${itemsTable.id} != ${Number(itemId)}`,
      item.category ? eq(itemsTable.category, item.category) : sql`1=1`,
    ))
    .groupBy(itemsTable.id, itemsTable.code, itemsTable.name)
    .having(sql`coalesce(sum(${inventoryStockTable.qtyOnHand} - ${inventoryStockTable.qtyReserved}), 0) > 0`)
    .orderBy(sql`coalesce(sum(${inventoryStockTable.qtyOnHand} - ${inventoryStockTable.qtyReserved}), 0) desc`)
    .limit(10));
  res.json({ referenceItem: { id: Number(itemId), code: item.code }, alternatives: alternatives.map((a) => ({ ...a, qtyOnHand: Number(a.qtyOnHand), qtyAvailable: Number(a.qtyAvailable) })) });
});

// ── Invoice Aging Report ───────────────────────────────────────────────────────

/**
 * GET /sales/reports/invoice-aging
 * Group outstanding invoices into aging buckets: current, 1-30, 31-60, 61-90, 90+ days overdue.
 */
router.get("/sales/reports/invoice-aging", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { customerId } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        ci.id,
        ci.code,
        ci.customer_name AS "customerName",
        ci.invoice_date AS "invoiceDate",
        ci.due_date AS "dueDate",
        ci.total::numeric AS "total",
        ci.paid_amount::numeric AS "paidAmount",
        (ci.total::numeric - ci.paid_amount::numeric) AS "balance",
        CURRENT_DATE - ci.due_date::date AS "daysOverdue",
        CASE
          WHEN ci.due_date IS NULL OR ci.due_date::date >= CURRENT_DATE THEN 'current'
          WHEN CURRENT_DATE - ci.due_date::date <= 30 THEN '1_to_30'
          WHEN CURRENT_DATE - ci.due_date::date <= 60 THEN '31_to_60'
          WHEN CURRENT_DATE - ci.due_date::date <= 90 THEN '61_to_90'
          ELSE 'over_90'
        END AS "agingBucket"
      FROM customer_invoices ci
      WHERE ci.tenant_id = ${tenantId}
        AND ci.deleted_at IS NULL
        AND ci.status IN ('sent', 'draft')
        AND (ci.total::numeric - ci.paid_amount::numeric) > 0
        ${customerId ? sql`AND ci.customer_id = ${Number(customerId)}` : sql``}
      ORDER BY ci.due_date ASC NULLS LAST
    `)
  );
  const rows = qr.rows as Array<{ id: number; code: string; customerName: string | null; invoiceDate: string | null; dueDate: string | null; total: number; paidAmount: number; balance: number; daysOverdue: number | null; agingBucket: string }>;

  // Aggregate totals per bucket
  const buckets = ["current", "1_to_30", "31_to_60", "61_to_90", "over_90"];
  const summary = Object.fromEntries(buckets.map(b => [b, { count: 0, total: 0 }]));
  for (const r of rows) {
    const bucket = summary[r.agingBucket];
    if (bucket) { bucket.count++; bucket.total += Number(r.balance); }
  }

  res.json({ invoices: rows, summary });
});

/**
 * GET /sales/reports/invoice-aging/export/csv
 * Export invoice aging report as CSV.
 */
router.get("/sales/reports/invoice-aging/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;

  const qr2 = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT ci.code, ci.customer_name AS "customerName", ci.invoice_date AS "invoiceDate",
             ci.due_date AS "dueDate", ci.total::numeric AS "total", ci.paid_amount::numeric AS "paidAmount",
             (ci.total::numeric - ci.paid_amount::numeric) AS "balance",
             CURRENT_DATE - ci.due_date::date AS "daysOverdue",
             CASE
               WHEN ci.due_date IS NULL OR ci.due_date::date >= CURRENT_DATE THEN 'Current'
               WHEN CURRENT_DATE - ci.due_date::date <= 30 THEN '1-30 Days'
               WHEN CURRENT_DATE - ci.due_date::date <= 60 THEN '31-60 Days'
               WHEN CURRENT_DATE - ci.due_date::date <= 90 THEN '61-90 Days'
               ELSE '90+ Days'
             END AS "agingBucket"
      FROM customer_invoices ci
      WHERE ci.tenant_id = ${tenantId} AND ci.deleted_at IS NULL
        AND ci.status IN ('sent','draft') AND (ci.total::numeric - ci.paid_amount::numeric) > 0
      ORDER BY ci.due_date ASC NULLS LAST LIMIT 5000
    `)
  );
  const rows = qr2.rows as Array<{ code: string; customerName: string | null; invoiceDate: string | null; dueDate: string | null; total: number; paidAmount: number; balance: number; daysOverdue: number | null; agingBucket: string }>;

  const escape = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    ["Invoice", "Customer", "Invoice Date", "Due Date", "Total", "Paid", "Balance", "Days Overdue", "Aging Bucket"].join(","),
    ...rows.map(r => [r.code, r.customerName ?? "", r.invoiceDate ?? "", r.dueDate ?? "", Number(r.total).toFixed(2), Number(r.paidAmount).toFixed(2), Number(r.balance).toFixed(2), r.daysOverdue ?? 0, r.agingBucket].map(escape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "invoice-aging", "csv")}"`);
  res.send(lines.join("\r\n"));
});

/**
 * GET /sales/reports/invoice-aging/export/pdf
 * Export invoice aging report as PDF.
 */
router.get("/sales/reports/invoice-aging/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { customerId } = req.query as Record<string, string>;

  const qr = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT ci.code, ci.customer_name AS "customerName", ci.due_date AS "dueDate",
             (ci.total::numeric - ci.paid_amount::numeric) AS "balance",
             CASE
               WHEN ci.due_date IS NULL OR ci.due_date::date >= CURRENT_DATE THEN 'Current'
               WHEN CURRENT_DATE - ci.due_date::date <= 30 THEN '1-30 Days'
               WHEN CURRENT_DATE - ci.due_date::date <= 60 THEN '31-60 Days'
               WHEN CURRENT_DATE - ci.due_date::date <= 90 THEN '61-90 Days'
               ELSE '90+ Days'
             END AS "agingBucket"
      FROM customer_invoices ci
      WHERE ci.tenant_id = ${tenantId} AND ci.deleted_at IS NULL
        AND ci.status IN ('sent','draft') AND (ci.total::numeric - ci.paid_amount::numeric) > 0
        ${customerId ? sql`AND ci.customer_id = ${Number(customerId)}` : sql``}
      ORDER BY ci.due_date ASC NULLS LAST LIMIT 2000
    `)
  );
  const rows = qr.rows as Array<{ code: string; customerName: string | null; dueDate: string | null; balance: number; agingBucket: string }>;

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "invoice-aging", "pdf")}"`);
  doc.pipe(res);

  doc.fontSize(16).font("Helvetica-Bold").text("Invoice Aging Report", { align: "center" });
  doc.fontSize(9).font("Helvetica").text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.moveDown();

  const colX = [40, 130, 230, 300, 380, 460];
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("Invoice", colX[0], doc.y, { continued: true })
     .text("Customer", colX[1], undefined, { continued: true })
     .text("Due Date", colX[2], undefined, { continued: true })
     .text("Balance", colX[3], undefined, { continued: true })
     .text("Bucket", colX[4]);
  doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(7);
  for (const r of rows) {
    const y = doc.y;
    if (y > 750) { doc.addPage(); }
    doc.text(r.code ?? "", colX[0], doc.y, { continued: true })
       .text(r.customerName ?? "", colX[1], undefined, { continued: true })
       .text(r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "", colX[2], undefined, { continued: true })
       .text(Number(r.balance).toFixed(2), colX[3], undefined, { continued: true })
       .text(r.agingBucket, colX[4]);
  }
  doc.end();
});

/**
 * GET /sales/reports/backorders/export/pdf
 * Export backorder report as PDF.
 */
router.get("/sales/reports/backorders/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      soId: soLinesTable.soId,
      soLineId: soLinesTable.id,
      itemCode: soLinesTable.itemCode,
      itemName: soLinesTable.itemName,
      qty: soLinesTable.quantity,
      despatched: soLinesTable.despatched_qty,
      backorderQty: sql<string>`${soLinesTable.quantity} - ${soLinesTable.despatched_qty}`,
    })
      .from(soLinesTable)
      .where(and(eq(soLinesTable.tenantId, tenantId), eq(soLinesTable.lineType, "stock"), sql`${soLinesTable.despatched_qty} < ${soLinesTable.quantity}`))
      .orderBy(soLinesTable.soId)
      .limit(2000)
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "backorders", "pdf")}"`);
  doc.pipe(res);

  doc.fontSize(16).font("Helvetica-Bold").text("Backorder Report", { align: "center" });
  doc.fontSize(9).font("Helvetica").text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.moveDown();

  const colX = [40, 100, 160, 280, 360, 430, 500];
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("SO ID", colX[0], doc.y, { continued: true })
     .text("Line", colX[1], undefined, { continued: true })
     .text("Item", colX[2], undefined, { continued: true })
     .text("Ordered", colX[3], undefined, { continued: true })
     .text("Despatched", colX[4], undefined, { continued: true })
     .text("Backorder", colX[5]);
  doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(7);
  for (const r of rows) {
    if (doc.y > 750) { doc.addPage(); }
    doc.text(String(r.soId), colX[0], doc.y, { continued: true })
       .text(String(r.soLineId), colX[1], undefined, { continued: true })
       .text(String(r.itemCode ?? ""), colX[2], undefined, { continued: true })
       .text(String(r.qty), colX[3], undefined, { continued: true })
       .text(String(r.despatched), colX[4], undefined, { continued: true })
       .text(Number(r.backorderQty).toFixed(2), colX[5]);
  }
  doc.end();
});

/**
 * GET /sales/reports/backorders/export/csv
 * Export backorder report as CSV.
 */
router.get("/sales/reports/backorders/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      soId: soLinesTable.soId,
      soLineId: soLinesTable.id,
      itemCode: soLinesTable.itemCode,
      itemName: soLinesTable.itemName,
      qty: soLinesTable.quantity,
      despatched: soLinesTable.despatched_qty,
      backorderQty: sql<string>`${soLinesTable.quantity} - ${soLinesTable.despatched_qty}`,
    })
      .from(soLinesTable)
      .where(and(eq(soLinesTable.tenantId, tenantId), eq(soLinesTable.lineType, "stock"), sql`${soLinesTable.despatched_qty} < ${soLinesTable.quantity}`))
      .orderBy(soLinesTable.soId)
      .limit(5000)
  );

  const escape = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    ["SO ID", "SO Line ID", "Item Code", "Item Name", "Ordered Qty", "Despatched Qty", "Backorder Qty"].join(","),
    ...rows.map(r => [r.soId, r.soLineId, r.itemCode ?? "", r.itemName ?? "", r.qty, r.despatched, Number(r.backorderQty).toFixed(2)].map(escape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "backorders", "csv")}"`);
  res.send(lines.join("\r\n"));
});

/** Sales by Period CSV Export */
router.get("/sales/reports/by-period/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      period: sql<string>`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
    })
    .from(customerInvoicesTable)
    .where(and(
      eq(customerInvoicesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM') asc`)
  );

  const lines = ["Period,Total Revenue,Invoice Count"];
  for (const r of rows) {
    lines.push([r.period, Number(r.totalRevenue).toFixed(2), r.invoiceCount].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "revenue-by-period", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Sales by Period PDF Export */
router.get("/sales/reports/by-period/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      period: sql<string>`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
    })
    .from(customerInvoicesTable)
    .where(and(
      eq(customerInvoicesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM')`)
    .orderBy(sql`to_char(${customerInvoicesTable.invoiceDate}::date, 'YYYY-MM') asc`)
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "revenue-by-period", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Sales Revenue by Period", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [150, 200, 150];
  const headers = ["Period", "Total Revenue", "Invoice Count"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(9).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [r.period, Number(r.totalRevenue).toFixed(2), String(r.invoiceCount)].forEach((v, i) => {
      doc.fontSize(9).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.7);
  }
  doc.end();
});

/** Sales by Item CSV Export */
router.get("/sales/reports/by-item/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      itemCode: customerInvoiceLinesTable.itemCode,
      itemName: customerInvoiceLinesTable.itemName,
      totalQty: sql<string>`coalesce(sum(${customerInvoiceLinesTable.quantity}::numeric), 0)`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoiceLinesTable.lineTotal}::numeric), 0)`,
      invoiceCount: sql<number>`count(distinct ${customerInvoiceLinesTable.invoiceId})`,
    })
    .from(customerInvoiceLinesTable)
    .innerJoin(customerInvoicesTable, eq(customerInvoiceLinesTable.invoiceId, customerInvoicesTable.id))
    .where(and(
      eq(customerInvoiceLinesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(customerInvoiceLinesTable.itemId, customerInvoiceLinesTable.itemCode, customerInvoiceLinesTable.itemName)
    .orderBy(sql`sum(${customerInvoiceLinesTable.lineTotal}::numeric) desc`)
  );

  const lines = ["Item Code,Item Name,Total Qty,Total Revenue,Invoice Count"];
  for (const r of rows) {
    lines.push([r.itemCode ?? "", `"${r.itemName ?? ""}"`, Number(r.totalQty).toFixed(2), Number(r.totalRevenue).toFixed(2), r.invoiceCount].join(","));
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "sales-by-item", "csv")}"`);
  res.send(lines.join("\n"));
});

/** Sales by Item PDF Export */
router.get("/sales/reports/by-item/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      itemCode: customerInvoiceLinesTable.itemCode,
      itemName: customerInvoiceLinesTable.itemName,
      totalQty: sql<string>`coalesce(sum(${customerInvoiceLinesTable.quantity}::numeric), 0)`,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoiceLinesTable.lineTotal}::numeric), 0)`,
      invoiceCount: sql<number>`count(distinct ${customerInvoiceLinesTable.invoiceId})`,
    })
    .from(customerInvoiceLinesTable)
    .innerJoin(customerInvoicesTable, eq(customerInvoiceLinesTable.invoiceId, customerInvoicesTable.id))
    .where(and(
      eq(customerInvoiceLinesTable.tenantId, tenantId),
      isNull(customerInvoicesTable.deletedAt),
      sql`${customerInvoicesTable.status} NOT IN ('voided')`,
      fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
      toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
    ))
    .groupBy(customerInvoiceLinesTable.itemId, customerInvoiceLinesTable.itemCode, customerInvoiceLinesTable.itemName)
    .orderBy(sql`sum(${customerInvoiceLinesTable.lineTotal}::numeric) desc`)
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "sales-by-item", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Sales by Item Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [80, 180, 80, 100, 80];
  const headers = ["Item Code", "Item Name", "Total Qty", "Total Revenue", "Invoices"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(9).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [r.itemCode ?? "", String(r.itemName ?? "").slice(0, 30), Number(r.totalQty).toFixed(2), Number(r.totalRevenue).toFixed(2), String(r.invoiceCount)].forEach((v, i) => {
      doc.fontSize(9).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.7);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

/** Sales by Customer CSV Export */
router.get("/sales/reports/by-customer/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      customerName: customerInvoicesTable.customerName,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
      avgInvoiceValue: sql<string>`coalesce(avg(${customerInvoicesTable.total}::numeric), 0)`,
    })
      .from(customerInvoicesTable)
      .where(and(
        eq(customerInvoicesTable.tenantId, tenantId),
        isNull(customerInvoicesTable.deletedAt),
        sql`${customerInvoicesTable.status} NOT IN ('voided')`,
        fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
        toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
      ))
      .groupBy(customerInvoicesTable.customerId, customerInvoicesTable.customerName)
      .orderBy(sql`sum(${customerInvoicesTable.total}::numeric) desc`)
  );

  const escape = (v: unknown) => { const s = v == null ? "" : String(v); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [
    ["Customer", "Total Revenue", "Invoice Count", "Avg Invoice Value"].join(","),
    ...rows.map(r => [r.customerName ?? "", Number(r.totalRevenue).toFixed(2), r.invoiceCount, Number(r.avgInvoiceValue).toFixed(2)].map(escape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "sales-by-customer", "csv")}"`);
  res.send(lines.join("\r\n"));
});

/** Sales by Customer PDF Export */
router.get("/sales/reports/by-customer/export/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;
  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      customerName: customerInvoicesTable.customerName,
      totalRevenue: sql<string>`coalesce(sum(${customerInvoicesTable.total}::numeric), 0)`,
      invoiceCount: sql<number>`count(*)`,
      avgInvoiceValue: sql<string>`coalesce(avg(${customerInvoicesTable.total}::numeric), 0)`,
    })
      .from(customerInvoicesTable)
      .where(and(
        eq(customerInvoicesTable.tenantId, tenantId),
        isNull(customerInvoicesTable.deletedAt),
        sql`${customerInvoicesTable.status} NOT IN ('voided')`,
        fromDate ? sql`${customerInvoicesTable.invoiceDate} >= ${fromDate}` : undefined,
        toDate ? sql`${customerInvoicesTable.invoiceDate} <= ${toDate}` : undefined,
      ))
      .groupBy(customerInvoicesTable.customerId, customerInvoicesTable.customerName)
      .orderBy(sql`sum(${customerInvoicesTable.total}::numeric) desc`)
  );

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "sales-by-customer", "pdf")}"`);
  doc.pipe(res);
  doc.fontSize(16).text("Sales by Customer Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Generated: ${new Date().toISOString().split("T")[0]}`, { align: "right" });
  doc.moveDown();
  const cols = [240, 110, 80, 110];
  const headers = ["Customer", "Total Revenue", "Invoices", "Avg Invoice"];
  let x = doc.page.margins.left;
  headers.forEach((h, i) => { doc.fontSize(9).font("Helvetica-Bold").text(h, x, doc.y, { width: cols[i], lineBreak: false }); x += cols[i]; });
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
  for (const r of rows) {
    x = doc.page.margins.left;
    const rowY = doc.y;
    [String(r.customerName ?? "").slice(0, 50), Number(r.totalRevenue).toFixed(2), String(r.invoiceCount), Number(r.avgInvoiceValue).toFixed(2)].forEach((v, i) => {
      doc.fontSize(9).font("Helvetica").text(v, x, rowY, { width: cols[i], lineBreak: false }); x += cols[i];
    });
    doc.moveDown(0.7);
    if (doc.y > doc.page.height - 80) { doc.addPage(); }
  }
  doc.end();
});

export default router;

import { Router, type Request, type Response } from "express";
import { eq, and, isNull, desc, sql, or, ilike, gte, lte, asc } from "drizzle-orm";
import PDFDocument from "pdfkit";
import * as XLSX from "xlsx";
import {
  glPostingsTable,
  glAccountsTable,
  tenantsTable,
} from "@workspace/db";
import { withTenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  requireRole,
  type TenantRequest,
} from "../middlewares/tenantContext";
import { writeAuditLog } from "../lib/audit";
import { buildExportFilename } from "../lib/exportFilename";
import type { IRouter } from "express";
import { z } from "zod";

const router: IRouter = Router();

const tenantReadMiddleware = [requireAuth, tenantContext, requireRole("accountant", "tenant_admin", "global_admin")];
const tenantWriteMiddleware = [requireAuth, tenantContext, requireRole("accountant", "tenant_admin", "global_admin")];
const tenantUserMiddleware = tenantReadMiddleware;

// ── GL Journal ─────────────────────────────────────────────────────────────────

/**
 * GET /finance/gl-journal
 * List all GL postings across all source modules with filter + pagination.
 */
router.get("/finance/journals", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const {
    fromDate, toDate, entityType, status, accountCode,
    page = "1", limit = "50", sort = "desc",
  } = req.query as Record<string, string>;
  const pg = Math.max(1, Number(page));
  const lim = Math.min(200, Math.max(1, Number(limit)));
  const offset = (pg - 1) * lim;

  const rows = await withTenantDb(tenantId, (db) => {
    let q = db.select({
      id: glPostingsTable.id,
      code: glPostingsTable.code,
      entityType: glPostingsTable.entityType,
      entityId: glPostingsTable.entityId,
      status: glPostingsTable.status,
      totalDebit: glPostingsTable.totalDebit,
      totalCredit: glPostingsTable.totalCredit,
      postedAt: glPostingsTable.postedAt,
      postedByEmail: glPostingsTable.postedByEmail,
      notes: glPostingsTable.notes,
      createdAt: glPostingsTable.createdAt,
    }).from(glPostingsTable).where(
      and(
        eq(glPostingsTable.tenantId, tenantId),
        fromDate ? gte(glPostingsTable.createdAt, new Date(fromDate)) : undefined,
        toDate ? lte(glPostingsTable.createdAt, new Date(toDate)) : undefined,
        entityType ? eq(glPostingsTable.entityType, entityType) : undefined,
        status ? eq(glPostingsTable.status, status) : undefined,
        accountCode ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${glPostingsTable.lines}) AS ln WHERE ln->>'accountCode' = ${accountCode})` : undefined,
      )
    );
    return (sort === "asc" ? q.orderBy(asc(glPostingsTable.createdAt)) : q.orderBy(desc(glPostingsTable.createdAt)))
      .limit(lim).offset(offset);
  });

  const [total] = await withTenantDb(tenantId, (db) =>
    db.select({ count: sql<number>`count(*)` }).from(glPostingsTable).where(
      and(
        eq(glPostingsTable.tenantId, tenantId),
        fromDate ? gte(glPostingsTable.createdAt, new Date(fromDate)) : undefined,
        toDate ? lte(glPostingsTable.createdAt, new Date(toDate)) : undefined,
        entityType ? eq(glPostingsTable.entityType, entityType) : undefined,
        status ? eq(glPostingsTable.status, status) : undefined,
        accountCode ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${glPostingsTable.lines}) AS ln WHERE ln->>'accountCode' = ${accountCode})` : undefined,
      )
    )
  );

  res.json({
    data: rows,
    total: Number(total?.count ?? 0),
    page: pg,
    limit: lim,
    pages: Math.ceil(Number(total?.count ?? 0) / lim),
  });
});

/**
 * GET /finance/journals/export/csv
 * Export GL journal entries as CSV.
 */
router.get("/finance/journals/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const {
    fromDate, toDate, entityType, status, accountCode,
  } = req.query as Record<string, string>;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: glPostingsTable.id,
      code: glPostingsTable.code,
      entityType: glPostingsTable.entityType,
      entityId: glPostingsTable.entityId,
      status: glPostingsTable.status,
      totalDebit: glPostingsTable.totalDebit,
      totalCredit: glPostingsTable.totalCredit,
      postedAt: glPostingsTable.postedAt,
      postedByEmail: glPostingsTable.postedByEmail,
      notes: glPostingsTable.notes,
      createdAt: glPostingsTable.createdAt,
    }).from(glPostingsTable).where(
      and(
        eq(glPostingsTable.tenantId, tenantId),
        fromDate ? gte(glPostingsTable.createdAt, new Date(fromDate)) : undefined,
        toDate ? lte(glPostingsTable.createdAt, new Date(toDate)) : undefined,
        entityType ? eq(glPostingsTable.entityType, entityType) : undefined,
        status ? eq(glPostingsTable.status, status) : undefined,
        accountCode ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${glPostingsTable.lines}) AS ln WHERE ln->>'accountCode' = ${accountCode})` : undefined,
      )
    ).orderBy(desc(glPostingsTable.createdAt)).limit(5000)
  );

  const header = ["ID", "Code", "Type", "Entity ID", "Status", "Total Debit", "Total Credit", "Posted At", "Posted By", "Notes", "Created At"];
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(","),
    ...rows.map(r => [r.id, r.code, r.entityType, r.entityId, r.status, r.totalDebit, r.totalCredit, r.postedAt?.toISOString() ?? "", r.postedByEmail ?? "", r.notes ?? "", r.createdAt?.toISOString() ?? ""].map(escape).join(","))
  ];

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "gl-journals", "csv")}"`);
  res.send(lines.join("\r\n"));
});

/**
 * GET /finance/gl-journal/:id
 * Get a single GL posting with full line detail.
 */
router.get("/finance/journals/:id", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [posting] = await withTenantDb(tenantId, (db) =>
    db.select().from(glPostingsTable).where(and(eq(glPostingsTable.id, id), eq(glPostingsTable.tenantId, tenantId))).limit(1)
  );
  if (!posting) { res.status(404).json({ error: "GL posting not found" }); return; }
  res.json(posting);
});

// ── Manual Journal Entries ─────────────────────────────────────────────────────

const manualJournalSchema = z.object({
  memo: z.string().min(1, "Memo is required"),
  postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  attachmentUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  lines: z.array(z.object({
    accountCode: z.string().min(1),
    accountName: z.string().min(1),
    debit: z.number().min(0),
    credit: z.number().min(0),
    description: z.string().optional(),
  })).min(2),
});

/**
 * POST /finance/gl-journal/manual
 * Create a balanced manual journal entry.
 */
router.post("/finance/journals", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail, userRole } = req as TenantRequest;
  const parsed = manualJournalSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", details: parsed.error.issues }); return; }
  const d = parsed.data;

  const totalDebit = d.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = d.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    res.status(400).json({ error: `Journal is not balanced. Debits: ${totalDebit.toFixed(2)}, Credits: ${totalCredit.toFixed(2)}` });
    return;
  }

  // Journals above the approval threshold require manager/admin approval before posting
  const APPROVAL_THRESHOLD = Number(process.env["MANUAL_JOURNAL_APPROVAL_THRESHOLD"] ?? 10_000);
  const requiresApproval = totalDebit > APPROVAL_THRESHOLD && !["tenant_admin", "global_admin"].includes(userRole);
  const postingDate = d.postingDate ? new Date(d.postingDate) : new Date();
  const result = await withTenantDb(tenantId, async (db) => {
    const [posting] = await db.insert(glPostingsTable).values({
      tenantId,
      code: "MJE-TEMP",
      entityType: "manual_journal",
      entityId: 0,
      status: requiresApproval ? "draft" : "posted",
      postedByClerkId: clerkUserId,
      postedByEmail: userEmail ?? undefined,
      postedAt: requiresApproval ? null : postingDate,
      notes: d.memo,
      lines: d.lines as unknown as typeof glPostingsTable.$inferInsert["lines"],
      totalDebit: String(totalDebit),
      totalCredit: String(totalCredit),
      attachmentUrl: d.attachmentUrl || null,
    } as typeof glPostingsTable.$inferInsert).returning();

    const code = `MJE-${String(posting.id).padStart(6, "0")}`;
    await db.update(glPostingsTable).set({ code, entityId: posting.id }).where(eq(glPostingsTable.id, posting.id));
    return { ...posting, code };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "finance.manual_journal_created", entityType: "gl_posting", entityId: String(result.id), newValues: d });
  res.status(201).json({ ...result, requiresApproval, approvalThreshold: APPROVAL_THRESHOLD });
});

/**
 * POST /finance/gl-journal/:id/reverse
 * Reverse an existing posted GL posting.
 */
router.post("/finance/journals/:id/reverse", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail } = req as TenantRequest;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [original] = await withTenantDb(tenantId, (db) =>
    db.select().from(glPostingsTable).where(and(eq(glPostingsTable.id, id), eq(glPostingsTable.tenantId, tenantId))).limit(1)
  );
  if (!original) { res.status(404).json({ error: "GL posting not found" }); return; }
  if (original.status !== "posted") {
    res.status(400).json({ error: original.status === "reversed" ? "Already reversed" : "Only posted journals can be reversed" });
    return;
  }

  const reversalLines = (original.lines as Array<{ accountCode: string; accountName: string; debit: number; credit: number; description?: string }>).map(l => ({
    ...l, debit: l.credit, credit: l.debit, description: `Reversal: ${l.description ?? ""}`,
  }));

  const result = await withTenantDb(tenantId, async (db) => {
    const [reversal] = await db.insert(glPostingsTable).values({
      tenantId,
      code: "REV-TEMP",
      entityType: "reversal",
      entityId: original.id,
      status: "posted",
      postedByClerkId: clerkUserId,
      postedByEmail: userEmail ?? undefined,
      postedAt: new Date(),
      notes: `Reversal of ${original.code}`,
      lines: reversalLines as unknown as typeof glPostingsTable.$inferInsert["lines"],
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
    } as typeof glPostingsTable.$inferInsert).returning();

    const code = `REV-${String(reversal.id).padStart(6, "0")}`;
    // Only update code; entityId keeps pointing at original.id (the posting being reversed)
    await db.update(glPostingsTable).set({ code }).where(eq(glPostingsTable.id, reversal.id));
    await db.update(glPostingsTable).set({ status: "reversed", reversedByPostingId: reversal.id }).where(eq(glPostingsTable.id, original.id));
    return { reversalId: reversal.id, reversalCode: code, originalId: original.id };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "finance.posting_reversed", entityType: "gl_posting", entityId: String(id) });
  res.status(201).json(result);
});

/**
 * POST /finance/journals/:id/approve
 * Approve a draft manual journal entry (admin/manager only).
 */
router.post("/finance/journals/:id/approve", ...tenantWriteMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, clerkUserId, userEmail, userRole } = req as TenantRequest;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  if (!["accountant", "tenant_admin", "global_admin"].includes(userRole)) {
    res.status(403).json({ error: "Insufficient permissions to approve journals" });
    return;
  }

  const [posting] = await withTenantDb(tenantId, (db) =>
    db.select().from(glPostingsTable).where(and(eq(glPostingsTable.id, id), eq(glPostingsTable.tenantId, tenantId))).limit(1)
  );
  if (!posting) { res.status(404).json({ error: "GL posting not found" }); return; }
  if (posting.status !== "draft") { res.status(400).json({ error: `Cannot approve posting with status: ${posting.status}` }); return; }

  const [updated] = await withTenantDb(tenantId, (db) =>
    db.update(glPostingsTable)
      .set({ status: "posted", postedAt: new Date(), postedByClerkId: clerkUserId, postedByEmail: userEmail ?? undefined })
      .where(and(eq(glPostingsTable.id, id), eq(glPostingsTable.tenantId, tenantId)))
      .returning()
  );

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "finance.manual_journal_approved", entityType: "gl_posting", entityId: String(id) });
  res.json(updated);
});

/**
 * GET /finance/journals/export/xlsx
 * Export GL journal entries as Excel workbook.
 */
router.get("/finance/journals/export/xlsx", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate, entityType, status, accountCode } = req.query as Record<string, string>;

  const rows = await withTenantDb(tenantId, (db) =>
    db.select({
      id: glPostingsTable.id,
      code: glPostingsTable.code,
      entityType: glPostingsTable.entityType,
      entityId: glPostingsTable.entityId,
      status: glPostingsTable.status,
      totalDebit: glPostingsTable.totalDebit,
      totalCredit: glPostingsTable.totalCredit,
      postedAt: glPostingsTable.postedAt,
      postedByEmail: glPostingsTable.postedByEmail,
      notes: glPostingsTable.notes,
      createdAt: glPostingsTable.createdAt,
    }).from(glPostingsTable).where(
      and(
        eq(glPostingsTable.tenantId, tenantId),
        fromDate ? gte(glPostingsTable.createdAt, new Date(fromDate)) : undefined,
        toDate ? lte(glPostingsTable.createdAt, new Date(toDate)) : undefined,
        entityType ? eq(glPostingsTable.entityType, entityType) : undefined,
        status ? eq(glPostingsTable.status, status) : undefined,
        accountCode ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${glPostingsTable.lines}) AS ln WHERE ln->>'accountCode' = ${accountCode})` : undefined,
      )
    ).orderBy(desc(glPostingsTable.createdAt)).limit(5000)
  );

  const wsData = [
    ["ID", "Code", "Type", "Entity ID", "Status", "Total Debit", "Total Credit", "Posted At", "Posted By", "Notes", "Created At"],
    ...rows.map(r => [r.id, r.code, r.entityType, r.entityId, r.status, Number(r.totalDebit), Number(r.totalCredit), r.postedAt?.toISOString() ?? "", r.postedByEmail ?? "", r.notes ?? "", r.createdAt?.toISOString() ?? ""])
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "GL Journals");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "gl-journals", "xlsx")}"`);
  res.send(buf);
});

// ── Trial Balance ──────────────────────────────────────────────────────────────

/**
 * GET /finance/trial-balance
 * Returns trial balance for all GL accounts for a given period.
 * For each account: opening balance, period debits, period credits, closing balance.
 */
router.get("/finance/trial-balance", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;

  type MovSummary = Array<{ accountCode: string; totalDebit: string; totalCredit: string }>;
  const [accounts, openingMovements, periodMovements] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name, accountType: glAccountsTable.accountType })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt), eq(glAccountsTable.isActive, true)))
        .orderBy(asc(glAccountsTable.code))
    ),
    // Opening balance = sum of all movements BEFORE fromDate
    withTenantDb(tenantId, async (db) => {
      if (!fromDate) return [] as MovSummary;
      const qr = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId}
          AND ${glPostingsTable.status} = 'posted'
          AND ${glPostingsTable.createdAt} < ${new Date(fromDate)}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as MovSummary;
    }),
    // Period movements
    withTenantDb(tenantId, async (db) => {
      const qr = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId}
          AND ${glPostingsTable.status} = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable.createdAt} >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable.createdAt} <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as MovSummary;
    }),
  ]);

  const openMap = new Map<string, number>();
  for (const row of openingMovements) {
    openMap.set(row.accountCode, Number(row.totalDebit ?? 0) - Number(row.totalCredit ?? 0));
  }

  const periodMap = new Map<string, { dr: number; cr: number }>();
  for (const row of periodMovements) {
    periodMap.set(row.accountCode, { dr: Number(row.totalDebit ?? 0), cr: Number(row.totalCredit ?? 0) });
  }

  const trialBalance = accounts.map(acc => {
    const opening = openMap.get(acc.code ?? "") ?? 0;
    const { dr, cr } = periodMap.get(acc.code ?? "") ?? { dr: 0, cr: 0 };
    return {
      accountId: acc.id,
      accountCode: acc.code,
      accountName: acc.name,
      accountType: acc.accountType,
      openingBalance: opening,
      periodDebit: dr,
      periodCredit: cr,
      closingBalance: opening + dr - cr,
    };
  });

  const totals = trialBalance.reduce(
    (acc, r) => ({ debit: acc.debit + r.periodDebit, credit: acc.credit + r.periodCredit }),
    { debit: 0, credit: 0 }
  );

  res.json({ fromDate: fromDate ?? null, toDate: toDate ?? null, accounts: trialBalance, totals });
});

/**
 * GET /finance/trial-balance/pdf
 * Stream a PDF version of the trial balance.
 */
router.get("/finance/trial-balance/pdf", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;

  type PdfMovSummary = Array<{ accountCode: string; totalDebit: number; totalCredit: number }>;
  const [tenant, accounts, openingMovements, periodMovements] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
    ),
    withTenantDb(tenantId, (db) =>
      db.select({ id: glAccountsTable.id, code: glAccountsTable.code, name: glAccountsTable.name, accountType: glAccountsTable.accountType })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt), eq(glAccountsTable.isActive, true)))
        .orderBy(asc(glAccountsTable.code))
    ),
    withTenantDb(tenantId, async (db) => {
      if (!fromDate) return [] as PdfMovSummary;
      const qr = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId} AND ${glPostingsTable.status} = 'posted'
          AND ${glPostingsTable.createdAt} < ${new Date(fromDate)}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as PdfMovSummary;
    }),
    withTenantDb(tenantId, async (db) => {
      const qr = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId} AND ${glPostingsTable.status} = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable.createdAt} >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable.createdAt} <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as PdfMovSummary;
    }),
  ]);

  const openMap = new Map<string, number>();
  for (const row of openingMovements) {
    openMap.set(row.accountCode, Number(row.totalDebit ?? 0) - Number(row.totalCredit ?? 0));
  }
  const periodMap = new Map<string, { dr: number; cr: number }>();
  for (const row of periodMovements) {
    periodMap.set(row.accountCode, { dr: Number(row.totalDebit ?? 0), cr: Number(row.totalCredit ?? 0) });
  }
  const rows = accounts.map(acc => {
    const opening = openMap.get(acc.code) ?? 0;
    const { dr, cr } = periodMap.get(acc.code) ?? { dr: 0, cr: 0 };
    return { ...acc, openingBalance: opening, periodDebit: dr, periodCredit: cr, closingBalance: opening + dr - cr };
  });
  const totals = rows.reduce((a, r) => ({ debit: a.debit + r.periodDebit, credit: a.credit + r.periodCredit }), { debit: 0, credit: 0 });

  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "trial-balance", "pdf")}"`);
  doc.pipe(res);

  const tenantName = tenant[0]?.name ?? "Forge ERP";
  const fmtN = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const period = `${fromDate ?? "All time"} to ${toDate ?? "Today"}`;

  doc.fontSize(16).font("Helvetica-Bold").text(tenantName, { align: "center" });
  doc.fontSize(12).font("Helvetica").text("Trial Balance", { align: "center" });
  doc.fontSize(9).text(period, { align: "center" });
  doc.moveDown();

  const colX = { code: 40, name: 90, type: 230, open: 320, dr: 390, cr: 470, balance: 550 };
  const headerY = doc.y;
  doc.fontSize(8).font("Helvetica-Bold");
  doc.text("Code", colX.code, headerY);
  doc.text("Account", colX.name, headerY);
  doc.text("Type", colX.type, headerY);
  doc.text("Opening", colX.open, headerY, { width: 65, align: "right" });
  doc.text("Period Dr", colX.dr, headerY, { width: 65, align: "right" });
  doc.text("Period Cr", colX.cr, headerY, { width: 65, align: "right" });
  doc.text("Closing", colX.balance, headerY, { width: 65, align: "right" });
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(760, doc.y).strokeColor("#999").stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(7.5);
  for (const row of rows) {
    if (doc.y > 520) { doc.addPage(); }
    const y = doc.y;
    doc.text(row.code, colX.code, y);
    doc.text(row.name.substring(0, 25), colX.name, y);
    doc.text(row.accountType ?? "", colX.type, y);
    doc.fillColor(row.openingBalance < 0 ? "#c00" : "#000").text(fmtN(Math.abs(row.openingBalance)), colX.open, y, { width: 65, align: "right" });
    doc.fillColor("#000").text(fmtN(row.periodDebit), colX.dr, y, { width: 65, align: "right" });
    doc.text(fmtN(row.periodCredit), colX.cr, y, { width: 65, align: "right" });
    const bal = row.closingBalance;
    doc.fillColor(bal < 0 ? "#c00" : "#000").text(fmtN(Math.abs(bal)), colX.balance, y, { width: 65, align: "right" });
    doc.fillColor("#000");
    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(760, doc.y).strokeColor("#333").stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(8);
  const totY = doc.y;
  doc.text("TOTAL", colX.code, totY);
  doc.text(fmtN(totals.debit), colX.dr, totY, { width: 65, align: "right" });
  doc.text(fmtN(totals.credit), colX.cr, totY, { width: 65, align: "right" });

  doc.end();
});

// ── Account Movement Detail ────────────────────────────────────────────────────

/**
 * GET /finance/account-movement
 * Returns all GL lines for a specific account code (for ledger drill-down).
 */
router.get("/finance/account-movements", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { accountCode, fromDate, toDate, page = "1", limit = "100" } = req.query as Record<string, string>;
  if (!accountCode) { res.status(400).json({ error: "accountCode is required" }); return; }
  const pg = Math.max(1, Number(page));
  const lim = Math.min(500, Math.max(1, Number(limit)));

  type MovementRow = { postingId: number; postingCode: string; entityType: string; postedAt: Date | null; createdAt: Date; debit: number; credit: number; description: string; balance: number; };
  const qrMov = await withTenantDb(tenantId, (db) =>
    db.execute(sql`
      SELECT
        p.id AS "postingId",
        p.code AS "postingCode",
        p.entity_type AS "entityType",
        p.posted_at AS "postedAt",
        p.created_at AS "createdAt",
        (line->>'debit')::numeric AS "debit",
        (line->>'credit')::numeric AS "credit",
        line->>'description' AS "description"
      FROM ${glPostingsTable} p, jsonb_array_elements(p.lines) AS line
      WHERE p.tenant_id = ${tenantId}
        AND p.status = 'posted'
        AND line->>'accountCode' = ${accountCode}
        ${fromDate ? sql`AND p.created_at >= ${new Date(fromDate)}` : sql``}
        ${toDate ? sql`AND p.created_at <= ${new Date(toDate)}` : sql``}
      ORDER BY p.created_at ASC
      LIMIT ${lim} OFFSET ${(pg - 1) * lim}
    `)
  );
  const rows = qrMov.rows as unknown as MovementRow[];

  let runningBalance = 0;
  const withBalance = rows.map(r => {
    runningBalance += Number(r.debit ?? 0) - Number(r.credit ?? 0);
    return { ...r, debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0), balance: runningBalance };
  });

  res.json({ accountCode, fromDate: fromDate ?? null, toDate: toDate ?? null, data: withBalance });
});

// ── GL Journal CSV Export ──────────────────────────────────────────────────────

/**
 * GET /finance/trial-balance/export/csv
 * Export trial balance as CSV.
 */
router.get("/finance/trial-balance/export/csv", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { fromDate, toDate } = req.query as Record<string, string>;

  type CsvMovSummary = Array<{ accountCode: string; totalDebit: string; totalCredit: string }>;
  const [accounts, openingMov, periodMovements] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ code: glAccountsTable.code, name: glAccountsTable.name, accountType: glAccountsTable.accountType })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt), eq(glAccountsTable.isActive, true)))
        .orderBy(asc(glAccountsTable.code))
    ),
    withTenantDb(tenantId, async (db) => {
      if (!fromDate) return [] as CsvMovSummary;
      const qr = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId} AND ${glPostingsTable.status} = 'posted'
          AND ${glPostingsTable.createdAt} < ${new Date(fromDate)}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as CsvMovSummary;
    }),
    withTenantDb(tenantId, async (db) => {
      const qr = await db.execute(sql`
        SELECT
          line->>'accountCode' AS "accountCode",
          SUM((line->>'debit')::numeric) AS "totalDebit",
          SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId}
          AND ${glPostingsTable.status} = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable.createdAt} >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable.createdAt} <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `);
      return qr.rows as unknown as CsvMovSummary;
    }),
  ]);

  const openMap2 = new Map(openingMov.map(m => [m.accountCode, m]));
  const movMap = new Map(periodMovements.map(m => [m.accountCode, m]));
  const csvLines: string[] = ["Account Code,Account Name,Type,Opening Balance,Period Debits,Period Credits,Closing Balance"];
  for (const acct of accounts) {
    const op = openMap2.get(acct.code);
    const mv = movMap.get(acct.code);
    const opening = Number(op?.totalDebit ?? 0) - Number(op?.totalCredit ?? 0);
    const debits = Number(mv?.totalDebit ?? 0);
    const credits = Number(mv?.totalCredit ?? 0);
    const closing = opening + debits - credits;
    csvLines.push([
      acct.code,
      `"${(acct.name ?? "").replace(/"/g, '""')}"`,
      acct.accountType ?? "",
      opening.toFixed(2),
      debits.toFixed(2),
      credits.toFixed(2),
      closing.toFixed(2),
    ].join(","));
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${await buildExportFilename(tenantId, "trial-balance", "csv")}"`);
  res.send(csvLines.join("\n"));
});

export default router;

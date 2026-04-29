import { Router, type Request, type Response } from "express";
import { eq, and, isNull, desc, sql, or, ilike, gte, lte, asc } from "drizzle-orm";
import PDFDocument from "pdfkit";
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
import type { IRouter } from "express";
import { z } from "zod";

const router: IRouter = Router();

const tenantUserMiddleware = [requireAuth, tenantContext];
const tenantWriteMiddleware = [requireAuth, tenantContext, requireRole("admin", "accountant", "manager")];

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
  const APPROVAL_THRESHOLD = 10_000;
  const requiresApproval = totalDebit > APPROVAL_THRESHOLD && !["admin", "super_admin"].includes(userRole);
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
  if (original.status === "reversed") { res.status(400).json({ error: "Already reversed" }); return; }

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
    await db.update(glPostingsTable).set({ code, entityId: reversal.id }).where(eq(glPostingsTable.id, reversal.id));
    await db.update(glPostingsTable).set({ status: "reversed", reversedByPostingId: reversal.id }).where(eq(glPostingsTable.id, original.id));
    return { reversalId: reversal.id, reversalCode: code, originalId: original.id };
  });

  await writeAuditLog({ req, actorClerkId: clerkUserId, actorEmail: userEmail, tenantId, action: "finance.posting_reversed", entityType: "gl_posting", entityId: String(id) });
  res.status(201).json(result);
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
      const rows = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId}
          AND ${glPostingsTable.status} = 'posted'
          AND ${glPostingsTable.createdAt} < ${new Date(fromDate)}
        GROUP BY line->>'accountCode'
      `) as unknown as MovSummary;
      return rows;
    }),
    // Period movements
    withTenantDb(tenantId, async (db) => {
      const rows = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId}
          AND ${glPostingsTable.status} = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable.createdAt} >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable.createdAt} <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `) as unknown as MovSummary;
      return rows;
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

  const [tenant, accounts, periodMovements] = await Promise.all([
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
      const rows = await db.execute(sql`
        SELECT line->>'accountCode' AS "accountCode",
               SUM((line->>'debit')::numeric) AS "totalDebit",
               SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(${glPostingsTable.lines}) AS line
        WHERE ${glPostingsTable.tenantId} = ${tenantId} AND ${glPostingsTable.status} = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable.createdAt} >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable.createdAt} <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `) as unknown as Array<{ accountCode: string; totalDebit: number; totalCredit: number }>;
      return rows;
    }),
  ]);

  const movementMap = new Map<string, { dr: number; cr: number }>();
  for (const row of periodMovements) {
    movementMap.set(row.accountCode, { dr: Number(row.totalDebit ?? 0), cr: Number(row.totalCredit ?? 0) });
  }
  const rows = accounts.map(acc => {
    const mov = movementMap.get(acc.code) ?? { dr: 0, cr: 0 };
    return { ...acc, periodDebit: mov.dr, periodCredit: mov.cr, closingBalance: mov.dr - mov.cr };
  });
  const totals = rows.reduce((a, r) => ({ debit: a.debit + r.periodDebit, credit: a.credit + r.periodCredit }), { debit: 0, credit: 0 });

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="trial-balance.pdf"`);
  doc.pipe(res);

  const tenantName = tenant[0]?.name ?? "Forge ERP";
  const fmt = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const period = `${fromDate ?? "All time"} to ${toDate ?? "Today"}`;

  doc.fontSize(18).font("Helvetica-Bold").text(tenantName, { align: "center" });
  doc.fontSize(13).font("Helvetica").text("Trial Balance", { align: "center" });
  doc.fontSize(10).text(period, { align: "center" });
  doc.moveDown();

  const colX = { code: 40, name: 90, type: 280, dr: 360, cr: 440, balance: 510 };
  const headerY = doc.y;
  doc.fontSize(9).font("Helvetica-Bold");
  doc.text("Code", colX.code, headerY);
  doc.text("Account", colX.name, headerY);
  doc.text("Type", colX.type, headerY);
  doc.text("Dr", colX.dr, headerY, { width: 70, align: "right" });
  doc.text("Cr", colX.cr, headerY, { width: 70, align: "right" });
  doc.text("Balance", colX.balance, headerY, { width: 70, align: "right" });
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#999").stroke();
  doc.moveDown(0.3);

  doc.font("Helvetica").fontSize(8);
  for (const row of rows) {
    if (doc.y > 760) { doc.addPage(); }
    const y = doc.y;
    doc.text(row.code, colX.code, y);
    doc.text(row.name.substring(0, 30), colX.name, y);
    doc.text(row.accountType ?? "", colX.type, y);
    doc.text(fmt(row.periodDebit), colX.dr, y, { width: 70, align: "right" });
    doc.text(fmt(row.periodCredit), colX.cr, y, { width: 70, align: "right" });
    const bal = row.closingBalance;
    doc.fillColor(bal < 0 ? "#c00" : "#000").text(fmt(Math.abs(bal)), colX.balance, y, { width: 70, align: "right" });
    doc.fillColor("#000");
    doc.moveDown(0.5);
  }

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor("#333").stroke();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(9);
  const totY = doc.y;
  doc.text("TOTAL", colX.code, totY);
  doc.text(fmt(totals.debit), colX.dr, totY, { width: 70, align: "right" });
  doc.text(fmt(totals.credit), colX.cr, totY, { width: 70, align: "right" });

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
  const rows = await withTenantDb(tenantId, async (db) => {
    return db.execute(sql`
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
    `) as unknown as MovementRow[];
  }) as MovementRow[];

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

  const [accounts, periodMovements] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ code: glAccountsTable.code, name: glAccountsTable.name, accountType: glAccountsTable.accountType })
        .from(glAccountsTable)
        .where(and(eq(glAccountsTable.tenantId, tenantId), isNull(glAccountsTable.deletedAt), eq(glAccountsTable.isActive, true)))
        .orderBy(asc(glAccountsTable.code))
    ),
    withTenantDb(tenantId, async (db) => {
      const rows = await db.execute(sql`
        SELECT
          line->>'accountCode' AS "accountCode",
          SUM((line->>'debit')::numeric) AS "totalDebit",
          SUM((line->>'credit')::numeric) AS "totalCredit"
        FROM ${glPostingsTable}, jsonb_array_elements(lines) AS line
        WHERE ${glPostingsTable}.tenant_id = ${tenantId}
          AND ${glPostingsTable}.status = 'posted'
          ${fromDate ? sql`AND ${glPostingsTable}.created_at >= ${new Date(fromDate)}` : sql``}
          ${toDate ? sql`AND ${glPostingsTable}.created_at <= ${new Date(toDate)}` : sql``}
        GROUP BY line->>'accountCode'
      `) as unknown as Array<{ accountCode: string; totalDebit: string; totalCredit: string }>;
      return rows;
    }),
  ]);

  const movMap = new Map(periodMovements.map(m => [m.accountCode, m]));
  const csvLines: string[] = ["Account Code,Account Name,Type,Period Debits,Period Credits,Net"];
  for (const acct of accounts) {
    const mv = movMap.get(acct.code);
    const debits = Number(mv?.totalDebit ?? 0);
    const credits = Number(mv?.totalCredit ?? 0);
    csvLines.push([
      acct.code,
      `"${(acct.name ?? "").replace(/"/g, '""')}"`,
      acct.accountType ?? "",
      debits.toFixed(2),
      credits.toFixed(2),
      (debits - credits).toFixed(2),
    ].join(","));
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="trial-balance.csv"`);
  res.send(csvLines.join("\n"));
});

export default router;

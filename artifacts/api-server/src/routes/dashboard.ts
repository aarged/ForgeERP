import { Router, type Request, type Response } from "express";
import { eq, and, isNull, desc, sql, gte } from "drizzle-orm";
import {
  purchaseOrdersTable,
  purchaseRequisitionsTable,
  approvalWorkflowsTable,
  approvalDecisionsTable,
  glPostingsTable,
  inventoryStockTable,
  inventoryMovementsTable,
  salesOrdersTable,
  customerInvoicesTable,
  despatchesTable,
  quotationsTable,
  cycleCountTasksTable,
  itemsTable,
} from "@workspace/db";
import { withTenantDb } from "@workspace/db/rls";
import { requireAuth } from "../middlewares/requireAuth";
import {
  tenantContext,
  type TenantRequest,
} from "../middlewares/tenantContext";
import type { IRouter } from "express";

const router: IRouter = Router();
const tenantUserMiddleware = [requireAuth, tenantContext];

const startOfMonth = () => {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
};
const startOfToday = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
};
const daysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d;
};

// ── Role-Based Dashboard KPIs ─────────────────────────────────────────────────

router.get("/dashboard/kpi", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId, userRole: role } = req as TenantRequest;

  if (role === "purchaser" || role === "admin" || role === "manager") {
    const [openPos, awaitingApproval, toReceive, spendMtd] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), sql`status NOT IN ('closed','cancelled')`))),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "pending_approval")))),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "approved")))),
      withTenantDb(tenantId, (db) =>
        db.select({ total: sql<string>`coalesce(sum(total),0)` }).from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), gte(purchaseOrdersTable.createdAt, startOfMonth())))),
    ]);
    res.json({
      role,
      kpis: {
        openPOs: Number(openPos[0]?.count ?? 0),
        awaitingApproval: Number(awaitingApproval[0]?.count ?? 0),
        itemsToReceive: Number(toReceive[0]?.count ?? 0),
        supplierSpendMtd: Number(spendMtd[0]?.total ?? 0),
      },
    });
    return;
  }

  if (role === "warehouse") {
    const [pickReady, lowStockRows, pendingCounts, toReceive] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(despatchesTable)
          .where(and(eq(despatchesTable.tenantId, tenantId), eq(despatchesTable.status, "draft")))),
      // Low stock via raw SQL (reorder_point lives in item_locations)
      withTenantDb(tenantId, async (db) =>
        db.execute(sql`
          SELECT COUNT(*) AS count FROM (
            SELECT DISTINCT s.item_id FROM inventory_stock s
            JOIN item_locations il ON il.item_id = s.item_id AND il.warehouse_id = s.warehouse_id AND il.tenant_id = ${tenantId}
            WHERE s.tenant_id = ${tenantId}
              AND il.reorder_point IS NOT NULL AND il.reorder_point > 0
              AND s.qty_on_hand::numeric <= il.reorder_point::numeric
          ) sub
        `) as unknown as [{ count: string }]
      ),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(cycleCountTasksTable)
          .where(and(eq(cycleCountTasksTable.tenantId, tenantId), sql`status NOT IN ('completed','cancelled')`))),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "approved")))),
    ]);
    res.json({
      role,
      kpis: {
        pickSlipsReady: Number(pickReady[0]?.count ?? 0),
        itemsToReceiveToday: Number(toReceive[0]?.count ?? 0),
        lowStockAlerts: Number((lowStockRows as Array<{ count: string }>)[0]?.count ?? 0),
        pendingCycleCounts: Number(pendingCounts[0]?.count ?? 0),
      },
    });
    return;
  }

  if (role === "approver") {
    const [pendingPos, pendingReqs, approvedMtdRows, avgTurnaround, valuePendingRows, recentDecisions] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select({ id: purchaseOrdersTable.id, code: purchaseOrdersTable.code, supplierName: purchaseOrdersTable.supplierName, total: purchaseOrdersTable.total, createdAt: purchaseOrdersTable.createdAt })
          .from(purchaseOrdersTable)
          .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "pending_approval")))
          .orderBy(desc(purchaseOrdersTable.createdAt)).limit(20)),
      withTenantDb(tenantId, (db) =>
        db.select({ id: purchaseRequisitionsTable.id, code: purchaseRequisitionsTable.code, requestedByEmail: purchaseRequisitionsTable.requestedByEmail, totalEstimated: purchaseRequisitionsTable.totalEstimated, createdAt: purchaseRequisitionsTable.createdAt })
          .from(purchaseRequisitionsTable)
          .where(and(eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt), eq(purchaseRequisitionsTable.status, "pending_approval")))
          .orderBy(desc(purchaseRequisitionsTable.createdAt)).limit(20)),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(approvalDecisionsTable)
          .where(and(eq(approvalDecisionsTable.tenantId, tenantId), eq(approvalDecisionsTable.decision, "approved"), gte(approvalDecisionsTable.decidedAt, startOfMonth())))),
      withTenantDb(tenantId, async (db) => {
        const rows = await db.execute(sql`
          SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (ad.decided_at - po.created_at)) / 3600), 0) AS avg_hours
          FROM approval_decisions ad
          JOIN purchase_orders po ON po.id = ad.entity_id AND ad.entity_type = 'purchase_order' AND po.tenant_id = ${tenantId}
          WHERE ad.tenant_id = ${tenantId} AND ad.decided_at >= ${startOfMonth()}
        `) as unknown as Array<{ avg_hours: string }>;
        return Number(rows[0]?.avg_hours ?? 0);
      }),
      withTenantDb(tenantId, async (db) => {
        const [pos, reqs] = await Promise.all([
          db.select({ total: sql<string>`coalesce(sum(total),0)` }).from(purchaseOrdersTable)
            .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "pending_approval"))),
          db.select({ total: sql<string>`coalesce(sum(total_estimated),0)` }).from(purchaseRequisitionsTable)
            .where(and(eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt), eq(purchaseRequisitionsTable.status, "pending_approval"))),
        ]);
        return Number(pos[0]?.total ?? 0) + Number(reqs[0]?.total ?? 0);
      }),
      withTenantDb(tenantId, (db) =>
        db.select({ id: approvalDecisionsTable.id, entityType: approvalDecisionsTable.entityType, entityId: approvalDecisionsTable.entityId, decision: approvalDecisionsTable.decision, approverEmail: approvalDecisionsTable.approverEmail, comment: approvalDecisionsTable.comment, decidedAt: approvalDecisionsTable.decidedAt })
          .from(approvalDecisionsTable)
          .where(and(eq(approvalDecisionsTable.tenantId, tenantId)))
          .orderBy(desc(approvalDecisionsTable.decidedAt)).limit(10)),
    ]);
    const pending = [...pendingPos.map(p => ({ ...p, entityType: "purchase_order" })), ...pendingReqs.map(r => ({ ...r, entityType: "purchase_requisition" }))];
    res.json({
      role,
      kpis: {
        pendingApprovals: pending.length,
        approvedMtd: Number(approvedMtdRows[0]?.count ?? 0),
        avgTurnaroundHours: Math.round(avgTurnaround * 10) / 10,
        valuePending: valuePendingRows,
      },
      pendingApprovalList: pending.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      recentDecisions,
    });
    return;
  }

  if (role === "accountant") {
    const today = startOfToday();
    const [postingsToday, unreconciled, trialBalTotals, outstandingInvoices, cashFlowRows] = await Promise.all([
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)`, totalDebit: sql<string>`coalesce(sum(total_debit),0)` })
          .from(glPostingsTable)
          .where(and(eq(glPostingsTable.tenantId, tenantId), eq(glPostingsTable.status, "posted"), gte(glPostingsTable.createdAt, today)))),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)` }).from(glPostingsTable)
          .where(and(eq(glPostingsTable.tenantId, tenantId), eq(glPostingsTable.status, "draft")))),
      withTenantDb(tenantId, async (db) => {
        const rows = await db.execute(sql`
          SELECT COALESCE(SUM(total_debit),0) AS "totalDebit", COALESCE(SUM(total_credit),0) AS "totalCredit"
          FROM gl_postings WHERE tenant_id = ${tenantId} AND status = 'posted'
        `) as unknown as Array<{ totalDebit: string; totalCredit: string }>;
        return rows[0];
      }),
      withTenantDb(tenantId, (db) =>
        db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(customerInvoicesTable)
          .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), sql`status IN ('sent','draft')`))),
      // Cash flow estimate: paid invoices (inflows) - PO spend this month (outflows)
      withTenantDb(tenantId, async (db) => {
        const [inflow, outflow] = await Promise.all([
          db.select({ total: sql<string>`coalesce(sum(paid_amount),0)` }).from(customerInvoicesTable)
            .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), eq(customerInvoicesTable.status, "paid"), gte(customerInvoicesTable.createdAt, startOfMonth()))),
          db.select({ total: sql<string>`coalesce(sum(total),0)` }).from(purchaseOrdersTable)
            .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), sql`status IN ('approved','sent','partially_received','closed')`, gte(purchaseOrdersTable.createdAt, startOfMonth()))),
        ]);
        return { inflow: Number(inflow[0]?.total ?? 0), outflow: Number(outflow[0]?.total ?? 0) };
      }),
    ]);
    res.json({
      role,
      kpis: {
        glPostingsToday: Number(postingsToday[0]?.count ?? 0),
        glValueToday: Number(postingsToday[0]?.totalDebit ?? 0),
        unreconciledDraftPostings: Number(unreconciled[0]?.count ?? 0),
        trialBalanceTotalDebit: Number(trialBalTotals?.totalDebit ?? 0),
        trialBalanceTotalCredit: Number(trialBalTotals?.totalCredit ?? 0),
        outstandingReceivables: Number(outstandingInvoices[0]?.total ?? 0),
        cashFlowEstimateMtd: cashFlowRows.inflow - cashFlowRows.outflow,
        cashInflowMtd: cashFlowRows.inflow,
        cashOutflowMtd: cashFlowRows.outflow,
      },
    });
    return;
  }

  // Admin / default — all-module overview
  const [openPos, salesMtd, lowStockRows, pendingApprovals, invoicesDue, glPostingsWeek, itemCount, activeOrders] = await Promise.all([
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), sql`status NOT IN ('closed','cancelled')`))),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(customerInvoicesTable)
        .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), gte(customerInvoicesTable.createdAt, startOfMonth())))),
    withTenantDb(tenantId, async (db) =>
      db.execute(sql`
        SELECT COUNT(*) AS count FROM (
          SELECT DISTINCT s.item_id FROM inventory_stock s
          JOIN item_locations il ON il.item_id = s.item_id AND il.warehouse_id = s.warehouse_id AND il.tenant_id = ${tenantId}
          WHERE s.tenant_id = ${tenantId}
            AND il.reorder_point IS NOT NULL AND il.reorder_point > 0
            AND s.qty_on_hand::numeric <= il.reorder_point::numeric
        ) sub
      `) as unknown as [{ count: string }]
    ),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` }).from(purchaseOrdersTable)
        .where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "pending_approval")))),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)`, total: sql<string>`coalesce(sum(total),0)` }).from(customerInvoicesTable)
        .where(and(eq(customerInvoicesTable.tenantId, tenantId), isNull(customerInvoicesTable.deletedAt), sql`status IN ('sent','draft')`))),
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` }).from(glPostingsTable)
        .where(and(eq(glPostingsTable.tenantId, tenantId), eq(glPostingsTable.status, "posted"), gte(glPostingsTable.createdAt, daysAgo(7))))),
    // System health: active items in catalog
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` }).from(itemsTable)
        .where(and(eq(itemsTable.tenantId, tenantId), isNull(itemsTable.deletedAt)))),
    // User activity: open sales orders (active work)
    withTenantDb(tenantId, (db) =>
      db.select({ count: sql<number>`count(*)` }).from(salesOrdersTable)
        .where(and(eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt), sql`status IN ('confirmed','processing','partially_despatched')`))),
  ]);

  res.json({
    role,
    kpis: {
      openPOs: Number(openPos[0]?.count ?? 0),
      openPOsValue: Number(openPos[0]?.total ?? 0),
      salesMtdCount: Number(salesMtd[0]?.count ?? 0),
      salesMtdValue: Number(salesMtd[0]?.total ?? 0),
      lowStockAlerts: Number((lowStockRows as Array<{ count: string }>)[0]?.count ?? 0),
      pendingApprovals: Number(pendingApprovals[0]?.count ?? 0),
      outstandingInvoicesCount: Number(invoicesDue[0]?.count ?? 0),
      outstandingReceivables: Number(invoicesDue[0]?.total ?? 0),
      glPostingsThisWeek: Number(glPostingsWeek[0]?.count ?? 0),
      catalogItemCount: Number(itemCount[0]?.count ?? 0),
      activeSalesOrders: Number(activeOrders[0]?.count ?? 0),
    },
  });
});

// ── Widget Data Endpoints ──────────────────────────────────────────────────────

router.get("/dashboard/widget/:type", ...tenantUserMiddleware, async (req: Request, res: Response): Promise<void> => {
  const { tenantId } = req as TenantRequest;
  const { type } = req.params;
  const { limit = "10" } = req.query as Record<string, string>;
  const lim = Math.min(50, Math.max(1, Number(limit)));

  switch (type) {
    case "recent-pos": {
      const rows = await withTenantDb(tenantId, (db) =>
        db.select({ id: purchaseOrdersTable.id, code: purchaseOrdersTable.code, supplierName: purchaseOrdersTable.supplierName, status: purchaseOrdersTable.status, total: purchaseOrdersTable.total, createdAt: purchaseOrdersTable.createdAt })
          .from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt)))
          .orderBy(desc(purchaseOrdersTable.createdAt)).limit(lim));
      res.json({ type, data: rows }); return;
    }
    case "recent-orders": {
      const rows = await withTenantDb(tenantId, (db) =>
        db.select({ id: salesOrdersTable.id, code: salesOrdersTable.code, customerName: salesOrdersTable.customerName, status: salesOrdersTable.status, total: salesOrdersTable.total, createdAt: salesOrdersTable.createdAt })
          .from(salesOrdersTable).where(and(eq(salesOrdersTable.tenantId, tenantId), isNull(salesOrdersTable.deletedAt)))
          .orderBy(desc(salesOrdersTable.createdAt)).limit(lim));
      res.json({ type, data: rows }); return;
    }
    case "stock-alerts": {
      const result = await withTenantDb(tenantId, (db) =>
        db.execute(sql`
          SELECT DISTINCT ON (s.item_id) s.item_id AS "itemId", i.code AS "itemCode", i.name AS "itemName",
            s.warehouse_id AS "warehouseId", s.qty_on_hand::numeric AS "qtyOnHand", il.reorder_point::numeric AS "reorderPoint"
          FROM inventory_stock s
          JOIN items i ON i.id = s.item_id AND i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
          JOIN item_locations il ON il.item_id = s.item_id AND il.warehouse_id = s.warehouse_id AND il.tenant_id = ${tenantId}
          WHERE s.tenant_id = ${tenantId}
            AND il.reorder_point IS NOT NULL AND il.reorder_point > 0
            AND s.qty_on_hand::numeric <= il.reorder_point::numeric
          ORDER BY s.item_id, s.qty_on_hand ASC
          LIMIT ${lim}
        `)
      );
      res.json({ type, data: result.rows }); return;
    }
    case "pending-approvals": {
      const [pos, reqs] = await Promise.all([
        withTenantDb(tenantId, (db) =>
          db.select({ id: purchaseOrdersTable.id, code: purchaseOrdersTable.code, supplierName: purchaseOrdersTable.supplierName, total: purchaseOrdersTable.total, createdAt: purchaseOrdersTable.createdAt })
            .from(purchaseOrdersTable).where(and(eq(purchaseOrdersTable.tenantId, tenantId), isNull(purchaseOrdersTable.deletedAt), eq(purchaseOrdersTable.status, "pending_approval")))
            .orderBy(desc(purchaseOrdersTable.createdAt)).limit(lim)),
        withTenantDb(tenantId, (db) =>
          db.select({ id: purchaseRequisitionsTable.id, code: purchaseRequisitionsTable.code, requestedByEmail: purchaseRequisitionsTable.requestedByEmail, totalEstimated: purchaseRequisitionsTable.totalEstimated, createdAt: purchaseRequisitionsTable.createdAt })
            .from(purchaseRequisitionsTable).where(and(eq(purchaseRequisitionsTable.tenantId, tenantId), isNull(purchaseRequisitionsTable.deletedAt), eq(purchaseRequisitionsTable.status, "pending_approval")))
            .orderBy(desc(purchaseRequisitionsTable.createdAt)).limit(lim)),
      ]);
      const combined = [
        ...pos.map(p => ({ type: "purchase_order", code: p.code, requestedBy: p.supplierName ?? "—", amount: Number(p.total ?? 0), createdAt: p.createdAt })),
        ...reqs.map(r => ({ type: "requisition", code: r.code, requestedBy: r.requestedByEmail ?? "—", amount: Number(r.totalEstimated ?? 0), createdAt: r.createdAt })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json({ type, data: combined }); return;
    }
    case "top-items": {
      const result = await withTenantDb(tenantId, (db) =>
        db.execute(sql`
          SELECT item_code AS "itemCode", item_name AS "itemName",
                 SUM(ABS(quantity::numeric)) AS "totalQty", COUNT(*) AS "movementCount"
          FROM inventory_movements
          WHERE tenant_id = ${tenantId} AND created_at >= ${daysAgo(30)}
          GROUP BY item_code, item_name
          ORDER BY "totalQty" DESC LIMIT ${lim}
        `)
      );
      res.json({ type, data: result.rows }); return;
    }
    case "stock-value": {
      const result = await withTenantDb(tenantId, (db) =>
        db.execute(sql`
          SELECT s.warehouse_id AS "warehouseId", w.name AS "warehouseName",
                 SUM(s.qty_on_hand::numeric * COALESCE(s.average_cost::numeric, 0)) AS "totalValue",
                 COUNT(DISTINCT s.item_id) AS "itemCount"
          FROM inventory_stock s
          JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = ${tenantId}
          WHERE s.tenant_id = ${tenantId}
          GROUP BY s.warehouse_id, w.name ORDER BY "totalValue" DESC
        `)
      );
      res.json({ type, data: result.rows }); return;
    }
    case "gl-activity": {
      const rows = await withTenantDb(tenantId, (db) =>
        db.select({ id: glPostingsTable.id, code: glPostingsTable.code, entityType: glPostingsTable.entityType, totalDebit: glPostingsTable.totalDebit, status: glPostingsTable.status, postedAt: glPostingsTable.postedAt, notes: glPostingsTable.notes, createdAt: glPostingsTable.createdAt })
          .from(glPostingsTable).where(and(eq(glPostingsTable.tenantId, tenantId), eq(glPostingsTable.status, "posted")))
          .orderBy(desc(glPostingsTable.createdAt)).limit(lim));
      res.json({ type, data: rows }); return;
    }
    case "sales-by-period": {
      const result = await withTenantDb(tenantId, (db) =>
        db.execute(sql`
          SELECT DATE_TRUNC('month', created_at) AS "period",
                 COUNT(*) AS "orderCount",
                 COALESCE(SUM(total::numeric), 0) AS "revenue"
          FROM customer_invoices
          WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
            AND created_at >= ${daysAgo(180)}
          GROUP BY DATE_TRUNC('month', created_at)
          ORDER BY "period" ASC
        `)
      );
      res.json({ type, data: result.rows }); return;
    }
    default:
      res.status(400).json({ error: `Unknown widget type: ${type}` });
  }
});

export default router;

import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  date,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import {
  suppliersTable,
  customersTable,
  warehousesTable,
  warehouseLocationsTable,
  itemsTable,
  glAccountsTable,
} from "./master_data";

// ── Approval Workflows ───────────────────────────────────────────────────────
export const approvalWorkflowsTable = pgTable("approval_workflows", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  entityType: text("entity_type").notNull().default("purchase_order"), // purchase_requisition | purchase_order
  isActive: boolean("is_active").notNull().default(true),
  triggerRules: jsonb("trigger_rules").notNull().default({}), // { valueAbove?: number, categories?: string[], supplierIds?: number[] }
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const approvalStepsTable = pgTable("approval_steps", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  workflowId: integer("workflow_id")
    .notNull()
    .references(() => approvalWorkflowsTable.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),
  stepName: text("step_name").notNull(),
  approverType: text("approver_type").notNull().default("role"), // role | user
  approverRoles: jsonb("approver_roles").notNull().default([]), // string[]
  approverUserIds: jsonb("approver_user_ids").notNull().default([]), // clerkUserId[]
  approvalMode: text("approval_mode").notNull().default("any"), // any | all
  valueLimit: numeric("value_limit", { precision: 18, scale: 2 }),
  escalationDays: integer("escalation_days").default(3),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Purchase Requisitions ────────────────────────────────────────────────────
export const purchaseRequisitionsTable = pgTable("purchase_requisitions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  requestedByClerkId: text("requested_by_clerk_id").notNull(),
  requestedByEmail: text("requested_by_email"),
  preferredSupplierId: integer("preferred_supplier_id").references(() => suppliersTable.id),
  deliverToWarehouseId: integer("deliver_to_warehouse_id").references(() => warehousesTable.id),
  currencyCode: text("currency_code").notNull().default("AUD"),
  totalEstimated: numeric("total_estimated", { precision: 18, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("draft"), // draft | submitted | pending_approval | approved | rejected | converted | cancelled
  priority: text("priority").notNull().default("normal"), // normal | urgent | low
  requiredByDate: date("required_by_date"),
  approvalWorkflowId: integer("approval_workflow_id").references(() => approvalWorkflowsTable.id),
  currentApprovalStep: integer("current_approval_step").default(0),
  notes: text("notes"),
  convertedPoId: integer("converted_po_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const requisitionLinesTable = pgTable("requisition_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  requisitionId: integer("requisition_id")
    .notNull()
    .references(() => purchaseRequisitionsTable.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitOfMeasure: text("unit_of_measure"),
  estimatedUnitPrice: numeric("estimated_unit_price", { precision: 18, scale: 4 }),
  estimatedTotal: numeric("estimated_total", { precision: 18, scale: 2 }),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Purchase Orders ──────────────────────────────────────────────────────────
export const purchaseOrdersTable = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  supplierName: text("supplier_name"),
  supplierRef: text("supplier_ref"),
  deliverToWarehouseId: integer("deliver_to_warehouse_id").references(() => warehousesTable.id),
  deliveryDate: date("delivery_date"),
  currencyCode: text("currency_code").notNull().default("AUD"),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }).default("1"),
  paymentTerms: text("payment_terms"),
  status: text("status").notNull().default("draft"), // draft | pending_approval | approved | sent | receiving | received | partially_received | cancelled | closed
  subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  internalNotes: text("internal_notes"),
  approvalWorkflowId: integer("approval_workflow_id").references(() => approvalWorkflowsTable.id),
  currentApprovalStep: integer("current_approval_step").default(0),
  requisitionId: integer("requisition_id").references(() => purchaseRequisitionsTable.id),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const poLinesTable = pgTable("po_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  lineType: text("line_type").notNull().default("stock"), // stock | service | charge | comment
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("0"),
  receivedQty: numeric("received_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  unitOfMeasure: text("unit_of_measure"),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull().default("0"),
  discountPct: numeric("discount_pct", { precision: 8, scale: 4 }).default("0"),
  taxPct: numeric("tax_pct", { precision: 8, scale: 4 }).default("0"),
  lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0"),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  requisitionLineId: integer("requisition_line_id").references(() => requisitionLinesTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Approval Decisions ───────────────────────────────────────────────────────
export const approvalDecisionsTable = pgTable("approval_decisions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  workflowId: integer("workflow_id").references(() => approvalWorkflowsTable.id),
  stepId: integer("step_id").references(() => approvalStepsTable.id),
  stepNumber: integer("step_number").notNull(),
  entityType: text("entity_type").notNull(), // purchase_requisition | purchase_order
  entityId: integer("entity_id").notNull(),
  approverClerkId: text("approver_clerk_id").notNull(),
  approverEmail: text("approver_email"),
  decision: text("decision").notNull(), // approved | rejected | returned | delegated
  comment: text("comment"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Goods Receipt ────────────────────────────────────────────────────────────
export const poReceiptsTable = pgTable("po_receipts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  status: text("status").notNull().default("draft"), // draft | confirmed | posted
  receivedByClerkId: text("received_by_clerk_id"),
  receivedByEmail: text("received_by_email"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  supplierDeliveryRef: text("supplier_delivery_ref"),
  notes: text("notes"),
  glPostingId: integer("gl_posting_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const receiptLinesTable = pgTable("receipt_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  receiptId: integer("receipt_id")
    .notNull()
    .references(() => poReceiptsTable.id, { onDelete: "cascade" }),
  poLineId: integer("po_line_id")
    .notNull()
    .references(() => poLinesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  orderedQty: numeric("ordered_qty", { precision: 18, scale: 4 }).notNull(),
  receivedQty: numeric("received_qty", { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  batchNumber: text("batch_number"),
  serialNumber: text("serial_number"),
  expiryDate: date("expiry_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Returns to Vendor (RTV) ──────────────────────────────────────────────────
export const poReturnsTable = pgTable("po_returns", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  poId: integer("po_id")
    .notNull()
    .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  receiptId: integer("receipt_id").references(() => poReceiptsTable.id),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("draft"), // draft | confirmed | posted
  returnType: text("return_type").notNull().default("credit"), // credit | replace
  reason: text("reason"),
  notes: text("notes"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  glPostingId: integer("gl_posting_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const poReturnLinesTable = pgTable("po_return_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  returnId: integer("return_id")
    .notNull()
    .references(() => poReturnsTable.id, { onDelete: "cascade" }),
  poLineId: integer("po_line_id").references(() => poLinesTable.id),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  serialNumber: text("serial_number"),
  batchNumber: text("batch_number"),
  reason: text("reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── GL Postings ──────────────────────────────────────────────────────────────
export const glPostingsTable = pgTable("gl_postings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  entityType: text("entity_type").notNull(), // po_receipt | po_return
  entityId: integer("entity_id").notNull(),
  status: text("status").notNull().default("draft"), // draft | posted | reversed
  postedByClerkId: text("posted_by_clerk_id"),
  postedByEmail: text("posted_by_email"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  notes: text("notes"),
  lines: jsonb("lines").notNull().default([]), // [{accountId, accountCode, accountName, debit, credit, description}]
  totalDebit: numeric("total_debit", { precision: 18, scale: 2 }).notNull().default("0"),
  totalCredit: numeric("total_credit", { precision: 18, scale: 2 }).notNull().default("0"),
  reversedByPostingId: integer("reversed_by_posting_id"),
  attachmentUrl: text("attachment_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Inventory Stock (updated on receipt/return/movement) ─────────────────────
export const inventoryStockTable = pgTable("inventory_stock", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id")
    .notNull()
    .references(() => warehousesTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  batchNumber: text("batch_number"),
  serialNumber: text("serial_number"),
  expiryDate: date("expiry_date"),
  qtyOnHand: numeric("qty_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
  qtyReserved: numeric("qty_reserved", { precision: 18, scale: 4 }).notNull().default("0"),
  averageCost: numeric("average_cost", { precision: 18, scale: 4 }),
  lastMovementAt: timestamp("last_movement_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const inventoryMovementsTable = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  warehouseId: integer("warehouse_id")
    .notNull()
    .references(() => warehousesTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  /** Destination warehouse for transfers */
  toWarehouseId: integer("to_warehouse_id").references(() => warehousesTable.id),
  /** Destination location for transfers */
  toLocationId: integer("to_location_id").references(() => warehouseLocationsTable.id),
  /** receipt | despatch | return | adjustment | transfer | issue | repack | build */
  movementType: text("movement_type").notNull(),
  /** positive = in, negative = out */
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  /** po_receipt | po_return | so_despatch | adjustment | transfer | issue | build */
  refType: text("ref_type"),
  refId: integer("ref_id"),
  refCode: text("ref_code"),
  lotNumber: text("lot_number"),
  batchNumber: text("batch_number"),
  serialNumber: text("serial_number"),
  /** Reason code for adjustments */
  adjReason: text("adj_reason"),
  /** GL account for issues */
  issueAccountId: integer("issue_account_id"),
  issueAccountCode: text("issue_account_code"),
  /** Link to the GL posting generated by this movement */
  glPostingId: integer("gl_posting_id"),
  postedByEmail: text("posted_by_email"),
  notes: text("notes"),
  postedByClerkId: text("posted_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Type exports ─────────────────────────────────────────────────────────────
export type ApprovalWorkflow = typeof approvalWorkflowsTable.$inferSelect;
export type ApprovalStep = typeof approvalStepsTable.$inferSelect;
export type ApprovalDecision = typeof approvalDecisionsTable.$inferSelect;
export type PurchaseRequisition = typeof purchaseRequisitionsTable.$inferSelect;
export type RequisitionLine = typeof requisitionLinesTable.$inferSelect;
export type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
export type PoLine = typeof poLinesTable.$inferSelect;
export type PoReceipt = typeof poReceiptsTable.$inferSelect;
export type ReceiptLine = typeof receiptLinesTable.$inferSelect;
export type PoReturn = typeof poReturnsTable.$inferSelect;
export type PoReturnLine = typeof poReturnLinesTable.$inferSelect;
export type GlPosting = typeof glPostingsTable.$inferSelect;
export type InventoryStock = typeof inventoryStockTable.$inferSelect;
export type InventoryMovement = typeof inventoryMovementsTable.$inferSelect;

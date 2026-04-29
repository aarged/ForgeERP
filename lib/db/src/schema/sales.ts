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
  customersTable,
  warehousesTable,
  warehouseLocationsTable,
  itemsTable,
  glAccountsTable,
} from "./master_data";

// ── Quotations ────────────────────────────────────────────────────────────────
export const quotationsTable = pgTable("quotations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerRef: text("customer_ref"),
  deliveryAddressLine1: text("delivery_address_line1"),
  deliveryAddressLine2: text("delivery_address_line2"),
  deliveryCity: text("delivery_city"),
  deliveryState: text("delivery_state"),
  deliveryPostalCode: text("delivery_postal_code"),
  deliveryCountry: text("delivery_country"),
  expiryDate: date("expiry_date"),
  requestedDate: date("requested_date"),
  currencyCode: text("currency_code").notNull().default("AUD"),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }).default("1"),
  paymentTerms: text("payment_terms"),
  status: text("status").notNull().default("draft"), // draft | sent | accepted | rejected | expired | converted
  subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  internalNotes: text("internal_notes"),
  convertedSoId: integer("converted_so_id"), // set when converted to SO (idempotency guard)
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const quotationLinesTable = pgTable("quotation_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  quotationId: integer("quotation_id")
    .notNull()
    .references(() => quotationsTable.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  lineType: text("line_type").notNull().default("stock"), // stock | service | charge | comment
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
  unitOfMeasure: text("unit_of_measure"),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull().default("0"),
  discountPct: numeric("discount_pct", { precision: 8, scale: 4 }).default("0"),
  taxPct: numeric("tax_pct", { precision: 8, scale: 4 }).default("0"),
  lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0"),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Sales Orders ──────────────────────────────────────────────────────────────
export const salesOrdersTable = pgTable("sales_orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  quotationId: integer("quotation_id").references(() => quotationsTable.id),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerRef: text("customer_ref"),
  deliveryAddressLine1: text("delivery_address_line1"),
  deliveryAddressLine2: text("delivery_address_line2"),
  deliveryCity: text("delivery_city"),
  deliveryState: text("delivery_state"),
  deliveryPostalCode: text("delivery_postal_code"),
  deliveryCountry: text("delivery_country"),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  requestedDate: date("requested_date"),
  scheduledDate: date("scheduled_date"),
  currencyCode: text("currency_code").notNull().default("AUD"),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }).default("1"),
  paymentTerms: text("payment_terms"),
  status: text("status").notNull().default("draft"), // draft | confirmed | picking | partially_despatched | despatched | invoiced | cancelled
  subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  internalNotes: text("internal_notes"),
  creditCheckPassed: boolean("credit_check_passed").notNull().default(true),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const soLinesTable = pgTable("so_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  soId: integer("so_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  lineNumber: integer("line_number").notNull(),
  lineType: text("line_type").notNull().default("stock"), // stock | service | charge | comment
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull().default("1"),
  despatched_qty: numeric("despatched_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  invoiced_qty: numeric("invoiced_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  unitOfMeasure: text("unit_of_measure"),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull().default("0"),
  discountPct: numeric("discount_pct", { precision: 8, scale: 4 }).default("0"),
  taxPct: numeric("tax_pct", { precision: 8, scale: 4 }).default("0"),
  lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0"),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  quotationLineId: integer("quotation_line_id").references(() => quotationLinesTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Stock Allocations (soft reservation against an SO) ────────────────────────
export const soAllocationsTable = pgTable("so_allocations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  soId: integer("so_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  soLineId: integer("so_line_id")
    .notNull()
    .references(() => soLinesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id")
    .notNull()
    .references(() => warehousesTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  allocatedQty: numeric("allocated_qty", { precision: 18, scale: 4 }).notNull(),
  isReleased: boolean("is_released").notNull().default(false),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Pick Slips ────────────────────────────────────────────────────────────────
export const pickSlipsTable = pgTable("pick_slips", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  soId: integer("so_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("pending"), // pending | picking | picked | cancelled
  notes: text("notes"),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const pickSlipLinesTable = pgTable("pick_slip_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  pickSlipId: integer("pick_slip_id")
    .notNull()
    .references(() => pickSlipsTable.id, { onDelete: "cascade" }),
  soLineId: integer("so_line_id")
    .notNull()
    .references(() => soLinesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  requiredQty: numeric("required_qty", { precision: 18, scale: 4 }).notNull(),
  pickedQty: numeric("picked_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  lotNumber: text("lot_number"),
  serialNumber: text("serial_number"),
  batchNumber: text("batch_number"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Despatches ────────────────────────────────────────────────────────────────
export const despatchesTable = pgTable("despatches", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  soId: integer("so_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("draft"), // draft | confirmed
  despatchDate: date("despatch_date"),
  trackingNumber: text("tracking_number"),
  carrier: text("carrier"),
  notes: text("notes"),
  glPostingId: integer("gl_posting_id"),
  despatcedByClerkId: text("despatched_by_clerk_id"),
  despatchedAt: timestamp("despatched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const despatchLinesTable = pgTable("despatch_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  despatchId: integer("despatch_id")
    .notNull()
    .references(() => despatchesTable.id, { onDelete: "cascade" }),
  soLineId: integer("so_line_id")
    .notNull()
    .references(() => soLinesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  serialNumber: text("serial_number"),
  batchNumber: text("batch_number"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Customer Invoices ─────────────────────────────────────────────────────────
export const customerInvoicesTable = pgTable("customer_invoices", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  soId: integer("so_id")
    .notNull()
    .references(() => salesOrdersTable.id, { onDelete: "cascade" }),
  despatchId: integer("despatch_id").references(() => despatchesTable.id),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  status: text("status").notNull().default("draft"), // draft | sent | paid | cancelled
  invoiceDate: date("invoice_date"),
  dueDate: date("due_date"),
  currencyCode: text("currency_code").notNull().default("AUD"),
  subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  paidAmount: numeric("paid_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  glPostingId: integer("gl_posting_id"),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const customerInvoiceLinesTable = pgTable("customer_invoice_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => customerInvoicesTable.id, { onDelete: "cascade" }),
  soLineId: integer("so_line_id").references(() => soLinesTable.id),
  despatchLineId: integer("despatch_line_id").references(() => despatchLinesTable.id),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull().default("0"),
  discountPct: numeric("discount_pct", { precision: 8, scale: 4 }).default("0"),
  taxPct: numeric("tax_pct", { precision: 8, scale: 4 }).default("0"),
  lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0"),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Credit Notes ──────────────────────────────────────────────────────────────
export const creditNotesTable = pgTable("credit_notes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  invoiceId: integer("invoice_id").references(() => customerInvoicesTable.id),
  soId: integer("so_id").references(() => salesOrdersTable.id),
  rmaId: integer("rma_id"), // set after rma_orders table defined
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  reason: text("reason"),
  status: text("status").notNull().default("draft"), // draft | issued | cancelled
  subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 18, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  glPostingId: integer("gl_posting_id"),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const creditNoteLinesTable = pgTable("credit_note_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  creditNoteId: integer("credit_note_id")
    .notNull()
    .references(() => creditNotesTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  description: text("description"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull().default("0"),
  taxPct: numeric("tax_pct", { precision: 8, scale: 4 }).default("0"),
  lineTotal: numeric("line_total", { precision: 18, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── RMA (Return Merchandise Authorization) ────────────────────────────────────
export const rmaOrdersTable = pgTable("rma_orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  soId: integer("so_id").references(() => salesOrdersTable.id),
  invoiceId: integer("invoice_id").references(() => customerInvoicesTable.id),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("draft"), // draft | authorized | received | processed | closed
  reason: text("reason"),
  resolution: text("resolution").notNull().default("credit"), // credit | exchange | repair
  notes: text("notes"),
  creditNoteId: integer("credit_note_id"),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  createdByClerkId: text("created_by_clerk_id"),
  createdByEmail: text("created_by_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const rmaLinesTable = pgTable("rma_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  rmaId: integer("rma_id")
    .notNull()
    .references(() => rmaOrdersTable.id, { onDelete: "cascade" }),
  soLineId: integer("so_line_id").references(() => soLinesTable.id),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  receivedQty: numeric("received_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }),
  condition: text("condition").notNull().default("unknown"), // good | damaged | unknown
  disposition: text("disposition").notNull().default("restock"), // restock | scrap | return_to_supplier
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  reason: text("reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Backorders ────────────────────────────────────────────────────────────────
// Auto-created when a despatch partially fulfils an SO line; released when stock arrives
export const backordersTable = pgTable("backorders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  soId: integer("so_id").notNull().references(() => salesOrdersTable.id),
  soLineId: integer("so_line_id").references(() => soLinesTable.id),
  customerId: integer("customer_id").references(() => customersTable.id),
  customerName: text("customer_name"),
  itemId: integer("item_id").references(() => itemsTable.id),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  /** Original ordered quantity for this backorder */
  orderedQty: numeric("ordered_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  /** Quantity still outstanding (not yet despatched via subsequent deliveries) */
  backorderQty: numeric("backorder_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  /** Quantity released/fulfilled against this backorder */
  releasedQty: numeric("released_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  unitPrice: numeric("unit_price", { precision: 18, scale: 4 }),
  /** open | released | cancelled */
  status: text("status").notNull().default("open"),
  requestedDate: date("requested_date"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releasedByClerkId: text("released_by_clerk_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Type exports ──────────────────────────────────────────────────────────────
export type Quotation = typeof quotationsTable.$inferSelect;
export type QuotationLine = typeof quotationLinesTable.$inferSelect;
export type SalesOrder = typeof salesOrdersTable.$inferSelect;
export type SoLine = typeof soLinesTable.$inferSelect;
export type SoAllocation = typeof soAllocationsTable.$inferSelect;
export type PickSlip = typeof pickSlipsTable.$inferSelect;
export type PickSlipLine = typeof pickSlipLinesTable.$inferSelect;
export type Despatch = typeof despatchesTable.$inferSelect;
export type DespatchLine = typeof despatchLinesTable.$inferSelect;
export type CustomerInvoice = typeof customerInvoicesTable.$inferSelect;
export type CustomerInvoiceLine = typeof customerInvoiceLinesTable.$inferSelect;
export type CreditNote = typeof creditNotesTable.$inferSelect;
export type CreditNoteLine = typeof creditNoteLinesTable.$inferSelect;
export type RmaOrder = typeof rmaOrdersTable.$inferSelect;
export type RmaLine = typeof rmaLinesTable.$inferSelect;
export type Backorder = typeof backordersTable.$inferSelect;

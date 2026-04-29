import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  boolean,
  date,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import {
  itemsTable,
  warehousesTable,
  warehouseLocationsTable,
  glAccountsTable,
} from "./master_data";
import { inventoryMovementsTable } from "./procurement";

// ── FIFO Cost Layers ─────────────────────────────────────────────────────────
// One row per receipt/inbound transaction for items using FIFO costing.
// Consumed (FIFO matched) when stock leaves.
export const costLayersTable = pgTable("cost_layers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  /** Quantity remaining unconsumed in this cost layer */
  qtyRemaining: numeric("qty_remaining", { precision: 18, scale: 4 }).notNull().default("0"),
  /** Quantity that originally entered via this layer */
  qtyOriginal: numeric("qty_original", { precision: 18, scale: 4 }).notNull().default("0"),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull().default("0"),
  /** Reference to the inventory movement that created this layer */
  movementId: integer("movement_id").references(() => inventoryMovementsTable.id),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Lot Numbers ──────────────────────────────────────────────────────────────
// Formal lot/batch master records for lot-controlled items.
export const lotNumbersTable = pgTable("lot_numbers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  lotNumber: text("lot_number").notNull(),
  batchNumber: text("batch_number"),
  expiryDate: date("expiry_date"),
  manufacturedDate: date("manufactured_date"),
  supplierLotNumber: text("supplier_lot_number"),
  originWarehouseId: integer("origin_warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("active"), // active | quarantine | consumed | expired
  qtyReceived: numeric("qty_received", { precision: 18, scale: 4 }).notNull().default("0"),
  qtyOnHand: numeric("qty_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Inventory Adjustments (document header) ───────────────────────────────────
// Each adjustment document groups one or more movement lines.
export const inventoryAdjustmentsTable = pgTable("inventory_adjustments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  /** increase | decrease | recount */
  adjustmentType: text("adjustment_type").notNull().default("increase"),
  reason: text("reason").notNull(),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  glAccountCode: text("gl_account_code"),
  glAccountName: text("gl_account_name"),
  warehouseId: integer("warehouse_id").references(() => warehousesTable.id),
  status: text("status").notNull().default("draft"), // draft | posted
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedByClerkId: text("posted_by_clerk_id"),
  postedByEmail: text("posted_by_email"),
  glPostingId: integer("gl_posting_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Inventory Adjustment Lines ────────────────────────────────────────────────
export const inventoryAdjustmentLinesTable = pgTable("inventory_adjustment_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  adjustmentId: integer("adjustment_id").notNull().references(() => inventoryAdjustmentsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  /** Positive = increase, negative = decrease */
  qtyAdjusted: numeric("qty_adjusted", { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  movementId: integer("movement_id").references(() => inventoryMovementsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Stocktake Runs ────────────────────────────────────────────────────────────
export const stocktakeRunsTable = pgTable("stocktake_runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  status: text("status").notNull().default("open"), // open | counting | variance | posted | cancelled
  countedAt: date("counted_at"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedByClerkId: text("posted_by_clerk_id"),
  glPostingId: integer("gl_posting_id"),
  notes: text("notes"),
  createdByClerkId: text("created_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Stocktake Lines ───────────────────────────────────────────────────────────
export const stocktakeLinesTable = pgTable("stocktake_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  stocktakeId: integer("stocktake_id").notNull().references(() => stocktakeRunsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  lotNumber: text("lot_number"),
  /** System quantity at time of freeze */
  systemQty: numeric("system_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  /** Physically counted quantity (null = not yet counted) */
  countedQty: numeric("counted_qty", { precision: 18, scale: 4 }),
  /** countedQty - systemQty */
  varianceQty: numeric("variance_qty", { precision: 18, scale: 4 }),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  varianceValue: numeric("variance_value", { precision: 18, scale: 4 }),
  movementId: integer("movement_id").references(() => inventoryMovementsTable.id),
  countedByClerkId: text("counted_by_clerk_id"),
  countedAt: timestamp("counted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Cycle Count Tasks ─────────────────────────────────────────────────────────
export const cycleCountTasksTable = pgTable("cycle_count_tasks", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehousesTable.id),
  locationId: integer("location_id").references(() => warehouseLocationsTable.id),
  category: text("category"),
  assignedToClerkId: text("assigned_to_clerk_id"),
  assignedToName: text("assigned_to_name"),
  dueDate: date("due_date"),
  status: text("status").notNull().default("pending"), // pending | in_progress | completed | cancelled
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedByClerkId: text("completed_by_clerk_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Cycle Count Lines ─────────────────────────────────────────────────────────
export const cycleCountLinesTable = pgTable("cycle_count_lines", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  taskId: integer("task_id").notNull().references(() => cycleCountTasksTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id").notNull().references(() => itemsTable.id, { onDelete: "cascade" }),
  itemCode: text("item_code"),
  itemName: text("item_name"),
  lotNumber: text("lot_number"),
  systemQty: numeric("system_qty", { precision: 18, scale: 4 }).notNull().default("0"),
  countedQty: numeric("counted_qty", { precision: 18, scale: 4 }),
  varianceQty: numeric("variance_qty", { precision: 18, scale: 4 }),
  countedAt: timestamp("counted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Landed Cost Allocations ───────────────────────────────────────────────────
// Allocates freight, duties, and other landed costs to receipt lines.
export const landedCostAllocationsTable = pgTable("landed_cost_allocations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  receiptId: integer("receipt_id").notNull(),
  receiptLineId: integer("receipt_line_id"),
  costType: text("cost_type").notNull(), // freight | duty | insurance | other
  description: text("description"),
  totalLandedCost: numeric("total_landed_cost", { precision: 18, scale: 2 }).notNull(),
  allocationMethod: text("allocation_method").notNull().default("value"), // value | qty | weight
  allocatedAmount: numeric("allocated_amount", { precision: 18, scale: 4 }),
  glAccountId: integer("gl_account_id").references(() => glAccountsTable.id),
  isPosted: boolean("is_posted").notNull().default(false),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Type exports ──────────────────────────────────────────────────────────────
export type CostLayer = typeof costLayersTable.$inferSelect;
export type LotNumber = typeof lotNumbersTable.$inferSelect;
export type InventoryAdjustment = typeof inventoryAdjustmentsTable.$inferSelect;
export type InventoryAdjustmentLine = typeof inventoryAdjustmentLinesTable.$inferSelect;
export type StocktakeRun = typeof stocktakeRunsTable.$inferSelect;
export type StocktakeLine = typeof stocktakeLinesTable.$inferSelect;
export type CycleCountTask = typeof cycleCountTasksTable.$inferSelect;
export type CycleCountLine = typeof cycleCountLinesTable.$inferSelect;
export type LandedCostAllocation = typeof landedCostAllocationsTable.$inferSelect;

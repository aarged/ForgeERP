import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";

// ── Warehouses ──────────────────────────────────────────────────────────────
export const warehousesTable = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  isDefault: text("is_default").notNull().default("false"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Warehouse Locations (zones → aisles → bins) ─────────────────────────────
export const warehouseLocationsTable = pgTable("warehouse_locations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id")
    .notNull()
    .references(() => warehousesTable.id, { onDelete: "cascade" }),
  parentId: integer("parent_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  locationType: text("location_type").notNull().default("bin"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Departments ─────────────────────────────────────────────────────────────
export const departmentsTable = pgTable("departments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Items ───────────────────────────────────────────────────────────────────
export const itemsTable = pgTable("items", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  itemType: text("item_type").notNull().default("stock"),
  trackingType: text("tracking_type").notNull().default("none"),
  unitOfMeasure: text("unit_of_measure"),
  packSize: numeric("pack_size", { precision: 10, scale: 4 }),
  barcode: text("barcode"),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
  salesPrice: numeric("sales_price", { precision: 18, scale: 4 }),
  marketPrice: numeric("market_price", { precision: 18, scale: 4 }),
  category: text("category"),
  imageUrl: text("image_url"),
  /** fifo | avco | standard — determines how stock cost is maintained */
  costingMethod: text("costing_method").notNull().default("avco"),
  isActive: boolean("is_active").notNull().default(true),
  hasVariants: boolean("has_variants").notNull().default(false),
  /** True when there is enough demand that this item is planned to be held in stock. */
  planned: boolean("planned").notNull().default(false),
  notes: text("notes"),
  /** Preferred supplier for this item (FK -> suppliers.id). */
  preferredSupplierId: integer("preferred_supplier_id").references((): AnyPgColumn => suppliersTable.id, { onDelete: "set null" }),
  /** Preferred supplier's part number for this item. */
  supplierItemNumber: text("supplier_item_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("items_tenant_code_unique_idx")
    .on(t.tenantId, sql`lower(${t.code})`)
    .where(sql`${t.deletedAt} IS NULL`),
]);

// ── Item Variants ───────────────────────────────────────────────────────────
export const itemVariantsTable = pgTable("item_variants", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  variantCode: text("variant_code").notNull(),
  name: text("name").notNull(),
  sku: text("sku"),
  barcode: text("barcode"),
  attributes: jsonb("attributes"),
  costAdjustment: numeric("cost_adjustment", { precision: 18, scale: 4 }),
  priceAdjustment: numeric("price_adjustment", { precision: 18, scale: 4 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Item Units (UoM conversions) ─────────────────────────────────────────────
export const itemUnitsTable = pgTable("item_units", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  unitCode: text("unit_code").notNull(),
  unitName: text("unit_name").notNull(),
  conversionFactor: numeric("conversion_factor", { precision: 18, scale: 6 }).notNull().default("1"),
  isBase: boolean("is_base").notNull().default(false),
  barcode: text("barcode"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Item Attributes ─────────────────────────────────────────────────────────
export const itemAttributesTable = pgTable("item_attributes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  attrKey: text("attr_key").notNull(),
  attrValue: text("attr_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Item Locations (warehouse stocking locations per item) ──────────────────
export const itemLocationsTable = pgTable("item_locations", {
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
  locationId: integer("location_id"),
  reorderPoint: numeric("reorder_point", { precision: 12, scale: 4 }),
  reorderQty: numeric("reorder_qty", { precision: 12, scale: 4 }),
  maxStock: numeric("max_stock", { precision: 12, scale: 4 }),
  isPreferred: boolean("is_preferred").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Item Cross References ────────────────────────────────────────────────────
export const itemCrossReferencesTable = pgTable("item_cross_references", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => itemsTable.id, { onDelete: "cascade" }),
  refType: text("ref_type").notNull().default("alternative"),
  refCode: text("ref_code").notNull(),
  refDescription: text("ref_description"),
  supplierId: integer("supplier_id"),
  competitorName: text("competitor_name"),
  competitorPrice: numeric("competitor_price", { precision: 18, scale: 4 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Suppliers ───────────────────────────────────────────────────────────────
export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  taxId: text("tax_id"),
  abn: text("abn"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  deliveryAddressLine1: text("delivery_address_line1"),
  deliveryAddressLine2: text("delivery_address_line2"),
  deliveryCity: text("delivery_city"),
  deliveryState: text("delivery_state"),
  deliveryPostalCode: text("delivery_postal_code"),
  deliveryCountry: text("delivery_country"),
  address: text("address"),
  contactName: text("contact_name"),
  paymentTerms: text("payment_terms"),
  currency: text("currency").default("USD"),
  pricingTier: text("pricing_tier"),
  creditLimit: numeric("credit_limit", { precision: 18, scale: 2 }),
  onTimeDeliveryPct: numeric("on_time_delivery_pct", { precision: 5, scale: 2 }),
  fillRatePct: numeric("fill_rate_pct", { precision: 5, scale: 2 }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Supplier Contacts ────────────────────────────────────────────────────────
export const supplierContactsTable = pgTable("supplier_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  supplierId: integer("supplier_id")
    .notNull()
    .references(() => suppliersTable.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── Customers ───────────────────────────────────────────────────────────────
export const customersTable = pgTable("customers", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  taxId: text("tax_id"),
  abn: text("abn"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  billingAddressLine1: text("billing_address_line1"),
  billingAddressLine2: text("billing_address_line2"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingPostalCode: text("billing_postal_code"),
  billingCountry: text("billing_country"),
  shippingAddressLine1: text("shipping_address_line1"),
  shippingAddressLine2: text("shipping_address_line2"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingPostalCode: text("shipping_postal_code"),
  shippingCountry: text("shipping_country"),
  address: text("address"),
  contactName: text("contact_name"),
  creditLimit: numeric("credit_limit", { precision: 18, scale: 2 }),
  paymentTerms: text("payment_terms"),
  currency: text("currency").default("USD"),
  pricingTier: text("pricing_tier"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Customer Contacts ────────────────────────────────────────────────────────
export const customerContactsTable = pgTable("customer_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ── GL Chart of Accounts ─────────────────────────────────────────────────────
export const glAccountsTable = pgTable("gl_accounts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  parentId: integer("parent_id"),
  code: text("code").notNull(),
  name: text("name").notNull(),
  accountType: text("account_type").notNull(),
  description: text("description"),
  taxCode: text("tax_code"),
  isPosting: boolean("is_posting").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  glTemplate: text("gl_template"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

// ── Type exports ─────────────────────────────────────────────────────────────
export type Warehouse = typeof warehousesTable.$inferSelect;
export type WarehouseLocation = typeof warehouseLocationsTable.$inferSelect;
export type Department = typeof departmentsTable.$inferSelect;
export type Item = typeof itemsTable.$inferSelect;
export type ItemVariant = typeof itemVariantsTable.$inferSelect;
export type ItemUnit = typeof itemUnitsTable.$inferSelect;
export type ItemAttribute = typeof itemAttributesTable.$inferSelect;
export type ItemLocation = typeof itemLocationsTable.$inferSelect;
export type ItemCrossReference = typeof itemCrossReferencesTable.$inferSelect;
export type Supplier = typeof suppliersTable.$inferSelect;
export type SupplierContact = typeof supplierContactsTable.$inferSelect;
export type Customer = typeof customersTable.$inferSelect;
export type CustomerContact = typeof customerContactsTable.$inferSelect;
export type GlAccount = typeof glAccountsTable.$inferSelect;

import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantStatusEnum = pgEnum("tenant_status", [
  "active",
  "suspended",
  "trial",
  "pending",
]);

export const tenantPlanEnum = pgEnum("tenant_plan", [
  "starter",
  "growth",
  "enterprise",
]);

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  tradingName: text("trading_name"),
  slug: text("slug").notNull().unique(),
  status: tenantStatusEnum("status").notNull().default("trial"),
  planTier: tenantPlanEnum("plan_tier").notNull().default("starter"),
  // Business details
  legalName: text("legal_name"),
  taxId: text("tax_id"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  // Address
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  // Config
  currency: text("currency").default("USD"),
  timezone: text("timezone").default("UTC"),
  fiscalYearStart: integer("fiscal_year_start").default(1),
  industryType: text("industry_type"),
  // Stripe
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  // Onboarding
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;

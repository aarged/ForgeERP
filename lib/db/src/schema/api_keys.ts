import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { userRoleEnum } from "./users";

/**
 * Tenant-scoped API keys for external integrations (e.g. Cyntric → Forge).
 *
 * The plaintext key is shown to the admin exactly once at creation time;
 * only a SHA-256 hash is stored. Tokens are formatted as
 *   fk_live_<32 random bytes hex>
 * so the prefix is recognisable and cannot collide with Clerk session JWTs.
 *
 * `role` controls what the key may do once authenticated — typically
 * `purchaser` (allowed to create quotations) for Cyntric, never
 * `tenant_admin` or `global_admin`.
 */
export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    prefix: text("prefix").notNull(),
    hashedKey: text("hashed_key").notNull().unique(),
    role: userRoleEnum("role").notNull().default("purchaser"),
    createdByClerkId: text("created_by_clerk_id"),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByClerkId: text("revoked_by_clerk_id"),
    revokedByEmail: text("revoked_by_email"),
  },
  (t) => ({
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId),
  }),
);

export type ApiKey = typeof apiKeysTable.$inferSelect;
export type InsertApiKey = typeof apiKeysTable.$inferInsert;

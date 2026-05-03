import {
  pgTable,
  text,
  serial,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const superAdminInvitesTable = pgTable("super_admin_invites", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  email: text("email"),
  createdByClerkId: text("created_by_clerk_id").notNull(),
  createdByEmail: text("created_by_email"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByClerkId: text("used_by_clerk_id"),
  usedByEmail: text("used_by_email"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByClerkId: text("revoked_by_clerk_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSuperAdminInviteSchema = createInsertSchema(
  superAdminInvitesTable,
).omit({ id: true, createdAt: true });
export type InsertSuperAdminInvite = z.infer<
  typeof insertSuperAdminInviteSchema
>;
export type SuperAdminInvite = typeof superAdminInvitesTable.$inferSelect;

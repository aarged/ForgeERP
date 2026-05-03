/**
 * grant-global-admin: Promote (or revoke) a tenant_membership to global_admin.
 *
 * Usage:
 *   pnpm grant-global-admin <email>           # promote to global_admin
 *   pnpm grant-global-admin <email> --revoke  # demote back to tenant_admin
 *
 * Looks up the active tenant_memberships row for <email> (case-insensitive),
 * updates its `role`, and writes an audit_log entry attributed to
 * `cli:bootstrap`.
 *
 * Errors clearly when there are zero or multiple matches. The user must have
 * already signed up via Clerk and completed onboarding (which is what creates
 * the membership row this script promotes).
 *
 * NOTE: This script is now mainly for emergency bootstrap. Existing super
 * admins can issue self-service global-admin invite links from the
 * /global-admin > "Global-admin invites" tab in the web UI — no shell needed.
 */
import {
  adminPool,
  tenantMembershipsTable,
  tenantsTable,
  auditLogsTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { sql, eq, and } from "drizzle-orm";

const adminDb = drizzle(adminPool, { schema });

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const revoke = args.includes("--revoke");
  const positional = args.filter((a) => !a.startsWith("--"));
  const email = positional[0];

  if (!email) {
    console.error("Usage: pnpm grant-global-admin <email> [--revoke]");
    return 2;
  }

  const lowered = email.trim().toLowerCase();
  const newRole: "global_admin" | "tenant_admin" = revoke
    ? "tenant_admin"
    : "global_admin";

  const matches = await adminDb
    .select({
      id: tenantMembershipsTable.id,
      tenantId: tenantMembershipsTable.tenantId,
      tenantName: tenantsTable.name,
      tenantSlug: tenantsTable.slug,
      clerkId: tenantMembershipsTable.clerkId,
      email: tenantMembershipsTable.email,
      role: tenantMembershipsTable.role,
      isActive: tenantMembershipsTable.isActive,
    })
    .from(tenantMembershipsTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, tenantMembershipsTable.tenantId))
    .where(
      and(
        sql`lower(${tenantMembershipsTable.email}) = ${lowered}`,
        eq(tenantMembershipsTable.isActive, "true"),
      ),
    );

  if (matches.length === 0) {
    console.error(
      `No active tenant_membership found for "${email}". The user must sign up via Clerk and complete onboarding before promotion.`,
    );
    return 1;
  }
  if (matches.length > 1) {
    console.error(
      `Multiple active memberships found for "${email}" — refusing to promote ambiguously. Found:`,
    );
    for (const m of matches) {
      console.error(
        `  membership_id=${m.id} tenant=${m.tenantName} (${m.tenantSlug}, id=${m.tenantId}) clerk_id=${m.clerkId} role=${m.role}`,
      );
    }
    return 1;
  }

  const target = matches[0]!;

  if (revoke && target.role !== "global_admin") {
    console.error(
      `Membership for "${email}" is not a global_admin (current role: ${target.role}). Nothing to revoke.`,
    );
    return 1;
  }

  if (!revoke && target.role === "global_admin") {
    console.log(
      `Membership for "${email}" is already global_admin. No change.`,
    );
    return 0;
  }

  // Last-global-admin platform protection on revoke
  if (revoke) {
    const [{ remaining } = { remaining: 0 }] = await adminDb
      .select({ remaining: sql<number>`COUNT(*)::int` })
      .from(tenantMembershipsTable)
      .where(
        sql`${tenantMembershipsTable.role} = 'global_admin'
            AND ${tenantMembershipsTable.isActive} = 'true'
            AND ${tenantMembershipsTable.id} <> ${target.id}`,
      );
    if (Number(remaining) === 0) {
      console.error(
        `Refusing to revoke "${email}" — at least one active global_admin must remain on the platform.`,
      );
      return 1;
    }
  }

  await adminDb.transaction(async (tx) => {
    await tx
      .update(tenantMembershipsTable)
      .set({ role: newRole })
      .where(eq(tenantMembershipsTable.id, target.id));

    await tx.insert(auditLogsTable).values({
      tenantId: target.tenantId,
      actorClerkId: "cli:bootstrap",
      actorEmail: "cli:bootstrap",
      action: revoke ? "tenant_member.revoke_global_admin" : "tenant_member.grant_global_admin",
      entityType: "tenant_membership",
      entityId: String(target.id),
      oldValues: { role: target.role },
      newValues: { role: newRole },
    });
  });

  console.log(
    `${revoke ? "Revoked" : "Granted"} ${revoke ? "global_admin from" : "global_admin to"} "${target.email}" ` +
      `(membership_id=${target.id}, tenant=${target.tenantName} [${target.tenantSlug}, id=${target.tenantId}], clerk_id=${target.clerkId}).`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await adminPool.end().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await adminPool.end().catch(() => {});
    process.exit(1);
  });

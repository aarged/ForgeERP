import { adminPool, auditLogsTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import type { Request } from "express";

const adminDb = drizzle(adminPool, { schema });

interface AuditParams {
  req?: Request;
  actorClerkId?: string;
  actorEmail?: string;
  tenantId?: number | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  oldValues?: unknown;
  newValues?: unknown;
}

export async function writeAuditLog(params: AuditParams): Promise<void> {
  await adminDb.insert(auditLogsTable).values({
    tenantId: params.tenantId ?? null,
    actorClerkId: params.actorClerkId ?? null,
    actorEmail: params.actorEmail ?? null,
    action: params.action,
    entityType: params.entityType ?? null,
    entityId: params.entityId !== undefined ? String(params.entityId) : null,
    oldValues: params.oldValues ?? null,
    newValues: params.newValues ?? null,
    ipAddress: params.req?.ip ?? null,
    userAgent: params.req?.headers["user-agent"] ?? null,
  });
}

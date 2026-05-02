import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { adminPool, apiKeysTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import type { TenantRequest } from "./tenantContext";
import { writeAuditLog } from "../lib/audit";
import { logger } from "../lib/logger";

const adminDb = drizzle(adminPool, { schema });

export const API_KEY_PREFIX = "fk_live_";

/**
 * Extends TenantRequest with API key attribution. When `apiKeyAuth` is true,
 * downstream middleware (`requireAuth`, `tenantContext`) short-circuits and
 * relies on the values set here.
 */
export interface ApiKeyRequest extends TenantRequest {
  apiKeyAuth: true;
  apiKeyId: number;
  apiKeyLabel: string;
}

/** Returns the SHA-256 hex digest of a plaintext API key. */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Generates a new API key in the format `fk_live_<64 hex chars>` (32 random
 * bytes). Returns both the plaintext (revealed once) and its SHA-256 hash.
 */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString("hex");
  const plaintext = `${API_KEY_PREFIX}${random}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, API_KEY_PREFIX.length + 6),
  };
}

/**
 * Synthetic Clerk user id for API-key authenticated requests. Used wherever
 * downstream code expects a clerkId (audit logs, createdBy stamps).
 */
export function syntheticClerkIdForApiKey(apiKeyId: number): string {
  return `apikey:${apiKeyId}`;
}

/**
 * Email-shaped attribution string for API-key requests, e.g.
 * `apikey:cyntric-prod@tenant-12`. This is the value stamped into
 * `createdByEmail` columns and audit logs so quote provenance is obvious.
 */
export function apiKeyAttributionEmail(label: string, tenantId: number): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60) || "key";
  return `apikey:${safeLabel}@tenant-${tenantId}`;
}

/**
 * Detects `Authorization: Bearer fk_…` headers and authenticates the request
 * via the api_keys table. On success, attaches tenant context to req and
 * marks `apiKeyAuth = true` so requireAuth + tenantContext skip Clerk.
 *
 * If the header is absent or doesn't begin with `fk_live_`, we fall through
 * so the normal Clerk flow runs. A header that begins with `fk_live_` but
 * is invalid / revoked is rejected with 401 (never falls through to Clerk).
 */
export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header) {
    next();
    return;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    next();
    return;
  }
  const token = match[1]!.trim();
  if (!token.startsWith(API_KEY_PREFIX)) {
    next();
    return;
  }

  const hash = hashApiKey(token);
  try {
    const rows = await adminDb
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.hashedKey, hash))
      .limit(1);

    const key = rows[0];
    if (!key) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    if (key.revokedAt) {
      res.status(401).json({ error: "API key has been revoked" });
      return;
    }

    const attributionEmail = apiKeyAttributionEmail(key.label, key.tenantId);
    const apiReq = req as ApiKeyRequest;
    apiReq.apiKeyAuth = true;
    apiReq.apiKeyId = key.id;
    apiReq.apiKeyLabel = key.label;
    apiReq.clerkUserId = syntheticClerkIdForApiKey(key.id);
    apiReq.tenantId = key.tenantId;
    apiReq.userRole = key.role;
    apiReq.userEmail = attributionEmail;

    // Stamp last-used + audit (fire-and-forget — don't block request).
    void adminDb
      .update(apiKeysTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeysTable.id, key.id))
      .catch((err) => {
        logger.warn({ err }, "Failed to update api_key.last_used_at");
      });
    void writeAuditLog({
      req,
      actorClerkId: apiReq.clerkUserId,
      actorEmail: attributionEmail,
      tenantId: key.tenantId,
      action: "apikey.used",
      entityType: "api_key",
      entityId: String(key.id),
      newValues: {
        label: key.label,
        method: req.method,
        path: req.originalUrl?.split("?")[0],
      },
    }).catch((err) => {
      logger.warn({ err }, "Failed to write apikey.used audit log");
    });

    next();
  } catch (err) {
    logger.error({ err }, "Failed to authenticate API key");
    res.status(500).json({ error: "Internal server error" });
  }
}
